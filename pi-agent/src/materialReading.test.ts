import assert from "node:assert/strict";
import {spawn, spawnSync, type ChildProcess} from "node:child_process";
import {once} from "node:events";
import {existsSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer} from "node:net";
import {fileURLToPath} from "node:url";
import test, {before, after, afterEach} from "node:test";
import type {Api, Model} from "@earendil-works/pi-ai";
import {streamSimple} from "@earendil-works/pi-ai/api/openai-completions";
import {MaterialReadingClient, MaterialReadingExecutor, ReadingExecutionError, type ReadingSelection, type ReadingNote} from "./materialReading.js";
import {MaterialReadingRuntime} from "./materialReadingRuntime.js";
import {materialReadingContext} from "./materialReadingContext.js";
import {readingModelActivity} from "./readingModelActivity.js";
import {stopSmokeProcess} from "./smokeProcess.js";
import {RetrievalRuntime} from "./retrieval/runtime.js";
import {RetrievalSettingsStore} from "./retrieval/settings.js";
import {KernelSourceBackend} from "./retrieval/backend.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "lawa-reading-runtime-"));
const python = join(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
let api: ChildProcess, client: MaterialReadingClient, scope: string, beforeOverview: unknown;
const materials: string[] = [];

before(async () => {
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as {port: number}).port; reservation.close(); await once(reservation, "close");
  api = spawn(python, ["-m", "uvicorn", "app.api.main:app", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: {...process.env,
      LEARNING_STATE_PATH: ":memory:", LEARNING_BOOTSTRAP: "gradient-demo", LEARNING_MATERIALS_DIR: join(temporary, "materials")},
  });
  let errors = ""; api.stderr?.on("data", chunk => {errors += String(chunk);});
  client = new MaterialReadingClient(`http://127.0.0.1:${port}`);
  let ready = false;
  for (let n = 0; n < 100; n++) {
    if (api.exitCode !== null) throw new Error(errors);
    try {
      const response = await fetch(client.baseUrl + "/api/learning/overview", {signal: AbortSignal.timeout(2000)});
      if (response.ok) {beforeOverview = await response.json(); scope = (beforeOverview as {goal_profile: {id: string}}).goal_profile.id; ready = true; break;}
    } catch {}
    await new Promise(done => setTimeout(done, 100));
  }
  assert.ok(ready, "isolated Kernel startup");
  const fixture = spawnSync(python, ["-c", [
    "from pathlib import Path", "from PIL import Image", "from docx import Document", "from pypdf import PdfWriter", "import sys",
    "p=Path(sys.argv[1])", "Image.new('RGB',(480,240),'#dce9f8').save(p/'original.png')",
    "d=Document(); d.add_paragraph('HEAD_DOC'); d.add_picture(str(p/'original.png')); d.add_paragraph('TAIL_DOC_41'); d.save(p/'mixed.docx')",
    "w=PdfWriter(); [w.add_blank_page(width=300,height=400) for _ in range(4)]; w.write(p/'original.pdf')",
  ].join("\n"), temporary], {windowsHide: true});
  assert.equal(fixture.status, 0, String(fixture.stderr));
});
afterEach(async () => {
  for (const id of materials.splice(0)) await fetch(`${client.baseUrl}/api/user/materials/${id}?expected_goal_id=${scope}`, {method: "DELETE"});
  assert.deepEqual(await (await fetch(client.baseUrl + "/api/learning/overview")).json(), beforeOverview);
});
after(async () => {if (api) await stopSmokeProcess(api); rmSync(temporary, {recursive: true, force: true});});

async function upload(name: string, body: Uint8Array): Promise<string> {
  const params = new URLSearchParams({filename: name, expected_goal_id: scope, purpose: "conversation_attachment", conversation_id: "isolated-source-conversation"});
  const response = await fetch(client.baseUrl + "/api/user/materials?" + params, {method: "POST", body: body as BodyInit});
  assert.equal(response.status, 201); const id = (await response.json() as {id: string}).id; materials.push(id); return id;
}

