import {createTeachingFaux as createFauxCore} from "./testing/teachingFaux.js";
import assert from "node:assert/strict";
import test from "node:test";
import {createServer} from "node:http";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ModelRuntime, SessionManager} from "@earendil-works/pi-coding-agent";
import {fauxAssistantMessage, fauxToolCall} from "@earendil-works/pi-ai";
import {masteryReviewDecision, masteryReviewRequest, masteryReviewSignature} from "./masteryReview.js";
import {LearnerQuestionsContext, validateQuestionRequest} from "./learnerQuestions.js";
import {TeachingSessionContext} from "./teachingSession.js";
import {GoalOnboardingContext} from "./planning/goalOnboarding.js";
import {createLearningAgentSession} from "./agentSession.js";
import {createLearnerQuestionTool} from "./learnerQuestionTool.js";
import type {LearningOverview} from "./learningOverviewTool.js";

const overview = (): LearningOverview => ({current_goal: "读懂函数", goal_profile: {id: "goal"},
  current_frontier: {focus_skill_id: "skill"}, active_task: {id: "task", title: "函数练习", status: "ACTIVE", related_skill_ids: ["skill"]},
  current_focus: null, current_goal_skill_ids: ["skill"], skills: [{id: "skill", name: "函数", status: "LEARNING"}],
  curriculum_spine: [], recent_evidence: [], knowledge_cards: [], learning_history: []});
const reply = (request: NonNullable<ReturnType<typeof masteryReviewRequest>>, id: string, feedback = "") =>
  ({request_id: request.id, answers: [{question_id: "mastery-review", selected_option_ids: [id], other_text: feedback}]});

test("only the current active skill can be offered; fixed actions cannot carry hidden grading or forged mastery labels", () => {
  const request = masteryReviewRequest(overview(), "session")!;
  validateQuestionRequest(request);
  assert.deepEqual(request.questions[0]!.options.map(o => o.id), ["proceed", "revise", "skip"]);
  assert.throws(() => validateQuestionRequest({...request, questions: [{...request.questions[0]!, options: [{id: "proceed", label: "已自动掌握"}]}]}));
  assert.throws(() => validateQuestionRequest({...request, assessment_contract_id: "hidden-score"}));
  assert.equal(masteryReviewRequest({...overview(), active_task: null}, "session"), undefined);
  const mastered = overview(); (mastered.skills[0] as {status: string}).status = "MASTERED_BY_USER";
  assert.equal(masteryReviewRequest(mastered, "session"), undefined);
  assert.notEqual(masteryReviewSignature(overview()), masteryReviewSignature({...overview(), goal_profile: {id: "other"}}));
});

test("the teacher's explicit offer only reads the current scope and cannot supply its own confirmation or grading options", async () => {
  const context = new TeachingSessionContext(); let reads = 0;
  const tool = createLearnerQuestionTool(context, new GoalOnboardingContext(), {log: () => undefined,
    fetchImpl: async (_url, options) => {assert.equal(options?.method ?? "GET", "GET"); reads++; return Response.json(overview());}});
  const execute = (params: Parameters<typeof tool.execute>[1]) => tool.execute("offer", params,
    new AbortController().signal, undefined, {} as Parameters<typeof tool.execute>[4]);
  await assert.rejects(execute({purpose: "CONFIRM_MASTERY", active_task_id: "foreign"}), /当前/);
  await assert.rejects(execute({purpose: "CONFIRM_MASTERY", questions: [{id: "fake", prompt: "已掌握", selection: "single", options: []}]}), /固定/);
  await execute({purpose: "CONFIRM_MASTERY", active_task_id: "task", active_skill_id: "skill"});
  assert.equal(context.learnerQuestions.snapshot().pending?.purpose, "CONFIRM_MASTERY");
  assert.equal(context.learnerQuestions.snapshot().last_answer, null); assert.equal(reads, 3);
  context.learnerQuestions.invalidate();
  context.recordTurn({active_skill_id: "skill", active_task_id: "task", teaching_mode: "QUIZ", outcome: "CORRECT",
    candidate_evidence: {evidence_type: "EXPLAIN", description: "之前的真实作答", supporting_interaction_summary: "当时的推理", assistance_level: "INDEPENDENT"}});
  await assert.rejects(execute({purpose: "CONFIRM_MASTERY"}), /先保存/);
  assert.equal(context.learnerQuestions.snapshot().pending, null);
  assert.equal(context.snapshot().candidate_evidence?.description, "之前的真实作答");
});

