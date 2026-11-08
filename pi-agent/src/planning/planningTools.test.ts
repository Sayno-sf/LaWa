import assert from "node:assert/strict";
import test from "node:test";

import { GoalOnboardingContext } from "./goalOnboarding.js";
import {
  applyCurriculumPlan,
  createInitializeLearningGoalTool,
  createRecordGoalUnderstandingTool,
  initializeLearningGoal,
} from "./planningTools.js";
import type { InitializeLearningGoalInput } from "./planningTypes.js";

function input(): InitializeLearningGoalInput {
  return {
    goal_profile: {
      id: "goal-yolo",
      goal_description: "理解 YOLO",
      background_summary: "做过 AI 辅助项目",
      desired_outcome: "独立完成检测项目",
      learning_preferences: ["实践为主"],
      time_constraint: "每天两小时",
      prior_knowledge_claims: ["学过 CNN"],
    },
    curriculum_spine: [
      "pytorch-vision",
      "cnn",
      "feature-hierarchy",
      "object-detection",
      "yolo",
    ].map((id, index) => ({
      id,
      skill_ids: index == 0 ? ["feature-map"] : [],
      name: id,
      description: id,
      target_depth: "PRACTICAL" as const,
    })),
    frontier_skills: [
      {
        id: "feature-map",
        name: "Feature Map",
        description: "spatial responses",
        prerequisites: [],
        target_depth: "PRACTICAL",
      },
    ],
    frontier: {
      focus_skill_id: "feature-map",
      supporting_skill_ids: [],
      reason: "start near current boundary",
      target_depth: "PRACTICAL",
      suggested_learning_mode: "EXPLAIN",
      next_action: "feature map diagnostic",
    },
    replace_existing: false,
  };
}

test("initialize goal posts a structured plan rather than parsing markdown", async () => {
  let body = "";
  await initializeLearningGoal(input(), {
    baseUrl: "http://learning.test",
    log: () => undefined,
    fetchImpl: async (_url, init) => {
      body = String(init?.body);
      return Response.json({ ok: true }, { status: 201 });
    },
  });
  const parsed = JSON.parse(body);
  assert.equal(parsed.curriculum_spine.length, 5);
  assert.equal(parsed.frontier_skills.length, 1);
  assert.equal(parsed.goal_profile.prior_knowledge_claims[0], "学过 CNN");
});

test("initialize tool refuses unconfirmed goal understanding", async () => {
  const tool = createInitializeLearningGoalTool(new GoalOnboardingContext(), {
    log: () => undefined,
    fetchImpl: async () => Response.json({ ok: true }, { status: 201 }),
  });
  await assert.rejects(
    tool.execute(
      "call",
      input(),
      new AbortController().signal,
      undefined,
      {} as Parameters<typeof tool.execute>[4],
    ),
    /only after the user confirms/,
  );
});

test("curriculum replan uses the future-frontier endpoint", async () => {
  let url = "";
  await applyCurriculumPlan(
    {
      frontier: input().frontier,
      added_skills: [],
      depth_changes: [],
      prerequisite_additions: [],
      remove_skill_ids: [],
    },
    {
      baseUrl: "http://learning.test",
      log: () => undefined,
      fetchImpl: async (request) => {
        url = String(request);
        return Response.json(input().frontier);
      },
    },
  );
  assert.equal(url, "http://learning.test/api/learning/frontier/apply");
});

test("goal-understanding tool exposes a provider-compatible object root schema", () => {
  const tool = createRecordGoalUnderstandingTool(new GoalOnboardingContext());
  assert.equal(
    (tool.parameters as { type?: string }).type,
    "object",
    "DeepSeek and OpenAI-compatible providers require function schemas to have an object root",
  );
});

test("confirmed card accepts an identical structured profile echo without rewriting the draft", async () => {
  const context = new GoalOnboardingContext();
  context.start({replaceExisting: true});
  const profile = {...input().goal_profile, learning_domain: "数学"};
  context.record({outcome: "READY_FOR_CONFIRMATION", profile});
  context.beginUserTurn("确认");
  const tool = createRecordGoalUnderstandingTool(context);
  await tool.execute("echo-confirm", {outcome: "CONFIRMED", profile}, new AbortController().signal,
    undefined, {} as Parameters<typeof tool.execute>[4]);
  assert.equal(context.snapshot().status, "CONFIRMED");
  assert.deepEqual(context.snapshot().pending_profile, profile);
  assert.equal(context.snapshot().replace_existing, true);
});

test("confirmation rejects changed profiles and still requires a real independent human turn", async () => {
  const context = new GoalOnboardingContext(); context.start();
  const profile = input().goal_profile;
  context.record({outcome: "READY_FOR_CONFIRMATION", profile});
  const tool = createRecordGoalUnderstandingTool(context);
  const run = (profile: ReturnType<typeof input>["goal_profile"]) =>
    tool.execute("confirm", {outcome: "CONFIRMED", profile}, new AbortController().signal, undefined, {} as Parameters<typeof tool.execute>[4]);
  await assert.rejects(() => run(profile), /latest user/);
  context.beginUserTurn("确认");
  await assert.rejects(() => run({...profile, desired_outcome: "偷偷替换"}), /原草案/);
  assert.equal(context.snapshot().status, "READY_FOR_CONFIRMATION");
  assert.deepEqual(context.snapshot().pending_profile, profile);
});

test("lost initialization response queries the original committed result and never posts a second create", async () => {
  let committed = false; let creates = 0; let queries = 0;
  const result = {goal_profile: input().goal_profile, curriculum_spine: input().curriculum_spine, frontier: input().frontier};
  const options = {baseUrl: "http://learning.test", onboardingSessionId: "original-draft", log: () => undefined,
    fetchImpl: async (_url: unknown, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      if (payload.recover_only) {
        queries++;
        return committed ? Response.json(result, {status: 201})
          : Response.json({code: "PLANNING_RESULT_NOT_FOUND"}, {status: 404});
      }
      creates++; committed = true; throw new TypeError("socket closed after atomic save");
    }};
  assert.deepEqual(await initializeLearningGoal(input(), options), result);
  assert.equal(creates, 1); assert.equal(queries, 2);
  assert.deepEqual(await initializeLearningGoal(input(), options), result);
  assert.equal(creates, 1, "retry must resolve the saved route before sending another create");
});

test("unknown initialization result does not blindly create when authority cannot be queried", async () => {
  let creates = 0;
  await assert.rejects(() => initializeLearningGoal(input(), {baseUrl: "http://learning.test", onboardingSessionId: "original-draft", log: () => undefined,
    fetchImpl: async (_url, init) => {
      if (JSON.parse(String(init?.body)).recover_only) throw new TypeError("query timed out");
      creates++; return Response.json({});
    }}), /query timed out|结果|核验/);
  assert.equal(creates, 0);
});
