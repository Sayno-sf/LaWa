import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { StudyTimeStore } from "./studyTimeStore.js";
import { studyScope, studyTimingPrompt, type StudyInterval, type StudyScope } from "../studyTimeTypes.js";

const scope: StudyScope = { goalId: "g", taskId: "t", goalName: "理解", taskName: "练习" };
const interval = (seq: number, focusedMs = 4000, waitingMs = 0): StudyInterval => ({ seq, observedMs: 5000, focusedMs, waitingMs, observation: focusedMs ? "FOCUSED" : "AWAY" });
async function fixture(run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "lawa-study-"));
  try { await run(join(dir, "time.json")); }
  finally { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); await rm(dir, { recursive: true, force: true }); }
}
test("focus, pause, waiting, retry, scope transition and restart preserve meaningful task time", async () => fixture(async path => {
  let at = 10000; const store = new StudyTimeStore(path, () => at);
  const start = await store.start(scope);
  await assert.rejects(store.start(scope), /另一个页面/);
  at += 5000; await store.observe(start.runId, interval(1), scope);
  await store.observe(start.runId, interval(1), scope);
  at += 5000; await store.observe(start.runId, interval(2, 0), scope);
  at += 5000; await store.observe(start.runId, interval(3, 0, 4000), scope);
  assert.equal((await store.summary(scope)).taskFocusedMs, 4000);
  assert.equal((await store.summary(scope)).taskWaitingMs, 4000);
  // 另一对话仍传入相同的Kernel scope，继续同一run；改变Task只保留可靠的新区间。
  at += 5000; await store.observe(start.runId, interval(4), scope);
  const second = { ...scope, taskId: "t2" };
  at += 5000; await store.observe(start.runId, interval(5), second);
  assert.equal((await store.summary(second)).taskFocusedMs, 0);
  at += 5000; await store.observe(start.runId, interval(6), second);
  assert.equal((await store.summary(second)).goalFocusedMs, 12000);
  await store.stop(start.runId, second);
  const restored = new StudyTimeStore(path, () => at);
  assert.equal((await restored.summary(scope)).taskFocusedMs, 8000);
  assert.equal((await restored.summary(second)).taskFocusedMs, 4000);
  assert.equal((await restored.summary(second)).recording, false);
  await assert.rejects(restored.observe(start.runId, interval(7), second), /失效/);
  const records = JSON.parse(await readFile(path, "utf8")).segments;
  assert.equal(records.length, 2); assert.ok(records.every((s: {endedAt: unknown}) => s.endedAt !== null));
  await restored.purgeGoal("g"); await restored.purgeGoal("g");
  assert.equal((await restored.summary(scope)).taskFocusedMs, 0);
  assert.equal(JSON.parse(await readFile(path, "utf8")).segments.length, 0);
}));
test("sleep, unknown scope and malformed intervals never inflate time", async () => fixture(async path => {
  let at = 10000; const store = new StudyTimeStore(path, () => at); const { runId } = await store.start(scope);
  await assert.rejects(store.observe(runId, { ...interval(1), focusedMs: 9000 }, scope), /无效/);
  at += 60000; await store.observe(runId, interval(1), scope);
  assert.equal((await store.summary(scope)).taskFocusedMs, 0);
  at += 5000; await store.observe(runId, interval(2), null);
  at += 5000; await store.observe(runId, interval(3), scope);
  assert.equal((await store.summary(scope)).taskFocusedMs, 0);
  at += 5000; await store.observe(runId, interval(4), scope);
  assert.equal((await store.summary(scope)).taskFocusedMs, 4000);
}));
test("corrupt data and failed saves cannot silently erase or acknowledge time", async () => fixture(async path => {
  await writeFile(path, "broken", "utf8"); const broken = new StudyTimeStore(path);
  await assert.rejects(broken.summary(scope)); assert.equal(await readFile(path, "utf8"), "broken");
  await rm(path); let at = 10000; const store = new StudyTimeStore(path, () => at); const {runId} = await store.start(scope);
  await mkdir(path + ".tmp"); at += 5000;
  await assert.rejects(store.observe(runId, interval(1), scope));
  assert.equal((await store.summary(scope)).taskFocusedMs, 0);
  await rm(path + ".tmp", {recursive: true}); await store.observe(runId, interval(1), scope);
  assert.equal((await store.summary(scope)).taskFocusedMs, 4000);
}));
test("scope and teacher timing cannot grant evidence or turn a duration into graduation", () => {
  assert.equal(studyScope({ goal_profile: {id: "g"}, current_goal: "g", active_task: {id:"t", goal_id:"other", status:"ACTIVE"} }), null);
  const prompt = studyTimingPrompt({ scope, taskFocusedMs: 12345, goalFocusedMs: 12345, runFocusedMs: 12345, taskObservedMs: 15000, taskWaitingMs: 1000, observation:"FOCUSED", recording:true });
  assert.match(prompt, /task_focused_seconds":12/); assert.match(prompt, /不能为赶时间跳过关键内容/); assert.match(prompt, /时间不是理解、Evidence/); assert.match(prompt, /未开启、未记录或覆盖不足不等于未学习/);
});
