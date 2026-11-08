import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {ModelRuntime, SessionManager} from "@earendil-works/pi-coding-agent";
import type {Model} from "@earendil-works/pi-ai";
import {streamSimple} from "@earendil-works/pi-ai/api/openai-completions";
import {DocumentTurnInput} from "./documentReadingTool.js";
import {readingModelActivity} from "./readingModelActivity.js";
import {loadVisualManifest, loadVisualPacket, parseVisualIds} from "./visualInput.js";
import {createLearningAgentSession} from "./agentSession.js";
import {createAssistantAgent, assistantToolGuard} from "./assistantAgent.js";
import {TeachingSessionContext} from "./teachingSession.js";
import {GoalOnboardingContext} from "./planning/goalOnboarding.js";

const id = "mat-" + "a".repeat(32);
const source = {material_id: id, scope: "goal", source_hash: "b".repeat(64), purpose_revision: 0, parser_version: "test-v1", name: "source.pdf"};
const imageData = (tag: string) => Buffer.concat([Buffer.from([255, 216, 255]), Buffer.from(tag)]).toString("base64");
const packet = (asset = "page-1") => ({...source, asset_id: asset, unit: Number(asset.split("-")[1]) || 1, label: `Original ${asset}`, citation: `source, ${asset}`, mime: "image/jpeg" as const, data: imageData(asset)});
const meta = {goal_id: "goal", sha256: source.source_hash, purpose_revision: 0, parser_version: "test-v1", format: "pdf"};
const model: Model<"openai-completions"> = {id: "catalog-vision", name: "mock vision", provider: "catalog-provider", api: "openai-completions",
  baseUrl: "https://provider.example/v1", reasoning: false, input: ["text", "image"], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 256000, maxTokens: 8192};

test("visual protocols reject forged source, paths, duplicate IDs and bad images", async () => {
  for (const ids of [[], ["../source"], ["image-1", "image-1"], ["a", "b", "c", "d"]]) assert.throws(() => parseVisualIds(ids));
  await assert.rejects(loadVisualPacket(id, "goal", "image-1", "http://kernel.test", undefined,
    async () => Response.json({...packet("image-1"), scope: "another-goal"})), /身份/);
  await assert.rejects(loadVisualPacket(id, "goal", "image-1", "http://kernel.test", undefined,
    async () => Response.json({...packet("image-1"), data: Buffer.from("not an image").toString("base64")})), /内容/);
  const manifest = await loadVisualManifest(id, "goal", 0, "http://kernel.test", undefined, async () => Response.json({...source,
    unit_kind: "page", unit_count: 23, assets: [{id: "page-1", unit: 1, label: "Page 1", kind: "page", url: "https://private.example"}], total: 23, next_offset: 20, warnings: []}));
  assert.equal(manifest.next_offset, 20);
  assert.equal("url" in manifest.assets[0]!, false);
});

test("document image slots, scope reset and source changes are checked before dispatch", async () => {
  let calls = 0, changed = false;
  const input = new DocumentTurnInput({baseUrl: "http://kernel.test", model: () => model, draft: () => null, sessionId: () => "one", imageSlots: () => 1,
    fetcher: async url => {calls++; return Response.json(String(url).includes("visual-packet") ? packet() : {...meta, purpose_revision: changed ? 1 : 0});}});
  await assert.rejects(input.readVisual(id, ["page-1", "page-2"]), /合计最多/); assert.equal(calls, 0);
  const messages = [{role: "user" as const, content: "original question", timestamp: 1}];
  await input.requestOptions(model, messages); await input.read(id, 1, 1);
  const options = await input.requestOptions(model, messages);
  assert.ok(input.projectMessages(messages).some(m => Array.isArray(m.content) && m.content.some(p => p.type === "image")));
  changed = true;
  await assert.rejects(async () => {await options?.onPayload?.({messages}, model);}, /原件/);
  changed = false; input.reset();
  await assert.rejects(async () => {await options?.onPayload?.({messages}, model);}, /回合/);
  assert.equal(input.tokenReserve, 0);
  assert.equal(assistantToolGuard("read_learning_visual", {material_id: id, asset_ids: ["page-1"]}, "skill"), null);
  assert.ok(assistantToolGuard("set_learning_material_purpose", {}, "skill"));
  assert.ok(assistantToolGuard("read_learning_visual", {material_id: id, goal_id: "other"}, "skill"));
});

test("reused tool IDs cannot bind original images to old turns or failed results", async () => {
  const input = new DocumentTurnInput({baseUrl: "http://kernel.test", model: () => model, draft: () => null, sessionId: () => "one",
    fetcher: async url => Response.json(String(url).includes("visual-packet") ? packet() : meta)});
  const current = {role: "user" as const, content: "current question", timestamp: 2};
  await input.requestOptions(model, [current]);
  const value = await input.readVisual(id, ["page-1"], undefined, "reused-id");
  const result = {role: "toolResult", toolCallId: "reused-id", toolName: "read_learning_visual", isError: false, timestamp: 3,
    content: [{type: "text", text: JSON.stringify(value)}]};
  const messages = [{role: "user", content: "old question", timestamp: 0}, result, current, result] as any;
  const projected = input.projectMessages(messages);
  assert.equal((projected[1]!.content as any[]).length, 1);
  assert.ok((projected[3]!.content as any[]).some(p => p.type === "image"));
  assert.throws(() => input.projectMessages([current, {...result, isError: true}] as any), /读取结果/);
  assert.throws(() => input.projectMessages([messages[0], result, current] as any), /读取结果/);
});

