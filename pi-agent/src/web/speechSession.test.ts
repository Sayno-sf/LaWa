import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { LearningOverview } from "../learningOverviewTool.js";
import type { LearnerQuestionRequest } from "../learnerQuestionTypes.js";
import type { SpeechPresentation } from "../speechTypes.js";
import type { TeachingSessionContext } from "../teachingSession.js";
import type { GoalOnboardingContext } from "../planning/goalOnboarding.js";
import { WebSessionStore, type WebSessionEvent } from "./sessionStore.js";

function overview(): LearningOverview {
  return { current_goal: "英语表达", goal_profile: { id: "goal-en" }, curriculum_spine: [], current_frontier: null,
    current_focus: null, skills: [{ id: "skill-en", status: "LEARNING" }], recent_evidence: [],
    active_task: { id: "task-en", status: "ACTIVE", related_skill_ids: ["skill-en"] }, current_goal_skill_ids: ["skill-en"], learning_history: [] };
}
function cleanup(directory: string) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith("lawa-speech-"));
  rmSync(directory, { recursive: true, force: true });
}
function speech(manager: SessionManager, id = "speech-one", isError = false): string {
  const presentation: SpeechPresentation = { id, sourceSessionId: manager.getSessionId(), text: "Could you say that again?", language: "en", purpose: "repeat",
    goalId: "goal-en", taskId: "task-en", skillId: "skill-en" };
  return manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "present_speech", isError, timestamp: Date.now(),
    content: [{ type: "text", text: "PRESENTED" }], details: { speech: presentation } } satisfies ToolResultMessage);
}

test("successful speech is restored with real entry IDs, including a historical preview from another session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-speech-history-"));
  const managers = new Map<string, SessionManager>();
  const options = { conversationDir: directory, fetchOverview: async () => overview(), fetchLibrary: async () => ({ projects: [] }),
    createAgent: async (context: TeachingSessionContext, _planning: unknown, _emit: unknown, manager: SessionManager) => {
      managers.set(context.getSessionId(), manager);
      return { prompt: async (text: string) => { manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
        speech(manager); speech(manager, "failed-speech", true); manager.appendMessage(fauxAssistantMessage("听示范后，可以写下你的表达。")); },
        abort: async () => undefined, dispose: () => undefined };
    } };
  let store = new WebSessionStore(options);
  try {
    const first = await store.create("new"); const events: WebSessionEvent[] = [];
    await store.sendMessage(first.sessionId, "[LAWA_MATERIAL_CONTEXT]\n请读取练习图片。\n[/LAWA_MATERIAL_CONTEXT]", event => events.push(event));
    const final = events.find(event => event.type === "conversation_update"); assert.ok(final?.type === "conversation_update");
    assert.equal(events.at(-1)?.type, "done");
    const component = final.messages.find(message => message.speech)?.speech;
    assert.ok(component); assert.equal(component.sourceSessionId, first.sessionId); assert.ok(component.entryId);
    assert.equal(final.messages.filter(message => message.speech).length, 1, "failed tool results must not become components");
    const attachmentUser = final.messages.find(message => message.role === "user");
    assert.ok(attachmentUser?.entryId); assert.equal(attachmentUser.content, "", "image-only user entries must survive saved speech projection");
    assert.deepEqual((await store.state(first.sessionId)).overview.recent_evidence, []);
    const manager = managers.get(first.sessionId)!; const originalFile = manager.getSessionFile()!;
    const before = readFileSync(originalFile);
    const second = await store.create("new");
    const preview = await store.locateSkill("goal-en", "skill-en");
    assert.equal(preview.sessionId, second.sessionId);
    assert.equal(preview.messages.find(message => message.speech)?.speech?.sourceSessionId, first.sessionId);
    const reference = { sourceSessionId: component.sourceSessionId, entryId: component.entryId, presentationId: component.id };
    assert.equal((await store.resolveSpeech(reference)).text, component.text);
    assert.deepEqual(readFileSync(originalFile), before, "historical synthesis lookup must not mutate the original session");
    await assert.rejects(() => store.resolveSpeech({ ...reference, sourceSessionId: second.sessionId }), /朗读组件/);
    await assert.rejects(() => store.resolveSpeech({ ...reference, presentationId: "another" }), /朗读组件/);
    store.dispose(); store = new WebSessionStore(options);
    const reopened = await store.activateConversation(first.sessionId);
    assert.deepEqual(reopened.messages.find(message => message.speech)?.speech, component);
  } finally { store.dispose(); cleanup(directory); }
});

