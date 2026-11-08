import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {growthProjectTimes, orderedGrowthProjects} from "./src/growthLibraryModel.ts";

const archivedTime = "2035-10-29T12:30:00+00:00";
const recordedTime = "2026-10-20T08:15:00+00:00";
function project(id: string, status = "ARCHIVED", archived_at: string | null = archivedTime) {
  return {id, status, archived_at, evidence: [] as {created_at: string}[],
    answer_assessments: [] as {created_at: string}[],
    knowledge_cards: [] as {created_at: string; note_updated_at?: string | null; feedback_updated_at?: string | null}[]};
}

test("archive snapshot time retains its switch label and does not become a learning time", () => {
  const source = readFileSync(new URL("./src/growthLibraryView.ts", import.meta.url), "utf8");
  assert.match(source, /最近切出/);
  assert.match(source, /首次归档/);
  assert.match(source, /最近学习/);
  assert.deepEqual(growthProjectTimes(project("archived")), {recorded: null, switched: archivedTime});
  assert.deepEqual(growthProjectTimes(project("current", "CURRENT", null)), {recorded: null, switched: null});
  assert.deepEqual(growthProjectTimes(project("no-time", "ARCHIVED", null)), {recorded: null, switched: null});
});

test("current goal comes first while other goals retain server order without mutating input", () => {
  const projects = Object.freeze([Object.freeze(project("first", "ARCHIVED", "2020-01-01T00:00:00+00:00")),
    Object.freeze(project("current", "CURRENT", null)), Object.freeze(project("second"))]);
  assert.deepEqual(orderedGrowthProjects(projects).map(p => p.id), ["current", "first", "second"]);
  assert.deepEqual(projects.map(p => p.id), ["first", "current", "second"]);
});

const factSources = [
  ["Evidence.created_at", (p: ReturnType<typeof project>) => p.evidence.push({created_at: recordedTime})],
  ["Assessment.created_at", (p: ReturnType<typeof project>) => p.answer_assessments.push({created_at: recordedTime})],
  ["Card.created_at", (p: ReturnType<typeof project>) => p.knowledge_cards.push({created_at: recordedTime})],
  ["Card.note_updated_at", (p: ReturnType<typeof project>) => p.knowledge_cards.push({created_at: "2020-01-01T00:00:00Z", note_updated_at: recordedTime})],
  ["Card.feedback_updated_at", (p: ReturnType<typeof project>) => p.knowledge_cards.push({created_at: "2020-01-01T00:00:00Z", feedback_updated_at: recordedTime})],
] as const;
for (const [source, add] of factSources) {
  test(`recent record uses ${source} independently of later archive snapshot time`, () => {
    const item = project("fact"); add(item); const before = JSON.stringify(item);
    assert.deepEqual(growthProjectTimes(item), {recorded: recordedTime, switched: archivedTime});
    assert.deepEqual(growthProjectTimes(item), {recorded: recordedTime, switched: archivedTime});
    assert.equal(JSON.stringify(item), before);
  });
}
