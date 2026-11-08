import assert from "node:assert/strict";
import test from "node:test";
import { traceScopeLabel } from "./src/retrievalView.js";

const row = (name: string) => ({ goal_name: name, name: "教材", snippet: "", score: 1, locator: { kind: "line", start: 1, end: 2 } });
test("retrieval record labels use recorded candidates rather than the live page goal", () => {
  assert.equal(traceScopeLabel({ scope: "current", stages: { bm25: [row("旧目标")], dense: [row("旧目标")] } }), "检索当时的学习目标：旧目标");
  assert.equal(traceScopeLabel({ scope: "current", current_scope: "draft:old", stages: { bm25: [row("教材")] } }), "检索当时的新目标草稿");
  assert.equal(traceScopeLabel({ scope: "library", stages: { bm25: [row("甲"), row("乙")] } }), "检索当时的个人学习库");
  assert.equal(traceScopeLabel({ scope: "current", stages: {} }), "检索当时的学习目标（名称未记录）");
  assert.equal(traceScopeLabel({ scope: "current", stages: { bm25: [row("甲"), row("乙")] } }), "检索当时的学习目标（名称未记录）");
});
