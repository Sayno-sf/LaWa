import {createTeachingFaux as createFauxCore} from "./testing/teachingFaux.js";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import test from "node:test";
import {ModelRuntime, SessionManager} from "@earendil-works/pi-coding-agent";
import {fauxAssistantMessage, fauxToolCall, type Context} from "@earendil-works/pi-ai";
import {createLearningAgentSession} from "./agentSession.js";
import {TeachingSessionContext} from "./teachingSession.js";
import {GoalOnboardingContext} from "./planning/goalOnboarding.js";
import {teachingPreferenceSnapshot} from "./teachingPreferences.js";
import type {LearningOverview} from "./learningOverviewTool.js";
import type {ActivityTask, TeachingActivity} from "./teachingActivity.js";

const arrangements = {preference_revision: "a".repeat(64), strategies: [], proposals: [], observations: []};
const preferenceRevision = teachingPreferenceSnapshot(arrangements, "").revision;
const activity = (method: TeachingActivity["method"], marker: string): TeachingActivity => ({
  method, purpose: `${marker}理解函数行为`, learner_action: `${marker}比较或修改程序`,
  observable_output: `${marker}实际给出的判断或修改`, evaluation_focus: ["判断函数返回值"],
  observation_limits: "文字解释不证明已经独立执行代码", teaching_preferences_revision: preferenceRevision,
});
const task = (id: string, value?: TeachingActivity): ActivityTask => ({id, status: "ACTIVE", related_skill_ids: ["functions"],
  ...(value ? {teaching_activity: value, activity_revision: 1} : {})});
function overview(active: ActivityTask): LearningOverview {
  return {current_goal: "读懂函数", goal_profile: {id: "same-goal", desired_outcome: "读懂并修改函数"},
    current_focus: null, current_frontier: {focus_skill_id: "functions", supporting_skill_ids: []}, active_task: active,
    skills: [{id: "functions", name: "函数", status: "LEARNING"}], current_goal_skill_ids: ["functions"],
    curriculum_spine: [], recent_evidence: [], knowledge_cards: [], learning_history: []};
}
function modelActivity(context: Context): {task_id: string; activity_revision: number; status: string; activity?: TeachingActivity} {
  const match = /当前任务活动（只读安排，不是学习表现）：([^\n]+)/.exec(context.systemPrompt ?? "");
  assert.ok(match, "检查实际Provider入口的系统输入，而不是prompt helper返回值");
  return JSON.parse(match[1]!);
}

