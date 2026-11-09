import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {SourceGraphStore, validateGraph} from "./retrieval/graph.js";
import {BailianRetrievalModels, RetrievalSettingsStore} from "./retrieval/settings.js";
import {testRetrievalSettings} from "./retrieval/testSettings.js";
import {RetrievalRuntime} from "./retrieval/runtime.js";
import {KernelSourceBackend} from "./retrieval/backend.js";
import type {Candidate, Models, SourceBackend, SourceChunk, SourceDescriptor} from "./retrieval/types.js";

const source = (id: string, goal = "a"): SourceDescriptor => ({source_id: "material:" + id, kind: "material", name: id,
  goal_id: goal.startsWith("draft:") ? null : goal, draft_session_id: goal.startsWith("draft:") ? goal.slice(6) : null,
  goal_name: goal, skill_id: "", version: "v1", parse_status: "ready", warnings: []});
const chunk = (s: SourceDescriptor, text: string, n = 0): SourceChunk => ({chunk_id: "c" + n, ordinal: n, text,
  source_ref: Buffer.from(JSON.stringify({source_id: s.source_id, version: s.version, chunk_id: "c" + n})).toString("base64url"),
  heading: null, locator: {kind: "page", start: n + 1, end: n + 1, char_start: n * 100, char_end: n * 100 + text.length},
  embedding_text: text, lexical_text: "tother", embedding_hash: text});
const extraction = (c: {chunk_id: string; text: string}) => {
  const [from, to] = c.text.includes("太阳风") ? ["太阳风", "磁层"] : ["磁层", "极光"];
  return {entities: [{name: from, aliases: []}, {name: to, aliases: []}],
    relations: [{from, to, relation: "影响", chunk_id: c.chunk_id, quote: c.text}]};
};

test("recycling a Goal aborts its in-flight visual model and prevents publication; restoring resumes with a fresh signal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lawa-visual-recycle-"));
  const settings = new RetrievalSettingsStore(join(directory, "settings.json"), join(directory, "providers.json"), join(directory, "secrets.json"));
  await writeFile(join(directory, "providers.json"), JSON.stringify({profiles: [{id: "p", provider: "aliyun", model: "chat", baseUrl: "https://example.test/v1"}]}));
  await settings.save({...testRetrievalSettings, graphEnabled: false});
  const material = {...source("pdf"), visual_count: 1};
  let sources = [material], publications = 0, analyses = 0;
  let entered!: () => void;
  const analyzing = new Promise<void>(done => {entered = done;});
  let modelSignal: AbortSignal | undefined;
  const backend: SourceBackend = {
    catalog: async () => ({sources, next_offset: null, catalog_version: JSON.stringify(sources)}),
    chunks: async () => ({source: material, chunks: [chunk(material, "扫描页内容")], next_offset: null}),
    visualPlan: async () => ({source_hash: "h", parser_version: "p", total: 1, completed: 0, assets: [{id: "asset", unit: 1, label: "页", context: "原文"}]}),
    visualAsset: async () => ({mime: "image/jpeg", data: "aGVsbG8="}),
    publishVisual: async () => {publications++; return {};},
    context: async () => ({current_scope: "a", allowed_scopes: ["a"], lexical_query: "tmissing"}), validate: async refs => refs, read: async () => ({text: "原文"}),
  };
  const models: Models = {embed: async texts => texts.map(() => [1, ...Array(63).fill(0)]), rerank: async () => [],
    analyzeVisual: async (_asset, _context, signal) => {
      analyses++; modelSignal = signal;
      if (analyses > 1) return {blocks: [], warnings: []};
      entered();
      return new Promise((_done, reject) => signal!.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), {once: true}));
    }};
  const runtime = new RetrievalRuntime(directory, backend, settings, () => models);
  try {
    await runtime.start(); await analyzing;
    sources = []; runtime.scopeChanged("a", true);
    await runtime.sync(); assert.equal(modelSignal?.aborted, true); assert.equal(publications, 0);
    await runtime.sync(); assert.equal((await runtime.status()).sources.length, 0);
    sources = [material]; runtime.scopeChanged("a", false); await runtime.sync();
    assert.equal(analyses, 2); assert.equal(publications, 1); assert.equal(modelSignal?.aborted, false);
  } finally {await runtime.stop(); await rm(directory, {recursive: true, force: true});}
});