for (const [id, action] of [["proceed", "confirm"], ["revise", "needs_work"], ["skip", "skip"]] as const) {
  test(`self-review ${action} is real intent, never a scored answer or source of Evidence`, () => {
    const context = new TeachingSessionContext();
    const request = masteryReviewRequest(overview(), context.getSessionId())!;
    context.learnerQuestions.ask(request);
    context.learnerQuestions.answer("", reply(request, id, id === "revise" ? "还不理解闭包" : ""));
    const answer = context.learnerQuestions.snapshot().last_answer!;
    assert.equal(masteryReviewDecision(answer)?.action, action);
    assert.equal(answer.choices_exposed, false);
    for (const tool of ["record_answer_assessment", "record_teaching_turn", "active_recall_checkpoint", "submit_evidence"])
      assert.equal(context.learnerQuestions.writeGuard(tool)?.block, true);
    assert.equal(context.evidenceWriteGuard({skill_id: "skill", evidence_type: "EXPLAIN", description: "按钮点击", assistance_level: "INDEPENDENT", source: "self-report"})?.block, true);
    assert.equal(context.learnerQuestions.writeGuard("complete_learning_task")?.block, action === "needs_work" ? true : undefined);
    const restored = new LearnerQuestionsContext(); restored.restore(context.learnerQuestions.snapshot(), context.getSessionId());
    assert.equal(restored.snapshot().transition_decision?.action, action);
    const fork = new LearnerQuestionsContext(); fork.restore(context.learnerQuestions.snapshot(), "new-review-branch");
    assert.equal(fork.snapshot().transition_decision, undefined, "新复习分支不能继承原课堂的掌握同意，也不因旧票据中断创建");
  });
}

test("chat and ambiguous confirmation do not authorize mastery or consume the pending decision", () => {
  const context = new LearnerQuestionsContext(); const request = masteryReviewRequest(overview(), "s")!;
  context.ask(request); context.chat("我确认已经掌握");
  assert.equal(context.snapshot().pending?.id, request.id);
  assert.equal(context.snapshot().transition_decision, undefined);
  assert.throws(() => context.answer("", reply(request, "proceed", "但是我还不会")));
  assert.throws(() => context.answer("", reply({...request, id: "old"}, "proceed")));
  assert.equal(context.snapshot().pending?.id, request.id);
});

