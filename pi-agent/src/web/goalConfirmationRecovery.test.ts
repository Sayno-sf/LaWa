import {createTeachingFaux as createFauxCore} from "../testing/teachingFaux.js";
import assert from "node:assert/strict";
import test from "node:test";
import {createServer} from "node:http";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import {ModelRuntime, type SessionManager} from "@earendil-works/pi-coding-agent";
import {fauxAssistantMessage, fauxToolCall} from "@earendil-works/pi-ai";
import {createLearningAgentSession} from "../agentSession.js";
import type {LearningOverview} from "../learningOverviewTool.js";
import type {GoalOnboardingContext} from "../planning/goalOnboarding.js";
import type {LearnerQuestionRequest} from "../learnerQuestionTypes.js";
import {WebSessionStore} from "./sessionStore.js";

const profile = {id: "qa-decimal-percent", goal_description: "QA复测：把小数转换成百分数", background_summary: "能读小数",
  desired_outcome: "解释并完成小数与百分数的转换", learning_domain: "数学", learning_preferences: [], time_constraint: "", prior_knowledge_claims: []};
const skill = {id: "decimal-percent", name: "小数转换百分数", description: "把比例表示为每百份", prerequisites: [], target_depth: "PRACTICAL" as const};
const frontier = {focus_skill_id: skill.id, supporting_skill_ids: [], reason: "从已知小数解释百分数", target_depth: "PRACTICAL" as const,
  suggested_learning_mode: "EXPLAIN" as const, next_action: "解释0.25与25%的关系"};
const spine = Array.from({length: 5}, (_, index) => ({id: `stage-${index + 1}`, name: `阶段${index + 1}`, description: `转换练习${index + 1}`,
  target_depth: "PRACTICAL" as const, skill_ids: index === 0 ? [skill.id] : []}));
const plan = {goal_profile: profile, curriculum_spine: spine, frontier_skills: [skill], frontier, replace_existing: true};
const activity = {method: "APPLY", purpose: "说明比例换算", learner_action: "说出百分数与理由", observable_output: "转换结果和解释",
  evaluation_focus: ["单位换算与解释一致"], observation_limits: "单题不证明长期掌握"};
const taskInput = {title: "转换小数", description: "说明每百份", related_skill_ids: [skill.id], expected_evidence_types: ["EXPLAIN"], teaching_activity: activity};
const reply = (request: LearnerQuestionRequest) => ({request_id: request.id,
  answers: [{question_id: request.questions[0]!.id, selected_option_ids: ["proceed"], other_text: ""}]});

