import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fauxAssistantMessage} from "@earendil-works/pi-ai";
import {ClassroomFeed} from "./classroomFeed.js";
import {WebSessionStore} from "./sessionStore.js";
import type {LearningOverview} from "../learningOverviewTool.js";

test("public run survives restart as interrupted, has bounded text, and never replays a model", () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-classroom-"));
  try {
    const feed = new ClassroomFeed(directory);
    const id = feed.begin("session-a");
    const received: Array<{sequence: number}> = [];
    const unsubscribe = feed.subscribe(value => received.push(value));
    feed.event("another-session", {type: "assistant_delta", delta: "wrong-scope"});
    feed.event("session-a", {type: "assistant_delta", delta: "a".repeat(70_000)});
    assert.equal(received.length, 1);
    assert.equal(received[0]?.sequence, 2);
    assert.equal(feed.sequence, 2);
    assert.equal(feed.snapshot()?.text.length, 64_000);
    assert.equal(feed.snapshot()?.textOmitted, true);
    unsubscribe(); feed.event("session-a", {type: "assistant_delta", delta: "more"});
    assert.equal(received.length, 1);
    const restored = new ClassroomFeed(directory).snapshot();
    assert.equal(restored?.id, id); assert.equal(restored?.status, "interrupted"); assert.equal(restored?.text, "");
  } finally {rmSync(directory, {recursive: true, force: true});}
});

test("a failed viewer cannot block healthy viewers or take over generation", () => {
  const feed = new ClassroomFeed(); let healthy = 0;
  feed.subscribe(() => {throw new Error("disconnected");});
  feed.subscribe(() => {healthy++;});
  feed.begin("s"); feed.event("s", {type: "assistant_delta", delta: "visible"}); feed.finish("s", true);
  assert.equal(healthy, 3); assert.equal(feed.snapshot()?.status, "completed");
  assert.equal(feed.sequence, 3);
});

test("reconnecting after an automatic route entry does not replay already projected streaming text", () => {
  const feed = new ClassroomFeed(); feed.begin("s");
  feed.event("s", {type: "assistant_delta", delta: "已落盘的进入说明"});
  feed.event("s", {type: "conversation_update", routeChanged: true});
  assert.equal(feed.snapshot()?.text, "");
  feed.event("s", {type: "assistant_delta", delta: "分支中的新讲解"});
  assert.equal(feed.snapshot()?.text, "分支中的新讲解");
});

test("two clients share one run, disconnected sender does not stop it, and stale scopes cannot write", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-shared-store-"));
  const overview: LearningOverview = {current_goal: "旅行交流", goal_profile: {id: "goal"}, curriculum_spine: [], current_frontier: null,
    current_focus: null, skills: [{id: "greeting", status: "LEARNING"}], recent_evidence: [], active_task: {id: "task", related_skill_ids: ["greeting"], status: "ACTIVE"}, current_goal_skill_ids: ["greeting"], learning_history: []};
  let release!: () => void, entered!: () => void, calls = 0;
  const started = new Promise<void>(resolve => {entered = resolve;});
  const gate = new Promise<void>(resolve => {release = resolve;});
  const store = new WebSessionStore({conversationDir: directory, fetchOverview: async () => overview, fetchLibrary: async () => ({projects: []}),
    createAgent: async (_context, _planning, emit, manager) => ({prompt: async text => {
      calls++; manager.appendMessage({role: "user", content: text, timestamp: Date.now()});
      emit({type: "assistant_delta", delta: "你好"}); entered(); await gate;
      manager.appendMessage(fauxAssistantMessage("你好，我们继续旅行交流。"));
    }, abort: async () => release(), dispose: () => undefined})});
  try {
    const initial = await store.create("resume-recent");
    const snapshot = await store.sharedClassroom() as {version: string};
    const seen: unknown[] = []; const unsubscribe = store.classroom.subscribe(value => seen.push(value));
    const pending = store.sendMessage(initial.sessionId, "开始", () => {throw new Error("sender closed");}, undefined, undefined, "one-request", snapshot.version);
    await started;
    assert.equal((await store.sharedClassroom() as {run: {text: string}}).run.text, "你好");
    await assert.rejects(() => store.sendMessage(initial.sessionId, "从另一端重复发", () => undefined), /already responding/);
    await assert.rejects(() => store.stop(initial.sessionId, "previous-run"), /回合已变化/);
    unsubscribe(); release(); await pending;
    assert.equal(store.classroom.snapshot()?.status, "completed"); assert.equal(calls, 1);
    await assert.rejects(() => store.sendMessage(initial.sessionId, "旧页回答", () => undefined, undefined, undefined, "old-page", snapshot.version), /现场已在其他设备变化/);
    await store.sendMessage(initial.sessionId, "开始", () => undefined, undefined, undefined, "one-request", snapshot.version);
    assert.equal(calls, 1, "same submitted request must not call the model again");
    assert.ok(seen.length > 1);
  } finally {release?.(); store.dispose(); rmSync(directory, {recursive: true, force: true});}
});
