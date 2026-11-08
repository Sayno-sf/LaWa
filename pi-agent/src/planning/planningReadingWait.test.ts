import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {SessionManager} from "@earendil-works/pi-coding-agent";
import {fauxAssistantMessage, fauxToolCall} from "@earendil-works/pi-ai";
import {capturePlanningWait, latestPlanningWait, provePlanningWait, transitionPlanningWait, projectPlanningMachineMessages,
  PLANNING_READY_MESSAGE, PLANNING_RESUME_CORRECTION} from "./planningReadingWait.js";
import {planningHash} from "./planningReading.js";
import {GoalOnboardingContext, type GoalOnboardingSnapshot} from "./goalOnboarding.js";
import type {LearningOverview} from "../learningOverviewTool.js";

const overview = {current_goal: null, goal_profile: null, curriculum_spine: [], current_frontier: null, current_focus: null,
  skills: [], recent_evidence: [], active_task: null, learning_history: [], current_goal_skill_ids: []} as LearningOverview;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lawa-planning-wait-"));
  const manager = SessionManager.create(root, root);
  const origin = manager.appendMessage({role: "user", content: "按我上传的教材安排学习。", timestamp: Date.now()});
  const profile = {id: "goal-lab", goal_description: "学习校准", background_summary: "初学者", desired_outcome: "能读懂流程",
    learning_preferences: [], time_constraint: "", prior_knowledge_claims: []};
  const snapshot: GoalOnboardingSnapshot = {status: "CONFIRMED", pending_profile: profile, missing_information: [], replace_existing: false,
    reading_requirement: {id: "a".repeat(64), session_id: manager.getSessionId(), user_entry_id: origin,
      profile_hash: planningHash(profile), materials: [{id: "mat-" + "b".repeat(32), name: "主教材.md"}]}};
  manager.appendMessage(fauxAssistantMessage("请确认目标。"));
  const confirmation = manager.appendMessage({role: "user", content: "确认", timestamp: Date.now()});
  manager.appendMessage(fauxAssistantMessage(fauxToolCall("record_goal_understanding", {outcome: "CONFIRMED"}), {stopReason: "toolUse"}));
  manager.appendMessage({role: "toolResult", toolCallId: "confirmed", toolName: "record_goal_understanding", content: [{type: "text", text: JSON.stringify(snapshot)}],
    isError: false, timestamp: Date.now()});
  manager.appendMessage(fauxAssistantMessage("正在阅读资料，读完继续规划。"));
  return {root, manager, snapshot, confirmation};
}

test("confirmed planning wait persists in its exact Pi branch and restores consent without a new user", () => {
  const f = fixture();
  try {
    const before = f.manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user").length;
    const saved = capturePlanningWait(f.manager, f.snapshot, overview)!;
    assert.equal(saved.data.state, "WAITING"); assert.equal(saved.data.confirmationUserId, f.confirmation);
    const reopened = SessionManager.open(f.manager.getSessionFile()!, f.root, f.root);
    const actual = latestPlanningWait(reopened)!;
    assert.ok(provePlanningWait(reopened, actual)); assert.deepEqual(actual.data.snapshot, f.snapshot);
    const planning = new GoalOnboardingContext(); planning.start(); planning.restoreReadingWait(actual.data.snapshot);
    assert.equal(planning.snapshot().status, "CONFIRMED");
    assert.equal(reopened.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user").length, before);
    const running = transitionPlanningWait(reopened, actual, "RUNNING");
    assert.ok(provePlanningWait(reopened, running));
    assert.throws(() => transitionPlanningWait(reopened, actual, "COMPLETED"), /CHANGED/);
    assert.equal(transitionPlanningWait(reopened, running, "CANCELED", "USER_STOP").data.state, "CANCELED");
  } finally {rmSync(f.root, {recursive: true, force: true});}
});

test("a shared ancestor or a new human turn cannot authorize the old planning completion", () => {
  const f = fixture();
  try {
    const saved = capturePlanningWait(f.manager, f.snapshot, overview)!;
    f.manager.appendCustomEntry("lawa.goal-onboarding-started", {replaceExisting: false});
    assert.equal(provePlanningWait(f.manager, saved), false, "a new explicit onboarding cycle revokes the old automatic continuation");
    f.manager.branch(saved.data.source.leafId);
    f.manager.appendMessage({role: "user", content: "另一个分支的不同问题。", timestamp: Date.now()});
    assert.equal(latestPlanningWait(f.manager), null);
    f.manager.branch(saved.initialEntryId);
    f.manager.appendMessage({role: "user", content: "改变目标。", timestamp: Date.now()});
    assert.equal(provePlanningWait(f.manager, saved), false);
    f.manager.branch(saved.initialEntryId); f.manager.appendCustomEntry("test-first-child", {});
    f.manager.branch(saved.initialEntryId); f.manager.appendCustomEntry("test-second-child", {});
    assert.equal(provePlanningWait(f.manager, saved), false, "ambiguous descendants are deferred even when only metadata differs");
  } finally {rmSync(f.root, {recursive: true, force: true});}
});

test("resource role, an unconfirmed snapshot or a different confirmed profile cannot create a waiter", () => {
  const f = fixture();
  try {
    assert.equal(capturePlanningWait(f.manager, {...f.snapshot, status: "READY_FOR_CONFIRMATION"}, overview), null);
    assert.equal(capturePlanningWait(f.manager, {...f.snapshot, pending_profile: {...f.snapshot.pending_profile!, desired_outcome: "另一个用途"}}, overview), null);
    assert.equal(latestPlanningWait(f.manager), null);
  } finally {rmSync(f.root, {recursive: true, force: true});}
});

test("only real custom-message projections are removed; a learner copying the marker remains a learner", () => {
  const machine = {role: "custom", customType: PLANNING_READY_MESSAGE, content: "MachinePlanningReady:owned", timestamp: 1};
  const correction = {role: "custom", customType: PLANNING_RESUME_CORRECTION,
    content: "MachinePlanningResumeCorrection:owned", timestamp: 2};
  const user = {role: "user", content: "MachinePlanningReady:owned", timestamp: 2};
  const correctionProjection = {role: "user", content: [{type: "text", text: correction.content}], timestamp: 2};
  const projected = [{role: "user", content: [{type: "text", text: machine.content}], timestamp: 1},
    correctionProjection, user];
  assert.deepEqual(projectPlanningMachineMessages(projected, [machine, user]), [correctionProjection, user]);
  assert.deepEqual(projectPlanningMachineMessages([user], [user]), [user]);
  assert.deepEqual(projectPlanningMachineMessages(projected, [machine, correction, user]), [user]);
  assert.throws(() => projectPlanningMachineMessages(projected, [machine, {...user, timestamp: 1}]), /AMBIGUOUS/);
});

test("an uncertain metadata write cannot authorize continuation from its in-memory entry", () => {
  const f = fixture();
  try {
    const append = f.manager.appendCustomEntry.bind(f.manager);
    f.manager.appendCustomEntry = (type, data) => {append(type, data); throw new Error("synthetic write acknowledgement failure");};
    assert.throws(() => capturePlanningWait(f.manager, f.snapshot, overview), /NOT_SAVED/);
    assert.throws(() => latestPlanningWait(f.manager), /STORAGE_INVALID/);
  } finally {rmSync(f.root, {recursive: true, force: true});}
});