async function scenario(mode: "normal" | "rejected-profile" | "lost-response" | "missing-confirm") {
  const dir = mkdtempSync(join(tmpdir(), "lawa-goal-confirm-recovery-"));
  const state: LearningOverview = {current_goal: null, goal_profile: null, active_task: null, current_frontier: null, current_focus: null,
    skills: [], current_goal_skill_ids: [], curriculum_spine: [], recent_evidence: [], learning_history: []};
  let initialized = 0, taskCreates = 0, taskActivations = 0, modelRequests = 0, receiptQueries = 0;
  let task: Record<string, unknown> | undefined;
  const api = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    let text = ""; for await (const chunk of req) text += chunk;
    if (req.method === "POST" && req.url === "/api/learning/curriculum/initialize") {
      const input = JSON.parse(text);
      assert.deepEqual(input.goal_profile, profile);
      if (input.recover_only) {
        receiptQueries++;
        if (!initialized) {res.statusCode = 404; return res.end(JSON.stringify({code: "PLANNING_RESULT_NOT_FOUND"}));}
        return res.end(JSON.stringify({goal_profile: profile, curriculum_spine: spine, frontier}));
      }
      initialized++;
      assert.equal(initialized, 1, "one real confirmation must create just one authoritative Goal");
      state.current_goal = profile.goal_description; state.goal_profile = structuredClone(profile);
      state.skills = [{...skill, status: "NOT_STARTED"}]; state.current_goal_skill_ids = [skill.id];
      state.current_frontier = frontier; state.curriculum_spine = spine;
      if (mode === "lost-response") return res.destroy();
      return res.end(JSON.stringify({goal_profile: profile, curriculum_spine: spine, frontier}));
    }
    if (req.method === "POST" && req.url === "/api/learning/tasks") {
      taskCreates++; task = {id: "task-decimal", ...JSON.parse(text), status: "TODO", goal_id: profile.id};
      return res.end(JSON.stringify(task));
    }
    if (req.method === "POST" && req.url === "/api/learning/tasks/task-decimal/activate") {
      taskActivations++; assert.ok(task); task.status = "ACTIVE"; state.active_task = task;
      return res.end(JSON.stringify(task));
    }
    assert.equal(req.method, "GET", `unexpected write ${req.method} ${req.url}`);
    res.end(JSON.stringify(state));
  });
  await new Promise<void>(done => api.listen(0, "127.0.0.1", done));
  const address = api.address(); assert.ok(address && typeof address !== "string");
  const apiBaseUrl = `http://127.0.0.1:${address.port}`;
  const faux = createFauxCore({api: "openai-completions", provider: "aliyun-bailian", tokensPerSecond: 0,
    models: [{id: "qwen3.8-flash", contextWindow: 1_000_000, maxTokens: 32768}]});
  let planning!: GoalOnboardingContext, manager!: SessionManager;
  const packet = (name: string, args: Record<string, unknown>, id: string) => fauxAssistantMessage(fauxToolCall(name, args, {id}), {stopReason: "toolUse"});
  const counted = (value: ReturnType<typeof fauxAssistantMessage>) => () => {modelRequests++; return value;};
  faux.setResponses([
    counted(packet("record_goal_understanding", {outcome: "READY_FOR_CONFIRMATION", profile}, "ready")),
    ...(mode === "missing-confirm" ? [] : [counted(packet("ask_learner_questions", {purpose: "CONFIRM_GOAL"}, "confirm-card"))]),
    counted(fauxAssistantMessage("请确认目标。")),
    ...(mode === "rejected-profile" ? [counted(packet("record_goal_understanding", {outcome: "CONFIRMED",
      profile: {...profile, desired_outcome: "未经用户确认的新目标"}}, "bad-confirm")), () => {
      modelRequests++;
      assert.equal(planning.snapshot().status, "READY_FOR_CONFIRMATION");
      assert.deepEqual(planning.snapshot().pending_profile, profile, "a rejected tool must preserve the exact user-confirmed draft");
      const failed = manager.getBranch().find(row => row.type === "message" && row.message.role === "toolResult" && row.message.toolCallId === "bad-confirm");
      assert.ok(failed?.type === "message" && failed.message.role === "toolResult" && failed.message.isError);
      return packet("record_goal_understanding", {outcome: "CONFIRMED", profile}, "confirm-echo");
    }] : [counted(packet("record_goal_understanding", {outcome: "CONFIRMED", profile}, "confirm-echo"))]),
    counted(packet("initialize_learning_goal", plan, "save-plan")),
    counted(fauxAssistantMessage("路线已保存，点下面的「开始学习」。")),
    counted(packet("create_learning_task", taskInput, "create-after-start")),
    counted(packet("activate_learning_task", {task_id: "task-decimal"}, "activate-after-start")),
    counted(fauxAssistantMessage("现在开始：请把0.25转换成百分数，并说明理由。")),
  ]);
  const runtime = await ModelRuntime.create({authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models.json"),
    allowModelNetwork: false, refreshOnCreate: false});
  runtime.streamSimple = faux.streamSimple; runtime.hasConfiguredAuth = () => true;
  runtime.getAuth = async () => ({auth: {apiKey: "isolated-test"}, env: {}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  const store = new WebSessionStore({conversationDir: join(dir, "sessions"), conversationCwd: dir, apiBaseUrl,
    fetchOverview: async () => structuredClone(state), fetchLibrary: async () => ({projects: []}), log: () => undefined,
    createAgent: (context, onboarding, onEvent, sessionManager) => {
      planning = onboarding; manager = sessionManager;
      return createLearningAgentSession(context, onboarding, {surface: "WEB", model: faux.getModel(), modelRuntime: runtime,
        sessionManager, retrieval: false, assistantSupport: false, apiBaseUrl, teachingInstructions: () => "", onEvent, log: () => undefined});
    }});
  try {
    const session = await store.create("new-goal");
    await store.sendMessage(session.sessionId, profile.goal_description, () => undefined);
    const confirmation = (await store.state(session.sessionId)).teaching.learner_questions?.pending;
    assert.ok(confirmation); assert.equal(confirmation.purpose, "CONFIRM_GOAL");
    assert.equal(initialized, 0, "presenting confirmation never saves a Goal on the learner's behalf");
    assert.equal(taskCreates, 0); assert.equal(taskActivations, 0);
    await store.sendMessage(session.sessionId, "", () => undefined, reply(confirmation));
    const saved = await store.state(session.sessionId);
    assert.equal(initialized, 1, JSON.stringify(manager.getBranch().filter(row => row.type === "message" && row.message.role === "toolResult").map(row =>
      row.type === "message" && row.message.role === "toolResult" ? {tool: row.message.toolName, error: row.message.isError, content: row.message.content} : null)));
    assert.equal(saved.onboarding.status, "INITIALIZED");
    assert.deepEqual(saved.overview.goal_profile, profile); assert.deepEqual(saved.overview.curriculum_spine, spine);
    const start = saved.teaching.learner_questions?.pending;
    assert.ok(start); assert.equal(start.purpose, "START_LEARNING", "a prose promise is not a start component; runtime must supply the real request");
    assert.equal(start.skill_id, skill.id); assert.equal(start.questions[0]!.options[0]!.label, "开始学习");
    assert.equal(taskCreates, 0); assert.equal(taskActivations, 0);
    const beforeDuplicate = modelRequests;
    await assert.rejects(store.sendMessage(session.sessionId, "", () => undefined, reply(confirmation)), /问题已变化|已失效|回答不完整/);
    assert.equal(modelRequests, beforeDuplicate); assert.equal(initialized, 1); assert.equal(taskCreates, 0);
    assert.equal((await store.state(session.sessionId)).teaching.learner_questions?.pending?.id, start.id);
    const restored = await store.create("resume-recent");
    assert.equal(restored.sessionId, session.sessionId); assert.equal(restored.state.teaching.learner_questions?.pending?.id, start.id);
    await store.sendMessage(session.sessionId, "", () => undefined, reply(start));
    assert.equal(taskCreates, 1); assert.equal(taskActivations, 1); assert.equal(initialized, 1);
    assert.equal((state.active_task as {id: string}).id, "task-decimal");
    if (mode === "lost-response") assert.ok(receiptQueries >= 2, "lost create response is reconciled before any duplicate creation");
  } finally {
    store.dispose(); api.closeAllConnections(); await new Promise<void>(done => api.close(() => done()));
    assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith("lawa-goal-confirm-recovery-"));
    rmSync(dir, {recursive: true, force: true});
  }
}

test("real Pi confirmation echo saves one Goal and supplies a real start card before teaching", () => scenario("normal"));
test("a rejected confirmation edit preserves the draft and corrected echo completes without another user card", () => scenario("rejected-profile"));
test("a saved Goal with a lost response is reconciled once and still has a usable real start card", () => scenario("lost-response"));

for (let run = 1; run <= 3; run++) {
  test(`missing initial confirmation tool still presents the exact draft decision before any goal write (repeat ${run})`, () => scenario("missing-confirm"));
}
