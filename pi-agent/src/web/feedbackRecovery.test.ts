import {createTeachingFaux as createFauxCore} from "../testing/teachingFaux.js";
import assert from "node:assert/strict";
import test from "node:test";
import {createServer} from "node:http";
import {once} from "node:events";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import {ModelRuntime, type SessionManager} from "@earendil-works/pi-coding-agent";
import {fauxAssistantMessage, fauxToolCall} from "@earendil-works/pi-ai";
import {createLearningAgentSession} from "../agentSession.js";
import type {LearningOverview} from "../learningOverviewTool.js";
import type {TeachingSessionContext} from "../teachingSession.js";
import {WebSessionStore, type WebSessionStoreOptions} from "./sessionStore.js";
import {createGateway} from "./gateway.js";
import type {RetrievalRuntime} from "../retrieval/runtime.js";

const question = "1/4和1/8哪个更大？为什么？";
const grading = {question, topic: "单位分数比较", assistance_level: "WITH_HELP", criteria: [{label: "比较与解释", earned: 10, possible: 10, feedback: "比较和同一整体解释正确"}], summary: "回答正确", strengths: ["同一整体下比较每份大小"], gaps: []};

async function fixture(run: (f: {store: WebSessionStore; context: () => TeachingSessionContext; manager: () => SessionManager;
  state: LearningOverview; requests: () => number; assessmentPosts: () => number; assessments: Map<string, unknown>; failSave: (value: boolean) => void;
  restart: () => WebSessionStore; blockRetry: (wait: Promise<void>, entered: () => void) => void}) => Promise<void>, saveFails = false,
  mode: "normal" | "preflight" | "after-saved" | "evidence" | "skip-grade" | "skip-initial-grade" | "lost-save-response" | "unknown-save-response" = "normal") {
  const dir = mkdtempSync(join(tmpdir(), "lawa-feedback-recovery-"));
  const state: LearningOverview = {current_goal: "理解分数", goal_profile: {id: "goal"}, current_frontier: {focus_skill_id: "skill"}, current_focus: null,
    active_task: {id: "task", status: "ACTIVE", related_skill_ids: ["skill"]}, skills: [{id: "skill", name: "分数", status: "LEARNING"}],
    current_goal_skill_ids: ["skill"], curriculum_spine: [], recent_evidence: [], learning_history: []};
  const assessments = new Map<string, any>(); let fail = saveFails, requests = 0, posts = 0, receiptReads = 0;
  let retryWait: Promise<void> | undefined, retryEntered: (() => void) | undefined;
  const api = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url === "/api/learning/answer-assessments") {
      posts++;
      let text = ""; for await (const chunk of req) text += chunk;
      if (fail) {res.statusCode = 503; return res.end(JSON.stringify({detail: "temporary save failure"}));}
      const body = JSON.parse(text); const value = assessments.get(body.id) ?? {...body, topic_id: "topic", score: 10, max_score: 10, follow_up: "RECHECK", review_after: 5, created_at: new Date().toISOString()};
      assessments.set(body.id, value);
      if (["lost-save-response", "unknown-save-response"].includes(mode) && posts === 1) return res.destroy();
      return res.end(JSON.stringify(value));
    }
    if (req.method === "GET" && req.url?.startsWith("/api/learning/answer-assessments?"))
      return res.end(JSON.stringify({assessments: [...assessments.values()], next_offset: null}));
    if (req.method === "GET" && req.url?.startsWith("/api/learning/answer-assessments/")) {
      receiptReads++;
      if (mode === "unknown-save-response" && receiptReads === 1) {res.statusCode = 503; return res.end(JSON.stringify({detail: "temporarily unknown"}));}
      const id = new URL(req.url, "http://local").pathname.split("/").at(-1)!;
      const saved = assessments.get(id);
      if (!saved) {res.statusCode = 404; return res.end(JSON.stringify({detail: "not saved"}));}
      return res.end(JSON.stringify(saved));
    }
    assert.equal(req.method, "GET", "retry cannot write Mastery or change the task");
    res.end(JSON.stringify(state));
  });
  await new Promise<void>(done => api.listen(0, "127.0.0.1", done)); const address = api.address(); assert.ok(address && typeof address !== "string");
  const faux = createFauxCore({api: "openai-completions", provider: "aliyun-bailian", models: [{id: "qwen3.8-flash", contextWindow: 1_000_000, maxTokens: 32768}], tokensPerSecond: 0});
  const result = (value: ReturnType<typeof fauxAssistantMessage>) => async () => {
    requests++;
    if (value.content.some(part => part.type === "toolCall" && part.id === "grade-on-retry")) {retryEntered?.(); await retryWait;}
    return value;
  };
  faux.setResponses([
    result(fauxAssistantMessage(question)),
    result(mode === "skip-initial-grade" ? fauxAssistantMessage(fauxToolCall("ask_learner_questions", {purpose: "CONFIRM_MASTERY"}, {id: "advance-ungraded"}), {stopReason: "toolUse"})
      : saveFails || mode === "after-saved" || ["lost-save-response", "unknown-save-response"].includes(mode) ? fauxAssistantMessage(fauxToolCall("record_answer_assessment", mode === "preflight" ? {...grading, question: "并非原题"} : grading, {id: "grade-fails"}), {stopReason: "toolUse"})
      : fauxAssistantMessage("", {stopReason: "error", errorMessage: "409 status code (no body)"})),
    ...(["skip-initial-grade", "lost-save-response", "unknown-save-response"].includes(mode) ? [result(fauxAssistantMessage("回答正确，我们继续。"))] : []),
    ...(saveFails ? [result(fauxAssistantMessage(fauxToolCall("ask_learner_questions", {purpose: "CONFIRM_MASTERY"}, {id: "advance-too-soon"}), {stopReason: "toolUse"})), result(fauxAssistantMessage("评分没有保存，稍后继续。"))] : []),
    ...(mode === "after-saved" ? [result(fauxAssistantMessage("", {stopReason: "error", errorMessage: "409 status code (no body)"}))] : []),
    result(mode === "skip-grade" ? fauxAssistantMessage("回答正确，我们继续。") : fauxAssistantMessage(fauxToolCall("record_answer_assessment",
      mode === "unknown-save-response" ? {...grading, criteria: [{label: "比较与解释", earned: 1, possible: 10, feedback: "重试模型给出不同判断"}], gaps: ["重试模型的新判断不可替换已保存成绩"]} : grading,
      {id: "grade-on-retry"}), {stopReason: "toolUse"})),
    ...(mode === "evidence" ? [result(fauxAssistantMessage(fauxToolCall("submit_evidence", {skill_id: "skill", evidence_type: "EXPLAIN", description: "已保存的原解释", assistance_level: "WITH_HELP", source: "interactive-teaching-session"}, {id: "duplicate-evidence"}), {stopReason: "toolUse"}))] : []),
    result(fauxAssistantMessage("本次评分已保存，回答正确。")),
  ]);
  const runtime = await ModelRuntime.create({authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models.json"), allowModelNetwork: false, refreshOnCreate: false});
  runtime.streamSimple = faux.streamSimple; runtime.hasConfiguredAuth = () => true; runtime.getAuth = async () => ({auth: {apiKey: "local-only"}, env: {}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  let context!: TeachingSessionContext, manager!: SessionManager;
  const options: WebSessionStoreOptions = {conversationDir: join(dir, "sessions"), conversationCwd: dir, apiBaseUrl: `http://127.0.0.1:${address.port}`,
    fetchOverview: async () => structuredClone(state), fetchLibrary: async () => ({projects: []}), log: () => undefined,
    createAgent: (ctx, planning, onEvent, sm) => {context = ctx; manager = sm; return createLearningAgentSession(ctx, planning, {model: faux.getModel(), modelRuntime: runtime, sessionManager: sm,
      surface: "WEB", retrieval: false, assistantSupport: false, apiBaseUrl: `http://127.0.0.1:${address.port}`, teachingInstructions: () => "", onEvent, log: () => undefined});}};
  let store = new WebSessionStore(options);
  try {await run({get store() {return store;}, context: () => context, manager: () => manager, state, requests: () => requests, assessments, assessmentPosts: () => posts,
    failSave: value => {fail = value;}, restart: () => {store.dispose(); store = new WebSessionStore(options); return store;},
    blockRetry: (wait, entered) => {retryWait = wait; retryEntered = entered;}});}
  finally {store.dispose(); api.closeAllConnections(); await new Promise<void>(done => api.close(() => done()));
    assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith("lawa-feedback-recovery-")); rmSync(dir, {recursive: true, force: true});}
}

async function submit(f: Parameters<Parameters<typeof fixture>[0]>[0]) {
  const session = await f.store.create(); await f.store.sendMessage(session.sessionId, "请出一道题", () => undefined);
  f.context().learnerQuestions.ask({id: "question", purpose: "CHECK", session_id: session.sessionId, goal_id: "goal", task_id: "task", skill_id: "skill",
    questions: [{id: "q", prompt: question, selection: "freeform", options: []}]});
  await f.store.sendMessage(session.sessionId, "", () => undefined, {request_id: "question", answers: [{question_id: "q", selected_option_ids: [], other_text: "1/4比1/8大，因为同一张饼切成4份时每份更大"}]});
  return session.sessionId;
}

test("explicit feedback retry keeps the original real answer and question source instead of appending a new user", async () => fixture(async f => {
  const id = await submit(f); const before = await f.store.state(id);
  const recovery = (before as any).feedback_recovery;
  assert.ok(recovery?.id, "interrupted feedback needs an actionable recovery operation, not only reconnection");
  const users = f.manager().getBranch().filter(e => e.type === "message" && e.message.role === "user"); const original = users.at(-1)!;
  await (f.store as any).retryFeedback(id, recovery.id, () => undefined, before.classroom_version);
  assert.equal(f.manager().getBranch().filter(e => e.type === "message" && e.message.role === "user").length, users.length);
  assert.equal(f.assessments.size, 1); const saved = [...f.assessments.values()][0] as any;
  assert.equal(saved.source_turn_id, original.id); assert.equal(saved.question, question);
  assert.equal((await f.store.state(id) as any).feedback_recovery, null); assert.equal(f.store.classroom.snapshot()?.status, "completed");
  await assert.rejects((f.store as any).retryFeedback(id, recovery.id, () => undefined), /失效|完成|没有/);
}));

test("the first CHECK feedback cannot silently advance without ever attempting its grade", async () => fixture(async f => {
  const id = await submit(f); const state = await f.store.state(id);
  assert.equal((state as any).feedback_recovery?.reason, "assessment_failed");
  assert.equal(state.teaching.learner_questions?.pending, null);
  assert.equal(f.assessments.size, 0);
  assert.equal(f.store.classroom.snapshot()?.status, "interrupted");
}, false, "skip-initial-grade"));

test("a committed grade with a lost POST response is reconciled from Kernel before another write", async () => fixture(async f => {
  const id = await submit(f); const state = await f.store.state(id);
  assert.equal(f.assessments.size, 1);
  assert.equal(f.assessmentPosts(), 1);
  assert.equal((state as any).feedback_recovery, null, "an authoritative read can finish the receipt after a lost response");
  const cards = (await f.store.sharedClassroom()).session!.messages.filter(message => message.assessment);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.assessment!.question, question);
}, false, "lost-save-response"));

test("an unknown save outcome stays recoverable and its explicit retry reads the original grade without reposting", async () => fixture(async f => {
  const id = await submit(f); const before = await f.store.state(id);
  assert.equal((before as any).feedback_recovery?.reason, "assessment_failed");
  assert.equal(f.assessments.size, 1); assert.equal(f.assessmentPosts(), 1);
  await f.store.retryFeedback(id, (before as any).feedback_recovery.id, () => undefined, before.classroom_version);
  assert.equal((await f.store.state(id) as any).feedback_recovery, null);
  assert.equal(f.assessmentPosts(), 1, "reconciliation must happen before another POST");
  const operation = f.manager().getBranch().findLast(row => row.type === "custom_message" && row.customType === "lawa.feedback-retry");
  assert.ok(operation?.type === "custom_message");
  const details = operation.details as {source_user_entry_id: string; requested_at: string};
  assert.ok(Number.isFinite(Date.parse(details.requested_at)), "the recovery request has its real time, not the original answer time");
  const assessment = [...f.assessments.values()][0] as any;
  assert.equal(details.source_user_entry_id, assessment.source_turn_id);
  assert.equal(assessment.score, 10, "the first authoritative grade is frozen even if the retry model proposes another score");
  const card = (await f.store.sharedClassroom()).session!.messages.find(message => message.assessment)?.assessment;
  assert.equal(card?.score, 10);
}, false, "unknown-save-response"));

test("failed assessment remains recoverable and cannot silently present the next learning decision", async () => fixture(async f => {
  const id = await submit(f); const before = await f.store.state(id);
  assert.equal((before as any).feedback_recovery?.reason, "assessment_failed");
  assert.equal(before.teaching.learner_questions?.pending, null, "failed grading must not advance to a mastery or next-question card");
  assert.equal(f.assessments.size, 0); f.failSave(false);
  await (f.store as any).retryFeedback(id, (before as any).feedback_recovery.id, () => undefined, before.classroom_version);
  assert.equal(f.assessments.size, 1); assert.equal((await f.store.state(id) as any).feedback_recovery, null);
}, true));

test("a preflight-rejected grade stays pending instead of being treated as completed feedback", async () => fixture(async f => {
  const id = await submit(f); const state = await f.store.state(id);
  assert.equal((state as any).feedback_recovery?.reason, "assessment_failed"); assert.equal(f.assessmentPosts(), 0);
  const results = f.manager().getBranch().filter(e => e.type === "message" && e.message.role === "toolResult");
  assert.ok(results.some(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "record_answer_assessment" && e.message.isError));
  assert.equal(state.teaching.learner_questions?.pending, null);
}, true, "preflight"));

test("shared state and a store restart retain the exact recoverable operation without replaying a model", async () => fixture(async f => {
  const id = await submit(f); const state = await f.store.state(id); const recovery = (state as any).feedback_recovery;
  const shared = await f.store.sharedClassroom(); assert.deepEqual((shared.session!.state as any).feedback_recovery, recovery);
  const before = f.requests(); f.restart(); const restored = await f.store.create("resume-recent");
  assert.equal(restored.sessionId, id); assert.deepEqual((restored.state as any).feedback_recovery, recovery); assert.equal(f.requests(), before);
  await (f.store as any).retryFeedback(id, recovery.id, () => undefined, restored.state.classroom_version);
  assert.equal(f.assessments.size, 1);
}));

test("stale browser versions and a changed task reject retry before any model call", async () => fixture(async f => {
  const id = await submit(f); const state = await f.store.state(id); const recovery = (state as any).feedback_recovery;
  const before = f.requests();
  await assert.rejects((f.store as any).retryFeedback(id, recovery.id, () => undefined, "stale"), /现场已变化/);
  (f.state.active_task as any).id = "other-task";
  await assert.rejects((f.store as any).retryFeedback(id, recovery.id, () => undefined, state.classroom_version), /失效/);
  assert.equal(f.requests(), before); assert.equal(f.assessments.size, 0);
}));

test("two concurrent retry clicks start only one resumed model operation", async () => fixture(async f => {
  const id = await submit(f); const state = await f.store.state(id); const recovery = (state as any).feedback_recovery;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(done => {release = done;}); const started = new Promise<void>(done => {entered = done;});
  f.blockRetry(gate, entered);
  const first = (f.store as any).retryFeedback(id, recovery.id, () => undefined, state.classroom_version);
  const second = (f.store as any).retryFeedback(id, recovery.id, () => undefined, state.classroom_version);
  const rejected = assert.rejects(second, /正在生成/);
  try {await started; assert.equal(f.requests(), 3); await rejected;}
  finally {release(); await first;}
  assert.equal(f.assessments.size, 1);
}));

test("retry reuses an already saved assessment instead of posting a second grade", async () => fixture(async f => {
  const id = await submit(f); const state = await f.store.state(id); const recovery = (state as any).feedback_recovery;
  assert.equal(f.assessments.size, 1); assert.equal(f.assessmentPosts(), 1);
  await (f.store as any).retryFeedback(id, recovery.id, () => undefined, state.classroom_version);
  assert.equal(f.assessments.size, 1); assert.equal(f.assessmentPosts(), 1);
  assert.equal((await f.store.sharedClassroom()).session!.messages.filter(message => message.assessment).length, 1, "resuming a saved grade cannot duplicate its visible card");
}, false, "after-saved"));

test("a known successful Evidence result cannot be written again while regenerating feedback", async () => fixture(async f => {
  const id = await submit(f); const manager = f.manager();
  // 已落盘的成功工具回执是夹具事实；恢复工具必须尊重它，而不是重复写新Evidence。
  manager.appendMessage(fauxAssistantMessage(fauxToolCall("submit_evidence", {}, {id: "original-evidence"}), {stopReason: "toolUse"}));
  manager.appendMessage({role: "toolResult", toolCallId: "original-evidence", toolName: "submit_evidence", isError: false,
    content: [{type: "text", text: JSON.stringify({id: "saved-evidence"})}], details: {}, timestamp: Date.now()});
  const state = await f.store.state(id);
  await (f.store as any).retryFeedback(id, (state as any).feedback_recovery.id, () => undefined, state.classroom_version);
  const result = manager.getBranch().find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === "duplicate-evidence");
  assert.ok(result?.type === "message" && result.message.role === "toolResult" && result.message.isError);
  assert.match(JSON.stringify(result.message.content), /Evidence已经成功保存/);
}, false, "evidence"));