function model(nativePdf = false): Model<Api> {
  return {id: nativePdf ? "qwen3.8-flash" : "fixture-vision", provider: "fixture", name: "Isolated vision", api: "openai-completions",
    baseUrl: nativePdf ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : "http://127.0.0.1:1/v1", reasoning: true,
    input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 8192,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
}
function selection(requests: any[], selected = model(), hooks: {hold?: (signal?: AbortSignal) => Promise<void>; undispatched?: boolean; invalidFirst?: boolean;
  nestedIntegrate?: boolean; sourceNotes?: boolean; sufficientNote?: boolean; citationRefs?: boolean;
  citationRefsInNote?: boolean; textJson?: boolean;
  noteFor?: (request: any) => ReadingNote} = {}): ReadingSelection {
  return {model: selected, thinkingLevel: "off", runtime: {completeSimple: async (chosen, context, options) => {
    if (hooks.undispatched) return {role: "assistant", content: [], stopReason: "stop"} as never;
    return streamSimple(chosen as Model<"openai-completions">, context, {...options, apiKey: "fixture-only", fetch: async (url, init) => {
      const request = await new Request(url, init).json() as any;
      request.__requestedMaxTokens = options?.maxTokens;
      requests.push(request);
      await hooks.hold?.(init?.signal ?? undefined);
      const integrate = Boolean(request.tools[0].function.parameters.properties.sufficient);
      const note = hooks.noteFor?.(request) ?? {summary: "Protocol fixture notes from delivered source.", concepts: [], facts: [], dependencies: [], uncertainties: []};
      const args = integrate && hooks.nestedIntegrate
        ? {note: {...note, sufficient: true, reading_blockers: []}}
        : {note, ...(integrate ? {sufficient: true, reading_blockers: []} : {})};
      if (hooks.sourceNotes) (args.note as any).source_notes = ["来源：测试夹具的完整原件范围。"];
      if (hooks.sufficientNote) (args.note as any).sufficient_note = "n/a";
      if (hooks.citationRefs) (args as any).citation_refs = ["material:fixture:line:1-1"];
      if (hooks.citationRefsInNote) (args.note as any).citation_refs = ["material:fixture:line:1-2"];
      if (hooks.invalidFirst && requests.length === 1) (args.note as any).facts = [{claim: "wrong shape"}];
      const event = (data: object) => `data: ${JSON.stringify(data)}\n\n`;
      if (hooks.textJson)
        return new Response(event({id: "isolated", choices: [{index: 0, delta: {role: "assistant", content: JSON.stringify(args)},
          finish_reason: null}]}) + event({id: "isolated", choices: [{index: 0, delta: {}, finish_reason: "stop"}],
          usage: {prompt_tokens: 100, completion_tokens: 50}}) + "data: [DONE]\n\n",
        {headers: {"Content-Type": "text/event-stream"}});
      return new Response(event({id: "isolated", choices: [{index: 0, delta: {role: "assistant", tool_calls: [{index: 0, id: "note", type: "function",
        function: {name: "submit_material_reading_note", arguments: JSON.stringify(args)}}]}, finish_reason: null}]})
        + event({id: "isolated", choices: [{index: 0, delta: {}, finish_reason: "tool_calls"}], usage: {prompt_tokens: 100, completion_tokens: 50}}) + "data: [DONE]\n\n",
      {headers: {"Content-Type": "text/event-stream"}});
    }}).result();
  }}};
}
async function untilReady(executor: MaterialReadingExecutor, id: string): Promise<void> {
  for (let n = 0; n < 8; n++) {
    let result;
    try {result = await executor.step(id, scope);}
    catch (error) {
      if (!(error instanceof ReadingExecutionError) || error.code !== "MATERIAL_PROCESSING") throw error;
      assert.equal((await client.get(id, scope)).state, "QUEUED");
      let parsed = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const meta = await client.metadata(id, scope);
        if (meta.parse_status === "ready") {parsed = true; break;}
        if (meta.parse_status === "failed") assert.fail("native fixture failed parsing");
        await new Promise(done => setTimeout(done, 50));
      }
      assert.ok(parsed, "native fixture parser became ready"); continue;
    }
    assert.equal(result.ran, true);
    if (result.ran && result.value.state === "READY") return;
  }
  assert.fail("bounded reading did not finish");
}

