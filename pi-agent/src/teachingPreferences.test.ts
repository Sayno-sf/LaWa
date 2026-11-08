import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer} from "node:http";
import {ModelRuntime, SessionManager} from "@earendil-works/pi-coding-agent";
import {createFauxCore, fauxAssistantMessage, fauxToolCall, type Context} from "@earendil-works/pi-ai";
import {teachingPreferenceSnapshot, projectPreferencePlans, projectPreferenceMessages, PREFERENCE_HISTORY_NOTICE} from "./teachingPreferences.js";
import {TeachingInstructionsStore} from "./teachingInstructions.js";
import {createLearningAgentSession} from "./agentSession.js";
import {TeachingSessionContext} from "./teachingSession.js";
import {GoalOnboardingContext} from "./planning/goalOnboarding.js";
import {applyCurriculumPlan} from "./planning/planningTools.js";
import {projectTeachingCompaction} from "./teachingContextLifecycle.js";
import type {SessionBeforeCompactEvent} from "@earendil-works/pi-coding-agent";

const oldPlan = "每讲完一个知识点按已确认的安排给8～10题，整组提交";
const frontier = {focus_skill_id: "syntax", supporting_skill_ids: [], target_depth: "PRACTICAL" as const,
  next_action: oldPlan, reason: "按照旧偏好", suggested_learning_mode: "EXPLAIN" as const};
const empty = {preference_revision: "withdrawn", strategies: [], proposals: [], strategies_omitted: 0};

test("clear/save/restore have stable but distinct versions after store reload", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "lawa-pref-")), "instructions.json");
  const store = new TeachingInstructionsStore({path});
  const revisions = new Set<string>();
  for (const text of ["固定结尾", "", "固定结尾", "固定结尾"]) {
    await store.save(text);
    const current = teachingPreferenceSnapshot(empty, await store.prompt());
    revisions.add(current.revision);
    assert.equal(teachingPreferenceSnapshot(empty, await new TeachingInstructionsStore({path}).prompt()).revision, current.revision);
  }
  assert.equal(revisions.size, 4);
});

test("expired plans are removed from input copies while task and evidence facts remain exact", () => {
  const revision = teachingPreferenceSnapshot(empty, "").revision;
  const state = {current_frontier: {...frontier, teaching_preferences_revision: "old"},
    active_task: {id: "task", status: "ACTIVE"}, evidence: [{id: "e1", assistance_level: "WITH_HELP"}]};
  const before = structuredClone(state);
  const sent = projectPreferencePlans(state, revision);
  assert.doesNotMatch(JSON.stringify(sent), /8～10|按照旧偏好/);
  assert.deepEqual(sent.active_task, state.active_task);
  assert.deepEqual(sent.evidence, state.evidence);
  assert.equal(sent.current_frontier.focus_skill_id, "syntax");
  assert.deepEqual(state, before);
  assert.equal(projectPreferencePlans({...frontier, teaching_preferences_revision: revision}, revision).next_action, oldPlan);
  assert.equal(projectPreferencePlans(frontier, revision).next_action, undefined);
  assert.equal(projectPreferencePlans({...frontier, teaching_preferences_revision: revision}).next_action, undefined);
});

test("old tool receipts, previous-summary and split compaction demote preferences without rewriting answers", () => {
  const messages = [
    {role: "user", content: "以后固定这样做"},
    {role: "toolResult", toolName: "propose_teaching_strategy", content: [{type: "text", text: JSON.stringify({text: oldPlan})}]},
    {role: "toolResult", toolName: "get_learning_overview", content: [{type: "text", text: JSON.stringify({current_frontier: frontier})}]},
    {role: "assistant", content: "刚才的问题是 f(2) 返回什么？臣先告退。"},
    {role: "user", content: "4，因为乘以2"},
  ];
  const before = structuredClone(messages);
  const sent = projectPreferenceMessages(messages, "new");
  assert.doesNotMatch(JSON.stringify(sent[1]), /8～10/);
  assert.doesNotMatch(JSON.stringify(sent[2]), /8～10/);
  assert.deepEqual(sent[3], messages[3], "旧教师正文保留以核对题面，不注入可被模仿的重复前缀");
  assert.ok(String(sent[0]!.content).startsWith(PREFERENCE_HISTORY_NOTICE));
  assert.deepEqual(sent[4], messages[4]);
  const preparation = {messagesToSummarize: messages, turnPrefixMessages: messages,
    previousSummary: "必须保持固定结尾。已回答 f(2)=4。"} as unknown as SessionBeforeCompactEvent["preparation"];
  projectTeachingCompaction(preparation);
  assert.ok(preparation.previousSummary!.startsWith(PREFERENCE_HISTORY_NOTICE));
  assert.doesNotMatch(JSON.stringify(preparation.messagesToSummarize), /8～10/);
  assert.match(JSON.stringify(preparation.turnPrefixMessages), /4，因为乘以2/);
  assert.deepEqual(messages, before);
});

