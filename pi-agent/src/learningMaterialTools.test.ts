import assert from "node:assert/strict";
import test from "node:test";
import { createLearningMaterialTools } from "./learningMaterialTools.js";

test("one existing search tool handles optional source and runtime draft scope", async () => {
  const calls: URL[] = [];
  const tools = createLearningMaterialTools({ baseUrl: "http://api.test", fetchImpl: async (input, init) => {
    calls.push(new URL(String(input)));
    assert.ok(!init?.method || init.method === "GET");
    return Response.json({ matches: [] });
  } }, () => "draft-session");
  assert.deepEqual(tools.map(t => t.name), ["get_imported_learning_context", "get_skill_learning_context", "list_learning_materials", "read_learning_material", "search_learning_material"]);
  const search = tools.find(t => t.name === "search_learning_material")!;
  await search.execute("all", { query: "AgentSession" }, new AbortController().signal, undefined, {} as Parameters<typeof search.execute>[4]);
  await search.execute("one", { query: "学习率", material_id: "mat-id", limit: 3 }, new AbortController().signal, undefined, {} as Parameters<typeof search.execute>[4]);
  assert.equal(calls[0]!.pathname, "/api/learning/materials/search");
  assert.equal(calls[0]!.searchParams.get("limit"), "5");
  assert.equal(calls[0]!.searchParams.get("draft_session_id"), "draft-session");
  assert.equal(calls[1]!.pathname, "/api/learning/materials/mat-id/search");
  assert.equal(calls[1]!.searchParams.get("query"), "学习率");
  assert.ok(!(search.parameters as { required: string[] }).required.includes("material_id"));
  assert.ok(!JSON.stringify(search.parameters).includes("goal_id"));
});

test("read tool forwards a stable chunk window or cursor and applies default context bound", async () => {
  const calls: URL[] = [];
  const tools = createLearningMaterialTools({ baseUrl: "http://api.test", fetchImpl: async input => {
    calls.push(new URL(String(input)));
    return Response.json({ text: "original", citation: "source line 2" });
  } });
  const read = tools.find(t => t.name === "read_learning_material")!;
  await read.execute("chunk", { material_id: "mat-id", chunk_id: "chk-stable", before: 1, after: 1 }, new AbortController().signal, undefined, {} as Parameters<typeof read.execute>[4]);
  await read.execute("cursor", { material_id: "mat-id", cursor: "continue-here" }, new AbortController().signal, undefined, {} as Parameters<typeof read.execute>[4]);
  assert.equal(calls[0]!.searchParams.get("chunk_id"), "chk-stable");
  assert.equal(calls[0]!.searchParams.get("before"), "1");
  assert.equal(calls[0]!.searchParams.get("after"), "1");
  assert.equal(calls[0]!.searchParams.get("max_chars"), "4000");
  assert.equal(calls[1]!.searchParams.get("cursor"), "continue-here");
  assert.equal(calls[1]!.searchParams.has("start"), false);
});