test("actual Kernel deletion records are discovered without a Gateway event and erase native derived sources on sync and restart", async () => {
  const query = new URLSearchParams({filename: "delete-protocol.txt", expected_goal_id: scope, purpose: "learning_material"});
  const uploaded = await fetch(client.baseUrl + "/api/user/materials?" + query, {method: "POST", body: "校准步骤：先零参考，再比较。DELETE_PROTOCOL_MARKER"});
  assert.equal(uploaded.status, 201); const id = (await uploaded.json() as {id: string}).id; materials.push(id);
  for (let i = 0; i < 100 && (await client.metadata(id, scope)).parse_status !== "ready"; i++) await new Promise(done => setTimeout(done, 20));
  const directory = join(temporary, "delete-protocol-index"), backend = new KernelSourceBackend(client.baseUrl);
  const settings = new RetrievalSettingsStore(join(directory, "settings.json"), join(temporary, "unused-profiles.json"), join(temporary, "unused-secrets.json"));
  await settings.save({...await settings.get(), enabled: false, dimensions: 64});
  const models = {embed: async (texts: string[]) => texts.map(() => [1, ...Array(63).fill(0)]),
    rerank: async (_query: string, texts: string[]) => texts.map((_, index) => ({index, score: 1}))};
  const runtime = new RetrievalRuntime(directory, backend, settings, () => models);
  try {
    await runtime.start(); await runtime.sync();
    const found = await runtime.search({query: "校准"});
    assert.ok(found.matches.some(row => row.material_id === id), "the actual source was indexed before deletion");
    assert.ok(await runtime.trace(found.trace_id));
    assert.equal((await fetch(`${client.baseUrl}/api/user/materials/${id}?expected_goal_id=${scope}`, {method: "DELETE"})).status, 204);
    await runtime.sync();
    assert.equal(await runtime.trace(found.trace_id), null);
    assert.ok(!(await runtime.status()).sources.some(source => source.source_id === "material:" + id));
    assert.ok(!(await runtime.search({query: "校准"})).matches.some(row => row.material_id === id));
    await runtime.stop();
    const reopened = new RetrievalRuntime(directory, backend, settings, () => models);
    try {await reopened.start(); await reopened.sync(); assert.equal(await reopened.trace(found.trace_id), null);}
    finally {await reopened.stop();}
  } finally {await runtime.stop();}
});

test("confirmed material deletion aborts the actual background SDK request and removes its queued retry", async () => {
  const id = await upload("delete-running.md", Buffer.from("DELETE_RUNNING_SOURCE"));
  for (let i = 0; i < 100 && (await client.metadata(id, scope)).parse_status !== "ready"; i++) await new Promise(done => setTimeout(done, 20));
  let dispatched!: () => void;
  const began = new Promise<void>(done => {dispatched = done;}), requests: any[] = [], failures: string[] = [];
  let complete = 0, backendCalls = 0;
  const runtime = new MaterialReadingRuntime({baseUrl: client.baseUrl,
    fetcher: async (url, init) => {backendCalls++; return fetch(url, init);},
    onComplete: () => {complete++;}, onError: code => failures.push(code),
    selection: async () => selection(requests, model(), {hold: async signal => {
      dispatched(); await new Promise<void>((_done, reject) => {
        const stopped = () => reject(new DOMException("source deleted", "AbortError"));
        signal?.addEventListener("abort", stopped, {once: true}); if (signal?.aborted) stopped();
      });
    }})});
  try {
    await runtime.enqueue(id, scope, "basis"); await began;
    assert.equal((await fetch(`${client.baseUrl}/api/user/materials/${id}?expected_goal_id=${scope}`, {method: "DELETE"})).status, 204);
    runtime.materialDeleted(id);
    for (let i = 0; i < 100 && readingModelActivity(client.baseUrl).busy; i++) await new Promise(done => setTimeout(done, 20));
    assert.equal(readingModelActivity(client.baseUrl).busy, false);
    const before = backendCalls; runtime.wake(true); await new Promise(done => setTimeout(done, 20));
    assert.equal(backendCalls, before, "removed work is not re-queued to repeatedly request the deleted source");
    assert.equal(requests.length, 1); assert.equal(complete, 0); assert.deepEqual(failures, []);
  } finally {runtime.dispose();}
});