test("planning HTTP writes bind runtime preference version, not a model-supplied version", async () => {
  let body: any;
  await applyCurriculumPlan({frontier: {...frontier, teaching_preferences_revision: "forged"} as typeof frontier,
    added_skills: [], depth_changes: [], prerequisite_additions: [], remove_skill_ids: []}, {
    teachingPreferencesRevision: () => "a".repeat(64), log: () => undefined,
    fetchImpl: async (_url, init) => {body = JSON.parse(String(init?.body)); return Response.json(body.frontier);},
  });
  assert.equal(body.frontier.teaching_preferences_revision, "a".repeat(64));
});

test("actual teacher boundary refreshes withdrawn/cleared/restored preferences across runs and reopened sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lawa-pref-loop-"));
  const store = new TeachingInstructionsStore({path: join(dir, "instructions.json")});
  await store.save("每次结尾说臣先告退");
  let arrangements: Record<string, unknown> = {...empty, preference_revision: "confirmed",
    strategies: [{id: "p", revision: 2, text: oldPlan}]};
  const overview = {current_goal: "读懂JS", goal_profile: {id: "g"}, current_focus: null, current_frontier: {...frontier},
    active_task: {id: "task", status: "ACTIVE", related_skill_ids: ["syntax"]},
    skills: [{id: "syntax", name: "JS", status: "LEARNING"}], current_goal_skill_ids: ["syntax"],
    curriculum_spine: [], recent_evidence: [], learning_history: []};
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
  faux.setResponses([
    c => {seen.push(c); return fauxAssistantMessage("f(2)返回什么？臣先告退。");},
    c => {seen.push(c); return fauxAssistantMessage(fauxToolCall("get_learning_overview", {}, {id: "read"}), {stopReason: "toolUse"});},
    c => {seen.push(c); return fauxAssistantMessage("返回4。");},
    c => {seen.push(c); return fauxAssistantMessage("恢复后的安排。");},
    c => {seen.push(c); return fauxAssistantMessage("重开后继续。");},
  ]);
  const runtime = await ModelRuntime.create({authPath: join(dir, "auth.json"), modelsPath: null,
    modelsStorePath: join(dir, "models.json"), allowModelNetwork: false, refreshOnCreate: false});
  runtime.streamSimple = faux.streamSimple;
  runtime.hasConfiguredAuth = () => true;
  runtime.getAuth = async () => ({auth: {apiKey: "faux"}, env: {}} as any);
  const manager = SessionManager.inMemory();
  const create = () => createLearningAgentSession(new TeachingSessionContext(), new GoalOnboardingContext(), {
    model: faux.getModel(), modelRuntime: runtime, sessionManager: manager, retrieval: false, assistantSupport: false,
    apiBaseUrl: `http://127.0.0.1:${address.port}`, teachingInstructions: () => store.prompt(), log: () => undefined,
  });
  let agent = await create();
  try {
    await agent.prompt("先讲函数");
    assert.match(seen[0]!.systemPrompt!, /每次结尾说臣先告退/);
    arrangements = empty;
    await store.save("");
    await agent.prompt("4，因为乘以2");
    assert.equal(seen.length, 3);
    for (const c of seen.slice(1)) {
      assert.doesNotMatch(c.systemPrompt!, /臣先告退|每讲完一个知识点/);
      assert.match(c.systemPrompt!, /当前没有自定义教学提示词/);
      assert.match(c.systemPrompt!, /STALE_PREFERENCES_REPLAN/);
      assert.match(JSON.stringify(c.messages), /f\(2\)返回什么/);
      assert.doesNotMatch(JSON.stringify(c.messages.filter(m => m.role === "toolResult")), /每讲完一个知识点/);
    }
    assert.match(JSON.stringify(seen[1]!.messages.at(-1)), /4，因为乘以2/);
    arrangements = {...empty, preference_revision: "restored", strategies: [{id: "p", revision: 4, text: oldPlan}]};
    await agent.prompt("继续");
    assert.match(seen[3]!.systemPrompt!, /每讲完一个知识点/);
    arrangements = {...empty, preference_revision: "deleted"};
    agent.dispose();
    agent = await create();
    await agent.prompt("继续解释函数");
    assert.doesNotMatch(seen[4]!.systemPrompt!, /臣先告退|每讲完一个知识点/);
    assert.ok(requests.every(r => r.startsWith("GET ")), "隔离模型回归不应写入学习事实");
  } finally {agent.dispose(); api.closeAllConnections(); await new Promise<void>(done => api.close(() => done()));}
});
