import assert from "node:assert/strict";
import {readFile, writeFile, mkdir} from "node:fs/promises";
import {resolve} from "node:path";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {buildSessionContext, SettingsManager} from "@earendil-works/pi-coding-agent";
import {fauxAssistantMessage, type Context} from "@earendil-works/pi-ai";
import {convertMessages} from "@earendil-works/pi-ai/api/openai-completions";
import {compactOverviewMessages} from "../src/modelLearningContext.js";
import {ProviderSettingsService} from "../src/web/providerSettings.js";

// 只读上下文审计：不输出正文/思考/凭据，只统计原事故分支。--probe用现有百炼模型验证默认历史思考策略。
const root = fileURLToPath(new URL("../../", import.meta.url));
const tracePath = resolve(root, "data/web-sessions/2026-10-11T06-15-19-551Z_01a12999-fafe-73e2-9496-9510b9c92964.jsonl");
const hash = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
const protectedPaths = [tracePath, resolve(root, "data/learning-state.json"), resolve(root, "data/provider-settings.json"), resolve(root, "data/provider-secrets.json")];
const beforeHashes = await Promise.all(protectedPaths.map(hash));
const entries = (await readFile(tracePath, "utf8")).trim().split(/\r?\n/).map(line => JSON.parse(line));
const publicSettings = JSON.parse(await readFile(resolve(root, "data/provider-settings.json"), "utf8"));
const active = publicSettings.profiles.find((profile: any) => profile.id === publicSettings.activeProfileId);
const compaction = SettingsManager.create(resolve(root, "pi-agent")).getCompactionSettings();
const model = {id: active.model, name: active.model, api: "openai-completions" as const, provider: active.provider,
  baseUrl: active.baseUrl, reasoning: true, input: ["text" as const], contextWindow: 128000, maxTokens: active.maxOutputTokens,
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, compat: {supportsDeveloperRole: false}};
const compat = {supportsDeveloperRole: false, requiresThinkingAsText: false, requiresReasoningContentOnAssistantMessages: false,
  requiresAssistantAfterToolResult: false, requiresToolResultName: false} as any;
const context = buildSessionContext(entries, "33e7aec8");
assert.ok(context.messages.every(message => ["user", "assistant", "toolResult"].includes(message.role)));
const llmMessages = context.messages.filter((message): message is Context["messages"][number] => message.role === "user" || message.role === "assistant" || message.role === "toolResult");
const projected = compactOverviewMessages(llmMessages);
const serialized = convertMessages(model, {messages: projected}, compat) as Array<Record<string, any>>;
const byRole: Record<string, {count: number; contentChars: number; reasoningChars: number; toolArgumentsChars: number}> = {};
for (const message of serialized) {
  const row = byRole[message.role] ??= {count: 0, contentChars: 0, reasoningChars: 0, toolArgumentsChars: 0};
  row.count++;
  row.contentChars += typeof message.content === "string" ? message.content.length : JSON.stringify(message.content ?? "").length;
  row.reasoningChars += (message.reasoning_content ?? "").length;
  row.toolArgumentsChars += (message.tool_calls ?? []).reduce((sum: number, call: any) => sum + (call.function?.arguments?.length ?? 0), 0);
}
const toolResults: Record<string, {count: number; textChars: number}> = {};
for (const message of projected) if (message.role === "toolResult") {
  const row = toolResults[message.toolName] ??= {count: 0, textChars: 0}; row.count++;
  row.textChars += message.content.filter(part => part.type === "text").reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0);
}
const badReply = entries.find(entry => entry.id === "0b4c37e9");
const previousReply = entries.find(entry => entry.id === "7926c114");
const report: Record<string, any> = {model: model.id, declaredWindow: model.contextWindow, requestedOutputLimit: model.maxTokens,
  compaction, threshold: model.contextWindow - compaction.reserveTokens, compactionEntries: entries.filter(entry => entry.type === "compaction").length,
  beforeFailureTotalTokens: previousReply.message.usage.totalTokens,
  failurePromptTokens: badReply.message.usage.input + badReply.message.usage.cacheRead,
  failureTotalTokens: badReply.message.usage.totalTokens, byRole, toolResults,
  replayedMessageCount: serialized.length, historicalThinkingMessages: serialized.filter(message => message.reasoning_content).length,
  snapshotKinds: projected.filter(message => message.role === "toolResult" && ["record_teaching_turn", "active_recall_checkpoint"].includes(message.toolName)).length};
const output = resolve(root, "data/qa/teacher-context-audit"); await mkdir(output, {recursive: true});
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--probe") || process.argv.includes("--full-probe")) {
  const service = new ProviderSettingsService({settingsPath: resolve(root, "data/provider-settings.json"), secretsPath: resolve(root, "data/provider-secrets.json")});
  const binding = await service.getActiveRuntime();
  assert.equal(binding.model.provider, "aliyun-bailian");
  assert.equal(binding.model.id, "qwen3.8-flash");
  const thought = "This is an earlier internal scratchpad about an old configuration question. It is not the current learner answer. ".repeat(128);
  report.probes = [];
  const full = process.argv.includes("--full-probe");
  const samples = full ? [{name: "original-history-default", include: true, preserve: undefined}, {name: "original-history-no-preserve", include: true, preserve: false}]
    : [{name: "no-history-thought", include: false, preserve: undefined},
      {name: "default-history-thought", include: true, preserve: undefined}, {name: "explicit-no-preserve", include: true, preserve: false}];
  for (const sample of samples) {
    const previous = {...fauxAssistantMessage([{type: "text", text: "收到。"}, ...(sample.include
      ? [{type: "thinking" as const, thinking: thought, thinkingSignature: "reasoning_content"}] : [])]),
      api: binding.model.api, provider: binding.model.provider, model: binding.model.id};
    let sentFacts: unknown;
    const probeContext: Context = full ? {messages: projected} : {messages: [
      {role: "user", content: "上一轮请只确认收到。", timestamp: 1}, previous,
      {role: "user", content: "现在请只回复OK。", timestamp: 3}]};
    const response = await binding.runtime.completeSimple(binding.model, probeContext, {
      reasoning: "low", maxTokens: 16, timeoutMs: 25_000, maxRetries: 0,
      ...(sample.preserve === undefined ? {} : {samplingParams: {preserve_thinking: sample.preserve}}),
      onPayload: payload => {const body = payload as any; sentFacts = {preserveThinking: body.preserve_thinking ?? "provider-default",
        historicalReasoningChars: body.messages.reduce((sum: number, message: any) => sum + (message.reasoning_content?.length ?? 0), 0)};},
    });
    const row = {sample: sample.name, promptTokens: response.usage.input + response.usage.cacheRead + response.usage.cacheWrite,
      outputTokens: response.usage.output, stopReason: response.stopReason, sentFacts};
    report.probes.push(row); console.log(JSON.stringify(row));
  }
}
const afterHashes = await Promise.all(protectedPaths.map(hash));
report.recordsUnchanged = beforeHashes.every((value, index) => value === afterHashes[index]);
const outputName = process.argv.includes("--full-probe") ? "full-history.json"
  : process.argv.includes("--probe") ? "report.json" : "distribution.json";
await writeFile(resolve(output, outputName), JSON.stringify(report, null, 2));
assert.ok(report.recordsUnchanged, "Original learning records and provider configuration must remain unchanged");
console.log(JSON.stringify({report: resolve(output, outputName), recordsUnchanged: true}));
