import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import {createConfigureTeachingActivityTool, requireTeachingActivity, type TeachingActivity} from "./teachingActivity.js";
import {TeachingSessionContext} from "./teachingSession.js";
import {learningStartSignature} from "./learnerQuestions.js";
import {projectPreferencePlans, teachingPreferenceSnapshot} from "./teachingPreferences.js";
import type {LearningOverview} from "./learningOverviewTool.js";

const activity: TeachingActivity = {method: "COMPARE", purpose: "区分适用条件", learner_action: "比较两例并判断新例子",
  observable_output: "判断与理由", evaluation_focus: ["关键区别"], observation_limits: "一次回答不证明长期保持"};
const overview: LearningOverview = {current_goal: "阅读材料", goal_profile: {id: "g"}, current_frontier: null,
  current_focus: null, skills: [], recent_evidence: [], active_task: {id: "t", related_skill_ids: ["s"], status: "ACTIVE"},
  curriculum_spine: [], learning_history: [], current_goal_skill_ids: ["s"]};

test("activity update binds runtime Goal, exact revision and preference version; pending questions block writes", async () => {
  const context = new TeachingSessionContext(); context.bindSession("session");
  const writes: unknown[] = [];
  const revision = "b".repeat(64);
  const tool = createConfigureTeachingActivityTool(context, {teachingPreferencesRevision: () => revision, log: () => {}, fetchImpl: async (url, init) => {
    if (String(url).endsWith("overview")) return Response.json(overview);
    const body = JSON.parse(String(init?.body)); writes.push(body); return Response.json({id: "t", ...body});
  }});
  const args = {task_id: "t", expected_revision: 3, teaching_activity: {...activity, teaching_preferences_revision: "forged"}};
  const run = () => tool.execute("call", args, new AbortController().signal, undefined, {} as never);
  await run();
  assert.deepEqual(writes, [{expected_goal_id: "g", expected_revision: 3, teaching_activity: {...activity, teaching_preferences_revision: revision}}]);
  context.learnerQuestions.ask({id: "q", purpose: "CHECK", session_id: "session", goal_id: "g", task_id: "t", skill_id: "s",
    questions: [{id: "q", prompt: "判断这个例子", selection: "freeform", options: []}]});
  await assert.rejects(run, /问题尚未/); assert.equal(writes.length, 1);
  context.learnerQuestions.chat("先讲清楚，再决定做不做题");
  await run(); assert.equal(writes.length, 2, "chat may interrupt practice and replan without submitting an answer");
});

test("new observations do not change preference identity; withdrawal invalidates Task activity but preserves contracts", () => {
  const data = {preference_revision: "v1", strategies: [{id: "p", revision: 1, text: "先举例"}]};
  const first = teachingPreferenceSnapshot({...data, observations: [{id: "a1"}], available_domains: ["英语"]}, "");
  const second = teachingPreferenceSnapshot({...data, observations: [{id: "a2"}], available_domains: ["英语", "历史"]}, "");
  assert.equal(first.revision, second.revision);
  const next = teachingPreferenceSnapshot({preference_revision: "v2", strategies: []}, "");
  assert.notEqual(first.revision, next.revision);
  const oldActivity = {...activity, teaching_preferences_revision: first.revision};
  const source = {active_task: {id: "t", related_skill_ids: ["s"], activity_revision: 1, teaching_activity: oldActivity},
    contract: {id: "q", activity_revision: 1, teaching_activity: oldActivity}};
  const projected = projectPreferencePlans(source, next.revision);
  assert.equal(projected.active_task.teaching_activity, undefined);
  assert.deepEqual(projected.contract, source.contract);
  assert.deepEqual(source.active_task.teaching_activity, oldActivity);
  assert.throws(() => requireTeachingActivity(source.active_task, next.revision), /偏好已经变化/);
  assert.deepEqual(requireTeachingActivity(source.active_task, first.revision), oldActivity);
});

test("new empty metadata retains old start and reading-wait signatures; real domain changes invalidate", () => {
  const old = {...overview, current_frontier: {focus_skill_id: "s", next_action: "学习"}};
  const oldSignature = createHash("sha256").update(JSON.stringify({goal: old.goal_profile, frontier: old.current_frontier, task: old.active_task})).digest("hex");
  const extended = {...old, goal_profile: {...old.goal_profile as object, learning_domain: ""},
    current_frontier: {...old.current_frontier, teaching_preferences_revision: null},
    active_task: {...old.active_task as object, activity_revision: 0, teaching_activity: null}};
  assert.equal(learningStartSignature(extended), oldSignature);
  assert.notEqual(learningStartSignature({...extended, goal_profile: {id: "g", learning_domain: "英语"}}), oldSignature);
});
