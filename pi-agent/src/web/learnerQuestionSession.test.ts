import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { createGateway } from "./gateway.js";
import type { RetrievalRuntime } from "../retrieval/runtime.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { LearningAgentSession } from "../agentSession.js";
import type { LearningOverview } from "../learningOverviewTool.js";
import type { LearnerQuestionRequest } from "../learnerQuestionTypes.js";
import type { TeachingSessionContext } from "../teachingSession.js";
import { WebSessionStore, type WebSessionEvent, type WebSessionStoreOptions } from "./sessionStore.js";
import { createLearnerQuestionTool } from "../learnerQuestionTool.js";
import { learningStartSignature } from "../learnerQuestions.js";
import type { GoalOnboardingContext } from "../planning/goalOnboarding.js";

function overview(): LearningOverview {
  return { current_goal: "理解学习上下文", goal_profile: { id: "goal-q" }, curriculum_spine: [],
    current_frontier: null, current_focus: null, skills: [{ id: "skill-q", status: "LEARNING" }],
    recent_evidence: [], active_task: { id: "task-q", related_skill_ids: ["skill-q"], status: "ACTIVE" },
    current_goal_skill_ids: ["skill-q"], learning_history: [] };
}
function question(sessionId: string): LearnerQuestionRequest {
  return { id: "request-q", session_id: sessionId, purpose: "CHECK", goal_id: "goal-q", skill_id: "skill-q", task_id: "task-q",
    questions: [{ id: "meaning", prompt: "Session 保存什么？请说明用途。", selection: "single",
      options: [{ id: "history", label: "完整对话历史" }, { id: "latest", label: "仅最后一条回复" }] }] };
}
const reply = { request_id: "request-q", answers: [{ question_id: "meaning", selected_option_ids: ["history"], other_text: "保留历史用于回看和构建上下文" }] };

function fixture(extra: Partial<WebSessionStoreOptions> = {}) {
  let current = overview();
  let failure = false;
  const contexts = new Map<string, TeachingSessionContext>();
  const prompts: string[] = [];
  const options: WebSessionStoreOptions = {
    fetchOverview: async () => current, fetchLibrary: async () => ({ projects: [] }),
    createAgent: async (context, _planning, emit, manager): Promise<LearningAgentSession> => {
      contexts.set(context.getSessionId(), context);
      return { prompt: async (text) => {
        prompts.push(text);
        manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
        if (text === "提问") {
          context.learnerQuestions.ask(question(context.getSessionId()));
          manager.appendMessage(fauxAssistantMessage("请按自己的判断选择，并说明理由。"));
        } else if (failure) {
          context.learnerQuestions.ask({ ...question(context.getSessionId()), id: "failed-next-question" });
          emit({ type: "model_error", message: "isolated model failure" });
        } else {
          context.recordTurn({ active_skill_id: "skill-q", active_task_id: "task-q", teaching_mode: "QUIZ", outcome: "CORRECT",
            candidate_evidence: { evidence_type: "EXPLAIN", description: "解释历史保存用途", supporting_interaction_summary: "实际理由" } });
        }
      }, abort: async () => undefined, dispose: () => undefined };
    }, ...extra,
  };
  return { options, contexts, prompts, setFailure: (value: boolean) => { failure = value; }, setOverview: (value: LearningOverview) => { current = value; } };
}

