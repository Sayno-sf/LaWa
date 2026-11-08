import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConversationCatalog } from "./conversationCatalog.js";
import {ROUTE_TRANSITION} from "./routePathState.js";

test("route records follow their own intervals and Goal, including an empty entry and later resumed teaching", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-route-records-"));
  try {
    const catalog = new ConversationCatalog(directory), manager = catalog.create();
    const say = (text: string) => manager.appendMessage({role:"assistant",content:[{type:"text",text}],timestamp:Date.now()} as Parameters<typeof manager.appendMessage>[0]);
    const move = (branchId: string, action: string, goal = "goal-a") => manager.appendCustomEntry(ROUTE_TRANSITION,
      {branchId, action, path:`${goal}:${action === "enter" ? branchId : "main"}`});
    catalog.recordGoal(manager,"goal-a","Goal A"); say("Main lesson before the detour");
    const entry = move("route-a","enter");
    assert.deepEqual(await catalog.locateRouteBranch("goal-a","route-a"), {sessionId:manager.getSessionId(),entryId:entry,messageIds:[]});
    const first = say("First prerequisite explanation");
    move("route-a","return"); say("Interleaved main lesson");
    move("route-b","enter"); say("A different extension"); move("route-b","return");
    move("route-a","enter"); const second=say("Resumed prerequisite explanation"); move("route-a","complete");
    catalog.recordGoal(manager,"goal-b","Goal B");
    move("route-a","enter","goal-b"); say("A different Goal must not be included");
    const bytes=readFileSync(manager.getSessionFile()!);
    const source=await catalog.locateRouteBranch("goal-a","route-a");
    assert.deepEqual(source?.messageIds,[first,second]);
    assert.equal(await catalog.locateRouteBranch("missing-goal","route-a"),null);
    assert.deepEqual(readFileSync(manager.getSessionFile()!),bytes,"reading never rewrites the source session");
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test("conversation catalog lists empty sessions, persists names and goal labels, and trashes safely", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-catalog-"));
  try {
    const catalog = new ConversationCatalog(directory, process.cwd());
    const manager = catalog.create();
    const id = manager.getSessionId();
    catalog.recordGoal(manager, "goal-a", "学习 ACO");

    let listed = await catalog.list(id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.active, true);
    assert.match(listed[0]?.name ?? "", /^新对话 ·/);
    assert.equal(listed[0]?.goalId, "goal-a");
    assert.equal(listed[0]?.goalDescription, "学习 ACO");

    await catalog.rename(id, "蚁群算法学习");
    listed = await catalog.list(id);
    assert.equal(listed[0]?.name, "蚁群算法学习");
    assert.equal((await catalog.open(id)).getSessionId(), id);

    await catalog.trash(id);
    assert.deepEqual(await catalog.list(null), []);
    const trashDirectory = join(directory, ".trash");
    assert.equal(existsSync(trashDirectory), true);
    assert.equal(readdirSync(trashDirectory).some((file) => file.endsWith(".jsonl")), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("conversation catalog resolves ids only from its enumerated directory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-catalog-safe-"));
  try {
    const catalog = new ConversationCatalog(directory, process.cwd());
    catalog.create();
    await assert.rejects(catalog.open("../outside"), /not found/i);
    await assert.rejects(catalog.trash("..%2Foutside"), /not found/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("goal and skill locations follow Pi branches and preserve the original path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-catalog-tree-"));
  try {
    const catalog = new ConversationCatalog(directory, process.cwd());
    const manager = catalog.create();
    catalog.recordGoal(manager, "goal-a", "Learn A");
    manager.appendMessage({
      role: "toolResult", toolName: "record_teaching_turn", toolCallId: "teach-a",
      content: [{ type: "text", text: JSON.stringify({ active_skill_id: "skill-a" }) }],
      isError: false, timestamp: Date.now(),
    } as Parameters<typeof manager.appendMessage>[0]);
    const original = manager.appendMessage({
      role: "assistant", content: [{ type: "text", text: "First explanation" }], timestamp: Date.now(),
    } as Parameters<typeof manager.appendMessage>[0]);
    catalog.recordGoal(manager, "goal-b", "Learn B");
    const other = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "B" }], timestamp: Date.now() } as Parameters<typeof manager.appendMessage>[0]);

    assert.deepEqual(await catalog.locateSkill("goal-a", "skill-a"), { sessionId: manager.getSessionId(), entryId: original });
    assert.deepEqual(await catalog.locateGoal("goal-a"), { sessionId: manager.getSessionId(), entryId: original });
    manager.branch(original);
    catalog.recordReview(manager, {
      operationId: "operation-001", goalId: "goal-a", skillId: "skill-a",
      sourceEntryId: original, returnEntryId: original, returnSessionId: manager.getSessionId(),
      reviewTaskId: "review-operation-001", createdAt: new Date().toISOString(),
    });
    catalog.recordGoal(manager, "goal-a", "Learn A", true);
    assert.equal(catalog.goalObservation(manager)?.goalId, "goal-a");
    assert.equal(catalog.currentReview(manager)?.skillId, "skill-a");
    assert.equal(manager.getEntry(other)?.id, other);
    assert.deepEqual(catalog.branches(manager).map((item) => item.label), ["首次学习", "复习 1"]);
    manager.branch(other);
    catalog.recordReview(manager, {
      operationId: "operation-002", goalId: "goal-b", skillId: "skill-b",
      sourceEntryId: other, returnEntryId: other, returnSessionId: manager.getSessionId(),
      reviewTaskId: "review-operation-002", createdAt: new Date().toISOString(),
    });
    assert.deepEqual(catalog.branches(manager, "goal-a").map((item) => item.label), ["首次学习", "复习 1"]);
    assert.deepEqual(catalog.branches(manager, "goal-b").map((item) => item.label), ["首次学习", "复习 1"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Goal restore prefers its dedicated session over a newer mixed session's stale marker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-catalog-owner-"));
  try {
    const catalog = new ConversationCatalog(directory, process.cwd());
    const a = catalog.create();
    catalog.recordGoal(a, "goal-a", "Learn A");
    const aLesson = a.appendMessage({ role: "assistant", content: [{ type: "text", text: "A lesson" }], timestamp: Date.now() } as Parameters<typeof a.appendMessage>[0]);
    const mixed = catalog.create();
    catalog.recordGoal(mixed, "goal-a", "Learn A");
    mixed.appendMessage({ role: "assistant", content: [{ type: "text", text: "Old A marker" }], timestamp: Date.now() } as Parameters<typeof mixed.appendMessage>[0]);
    catalog.recordGoal(mixed, "goal-b", "Learn B");
    mixed.appendMessage({ role: "assistant", content: [{ type: "text", text: "B lesson" }], timestamp: Date.now() } as Parameters<typeof mixed.appendMessage>[0]);
    assert.deepEqual(await catalog.locateGoal("goal-a"), { sessionId: a.getSessionId(), entryId: aLesson });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("navigation in a mixed-only session is not mistaken for a stale foreign branch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-catalog-mixed-only-"));
  try {
    const catalog = new ConversationCatalog(directory, process.cwd());
    const manager = catalog.create();
    catalog.recordGoal(manager, "goal-a", "Learn A");
    const a = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "A lesson" }], timestamp: Date.now() } as Parameters<typeof manager.appendMessage>[0]);
    catalog.recordGoal(manager, "goal-b", "Learn B");
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "B lesson" }], timestamp: Date.now() } as Parameters<typeof manager.appendMessage>[0]);
    manager.branch(a);
    catalog.recordGoal(manager, "goal-a", "Learn A", true);
    catalog.recordPosition(manager);
    assert.equal(await catalog.restoreNaturalConversationLeaf(manager), false);
    assert.equal(catalog.goalObservation(manager)?.goalId, "goal-a");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recent conversations follow learning activity rather than rename or filesystem modification", async () => {
 const directory=mkdtempSync(join(tmpdir(),"lawa-recent-learning-"));
 try {
  const catalog=new ConversationCatalog(directory,process.cwd()),older=catalog.create(),recent=catalog.create();
  for(const [manager,date] of [[older,"2026-01-01T00:00:00Z"],[recent,"2026-01-02T00:00:00Z"]] as const){
   manager.appendMessage({role:"user",content:"学习",timestamp:Date.parse(date)});
   const file=manager.getSessionFile()!;
   const rows=readFileSync(file,"utf8").trim().split("\n").map(line=>JSON.parse(line));
   for(const row of rows)if(row.type==="message")row.timestamp=date;
   writeFileSync(file,rows.map(row=>JSON.stringify(row)).join("\n")+"\n");
  }
  await catalog.rename(older.getSessionId(),"更改名称");
  assert.equal((await catalog.list())[0]?.id,recent.getSessionId());
  catalog.recordPosition(await catalog.open(older.getSessionId()));
  assert.equal((await catalog.list())[0]?.id,older.getSessionId());
 }finally{rmSync(directory,{recursive:true,force:true});}
});
