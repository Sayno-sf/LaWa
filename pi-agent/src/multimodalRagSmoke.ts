import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {KernelSourceBackend} from "./retrieval/backend.js";
import {RetrievalSettingsStore} from "./retrieval/settings.js";
import {RetrievalRuntime} from "./retrieval/runtime.js";
import {stopSmokeProcess} from "./smokeProcess.js";
import type {SourceDescriptor} from "./retrieval/types.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "lawa-multimodal-live-"));
const base = "http://127.0.0.1:8138", python = join(root, ".venv", "Scripts", "python.exe");
const fixture = spawnSync(python, [join(root, "scripts", "multimodal_rag_fixture.py"), temp], {windowsHide: true});
if (fixture.status !== 0) throw new Error("Fixture creation failed");
const api = spawn(python, ["-m", "uvicorn", "app.api.main:app", "--host", "127.0.0.1", "--port", "8138"], {
  cwd: root, windowsHide: true, env: {...process.env, LEARNING_STATE_PATH: join(temp, "state.json"), LEARNING_BOOTSTRAP: "gradient-demo",
    LEARNING_MATERIALS_DIR: join(temp, "materials")}, stdio: ["ignore", "pipe", "pipe"]});
api.stdout?.resume(); api.stderr?.resume();
let runtime: RetrievalRuntime | undefined;
const report: Record<string, any> = {at: new Date().toISOString(), status: "running", isolated: true};
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {ready = (await fetch(base + "/api/learning/overview")).ok;} catch {}
    if (ready) break; await new Promise(done => setTimeout(done, 100));
  }
  assert.ok(ready);
  const overview = await (await fetch(base + "/api/learning/overview")).json() as any;
  const goal = overview.goal_profile.id;
  const ledger = await readFile(join(temp, "state.json"), "utf8").catch(() => null);
  const ids: string[] = [];
  for (const filename of ["solar-scan.pdf", "aurora.txt"]) {
    const response = await fetch(base + "/api/user/materials?" + new URLSearchParams({filename, expected_goal_id: goal}),
      {method: "POST", body: new Uint8Array(await readFile(join(temp, filename)))});
    assert.equal(response.status, 201); ids.push((await response.json() as any).id);
  }
  for (let i = 0; i < 100; i++) {
    const list = await (await fetch(base + "/api/learning/materials?expected_goal_id=" + goal)).json() as any;
    if (list.materials.every((m: any) => m.parse_status === "ready")) break;
    await new Promise(done => setTimeout(done, 100));
  }
  const settings = new RetrievalSettingsStore(join(temp, "retrieval", "settings.json"), join(root, "data", "provider-settings.json"), join(root, "data", "provider-secrets.json"));
  const live = new RetrievalSettingsStore(join(root, "data", "retrieval", "settings.json"), settings.providerPath, settings.secretsPath);
  const config = await live.get();
  assert.ok(config.enabled, "Save and enable retrieval settings before running this real-provider smoke.");
  await settings.save({...config, visionEnabled: true, graphEnabled: true});
  report.models = {embedding: config.embeddingModel, rerank: config.rerankModel, vision: config.visionModel || (await live.queryModel(config.profileId)).model,
    extraction: config.extractionModel || (await live.queryModel(config.profileId)).model};
  const backend = new KernelSourceBackend(base);
  const originalCatalog = backend.catalog.bind(backend);
  backend.catalog = async () => {const page = await originalCatalog(); return {...page, sources: page.sources.filter((s: SourceDescriptor) => ids.includes(s.source_id.slice(9))), next_offset: null};};
  runtime = new RetrievalRuntime(join(temp, "retrieval"), backend, settings);
  await runtime.start(); await runtime.sync(); await runtime.sync();
  report.index = await runtime.status();
  assert.ok(report.index.sources.every((s: any) => s.state === "ready" && s.derived?.graph?.state === "ready" && s.derived?.vision?.state === "ready"));
  const read = await (await fetch(base + `/api/learning/materials/${ids[0]}?expected_goal_id=${goal}&max_chars=8000`)).json() as any;
  report.visual = {text: read.text, annotations: read.visual_annotations, citation: read.citation};
  assert.ok(read.visual_annotations.some((a: any) => a.kind === "table"));
  assert.ok(read.visual_annotations.some((a: any) => a.kind === "formula"));
  assert.match(read.text, /400/); assert.match(read.text, /800/);
  const original = await fetch(base + `/api/learning/materials/${ids[0]}/visual/page-1?expected_goal_id=${goal}`);
  assert.equal(original.headers.get("content-type"), "image/jpeg"); report.original_bytes = (await original.arrayBuffer()).byteLength;
  const query = "How does solar wind relate to auroras and which gases produce their colors?";
  const search = await runtime.search({query}); report.search = search;
  const trace = await runtime.trace(search.trace_id); report.graph_candidates = trace?.stages.graph;
  assert.ok(trace?.stages.graph?.some((c: any) => c.graph_context?.length === 2), "Expected a grounded two-hop path");
  report.reads = [];
  for (const hit of search.matches) report.reads.push(await runtime.read(hit.source_ref, "current", {}, null, search.trace_id));
  assert.ok(report.reads.some((r: any) => /oxygen/i.test(r.text)));
  assert.equal(await readFile(join(temp, "state.json"), "utf8").catch(() => null), ledger);
  assert.deepEqual(await (await fetch(base + "/api/learning/overview")).json(), overview); report.ledger_unchanged = true;
  report.status = "passed";
} catch (error) {report.status = "failed"; report.error = error instanceof Error ? error.message : "Smoke failure"; process.exitCode = 1;}
finally {
  await runtime?.stop(); await stopSmokeProcess(api);
  await writeFile(join(root, "docs", "evals", "multimodal-rag-provider-probe.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({status: report.status, error: report.error, models: report.models, index: report.index,
    visual_blocks: report.visual?.annotations?.length, graph_candidates: report.graph_candidates?.length, ledger_unchanged: report.ledger_unchanged}));
  await rm(temp, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
}
