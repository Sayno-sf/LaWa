import assert from "node:assert/strict";
import test from "node:test";
import { projectLearningContext, compactOverviewMessages } from "./modelLearningContext.js";
import { createGetLearningOverviewTool, type LearningOverview } from "./learningOverviewTool.js";

const overview: LearningOverview = {
  current_goal: "学习当前课程", goal_profile: { id: "goal-current", learning_preferences: ["用中文解释"] },
  current_frontier: { focus_skill_id: "focus", supporting_skill_ids: ["support"], next_action: "继续当前任务" },
  active_task: { id: "task-current", title: "当前练习", status: "ACTIVE", related_skill_ids: ["focus"] },
  current_focus: null, current_goal_skill_ids: ["focus", "support", "prior", "later"],
  skills: [
    { id: "focus", name: "当前技能", status: "LEARNING", prerequisites: ["prior"], evidence_ids: ["e-1"] },
    { id: "support", status: "NOT_STARTED" }, { id: "prior", status: "MASTERED_BY_USER" },
    { id: "later", status: "NOT_STARTED" }, { id: "foreign", name: "OTHER_GOAL_SECRET" },
  ],
  curriculum_spine: [{ id: "m-1", name: "当前阶段" }, { id: "m-2", name: "未来阶段" }],
  recent_evidence: [{ description: "EVIDENCE_DETAIL_SECRET", assistance_level: "WITH_HINT" }],
  knowledge_cards: [{ answer: "CARD_DETAIL_SECRET" }],
  learning_history: Array.from({ length: 100 }, () => ({ goal: "ARCHIVED_SECRET", text: "x".repeat(10_000) })),
};

test("default model context keeps current facts and prerequisites without unrelated records", () => {
  const context = projectLearningContext(overview);
  assert.deepEqual(context.skills.map(skill => skill.id), ["focus", "support", "prior"]);
  assert.equal(context.active_task?.id, "task-current");
  assert.equal(context.skills[0]?.evidence_count, 1);
  assert.deepEqual(context.goal_profile?.learning_preferences, ["用中文解释"]);
  assert.doesNotMatch(JSON.stringify(context), /SECRET|later|learning_history|recent_evidence|knowledge_cards/);
  assert.equal(context.scope, "current");
});

test("route query is bounded, paginated and restricted to the current Goal", () => {
  const first = projectLearningContext(overview, { scope: "route", limit: 2 });
  const second = projectLearningContext(overview, { scope: "route", limit: 2, offset: 2 });
  assert.deepEqual(first.skills.map(skill => skill.id), ["focus", "support"]);
  assert.deepEqual(second.skills.map(skill => skill.id), ["prior", "later"]);
  assert.equal(first.page?.skills_total, 4);
  assert.equal(first.page?.next_offset, 2);
  assert.equal(second.page?.next_offset, null);
  assert.doesNotMatch(JSON.stringify([first, second]), /SECRET/);
  assert.equal(projectLearningContext(overview, { scope: "route", offset: 100 }).skills.length, 0);
});

test("oversized fields and lists are bounded and explicitly report omissions", () => {
  const large = { ...overview, goal_profile: { id: "goal-current", desired_outcome: "z".repeat(100_000),
    learning_preferences: Array.from({ length: 100 }, () => "p".repeat(10_000)) },
    current_frontier: { focus_skill_id: "focus", supporting_skill_ids: [], next_action: "a".repeat(100_000) } };
  const context = projectLearningContext(large);
  assert.ok(JSON.stringify(context).length < 8_000);
  assert.ok(context.truncated_fields.includes("goal_profile.desired_outcome"));
  assert.ok(context.truncated_fields.includes("goal_profile.learning_preferences"));
});

test("existing overview history is reduced only for model input without altering stored messages", () => {
  const old = { role: "toolResult", toolName: "get_learning_overview", toolCallId: "old-call", isError: false,
    content: [{ type: "text", text: JSON.stringify(overview) }], timestamp: 1 };
  const source = { ...old, toolName: "read_learning_material" };
  const error = { ...old, isError: true };
  const invalid = { ...old, content: [{ type: "text", text: "not JSON" }] };
  const assistant = { ...old, role: "assistant" };
  const messages = [old, source, error, invalid, assistant];
  const before = JSON.stringify(messages);
  const reduced = compactOverviewMessages(messages);
  assert.equal(JSON.stringify(messages), before);
  assert.doesNotMatch(reduced[0]!.content[0]!.text, /SECRET/);
  assert.equal(reduced[0]!.toolCallId, "old-call");
  assert.equal(JSON.parse(reduced[0]!.content[0]!.text).historical_snapshot, true);
  assert.equal(reduced[1], source); assert.equal(reduced[2], error);
  assert.equal(reduced[3], invalid); assert.equal(reduced[4], assistant);
  assert.deepEqual(compactOverviewMessages(reduced), reduced);
});

test("actual overview tool returns bounded views while raw fetch remains available to UI", async () => {
  let calls = 0;
  const tool = createGetLearningOverviewTool({ log: () => undefined, fetchImpl: async () => {
    calls++; return Response.json(overview);
  } });
  const execute = (params: Parameters<typeof tool.execute>[1]) => tool.execute("call", params, undefined, undefined, {} as Parameters<typeof tool.execute>[4]);
  const parse = (result: Awaited<ReturnType<typeof execute>>) => {
    const part = result.content.find(part => part.type === "text");
    assert.ok(part?.type === "text");
    return JSON.parse(part.text);
  };
  const current = parse(await execute({}));
  const route = parse(await execute({ scope: "route", offset: 2, limit: 2 }));
  assert.equal(current.scope, "current");
  assert.deepEqual(route.skills.map((skill: { id: string }) => skill.id), ["prior", "later"]);
  assert.doesNotMatch(JSON.stringify([current, route]), /SECRET/);
  assert.equal(calls, 2);
});

test("state reads refresh after changes and retain the unmodified raw UI response", async () => {
  const { fetchLearningOverview } = await import("./learningOverviewTool.js");
  let state = structuredClone(overview);
  const options = { log: () => undefined, fetchImpl: async () => Response.json(state) };
  const tool = createGetLearningOverviewTool(options);
  const first = await tool.execute("first", {}, undefined, undefined, {} as Parameters<typeof tool.execute>[4]);
  assert.match(JSON.stringify(first.content), /task-current/);
  state.active_task = { id: "task-new", related_skill_ids: ["later"], status: "ACTIVE" };
  const second = await tool.execute("second", {}, undefined, undefined, {} as Parameters<typeof tool.execute>[4]);
  assert.match(JSON.stringify(second.content), /task-new/);
  assert.doesNotMatch(JSON.stringify(second.content), /task-current/);
  assert.deepEqual(await fetchLearningOverview(options), state);
});