test("completed visual jobs stop planning and fetching chunks across syncs and restart", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lawa-visual-idle-"));
  const settings = new RetrievalSettingsStore(join(directory, "settings.json"), join(directory, "providers.json"), join(directory, "secrets.json"));
  await writeFile(join(directory, "providers.json"), JSON.stringify({profiles: [{id: "p", provider: "aliyun", model: "chat", baseUrl: "https://example.test/v1"}]}));
  await settings.save({...testRetrievalSettings, graphEnabled: false});
  let sources = [{...source("pdf"), visual_count: 10}, {...source("txt"), visual_count: 0}];
  let catalogs = 0;
  const calls = {plan: 0, chunks: 0, visual: 0};
  const backend: SourceBackend = {
    catalog: async () => {catalogs++; return {sources, next_offset: null, catalog_version: JSON.stringify(sources)};},
    chunks: async id => {calls.chunks++; const s = sources.find(s => s.source_id === id)!;
      return {source: s, chunks: [chunk(s, "已完成的扫描页正文")], next_offset: null};},
    visualPlan: async () => {calls.plan++; return {source_hash: "h", parser_version: "p", total: 10, completed: 10, assets: []};},
    visualAsset: async () => ({mime: "image/jpeg", data: "aGVsbG8="}), publishVisual: async () => ({}),
    context: async () => ({current_scope: "a", allowed_scopes: ["a"], lexical_query: "tmissing"}),
    validate: async refs => refs, read: async () => ({text: "原文"}),
  };
  const models: Models = {embed: async texts => texts.map(() => [1, ...Array(63).fill(0)]), rerank: async () => [],
    analyzeVisual: async () => {calls.visual++; return {blocks: [], warnings: []};}};
  let runtime = new RetrievalRuntime(directory, backend, settings, () => models);
  try {
    await runtime.start(); await runtime.sync();
    assert.equal((await runtime.status()).sources[0]?.derived?.vision?.state, "ready");
    assert.equal(calls.plan, 1, "TXT without visual assets skips the plan endpoint");
    const baseline = {...calls};
    await runtime.sync(); await runtime.sync();
    assert.deepEqual(calls, baseline, "ready visual sources must not re-plan or re-read chunks every tick");
    t.mock.timers.enable({apis: ["setTimeout"]});
    await runtime.sync(); const idleCatalogs = catalogs;
    t.mock.timers.tick(5000); assert.equal(catalogs, idleCatalogs);
    t.mock.timers.tick(25_000); await runtime.sync(); assert.equal(catalogs, idleCatalogs + 1);
    await runtime.stop();
    runtime = new RetrievalRuntime(directory, backend, settings, () => models);
    await runtime.start(); await runtime.sync();
    assert.deepEqual(calls, baseline, "ready state must survive process restart");
    await runtime.stop();
    const pointer = JSON.parse(await readFile(join(directory, "active.json"), "utf8"));
    const path = join(directory, pointer.generation, "manifest.json"), manifest = JSON.parse(await readFile(path, "utf8"));
    for (const jobs of Object.values(manifest.derived) as any[]) for (const key of ["version", "scope_id", "fingerprint"]) delete jobs.vision[key];
    await writeFile(path, JSON.stringify(manifest));
    runtime = new RetrievalRuntime(directory, backend, settings, () => models);
    await runtime.start(); await runtime.sync();
    assert.equal(calls.plan, baseline.plan + 1, "legacy completed jobs migrate with one plan check");
    assert.equal(calls.chunks, baseline.chunks, "migration does not fetch chunks or re-index");
    sources[0] = {...sources[0]!, version: "v2"};
    await runtime.sync(); assert.equal(calls.plan, baseline.plan + 2);
    const updated = {...calls}; await runtime.sync(); assert.deepEqual(calls, updated);
    await settings.save({...await settings.get(), visionModel: "other-vision"});
    await runtime.sync(); assert.equal(calls.plan, updated.plan + 1);
    sources = []; await runtime.sync(); assert.equal((await runtime.status()).sources.length, 0);
    assert.equal(calls.visual, 0, "a completed plan never incurs a new visual model call");
  } finally {await runtime.stop(); await rm(directory, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});}
});