test("a stopped or failed teacher round still publishes saved speech and releases the session without Evidence", async () => {
  for (const action of ["stop", "failure"] as const) {
    const directory = mkdtempSync(join(tmpdir(), "lawa-speech-interruption-"));
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    const blocked = new Promise<void>(done => { release = done; });
    const store = new WebSessionStore({ conversationDir: directory, fetchOverview: async () => overview(),
      createAgent: async (_context, _planning, _emit, manager) => ({
        prompt: async text => { manager.appendMessage({ role: "user", content: text, timestamp: Date.now() }); speech(manager);
          if (action === "failure") throw new Error("isolated teacher failure"); entered(); await blocked; },
        abort: async () => { release(); }, dispose: () => undefined,
      }) });
    try {
      const session = await store.create("new"); const events: WebSessionEvent[] = [];
      if (action === "failure") await assert.rejects(() => store.sendMessage(session.sessionId, "示范", event => events.push(event)), /teacher failure/);
      else { const running = store.sendMessage(session.sessionId, "示范", event => events.push(event)); await started; await store.stop(session.sessionId); await running; }
      const updated = events.find(event => event.type === "conversation_update"); assert.ok(updated?.type === "conversation_update");
      assert.equal(updated.messages.filter(message => message.speech).length, 1);
      const state = await store.state(session.sessionId); assert.deepEqual(state.overview.recent_evidence, []); assert.equal(state.teaching.candidate_evidence, null);
      await store.voiceScope(session.sessionId);
    } finally { store.dispose(); cleanup(directory); }
  }
});

test("voice scope detects leaf, Goal/Task/question changes and prevents late results from another conversation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-speech-scope-")); let current = overview(); let context!: TeachingSessionContext;
  let manager!: SessionManager;
  const store = new WebSessionStore({ conversationDir: directory, fetchOverview: async () => current,
    createAgent: async (ctx, _planning, _emit, session) => { context = ctx; manager = session; return {
      prompt: async text => { manager.appendMessage({ role: "user", content: text, timestamp: Date.now() }); }, abort: async () => undefined, dispose: () => undefined,
    }; } });
  try {
    const session = await store.create("new"); const initial = await store.voiceScope(session.sessionId);
    await store.assertVoiceScope(session.sessionId, initial);
    await store.sendMessage(session.sessionId, "文字", () => undefined);
    await assert.rejects(() => store.assertVoiceScope(session.sessionId, initial), /已变化/);
    const questionBefore = await store.voiceScope(session.sessionId);
    context.learnerQuestions.ask({ id: "questions", purpose: "CHECK", session_id: session.sessionId, goal_id: "goal-en", task_id: "task-en", skill_id: "skill-en",
      questions: [{ id: "one", prompt: "How would you ask?", selection: "single", options: [{ id: "a", label: "a" }, { id: "b", label: "b" }] }] });
    await assert.rejects(() => store.assertVoiceScope(session.sessionId, questionBefore), /已变化/);
    const taskBefore = await store.voiceScope(session.sessionId); current = { ...current, active_task: { id: "next-task", status: "ACTIVE", related_skill_ids: ["skill-en"] } };
    await assert.rejects(() => store.assertVoiceScope(session.sessionId, taskBefore), /已变化/);
    const beforeSwitch = await store.voiceScope(session.sessionId); await store.create("new");
    await assert.rejects(() => store.assertVoiceScope(session.sessionId, beforeSwitch));
  } finally { store.dispose(); cleanup(directory); }
});