for (const role of ["teacher", "assistant"] as const) test(`actual ${role} Pi/SDK reads original images for a non-PDF vision model without replay or binary persistence`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-visual-loop-"));
  const requests: any[] = [];
  const overview = {current_goal: "Read source", goal_profile: {id: "goal"}, curriculum_spine: [], current_frontier: null, current_focus: null,
    skills: [], recent_evidence: [], active_task: null, learning_history: [], current_goal_skill_ids: []};
  const kernel = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const match = req.url?.match(/visual-packet\/(page-[12])/);
    if (match) assert.ok(req.url?.includes("expected_goal_id=goal"));
    res.end(JSON.stringify(match ? packet(match[1]) : req.url?.includes("/metadata") ? meta : overview));
  });
  await new Promise<void>(done => kernel.listen(0, "127.0.0.1", done));
  const address = kernel.address(); assert.ok(address && typeof address !== "string");
  const runtime = await ModelRuntime.create({authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models.json"), allowModelNetwork: false, refreshOnCreate: false});
  runtime.hasConfiguredAuth = () => true;
  runtime.getAuth = async () => ({auth: {apiKey: "isolated-only"}, env: {}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  runtime.streamSimple = (selected, context, options) => streamSimple(selected as Model<"openai-completions">, context, {...options, apiKey: "isolated-only",
    fetch: async (url, init) => {
      requests.push(await new Request(url, init).json());
      const index = requests.length;
      const tool = index === 1 ? {id: "read-images", name: "read_learning_document", args: {material_id: id, start: 1, end: 2}}
        : index === 2 ? {id: "read-context", name: role === "teacher" ? "get_learning_overview" : "get_skill_learning_context", args: role === "teacher" ? {} : {skill_id: "skill"}} : context.tools?.some(t => t.name === "begin_teacher_reply") ? {id: "begin", name: "begin_teacher_reply", args: {}} : null;
      const delta = tool ? {role: "assistant", tool_calls: [{index: 0, id: tool.id, type: "function", function: {name: tool.name, arguments: JSON.stringify(tool.args)}}]}
        : {role: "assistant", content: "Read the original images."};
      const event = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
      return new Response(event({id: "mock", choices: [{index: 0, delta, finish_reason: null}]})
        + event({id: "mock", choices: [{index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop"}], usage: {prompt_tokens: 100, completion_tokens: 10}})
        + "data: [DONE]\n\n", {headers: {"Content-Type": "text/event-stream"}});
    }});
  const manager = SessionManager.create(directory, directory);
  let agent: Awaited<ReturnType<typeof createLearningAgentSession>> | undefined;
  let assistant: Awaited<ReturnType<typeof createAssistantAgent>> | undefined;
  let interruptedReading = false;
  let background: Promise<unknown> | undefined;
  const startReading = () => {
    background = readingModelActivity(`http://127.0.0.1:${address.port}`).tryBackground(signal => new Promise<void>(done => {
      signal.addEventListener("abort", () => {interruptedReading = true; done();}, {once: true});
    }));
  };
  const userImage = {type: "image" as const, mimeType: "image/jpeg", data: imageData("USER_IMAGE")};
  try {
    if (role === "teacher") {
      agent = await createLearningAgentSession(new TeachingSessionContext(), new GoalOnboardingContext(), {apiBaseUrl: `http://127.0.0.1:${address.port}`,
        model, modelRuntime: runtime, sessionManager: manager, retrieval: false, assistantSupport: false, surface: "WEB", log: () => undefined});
      startReading();
      assert.equal((await agent.prompt("Read the document pages", [userImage]))?.status, "completed");
    } else {
      assistant = await createAssistantAgent({scope: {goalId: "goal", taskId: "task", skillId: "skill", mainSessionId: "main", branchId: "branch", questionId: null, attemptId: null},
        context: {apiBaseUrl: `http://127.0.0.1:${address.port}`, model, modelRuntime: runtime, retrieval: false}, history: [], onEvent: () => undefined, onClassification: () => undefined, isCurrentScope: async () => true});
      startReading();
      await assistant.prompt("Read the document pages");
    }
    await background;
    assert.equal(interruptedReading, true, "actual teacher/assistant prompt must preempt resource reading");
    assert.equal(requests.length, role === "teacher" ? 4 : 3);
    for (const request of requests.slice(1)) {
      const images = request.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).filter((p: any) => p.type === "image_url");
      assert.ok(request.messages.some((m: any) => m.role === "user" && Array.isArray(m.content) && m.content.some((p: any) => p.text === "Attached image(s) from tool result:")), "SDK must deliver actual images associated with the reading result");
      assert.equal(images.length, role === "teacher" ? 3 : 2);
      if (role === "teacher") assert.equal(images[0].image_url.url, `data:image/jpeg;base64,${userImage.data}`);
      assert.equal(images.at(-2).image_url.url, `data:image/jpeg;base64,${packet("page-1").data}`);
      assert.equal(images.at(-1).image_url.url, `data:image/jpeg;base64,${packet("page-2").data}`);
    }
    if (agent) {
      const saved = readFileSync(manager.getSessionFile()!, "utf8");
      for (const data of [packet().data, userImage.data]) assert.ok(!saved.includes(data));
      await agent.prompt("Next question");
    } else await assistant!.prompt("Next question");
    assert.ok(!JSON.stringify(requests.at(-1)).includes(packet().data));
    assert.ok(!JSON.stringify(requests.at(-1)).includes(userImage.data));
  } finally {
    agent?.dispose(); assistant?.dispose(); await new Promise<void>(done => kernel.close(() => done())); rmSync(directory, {recursive: true, force: true});
  }
});
