import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {RetrievalRuntime} from "./retrieval/runtime.js";
import {BailianRetrievalModels, RetrievalSettingsStore} from "./retrieval/settings.js";
import {SourceGraphStore, validateGraph} from "./retrieval/graph.js";
import type {IndexRow, Models, SourceBackend, SourceChunk, SourceDescriptor} from "./retrieval/types.js";
import {sourceIndexLabel} from "../web/src/retrievalView.js";

test("native-text graph progresses while an 800-page PDF still has pending visuals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lawa-graph-pending-"));
  const provider = join(directory, "providers.json");
  await writeFile(provider, JSON.stringify({profiles: [{id: "p", provider: "aliyun", model: "chat", baseUrl: "https://example.test/v1"}]}));
  const settings = new RetrievalSettingsStore(join(directory, "settings.json"), provider, join(directory, "secrets.json"));
  await settings.save({...await settings.get(), enabled: true, profileId: "p", dimensions: 64});
  const source: SourceDescriptor = {source_id: "material:long", kind: "material", name: "long.pdf", goal_id: "goal",
    goal_name: "goal", draft_session_id: null, skill_id: "", version: "v1", parse_status: "ready", warnings: [], visual_count: 800};
  const text = "太阳风撞击磁层，扰动磁层的形状。";
  const row: SourceChunk = {chunk_id: "c1", ordinal: 0, text, heading: null,
    source_ref: Buffer.from(JSON.stringify({source_id: source.source_id, version: source.version, chunk_id: "c1"})).toString("base64url"),
    locator: {kind: "page", start: 1, end: 1, char_start: 0, char_end: text.length},
    embedding_text: text, lexical_text: text, embedding_hash: "text"};
  let visuals = 0, graphs = 0;
  const backend: SourceBackend = {
    catalog: async () => ({sources: [source], next_offset: null, catalog_version: "v1"}),
    chunks: async () => ({source, chunks: [row], next_offset: null}),
    visualPlan: async () => ({source_hash: "h", parser_version: "p", total: 800, completed: visuals,
      assets: Array.from({length: 3}, (_, n) => ({id: "page-" + (visuals + n), unit: visuals + n + 1, label: "page", context: text}))}),
    visualAsset: async () => ({mime: "image/jpeg", data: "aGVsbG8="}),
    publishVisual: async () => {visuals++; return {};},
    context: async () => ({current_scope: "goal", allowed_scopes: ["goal"], lexical_query: text}),
    validate: async refs => refs,
    read: async () => ({text}),
  };
  const models: Models = {embed: async texts => texts.map(() => [1, ...Array(63).fill(0)]), rerank: async () => [],
    analyzeVisual: async () => ({blocks: [], warnings: []}),
    extractGraph: async () => {graphs++; return {entities: [{name: "太阳风", aliases: []}, {name: "磁层", aliases: []}],
      relations: [{from: "太阳风", to: "磁层", relation: "扰动", chunk_id: row.chunk_id, quote: text}]};}};
  const runtime = new RetrievalRuntime(directory, backend, settings, () => models);
  try {
    await runtime.start(); await runtime.sync();
    const status = await runtime.status();
    assert.equal(status.sources[0]?.derived?.vision?.state, "pending");
    assert.equal(visuals, 3);
    assert.equal(graphs, 1, "existing native text must not wait for all 800 page images");
    assert.equal(status.graph_relations, 1);
  } finally {await runtime.stop(); await rm(directory, {recursive: true, force: true});}
});

test("undeclared literal endpoints and whitespace-only quote changes retain actual source evidence", () => {
  const text = "太阳风\n撞击磁层，扰动磁层的形状。";
  const row = {chunk_id: "c", text, source_ref: "ref"} as SourceChunk;
  const result = validateGraph({entities: [{name: "太阳风", aliases: []}],
    relations: [{from: "太阳风", to: "磁层", relation: "扰动", chunk_id: "c", quote: text.replace("\n", " ")}]}, [row]);
  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0]?.quote, text, "the saved quote must be the original continuous substring");
  assert.ok(result.entities.some(e => e.name === "磁层"));
  assert.equal(validateGraph({entities: [], relations: [{from: "太阳风", to: "虚构术语", relation: "影响", chunk_id: "c", quote: text}]}, [row]).relations.length, 0);
});

