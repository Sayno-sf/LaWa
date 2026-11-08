import assert from "node:assert/strict";
import test from "node:test";

import { TeachingSessionContext } from "./teachingSession.js";
import { createRecordTeachingTurnTool } from "./teachingTool.js";

function overview(
  activeTask: { id: string; related_skill_ids: string[] } | null,
): Response {
  return Response.json({
    current_goal: "掌握 CNN",
    goal_profile: null,
    curriculum_spine: [],
    current_frontier: null,
    current_focus: activeTask,
    active_task: activeTask,
    skills: [],
    recent_evidence: [],
    learning_history: [],
    current_goal_skill_ids: [],
  });
}

test("record_teaching_turn returns factual context without prescribing the response", async () => {
  const context = new TeachingSessionContext();
  context.beginUserTurn("开始学习");
  const tool = createRecordTeachingTurnTool(context, {
    baseUrl: "http://learning.test",
    fetchImpl: async () =>
      overview({ id: "task-cnn", related_skill_ids: ["cnn"] }),
    log: () => undefined,
  });
  await tool.execute(
    "start",
    {
      active_skill_id: "cnn",
      active_task_id: "task-cnn",
      teaching_mode: "QUIZ",
      outcome: "START",
      current_question: "为什么卷积保留空间结构？",
    },
    new AbortController().signal,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  );

  context.beginUserTurn("因为像素很多");
  const result = await tool.execute(
    "attempt",
    {
      active_skill_id: "cnn",
      active_task_id: "task-cnn",
      teaching_mode: "QUIZ",
      outcome: "PARTIAL",
      current_question: "为什么卷积保留空间结构？",
      key_gap: "局部连接",
      hint_level: 2,
    },
    new AbortController().signal,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  );

  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  const payload = JSON.parse(text) as Record<string, unknown>;
  assert.equal(result.details.hintLevel, 2);
  assert.equal("response_directive" in payload, false);
  assert.equal(payload.candidate_persistence_status, "NOT_PERSISTED");
});

test("record_teaching_turn treats review as descriptive context", async () => {
  const context = new TeachingSessionContext();
  context.beginUserTurn("请系统复习，一次给我一组题");
  const tool = createRecordTeachingTurnTool(context, {
    baseUrl: "http://learning.test",
    fetchImpl: async () =>
      overview({ id: "task-cnn", related_skill_ids: ["cnn"] }),
    log: () => undefined,
  });

  const result = await tool.execute(
    "knowledge-block",
    {
      active_skill_id: "cnn",
      active_task_id: "task-cnn",
      teaching_mode: "EXPLAIN",
      teaching_flow: "REVIEW",
      review_reason: "USER_REQUEST",
      outcome: "START",
      current_question: "CNN 基础知识检查",
      check_scope: ["局部连接", "参数共享", "输出 shape"],
      check_questions: [
        "局部连接为什么适合图像？",
        "参数共享怎样减少参数量？",
        "输出 shape 怎样计算？",
      ],
    },
    new AbortController().signal,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  );

  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.doesNotMatch(text, /系统总结|3～5 道|一次性回答/);
  assert.match(text, /"teaching_flow":"REVIEW"/);
});

test("record_teaching_turn rejects teaching when the Kernel has no ACTIVE task", async () => {
  const context = new TeachingSessionContext();
  const tool = createRecordTeachingTurnTool(context, {
    baseUrl: "http://learning.test",
    fetchImpl: async () => overview(null),
    log: () => undefined,
  });

  await assert.rejects(
    () =>
      tool.execute(
        "start-without-task",
        {
          active_skill_id: "cnn",
          active_task_id: "invented-task",
          teaching_mode: "EXPLAIN",
          outcome: "START",
          current_question: "为什么卷积保留空间结构？",
        },
        new AbortController().signal,
        undefined,
        {} as Parameters<typeof tool.execute>[4],
      ),
    /ACTIVE LearningTask/,
  );
  assert.equal(context.snapshot().active_task_id, null);
});

test("record_teaching_turn rejects a task id that is not the authoritative ACTIVE task", async () => {
  const context = new TeachingSessionContext();
  const tool = createRecordTeachingTurnTool(context, {
    baseUrl: "http://learning.test",
    fetchImpl: async () =>
      overview({ id: "task-real", related_skill_ids: ["cnn"] }),
    log: () => undefined,
  });

  await assert.rejects(
    () =>
      tool.execute(
        "wrong-task",
        {
          active_skill_id: "cnn",
          active_task_id: "task-invented",
          teaching_mode: "QUIZ",
          outcome: "START",
          current_question: "输出 shape 是什么？",
        },
        new AbortController().signal,
        undefined,
        {} as Parameters<typeof tool.execute>[4],
      ),
    /does not match.*ACTIVE LearningTask/,
  );
});

test("record_teaching_turn rejects a skill outside the ACTIVE task", async () => {
  const context = new TeachingSessionContext();
  const tool = createRecordTeachingTurnTool(context, {
    baseUrl: "http://learning.test",
    fetchImpl: async () =>
      overview({ id: "task-pytorch", related_skill_ids: ["pytorch"] }),
    log: () => undefined,
  });

  await assert.rejects(
    () =>
      tool.execute(
        "unrelated-skill",
        {
          active_skill_id: "cnn",
          active_task_id: "task-pytorch",
          teaching_mode: "EXPLAIN",
          outcome: "START",
          current_question: "为什么卷积保留空间结构？",
        },
        new AbortController().signal,
        undefined,
        {} as Parameters<typeof tool.execute>[4],
      ),
    /not related to.*ACTIVE LearningTask/,
  );
});