test("a claim committed before its canceled response is recovered only by the same reader without waiting for lease expiry", async () => {
  const id = await upload("claim-response.md", Buffer.from("HEAD_CLAIM q=3v+4 TAIL_CLAIM"));
  await client.enqueue(id, scope, "basis");
  for (let i = 0; i < 100 && (await client.metadata(id, scope)).parse_status !== "ready"; i++) await new Promise(done => setTimeout(done, 20));
  const controller = new AbortController(); let lost = false;
  const uncertain = new MaterialReadingClient(client.baseUrl, async (url, init) => {
    const response = await fetch(url, init);
    if (response.ok && String(url).includes("/claim?") && !lost) {
      lost = true;
      await response.arrayBuffer(); // 服务端租约已经真实落盘，故意在调用方拿到租约ID之前取消。
      controller.abort(); throw new DOMException("canceled claim response", "AbortError");
    }
    return response;
  });
  const requests: any[] = [], executor = new MaterialReadingExecutor(uncertain, async () => selection(requests));
  const foreign = await client.claim(id, scope, {reader_id: "other-live-reader"});
  await assert.rejects(executor.step(id, scope), /READING_LEASE_BUSY/);
  assert.equal((await client.get(id, scope)).lease?.id, foreign.job.lease!.id, "another reader's lease cannot be recovered");
  await client.release(id, scope, foreign.job.lease!.id, false, "READING_PREEMPTED");
  await assert.rejects(executor.step(id, scope, controller.signal));
  assert.equal((await client.get(id, scope)).state, "READING");
  assert.equal(requests.length, 0, "no model was dispatched before the lost claim response");
  await untilReady(executor, id);
  assert.equal((await client.get(id, scope)).state, "READY");
  assert.equal(requests.length, 2, "recover the uncertain lease, not an extra reading/model run");
});

test("actual Kernel and SDK retain complete native text into integration without snippet caps or thinking", async () => {
  const text = "ORIGINAL_HEAD\n" + "原文关系不能只读开头。".repeat(18_000) + "\nORIGINAL_TAIL_41";
  const id = await upload("whole.md", Buffer.from(text));
  const requests: any[] = [];
  await client.enqueue(id, scope, "basis");
  await untilReady(new MaterialReadingExecutor(client, async () => selection(requests)), id);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    const serialized = JSON.stringify(request.messages);
    assert.ok(serialized.includes(text.replace(/\n/g, "\\n")), "full native original remains while it fits");
    assert.equal(request.reasoning_effort, undefined);
    assert.equal(request.lawa_background_reading, undefined, "private scheduling flags never leak to direct vendors");
  }
  const stored = readFileSync(join(temporary, "materials", id, "reading-v1.json"), "utf8");
  assert.ok(!stored.includes(text), "source originals are not duplicated into a new conversation ledger");
});

