import {createTeachingFaux as createFauxCore} from "./testing/teachingFaux.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { createLearningAgentSession } from "./agentSession.js";
import { TeachingSessionContext } from "./teachingSession.js";
import { GoalOnboardingContext } from "./planning/goalOnboarding.js";
import type { LearningOverview } from "./learningOverviewTool.js";

test("real shared Agent hook compacts old input, refreshes after writes and preserves stored history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-context-runtime-"));
  const state: LearningOverview = {
    current_goal: "当前课程", goal_profile: { id: "goal", learning_preferences: ["CURRENT_PREFERENCE"] },
    current_focus: null, current_frontier: { focus_skill_id: "one", supporting_skill_ids: [] },
    active_task: { id: "task-one", related_skill_ids: ["one"], status: "ACTIVE" },
    // 本夹具测试已获用户掌握确认后的Task收尾/状态刷新；未确认时的收尾等待由masteryReview回归覆盖。
    skills: [{ id: "one", status: "MASTERED_BY_USER", evidence_ids: ["e-1"] }, { id: "two", status: "NOT_STARTED" }],
    current_goal_skill_ids: ["one", "two"], curriculum_spine: [], recent_evidence: [], knowledge_cards: [],
    learning_history: [{ description: "ARCHIVED_SECRET".repeat(1000) }],
  };
  let reads = 0; let writes = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/api/learning/overview") {
      reads++; response.end(JSON.stringify(state));
    } else if (request.method === "POST" && request.url === "/api/learning/tasks/task-one/complete") {
      writes++; state.active_task = null; state.current_frontier = { focus_skill_id: "two", supporting_skill_ids: [] };
      response.end(JSON.stringify({ id: "task-one", status: "DONE" }));
    } else { response.statusCode = 404; response.end("{}"); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const manager = SessionManager.inMemory();
  manager.appendMessage(fauxAssistantMessage(fauxToolCall("get_learning_overview", {}, { id: "old-call" }), { stopReason: "toolUse" }));
  const old: ToolResultMessage = { role: "toolResult", toolCallId: "old-call", toolName: "get_learning_overview",
    content: [{ type: "text", text: JSON.stringify(state) }], isError: false, timestamp: Date.now() };
  manager.appendMessage(old);
  const faux = createFauxCore({ tokensPerSecond: 0 });
  faux.setResponses([
    context => {
      assert.ok(context.systemPrompt);
      assert.match(context.systemPrompt, /task-one/);
      assert.doesNotMatch(context.systemPrompt, /CURRENT_PREFERENCE/, "旧Goal自由文本偏好不能覆盖当前快照");
      assert.match(context.systemPrompt, /TASK_TIME_current-task/);
      assert.doesNotMatch(JSON.stringify(context), /ARCHIVED_SECRET/);
      return fauxAssistantMessage(fauxToolCall("complete_learning_task", { task_id: "task-one" }, { id: "complete" }), { stopReason: "toolUse" });
    },
    context => {
      assert.ok(context.systemPrompt);
      assert.match(context.systemPrompt, /"focus_skill_id":"two"/);
      assert.match(context.systemPrompt, /"active_task":null/);
      assert.match(context.systemPrompt, /TASK_TIME_no-task/);
      assert.doesNotMatch(context.systemPrompt, /task-one/);
      assert.doesNotMatch(JSON.stringify(context), /ARCHIVED_SECRET/);
      return fauxAssistantMessage("可以继续下一项练习。");
    },
  ]);
  // 真正的 Pi Session 与实际 stream 入口；仅模型流和 HTTP Kernel 使用隔离 Adapter，不接触实际凭据或账本。
  const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null,
    modelsStorePath: join(directory, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
  runtime.streamSimple = faux.streamSimple;
  runtime.hasConfiguredAuth = provider => provider === faux.getModel().provider;
  runtime.getAuth = async () => ({ auth: { apiKey: "isolated-faux-key" }, env: {} } as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  let session: Awaited<ReturnType<typeof createLearningAgentSession>> | undefined;
  const errors: string[] = [];
  try {
    session = await createLearningAgentSession(new TeachingSessionContext(), new GoalOnboardingContext(), {
      apiBaseUrl: `http://127.0.0.1:${address.port}`, model: faux.getModel(), modelRuntime: runtime, sessionManager: manager,
      surface: "WEB", log: () => undefined,
      studyTiming: overview => overview.active_task ? "TASK_TIME_current-task" : "TASK_TIME_no-task",
      onEvent: event => { if (event.type === "model_error") errors.push(event.message.slice(0, 1600)); },
    });
    await session.prompt("继续学习");
    assert.deepEqual(errors, []);
    assert.equal(faux.state.callCount, 3);
    assert.equal(reads, 4); assert.equal(writes, 1); // 实际请求两次刷新，收尾前另核对一次真实任务现场。
    const stored = manager.getBranch().find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "old-call");
    assert.ok(stored?.type === "message");
    assert.deepEqual(stored.message, old);
  } finally {
    session?.dispose();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("lawa-context-runtime-"));
    rmSync(directory, { recursive: true, force: true });
  }
});