test("a graph survives visual version changes only for unchanged grounded chunks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lawa-graph-rebase-"));
  const graph = new SourceGraphStore(directory);
  const source: SourceDescriptor = {source_id: "material:pdf", version: "v1", kind: "material", name: "pdf", goal_id: "goal", goal_name: "goal", draft_session_id: null, skill_id: "", parse_status: "ready", warnings: []};
  const text = "太阳风撞击磁层，扰动磁层的形状。";
  const row = {chunk_id: "c1", text, source_ref: "old-ref", ordinal: 0} as SourceChunk;
  const models: Models = {embed: async texts => texts.map(() => [1, 0]), rerank: async () => [], extractGraph: async () => ({entities: [{name: "太阳风", aliases: []}, {name: "磁层", aliases: []}], relations: [{from: "太阳风", to: "磁层", relation: "扰动", chunk_id: "c1", quote: text}]})};
  try {
    await graph.append(source, "fingerprint", [row], 1, true, models);
    const newer = {...source, version: "v2"};
    const current: IndexRow = {id: "index-row", chunk_id: "c1", ordinal: 0, text, source_ref: "current-ref",
      source_id: source.source_id, source_version: "v2", scope_id: "goal", kind: "material", name: "pdf", goal_name: "goal",
      skill_id: "", heading: "", locator_json: "{}", lexical_text: text, embedding_hash: "text", vector: [1,0], has_vector: true};
    await graph.rebase(newer, "fingerprint", [current]);
    const kept = await graph.load(source.source_id);
    assert.equal(kept?.relations[0]?.source_ref, "current-ref");
    assert.equal(kept?.cursor, 1);
    await graph.rebase({...newer, version: "v3"}, "fingerprint", [{...current, source_version: "v3", text: "原内容已改变。"}]);
    assert.equal((await graph.load(source.source_id))?.relations.length, 0);
    await graph.rebase({...newer, goal_id: "other"}, "fingerprint", [{...current, scope_id: "other"}]);
    assert.equal(await graph.load(source.source_id), null, "scope changes cannot reuse a different Goal's graph");
  } finally {await rm(directory, {recursive: true, force: true});}
});

test("visual revisions and process restart advance native graph batches without starting over", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lawa-graph-resume-"));
  const provider = join(directory, "providers.json");
  await writeFile(provider, JSON.stringify({profiles: [{id: "p", provider: "aliyun", model: "chat", baseUrl: "https://example.test/v1"}]}));
  const settings = new RetrievalSettingsStore(join(directory, "settings.json"), provider, join(directory, "secrets.json"));
  await settings.save({...await settings.get(), enabled: true, profileId: "p", dimensions: 64});
  let revision = 0;
  const source = (): SourceDescriptor => ({source_id: "material:long", kind: "material", name: "long.pdf", goal_id: "goal",
    goal_name: "goal", draft_session_id: null, skill_id: "", version: "v" + revision, parse_status: "ready", warnings: [], visual_count: 800});
  const chunks = (): SourceChunk[] => Array.from({length: 12}, (_, ordinal) => {
    const text = `第${ordinal + 1}段：太阳风撞击磁层，扰动磁层的形状。`;
    return {chunk_id: `v${revision}-c${ordinal}`, ordinal, text, heading: null, source_ref: `v${revision}-ref${ordinal}`,
      locator: {kind: "page", start: ordinal + 1, end: ordinal + 1, char_start: 0, char_end: text.length},
      embedding_text: text, lexical_text: text, embedding_hash: "text-" + ordinal};
  });
  const seen: number[][] = [];
  const backend: SourceBackend = {
    catalog: async () => ({sources: [source()], next_offset: null, catalog_version: source().version}),
    chunks: async (_id, offset = 0) => ({source: source(), chunks: chunks().slice(offset), next_offset: null}),
    visualPlan: async () => ({source_hash: "h", parser_version: "p", total: 800, completed: revision,
      assets: Array.from({length: 3}, (_, n) => ({id: "page-" + (revision + n), unit: revision + n + 1, label: "page", context: ""}))}),
    visualAsset: async () => ({mime: "image/jpeg", data: "aGVsbG8="}),
    publishVisual: async () => {revision++; return {};},
    context: async () => ({current_scope: "goal", allowed_scopes: ["goal"], lexical_query: "太阳风"}),
    validate: async refs => refs, read: async () => ({text: ""}),
  };
  const models: Models = {embed: async texts => texts.map(() => [1, ...Array(63).fill(0)]), rerank: async () => [],
    analyzeVisual: async () => ({blocks: [], warnings: []}),
    extractGraph: async batch => {
      seen.push(batch.map(c => Number(c.chunk_id.split("-c")[1])));
      return {entities: [], relations: batch.map(c => ({from: "太阳风", to: "磁层", relation: "扰动", chunk_id: c.chunk_id, quote: c.text}))};
    }};
  let runtime = new RetrievalRuntime(directory, backend, settings, () => models);
  try {
    await runtime.start(); await runtime.sync(); await runtime.sync(); await runtime.stop();
    runtime = new RetrievalRuntime(directory, backend, settings, () => models);
    await runtime.start(); await runtime.sync();
    const status = await runtime.status();
    assert.deepEqual(seen, [[0,1,2,3,4], [5,6,7,8,9], [10,11]]);
    assert.equal(status.sources[0]?.derived?.vision?.state, "pending");
    assert.equal(status.sources[0]?.derived?.graph?.state, "ready");
    assert.equal(status.graph_relations, 12);
    await runtime.sync();
    assert.equal(seen.length, 3, "a visual-only revision must not repeat finished native batches");
    const again = await runtime.status();
    assert.equal(again.graph_relations, 12);
    assert.equal(again.sources[0]?.derived?.graph?.state, "ready");
  } finally {await runtime.stop(); await rm(directory, {recursive: true, force: true});}
});

