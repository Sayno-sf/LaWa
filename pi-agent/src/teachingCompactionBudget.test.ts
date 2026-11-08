import assert from "node:assert/strict";
import test from "node:test";
import {buildSessionContext, SessionManager, shouldCompact, type SessionBeforeCompactEvent, type SessionEntry} from "@earendil-works/pi-coding-agent";
import type {AssistantMessage, UserMessage, ToolResultMessage} from "@earendil-works/pi-ai";
import {protectTeachingCompaction, teachingEconomicCompaction} from "./teachingCompactionBudget.js";

const configured = {enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000};
const model = {contextWindow: 1_000_000, maxTokens: 32_768};
const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
const user = (text: string): UserMessage => ({role: "user", content: [{type: "text", text}], timestamp: 1});
const assistant = (text: string, call?: string): AssistantMessage => ({role: "assistant",
  content: [{type: "text", text}, ...(call ? [{type: "toolCall" as const, id: call, name: "record_teaching_turn", arguments: {answer: "actual"}}] : [])],
  api: "openai-completions", provider: "opencode-go", model: "deepseek-v4.1-flash", usage, stopReason: call ? "toolUse" : "stop", timestamp: 2});
const result = (call: string): ToolResultMessage => ({role: "toolResult", toolCallId: call, toolName: "record_teaching_turn",
  content: [{type: "text", text: "Kernel accepted actual answer"}], isError: false, timestamp: 3});

function event(entries: SessionEntry[], firstKeptEntryId: string, reason: SessionBeforeCompactEvent["reason"] = "threshold"): SessionBeforeCompactEvent {
  return {type: "session_before_compact", branchEntries: entries, reason, willRetry: false, signal: new AbortController().signal,
    preparation: {firstKeptEntryId, messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: true,
      tokensBefore: 100_000, settings: configured, fileOps: {read: new Set(), written: new Set(), edited: new Set()}}};
}

test("one-million capacity uses the approved 128K working threshold and 24K recent retention", () => {
  const settings = teachingEconomicCompaction(model, configured);
  assert.equal(model.contextWindow - settings.reserveTokens, 128_000);
  assert.equal(settings.keepRecentTokens, 24_000);
  assert.equal(shouldCompact(70_000, model.contextWindow, settings), false);
  assert.equal(shouldCompact(128_000, model.contextWindow, settings), false);
  assert.equal(shouldCompact(128_001, model.contextWindow, settings), true);
  assert.deepEqual(configured, {enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000});
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(teachingEconomicCompaction(model, {...configured, enabled: false}).enabled, false);
  assert.equal(teachingEconomicCompaction(model, {...configured, keepRecentTokens: 6000}).keepRecentTokens, 24_000);
  const small = {contextWindow: 4096, maxTokens: 1024};
  const smallSettings = teachingEconomicCompaction(small, configured);
  assert.ok(smallSettings.reserveTokens < small.contextWindow);
  assert.ok(smallSettings.keepRecentTokens <= small.contextWindow - smallSettings.reserveTokens);
});