test("actual SDK delivers Office native text and embedded original in separate batches and together for integration", async () => {
  const id = await upload("mixed.docx", readFileSync(join(temporary, "mixed.docx")));
  const requests: any[] = [];
  await client.enqueue(id, scope, "supplementary");
  await untilReady(new MaterialReadingExecutor(client, async () => selection(requests)), id);
  assert.equal(requests.length, 3);
  assert.match(JSON.stringify(requests[0]), /HEAD_DOC[\s\S]*TAIL_DOC_41/);
  for (const request of requests.slice(1)) assert.equal(request.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).filter((part: any) => part.type === "image_url").length, 1);
  assert.match(JSON.stringify(requests[2]), /HEAD_DOC[\s\S]*TAIL_DOC_41/);
  assert.ok(!readFileSync(join(temporary, "materials", id, "reading-v1.json"), "utf8").includes("data:image"));
});

test("actual SDK sends original PDF file to a verified interface and original pages to other vision models", async () => {
  for (const native of [true, false]) {
    const id = await upload("original.pdf", readFileSync(join(temporary, "original.pdf")));
    const requests: any[] = [];
    await client.enqueue(id, scope, "basis");
    await untilReady(new MaterialReadingExecutor(client, async () => selection(requests, model(native))), id);
    assert.equal(requests.length, native ? 2 : 3);
    const media = requests.flatMap(request => request.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []));
    if (native) assert.equal(media.filter((part: any) => part.type === "file").length, 2);
    else assert.equal(media.filter((part: any) => part.type === "image_url").length, 7);
    assert.equal((await client.get(id, scope)).state, "READY");
  }
});

test("foreground preemption aborts the actual SDK request and preserves the uncommitted range for resume", async () => {
  const id = await upload("pause.md", Buffer.from("HEAD preserved range TAIL"));
  await client.enqueue(id, scope, "basis");
  let started!: () => void;
  const entered = new Promise<void>(done => {started = done;});
  let canceled = false;
  const requests: any[] = [];
  const executor = new MaterialReadingExecutor(client, async () => selection(requests, model(), {hold: async signal => {
    started(); await new Promise<void>((_, reject) => signal!.addEventListener("abort", () => {canceled = true; reject(new DOMException("aborted", "AbortError"));}, {once: true}));
  }}));
  const reading = executor.step(id, scope); const rejection = assert.rejects(reading);
  await entered;
  await readingModelActivity(client.baseUrl).runForeground(async () => {assert.equal(canceled, true);});
  await rejection;
  const paused = await client.get(id, scope);
  assert.equal(paused.state, "QUEUED"); assert.equal(paused.notes.length, 0);
  await untilReady(new MaterialReadingExecutor(client, async () => selection(requests)), id);
  assert.equal((await client.get(id, scope)).notes.length, 1);
});

test("restart discovery resumes valid committed work and emits only a machine completion event", async () => {
  const id = await upload("resume.md", Buffer.from("ORIGINAL_HEAD restart ORIGINAL_TAIL"));
  const requests: any[] = [];
  await client.enqueue(id, scope, "basis");
  await new MaterialReadingExecutor(client, async () => selection(requests)).step(id, scope);
  let complete!: () => void;
  const done = new Promise<void>(resolve => {complete = resolve;});
  const runtime = new MaterialReadingRuntime({baseUrl: client.baseUrl, selection: async () => selection(requests), onComplete: job => {
    assert.equal(job.source.material_id, id); complete();
  }});
  try {
    runtime.start();
    await Promise.race([done, new Promise<never>((_, reject) => {setTimeout(() => reject(new Error("resume timed out")), 10_000).unref();})]);
    assert.equal(requests.length, 2, "restart must not repeat committed native batch");
    assert.equal((await client.get(id, scope)).notes.length, 1);
  } finally {runtime.dispose();}
});