test("browser state and classroom snapshot omit legacy pending grading answers without mutating the teacher record", async () => {
  const f = fixture();
  const raw = overview();
  (raw.active_task as any).teaching_activity = {evaluation_focus: ["private-result-42"]};
  raw.current_focus = structuredClone(raw.active_task);
  f.setOverview(raw);
  const store = new WebSessionStore(f.options);
  let server: ReturnType<typeof createGateway> | undefined;
  try {
    const session = await store.create("resume-recent");
    await store.sendMessage(session.sessionId, "初始化", () => undefined);
    const request = question(session.sessionId);
    request.assessment_contract_id = "frozen-contract";
    request.questions[0]!.prompt += "\n本题检查：private-result-42（6分）；private-result-43（4分）";
    f.contexts.get(session.sessionId)!.learnerQuestions.ask(request);
    const before = f.contexts.get(session.sessionId)!.snapshot();
    const state = await store.state(session.sessionId);
    assert.doesNotMatch(JSON.stringify(state), /private-result-/);
    assert.doesNotMatch(JSON.stringify(await store.sharedClassroom()), /private-result-/);
    server = createGateway({store,retrieval:{scopeChanged:()=>{}} as unknown as RetrievalRuntime});
    server.listen(0,"127.0.0.1"); await once(server,"listening");
    const address = server.address(); assert.ok(address && typeof address === "object");
    for (const path of [`/api/web/sessions/${session.sessionId}/state`, "/api/web/classroom/snapshot"]) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}${path}`);
      assert.equal(response.status,200);
      assert.doesNotMatch(await response.text(), /private-result-/);
    }
    assert.equal(state.teaching.learner_questions!.pending!.questions[0]!.prompt, question(session.sessionId).questions[0]!.prompt);
    assert.deepEqual(f.contexts.get(session.sessionId)!.snapshot(), before);
    assert.match(JSON.stringify(raw), /private-result-42/, "projection must not rewrite Kernel facts");
    await store.sendMessage(session.sessionId, "", () => undefined, reply);
    assert.deepEqual((await store.state(session.sessionId)).teaching.learner_questions!.last_answer!.reply, reply);
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    store.dispose();
  }
});

test("a goal decision reaches confirmation only after a real submitted click, and a changed profile invalidates the old button", async () => {
  let planning!: GoalOnboardingContext;
  const profile = { id: "new", goal_description: "理解上下文", background_summary: "初学", desired_outcome: "解释用途", learning_preferences: [], time_constraint: "", prior_knowledge_claims: [] };
  let seen = "";
  const f = fixture({ createAgent: async (context, currentPlanning, _emit, manager) => {
    planning = currentPlanning;
    return { prompt: async text => {
      manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
      if (text === "准备目标") {
        planning.record({ outcome: "READY_FOR_CONFIRMATION", profile });
        await createLearnerQuestionTool(context, planning).execute("decision", { purpose: "CONFIRM_GOAL" }, new AbortController().signal, undefined, {} as any);
      } else { seen = text; planning.record({ outcome: "CONFIRMED" }); }
    }, abort: async () => undefined, dispose: () => undefined };
  } });
  const store = new WebSessionStore(f.options);
  try {
    const session = await store.create("new-goal"); await store.sendMessage(session.sessionId, "准备目标", () => undefined);
    const pending = (await store.state(session.sessionId)).teaching.learner_questions!.pending!;
    assert.equal(planning.snapshot().status, "READY_FOR_CONFIRMATION");
    const clicked = { request_id: pending.id, answers: [{ question_id: pending.questions[0]!.id, selected_option_ids: ["proceed"], other_text: "" }] };
    await store.sendMessage(session.sessionId, "", () => undefined, clicked);
    assert.equal(seen, "确认"); assert.equal(planning.snapshot().status, "CONFIRMED");
    await store.sendMessage(session.sessionId, "准备目标", () => undefined);
    const old = (await store.state(session.sessionId)).teaching.learner_questions!.pending!;
    planning.record({ outcome: "READY_FOR_CONFIRMATION", profile: { ...profile, desired_outcome: "改为构建" } });
    await assert.rejects(() => store.sendMessage(session.sessionId, "", () => undefined, { ...clicked, request_id: old.id }), /已失效/);
    assert.equal(planning.snapshot().status, "READY_FOR_CONFIRMATION");
  } finally { store.dispose(); }
});

test("a saved goal button cannot restore confirmation authority after Gateway restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-question-session-"));
  const profile = { id: "new", goal_description: "目标", background_summary: "", desired_outcome: "解释", learning_preferences: [], time_constraint: "", prior_knowledge_claims: [] };
  const f = fixture({ conversationDir: directory, createAgent: async (context, planning) => ({
    prompt: async () => { planning.record({ outcome: "READY_FOR_CONFIRMATION", profile });
      await createLearnerQuestionTool(context, planning).execute("decision", { purpose: "CONFIRM_GOAL" }, new AbortController().signal, undefined, {} as any); },
    abort: async () => undefined, dispose: () => undefined,
  }) });
  const store = new WebSessionStore(f.options); let restored: WebSessionStore | undefined;
  try {
    const session = await store.create("new-goal"); await store.sendMessage(session.sessionId, "目标", () => undefined);
    assert.equal((await store.state(session.sessionId)).teaching.learner_questions?.pending?.purpose, "CONFIRM_GOAL");
    store.dispose(); restored = new WebSessionStore(f.options);
    const resumed = await restored.create("resume-recent");
    assert.equal(resumed.state.teaching.learner_questions?.pending, null);
    assert.notEqual(resumed.state.onboarding.status, "CONFIRMED");
  } finally {
    restored?.dispose(); store.dispose();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("lawa-question-session-"));
    rmSync(directory, { recursive: true, force: true });
  }
});

function startQuestion(sessionId: string): LearnerQuestionRequest {
  return { id: "request-start", session_id: sessionId, purpose: "START_LEARNING", goal_id: "goal-q", skill_id: "skill-q", task_id: "task-q",
    scope_signature: learningStartSignature(overview()), questions: [{ id: "start-learning", prompt: "准备好开始了吗？", selection: "single", options: [{ id: "proceed", label: "开始学习" }] }] };
}

test("a start action becomes stale when the same Goal's learning scope changes", async () => {
  let calls = 0;
  const f = fixture({ createAgent: async context => ({ prompt: async () => {
    calls++; context.learnerQuestions.ask(startQuestion(context.getSessionId()));
  }, abort: async () => undefined, dispose: () => undefined }) });
  const store = new WebSessionStore(f.options);
  try {
    const session = await store.create(); await store.sendMessage(session.sessionId, "准备", () => undefined);
    const pending = (await store.state(session.sessionId)).teaching.learner_questions!.pending!;
    const changed = overview(); changed.current_frontier = { focus_skill_id: "skill-next", supporting_skill_ids: [] }; f.setOverview(changed);
    await assert.rejects(() => store.sendMessage(session.sessionId, "", () => undefined, {
      request_id: pending.id, answers: [{ question_id: "start-learning", selected_option_ids: ["proceed"], other_text: "" }],
    }), /已失效/);
    assert.equal(calls, 1);
    assert.equal((await store.state(session.sessionId)).teaching.learner_questions?.pending, null);
  } finally { store.dispose(); }
});

test("a failed teacher round preserves the actual start intent on retry without Evidence or choice hints", async () => {
  let failure = true;
  let context!: TeachingSessionContext;
  const f = fixture({ createAgent: async (teaching, _planning, emit, manager) => {
    context = teaching;
    return { prompt: async text => {
      manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
      if (text === "准备") context.learnerQuestions.ask(startQuestion(context.getSessionId()));
      else if (failure) emit({ type: "model_error", message: "isolated decision failure" });
      else assert.equal(context.learnerQuestions.writeGuard("activate_learning_task"), undefined);
    }, abort: async () => undefined, dispose: () => undefined };
  } });
  const store = new WebSessionStore(f.options);
  try {
    const session = await store.create(); await store.sendMessage(session.sessionId, "准备", () => undefined);
    await store.sendMessage(session.sessionId, "", () => undefined, {
      request_id: "request-start", answers: [{ question_id: "start-learning", selected_option_ids: ["proceed"], other_text: "" }],
    });
    const failed = (await store.state(session.sessionId)).teaching.learner_questions!;
    assert.equal(failed.pending, null); assert.equal(failed.last_answer!.text, "开始学习");
    assert.equal(failed.last_answer!.choices_exposed, false);
    failure = false; await store.sendMessage(session.sessionId, "开始学习", () => undefined);
    assert.deepEqual(context.learnerQuestions.snapshot().last_answer?.reply, failed.last_answer!.reply);
    assert.deepEqual((await store.state(session.sessionId)).overview.recent_evidence, []);
    assert.equal(context.snapshot().candidate_evidence, null);
  } finally { store.dispose(); }
});

test("accepted answers publish their state before the teacher responds; rejected answers never do", async () => {
  let enter!: () => void; let release!: () => void;
  const started = new Promise<void>(done => { enter = done; });
  const blocked = new Promise<void>(done => { release = done; });
  const f = fixture({ createAgent: async (context) => ({
    prompt: async text => {
      if (text === "提问") context.learnerQuestions.ask(question(context.getSessionId()));
      else { enter(); await blocked; }
    }, abort: async () => { release(); }, dispose: () => undefined,
  }) });
  const store = new WebSessionStore(f.options);
  let running: Promise<void> | undefined;
  try {
    const session = await store.create();
    await store.sendMessage(session.sessionId, "提问", () => undefined);
    const events: WebSessionEvent[] = [];
    await assert.rejects(() => store.sendMessage(session.sessionId, "", event => events.push(event), { ...reply, request_id: "stale" }));
    assert.equal(events.length, 0, "未接收的回答不能令页面撤掉待答题");
    running = store.sendMessage(session.sessionId, "", event => events.push(event), reply);
    await started;
    const accepted = events.find(event => event.type === "state");
    assert.ok(accepted?.type === "state", "接收答案后、模型回复前必须立即通知页面");
    assert.equal(accepted.state.teaching.learner_questions?.pending, null);
    assert.deepEqual(accepted.state.teaching.learner_questions?.last_answer?.reply, reply);
    assert.equal(events.some(event => event.type === "done"), false, "接收答案并不代表模型回合结束");
  } finally { release(); await running; store.dispose(); }
});

test("Gateway restart restores the actual pending question and accepted answer; checkpoint is not recreated", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-question-session-"));
  const f = fixture({ conversationDir: directory });
  let store = new WebSessionStore(f.options);
  try {
    const session = await store.create("new");
    await store.sendMessage(session.sessionId, "提问", () => undefined);
    store.dispose(); store = new WebSessionStore(f.options);
    const restored = await store.create("resume-recent");
    assert.equal(restored.sessionId, session.sessionId);
    assert.deepEqual(restored.state.teaching.learner_questions?.pending, question(session.sessionId));
    assert.equal(restored.state.teaching.active_recall, null);
    assert.equal(f.prompts.length, 1, "restoring must not call the teacher");
    await store.sendMessage(restored.sessionId, "", () => undefined, reply);
    const answered = await store.state(restored.sessionId);
    assert.deepEqual(answered.teaching.learner_questions?.last_answer?.reply, reply);
    assert.equal(answered.teaching.candidate_evidence?.assistance_level, "WITH_HINT");
    assert.match(answered.teaching.candidate_evidence?.description ?? "", /完整对话历史/);
    store.dispose(); store = new WebSessionStore(f.options);
    const reopened = await store.create("resume-recent");
    assert.deepEqual(reopened.state.teaching.learner_questions?.last_answer?.reply, reply);
    assert.equal(reopened.state.teaching.candidate_evidence, null, "restart cannot recreate Evidence permission");
    assert.deepEqual(reopened.state.overview.recent_evidence, []);
  } finally {
    store.dispose();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("lawa-question-session-"));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid, stale and cross-conversation replies cannot reach the model or manufacture an answer", async () => {
  const f = fixture(); const store = new WebSessionStore(f.options);
  try {
    const a = await store.create("new"); await store.sendMessage(a.sessionId, "提问", () => undefined);
    await assert.rejects(() => store.sendMessage(a.sessionId, "", () => undefined, { ...reply, request_id: "stale" }), /问题已变化/);
    assert.equal((await store.state(a.sessionId)).teaching.learner_questions?.pending?.id, "request-q");
    const changed = overview(); changed.active_task = { id: "next-task", related_skill_ids: ["skill-q"], status: "ACTIVE" }; f.setOverview(changed);
    assert.equal((await store.state(a.sessionId)).teaching.learner_questions?.pending, null);
    await assert.rejects(() => store.sendMessage(a.sessionId, "", () => undefined, reply), /已失效/);
    const b = await store.create("new");
    await assert.rejects(() => store.sendMessage(b.sessionId, "", () => undefined, reply), /已失效/);
    assert.equal(f.prompts.length, 1);
  } finally { store.dispose(); }
});

test("model errors undo new questions while preserving accepted human replies and their help level on retry", async () => {
  const f = fixture(); const store = new WebSessionStore(f.options);
  try {
    const session = await store.create(); await store.sendMessage(session.sessionId, "提问", () => undefined);
    f.setFailure(true); await store.sendMessage(session.sessionId, "", () => undefined, reply);
    const failed = await store.state(session.sessionId);
    assert.equal(failed.teaching.learner_questions?.pending, null);
    assert.deepEqual(failed.teaching.learner_questions?.last_answer?.reply, reply);
    f.setFailure(false); await store.sendMessage(session.sessionId, failed.teaching.learner_questions!.last_answer!.text, () => undefined);
    const retried = await store.state(session.sessionId);
    assert.equal(retried.teaching.candidate_evidence?.assistance_level, "WITH_HINT");
    assert.match(retried.teaching.candidate_evidence?.description ?? "", /保留历史用于回看/);
  } finally { store.dispose(); }
});

test("stopped generation preserves submitted choices but cannot leave a new pending question", async () => {
  let release: (() => void) | undefined; let entered: (() => void) | undefined;
  const started = new Promise<void>(done => { entered = done; });
  const blocked = new Promise<void>(done => { release = done; });
  const f = fixture({ createAgent: async (context, _planning, _emit, manager) => ({
    prompt: async text => {
      manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
      if (text === "提问") context.learnerQuestions.ask(question(context.getSessionId()));
      else { context.learnerQuestions.ask({ ...question(context.getSessionId()), id: "unfinished" }); entered?.(); await blocked; }
    }, abort: async () => { release?.(); }, dispose: () => undefined,
  }) });
  const store = new WebSessionStore(f.options);
  try {
    const session = await store.create(); await store.sendMessage(session.sessionId, "提问", () => undefined);
    const pending = store.sendMessage(session.sessionId, "", () => undefined, reply);
    await started; await store.stop(session.sessionId); await pending;
    const stopped = await store.state(session.sessionId);
    assert.equal(stopped.teaching.learner_questions?.pending, null);
    assert.deepEqual(stopped.teaching.learner_questions?.last_answer?.reply, reply);
    assert.deepEqual(stopped.overview.recent_evidence, []);
  } finally { store.dispose(); }
});

test("ordinary composer text interrupts the question without becoming a submitted answer", async () => {
  const f = fixture(); const store = new WebSessionStore(f.options);
  try {
    const session = await store.create(); await store.sendMessage(session.sessionId, "提问", () => undefined);
    await store.sendMessage(session.sessionId, "我按自己的理解回答：历史支持追溯与复用。", () => undefined);
    const actual = (await store.state(session.sessionId)).teaching.learner_questions!;
    assert.equal(actual.last_answer, null);
    assert.equal(actual.pending, null);
    assert.equal(actual.chat_interruption?.request_id, "request-q");
    assert.equal(f.prompts[1], actual.chat_interruption?.text);
  } finally { store.dispose(); }
});