test("partial visual publication preserves retry backoff and resumes after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lawa-visual-backoff-"));
  await writeFile(join(directory, "providers.json"), JSON.stringify({profiles: [{id: "p", provider: "aliyun", model: "chat", baseUrl: "https://example.test/v1"}]}));
  const settings = new RetrievalSettingsStore(join(directory, "settings.json"), join(directory, "providers.json"), join(directory, "secrets.json"));
  await settings.save({...testRetrievalSettings, graphEnabled: false});
  let s = {...source("pdf"), visual_count: 4}, completed = 0, fail = true, plans = 0, analyses = 0;
  const backend: SourceBackend = {
    catalog: async () => ({sources: [s], next_offset: null, catalog_version: s.version}),
    chunks: async () => ({source: s, chunks: [chunk(s, "已经发布一页扫描文字")], next_offset: null}),
    visualPlan: async () => {plans++; return {source_hash: "h", parser_version: "p", total: 4, completed,
      assets: Array.from({length: Math.min(3, 4 - completed)}, (_,i) => ({id: "a" + (completed + i), unit: completed + i + 1, label: "page", context: "正文"}))};},
    visualAsset: async () => ({mime: "image/jpeg", data: "aGVsbG8="}),
    publishVisual: async () => {completed++; s = {...s, version: "v" + (completed + 1)}; return {};},
    context: async () => ({current_scope: "a", allowed_scopes: ["a"], lexical_query: "tmissing"}),
    validate: async refs => refs, read: async () => ({text: "原文"}),
  };
  const models: Models = {embed: async texts => texts.map(() => [1, ...Array(63).fill(0)]), rerank: async () => [],
    analyzeVisual: async () => {analyses++; if (fail && completed === 1) throw new Error("provider unavailable"); return {blocks: [], warnings: []};}};
  let runtime = new RetrievalRuntime(directory, backend, settings, () => models);
  try {
    await runtime.start(); await runtime.sync();
    const failed = (await runtime.status()).sources[0]!.derived!.vision!;
    assert.equal(failed.state, "failed"); assert.equal(failed.completed, 1); assert.equal(failed.version, s.version);
    assert.ok(failed.retry_at > Date.now()); assert.equal(failed.error_code, "VISUAL_PROCESSING_FAILED");
    await runtime.sync(); assert.equal(plans, 1); assert.equal(analyses, 2);
    await runtime.stop(); runtime = new RetrievalRuntime(directory, backend, settings, () => models);
    await runtime.start(); await runtime.sync(); assert.equal(plans, 1, "restart preserves backoff after visual_revision changed");
    fail = false; await runtime.retry();
    assert.equal(completed, 4); assert.equal((await runtime.status()).sources[0]!.derived!.vision!.state, "ready");
    const ready = {plans, analyses}; await runtime.sync(); assert.deepEqual({plans, analyses}, ready);
  } finally {await runtime.stop(); await rm(directory, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});}
});

