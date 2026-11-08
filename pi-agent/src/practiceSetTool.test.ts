import assert from "node:assert/strict";
import test from "node:test";

import { createPracticeSetTool } from "./practiceSetTool.js";
import { TeachingSessionContext } from "./teachingSession.js";
import { GoalOnboardingContext } from "./planning/goalOnboarding.js";

const overview = () => ({
  current_goal: "学习新版细则",
  goal_profile: { id: "goal-a" },
  current_frontier: null,
  current_focus: null,
  curriculum_spine: [],
  skills: [{ id: "skill-a" }],
  recent_evidence: [],
  active_task: { id: "task-a", status: "ACTIVE", related_skill_ids: ["skill-a"], activity_revision: 1, teaching_activity: { method: "RECALL", purpose: "巩固细则", learner_action: "回答细则问题", observable_output: "逐题回答", evaluation_focus: ["规则准确性"], observation_limits: "选择题不能证明独立迁移" } },
  current_goal_skill_ids: ["skill-a"],
  learning_history: [],
});

test("practice set presents a complete multi-question component without Kernel writes", async () => {
  const context = new TeachingSessionContext();
  context.bindSession("session-a");
  const planning = new GoalOnboardingContext();
  const tool = createPracticeSetTool(context, planning, {
    fetchImpl: async () => Response.json(overview()),
    log: () => undefined,
  });
  const questions = Array.from({ length: 9 }, (_, index) => ({
    id: `q-${index + 1}`,
    prompt: `第 ${index + 1} 题`,
    selection: "single" as const,
    options: [
      { id: "a", label: "选项 A" },
      { id: "b", label: "选项 B" },
    ],
  }));

  await tool.execute(
    "practice-set",
    {
      active_skill_id: "skill-a",
      active_task_id: "task-a",
      title: "第二章练习",
      questions,
    },
    new AbortController().signal,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  );

  const pending = context.learnerQuestions.snapshot().pending!;
  assert.equal(pending.purpose, "PRACTICE_SET");
  assert.equal(pending.questions.length, 9);
  assert.equal(pending.task_id, "task-a");
  assert.equal(pending.questions[8]?.id, "q-9");
});

test("practice set refuses cross-task scope and fewer than two questions", async () => {
  const tool = createPracticeSetTool(new TeachingSessionContext(), new GoalOnboardingContext(), {
    fetchImpl: async () => Response.json(overview()),
    log: () => undefined,
  });
  const question = {
    id: "q",
    prompt: "一题",
    selection: "single" as const,
    options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
  };
  await assert.rejects(
    tool.execute(
      "practice-set",
      { active_skill_id: "skill-a", active_task_id: "task-a", questions: [question] },
      new AbortController().signal,
      undefined,
      {} as Parameters<typeof tool.execute>[4],
    ),
    /2～10/,
  );
  await assert.rejects(
    tool.execute(
      "practice-set",
      {
        active_skill_id: "skill-a",
        active_task_id: "foreign-task",
        questions: [question, { ...question, id: "q-2" }],
      },
      new AbortController().signal,
      undefined,
      {} as Parameters<typeof tool.execute>[4],
    ),
    /ACTIVE Task/,
  );
});
