import assert from "node:assert/strict";
import test from "node:test";
import {closureSummaryPrompt, teachingPreferenceSnapshot} from "./teachingPreferences.js";

const empty = {preference_revision: "stable", strategies: [], proposals: []};
const progress = (assistance: string) => ({goal_id: "goal", route_learning_complete: true, active_task_present: false,
  user_confirmed_count: 0, expanded_skill_count: 2, milestone_count: 2, covered_milestone_count: 2,
  milestones: [{skills: [{id: "s5", name: "陌生场景", status: "LEARNING", assistance_levels: ["INDEPENDENT"],
    latest_assessment: {id: "a5", score: 10, assistance_level: "INDEPENDENT"}}]},
  {skills: [{id: "s6", name: "对照复盘", status: "LEARNING", assistance_levels: [assistance],
    latest_assessment: {id: "a6", score: 10, assistance_level: assistance}}]}], unassigned_skills: []});

for (const level of ["WITH_HINT", "WITH_HELP", "WITH_REFERENCE"]) {
  test(`closing input distinguishes each node's real ${level} from independent completion`, () => {
    const original = { ...empty, closure_progress: progress(level)};
    const before = structuredClone(original);
    const result = teachingPreferenceSnapshot(original, "");
    assert.match(result.prompt, /本轮收尾事实/);
    assert.match(result.prompt, /最近正式评分的帮助程度/);
    assert.match(result.prompt, new RegExp(`"skill_id":"s6"[^\n]*"assistance_level":"${level}"`));
    assert.match(result.prompt, /"skill_id":"s5"[^\n]*"assistance_level":"INDEPENDENT"/);
    assert.match(result.prompt, /"display_status":"待巩固"/);
    assert.match(result.prompt, /"user_confirmed_count":0/);
    assert.equal(result.revision, teachingPreferenceSnapshot({...empty, closure_progress: progress("INDEPENDENT")}, "").revision,
      "learning observations never change the teaching-preference revision");
    assert.deepEqual(original, before);
  });
}

test("a closure input with missing score cannot invent independent help or mastery", () => {
  const value = progress("WITH_HINT");
  value.milestones[1]!.skills[0]!.latest_assessment = null as never;
  const output = teachingPreferenceSnapshot({...empty, closure_progress: value}, "").prompt;
  assert.match(output, /本轮收尾事实/);
  assert.match(output, /"skill_id":"s6"[^\n]*"latest_assessment":null/);
});

test("a transferred fifth node does not erase the sixth node's hint or earlier help", () => {
  const value = progress("WITH_HINT");
  value.milestones[0]!.skills[0]!.assistance_levels = ["WITH_HELP", "TRANSFERRED"];
  value.milestones[0]!.skills[0]!.latest_assessment!.assistance_level = "TRANSFERRED";
  const before = structuredClone(value);
  const output = closureSummaryPrompt(value);
  assert.match(output, /"skill_id":"s5"[^\n]*"assistance_level":"TRANSFERRED"[^\n]*"all_recorded_assistance_levels":\["WITH_HELP","TRANSFERRED"\]/);
  assert.match(output, /"skill_id":"s6"[^\n]*"assistance_level":"WITH_HINT"/);
  assert.match(output, /TRANSFERRED只是原迁移标记，不自动证明无提示或长期掌握/);
  assert.deepEqual(value, before);
});

test("closing foreground is bounded and never inferred before the route actually ends", () => {
  const value = progress("WITH_HINT");
  assert.equal(closureSummaryPrompt({...value, route_learning_complete: false}), "");
  assert.equal(closureSummaryPrompt({...value, active_task_present: true}), "");
  assert.equal(closureSummaryPrompt({...value, active_task_present: undefined}), "");
  value.milestones[0]!.skills = Array.from({length: 25}, (_, index) => ({...value.milestones[0]!.skills[0]!, id: `extra-${index}`}));
  const output = closureSummaryPrompt(value);
  const data = JSON.parse(output.split("\n").find(line => line.startsWith("{\"goal_id\""))!);
  assert.equal(data.nodes.length, 20);
  assert.equal(data.omitted_skills, 6);
});