test("invalid or unused model entries do not consume the grounded relation budget", () => {
  const text = "太阳风撞击磁层，扰动磁层的形状。";
  const row = {chunk_id: "c", text, source_ref: "ref"} as SourceChunk;
  const valid = {from: "太阳风", to: "磁层", relation: "扰动", chunk_id: "c", quote: text};
  const result = validateGraph({entities: Array.from({length: 40}, (_, i) => ({name: "无关实体" + i, aliases: []})),
    relations: [...Array.from({length: 60}, () => ({...valid, quote: "模型改写了原文里的说明。"})), valid]}, [row]);
  assert.equal(result.relations.length, 1);
  assert.equal(result.rejected, 60);
  assert.equal(result.rejection_reasons.quote_not_exact, 60);
});

test("quote repair rejects altered punctuation, numbers, wording and ambiguous whitespace matches", () => {
  const text = "太阳风在2026年撞击磁层，扰动磁层的形状。";
  const row = {chunk_id: "c", text, source_ref: "ref"} as SourceChunk;
  const value = (quote: string) => ({entities: [], relations: [{from: "太阳风", to: "磁层", relation: "扰动", chunk_id: "c", quote}]});
  for (const quote of [text.replace("2026", "2025"), text.replace("，", ","), text.replace("撞击", "影响")]) {
    assert.equal(validateGraph(value(quote), [row]).relations.length, 0);
  }
  const quote = text.replace("撞击", "撞 击");
  assert.equal(validateGraph(value(quote), [{...row, text: text + "\n" + text}]).relations.length, 0);
});

test("material status distinguishes usable graph relations from completed but empty extraction", () => {
  const label = sourceIndexLabel({source_id: "s", state: "ready", derived: {graph: {state: "ready", completed: 178, total: 178,
    relations: 169, rejected_relations: 446, rejection_reasons: {quote_not_exact: 200, endpoint_not_grounded: 246}}}});
  assert.match(label, /169 条关系已纳入/);
  assert.match(label, /446 条未通过校验/);
  assert.match(label, /引文不一致 200/);
  assert.match(sourceIndexLabel({source_id: "s", state: "ready", derived: {graph: {state: "ready", completed: 1, total: 1, relations: 0}}}), /未提取到有出处的关系/);
  assert.doesNotMatch(sourceIndexLabel({source_id: "s", state: "ready", derived: {graph: {state: "ready", completed: 1, total: 1}}}), /未提取到/);
});

