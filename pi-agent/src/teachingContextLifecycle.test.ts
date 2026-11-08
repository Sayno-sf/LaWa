import assert from "node:assert/strict";
import test from "node:test";
import {projectTeachingReasoning, projectTeachingCompaction} from "./teachingContextLifecycle.js";
import {teachingEconomicCompaction} from "./teachingCompactionBudget.js";
import {serializeConversation, type SessionBeforeCompactEvent} from "@earendil-works/pi-coding-agent";
const model = {provider: "aliyun-bailian", id: "qwen3.8-flash", contextWindow: 128000, maxTokens: 32768};

test("Go drops completed foreign-model thinking but keeps the active DeepSeek tool chain", () => {
  const messages = [
    {role: "user", content: [{type: "text", text: "旧题"}]},
    {role: "assistant", content: [{type: "thinking", thinking: "OLD_QWEN_PRIVATE"}, {type: "text", text: "当前题面"}]},
    {role: "user", content: [{type: "text", text: "实际答案"}]},
    {role: "assistant", content: [{type: "thinking", thinking: "ACTIVE_DEEPSEEK"}, {type: "toolCall", id: "c", name: "get_learning_overview", arguments: {}}]},
    {role: "toolResult", content: [{type: "text", text: "actual tool result"}]},
  ];
  const before = structuredClone(messages);
  const sent = projectTeachingReasoning({provider: "opencode-go", id: "deepseek-v4.1-flash"}, messages);
  assert.doesNotMatch(JSON.stringify(sent), /OLD_QWEN_PRIVATE/);
  assert.match(JSON.stringify(sent), /ACTIVE_DEEPSEEK|当前题面|实际答案|actual tool result/);
  assert.deepEqual(messages, before);
});

test("a new learner answer must not replay a closed teacher's private reasoning", () => {
  const messages = [
    {role: "user", content: [{type: "text", text: "旧题答案"}], timestamp: 1},
    {role: "assistant", content: [{type: "thinking", thinking: "仍需判旧题"}, {type: "text", text: "add(2, 3) 与 add(2, '3')？"}], timestamp: 2},
    {role: "user", content: [{type: "text", text: "5，23，因为字符串拼接"}], timestamp: 3},
  ];
  const sent = projectTeachingReasoning(model, messages);
  assert.equal(sent.flatMap(message => message.content).filter(part => part.type === "thinking").length, 0);
  assert.deepEqual(messages[1]!.content[0], {type: "thinking", thinking: "仍需判旧题"});
});

test("keep current tool-chain thinking, order, images and evidence/help facts; end its lifecycle only on the next user", () => {
  const messages = [
    {role: "user", content: [{type: "text", text: "答案"}, {type: "image", data: "bytes", mimeType: "image/png"}]},
    {role: "assistant", content: [{type: "thinking", thinking: "CURRENT_CHAIN"}, {type: "toolCall", id: "call", name: "record_teaching_turn", arguments: {assistance_level: "WITH_HELP"}}]},
    {role: "toolResult", toolName: "record_teaching_turn", toolCallId: "call", content: [{type: "text", text: '{"assistance_level":"WITH_HELP","question_id":"q"}'}]},
    {role: "assistant", content: [{type: "thinking", thinking: "CURRENT_CONTINUATION"}, {type: "text", text: "反馈与新题"}]},
  ];
  const before = structuredClone(messages);
  assert.deepEqual(projectTeachingReasoning(model, messages), messages);
  const next = projectTeachingReasoning(model, [...messages, {role: "user", content: [{type: "text", text: "回看旧题"}]}]);
  assert.equal(next.length, 5);
  assert.deepEqual(next[0], messages[0]);
  assert.deepEqual(next[2], messages[2]);
  assert.deepEqual(next[1]!.content, messages[1]!.content.slice(1));
  assert.deepEqual(next[3]!.content, messages[3]!.content.slice(1));
  assert.deepEqual(messages, before);
});

test("signed or unverified provider formats and contexts without user are left intact", () => {
  const messages = [{role: "assistant", content: [{type: "thinking", thinking: "PRIVATE", thinkingSignature: "signed"}]}, {role: "user", content: []}];
  for (const other of [{provider: "anthropic", id: "claude"}, {provider: "aliyun-bailian", id: "qwen3-max"},
    {provider: "aliyun-bailian", id: "qwen3.8-unverified"}, {provider: "custom", id: "qwen3.8-flash"}]) {
    assert.deepEqual(projectTeachingReasoning(other, messages), messages);
  }
  assert.deepEqual(projectTeachingReasoning(model, messages.slice(0, 1)), messages.slice(0, 1));
});

test("summary projection excludes process thinking from both prefix and split turn without changing source records", () => {
  const messages = [{role: "assistant", content: [{type: "thinking", thinking: "STALE_PRIVATE"}, {type: "text", text: "实际交付的提示"}], api: "openai-completions", provider: model.provider, model: model.id}];
  const preparation = {messagesToSummarize: messages, turnPrefixMessages: messages} as unknown as SessionBeforeCompactEvent["preparation"];
  const before = structuredClone(messages);
  projectTeachingCompaction(preparation);
  for (const sent of [preparation.messagesToSummarize, preparation.turnPrefixMessages]) {
    const serialized = serializeConversation(sent as Parameters<typeof serializeConversation>[0]);
    assert.doesNotMatch(serialized, /STALE_PRIVATE|Assistant thinking/);
    assert.match(serialized, /实际交付的提示/);
  }
  assert.deepEqual(messages, before);
});

test("128K retains output headroom while ordinary history compacts before the capacity boundary", () => {
  const configured = {enabled: true, reserveTokens: 16384, keepRecentTokens: 20000};
  const settings = teachingEconomicCompaction(model, configured);
  assert.equal(model.contextWindow - settings.reserveTokens, 87040);
  assert.equal(settings.keepRecentTokens, 24000);
  assert.ok(settings.reserveTokens >= model.maxTokens + 8192);
  assert.equal(teachingEconomicCompaction(model, {...configured, reserveTokens: 90000}).reserveTokens, 90000);
  assert.equal(model.contextWindow, 128000);
});
