import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fauxAssistantMessage, fauxToolCall} from "@earendil-works/pi-ai";
import {ConversationCatalog} from "./conversationCatalog.js";
import {WebSessionStore} from "./sessionStore.js";
import {LEARNER_QUESTIONS_ENTRY, goalConfirmationSignature} from "../learnerQuestions.js";
import type {LearningOverview} from "../learningOverviewTool.js";

const profile = {id: "goal-decimal", goal_description: "小数写成百分数", desired_outcome: "解释35%", background_summary: "会乘法",
  learning_preferences: [], prior_knowledge_claims: [], time_constraint: ""};
const overview: LearningOverview = {current_goal: "旧目标", goal_profile: {id: "old"}, curriculum_spine: [], skills: [],
  recent_evidence: [], active_task: null, current_frontier: null, current_focus: null, learning_history: [], current_goal_skill_ids: []};

for (const variant of [{status: "READY_FOR_CONFIRMATION", stale: false}, {status: "CONFIRMED", stale: false}, {status: "READY_FOR_CONFIRMATION", stale: true}] as const) {
  const {status, stale} = variant;
  test(`restart preserves the ${status} draft (stale=${stale}) but never restores human confirmation authority`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "lawa-goal-draft-restore-"));
    const manager = new ConversationCatalog(dir).create();
    manager.appendCustomEntry("lawa.goal-onboarding-started", {replaceExisting: true});
    manager.appendMessage({role: "user", content: "建立百分数目标", timestamp: Date.now()});
    const callId = "draft-record";
    manager.appendMessage(fauxAssistantMessage(fauxToolCall("record_goal_understanding", {outcome: status,
      ...(status === "READY_FOR_CONFIRMATION" ? {profile} : {})}, {id: callId}), {stopReason: "toolUse"}));
    manager.appendMessage({role: "toolResult", toolName: "record_goal_understanding", toolCallId: callId, content: [{type: "text",
      text: JSON.stringify({status, pending_profile: profile, missing_information: [], replace_existing: true})}], isError: false, timestamp: Date.now()});
    const request = {id: "old-confirm-card", purpose: "CONFIRM_GOAL", session_id: manager.getSessionId(), goal_id: profile.id,
      task_id: null, skill_id: null, scope_signature: goalConfirmationSignature(stale ? {...profile, desired_outcome: "已过期旧内容"} : profile), questions: [{id: "confirm-goal", prompt: "符合想法吗？",
        selection: "single", options: [{id: "proceed", label: "确认"}]}]};
    manager.appendCustomEntry(LEARNER_QUESTIONS_ENTRY, {pending: status === "READY_FOR_CONFIRMATION" ? request : null,
      last_answer: status === "CONFIRMED" ? {request, text: "确认", used_choices: true, choices_exposed: false,
        reply: {request_id: request.id, answers: [{question_id: "confirm-goal", selected_option_ids: ["proceed"], other_text: ""}]}} : null});
    const store = new WebSessionStore({conversationDir: dir, fetchOverview: async () => overview, fetchLibrary: async () => ({projects: []})});
    try {
      const session = await store.create("resume-recent");
      assert.equal(session.state.onboarding.status, "READY_FOR_CONFIRMATION");
      assert.deepEqual(session.state.onboarding.pending_profile, profile);
      const card = session.state.teaching.learner_questions?.pending;
      assert.equal(card?.purpose, "CONFIRM_GOAL", "a valid recovery action must be visible, not a dead old card");
      assert.equal(card?.scope_signature, goalConfirmationSignature(profile));
      if (status === "CONFIRMED" || stale) assert.notEqual(card?.id, request.id, "consumed or stale confirmation is never reused as new consent");
      assert.equal(session.state.overview.goal_profile && (session.state.overview.goal_profile as any).id, "old");
      assert.equal(session.state.overview.recent_evidence.length, 0);
    } finally {store.dispose(); rmSync(dir, {recursive: true, force: true});}
  });
}
