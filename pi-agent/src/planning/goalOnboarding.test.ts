import assert from "node:assert/strict";
import test from "node:test";

import { GoalOnboardingContext } from "./goalOnboarding.js";

const profile = {
  id: "goal-yolo",
  goal_description: "理解并独立实现 YOLO",
  background_summary: "做过 AI 辅助的 YOLO 项目",
  desired_outcome: "独立完成目标检测项目",
  learning_preferences: ["实践为主", "核心原理深入"],
  time_constraint: "每天两小时",
  prior_knowledge_claims: ["学过 CNN"],
};

test("complete natural-language understanding can go directly to one confirmation", () => {
  const context = new GoalOnboardingContext();
  context.start();
  const state = context.record({ outcome: "READY_FOR_CONFIRMATION", profile });
  assert.equal(state.status, "READY_FOR_CONFIRMATION");
  assert.deepEqual(state.missing_information, []);
  assert.deepEqual(state.pending_profile?.prior_knowledge_claims, ["学过 CNN"]);
});

test("missing route inputs are combined into one clarification", () => {
  const context = new GoalOnboardingContext();
  context.start();
  const state = context.record({
    outcome: "NEEDS_CLARIFICATION",
    profile: { ...profile, background_summary: "", time_constraint: "" },
    missing_information: ["relevant background", "available time"],
  });
  assert.deepEqual(state.missing_information, ["relevant background", "available time"]);
});

test("initialization requires a separate explicit confirmation turn", () => {
  const context = new GoalOnboardingContext();
  context.start();
  context.record({ outcome: "READY_FOR_CONFIRMATION", profile });
  assert.throws(
    () => context.record({ outcome: "CONFIRMED" }),
    /latest user message/,
  );
  context.beginUserTurn("对");
  context.record({ outcome: "CONFIRMED" });
  assert.doesNotThrow(() =>
    context.validateInitialization({
      goal_profile: profile,
      curriculum_spine: [],
      frontier_skills: [],
      frontier: {
        focus_skill_id: "cnn",
        supporting_skill_ids: [],
        reason: "start",
        target_depth: "PRACTICAL",
        suggested_learning_mode: "EXPLAIN",
        next_action: "diagnostic",
      },
      replace_existing: false,
    }),
  );
});

test("major goal replacement requires explicit replacement onboarding", () => {
  const context = new GoalOnboardingContext();
  context.start({ replaceExisting: true });
  context.record({ outcome: "READY_FOR_CONFIRMATION", profile });
  context.beginUserTurn("确认");
  context.record({ outcome: "CONFIRMED" });
  assert.throws(
    () =>
      context.validateInitialization({
        goal_profile: profile,
        curriculum_spine: [],
        frontier_skills: [],
        frontier: {
          focus_skill_id: "cnn",
          supporting_skill_ids: [],
          reason: "start",
          target_depth: "PRACTICAL",
          suggested_learning_mode: "EXPLAIN",
          next_action: "diagnostic",
        },
        replace_existing: false,
      }),
    /replacement requires/,
  );
});

test("idle teaching conversation cannot silently stage a new goal", () => {
  const context = new GoalOnboardingContext();
  context.beginUserTurn("继续解释一下刚才的内容");
  assert.throws(
    () => context.record({ outcome: "READY_FOR_CONFIRMATION", profile }),
    /新目标/,
  );
});

test("natural-language major direction change enters replacement confirmation", () => {
  const context = new GoalOnboardingContext();
  context.beginUserTurn("我不想学 YOLO 了，想转向图像分割");
  const ready = context.record({ outcome: "READY_FOR_CONFIRMATION", profile });
  assert.equal(ready.replace_existing, true);
  context.beginUserTurn("对，就是这样。");
  assert.equal(context.record({ outcome: "CONFIRMED" }).status, "CONFIRMED");
});

test("a new learning-route request in an existing-goal conversation keeps replacement authorization through confirmation", () => {
  const context = new GoalOnboardingContext();
  context.beginUserTurn("我想学习强化学习，根据我的基础帮我规划一条研究路线");
  const ready = context.record({ outcome: "READY_FOR_CONFIRMATION", profile });
  assert.equal(ready.replace_existing, true);
  context.beginUserTurn("确认");
  assert.equal(context.record({ outcome: "CONFIRMED" }).replace_existing, true);
  assert.doesNotThrow(() => context.validateInitialization({
    goal_profile: profile,
    curriculum_spine: [],
    frontier_skills: [],
    frontier: {
      focus_skill_id: "cnn",
      supporting_skill_ids: [],
      reason: "start",
      target_depth: "PRACTICAL",
      suggested_learning_mode: "EXPLAIN",
      next_action: "diagnostic",
    },
    replace_existing: true,
  }));
});

test("the user can authorize replacement after confirming a pending route without losing it", () => {
  const context = new GoalOnboardingContext();
  context.start();
  context.record({ outcome: "READY_FOR_CONFIRMATION", profile });
  context.beginUserTurn("确认");
  context.record({ outcome: "CONFIRMED" });
  const authorized = context.authorizeReplacement();
  assert.equal(authorized.status, "CONFIRMED");
  assert.equal(authorized.replace_existing, true);
  assert.deepEqual(authorized.pending_profile, profile);
});