test("voice provenance is tied to actual user messages and individual final question supplements", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-speech-provenance-")); let manager!: SessionManager; let context!: TeachingSessionContext;
  let planning!: GoalOnboardingContext;
  const store = new WebSessionStore({ conversationDir: directory, fetchOverview: async () => overview(),
    createAgent: async (ctx, goalPlanning, _emit, session) => { context = ctx; planning = goalPlanning; manager = session; return {
      prompt: async text => { manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
        context.recordTurn({ active_skill_id: "skill-en", active_task_id: "task-en", teaching_mode: "QUIZ", outcome: "CORRECT",
          candidate_evidence: { evidence_type: "EXPLAIN", description: "表达礼貌请求", supporting_interaction_summary: "实际文字" } }); },
      abort: async () => undefined, dispose: () => undefined,
    }; } });
  try {
    const session = await store.create("new");
    await store.sendMessage(session.sessionId, "Could you say that again?", () => undefined, undefined, { source: "voice", transcriptEdited: true });
    const source = manager.getEntries().find(entry => entry.type === "custom" && entry.customType === "lawa.voice-input");
    assert.ok(source?.type === "custom"); const data = source.data as { userEntryId: string; voice_input: unknown };
    assert.equal(manager.getEntry(data.userEntryId)?.type, "message"); assert.deepEqual(data.voice_input, { source: "voice", transcriptEdited: true });
    assert.match(context.snapshot().candidate_evidence?.description ?? "", /文本经用户编辑.*不证明原始发音/);
    const request: LearnerQuestionRequest = { id: "questions", purpose: "BACKGROUND", session_id: session.sessionId, goal_id: null, task_id: null, skill_id: null,
      questions: ["one", "two"].map(id => ({ id, prompt: id, selection: "single", options: [{ id: "a", label: "a" }, { id: "b", label: "b" }] })) };
    planning.start(); context.learnerQuestions.ask(request);
    await store.sendMessage(session.sessionId, "", () => undefined, { request_id: "questions", answers: [
      { question_id: "one", selected_option_ids: [], other_text: "英语交流", voice_input: { source: "voice", transcriptEdited: false } },
      { question_id: "two", selected_option_ids: [], other_text: "多练习表达" },
    ] });
    const entries = manager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "lawa.voice-input");
    assert.equal(entries.length, 2);
    const batch = entries[1]!; assert.ok(batch.type === "custom");
    assert.deepEqual((batch.data as { learner_reply: unknown }).learner_reply, { request_id: "questions", answers: [{ question_id: "one", voice_input: { source: "voice", transcriptEdited: false } }] });
    assert.deepEqual((await store.state(session.sessionId)).overview.recent_evidence, []);
    assert.doesNotMatch(readFileSync(manager.getSessionFile()!, "utf8"), /audio\/|base64|apiKey/);
  } finally { store.dispose(); cleanup(directory); }
});

test("only the immediate exact repeat uses reference assistance; later independent expression remains independent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-speech-repeat-")); let context!: TeachingSessionContext;
  const store = new WebSessionStore({ conversationDir: directory, fetchOverview: async () => overview(),
    createAgent: async (ctx, _planning, _emit, manager) => { context = ctx; return {
      prompt: async text => { manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
        if (text === "示范") { speech(manager); manager.appendMessage(fauxAssistantMessage("请跟读这个示范。")); return; }
        context.recordTurn({ active_skill_id: "skill-en", active_task_id: "task-en", teaching_mode: "QUIZ", outcome: "CORRECT",
          candidate_evidence: { evidence_type: "EXPLAIN", description: "表达礼貌请求", supporting_interaction_summary: "实际表达" } });
      }, abort: async () => undefined, dispose: () => undefined,
    }; } });
  try {
    const session = await store.create("new");
    await store.sendMessage(session.sessionId, "示范", () => undefined);
    assert.equal(context.snapshot().candidate_evidence, null);
    await store.sendMessage(session.sessionId, "Could you say that again?", () => undefined, undefined, { source: "voice", transcriptEdited: true });
    const repeated = context.snapshot().candidate_evidence!;
    assert.equal(repeated.assistance_level, "WITH_REFERENCE");
    assert.match(repeated.description, /原样复述/); assert.match(repeated.description, /不证明原始发音/);
    assert.equal(context.evidenceWriteGuard({ ...repeated, assistance_level: "INDEPENDENT" })?.block, true);
    await store.sendMessage(session.sessionId, "Would you please explain the next step?", () => undefined);
    assert.equal(context.snapshot().current_speech_reference, undefined);
    assert.equal(context.snapshot().candidate_evidence?.assistance_level, "INDEPENDENT");
    await store.sendMessage(session.sessionId, "Could you say that again?", () => undefined);
    assert.equal(context.snapshot().candidate_evidence?.assistance_level, "INDEPENDENT", "an old demonstration cannot permanently downgrade later answers");
    assert.deepEqual((await store.state(session.sessionId)).overview.recent_evidence, []);
  } finally { store.dispose(); cleanup(directory); }
});
