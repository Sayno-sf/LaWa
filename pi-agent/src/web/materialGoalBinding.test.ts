import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LearningOverview } from "../learningOverviewTool.js";
import { createGateway } from "./gateway.js";
import { WebSessionStore } from "./sessionStore.js";

test("new Goal onboarding cannot upload materials into the previous active Goal", async () => {
  let uploads = 0;
  let forwarded: URL | undefined;
  const api = createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(200, {"Content-Type":"application/json"}); response.end("{}"); return;
    }
    uploads++;
    forwarded = new URL(request.url!, "http://localhost");
    response.writeHead(201, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ goal_id: forwarded.searchParams.get("expected_goal_id"), onboarding_session_id: forwarded.searchParams.get("draft_session_id") }));
  }).listen(0, "127.0.0.1");
  await once(api, "listening");
  const apiAddress = api.address();
  assert.ok(apiAddress && typeof apiAddress === "object");
  const originalApi = process.env.LEARNING_API_BASE_URL;
  process.env.LEARNING_API_BASE_URL = `http://127.0.0.1:${apiAddress.port}`;
  const overview = {
    current_goal: "Old goal", goal_profile: { id: "old-goal" }, curriculum_spine: [],
    current_frontier: null, current_focus: null, skills: [], recent_evidence: [],
    active_task: null, learning_history: [], current_goal_skill_ids: [],
  } as LearningOverview;
  const store = new WebSessionStore({ fetchOverview: async () => overview });
  const gateway = createGateway({ store }).listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const address = gateway.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await store.create("new-goal");
    const response = await fetch(`${base}/api/web/materials?filename=handbook.txt&sessionId=${session.sessionId}&goalId=old-goal`, {
      method: "POST", body: "original handbook text",
    });
    assert.equal(response.status, 201, "new Goal must support upload before route planning");
    assert.equal(uploads, 1);
    assert.equal(forwarded!.searchParams.get("draft_session_id"), session.sessionId);
    assert.equal(forwarded!.searchParams.get("purpose"), "conversation_attachment");
    assert.equal(forwarded!.searchParams.get("conversation_id"), session.sessionId);
    assert.equal(forwarded!.searchParams.get("expected_goal_id"), null, "draft upload must never use old active Goal");
    const payload = await response.json() as { goal_id: string | null };
    assert.equal(payload.goal_id, null);
    await store.startGoalOnboarding(session.sessionId, true);
    assert.equal(await store.materialGoal(session.sessionId, "old-goal"), `draft:${session.sessionId}`);
    const current = await store.create("new");
    const missing = await fetch(`${base}/api/web/materials?filename=missing.txt`, { method: "POST", body: "x" });
    assert.equal(missing.status, 409);
    const stale = await fetch(`${base}/api/web/materials?filename=stale.txt&sessionId=${current.sessionId}&goalId=another-goal`, { method: "POST", body: "x" });
    assert.equal(stale.status, 409);
    const valid = await fetch(`${base}/api/web/materials?filename=valid.txt&sessionId=${current.sessionId}&goalId=old-goal`, { method: "POST", body: "x" });
    assert.equal(valid.status, 201);
    assert.equal(forwarded!.searchParams.get("expected_goal_id"), "old-goal");
  } finally {
    if (originalApi === undefined) delete process.env.LEARNING_API_BASE_URL;
    else process.env.LEARNING_API_BASE_URL = originalApi;
    store.dispose();
    gateway.close(); api.close();
    await Promise.all([once(gateway, "close"), once(api, "close")]);
  }
});

test("new Goal draft survives restart and selecting the original conversation restores its task", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-draft-return-"));
  const current = {
    current_goal: "Original", goal_profile: { id: "original-goal" },
    active_task: { id: "original-task", title: "Original task", related_skill_ids: ["s"] },
    curriculum_spine: [], current_frontier: null, current_focus: null,
    skills: [], recent_evidence: [], learning_history: [], current_goal_skill_ids: [],
  } as LearningOverview;
  let store = new WebSessionStore({ conversationDir: directory, fetchOverview: async () => current });
  try {
    const original = await store.create("new");
    const draft = await store.create("new-goal");
    assert.equal(draft.state.onboarding.status, "NEEDS_CLARIFICATION");
    store.dispose();
    store = new WebSessionStore({ conversationDir: directory, fetchOverview: async () => current });
    const resumed = await store.activateConversation(draft.sessionId);
    assert.equal(await store.materialGoal(resumed.sessionId, null), `draft:${draft.sessionId}`);
    const restored = await store.activateConversation(original.sessionId);
    assert.equal(restored.sessionId, original.sessionId);
    assert.equal((restored.state.overview.active_task as { id: string }).id, "original-task");
    assert.equal(restored.state.onboarding.status, "IDLE");
    const reopened = await store.activateConversation(draft.sessionId);
    assert.equal(reopened.state.onboarding.status, "NEEDS_CLARIFICATION", "draft remains resumable after switching conversations");
  } finally {
    store.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("selecting a conversation restores its Goal and Task; reopening a draft never activates the old Goal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-natural-navigation-"));
  let goal = "original-goal";
  const activations: string[] = [];
  const api = createServer((request, response) => {
    goal = decodeURIComponent(request.url!.split("/").at(-2)!);
    activations.push(goal);
    response.writeHead(200, { "Content-Type": "application/json" }); response.end("{}");
  }).listen(0, "127.0.0.1");
  await once(api, "listening");
  const address = api.address(); assert.ok(address && typeof address === "object");
  const overview = (): LearningOverview => ({
    current_goal: goal, goal_profile: { id: goal },
    active_task: { id: `${goal}-task`, title: "Saved task" }, curriculum_spine: [], current_frontier: null,
    current_focus: null, skills: [], recent_evidence: [], learning_history: [], current_goal_skill_ids: [],
  });
  const store = new WebSessionStore({
    conversationDir: directory, apiBaseUrl: `http://127.0.0.1:${address.port}`,
    fetchOverview: async () => overview(),
    fetchLibrary: async () => ({ projects: ["original-goal", "other-goal"].map((id) => ({
      status: id === goal ? "CURRENT" as const : "ARCHIVED" as const,
      goal_profile: { id }, curriculum_spine: [], skills: [], evidence: [], knowledge_cards: [], archived_at: null,
    })) }),
  });
  try {
    const original = await store.create("new");
    const draft = await store.create("new-goal");
    goal = "other-goal";
    const other = await store.create("new");
    const selected = await store.activateConversation(original.sessionId);
    assert.equal(selected.state.view_mode, "CURRENT");
    assert.equal(goal, "original-goal");
    assert.equal((selected.state.overview.active_task as { id: string }).id, "original-goal-task");
    await store.activateConversation(other.sessionId);
    assert.equal(goal, "other-goal");
    const count = activations.length;
    const reopened = await store.activateConversation(draft.sessionId);
    assert.equal(reopened.state.onboarding.status, "NEEDS_CLARIFICATION");
    assert.equal(activations.length, count, "draft navigation must not activate an old Goal");
    assert.equal(await store.materialGoal(draft.sessionId, null), `draft:${draft.sessionId}`);
  } finally {
    store.dispose(); api.close(); await once(api, "close"); rmSync(directory, { recursive: true, force: true });
  }
});
