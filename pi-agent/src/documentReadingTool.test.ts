import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createServer} from "node:http";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {ModelRuntime, SessionManager} from "@earendil-works/pi-coding-agent";
import type {Model} from "@earendil-works/pi-ai";
import {streamSimple} from "@earendil-works/pi-ai/api/openai-completions";
import {DocumentTurnInput} from "./documentReadingTool.js";
import {createLearningAgentSession} from "./agentSession.js";
import {TeachingSessionContext} from "./teachingSession.js";
import {GoalOnboardingContext} from "./planning/goalOnboarding.js";
import type {PdfBatch} from "./documentInput.js";

const bytes = Buffer.from("%PDF-1.7\nORIGINAL_DOCUMENT_BYTES_CANARY\n%%EOF");
const packet: PdfBatch = {material_id: "mat-" + "a".repeat(32), scope: "goal", source_hash: "b".repeat(64), purpose_revision: 0,
  start: 3, end: 4, total_units: 18, content_hash: createHash("sha256").update(bytes).digest("hex"), size_bytes: bytes.length,
  mime: "application/pdf", data: bytes.toString("base64"), name: "原件.pdf", citation: "原件.pdf，第3-4页"};
const model: Model<"openai-completions"> = {id: "qwen3.8-flash", name: "mock", provider: "bailian", api: "openai-completions",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", reasoning: false, input: ["text", "image"],
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 1_000_000, maxTokens: 8192};
const meta = {goal_id: "goal", sha256: packet.source_hash, purpose_revision: 0, format: "pdf"};

test("PDF batches cannot be replaced before delivery, replayed to another user or sent after deletion/reset", async () => {
  let deleted = false;
  const input = new DocumentTurnInput({baseUrl: "http://kernel.test", model: () => model, draft: () => null, sessionId: () => "one",
    fetcher: async url => String(url).includes("document-batch") ? Response.json(packet) : deleted ? new Response("", {status: 404}) : Response.json(meta)});
  input.reset();
  const messages = [{role: "user" as const, content: "read", timestamp: 1}];
  await input.requestOptions(model, messages);
  await input.read(packet.material_id, 3, 4);
  await assert.rejects(input.read(packet.material_id, 3, 4), /尚未交付/);
  await assert.rejects(input.requestOptions(model, [{role: "user", content: "branch changed before first delivery", timestamp: 2}]), /消息已变化/);
  const options = await input.requestOptions(model, messages);
  assert.ok(options?.onPayload);
  await options.onPayload({messages}, model);
  await assert.rejects(input.requestOptions(model, [{role: "user", content: "different", timestamp: 2}]), /消息已变化/);
  await input.read(packet.material_id, 3, 4);
  deleted = true;
  await assert.rejects(async () => {await options.onPayload!({messages}, model);}, /不存在/);
  deleted = false; input.reset();
  await assert.rejects(async () => {await options.onPayload!({messages}, model);}, /回合已变化/);
  assert.equal(input.tokenReserve, 0);
});

test("production Pi loop and actual SDK deliver PDF across tools without persisting/replaying binary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-pdf-pi-"));
  const overview = {current_goal: "阅读", goal_profile: {id: "goal"}, curriculum_spine: [], current_frontier: null, current_focus: null,
    skills: [], recent_evidence: [], active_task: null, learning_history: [], current_goal_skill_ids: []};
  const kernel = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url?.includes("document-batch") ? packet : req.url?.includes("/metadata") ? meta : overview));
  });
  await new Promise<void>(done => kernel.listen(0, "127.0.0.1", done));
  const address = kernel.address(); assert.ok(address && typeof address !== "string");
  const runtime = await ModelRuntime.create({authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models.json"), allowModelNetwork: false, refreshOnCreate: false});
  runtime.hasConfiguredAuth = () => true;
  runtime.getAuth = async () => ({auth: {apiKey: "isolated-only"}, env: {}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  const requests: any[] = [];
  runtime.streamSimple = (selected, context, options) => streamSimple(selected as Model<"openai-completions">, context, {...options,
    apiKey: "isolated-only", fetch: async (url, init) => {
      const sent = await new Request(url, init).json() as any; requests.push(sent);
      const index = requests.length;
      const tool = index === 1 ? {id: "read-doc", name: "read_learning_document", args: {material_id: packet.material_id, start: 3, end: 4}}
        : index === 2 ? {id: "overview", name: "get_learning_overview", args: {}} : context.tools?.some(t => t.name === "begin_teacher_reply") ? {id: "begin", name: "begin_teacher_reply", args: {}} : null;
      const delta = tool ? {role: "assistant", tool_calls: [{index: 0, id: tool.id, type: "function", function: {name: tool.name, arguments: JSON.stringify(tool.args)}}]}
        : {role: "assistant", content: index === 3 ? "收到原件第3-4页。" : "继续下一题。"};
      const event = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
      return new Response(event({id: "mock", choices: [{index: 0, delta, finish_reason: null}]})
        + event({id: "mock", choices: [{index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop"}], usage: {prompt_tokens: 100, completion_tokens: 10}})
        + "data: [DONE]\n\n", {headers: {"Content-Type": "text/event-stream"}});
    }});
  const manager = SessionManager.create(directory, directory);
  let agent: Awaited<ReturnType<typeof createLearningAgentSession>> | undefined;
  try {
    agent = await createLearningAgentSession(new TeachingSessionContext(), new GoalOnboardingContext(), {
      apiBaseUrl: `http://127.0.0.1:${address.port}`, model, modelRuntime: runtime, sessionManager: manager,
      retrieval: false, assistantSupport: false, surface: "WEB", log: () => undefined,
    });
    assert.equal((await agent.prompt("请直接看原件的第3-4页"))?.status, "completed");
    assert.equal(requests.length, 4);
    assert.ok(!JSON.stringify(requests[0]).includes(packet.data));
    for (const request of requests.slice(1)) {
      const user = request.messages.findLast((m: any) => m.role === "user");
      assert.equal(user.content.at(-1).file.file_data, `data:application/pdf;base64,${packet.data}`);
      assert.ok(JSON.stringify(request).includes("original_pdf"), "native PDF delivery must appear in the verified input source summary");
    }
    const originalHistory = readFileSync(manager.getSessionFile()!, "utf8");
    assert.ok(!originalHistory.includes(packet.data));
    assert.ok(!originalHistory.includes("native_pdf_attached"), "delivery projection must not rewrite original Pi tool records");
    assert.equal((await agent.prompt("接着做下一题"))?.status, "completed");
    assert.ok(!JSON.stringify(requests.at(-1)).includes(packet.data));
  } finally {
    agent?.dispose(); await new Promise<void>(done => kernel.close(() => done())); rmSync(directory, {recursive: true, force: true});
  }
});