test("a response without actual SDK payload dispatch cannot advance reading", async () => {
  const id = await upload("unseen.md", Buffer.from("Must be delivered"));
  await client.enqueue(id, scope, "supplementary");
  await assert.rejects(new MaterialReadingExecutor(client, async () => selection([], model(), {undispatched: true})).step(id, scope), /READING_NOT_DISPATCHED/);
  const job = await client.get(id, scope);
  assert.equal(job.notes.length, 0); assert.equal(job.state, "FAILED");
});

test("unsupported vision configuration fails visibly before dispatch instead of leaving an eternal queued job", async () => {
  const id = await upload("requires-vision.md", Buffer.from("source"));
  await client.enqueue(id, scope, "basis");
  const selected = {...model(), input: ["text" as const]};
  await assert.rejects(new MaterialReadingExecutor(client, async () => selection([], selected)).step(id, scope), /READING_VISION_REQUIRED/);
  const job = await client.get(id, scope);
  assert.equal(job.state, "FAILED"); assert.equal(job.error_code, "READING_VISION_REQUIRED");
  assert.equal(job.notes.length, 0);
});

test("invalid structured model output receives one source-preserving repair and never advances twice", async () => {
  const id = await upload("repair.md", Buffer.from("SOURCE_HEAD source fact SOURCE_TAIL"));
  const requests: any[] = [];
  await client.enqueue(id, scope, "basis");
  await untilReady(new MaterialReadingExecutor(client, async () => selection(requests, model(), {invalidFirst: true})), id);
  assert.equal(requests.length, 3);
  assert.match(JSON.stringify(requests[1].messages), /SOURCE_HEAD[\s\S]*SOURCE_TAIL/);
  assert.match(JSON.stringify(requests[1].messages), /JSONSchema/);
  assert.equal((await client.get(id, scope)).notes.length, 1);
});

test("known integrate control fields nested inside note are normalized without a repair request", async () => {
  const id = await upload("nested-control.md", Buffer.from("SOURCE_HEAD nested controls SOURCE_TAIL"));
  const requests: any[] = [];
  await client.enqueue(id, scope, "basis");
  await untilReady(new MaterialReadingExecutor(client, async () => selection(requests, model(), {nestedIntegrate: true})), id);
  assert.equal(requests.length, 2);
  const job = await client.get(id, scope);
  assert.equal(job.state, "READY");
  assert.equal(job.synthesis?.sufficient, true);
  assert.deepEqual(job.synthesis?.reading_blockers, []);
});

test("known source-note metadata is preserved in summary instead of causing a repair failure", async () => {
  const id = await upload("source-notes.md", Buffer.from("SOURCE_HEAD source note compatibility SOURCE_TAIL"));
  const requests: any[] = [];
  await client.enqueue(id, scope, "basis");
  await untilReady(new MaterialReadingExecutor(client, async () => selection(requests, model(), {sourceNotes: true})), id);
  assert.equal(requests.length, 2);
  const job = await client.get(id, scope);
  assert.equal(job.state, "READY");
  assert.match(job.synthesis?.summary ?? "", /阅读出处元数据：来源：测试夹具的完整原件范围/);
});

test("redundant sufficient-note metadata is normalized without a repair failure", async () => {
  const id = await upload("sufficient-note.md", Buffer.from("SOURCE_HEAD sufficient note compatibility SOURCE_TAIL"));
  const requests: any[] = [];
  await client.enqueue(id, scope, "basis");
  await untilReady(new MaterialReadingExecutor(client, async () => selection(requests, model(), {sufficientNote: true})), id);
  assert.equal(requests.length, 2);
  assert.equal((await client.get(id, scope)).state, "READY");
});

test("top-level citation metadata is preserved in the note summary without a repair failure", async () => {
  const id = await upload("citation-refs.md", Buffer.from("SOURCE_HEAD citation compatibility SOURCE_TAIL"));
  const requests: any[] = [];
  await client.enqueue(id, scope, "basis");
  await untilReady(new MaterialReadingExecutor(client, async () => selection(requests, model(), {citationRefs: true})), id);
  assert.equal(requests.length, 2);
  const job = await client.get(id, scope);
  assert.equal(job.state, "READY");
  assert.match(job.synthesis?.summary ?? "", /material:fixture:line:1-1/);
});