test("large visual jobs rotate files, resume their cursor and do not block graph when disabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lawa-visual-queue-"));
  await writeFile(join(directory, "providers.json"), JSON.stringify({profiles: [{id: "p", provider: "aliyun", model: "chat", baseUrl: "https://example.test/v1"}]}));
  const settings = new RetrievalSettingsStore(join(directory, "settings.json"), join(directory, "providers.json"), join(directory, "secrets.json"));
  await settings.save(testRetrievalSettings);
  let sources = [{...source("large"), visual_count: 9}, {...source("small"), visual_count: 1}];
  const completed = new Map<string, number>(); let analyses = 0;
  const makeChunk = (s: SourceDescriptor) => chunk(s, s.name === "large" ? "太阳风撞击磁层，扰动磁层的形状。" : "磁层中的粒子进入大气，形成极光。");
  const backend: SourceBackend = {
    catalog: async () => ({sources, next_offset: null, catalog_version: JSON.stringify(sources)}),
    chunks: async id => {const s = sources.find(s => s.source_id === id)!; return {source: s, chunks: [makeChunk(s)], next_offset: null};},
    visualPlan: async id => {const total = sources.find(s => s.name === id)!.visual_count, done = completed.get(id) ?? 0;
      return {source_hash: "h", parser_version: "p", total, completed: done,
        assets: Array.from({length: Math.min(3, total - done)}, (_,i) => ({id: "a" + (done + i), unit: done + i + 1, label: "page", context: "正文"}))};},
    visualAsset: async () => ({mime: "image/jpeg", data: "aGVsbG8="}),
    publishVisual: async value => {const id = (value as any).material_id, done = (completed.get(id) ?? 0) + 1; completed.set(id, done);
      sources = sources.map(s => s.name === id ? {...s, version: "v" + (done + 1)} : s); return {};},
    context: async () => ({current_scope: "a", allowed_scopes: ["a"], lexical_query: "tmissing"}),
    validate: async refs => refs.filter(ref => {const r = JSON.parse(Buffer.from(ref, "base64url").toString());
      return sources.some(s => s.source_id === r.source_id && s.version === r.version);}),
    read: async ref => {const r = JSON.parse(Buffer.from(ref, "base64url").toString()); return {text: makeChunk(sources.find(s => s.source_id === r.source_id)!).text};},
  };
  const models: Models = {embed: async texts => texts.map(() => [1, ...Array(63).fill(0)]), rerank: async (_q,texts) => texts.map((_,index) => ({index, score: .9})),
    analyzeVisual: async () => {analyses++; return {blocks: [], warnings: []};}, extractGraph: async cs => extraction(cs[0]!)};
  let runtime = new RetrievalRuntime(directory, backend, settings, () => models);
  try {
    await runtime.start(); await runtime.sync(); assert.equal(completed.get("large"), 3); assert.equal(completed.get("small"), undefined);
    await runtime.stop(); runtime = new RetrievalRuntime(directory, backend, settings, () => models);
    await runtime.start(); await runtime.sync();
    assert.equal(completed.get("small"), 1, "another file gets the next turn after a large file consumed the visual budget");
    assert.equal(completed.get("large"), 5); assert.equal(analyses, 6);
    await settings.save({...await settings.get(), visionEnabled: false}); await runtime.sync();
    assert.equal(analyses, 6); assert.ok((await runtime.status()).sources.every(s => s.derived?.graph?.state === "ready"));
    const search = await runtime.search({query: "太阳风"});
    assert.ok((await runtime.trace(search.trace_id))?.stages.graph?.some(s => (s.graph_context as any[])?.length === 2));
    assert.ok(search.matches.some(hit => hit.graph_context?.length));
    assert.match(String((await runtime.read(search.matches[0]!.source_ref, "current", {}, null, search.trace_id)).text), /磁层/);
    await settings.save({...await settings.get(), visionEnabled: true}); await runtime.sync(); await runtime.sync();
    assert.equal(completed.get("large"), 9); assert.equal(analyses, 10);
    assert.ok((await runtime.status()).sources.every(s => s.derived?.vision?.state === "ready" && s.derived?.graph?.state === "ready"));
    sources = sources.filter(s => s.name !== "large"); await runtime.sync();
    const deleted = await runtime.search({query: "太阳风"}); assert.ok(deleted.matches.every(hit => hit.source_id !== "material:large"));
    assert.equal((await runtime.status()).graph_relations, 1);
  } finally {await runtime.stop(); await rm(directory, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});}
});

