import assert from "node:assert/strict";
import test from "node:test";
import {TeachingSessionContext} from "../teachingSession.js";
import {GoalOnboardingContext} from "./goalOnboarding.js";
import {planningHash, type PlanningReadingReference} from "./planningReading.js";
import {
  createReviewPlanningSourcesTool,
  PlanningSourceReviewContext,
  reviewPlanningSourcePacket,
  requiresPlanningSourceReview,
} from "./planningSourceReview.js";

const profile = {
  id: "multi-source-goal",
  goal_description: "依据两份资料制定路线",
  background_summary: "初学者",
  desired_outcome: "形成可执行路线",
  learning_preferences: [],
  time_constraint: "",
  prior_knowledge_claims: [],
};

function confirmed(materialCount: number) {
  const planning = new GoalOnboardingContext();
  const reference: PlanningReadingReference = {
    id: "a".repeat(64),
    session_id: "session-a",
    user_entry_id: "user-a",
    profile_hash: planningHash(profile),
    materials: Array.from({length: materialCount}, (_, index) => ({
      id: "mat-" + String(index + 1).padStart(32, "0"),
      name: `资料${index + 1}.md`,
    })),
  };
  planning.start();
  planning.beginUserTurn("按上传资料学习");
  planning.record({outcome: "READY_FOR_CONFIRMATION", profile}, reference);
  planning.beginUserTurn("确认");
  planning.record({outcome: "CONFIRMED"});
  return {planning, reference};
}

test("multi-source review is required and a conflict ticket cannot initialize a route", async () => {
  const {planning, reference} = confirmed(2);
  assert.equal(requiresPlanningSourceReview(reference), true);
  assert.equal(requiresPlanningSourceReview({...reference, materials: reference.materials.slice(0, 1)}), false);
  const review = new PlanningSourceReviewContext();
  const teaching = new TeachingSessionContext(); teaching.bindSession("session-a");
  const tool = createReviewPlanningSourcesTool(teaching, planning, review);
  await review.prepare(reference, async () => ({
    status: "NEEDS_CLARIFICATION",
    summary: "旧资料与新资料的适用范围不同",
    conflicts: ["旧资料写7天、ALPHA；新资料写12天、BETA并声明替代关系。"],
    question: {prompt: "请求应按哪个日期范围适用政策？", options: [
      {id: "old-scope", label: "2026-10-01 之前"},
      {id: "new-scope", label: "2026-10-01 及之后"},
    ]},
  }));
  await tool.execute("review-conflict", {}, new AbortController().signal, undefined, {} as Parameters<typeof tool.execute>[4]);
  assert.equal(review.compatible(reference), false);
  assert.equal(review.snapshot()?.decision.status, "NEEDS_CLARIFICATION");
  assert.equal(teaching.learnerQuestions.snapshot().pending?.purpose, "BACKGROUND");
  review.beginTurn();
  assert.equal(review.snapshot(), undefined);
});

test("compatible multi-source review issues a turn-local initialize ticket", async () => {
  const {planning, reference} = confirmed(2);
  const review = new PlanningSourceReviewContext();
  const teaching = new TeachingSessionContext(); teaching.bindSession("session-a");
  const tool = createReviewPlanningSourcesTool(teaching, planning, review);
  await review.prepare(reference, async () => ({
    status: "COMPATIBLE",
    summary: "两份资料分别说明原则和操作顺序，依赖一致。",
    conflicts: [],
  }));
  await tool.execute("review-compatible", {}, new AbortController().signal, undefined, {} as Parameters<typeof tool.execute>[4]);
  assert.equal(review.compatible(reference), true);
  assert.equal(review.snapshot()?.requirementId, reference.id);
});

test("independent source reviewer returns a structured clarification without making a route", async () => {
  const runtime = {
    completeSimple: async () => ({
      stopReason: "toolUse",
      content: [{
        type: "toolCall",
        name: "submit_planning_source_review",
        arguments: {
          status: "NEEDS_CLARIFICATION",
          summary: "两份政策按创建日期分流。",
          conflicts: ["旧政策为7天/ALPHA；新政策为12天/BETA并声明替代关系。"],
          question: {
            prompt: "目标请求按哪个创建日期范围处理？",
            options: [
              {id: "before_2026_10_01", label: "2026-10-01 之前"},
              {id: "on_or_after_2026_10_01", label: "2026-10-01 及之后"},
            ],
          },
        },
      }],
    }),
  } as any;
  const decision = await reviewPlanningSourcePacket(runtime, {} as any, {sources: []}, "未提供日期");
  assert.equal(decision.status, "NEEDS_CLARIFICATION");
  assert.equal(decision.conflicts.length, 1);
  assert.equal(decision.question?.options.length, 2);
  assert.deepEqual(decision.question?.options.map(option => option.id),
    ["before_2026_10_01", "on_or_after_2026_10_01"]);
});