test("citation metadata nested in a note is preserved without a repair failure", async () => {
  const id = await upload("nested-citation.md", Buffer.from("SOURCE_HEAD nested citation SOURCE_TAIL"));
  const requests: any[] = [];
  await client.enqueue(id, scope, "basis");
  await untilReady(new MaterialReadingExecutor(client, async () => selection(requests, model(), {citationRefsInNote: true})), id);
  assert.equal(requests.length, 2);
  const job = await client.get(id, scope);
  assert.equal(job.state, "READY");
  assert.match(job.synthesis?.summary ?? "", /material:fixture:line:1-2/);
});

test("a strict JSON response body is accepted when the provider omits the tool-call envelope", async () => {
  const id = await upload("text-json.md", Buffer.from("SOURCE_HEAD text json compatibility SOURCE_TAIL"));
  const requests: any[] = [];
  await client.enqueue(id, scope, "basis");
  await untilReady(new MaterialReadingExecutor(client, async () => selection(requests, model(), {textJson: true})), id);
  assert.equal(requests.length, 2);
  assert.equal((await client.get(id, scope)).state, "READY");
});

test("reasoning-capable reading reserves up to 16K output without changing the model", async () => {
  const id = await upload("output-budget.md", Buffer.from("SOURCE_HEAD budget SOURCE_TAIL"));
  const requests: any[] = [];
  const selected = {...model(), maxTokens: 32_768};
  await client.enqueue(id, scope, "basis");
  await untilReady(new MaterialReadingExecutor(client, async () => selection(requests, selected)), id);
  assert.equal(requests[0].__requestedMaxTokens, 16_384);
  assert.equal(selected.maxTokens, 32_768);
});

test("a successful commit with a lost HTTP acknowledgement retries only its exact receipt", async () => {
  const id = await upload("ack.md", Buffer.from("SOURCE_HEAD durable fact SOURCE_TAIL"));
  await client.enqueue(id, scope, "basis");
  let commits = 0;
  const receipts: string[] = [];
  const uncertain = new MaterialReadingClient(client.baseUrl, async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).endsWith("/commit?expected_goal_id=" + scope)) {
      receipts.push(String(options?.body)); commits++;
      if (commits === 1) {
        assert.equal(response.status, 200); await response.text();
        return Response.json({code: "ACKNOWLEDGEMENT_LOST"}, {status: 503});
      }
    }
    return response;
  });
  const requests: any[] = [];
  await untilReady(new MaterialReadingExecutor(uncertain, async () => selection(requests)), id);
  assert.equal(requests.length, 2, "no new model call for an uncertain commit acknowledgement");
  assert.equal(commits, 3); assert.equal(receipts[0], receipts[1]);
  assert.equal((await client.get(id, scope)).notes.length, 1);
});

test("a source canceled while the actual SDK is running rejects a late model result", async () => {
  const id = await upload("late.md", Buffer.from("SOURCE_HEAD canceled source SOURCE_TAIL"));
  await client.enqueue(id, scope, "basis");
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;});
  const blocked = new Promise<void>(resolve => {finish = resolve;});
  const requests: any[] = [];
  const execution = new MaterialReadingExecutor(client, async () => selection(requests, model(), {hold: async () => {
    entered(); await blocked;
  }})).step(id, scope);
  const rejected = assert.rejects(execution, /READING_LEASE_STALE/);
  try {
    await started; await client.cancel(id, scope);
  } finally {finish();}
  await rejected;
  const actual = await client.get(id, scope);
  assert.equal(actual.state, "CANCELED"); assert.equal(actual.notes.length, 0); assert.equal(actual.synthesis, null);
  assert.equal(requests.length, 1);
});