test("graph extraction validates exact quote, endpoints and allowed chunk", () => {
  const c = chunk(source("first"), "太阳风撞击磁层，扰动磁层的形状。");
  assert.equal(validateGraph(extraction(c), [c]).relations[0]?.source_ref, c.source_ref);
  const aliases = extraction(c); aliases.entities[0]!.aliases = ["invented synonym"] as never[];
  assert.deepEqual(validateGraph(aliases, [c]).entities[0]?.aliases, []);
  const overflow = extraction(c);
  overflow.entities.push(...Array.from({length: 52}, (_,i) => ({name: "无关概念" + i, aliases: []})));
  const clipped = validateGraph(overflow, [c]);
  assert.equal(clipped.truncated_entities, 14); assert.equal(clipped.relations.length, 1);
  for (const change of [{quote: "太阳风与磁层是同一事物"}, {chunk_id: "missing"}, {to: "虚构概念"}, {source_ref: "forbidden"}]) {
    const value = extraction(c); Object.assign(value.relations[0]!, change);
    const checked = validateGraph(value, [c]); assert.equal(checked.relations.length, 0); assert.equal(checked.rejected, 1);
  }
});

test("two-hop graph recovers another source and respects Goal/draft/type/file filters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lawa-graph-"));
  const graph = new SourceGraphStore(directory);
  const sources = [source("first"), source("second"), source("secret", "draft:other")];
  const chunks = sources.map((s,i) => chunk(s, i === 0 ? "太阳风撞击磁层，扰动磁层的形状。" : "磁层中的粒子进入大气，形成极光。"));
  const models: Models = {embed: async texts => texts.map(() => [1, 0]), rerank: async () => [], extractGraph: async rows => extraction(rows[0]!)};
  const rows = chunks.map((c,i) => ({id: "id" + i, source_id: sources[i]!.source_id, source_version: "v1", kind: "material", scope_id: sources[i]!.goal_id ?? "draft:other",
    name: sources[i]!.name, source_ref: c.source_ref, locator_json: JSON.stringify(c.locator), text: c.text, score: 0, score_parts: {}} as Candidate));
  const index = {references: async (refs: string[], scopes: string[], kinds?: string[], materialId?: string) => rows.filter(r =>
    refs.includes(r.source_ref) && scopes.includes(r.scope_id) && (!kinds?.length || kinds.includes(r.kind)) && (!materialId || r.source_id === "material:" + materialId))} as any;
  try {
    for (let i = 0; i < sources.length; i++) await graph.append(sources[i]!, "f", [chunks[i]!], 1, true, models);
    const hits = await graph.search("太阳风", undefined, ["a"], index);
    assert.equal(hits.length, 2);
    const second = hits.find(h => h.source_id === "material:second")!;
    assert.equal(second.graph_context?.length, 2);
    assert.equal(second.graph_context?.[0]?.source_ref, chunks[0]?.source_ref);
    assert.equal((await graph.search("太阳风", undefined, ["a"], index, ["card"])).length, 0);
    assert.equal((await graph.search("太阳风", undefined, ["a"], index, undefined, "first")).length, 1);
    await graph.remove("material:first");
    assert.equal((await graph.search("太阳风", undefined, ["a"], index)).length, 0);
  } finally {await rm(directory, {recursive: true, force: true});}
});