test("ambiguous relocated text is re-extracted and a changed model cannot reuse old batches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lawa-graph-ambiguous-"));
  const graph = new SourceGraphStore(directory);
  const source: SourceDescriptor = {source_id: "material:pdf", version: "v1", kind: "material", name: "pdf", goal_id: "goal",
    goal_name: "goal", draft_session_id: null, skill_id: "", parse_status: "ready", warnings: []};
  const text = "太阳风撞击磁层，扰动磁层的形状。";
  const row = {chunk_id: "c", text, source_ref: "old-ref", ordinal: 0} as SourceChunk;
  let calls = 0;
  const models: Models = {embed: async texts => texts.map(() => [1,0]), rerank: async () => [], extractGraph: async chunks => {
    calls++; return {entities: [], relations: chunks.map(c => ({from: "太阳风", to: "磁层", relation: "扰动", chunk_id: c.chunk_id, quote: c.text}))};
  }};
  const current: IndexRow = {id: "i", chunk_id: "new-c", ordinal: 0, text, source_ref: "new-ref", source_id: source.source_id,
    source_version: "v2", scope_id: "goal", kind: "material", name: "pdf", goal_name: "goal", skill_id: "", heading: "",
    locator_json: "{}", lexical_text: text, embedding_hash: "text", vector: [1,0], has_vector: true};
  try {
    await graph.append(source, "f1", [row], 1, true, models);
    const newer = {...source, version: "v2"};
    await graph.rebase(newer, "f1", [current, {...current, id: "i2", ordinal: 1, chunk_id: "new-c2", source_ref: "new-ref2"}]);
    assert.equal((await graph.load(source.source_id))?.relations.length, 0, "identical text in two new positions cannot choose a citation arbitrarily");
    assert.equal((await graph.load(source.source_id))?.cursor, 0);
    await graph.append(newer, "f1", [{...row, chunk_id: "new-c", source_ref: "new-ref"}], 1, true, models);
    assert.equal(await graph.rebase(newer, "f2", [current]), null);
    await graph.append(newer, "f2", [{...row, chunk_id: "new-c", source_ref: "new-ref"}], 1, true, models);
    assert.equal(calls, 3, "a new extraction fingerprint requires a real extraction");
    assert.equal((await graph.load(source.source_id))?.fingerprint, "f2");
    await assert.rejects(graph.append(newer, "f2", [{...row, chunk_id: "more", source_ref: "more-ref"}], 2, true,
      {...models, embed: async () => []}), /GRAPH_VECTOR_INVALID/);
    assert.equal((await graph.load(source.source_id))?.cursor, 1, "invalid vectors do not commit a batch or advance progress");
    assert.equal((await graph.load(source.source_id))?.relations.length, 1);
    const corrupted = (await graph.load(source.source_id))!;
    corrupted.batches![0]!.chunks[0]!.text_hash = "broken";
    await graph.save(corrupted);
    assert.equal(await graph.load(source.source_id), null, "a well-checksummed but malformed resume record is rebuilt");
  } finally {await rm(directory, {recursive: true, force: true});}
});

test("background graph keeps its 90-second budget with a Goal cancellation signal", async t => {
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {deadlines.push(ms); return new AbortController().signal;});
  const parent = new AbortController();
  const fetcher = (async (_url, init) => {
    (init?.signal as AbortSignal).throwIfAborted();
    return new Response(JSON.stringify({choices: [{finish_reason: "stop", message: {content: '{"entities":[],"relations":[]}'}}]}));
  }) as typeof fetch;
  const models = new BailianRetrievalModels({version: 1, enabled: true, profileId: "p", embeddingModel: "e", dimensions: 64,
    embeddingUrl: "https://example.test/embeddings", rerankModel: "r", rerankUrl: "https://example.test/reranks", minimumRerankScore: .5},
    async () => "fixture", fetcher, async () => ({model: "chat", url: "https://example.test/chat/completions"}));
  await models.extractGraph([{chunk_id: "c", text: "原文"}], parent.signal);
  assert.equal(deadlines[0], 90_000, "cancellation support must not shorten the background graph budget to 30 seconds");
  await models.analyzeVisual({mime: "image/jpeg", data: "aGVsbG8="}, "", parent.signal);
  assert.equal(deadlines[1], 30_000, "the separate visual role retains its current policy");
  parent.abort();
  await assert.rejects(models.extractGraph([{chunk_id: "c", text: "原文"}], parent.signal), {name: "AbortError"});
});
