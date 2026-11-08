import assert from "node:assert/strict";
import test from "node:test";

import {
  createGetLearningOverviewTool,
  fetchLearningOverview,
} from "./learningOverviewTool.js";

const overviewPayload = {
  current_goal: "掌握 CNN",
  goal_profile: null,
  curriculum_spine: [],
  current_frontier: null,
  current_focus: { id: "task-1" },
  skills: [{ id: "cnn", status: "LEARNING" }],
  recent_evidence: [],
  active_task: { id: "task-1" },
  learning_history: [],
  current_goal_skill_ids: [],
};

test("fetchLearningOverview calls the Python endpoint and validates the payload", async () => {
  let requestedUrl = "";
  const logs: string[] = [];
  const overview = await fetchLearningOverview({
    baseUrl: "http://learning.test/",
    log: (message) => logs.push(message),
    fetchImpl: async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify(overviewPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(requestedUrl, "http://learning.test/api/learning/overview");
  assert.equal(overview.current_goal, "掌握 CNN");
  assert.match(logs[1] ?? "", /skills=1/);
});

test("fetchLearningOverview rejects HTTP and malformed responses", async () => {
  await assert.rejects(
    fetchLearningOverview({
      log: () => undefined,
      fetchImpl: async () => new Response("offline", { status: 503 }),
    }),
    /HTTP 503/,
  );
  await assert.rejects(
    fetchLearningOverview({
      log: () => undefined,
      fetchImpl: async () => Response.json({ current_goal: "missing arrays" }),
    }),
    /invalid overview payload/,
  );
});

test("legacy overview schema reports missing Sprint 4 fields and restart guidance", async () => {
  await assert.rejects(
    fetchLearningOverview({
      log: () => undefined,
      fetchImpl: async () =>
        Response.json({
          current_goal: null,
          current_focus: null,
          skills: [],
          recent_evidence: [],
          active_task: null,
          learning_history: [],
          current_goal_skill_ids: [],
        }),
    }),
    /goal_profile.*curriculum_spine.*current_frontier.*restart the Python Learning API/is,
  );
});

test("custom tool returns the overview as a Pi tool result", async () => {
  const tool = createGetLearningOverviewTool({
    log: () => undefined,
    fetchImpl: async () => Response.json(overviewPayload),
  });
  const context = {} as Parameters<typeof tool.execute>[4];
  const result = await tool.execute(
    "call-1",
    {},
    new AbortController().signal,
    undefined,
    context,
  );
  assert.equal(result.content[0]?.type, "text");
  assert.match(result.content[0]?.text ?? "", /task-1/);
  assert.deepEqual(result.details, {
    currentGoal: "掌握 CNN",
    skillCount: 1,
    evidenceCount: 0,
  });
});