test("runtime persists graph cursor, validates paths, retries failure and removes deleted contributions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lawa-derived-"));
  const provider = join(directory, "providers.json"), secrets = join(directory, "secrets.json");
  await writeFile(provider, JSON.stringify({profiles: [{id: "p", provider: "aliyun", model: "chat", baseUrl: "https://example.test/v1"}]}));
  const settings = new RetrievalSettingsStore(join(directory, "settings.json"), provider, secrets);
  await settings.save(testRetrievalSettings);
  let sources = [source("first"), source("second")], fail = true;
  let graphCalls = 0;
  const makeChunks = (s: SourceDescriptor) => s.name === "first"
    ? Array.from({length: 7}, (_,i) => chunk(s, "太阳风撞击磁层，扰动磁层的形状。", i))
    : [chunk(s, "磁层中的粒子进入大气，形成极光。")];
  const backend: SourceBackend = {
    catalog: async () => ({sources, next_offset: null, catalog_version: JSON.stringify(sources)}),
    chunks: async (id, offset = 0) => {const s = sources.find(s => s.source_id === id)!;
      return {source: s, chunks: makeChunks(s).slice(offset), next_offset: null};},
    context: async () => ({current_scope: "a", allowed_scopes: ["a"], lexical_query: "tmissing"}),
    validate: async refs => refs.filter(ref => {const r = JSON.parse(Buffer.from(ref, "base64url").toString());
      return sources.some(s => s.source_id === r.source_id && s.version === r.version);}),
    read: async () => ({text: "原文", estimated_tokens: 2}),
  };
  const models: Models = {embed: async texts => texts.map(() => [1, ...Array(63).fill(0)]),
    rerank: async (_q,texts) => texts.map((_,index) => ({index, score: .9})),
    extractGraph: async cs => {graphCalls++; if (fail && cs[0]!.text.includes("太阳风")) throw new Error("no provider");
      const value = extraction(cs[0]!); value.relations = cs.map(c => ({...value.relations[0]!, chunk_id: c.chunk_id, quote: c.text})); return value;}};
  let runtime = new RetrievalRuntime(directory, backend, settings, () => models);
  try {
    await runtime.start(); await runtime.sync();
    assert.equal((await runtime.status()).sources.find(s => s.source_id === "material:first")?.derived?.graph?.state, "failed");
    fail = false; await runtime.retry();
    assert.equal((await runtime.status()).sources.find(s => s.source_id === "material:first")?.derived?.graph?.completed, 5);
    await runtime.stop();
    runtime = new RetrievalRuntime(directory, backend, settings, () => models);
    await runtime.start(); await runtime.sync();
    assert.equal((await runtime.status()).sources.find(s => s.source_id === "material:first")?.derived?.graph?.state, "ready");
    const calls = graphCalls; await runtime.sync(); assert.equal(graphCalls, calls);
    const hits = await runtime.search({query: "太阳风"});
    assert.ok(hits.matches.some(h => h.graph_context?.length));
    const trace = await runtime.trace(hits.trace_id); assert.ok(trace?.stages.graph?.length);
    sources = sources.filter(s => s.name !== "first");
    const afterDelete = await runtime.search({query: "太阳风"});
    assert.ok(afterDelete.matches.every(h => !h.graph_context?.some(e => e.source_ref === makeChunks(source("first"))[0]!.source_ref)));
    await runtime.sync();
    assert.equal((await runtime.status()).graph_relations, 1);
  } finally {await runtime.stop(); await rm(directory, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});}
});

