import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import type {Api, Model} from "@earendil-works/pi-ai";
import {streamSimple} from "@earendil-works/pi-ai/api/openai-completions";
import {decodePdfBatch, loadPdfBatch, pdfPayloadHook, pdfReference, signPdfReference, supportsNativePdf, verifyPdfReference, type PdfBatch} from "./documentInput.js";

const data = Buffer.from("%PDF-1.7\nBOUNDED_DOCUMENT_CANARY\n%%EOF");
const batch: PdfBatch = {material_id: "mat-" + "a".repeat(32), scope: "goal-one", source_hash: "b".repeat(64), purpose_revision: 0,
  start: 3, end: 4, total_units: 18, content_hash: createHash("sha256").update(data).digest("hex"), size_bytes: data.length,
  mime: "application/pdf", data: data.toString("base64"), name: "原件.pdf", citation: "原件.pdf，第3-4页"};
const model: Model<"openai-completions"> = {id: "qwen3.8-flash", name: "isolated", provider: "bailian", api: "openai-completions",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", reasoning: false, input: ["text", "image"],
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 1_000_000, maxTokens: 8192};

test("native PDF capability is specific to verified API, model and region", () => {
  assert.equal(supportsNativePdf(model), true);
  for (const change of [{id: "qwen3.8-unverified"}, {api: "openai-responses"}, {baseUrl: "https://other.example/v1"},
    {baseUrl: "https://dashscope.aliyuncs.com.evil.example/compatible-mode/v1"},
    {id: "qwen3.8-27b", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"}]) {
    assert.equal(supportsNativePdf({...model, ...change} as Model<Api>), false);
  }
});

test("PDF identity checks content, bounds and account-bound signatures", () => {
  assert.deepEqual(decodePdfBatch(batch.data, pdfReference(batch)), data);
  assert.throws(() => decodePdfBatch(Buffer.from("%PDF-another").toString("base64"), batch), /不一致/);
  assert.throws(() => pdfReference({...batch, end: 19}), /范围/);
  assert.throws(() => pdfReference({...batch, material_id: "../another-account"}), /身份/);
  const signature = signPdfReference(batch, "instance-one");
  assert.equal(verifyPdfReference(batch, signature, "instance-one"), true);
  assert.equal(verifyPdfReference({...batch, start: 2}, signature, "instance-one"), false);
  assert.equal(verifyPdfReference(batch, signature, "instance-two"), false);
});

test("PDF loader binds controlled source and exact original page range", async () => {
  let url = "";
  const result = await loadPdfBatch(batch.material_id, batch.scope, 3, 4, "http://kernel.test", undefined,
    async input => {url = String(input); return Response.json(batch);});
  assert.equal(new URL(url).searchParams.get("expected_goal_id"), "goal-one");
  assert.equal(result.content_hash, batch.content_hash);
  await assert.rejects(loadPdfBatch(batch.material_id, batch.scope, 3, 4, "http://kernel.test", undefined,
    async () => Response.json({...batch, scope: "another-goal"})), /归属/);
});

test("payload hook composes previous replacement and does not mutate durable context", async () => {
  const payload = {messages: [{role: "user", content: "read source"}], stream: true};
  const before = JSON.stringify(payload);
  const hook = pdfPayloadHook(batch, p => ({...(p as object), temperature: 0.2}));
  const projected = await hook(payload, model) as any;
  assert.equal(projected.temperature, 0.2);
  assert.equal(projected.include_tool_usage, true);
  assert.equal(projected.messages[0].content.at(-1).type, "file");
  assert.ok(!JSON.stringify(projected).includes("undefined;base64"));
  assert.equal(JSON.stringify(payload), before);
  const trial = await pdfPayloadHook(batch, undefined, "instance-one")(payload, {...model, provider: "lawa-trial"}) as any;
  assert.equal(verifyPdfReference(trial.lawa_document_refs[0], trial.lawa_document_refs[0].signature, "instance-one"), true);
  await assert.rejects(async () => {await pdfPayloadHook(batch)(payload, {...model, provider: "lawa-trial"});}, /身份/);
});

test("real Pi SDK emits native file via onPayload, preserving stream and token usage", async () => {
  let sent: any;
  const context = {messages: [{role: "user" as const, content: "请读取原件第3-4页", timestamp: 1}]};
  const before = JSON.stringify(context);
  const body = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
  const events = body({id: "isolated", object: "chat.completion.chunk", choices: [{index: 0, delta: {role: "assistant", content: "原件已交付"}, finish_reason: null}]})
    + body({id: "isolated", object: "chat.completion.chunk", choices: [{index: 0, delta: {}, finish_reason: "stop"}], usage: {prompt_tokens: 123, completion_tokens: 4, total_tokens: 127}})
    + "data: [DONE]\n\n";
  const stream = streamSimple(model, context, {apiKey: "isolated-not-a-secret", onPayload: pdfPayloadHook(batch),
    fetch: async (input, init) => {
      sent = await new Request(input, init).json();
      return new Response(events, {headers: {"Content-Type": "text/event-stream"}});
    }});
  const result = await stream.result();
  assert.equal(result.stopReason, "stop");
  assert.equal(result.usage.input, 123);
  assert.equal(sent.messages.at(-1).content.at(-1).file.file_data, `data:application/pdf;base64,${batch.data}`);
  assert.equal(JSON.stringify(context), before);
});
