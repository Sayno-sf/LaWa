import assert from "node:assert/strict";
import test from "node:test";
import {SessionManager} from "@earendil-works/pi-coding-agent";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {MaterialReadingClient} from "../materialReading.js";
import {AdaptiveSourceContext} from "../retrieval/sourceContext.js";
import {PlanningReadingInput, planningInputReference, PLANNING_SOURCE_MARKER} from "./planningReadingInput.js";
import {planningHash} from "./planningReading.js";
import type {GoalOnboardingSnapshot} from "./goalOnboarding.js";
import {TeachingSessionContext} from "../teachingSession.js";
import {PlanningSourceReviewContext, presentPlanningSourceClarification} from "./planningSourceReview.js";

test("planning input is attached to a real user copy, survives source rereads and compaction, and adds no learner or tool entry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lawa-planning-input-"));
  try {
    const manager = SessionManager.create(dir, dir);
    const origin = manager.appendMessage({role: "user", content: "按这份教材学。", timestamp: 100});
    manager.appendMessage({role: "user", content: "确认", timestamp: 200});
    const profile = {id: "goal-lab", goal_description: "学习校准", desired_outcome: "可读懂流程", background_summary: "初学者",
      prior_knowledge_claims: [], learning_preferences: [], time_constraint: ""};
    const ref = {id: "a".repeat(64), session_id: manager.getSessionId(), user_entry_id: origin, profile_hash: planningHash(profile),
      materials: [{id: "mat-" + "b".repeat(32), name: "教材.md"}]};
    const snapshot: GoalOnboardingSnapshot = {status: "CONFIRMED", pending_profile: profile, reading_requirement: ref, missing_information: [], replace_existing: false};
    manager.appendMessage({role: "toolResult", toolCallId: "confirmed", toolName: "record_goal_understanding", isError: false,
      content: [{type: "text", text: JSON.stringify(snapshot)}], timestamp: 201});
    let calls = 0, deleted = false, incomplete = false;
    const client = new MaterialReadingClient("http://fixture.invalid", async (_url, init) => {
      calls++;
      assert.ok(JSON.parse(String(init?.body)).max_tokens > 1000);
      return deleted ? Response.json({code: "MATERIAL_NOT_FOUND"}, {status: 404}) : Response.json({version: 1, request_id: ref.id,
        goal_profile_hash: ref.profile_hash, sources: incomplete ? [] : [{source: {material_id: ref.materials[0]!.id},
          synthesis: {sufficient: true, summary: "先零参考，再校准。q=3v+4。", dependencies: ["比较依赖校准"]}, native_text: "SOURCE_ORIGINAL"}]});
    });
    const input = new PlanningReadingInput(client), budget = new AdaptiveSourceContext();
    const messages = [{role: "user", timestamp: 100, content: "按这份教材学。"},
      {role: "user", timestamp: 200, content: [{type: "text", text: "确认"}, {type: "text", text: "[本轮问答引用]"}]}];
    const raw = JSON.stringify(messages), count = manager.getBranch().length;
    const prepare = async (current = messages) => {
      const copy = await budget.prepare({contextWindow: 128_000, maxTokens: 8192}, {messages: current});
      return input.project(copy, manager, ref, "draft:" + ref.session_id, budget);
    };
    const projected = await prepare();
    assert.ok(JSON.stringify(projected[0]).includes(PLANNING_SOURCE_MARKER));
    assert.equal(projected.length, messages.length); assert.equal(JSON.stringify(messages), raw);
    assert.ok(input.allows(ref)); assert.equal(manager.getBranch().length, count);
    const compacted = await prepare(messages.slice(1));
    assert.ok(JSON.stringify(compacted[0]).includes("SOURCE_ORIGINAL"), "when origin was compacted, attach reference to the exact genuine latest user");
    const idle = {...snapshot, status: "IDLE" as const, pending_profile: null, reading_requirement: undefined};
    assert.deepEqual(planningInputReference(manager, idle, profile), ref);
    assert.deepEqual(planningInputReference(manager, idle, {...profile, created_at: "kernel-generated"}), ref);
    assert.equal(planningInputReference(manager, idle, {...profile, id: "other-goal"}), undefined);
    incomplete = true;
    await assert.rejects(prepare(), /PLANNING_CONTEXT_INVALID/);
    assert.equal(input.allows(ref), false, "an old successful delivery cannot authorize a later failed request");
    incomplete = false; deleted = true;
    await assert.rejects(prepare(), /MATERIAL_NOT_FOUND/);
    assert.equal(input.allows(ref), false); assert.equal(calls, 4);
  } finally {rmSync(dir, {recursive: true, force: true});}
});

