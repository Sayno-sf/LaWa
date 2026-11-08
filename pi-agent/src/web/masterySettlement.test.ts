import assert from "node:assert/strict";
import test from "node:test";
import {createServer} from "node:http";
import {mkdtempSync, readFileSync, readdirSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import {createFauxCore, fauxAssistantMessage, fauxToolCall} from "@earendil-works/pi-ai";
import {createLearningAgentSession} from "../agentSession.js";
import type {LearningOverview} from "../learningOverviewTool.js";
import {LEARNER_QUESTIONS_ENTRY} from "../learnerQuestions.js";
import {WebSessionStore, type WebSessionEvent, type WebSessionStoreOptions} from "./sessionStore.js";

test("a mastery offer streams its feedback before waiting and survives restart without granting mastery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-mastery-settlement-"));
  const sessions = join(directory, "sessions");
  const overview: LearningOverview = {current_goal: "读懂函数", goal_profile: {id: "goal"},
    current_frontier: {focus_skill_id: "skill", supporting_skill_ids: []}, current_focus: null,
    active_task: {id: "task", goal_id: "goal", status: "ACTIVE", related_skill_ids: ["skill"]},
    skills: [{id: "skill", name: "函数", status: "LEARNING"}], current_goal_skill_ids: ["skill"],
    curriculum_spine: [], recent_evidence: [], learning_history: []};
  const before = structuredClone(overview);
  let kernelWrites = 0, teacherRequests = 0;
  const api = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method !== "GET") {
      kernelWrites++;
      response.statusCode = 409;
      return response.end(JSON.stringify({detail: "A proposal cannot write learning state"}));
    }
    response.end(JSON.stringify(overview));
  });
  await new Promise<void>(done => api.listen(0, "127.0.0.1", done));
  const address = api.address(); assert.ok(address && typeof address === "object");
  const apiBaseUrl = `http://127.0.0.1:${address.port}`;
  const faux = createFauxCore({api: "openai-completions", provider: "aliyun-bailian",
    models: [{id: "qwen3.8-flash", contextWindow: 1_000_000, maxTokens: 32768}], tokensPerSecond: 0});
  const feedback = "你已经能区分参数和返回值。这里再串起来：参数把调用方的数据交给函数，返回值把计算结果交回调用方；打印结果不会自动成为返回值。";
  faux.setResponses([() => {
    teacherRequests++;
    return fauxAssistantMessage(fauxToolCall("ask_learner_questions", {purpose: "CONFIRM_MASTERY"}, {id: "mastery-offer"}), {stopReason: "toolUse"});
  }, () => {teacherRequests++; return fauxAssistantMessage(feedback);}]);
  const runtime = await ModelRuntime.create({authPath: join(directory, "auth.json"), modelsPath: null,
    modelsStorePath: join(directory, "models.json"), allowModelNetwork: false, refreshOnCreate: false});
  runtime.streamSimple = faux.streamSimple;
  runtime.hasConfiguredAuth = () => true;
  runtime.getAuth = async () => ({auth: {apiKey: "local-only"}, env: {}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  const options: WebSessionStoreOptions = {apiBaseUrl, conversationDir: sessions, conversationCwd: directory,
    fetchOverview: async () => structuredClone(overview), fetchLibrary: async () => ({projects: []}),
    log: () => undefined,
    skillAction: async () => {kernelWrites++; throw new Error("A teacher offer cannot invoke user mastery");},
    createAgent: (context, planning, onEvent, sessionManager) => createLearningAgentSession(context, planning, {
      apiBaseUrl, model: faux.getModel(), modelRuntime: runtime, sessionManager, surface: "WEB",
      retrieval: false, assistantSupport: false, teachingInstructions: () => "", onEvent, log: () => undefined,
    })};
  let store = new WebSessionStore(options);
  try {
    const classroom = await store.create();
    const events: WebSessionEvent[] = [];
    await store.sendMessage(classroom.sessionId, "可以进入下一节了吗？", event => events.push(event));
    const state = await store.state(classroom.sessionId);
    const pending = state.teaching.learner_questions?.pending;
    assert.ok(events.some(event => event.type === "tool_end" && event.toolName === "ask_learner_questions" && event.isError === false));
    assert.equal(pending?.purpose, "CONFIRM_MASTERY", "successfully presented card must not be rolled back at agent settlement");
    assert.ok(pending);
    assert.deepEqual(pending.questions[0]!.options.map(option => option.id), ["proceed", "revise", "skip"]);
    assert.equal(store.classroom.snapshot()?.status, "completed");
    assert.ok(!events.some(event => event.type === "model_error"));
    assert.equal(teacherRequests, 2, "the waiting card must still allow a read-only teaching reply");
    const deltas = events.flatMap(event => event.type === "assistant_delta" ? [event.delta] : []);
    assert.ok(deltas.length > 1, "feedback must remain native streaming");
    assert.equal(deltas.join(""), feedback);
    assert.equal(kernelWrites, 0);
    assert.deepEqual(overview, before);
    const entries = readdirSync(sessions).filter(name => name.endsWith(".jsonl"))
      .flatMap(name => readFileSync(join(sessions, name), "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line)));
    const saved = entries.findLast(entry => entry.type === "custom" && entry.customType === LEARNER_QUESTIONS_ENTRY);
    assert.equal(saved?.data.pending?.id, pending.id, "the real store must save the new card to Pi metadata");
    store.dispose();
    store = new WebSessionStore(options);
    const restored = await store.create("resume-recent");
    assert.equal(restored.sessionId, classroom.sessionId);
    assert.equal(restored.state.teaching.learner_questions?.pending?.id, pending.id);
    assert.equal(restored.state.teaching.learner_questions?.last_answer, null);
    assert.equal(restored.state.teaching.learner_questions?.transition_decision, undefined);
    assert.equal(teacherRequests, 2, "restoring the card cannot replay the teacher");
    assert.ok(restored.messages.some(message => message.content === feedback), "restoring the card must preserve the teaching reply");
    assert.equal(kernelWrites, 0, "restoring the card cannot apply any learner decision");
  } finally {
    store.dispose(); api.closeAllConnections();
    await new Promise<void>(done => api.close(() => done()));
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("lawa-mastery-settlement-"));
    rmSync(directory, {recursive: true, force: true});
  }
});
