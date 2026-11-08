import assert from "node:assert/strict";
import test from "node:test";
import {ReadingModelActivity} from "./readingModelActivity.js";

test("foreground cancels an active reading before answering, and reading cannot start during a turn", async () => {
  const activity = new ReadingModelActivity();
  const events: string[] = [];
  const background = activity.tryBackground(async signal => {
    await new Promise<void>(done => signal.addEventListener("abort", () => {events.push("reading-canceled"); done();}, {once: true}));
  });
  await activity.runForeground(async () => {
    events.push("teacher");
    assert.deepEqual(await activity.tryBackground(async () => {throw new Error("must not run");}), {ran: false});
  });
  await background;
  assert.deepEqual(events, ["reading-canceled", "teacher"]);
  assert.deepEqual(await activity.tryBackground(async () => "resumed"), {ran: true, value: "resumed"});
});

test("an SDK that ignores abort cannot hold the learner behind an unbounded reading wait", async () => {
  const activity = new ReadingModelActivity(20);
  let release!: () => void;
  const background = activity.tryBackground(() => new Promise<void>(done => {release = done;}));
  await activity.runForeground(async () => {assert.equal(activity.busy, true);});
  release(); await background;
  assert.equal(activity.busy, false);
});
