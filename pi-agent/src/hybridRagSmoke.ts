import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KernelSourceBackend } from "./retrieval/backend.js";
import { RetrievalRuntime } from "./retrieval/runtime.js";
import { RetrievalSettingsStore } from "./retrieval/settings.js";
import { createLearningAgentSession } from "./agentSession.js";
import { GoalOnboardingContext } from "./planning/goalOnboarding.js";
import { TeachingSessionContext } from "./teachingSession.js";
import { ProviderSettingsService } from "./web/providerSettings.js";
import { stopSmokeProcess } from "./smokeProcess.js";

type Case = [string, string, string | string[] | null];
const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "lawa-hybrid-eval-"));
const python = join(root, ".venv", "Scripts", "python.exe");
const report: Record<string, any> = { at: new Date().toISOString(), fixture: "self-generated source.md; no real learner data",
  results: [], warnings: [], target: { hit_at_5: .9, no_answer: .9, valid_locators: 1 } };
let apiProcess: ChildProcess | undefined;
let runtime: RetrievalRuntime | undefined;
async function pythonRun(args: string[]) {
  const child = spawn(python, args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let error = ""; child.stderr?.on("data", bytes => { error += String(bytes); });
  const [code] = await once(child, "exit");
  if (code) throw new Error(error.slice(-2000));
}
function score(rows: Array<Record<string, any>>, expected: Case[2], threshold: number) {
  const selected = rows.filter(row => row.score >= threshold).slice(0,5);
  return expected === null ? selected.length === 0
    : (Array.isArray(expected) ? expected : [expected]).every(heading => selected.some(row => row.heading === heading));
}
try {
  await pythonRun(["-m", "scripts.hybrid_rag_fixtures", temporary]);
  const cases = JSON.parse(await readFile(join(temporary, "cases.json"), "utf8")) as Record<string, Case[]>;
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const address = reservation.address(); assert.ok(address && typeof address === "object");
  const port = address.port; reservation.close(); await once(reservation, "close");
  const apiUrl = "http://127.0.0.1:" + port;
  apiProcess = spawn(python, ["-m", "uvicorn", "app.api.main:app", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, LEARNING_STATE_PATH: join(temporary, "state.json"),
      LEARNING_BOOTSTRAP: "gradient-demo", LEARNING_MATERIALS_DIR: join(temporary, "materials") },
  });
  let errors = ""; apiProcess.stderr?.on("data", bytes => { errors += String(bytes); });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (apiProcess.exitCode !== null) throw new Error(errors.slice(-2000));
    try { if ((await fetch(apiUrl + "/api/learning/overview")).ok) { ready = true; break; } } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, "isolated API starts");
  const overview = await (await fetch(apiUrl + "/api/learning/overview")).json() as any;
  const upload = await fetch(apiUrl + "/api/user/materials?filename=source.md&expected_goal_id=" + overview.goal_profile.id,
    { method: "POST", body: await readFile(join(temporary, "source.md")) });
  assert.equal(upload.status, 201);
  const material = await upload.json() as { id: string };
  await copyFile(join(root, "data", "provider-settings.json"), join(temporary, "providers.json"));
  await copyFile(join(root, "data", "provider-secrets.json"), join(temporary, "secrets.json"));
  const settings = new RetrievalSettingsStore(join(temporary, "retrieval", "settings.json"),
    join(temporary, "providers.json"), join(temporary, "secrets.json"));
  const config = await settings.get();
  await settings.save({ ...config, minimumRerankScore: 0 }); // record all scores before calibration
  report.models = { embedding: config.embeddingModel, dimensions: config.dimensions, rerank: config.rerankModel };
  runtime = new RetrievalRuntime(join(temporary, "retrieval"), new KernelSourceBackend(apiUrl), settings);
  console.log(JSON.stringify({ stage: "ingestion_started" }));
  await runtime.start();
  let indexed = false;
  const ingestAt = performance.now();
  for (let attempt = 0; attempt < 100; attempt++) {
    await runtime.sync();
    const state = await runtime.status();
    if (state.sources.some(job => job.source_id === "material:" + material.id && job.state === "ready")) {
      indexed = true; report.chunks = state.chunks; break;
    }
    const failed = state.sources.find(job => job.state === "lexical_only");
    if (failed) throw new Error("Real provider ingestion incomplete: " + failed.error_code);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(indexed, "cloud ingestion completes");
  report.ingestion_ms = Math.round(performance.now() - ingestAt);
  console.log(JSON.stringify({ stage: "indexed", chunks: report.chunks, ingestion_ms: report.ingestion_ms }));
  const evaluations: Array<Record<string, any>> = [];
  async function evaluate(set: string) {
    for (const [category, query, expected] of cases[set]!) {
      const result = await runtime!.search({ query });
      const trace = await runtime!.trace(result.trace_id);
      const rows = trace?.stages.rerank ?? [];
      evaluations.push({ set, category, query, expected, rows, warnings: result.warnings, timings: trace?.timings_ms });
      if (!trace?.stages.rerank) report.warnings.push({ set, query, warnings: result.warnings });
    }
    console.log(JSON.stringify({ stage: set + "_evaluated", count: evaluations.filter(row => row.set === set).length }));
  }
  await evaluate("calibration");
  const calibration = evaluations.filter(row => row.set === "calibration");
  const thresholds = Array.from({ length: 20 }, (_, i) => (i + 1) / 20);
  const selectedThreshold = thresholds.map(threshold => ({ threshold, correct: calibration.filter(row =>
    score(row.rows, row.expected, threshold)).length })).sort((a,b) => b.correct - a.correct || a.threshold - b.threshold)[0]!.threshold;
  report.threshold = selectedThreshold;
  await settings.save({ ...await settings.get(), minimumRerankScore: selectedThreshold });
  await evaluate("baseline");
  await evaluate("held_out");
  for (const set of ["baseline", "calibration", "held_out"]) {
    const subset = evaluations.filter(row => row.set === set);
    const relevant = subset.filter(row => row.expected !== null), absent = subset.filter(row => row.expected === null);
    report[set] = { hit_at_5: { hits: relevant.filter(row => score(row.rows, row.expected, selectedThreshold)).length, total: relevant.length },
      no_answer: { correct: absent.filter(row => score(row.rows, row.expected, selectedThreshold)).length, total: absent.length } };
  }
  report.results = evaluations.map(row => ({ ...row, hit: score(row.rows, row.expected, selectedThreshold) }));
  const readResult = await runtime.search({ query: "压缩了提示词后，还能恢复以前的聊天分支吗？" });
  let locatorChecks = 0;
  for (const hit of readResult.matches.slice(0,3)) {
    const value = await runtime.read(hit.source_ref, "current");
    assert.ok(typeof value.text === "string" && value.text.length > 0);
    assert.match(String(value.citation_ref), /^material:mat-[a-f0-9]{32}:line:\d+-\d+$/);
    locatorChecks++;
  }
  assert.ok(locatorChecks > 0);
  report.locator_checks = { passed: locatorChecks, total: locatorChecks };
  const ledgerBefore = await readFile(join(temporary, "state.json"), "utf8").catch(() => "");
  const provider = new ProviderSettingsService({ settingsPath: join(temporary, "providers.json"), secretsPath: join(temporary, "secrets.json") });
  const active = await provider.getActiveRuntime();
  const events: string[] = [];
  let answer = "";
  const session = await createLearningAgentSession(new TeachingSessionContext(), new GoalOnboardingContext(), {
    apiBaseUrl: apiUrl, retrieval: runtime, modelRuntime: active.runtime, model: active.model,
    thinkingLevel: active.thinkingLevel, surface: "WEB", onEvent: event => {
      if (event.type === "tool_start") events.push(event.toolName);
      if (event.type === "assistant_delta") answer += event.delta;
    },
  });
  try {
    await session.prompt("请只依据上传的 source.md 回答：压缩提示词后，旧会话分支还能恢复吗？请先用 search_learning_sources 搜索，再用 read_learning_source 回读。用中文简短解释并在末尾列真实来源。只读问答，不创建任务、知识卡片或学习证据。");
    assert.ok(events.includes("search_learning_sources") && events.includes("read_learning_source"), "actual teacher searches and reads");
    assert.match(answer, /source\.md/);
    assert.match(answer, /行/);
    assert.equal(await readFile(join(temporary, "state.json"), "utf8").catch(() => ""), ledgerBefore);
    report.teacher = { events, answer, ledger_unchanged: true };
  } finally { session.dispose(); }
  const held = report.held_out;
  report.acceptance = { hit_at_5: held.hit_at_5.hits / held.hit_at_5.total >= .9,
    no_answer: held.no_answer.correct / held.no_answer.total >= .9,
    provider_stages_completed: report.warnings.length === 0 };
  report.status = Object.values(report.acceptance).every(Boolean) ? "passed" : "needs_improvement";
  if (report.status !== "passed") process.exitCode = 1;
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : "Evaluation failed";
  process.exitCode = 1;
} finally {
  await writeFile(join(root, "docs", "evals", "hybrid-rag-results.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, threshold: report.threshold, baseline: report.baseline,
    held_out: report.held_out, acceptance: report.acceptance, error: report.error }));
  await runtime?.stop();
  await stopSmokeProcess(apiProcess);
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