test("the explicit retry route uses the normal message stream and rejects cross-origin actions", async () => fixture(async f => {
  const id = await submit(f); const state = await f.store.state(id);
  const gateway = createGateway({store: f.store, retrieval: {scopeChanged: () => undefined} as unknown as RetrievalRuntime});
  gateway.listen(0, "127.0.0.1"); await once(gateway, "listening"); const address = gateway.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`; const url = `${base}/api/web/sessions/${id}/retry-feedback`;
  const body = JSON.stringify({recovery_id: (state as any).feedback_recovery.id, expected_version: state.classroom_version});
  try {
    const denied = await fetch(url, {method: "POST", headers: {"Content-Type": "application/json", Origin: "https://unrelated.invalid"}, body});
    assert.equal(denied.status, 403); assert.equal(f.requests(), 2);
    const response = await fetch(url, {method: "POST", headers: {"Content-Type": "application/json", Origin: base}, body});
    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.ok(events.some(event => event.type === "conversation_update")); assert.ok(events.some(event => event.type === "done"));
    assert.equal(events.findLast(event => event.type === "state").state.feedback_recovery, null); assert.equal(f.assessments.size, 1);
  } finally {gateway.closeAllConnections(); await new Promise<void>(done => gateway.close(() => done()));}
}));

test("a CHECK retry cannot declare completion from prose alone while its original grade is still missing", async () => fixture(async f => {
  const id = await submit(f); const state = await f.store.state(id); const recovery = (state as any).feedback_recovery;
  await (f.store as any).retryFeedback(id, recovery.id, () => undefined, state.classroom_version);
  const after = await f.store.state(id);
  assert.equal((after as any).feedback_recovery?.id, recovery.id);
  assert.equal((after as any).feedback_recovery?.reason, "assessment_failed");
  assert.equal(f.assessments.size, 0); assert.equal(f.store.classroom.snapshot()?.status, "interrupted");
  assert.equal((after.overview.active_task as any).id, "task");
}, false, "skip-grade"));

test("ordinary chat remains available and cannot silently retry or grade the old answer", async () => fixture(async f => {
  const id = await submit(f); const before = await f.store.state(id); const old = (before as any).feedback_recovery;
  const users = f.manager().getBranch().filter(e => e.type === "message" && e.message.role === "user").length;
  await f.store.sendMessage(id, "我想先聊聊学习节奏", () => undefined);
  assert.equal(f.manager().getBranch().filter(e => e.type === "message" && e.message.role === "user").length, users + 1);
  assert.equal(f.assessments.size, 0);
  await assert.rejects((f.store as any).retryFeedback(id, old.id, () => undefined, (await f.store.state(id)).classroom_version), /失效/);
}));

test("a failed recovery-clear write keeps the ticket in memory and after restart without announcing completion", async () => fixture(async f => {
  const id = await submit(f); const state = await f.store.state(id); const recovery = (state as any).feedback_recovery;
  const manager = f.manager() as any; const persist = manager._persist.bind(manager);
  manager._persist = (entry: any) => {
    if (entry.type === "custom" && entry.customType === "lawa.feedback-recovery" && entry.data === null) throw new Error("fixture custom clear write failed");
    return persist(entry);
  };
  const events: Array<{type: string; state?: any}> = [];
  try {
    await assert.rejects((f.store as any).retryFeedback(id, recovery.id, (event: any) => events.push(event), state.classroom_version), /恢复状态未能保存/);
    assert.equal((await f.store.state(id) as any).feedback_recovery?.id, recovery.id, "unpersisted null cannot hide the still-recoverable ticket");
    assert.equal(f.store.classroom.snapshot()?.status, "interrupted");
    assert.equal(events.some(event => event.type === "done"), false);
    assert.equal(events.findLast(event => event.type === "state")?.state.feedback_recovery?.id, recovery.id);
    assert.equal(f.assessments.size, 1, "the successfully saved real grade survives a later metadata failure");
  } finally {manager._persist = persist;}
  f.restart(); const restored = await f.store.create("resume-recent");
  assert.equal((restored.state as any).feedback_recovery?.id, recovery.id);
  assert.equal(f.assessmentPosts(), 1);
}));