function readingPacket(request: any): any {
  const user = request.messages.find((message: any) => message.role === "user");
  const text = typeof user.content === "string" ? user.content : user.content.map((part: any) => part.text ?? "").join("");
  return JSON.parse(text.split("\n")[0]);
}

test("small-window SDK reading folds all earlier work in layers and resumes without deleting original notes", async () => {
  const original = "SOURCE_HEAD\n" + "original source line\n".repeat(80) + "SOURCE_TAIL";
  const id = await upload("layered.md", Buffer.from(original));
  await client.enqueue(id, scope, "basis");
  const seed = async (start: number, end: number) => {
    for (let index = start; index < end; index++) {
      const claimed = await client.claim(id, scope, {reader_id: "note-fixture", max_chars: 5});
      const note = {summary: `N${index} ` + "相同解释只为测试窗口边界，不是额外事实。".repeat(300), concepts: [],
        facts: [`FACT_${index} q=${index}v+4; see original batch locator`], dependencies: [`DEP_${index} uses previous definition`],
        uncertainties: [`UNIT_${index} is unspecified in the source`]};
      await client.commit(id, scope, claimed.job.lease!.id, note, model());
    }
  };
  await seed(0, 6);
  const initial = await client.get(id, scope);
  const selected = {...model(), contextWindow: 32_000, maxTokens: 2048};
  const requests: any[] = [];
  const configured = () => selection(requests, selected, {noteFor: request => {
    const packet = readingPacket(request);
    const notes = packet.earlier_machine_notes as Array<{note: ReadingNote}>;
    return {summary: "Grounded relations from all supplied nodes; original receipts remain available.", concepts: [],
      facts: [...new Set(notes.flatMap(node => node.note.facts ?? []))],
      dependencies: [...new Set(notes.flatMap(node => node.note.dependencies ?? []))],
      uncertainties: [...new Set(notes.flatMap(node => node.note.uncertainties ?? []))]};
  }});
  await new MaterialReadingExecutor(client, async () => configured()).step(id, scope);
  assert.equal(readingPacket(requests[0]).batch.kind, "consolidate");
  const first = await client.get(id, scope);
  assert.equal(first.folds?.length, 1); assert.deepEqual(first.notes, initial.notes);
  assert.equal(first.state, "QUEUED");
  await seed(6, 12);
  const beforeRestart = await client.get(id, scope);
  const restarted = new MaterialReadingExecutor(new MaterialReadingClient(client.baseUrl), async () => configured());
  await restarted.step(id, scope);
  const second = await client.get(id, scope);
  assert.deepEqual(second.notes, beforeRestart.notes);
  assert.equal(second.folds?.length, 2);
  const projected = materialReadingContext(second);
  assert.ok(projected.some(node => node.level >= 2), "new executor continues the persisted provenance tree");
  assert.equal(projected[0]!.start, 0); assert.equal(projected.at(-1)!.end, 12);
  for (let index = 1; index < projected.length; index++) assert.equal(projected[index - 1]!.end, projected[index]!.start);
  for (let number = 0; number < 12; number++) {
    const notes = JSON.stringify(projected);
    assert.ok(notes.includes(`FACT_${number} `)); assert.ok(notes.includes(`DEP_${number} `)); assert.ok(notes.includes(`UNIT_${number} `));
  }
  await untilReady(restarted, id);
  const ready = await client.get(id, scope);
  assert.equal(ready.notes.length, 13, "folds never replace or count as original-source batches");
  assert.deepEqual(ready.notes.slice(0, 12), beforeRestart.notes);
  assert.equal(ready.state, "READY");
  assert.match(JSON.stringify(requests.at(-1).messages), /SOURCE_HEAD[\s\S]*SOURCE_TAIL/);
  assert.ok(JSON.stringify(requests.at(-1).messages).includes(original.replace(/\n/g, "\\n")), "whole valid original still supplied during integration when it fits");
});