test("visual and graph roles use saved chat endpoint without serializing credential or allowing scope output", async () => {
  const calls: any[] = [];
  const config = {version: 1 as const, enabled: true, profileId: "p", embeddingModel: "emb", dimensions: 64,
    embeddingUrl: "https://example.test/embeddings", rerankModel: "rank", rerankUrl: "https://example.test/reranks", minimumRerankScore: .5,
    visionModel: "vision", extractionModel: "extract"};
  const models = new BailianRetrievalModels(config, async () => "secret", (async (url, init) => {
    const body = JSON.parse(init!.body as string); calls.push({url, body});
    return new Response(JSON.stringify({choices: [{message: {content: JSON.stringify(body.model === "vision" ? {blocks: [], warnings: []} : {entities: [], relations: []})}}]}));
  }) as typeof fetch, async () => ({model: "chat", url: "https://example.test/chat/completions"}));
  await models.analyzeVisual({mime: "image/jpeg", data: "aGVsbG8="}, "原文");
  await models.extractGraph([{chunk_id: "c1", text: "正文"}]);
  assert.equal(calls[0].body.model, "vision"); assert.equal(calls[1].body.model, "extract");
  assert.match(calls[0].body.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.ok(!JSON.stringify(calls).includes("secret"));
});

test("derived failures expose safe HTTP, JSON and validation codes without response text", async () => {
  const config = {version: 1 as const, enabled: true, profileId: "p", embeddingModel: "emb", dimensions: 64,
    embeddingUrl: "https://example.test/embeddings", rerankModel: "rank", rerankUrl: "https://example.test/reranks", minimumRerankScore: .5};
  for (const [value, status, code] of [
    [{error: {message: "test-secret-do-not-log"}}, 400, "MODEL_HTTP_400"],
    [{choices: [{message: {content: "test-secret-invalid-json"}}]}, 200, "INVALID_DERIVED_JSON"],
    [{choices: [{finish_reason: "length", message: {content: "test-secret-truncated"}}]}, 200, "DERIVED_OUTPUT_TRUNCATED"],
  ] as const) {
    const models = new BailianRetrievalModels(config, async () => "test-secret", (async () => new Response(JSON.stringify(value), {status})) as typeof fetch,
      async () => ({model: "chat", url: "https://example.test/chat/completions"}));
    await assert.rejects(models.analyzeVisual({mime: "image/jpeg", data: "aGVsbG8="}, "原文"), (error: any) => {
      assert.equal(error.code, code); assert.ok(!String(error).includes("test-secret")); return true;
    });
  }
  const backend = new KernelSourceBackend("http://127.0.0.1:8000", (async () => new Response(JSON.stringify({code: "INVALID_VISUAL_ANALYSIS", detail: "test-secret-do-not-log"}), {status: 400})) as typeof fetch);
  await assert.rejects(backend.publishVisual({}), (error: any) => {
    assert.equal(error.code, "INVALID_VISUAL_ANALYSIS"); assert.equal(error.status, 400); assert.ok(!String(error).includes("test-secret")); return true;
  });
});

test("graph cache corruption rebuilds and technical punctuation cannot merge different concepts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lawa-graph-integrity-"));
  const graph = new SourceGraphStore(directory);
  try {
    const sources = [source("cpp"), source("csharp")];
    for (const [i,s] of sources.entries()) {
      const name = i ? "C#" : "C++", endpoint = i ? "generics" : "templates", quote = `${name} supports ${endpoint} for reusable code.`;
      await graph.save({source_id: s.source_id, version: s.version, scope_id: "a", kind: "material", fingerprint: "f", cursor: 1, ready: true,
        entities: [{name, aliases: []}, {name: endpoint, aliases: []}], relations: [{from: name, to: endpoint, relation: "supports", quote,
          source_ref: chunk(s, quote).source_ref, vector: [1, 0]}]});
    }
    const index = {references: async (refs: string[]) => refs.map(ref => ({source_ref: ref, id: ref, text: "", score_parts: {}}))} as any;
    assert.equal((await graph.search("C++", undefined, ["a"], index)).length, 1);
    const path = join(directory, (await readdir(directory))[0]!);
    const value = JSON.parse(await readFile(path, "utf8")); value.record.cursor = 100;
    await writeFile(path, JSON.stringify(value));
    assert.equal(await graph.load(value.record.source_id), null);
    assert.equal((await graph.records()).length, 1);
  } finally {await rm(directory, {recursive: true, force: true});}
});