test("protected recent question, actual answer and complete live tool chain survive a native split cut", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage(user("Old completed exercise " + "history ".repeat(1500)));
  manager.appendMessage(assistant("Old exercise feedback"));
  const previousUser = manager.appendMessage(user("请出下一道题"));
  manager.appendMessage(assistant("CURRENT QUESTION: explain bind default argument"));
  manager.appendMessage(user("REAL ANSWER: undefined uses the default"));
  const cut = manager.appendMessage(assistant("Persist this real answer", "live-call"));
  manager.appendMessage(result("live-call"));
  const entries = manager.getBranch();
  const source = structuredClone(entries);
  const prepared = event(entries, cut);
  assert.equal(protectTeachingCompaction(prepared), true);
  assert.equal(prepared.preparation.firstKeptEntryId, previousUser);
  assert.equal(prepared.preparation.isSplitTurn, false);
  assert.deepEqual(prepared.preparation.turnPrefixMessages, []);
  assert.equal(prepared.preparation.settings.reserveTokens, 4096);
  assert.equal(configured.reserveTokens, 16_384);
  const summaryInput = JSON.stringify(prepared.preparation.messagesToSummarize);
  assert.match(summaryInput, /Old completed exercise/);
  assert.doesNotMatch(summaryInput, /CURRENT QUESTION|REAL ANSWER|live-call/);
  manager.appendCompaction("Older completed exercise summary", prepared.preparation.firstKeptEntryId, prepared.preparation.tokensBefore);
  const kept = buildSessionContext(manager.getBranch()).messages;
  assert.match(JSON.stringify(kept), /CURRENT QUESTION|REAL ANSWER/);
  const callAt = kept.findIndex(message => message.role === "assistant" && message.content.some(part => part.type === "toolCall" && part.id === "live-call"));
  assert.ok(callAt >= 0);
  assert.equal(kept[callAt + 1]?.role, "toolResult");
  assert.deepEqual(entries, source);
});

test("already summarized history never re-enters summary input; injected custom messages are not real learner turns", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage(user("ARCHIVED_DO_NOT_REVIVE"));
  const first = manager.appendMessage(user("Recent but closed " + "history ".repeat(1500)));
  manager.appendMessage(assistant("Recent feedback"));
  manager.appendCompaction("previous checkpoint", first, 100_000);
  const protectedUser = manager.appendMessage(user("Please ask a question"));
  manager.appendMessage(assistant("CURRENT QUESTION"));
  manager.appendCustomMessageEntry("state", [{type: "text", text: "injected state"}], false);
  manager.appendMessage(user("ACTUAL ANSWER"));
  const cut = manager.appendMessage(assistant("Record answer", "c"));
  manager.appendMessage(result("c"));
  const prepared = event(manager.getBranch(), cut);
  prepared.preparation.previousSummary = "previous checkpoint";
  assert.equal(protectTeachingCompaction(prepared), true);
  assert.equal(prepared.preparation.firstKeptEntryId, protectedUser);
  const summaryInput = JSON.stringify(prepared.preparation.messagesToSummarize);
  assert.doesNotMatch(summaryInput, /ARCHIVED_DO_NOT_REVIVE|CURRENT QUESTION|ACTUAL ANSWER|injected state/);
  assert.match(summaryInput, /Recent but closed/);
  assert.equal(prepared.preparation.previousSummary, "previous checkpoint");
});

test("a large current document or protected question alone must not buy a useless summary on every continuation", () => {
  const manager = SessionManager.inMemory();
  const first = manager.appendMessage(user("Attached document " + "large original content ".repeat(15_000)));
  manager.appendMessage(assistant("Current document question"));
  manager.appendMessage(user("actual answer"));
  const cut = manager.appendMessage(assistant("Save answer", "c"));
  manager.appendMessage(result("c"));
  const prepared = event(manager.getBranch(), cut);
  assert.equal(protectTeachingCompaction(prepared), false);
  assert.equal(prepared.preparation.firstKeptEntryId, first);
  assert.deepEqual(prepared.preparation.messagesToSummarize, []);
});

test("threshold compaction skips tiny new history even when its closed private thinking was huge", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage(user("old question"));
  manager.appendMessage({...assistant("short visible feedback"), content: [{type: "thinking", thinking: "private ".repeat(20_000)}, {type: "text", text: "short visible feedback"}]});
  manager.appendMessage(user("protected question request"));
  manager.appendMessage(assistant("CURRENT QUESTION"));
  manager.appendMessage(user("REAL ANSWER"));
  const cut = manager.appendMessage(assistant("Save answer", "c"));
  manager.appendMessage(result("c"));
  const entries = manager.getBranch();
  assert.equal(protectTeachingCompaction(event(entries, cut)), false);
  assert.equal(protectTeachingCompaction(event(entries, cut, "manual")), true);
  assert.equal(protectTeachingCompaction(event(entries, cut, "overflow")), true);
});
