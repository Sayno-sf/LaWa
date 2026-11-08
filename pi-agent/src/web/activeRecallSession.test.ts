import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";

import type { SessionManager } from "@earendil-works/pi-coding-agent";

import type { LearningAgentSession } from "../agentSession.js";
import type { LearningOverview } from "../learningOverviewTool.js";
import type { TeachingSessionContext } from "../teachingSession.js";
import { WebSessionStore } from "./sessionStore.js";

function overview(goalId = "goal-a"): LearningOverview {
  return {
    current_goal: "学习架构", goal_profile: { id: goalId }, curriculum_spine: [], current_frontier: null,
    current_focus: null, skills: [{ id: "skill-a", status: "LEARNING" }], recent_evidence: [],
    active_task: { id: "task-a", related_skill_ids: ["skill-a"], status: "ACTIVE" },
    learning_history: [], current_goal_skill_ids: ["skill-a"],
  };
}

test("browser checkpoint is scoped to its conversation, can be skipped, and disappears on Goal change", async () => {
  let goalId = "goal-a";
  let captured: TeachingSessionContext | undefined;
  const store = new WebSessionStore({
    fetchOverview: async () => overview(goalId),
    createAgent: async (context): Promise<LearningAgentSession> => {
      captured = context;
      return { prompt: async () => {
        context.activeRecall.start({ goal_id: goalId, session_id: context.getSessionId(), skill_id: "skill-a", task_id: "task-a", primary_questions: ["一？", "二？", "三？"] });
      }, abort: async () => undefined, dispose: () => undefined };
    },
  });
  try {
    const first = await store.create();
    await store.sendMessage(first.sessionId, "开始检查", () => undefined);
    assert.equal((await store.state(first.sessionId)).teaching.active_recall?.current_question, "一？");
    const skipped = await store.skipActiveRecall(first.sessionId);
    assert.equal(skipped.teaching.active_recall, null);
    captured!.activeRecall.start({ goal_id: "goal-a", session_id: first.sessionId, skill_id: "skill-a", task_id: "task-a", primary_questions: ["一？", "二？", "三？"] });
    goalId = "goal-b";
    assert.equal((await store.state(first.sessionId)).teaching.active_recall, null);
    captured!.setCheckpointCandidates({ goal_id: "goal-a", session_id: first.sessionId, skill_id: "skill-a", task_id: "task-a" }, [
      { evidence_type: "EXPLAIN", description: "旧目标能力", supporting_interaction_summary: "旧目标回答", assistance_level: "INDEPENDENT" },
    ]);
    assert.equal((await store.state(first.sessionId)).teaching.candidate_evidence, null);
    const second = await store.create("new");
    assert.notEqual(second.sessionId, first.sessionId);
    assert.equal(second.state.teaching.active_recall, null);
  } finally { store.dispose(); }
});

test("Stop Generation rolls back the question index and no Evidence appears", async () => {
  let releaseAnswer: (() => void) | undefined;
  let answerStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { answerStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseAnswer = resolve; });
  const store = new WebSessionStore({
    fetchOverview: async () => overview(),
    createAgent: async (context): Promise<LearningAgentSession> => ({
      prompt: async (text) => {
        if (text === "start") context.activeRecall.start({ goal_id: "goal-a", session_id: context.getSessionId(), skill_id: "skill-a", task_id: "task-a", primary_questions: ["一？", "二？", "三？"] });
        else {
          context.activeRecall.answer({ goal_id: "goal-a", session_id: context.getSessionId(), skill_id: "skill-a", task_id: "task-a", outcome: "CORRECT", observation: "用户解释了", next: "PRIMARY" });
          answerStarted?.();
          await blocked;
        }
      },
      abort: async () => { releaseAnswer?.(); },
      dispose: () => undefined,
    }),
  });
  try {
    const session = await store.create();
    await store.sendMessage(session.sessionId, "start", () => undefined);
    const pending = store.sendMessage(session.sessionId, "我的回答", () => undefined);
    await started;
    await store.stop(session.sessionId);
    await pending;
    const state = await store.state(session.sessionId);
    assert.equal(state.teaching.active_recall?.current_question, "一？");
    assert.equal(state.teaching.active_recall?.observations.length, 0);
    assert.deepEqual(state.overview.recent_evidence, []);
  } finally { store.dispose(); }
});

test("Gateway restart restores Pi conversation but not unfinished checkpoint or phantom Evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-recall-restart-"));
  const options = {
    conversationDir: directory,
    fetchOverview: async () => overview(),
    createAgent: async (context: TeachingSessionContext, _planning: unknown, _emit: unknown, manager: SessionManager): Promise<LearningAgentSession> => ({
      prompt: async (text) => {
        manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
        context.activeRecall.start({ goal_id: "goal-a", session_id: context.getSessionId(), skill_id: "skill-a", task_id: "task-a", primary_questions: ["一？", "二？", "三？"] });
      },
      abort: async () => undefined,
      dispose: () => undefined,
    }),
  };
  try {
    const firstStore = new WebSessionStore(options);
    const first = await firstStore.create("new");
    await firstStore.sendMessage(first.sessionId, "开始检查", () => undefined);
    assert.equal((await firstStore.state(first.sessionId)).teaching.active_recall?.current_question, "一？");
    firstStore.dispose();
    const restarted = new WebSessionStore(options);
    try {
      const resumed = await restarted.create("resume-recent");
      assert.equal(resumed.sessionId, first.sessionId);
      assert.equal(resumed.messages[0]?.content, "开始检查");
      assert.equal(resumed.state.teaching.active_recall, null);
      assert.equal(resumed.state.teaching.candidate_evidence, null);
      assert.deepEqual(resumed.state.overview.recent_evidence, []);
    } finally { restarted.dispose(); }
  } finally {
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
    rmSync(directory, { recursive: true, force: true });
  }
});
