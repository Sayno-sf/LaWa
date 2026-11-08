import assert from "node:assert/strict";
import test from "node:test";
import {createServer} from "node:http";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import {fauxAssistantMessage} from "@earendil-works/pi-ai";
import {WebSessionStore} from "./sessionStore.js";
import {createLearnerQuestionTool} from "../learnerQuestionTool.js";
import type {LearningOverview} from "../learningOverviewTool.js";

test("a goal confirmed and initialized in the same real user turn always has a start card", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-planning-start-"));
  const profile = {id: "fractions", goal_description: "理解分数", background_summary: "初学者", desired_outcome: "比较分数大小",
    learning_preferences: [], time_constraint: "", prior_knowledge_claims: []};
  const current: LearningOverview = {current_goal: "", goal_profile: null, active_task: null, current_frontier: null,
    current_focus: null, current_goal_skill_ids: [], skills: [], curriculum_spine: [], recent_evidence: [], learning_history: []};
  let writes = 0;
  const api = createServer((request, response) => {
    if (request.method !== "GET") writes++;
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(current));
  });
  await new Promise<void>(done => api.listen(0, "127.0.0.1", done));
  const address = api.address(); assert.ok(address && typeof address !== "string");
  const apiBaseUrl = `http://127.0.0.1:${address.port}`;
  const store = new WebSessionStore({apiBaseUrl, conversationDir: join(directory, "sessions"), conversationCwd: directory,
    fetchOverview: async () => structuredClone(current), fetchLibrary: async () => ({projects: []}), log: () => undefined,
    createAgent: async (context, planning, _emit, manager) => ({
      prompt: async text => {
        manager.appendMessage({role: "user", content: text, timestamp: Date.now()});
        if (text === "我想学习分数") {
          planning.record({outcome: "READY_FOR_CONFIRMATION", profile});
          const tool = createLearnerQuestionTool(context, planning, {baseUrl: apiBaseUrl, log: () => undefined});
          await tool.execute("confirm", {purpose: "CONFIRM_GOAL"}, new AbortController().signal, undefined, {} as any);
          manager.appendMessage(fauxAssistantMessage("请确认目标。"));
        } else {
          assert.equal(text, "确认");
          planning.record({outcome: "CONFIRMED"});
          // 模拟initialize_learning_goal已成功落盘；运行时补按钮不依赖模型再调用一次工具。
          current.current_goal = profile.goal_description; current.goal_profile = profile;
          current.skills = [{id: "fractions-intro", name: "认识分数", status: "NOT_STARTED"}];
          current.current_goal_skill_ids = ["fractions-intro"];
          current.current_frontier = {focus_skill_id: "fractions-intro", supporting_skill_ids: []};
          planning.markInitialized();
          manager.appendMessage(fauxAssistantMessage("路线已保存，点下面的「开始学习」。"));
        }
        return {status: "completed" as const};
      }, abort: async () => undefined, dispose: () => undefined,
    }),
  });
  try {
    const session = await store.create("new-goal");
    await store.sendMessage(session.sessionId, "我想学习分数", () => undefined);
    const confirmation = (await store.state(session.sessionId)).teaching.learner_questions!.pending!;
    assert.equal(confirmation.purpose, "CONFIRM_GOAL");
    await store.sendMessage(session.sessionId, "", () => undefined, {request_id: confirmation.id,
      answers: [{question_id: confirmation.questions[0]!.id, selected_option_ids: ["proceed"], other_text: ""}]});
    const state = await store.state(session.sessionId);
    const start = state.teaching.learner_questions?.pending;
    assert.equal(state.onboarding.status, "INITIALIZED");
    assert.equal(start?.purpose, "START_LEARNING", "老师完成路线后，真实开始卡片必须与正文同步交付");
    assert.ok(start);
    assert.equal(start.questions[0]!.options[0]!.label, "开始学习");
    assert.equal(start.skill_id, "fractions-intro");
    assert.equal(writes, 0, "补齐开始询问不能自动激活Task或代替用户同意");
    assert.equal(current.active_task, null);
    assert.equal((current.skills[0] as {status: string}).status, "NOT_STARTED");
  } finally {
    store.dispose(); api.closeAllConnections(); await new Promise<void>(done => api.close(() => done()));
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith("lawa-planning-start-"));
    rmSync(directory, {recursive: true, force: true});
  }
});
