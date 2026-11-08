import assert from "node:assert/strict";
import test from "node:test";

import {
  createProposePlanRevisionTool,
  decideLearningPlanRevision,
} from "./planningTools.js";

const profile = {
  id: "goal-plan",
  goal_description: "学习新版",
  background_summary: "考试准备",
  desired_outcome: "只学新版",
  learning_preferences: [],
  time_constraint: "",
  prior_knowledge_claims: [],
};

const revisionResponse = {
  id: "plan-revision-test",
  goal_id: "goal-plan",
  base_revision: 0,
  revision: 1,
  base_signature: "a".repeat(64),
  goal_profile: {...profile, created_at: "2026-10-20T00:00:00Z"},
  curriculum_spine: Array.from({length: 5}, (_, index) => ({
    id: `stage-${index + 1}`,
    name: `阶段${index + 1}`,
    description: `新版阶段${index + 1}`,
    target_depth: "PRACTICAL" as const,
  })),
  added_skills: [],
  updated_skills: [],
  remove_skill_ids: ["old"],
  frontier: {
    focus_skill_id: "new",
    supporting_skill_ids: [],
    reason: "使用新版",
    target_depth: "PRACTICAL" as const,
    suggested_learning_mode: "EXPLAIN" as const,
    next_action: "讲新版",
  },
  summary: "更新学习目标理解；调整当前 Frontier",
  reason: "考试只考新版",
  status: "PENDING" as const,
  feedback: "",
  decision_request_id: "",
  created_at: "2026-10-20T00:00:00Z",
  decided_at: null,
};

test("proposal tool persists a pending complete plan and never applies it", async () => {
  let url = "";
  let body: Record<string, unknown> = {};
  const tool = createProposePlanRevisionTool({
    baseUrl: "http://learning.test",
    log: () => undefined,
    fetchImpl: async (request, init) => {
      url = String(request);
      body = JSON.parse(String(init?.body));
      return Response.json({...revisionResponse, id: body.id}, {status: 201});
    },
  });
  await tool.execute(
    "tool-call-plan",
    {
      goal_profile: profile,
      curriculum_spine: revisionResponse.curriculum_spine,
      added_skills: [],
      updated_skills: [],
      remove_skill_ids: ["old"],
      frontier: revisionResponse.frontier,
      reason: revisionResponse.reason,
    },
    new AbortController().signal,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  );
  assert.equal(url, "http://learning.test/api/learning/plan-revisions");
  assert.match(String(body.id), /^plan-revision-/);
  assert.equal(body.reason, "考试只考新版");
});

test("decision transport sends only the real submitted plan revision decision", async () => {
  let body: Record<string, unknown> = {};
  const result = await decideLearningPlanRevision(
    "plan-revision-test",
    {action: "CONFIRM", feedback: "", request_id: "learner-request"},
    {
      baseUrl: "http://learning.test",
      log: () => undefined,
      fetchImpl: async (_request, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({...revisionResponse, status: "CONFIRMED"});
      },
    },
  );
  assert.deepEqual(body, {action: "CONFIRM", feedback: "", request_id: "learner-request"});
  assert.equal(result.status, "CONFIRMED");
});