/** 真实Pi会话和工具调度；仅模型与Kernel HTTP是临时adapter，不读取真实凭据或学习账本。 */
async function harness(state: LearningOverview, manager = SessionManager.inMemory()) {
  const directory = await mkdtemp(join(tmpdir(), "lawa-activity-runtime-"));
  const writes: Array<Record<string, unknown>> = [];
  const api = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/api/learning/overview") return response.end(JSON.stringify(state));
    if (request.method === "GET" && request.url === "/api/learning/teaching") return response.end(JSON.stringify(arrangements));
    const current = state.active_task as ActivityTask;
    if (request.method === "POST" && request.url === `/api/learning/tasks/${current.id}/teaching-activity`) {
      try {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        const input = JSON.parse(body) as {expected_goal_id: string; expected_revision: number; teaching_activity: TeachingActivity};
        writes.push(input);
        if (input.expected_goal_id !== "same-goal" || input.expected_revision !== (current.activity_revision ?? 0)) {
          response.statusCode = 409; return response.end(JSON.stringify({detail: "activity version conflict"}));
        }
        state.active_task = {...current, teaching_activity: input.teaching_activity, activity_revision: input.expected_revision + 1};
        return response.end(JSON.stringify(state.active_task));
      } catch {
        response.statusCode = 400; return response.end(JSON.stringify({detail: "invalid isolated request"}));
      }
    }
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>(done => api.listen(0, "127.0.0.1", done));
  const address = api.address(); assert.ok(address && typeof address !== "string");
  const faux = createFauxCore({tokensPerSecond: 0});
  const runtime = await ModelRuntime.create({authPath: join(directory, "auth.json"), modelsPath: null,
    modelsStorePath: join(directory, "models.json"), allowModelNetwork: false, refreshOnCreate: false});
  runtime.streamSimple = faux.streamSimple;
  runtime.hasConfiguredAuth = provider => provider === faux.getModel().provider;
  runtime.getAuth = async () => ({auth: {apiKey: "isolated-faux-key"}, env: {}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  const errors: string[] = [];
  const context = new TeachingSessionContext(); context.bindSession("activity-runtime-session");
  const session = await createLearningAgentSession(context, new GoalOnboardingContext(), {
    model: faux.getModel(), modelRuntime: runtime, sessionManager: manager, retrieval: false, assistantSupport: false,
    apiBaseUrl: `http://127.0.0.1:${address.port}`, surface: "WEB", teachingInstructions: () => "", log: () => undefined,
    onEvent: event => {if (event.type === "model_error") errors.push(event.message);},
  });
  return {session, faux, writes, errors, async close() {
    session.dispose();
    await new Promise<void>((done, reject) => api.close(error => error ? reject(error) : done()));
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("lawa-activity-runtime-"));
    await rm(directory, {recursive: true, force: true});
  }};
}

test("actual Pi input refreshes the activity revision after configure and retains the original question and answer", async () => {
  const state = overview(task("task-one", activity("COMPARE", "BEFORE_")));
  const manager = SessionManager.inMemory();
  const question = "ORIGINAL_QUESTION：这两种函数的返回值为什么不同？";
  const answer = "ORIGINAL_ANSWER：第二种写了花括号但没有return。";
  manager.appendMessage(fauxAssistantMessage(question));
  manager.appendMessage({role: "user", content: answer, timestamp: Date.now()});
  manager.appendMessage(fauxAssistantMessage("已记录你指出的返回值差别。"));
  const originalEntries = structuredClone(manager.getBranch());
  const run = await harness(state, manager);
  const next = activity("APPLY", "AFTER_");
  const modelInput = {...next}; delete modelInput.teaching_preferences_revision;
  run.faux.setResponses([
    context => {
      const selected = modelActivity(context);
      assert.equal(selected.task_id, "task-one"); assert.equal(selected.activity_revision, 1);
      assert.equal(selected.activity?.method, "COMPARE");
      assert.ok(JSON.stringify(context.messages).includes(question)); assert.ok(JSON.stringify(context.messages).includes(answer));
      return fauxAssistantMessage(fauxToolCall("configure_teaching_activity", {
        task_id: "task-one", expected_revision: 1, teaching_activity: modelInput,
      }, {id: "configure-current"}), {stopReason: "toolUse"});
    },
    context => {
      const selected = modelActivity(context);
      assert.equal(selected.task_id, "task-one"); assert.equal(selected.activity_revision, 2);
      assert.equal(selected.status, "READY"); assert.equal(selected.activity?.method, "APPLY");
      assert.match(selected.activity?.learner_action ?? "", /AFTER_/);
      assert.ok(JSON.stringify(context.messages).includes(question)); assert.ok(JSON.stringify(context.messages).includes(answer));
      return fauxAssistantMessage("现在通过修改一个函数观察返回值。");
    },
  ]);
  try {
    await run.session.prompt("现在换成修改程序的方式继续讲解。");
    assert.deepEqual(run.errors, []); assert.equal(run.faux.state.callCount, 3); assert.equal(run.writes.length, 1);
    assert.equal((run.writes[0]!.teaching_activity as TeachingActivity).teaching_preferences_revision, preferenceRevision);
    assert.deepEqual(manager.getBranch().filter(entry => originalEntries.some(old => old.id === entry.id)), originalEntries,
      "供应商输入整理不能重写已经保存的题目和真实答案");
  } finally {await run.close();}
});

test("an old Goal without a domain permits explanation and follows the current Task instead of a fixed domain method", async () => {
  const state = overview(task("legacy-task"));
  const run = await harness(state);
  const seen: Array<ReturnType<typeof modelActivity>> = [];
  run.faux.setResponses(Array.from({length: 3}, () => (context: Context) => {
    seen.push(modelActivity(context)); return fauxAssistantMessage("按当前任务继续解释函数。");
  }));
  try {
    await run.session.prompt("这是一份旧学习记录，先解释函数，不要出题。");
    assert.equal(seen[0]!.task_id, "legacy-task"); assert.equal(seen[0]!.status, "UNPLANNED");
    state.active_task = task("comparison-task", activity("COMPARE", "COMPARE_TASK_"));
    await run.session.prompt("继续比较例子。");
    state.active_task = task("application-task", activity("APPLY", "APPLY_TASK_"));
    await run.session.prompt("继续当前修改任务。");
    assert.equal(seen[1]!.task_id, "comparison-task"); assert.equal(seen[1]!.activity?.method, "COMPARE");
    assert.equal(seen[2]!.task_id, "application-task"); assert.equal(seen[2]!.activity?.method, "APPLY");
    assert.equal((state.goal_profile as {id: string}).id, "same-goal");
    assert.equal((state.goal_profile as {learning_domain?: string}).learning_domain, undefined);
    assert.equal(run.writes.length, 0); assert.deepEqual(run.errors, []); assert.equal(run.faux.state.callCount, 6);
  } finally {await run.close();}
});