test("real Pi completion is held before the Kernel write, then skipping confirmation permits completion without Mastery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lawa-mastery-loop-")); const state = overview(); let completed = 0;
  const api = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url?.endsWith("/complete")) {
      completed++; state.active_task = null;
      return res.end(JSON.stringify({id: "task", title: "函数练习", status: "DONE", related_skill_ids: ["skill"]}));
    }
    assert.equal(req.method, "GET", "收尾建议和跳过不能写Mastery或Evidence"); res.end(JSON.stringify(state));
  });
  await new Promise<void>(done => api.listen(0, "127.0.0.1", done)); const address = api.address(); assert.ok(address && typeof address !== "string");
  const faux = createFauxCore({api: "openai-completions", provider: "aliyun-bailian", models: [{id: "qwen3.8-flash", contextWindow: 1_000_000, maxTokens: 32768}], tokensPerSecond: 0});
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("complete_learning_task", {task_id: "task"}, {id: "before-choice"}), {stopReason: "toolUse"}),
    () => {assert.equal(completed, 0); return fauxAssistantMessage("先看看这一节你觉得掌握得怎样。");},
    fauxAssistantMessage(fauxToolCall("complete_learning_task", {task_id: "task"}, {id: "after-choice"}), {stopReason: "toolUse"}),
    () => {assert.equal(completed, 1); return fauxAssistantMessage("保留这一节未确认状态，继续下一节。");},
  ]);
  const runtime = await ModelRuntime.create({authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models.json"), allowModelNetwork: false, refreshOnCreate: false});
  runtime.streamSimple = faux.streamSimple; runtime.hasConfiguredAuth = () => true;
  runtime.getAuth = async () => ({auth: {apiKey: "local-only"}, env: {}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  const context = new TeachingSessionContext(); const errors: string[] = [];
  const agent = await createLearningAgentSession(context, new GoalOnboardingContext(), {model: faux.getModel(), modelRuntime: runtime,
    sessionManager: SessionManager.inMemory(), surface: "WEB", retrieval: false, assistantSupport: false,
    apiBaseUrl: `http://127.0.0.1:${address.port}`, log: () => undefined, onEvent: e => {if (e.type === "model_error") errors.push(e.message);}});
  try {
    await agent.prompt("可以下一节了吗？"); const pending = context.learnerQuestions.snapshot().pending;
    assert.ok(pending && pending.purpose === "CONFIRM_MASTERY"); assert.equal(completed, 0);
    const intent = context.learnerQuestions.answer("", reply(pending, "skip")); context.beginUserTurn(intent, true);
    await agent.prompt(intent); assert.equal(completed, 1); assert.equal((state.skills[0] as {status: string}).status, "LEARNING"); assert.deepEqual(errors, []);
  } finally {agent.dispose(); api.closeAllConnections(); await new Promise<void>(done => api.close(() => done())); rmSync(dir, {recursive: true, force: true});}
});

async function withMasteryLoop(
  responses: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0],
  run: (fixture: {context: TeachingSessionContext; manager: SessionManager; agent: Awaited<ReturnType<typeof createLearningAgentSession>>;
    errors: string[]; toolEnds: {toolName: string; isError: boolean}[]}) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "lawa-mastery-terminate-"));
  const api = createServer((req, res) => {
    assert.equal(req.method, "GET", "呈现自评不能写入Mastery、Task或Evidence");
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(overview()));
  });
  await new Promise<void>(done => api.listen(0, "127.0.0.1", done));
  const address = api.address(); assert.ok(address && typeof address !== "string");
  const faux = createFauxCore({api: "openai-completions", provider: "aliyun-bailian",
    models: [{id: "qwen3.8-flash", contextWindow: 1_000_000, maxTokens: 32768}], tokensPerSecond: 0});
  faux.setResponses(responses);
  const runtime = await ModelRuntime.create({authPath: join(dir, "auth.json"), modelsPath: null,
    modelsStorePath: join(dir, "models.json"), allowModelNetwork: false, refreshOnCreate: false});
  runtime.streamSimple = faux.streamSimple; runtime.hasConfiguredAuth = () => true;
  runtime.getAuth = async () => ({auth: {apiKey: "local-only"}, env: {}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  const context = new TeachingSessionContext(); const manager = SessionManager.inMemory(); const errors: string[] = [];
  const toolEnds: {toolName: string; isError: boolean}[] = [];
  const agent = await createLearningAgentSession(context, new GoalOnboardingContext(), {model: faux.getModel(), modelRuntime: runtime,
    sessionManager: manager, surface: "WEB", retrieval: false, assistantSupport: false,
    apiBaseUrl: `http://127.0.0.1:${address.port}`, log: () => undefined,
    onEvent: e => {if (e.type === "model_error") errors.push(e.message); if (e.type === "tool_end") toolEnds.push(e);}});
  try {await run({context, manager, agent, errors, toolEnds});}
  finally {agent.dispose(); api.closeAllConnections(); await new Promise<void>(done => api.close(() => done())); rmSync(dir, {recursive: true, force: true});}
}

test("real Pi mastery offer completes its read-only reply and its three decisions remain answerable", async () => {
  let calls = 0;
  await withMasteryLoop([() => {
    calls++;
    return fauxAssistantMessage(fauxToolCall("ask_learner_questions", {purpose: "CONFIRM_MASTERY"}, {id: "mastery-offer"}), {stopReason: "toolUse"});
  }, () => {calls++; return fauxAssistantMessage("参数是输入，返回值是输出；打印和返回的区别已经讲清，按你的实际理解选择是否收尾。");}], async ({context, manager, agent, errors}) => {
    context.beginAgentTurn();
    const result = await agent.prompt("可以进入下一节了，请让我选择是否掌握。");
    const offered = context.learnerQuestions.snapshot().pending;
    assert.equal(offered?.purpose, "CONFIRM_MASTERY", "真实工具已经成功呈现卡片");
    assert.equal(calls, 2, "Web收尾卡后仍完成只读教学正文");
    const lastAssistant = manager.getBranch().findLast(e => e.type === "message" && e.message.role === "assistant");
    assert.ok(lastAssistant?.type === "message" && lastAssistant.message.role === "assistant");
    assert.equal(lastAssistant.message.stopReason, "stop", "收尾决定仍等待用户，教师正文可以正常完成");
    // WebSessionStore按返回状态结束Agent回合；错误判定曾在这里回滚已呈现的卡片。
    context.endAgentTurn(result?.status === "completed");
    const pending = context.learnerQuestions.snapshot().pending;
    assert.equal(pending?.id, offered?.id, "成功的掌握确认卡片不能在Web回合结束时消失");
    assert.equal(result?.status, "completed"); assert.deepEqual(errors, []);
    for (const [id, action] of [["proceed", "confirm"], ["revise", "needs_work"], ["skip", "skip"]] as const) {
      const restored = new LearnerQuestionsContext(); restored.restore(context.learnerQuestions.snapshot(), context.getSessionId());
      restored.answer("", reply(pending!, id, id === "revise" ? "闭包仍不清楚" : ""));
      assert.equal(masteryReviewDecision(restored.snapshot().last_answer!)?.action, action);
    }
  });
});

for (const stopReason of ["error", "aborted"] as const) {
  test(`an old mastery card cannot turn a new real Pi ${stopReason} into a completed turn`, async () => {
    await withMasteryLoop([fauxAssistantMessage("", {stopReason, errorMessage: "synthetic non-retryable failure"})],
      async ({context, agent}) => {
        const old = masteryReviewRequest(overview(), context.getSessionId())!;
        context.learnerQuestions.ask(old); context.beginAgentTurn();
        const result = await agent.prompt("再讲一下刚才的内容。");
        assert.equal(result?.status, stopReason === "error" ? "model_error" : "stopped");
        context.endAgentTurn(false);
        assert.equal(context.learnerQuestions.snapshot().pending?.id, old.id, "失败回合只回滚本轮，不吞掉之前已保存的卡片");
      });
  });
}

test("a failed real Pi mastery tool cannot be classified as a successful offer", async () => {
  await withMasteryLoop([
    fauxAssistantMessage(fauxToolCall("ask_learner_questions", {purpose: "CONFIRM_MASTERY", active_task_id: "foreign"}, {id: "invalid-offer"}), {stopReason: "toolUse"}),
    fauxAssistantMessage("", {stopReason: "error", errorMessage: "synthetic non-retryable failure"}),
  ], async ({context, agent, toolEnds}) => {
    context.beginAgentTurn(); const result = await agent.prompt("进入下一节。");
    assert.equal(toolEnds.find(e => e.toolName === "ask_learner_questions")?.isError, true);
    assert.equal(result?.status, "model_error"); context.endAgentTurn(false);
    assert.equal(context.learnerQuestions.snapshot().pending, null);
  });
});

test("a successful terminating mastery offer cannot hide a failed Pi persistence verification", async () => {
  await withMasteryLoop([
    fauxAssistantMessage(fauxToolCall("ask_learner_questions", {purpose: "CONFIRM_MASTERY"}, {id: "unsaved-offer"}), {stopReason: "toolUse"}),
  ], async ({context, manager, agent, toolEnds}) => {
    // 模拟Pi声明了会话文件，但本轮追加无法从磁盘读回；工具成功不等于保存成功。
    const original = manager.getSessionFile.bind(manager);
    manager.getSessionFile = () => join(tmpdir(), `lawa-missing-${manager.getSessionId()}.jsonl`);
    try {
      context.beginAgentTurn(); const result = await agent.prompt("进入下一节前让我自评。");
      assert.equal(toolEnds.find(e => e.toolName === "ask_learner_questions")?.isError, true);
      assert.equal(result?.status, "persist_error");
      context.endAgentTurn(false);
      assert.equal(context.learnerQuestions.snapshot().pending, null);
    } finally {manager.getSessionFile = original;}
  });
});

test("a real Pi mixed tool batch followed by model error rolls back its new mastery card", async () => {
  await withMasteryLoop([
    fauxAssistantMessage([
      fauxToolCall("ask_learner_questions", {purpose: "CONFIRM_MASTERY"}, {id: "mixed-offer"}),
      fauxToolCall("get_learning_overview", {}, {id: "mixed-read"}),
    ], {stopReason: "toolUse"}),
    fauxAssistantMessage("", {stopReason: "error", errorMessage: "synthetic non-retryable failure"}),
  ], async ({context, agent, toolEnds}) => {
    context.beginAgentTurn(); const result = await agent.prompt("先问我是否掌握，同时看看进度。");
    assert.equal(toolEnds.find(e => e.toolName === "ask_learner_questions")?.isError, true);
    assert.equal(context.learnerQuestions.snapshot().pending, null, "混合工具被执行前拒绝，没有成功创建题卡");
    assert.equal(result?.status, "model_error"); context.endAgentTurn(false);
    assert.equal(context.learnerQuestions.snapshot().pending, null, "混合工具后仍发生模型失败，不能凭卡片存在就认成功");
  });
});