test("multi-source planning creates the clarification component from the independent review", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lawa-planning-review-input-"));
  try {
    const manager = SessionManager.create(dir, dir);
    const origin = manager.appendMessage({role: "user", content: "按两份政策安排。", timestamp: 100});
    manager.appendMessage({role: "user", content: "确认", timestamp: 200});
    const profile = {id: "goal-policy", goal_description: "审查请求", desired_outcome: "判断政策",
      background_summary: "初学者", prior_knowledge_claims: [], learning_preferences: [], time_constraint: ""};
    const ref = {id: "d".repeat(64), session_id: manager.getSessionId(), user_entry_id: origin, profile_hash: planningHash(profile),
      materials: [{id: "mat-" + "e".repeat(32), name: "旧政策.md"}, {id: "mat-" + "f".repeat(32), name: "新政策.md"}]};
    const snapshot: GoalOnboardingSnapshot = {status: "CONFIRMED", pending_profile: profile, reading_requirement: ref,
      missing_information: [], replace_existing: false};
    manager.appendMessage({role: "toolResult", toolCallId: "confirmed", toolName: "record_goal_understanding", isError: false,
      content: [{type: "text", text: JSON.stringify(snapshot)}], timestamp: 201});
    const sources = [
      {source: {material_id: ref.materials[0]!.id}, synthesis: {sufficient: true, summary: "旧政策：2026-10-01 前，7天，ALPHA"}},
      {source: {material_id: ref.materials[1]!.id}, synthesis: {sufficient: true, summary: "新政策：2026-10-01 及以后，12天，BETA"}},
    ];
    const client = new MaterialReadingClient("http://fixture.invalid", async () => Response.json({version: 1,
      request_id: ref.id, goal_profile_hash: ref.profile_hash, sources}));
    const teaching = new TeachingSessionContext(); teaching.bindSession(manager.getSessionId()); teaching.beginAgentTurn();
    const review = new PlanningSourceReviewContext();
    let reviewCalls = 0;
    const request = {
      status: "NEEDS_CLARIFICATION" as const,
      summary: "适用范围取决于请求创建日期。",
      conflicts: ["旧政策是7天/ALPHA；新政策是12天/BETA。"],
      question: {prompt: "目标请求按哪个日期范围适用？", options: [
        {id: "before", label: "2026-10-01 之前"},
        {id: "after", label: "2026-10-01 及之后"},
      ]},
    };
    const input = new PlanningReadingInput(client, review, async () => {reviewCalls++; return request;},
      decision => {presentPlanningSourceClarification(teaching, decision);});
    const budget = new AdaptiveSourceContext();
    const messages = [{role: "user", timestamp: 100, content: "按两份政策安排。"},
      {role: "user", timestamp: 200, content: "确认"}];
    const prepare = async () => {
      const copy = await budget.prepare({contextWindow: 128_000, maxTokens: 8192}, {messages});
      return input.project(copy, manager, ref, "draft:" + ref.session_id, budget);
    };
    await prepare();
    assert.equal(reviewCalls, 1);
    assert.equal(teaching.learnerQuestions.snapshot().pending?.purpose, "BACKGROUND");
    assert.match(teaching.learnerQuestions.snapshot().pending?.questions[0]?.prompt ?? "", /日期范围/);
    await prepare();
    assert.equal(reviewCalls, 1, "the independent review is reused within one planning turn");
  } finally {rmSync(dir, {recursive: true, force: true});}
});
