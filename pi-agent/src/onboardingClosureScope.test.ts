import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer} from "node:http";
import {ModelRuntime, SessionManager} from "@earendil-works/pi-coding-agent";
import {createFauxCore, fauxAssistantMessage, type Context} from "@earendil-works/pi-ai";
import {createLearningAgentSession} from "./agentSession.js";
import {TeachingSessionContext} from "./teachingSession.js";
import {GoalOnboardingContext, type GoalUnderstandingStatus} from "./planning/goalOnboarding.js";

const arrangements = {preference_revision: "unchanged-preferences",
  strategies: [{id: "personal", scope: "USER", text: "保留个人通用短例子方法"},
    {id: "previous-goal", scope: "GOAL", text: "旧目标专属策略应离开新草案"}],
  proposals: [{id: "old-proposal", text: "旧目标待决提案应离开新草案"}],
  closure_progress: {goal_id: "old-completed-goal", snapshot_signature: "CLOSURE_FROM_PREVIOUS_GOAL",
    route_learning_complete: true, active_task_present: false, user_confirmed_count: 0, expanded_skill_count: 1,
    milestones: [{skills: [{id: "old-sixth", name: "前一目标收尾原始事实", status: "LEARNING",
      assistance_levels: ["WITH_HINT"], latest_assessment: {id: "prior-assessment-6", score: 10, assistance_level: "WITH_HINT"}}]}],
    unassigned_skills: []}};

const overview = {current_goal: "已保存的前一目标", goal_profile: {id: "old-completed-goal"},
  current_focus: null, current_frontier: null, active_task: null, skills: [], current_goal_skill_ids: [],
  curriculum_spine: [], recent_evidence: [], learning_history: []};
const profile = {id: "new-draft", goal_description: "学习小数百分比", background_summary: "初学",
  desired_outcome: "能完成转换", learning_preferences: [], time_constraint: "无", prior_knowledge_claims: []};

async function captureInput(status: GoalUnderstandingStatus): Promise<Context> {
  const before = structuredClone(arrangements);
  const dir = await mkdtemp(join(tmpdir(), "lawa-onboarding-closure-"));
  const requests: string[] = [];
  const api = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url?.includes("/teaching") ? arrangements : overview));
  });
  await new Promise<void>(done => api.listen(0, "127.0.0.1", done));
  const address = api.address(); assert.ok(address && typeof address !== "string");
  const seen: Context[] = [];
  const faux = createFauxCore({api: "openai-completions", provider: "deepseek",
    models: [{id: "deepseek-flash", contextWindow: 128000, maxTokens: 8192}], tokensPerSecond: 0});
  faux.setResponses([input => {seen.push(input); return fauxAssistantMessage("收到本轮请求。");}]);
  const runtime = await ModelRuntime.create({authPath: join(dir, "auth.json"), modelsPath: null,
    modelsStorePath: join(dir, "models.json"), allowModelNetwork: false, refreshOnCreate: false});
  runtime.streamSimple = faux.streamSimple;
  runtime.hasConfiguredAuth = () => true;
  runtime.getAuth = async () => ({auth: {apiKey: "faux"}, env: {}} as any);
  const planning = new GoalOnboardingContext();
  if (status !== "IDLE") {
    planning.start({replaceExisting: true});
    if (status !== "NEEDS_CLARIFICATION") planning.record({outcome: "READY_FOR_CONFIRMATION", profile});
    if (status === "CONFIRMED" || status === "INITIALIZED") {
      planning.beginUserTurn("确认");
      planning.record({outcome: "CONFIRMED"});
      if (status === "INITIALIZED") planning.markInitialized();
    }
  }
  const context = new TeachingSessionContext();
  const agent = await createLearningAgentSession(context, planning, {model: faux.getModel(), modelRuntime: runtime,
    sessionManager: SessionManager.inMemory(), retrieval: false, assistantSupport: false,
    apiBaseUrl: `http://127.0.0.1:${address.port}`, teachingInstructions: async () => "", log: () => undefined});
  try {
    await agent.prompt("继续当前流程");
    assert.equal(seen.length, 1, "inspect the actual stream-boundary input without making real provider calls");
    assert.ok(requests.every(request => request.startsWith("GET ")), "onboarding scope projection is read-only");
    assert.deepEqual(arrangements, before, "the saved old Goal facts must remain exact");
    assert.match(JSON.stringify(seen[0]), /保留个人通用短例子方法/);
    return seen[0]!;
  } finally {
    agent.dispose();
    api.closeAllConnections();
    await new Promise<void>(done => api.close(() => done()));
  }
}

for (const [status, run] of [["NEEDS_CLARIFICATION", 1], ["NEEDS_CLARIFICATION", 2],
  ["READY_FOR_CONFIRMATION", 1], ["CONFIRMED", 1]] as const) {
  test(`new draft ${status} excludes previous Goal closure from actual model input (isolated run ${run})`, async () => {
    const input = JSON.stringify(await captureInput(status));
    assert.equal(/CLOSURE_FROM_PREVIOUS_GOAL|前一目标收尾原始事实|prior-assessment-6|本轮收尾事实/.test(input), false,
      "old closure facts entered a new Goal draft's real stream-boundary input");
    assert.equal(/旧目标专属策略应离开新草案|旧目标待决提案应离开新草案/.test(input), false);
  });
}

for (const status of ["IDLE", "INITIALIZED"] as const) {
  test(`existing ${status} Goal keeps its real closure input`, async () => {
    const input = JSON.stringify(await captureInput(status));
    assert.match(input, /CLOSURE_FROM_PREVIOUS_GOAL/);
    assert.match(input, /本轮收尾事实/);
    assert.match(input, /prior-assessment-6/);
    assert.match(input, /WITH_HINT/);
  });
}
