import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, utimes, writeFile, readdir } from "node:fs/promises";
import * as lancedb from "@lancedb/lancedb";
import {SourceGraphStore} from "./retrieval/graph.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RetrievalRuntime } from "./retrieval/runtime.js";
import { RetrievalSettingsStore, BailianRetrievalModels, refineQueryText } from "./retrieval/settings.js";
import { SourceReadBudget } from "./retrieval/tools.js";
import { LocalRetrievalIndex } from "./retrieval/store.js";
import { testRetrievalSettings } from "./retrieval/testSettings.js";
import type { Models, SourceBackend, SourceChunk, SourceDescriptor } from "./retrieval/types.js";

function descriptor(id: string, goal = "goal-a"): SourceDescriptor {
  return { source_id: id, kind: id.startsWith("card:") ? "card" : "material", name: id,
    goal_id: goal.startsWith("draft:") ? null : goal, draft_session_id: goal.startsWith("draft:") ? goal.slice(6) : null,
    goal_name: goal, skill_id: "", version: "v1", parse_status: "ready", warnings: [] };
}
function chunk(source: SourceDescriptor, text: string): SourceChunk {
  return { chunk_id: "chunk-1", ordinal: 0, text, heading: null,
    locator: { kind: "line", start: 1, end: 1, char_start: 0, char_end: text.length },
    source_ref: Buffer.from(JSON.stringify({ source_id: source.source_id, version: source.version, chunk_id: "chunk-1" })).toString("base64url"),
    embedding_text: text, lexical_text: text.includes("HTTP") ? "thttp tclient" : "tother",
    embedding_hash: text };
}
class FixtureBackend implements SourceBackend {
  sources = [descriptor("material:first"), descriptor("card:second", "goal-b"), descriptor("material:other-draft", "draft:secret")];
  texts = new Map([["material:first", "HTTP client sends a request."], ["card:second", "HTTP client uses TCP."],
    ["material:other-draft", "HTTP secret draft."]]);
  current = "goal-a";
  async catalog() { return { sources: this.sources, next_offset: null, catalog_version: JSON.stringify(this.sources) }; }
  async chunks(id: string) {
    const source = this.sources.find(row => row.source_id === id)!;
    return { source, chunks: [chunk(source, this.texts.get(id)!)], next_offset: null };
  }
  async context(query: string, scope: "current" | "library", draft?: string | null) {
    const current = draft ? "draft:" + draft : this.current;
    return { current_scope: current, allowed_scopes: scope === "library" ? ["goal-a", "goal-b", current] : [current],
      lexical_query: query.includes("HTTP") ? "thttp tclient" : "tunknown" };
  }
  async validate(refs: string[], scope: "current" | "library", draft?: string | null) {
    const current = draft ? "draft:" + draft : this.current;
    return refs.filter(ref => {
      const value = JSON.parse(Buffer.from(ref, "base64url").toString());
      const source = this.sources.find(row => row.source_id === value.source_id);
      return source && source.version === value.version &&
        ((source.goal_id ?? "draft:" + source.draft_session_id) === current || scope === "library" && Boolean(source.goal_id));
    });
  }
  async read(ref: string, scope: "current" | "library", _options?: Record<string, string | number>, draft?: string | null) {
    if (!(await this.validate([ref], scope, draft)).length) throw new Error("STALE_OR_FORBIDDEN");
    const payload = JSON.parse(Buffer.from(ref, "base64url").toString());
    return { text: this.texts.get(payload.source_id), citation: payload.source_id + "，第 1 行",
      citation_ref: payload.source_id + ":line:1-1", estimated_tokens: 12 };
  }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "lawa-retrieval-"));
  const profiles = join(directory, "providers.json"), secrets = join(directory, "secrets.json");
  await writeFile(profiles, JSON.stringify({ activeProfileId: "p", profiles: [{ id: "p", provider: "aliyun-bailian",
    model: "chat", baseUrl: "https://example.test/compatible-mode/v1" }] }));
  await writeFile(secrets, JSON.stringify({ apiKeys: { p: "test-secret-do-not-log" } }));
  const settings = new RetrievalSettingsStore(join(directory, "settings.json"), profiles, secrets);
  await settings.save(testRetrievalSettings);
  const backend = new FixtureBackend();
  const calls = { embed: 0, rerank: 0, failEmbed: false, failRerank: false, delayed: false };
  const models: Models = {
    async embed(texts, signal) {
      calls.embed += texts.length;
      if (calls.failEmbed) throw new Error("test");
      if (calls.delayed) await new Promise((_, reject) => {
        if (signal?.aborted) reject(new Error("abort"));
        else signal?.addEventListener("abort", () => reject(new Error("abort")), { once: true });
      });
      return texts.map(text => [text.includes("HTTP") ? 1 : -1, ...Array(63).fill(.01)]);
    },
    async rerank(query, texts) {
      calls.rerank++;
      if (calls.failRerank) throw new Error("test");
      return texts.map((text,index) => ({ index, score: query.includes("HTTP") && text.includes("HTTP") ? .9 : .01 }));
    },
  };
  const factory = (config: { dimensions: number }): Models => ({ ...models,
    async embed(texts, signal) {
      const vectors = await models.embed(texts, signal);
      return vectors.map(vector => [...vector, ...Array(Math.max(0,config.dimensions-vector.length)).fill(.01)].slice(0,config.dimensions));
    } });
  const runtime = new RetrievalRuntime(directory, backend, settings, factory);
  await runtime.start(); await runtime.sync();
  return { directory, backend, settings, calls, models, factory, runtime,
    async close() { await runtime.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } };
}
test("first retrieval read stays blank and does not write or adopt an existing model profile", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lawa-retrieval-defaults-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const profiles = join(directory, "providers.json");
  await writeFile(profiles, JSON.stringify({activeProfileId: "p", profiles: [
    {id: "p", provider: "aliyun-bailian", model: "chat", baseUrl: "https://example.test/v1"},
  ]}));
  const settings = new RetrievalSettingsStore(join(directory, "settings.json"), profiles, join(directory, "secrets.json"));
  const fresh = await settings.publicSettings();
  assert.equal(fresh.enabled, false);
  assert.equal(fresh.visionEnabled, false);
  assert.equal(fresh.graphEnabled, false);
  assert.deepEqual([fresh.profileId, fresh.embeddingModel, fresh.embeddingUrl, fresh.rerankModel, fresh.rerankUrl,
    fresh.visionModel, fresh.extractionModel], ["", "", "", "", "", "", ""]);
  assert.equal(fresh.profiles[0]?.id, "p", "saved teaching profiles remain available to select");
  await assert.rejects(readFile(settings.path), {code: "ENOENT"});
  await settings.save(testRetrievalSettings);
  assert.deepEqual(await settings.get(), {...testRetrievalSettings, visionEnabled: true, graphEnabled: true,
    visionModel: "", extractionModel: ""});
});
test("native hybrid search enforces Goal/draft isolation and records actual read locators", async () => {
  const f = await fixture();
  try {
    const own = await f.runtime.search({ query: "HTTP client" });
    assert.equal(own.matches.length, 1);
    assert.equal(own.matches[0]?.source_id, "material:first");
    assert.ok(Number.isFinite(own.matches[0]?.score));
    const trace = await f.runtime.trace(own.trace_id);
    assert.equal(trace?.stages.bm25?.length, 1);
    assert.ok(Number.isFinite(Number(trace?.stages.bm25?.[0]?.score)));
    const extended = await f.runtime.search({ query: "HTTP", scope: "library" });
    assert.deepEqual(new Set(extended.matches.map(row => row.source_id)), new Set(["material:first", "card:second"]));
    await f.runtime.read(own.matches[0]!.source_ref, "current", {}, null, own.trace_id);
    assert.equal((await f.runtime.trace(own.trace_id))?.reads.length, 1);
    await f.runtime.recordMaterialRead("first", { chunk_id: "chunk-1", citation: "legacy material, line 1",
      citation_ref: "material:first:line:1-1", locator: { kind: "line", start: 1, end: 1 }, estimated_tokens: 12 });
    assert.equal((await f.runtime.trace(extended.trace_id))?.reads.length, 1);
    const draft = await f.runtime.search({ query: "HTTP" }, "fresh");
    assert.equal(draft.matches.length, 0);
  } finally { await f.close(); }
});
test("incremental vector reuse, edits, deletion and cached query are observable", async () => {
  const f = await fixture();
  try {
    const built = f.calls.embed;
    await f.runtime.sync(); assert.equal(f.calls.embed, built);
    const first = await f.runtime.search({ query: "HTTP" });
    const queried = f.calls.embed;
    await f.runtime.search({ query: "HTTP" }); assert.equal(f.calls.embed, queried);
    f.backend.sources[0]!.version = "v2";
    assert.equal((await f.runtime.search({ query: "HTTP" })).matches.length, 0);
    await assert.rejects(f.runtime.read(first.matches[0]!.source_ref));
    await f.runtime.sync(); assert.equal(f.calls.embed, queried); // same text vector reused, different source version
    assert.equal((await f.runtime.search({ query: "HTTP" })).matches.length, 1);
    f.backend.sources = f.backend.sources.filter(row => row.source_id !== "material:first");
    assert.equal((await f.runtime.search({ query: "HTTP" })).matches.length, 0);
    await f.runtime.sync(); assert.equal((await f.runtime.status()).chunks, 2);
  } finally { await f.close(); }
});
test("no-answer threshold and cloud degradation are separate outcomes", async () => {
  const f = await fixture();
  try {
    const missing = await f.runtime.search({ query: "unknown question" });
    assert.equal(missing.status, "no_relevant_match");
    f.calls.failEmbed = true; f.calls.failRerank = true;
    const fallback = await f.runtime.search({ query: "HTTP client new query" });
    assert.equal(fallback.matches.length, 1);
    assert.ok(fallback.warnings.includes("DENSE_UNAVAILABLE_LEXICAL_FALLBACK"));
    assert.ok(fallback.warnings.includes("RERANK_UNAVAILABLE_FUSION_FALLBACK"));
  } finally { await f.close(); }
});

test("one query refinement recovers vocabulary misses and reranks against the unchanged original", async () => {
  const f = await fixture();
  try {
    for (let i=0; i<24; i++) {
      const id = "material:unrelated-" + i;
      f.backend.sources.push(descriptor(id)); f.backend.texts.set(id, "Other unrelated content " + i);
    }
    await f.runtime.sync();
    const original = "How is a web request sent without TCP?";
    let refinements = 0;
    const ranked: string[] = [];
    f.models.refineQuery = async query => { refinements++; assert.equal(query, original); return query + " HTTP client"; };
    f.models.rerank = async (query, texts) => {
      ranked.push(query);
      return texts.map((text,index) => ({index, score: text.includes("sends a request") ? .9 : .01}));
    };
    const result = await f.runtime.search({query:original, kinds:["material"], material_id:"first", limit:1});
    // 单文件过滤仍会让初次 dense 看见唯一正文；先确认普通命中不增加模型调用。
    assert.equal(result.matches.length,1); assert.equal(refinements,0);
    ranked.length = 0;
    const recovered = await f.runtime.search({query:original, kinds:["material"], limit:1});
    assert.equal(refinements,1);
    assert.equal(recovered.matches[0]?.source_id,"material:first");
    assert.equal(recovered.matches[0]?.scope,"current");
    assert.ok(ranked.every(query=>query===original));
    const trace = await f.runtime.trace(recovered.trace_id);
    assert.equal(trace?.query,original);
    assert.equal(trace?.query_refinement?.status,"used");
    assert.ok(trace?.stages.dense_retry);
  } finally { await f.close(); }
});

test("query refinement is at most once and not used for network errors or deleted candidates", async () => {
  const f = await fixture();
  try {
    let count=0;
    f.models.refineQuery=async query=>{ count++; return query + " extra"; };
    const missing=await f.runtime.search({query:"unknown question"});
    assert.equal(count,1); assert.equal(missing.matches.length,0);
    f.calls.failEmbed=true;
    await f.runtime.search({query:"another unknown question"});
    assert.equal(count,1);
    f.calls.failEmbed=false;
    f.backend.sources=f.backend.sources.filter(row=>row.source_id!=="material:first");
    await f.runtime.search({query:"HTTP client"});
    assert.equal(count,1);
  } finally { await f.close(); }
});

test("query refinement timeout preserves first results within the shared deadline", async () => {
  const f = await fixture();
  try {
    f.models.refineQuery=async (_query,signal)=>new Promise((_,reject)=>signal?.addEventListener("abort",()=>reject(new Error("timeout")),{once:true}));
    const at=performance.now();
    const result=await f.runtime.search({query:"unknown question"});
    assert.equal(result.matches.length,0);
    assert.ok(result.warnings.includes("QUERY_REFINEMENT_UNAVAILABLE"));
    assert.ok(performance.now()-at<3000);
  } finally { await f.close(); }
});

test("refinement cannot follow a concurrent Goal change or expose another draft", async () => {
  const f = await fixture();
  try {
    f.models.refineQuery=async query=>{ f.backend.current="goal-b"; return query+" HTTP"; };
    const result=await f.runtime.search({query:"unknown question"});
    assert.equal(result.matches.length,0);
    assert.ok(result.warnings.includes("QUERY_REFINEMENT_UNAVAILABLE"));
    assert.equal((await f.runtime.trace(result.trace_id))?.query_refinement?.status,"unavailable");
  } finally { await f.close(); }
});

test("structured refinement preserves original negation and rejects filter or answer injection", () => {
  const original="Only query current notes: timeout=30 must not be disabled.";
  const query=refineQueryText(original,JSON.stringify({keywords:["超时","timeout"],conditions:["不得禁用"]}));
  assert.ok(query?.startsWith(original)); assert.ok(query?.includes("超时"));
  assert.equal(refineQueryText(original,'{"keywords":[]}'),null);
  assert.throws(()=>refineQueryText(original,'{"keywords":["HTTP"],"scope":"library"}'));
  assert.throws(()=>refineQueryText(original,'{"answer":"disable timeout"}'));
  assert.throws(()=>refineQueryText(original,'{"keywords":[42]}'));
  assert.equal(refineQueryText("x".repeat(999),'{"keywords":["HTTP"]}'),null);
});
test("slow embedding leaves time for lexical fallback and version validation", async () => {
  const f = await fixture();
  try {
    f.calls.delayed = true;
    const at = Date.now();
    const result = await f.runtime.search({ query: "HTTP unique slow query" });
    assert.equal(result.matches.length, 1);
    assert.ok(Date.now() - at < 8000);
    assert.ok(result.warnings.includes("DENSE_UNAVAILABLE_LEXICAL_FALLBACK"));
  } finally { await f.close(); }
});
test("restart reopens durable generation; chat/rerank changes do not re-embed", async () => {
  const f = await fixture();
  try {
    await f.runtime.stop();
    const before = f.calls.embed;
    await f.settings.save({ ...await f.settings.get(), rerankModel: "different-rerank" });
    const reopened = new RetrievalRuntime(f.directory, f.backend, f.settings, () => f.models);
    try {
      await reopened.start(); await reopened.sync();
      assert.equal(f.calls.embed, before);
      assert.equal((await reopened.search({ query: "HTTP" })).matches.length, 1);
    } finally { await reopened.stop(); }
  } finally { await f.close(); }
});
test("settings, provider errors and traces never serialize credentials", async () => {
  const f = await fixture();
  try {
    await f.settings.save({ ...await f.settings.get(), apiKey: "injected" } as any);
    assert.ok(!(await readFile(f.settings.path, "utf8")).includes("injected"));
    assert.ok(!JSON.stringify(await f.settings.publicSettings()).includes("test-secret"));
    const model = new BailianRetrievalModels(await f.settings.get(), () => f.settings.credential("p"),
      (async () => new Response(JSON.stringify({ code: "AuthError", message: "test-secret-do-not-log" }), { status: 401 })) as typeof fetch);
    await assert.rejects(model.embed(["hello"]), error => {
      assert.ok(!String(error).includes("test-secret")); return true;
    });
    f.models.embed = model.embed.bind(model);
    f.backend.sources[0]!.version = "v2";
    f.backend.texts.set(f.backend.sources[0]!.source_id, "HTTP changed authentication fixture");
    await f.runtime.sync();
    const status = await f.runtime.status();
    assert.equal(status.sources.find(s => s.source_id === f.backend.sources[0]!.source_id)?.error_code, "MODEL_HTTP_401");
    assert.ok(!JSON.stringify(status).includes("test-secret"));
  } finally { await f.close(); }
});
test("binding a draft changes scope without repeating unchanged embeddings", async () => {
  const f = await fixture();
  try {
    const source = f.backend.sources.find(row=>row.source_id==="material:other-draft")!;
    const before = f.calls.embed;
    source.goal_id = "goal-a"; source.draft_session_id = null;
    await f.runtime.sync();
    assert.equal(f.calls.embed,before);
    assert.ok((await f.runtime.search({query:"HTTP"})).matches.some(row=>row.source_id===source.source_id));
  } finally { await f.close(); }
});
test("failed new embedding generation keeps old active index until retry succeeds", async () => {
  const f = await fixture();
  try {
    const active = (await f.runtime.status()).active_generation;
    await f.settings.save({...await f.settings.get(),dimensions:128});
    f.calls.failEmbed = true;
    await f.runtime.sync();
    const pending = await f.runtime.status();
    assert.equal(pending.active_generation,active);
    assert.ok(pending.building_generation);
    assert.equal((await f.runtime.search({query:"HTTP"})).matches.length,1);
    f.calls.failEmbed = false;
    await f.runtime.retry();
    assert.notEqual((await f.runtime.status()).active_generation,active);
    assert.equal((await f.runtime.search({query:"HTTP new generation"})).matches.length,1);
  } finally { await f.close(); }
});
test("restart resumes failed source using persisted vectors instead of rebuilding ready sources", async () => {
  const f = await fixture();
  try {
    f.backend.sources[0]!.version="v2"; f.backend.texts.set("material:first","HTTP changed text");
    f.calls.failEmbed = true;
    await f.runtime.sync();
    assert.ok((await f.runtime.status()).sources.some(row=>row.state==="lexical_only"));
    await f.runtime.stop();
    f.calls.failEmbed=false;
    const before=f.calls.embed;
    const resumed=new RetrievalRuntime(f.directory,f.backend,f.settings,f.factory);
    try {
      await resumed.start(); await resumed.sync(); await resumed.retry();
      assert.equal(f.calls.embed,before+1);
      assert.ok((await resumed.status()).sources.every(row=>row.state==="ready"));
    } finally { await resumed.stop(); }
  } finally { await f.close(); }
});
test("parallel source reads share hard turn budget and reset next turn", async () => {
  const budget = new SourceReadBudget();
  const read = () => Promise.resolve({ text: "x", estimated_tokens: 2000 });
  await Promise.all([budget.read("a", 4000, read), budget.read("b", 4000, read), budget.read("c", 4000, read)]);
  await assert.rejects(budget.read("a", 4000, read), /预算/);
  budget.reset(); await budget.read("d", 4000, read);
});

test("an interrupted empty writer lock recovers without discarding a live lock", async () => {
  const f = await fixture();
  const lock = join(f.directory, "writer.lock");
  try {
    f.backend.sources[0]!.version = "v2";
    f.backend.texts.set("material:first", "HTTP updated after interruption");
    await writeFile(lock, "");
    await f.runtime.sync();
    assert.equal(await readFile(lock, "utf8"), "", "a newly publishing lock must be left alone");
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await f.runtime.sync();
    await f.runtime.sync();
    assert.equal((await f.runtime.status()).sources.find(row => row.source_id === "material:first")?.version, "v2");
    assert.equal((await f.runtime.search({ query: "HTTP" })).matches.length, 1);
    await writeFile(lock, String(process.pid));
    await f.runtime.sync();
    assert.equal(await readFile(lock, "utf8"), String(process.pid));
  } finally {
    await rm(lock, { force: true });
    await f.close();
  }
});

test("a connection opened before a shared table sees its rows and can write without creating a duplicate", async () => {
  const f = await fixture();
  const active = (await f.runtime.status()).active_generation!;
  const existing = new LocalRetrievalIndex(join(f.directory, active, "lance"), 64);
  const shared = join(f.directory, "shared-check");
  const reader = new LocalRetrievalIndex(shared, 64);
  const lateWriter = new LocalRetrievalIndex(shared, 64);
  const writer = new LocalRetrievalIndex(shared, 64);
  try {
    await existing.open();
    const rows = (await existing.sourceRows("material:first")).map(row => ({ ...row, vector: Array.from(row.vector) }));
    await reader.open(); await lateWriter.open(); await writer.open();
    assert.equal(await reader.count(), 0);
    await writer.upsert(rows);
    assert.equal(await reader.count(), 1);
    assert.equal((await reader.sourceRows("material:first")).length, 1);
    await lateWriter.upsert(rows.map(row => ({ ...row, text: "HTTP changed through another connection" })));
    assert.equal((await reader.sourceRows("material:first"))[0]?.text, "HTTP changed through another connection");
    await reader.removeSource("material:first");
    assert.equal(await writer.count(), 0);
  } finally {
    existing.close(); reader.close(); lateWriter.close(); writer.close();
    await f.close();
  }
});

test("material deletion purges every index generation and historical version, graph/temp files and cached traces without re-embedding retained sources", async () => {
  const f = await fixture();
  const id = "mat-" + "a".repeat(32), removed = "material:" + id, retained = "card:retained";
  let retries = 0;
  const deletions: Array<{id: string; source_hash: string; original_cleanup: "pending"}> = [];
  (f.backend as SourceBackend).materialDeletions = async () => ({version: 1, deletions, next_offset: null, catalog_version: JSON.stringify(deletions)});
  (f.backend as SourceBackend).retryMaterialDeletion = async () => {retries++;};
  try {
    f.backend.sources = [descriptor(removed), descriptor(retained)];
    f.backend.texts.set(removed, "HTTP DELETED_SECRET_29 remains only in the deleted book.");
    f.backend.texts.set(retained, "HTTP retained knowledge should keep its vector.");
    await f.runtime.sync();
    const first = (await f.runtime.status()).active_generation!;
    await f.settings.save({...await f.settings.get(), embeddingModel: "replacement-generation"});
    await f.runtime.sync();
    const second = (await f.runtime.status()).active_generation!;
    assert.notEqual(first, second);
    const found = await f.runtime.search({query: "HTTP"});
    assert.ok(found.matches.some(m => m.source_id === removed));
    assert.ok(await f.runtime.trace(found.trace_id));
    for (const generation of [first, second]) {
      const graph = new SourceGraphStore(join(f.directory, generation, "graph"));
      await graph.save({source_id: removed, version: "v1", scope_id: "goal-a", kind: "material", fingerprint: "fixture", cursor: 1,
        ready: true, entities: [], relations: []});
      await graph.save({source_id: retained, version: "v1", scope_id: "goal-a", kind: "card", fingerprint: "fixture", cursor: 1,
        ready: true, entities: [], relations: []});
      // 真实中断写入格式；不只清理正常文件名。
      const all = await Promise.all((await readdir(graph.directory)).map(async file => ({file, text: await readFile(join(graph.directory, file), "utf8")})));
      const target = all.find(row => row.text.includes(removed))!.file;
      await writeFile(join(graph.directory, target + "." + "b".repeat(8) + "-bbbb-bbbb-bbbb-" + "b".repeat(12) + ".tmp"), "DELETED_SECRET_29");
    }
    const before = f.calls.embed;
    deletions.push({id, source_hash: "c".repeat(64), original_cleanup: "pending"});
    f.backend.sources = f.backend.sources.filter(source => source.source_id !== removed);
    await f.runtime.materialDeleted(id);
    assert.equal(f.calls.embed, before, "removing one source must not regenerate other source embeddings");
    assert.ok(retries > 0);
    assert.equal(await f.runtime.trace(found.trace_id), null, "in-memory trace must be invalidated too");
    assert.ok(!(await readdir(join(f.directory, "traces"))).includes(found.trace_id + ".json"));
    for (const generation of [first, second]) {
      const manifest = JSON.parse(await readFile(join(f.directory, generation, "manifest.json"), "utf8"));
      assert.ok(!manifest.jobs[removed]);
      const graph = new SourceGraphStore(join(f.directory, generation, "graph"));
      assert.equal(await graph.load(removed), null); assert.ok(await graph.load(retained));
      for (const file of await readdir(graph.directory)) assert.ok(!(await readFile(join(graph.directory, file), "utf8")).includes("DELETED_SECRET_29"));
      const connection = await lancedb.connect(join(f.directory, generation, "lance"));
      const table = await connection.openTable("chunks");
      try {
        const versions = await table.listVersions();
        for (const version of versions) {
          await table.checkout(version.version);
          assert.equal((await table.query().where(`source_id = '${removed}'`).toArray()).length, 0, "even retained historical versions cannot read deleted source rows");
          assert.equal((await table.query().where(`source_id = '${retained}'`).toArray()).length, 1);
        }
      } finally {table.close(); connection.close();}
    }
    const again = await f.runtime.search({query: "HTTP"});
    assert.equal(again.matches.length, 1); assert.equal(again.matches[0]?.source_id, retained);
    assert.equal((f.runtime as any).queryCache.size, 1, "only the new post-deletion query may be cached");
    await f.runtime.stop();
    const reopened = new RetrievalRuntime(f.directory, f.backend, f.settings, f.factory);
    try {await reopened.start(); await reopened.sync(); assert.equal(await reopened.trace(found.trace_id), null);
      assert.equal((await reopened.search({query: "HTTP"})).matches.length, 1);
    } finally {await reopened.stop();}
  } finally {await f.close();}
});

test("partial derived cleanup remains blocked and resumes after restart without losing retained vectors", async () => {
  const f = await fixture(), id = "mat-" + "d".repeat(32), sourceId = "material:" + id;
  const rows: Array<{id: string; source_hash: string; original_cleanup: "complete"}> = [];
  (f.backend as SourceBackend).materialDeletions = async () => ({version: 1, deletions: rows, next_offset: null, catalog_version: JSON.stringify(rows)});
  const erase = LocalRetrievalIndex.prototype.eraseSources;
  let failing = false;
  LocalRetrievalIndex.prototype.eraseSources = function (ids) {
    return failing ? Promise.reject(new Error("fixture cleanup unavailable")) : erase.call(this, ids);
  };
  try {
    f.backend.sources.push(descriptor(sourceId)); f.backend.texts.set(sourceId, "HTTP PRIVATE_DELETE_RETRY");
    await f.runtime.sync(); const found = await f.runtime.search({query: "HTTP"});
    const embed = f.calls.embed;
    failing = true; rows.push({id, source_hash: "e".repeat(64), original_cleanup: "complete"});
    f.backend.sources = f.backend.sources.filter(row => row.source_id !== sourceId);
    await f.runtime.sync();
    assert.ok((await f.runtime.status()).warning);
    assert.equal(await f.runtime.trace(found.trace_id), null, "failed file cleanup must never reopen the trace");
    assert.ok((await f.runtime.search({query: "HTTP"})).matches.every(m => m.source_id !== sourceId));
    await f.runtime.stop(); failing = false;
    const reopened = new RetrievalRuntime(f.directory, f.backend, f.settings, f.factory);
    try {
      await reopened.start(); await reopened.sync();
      assert.equal((await reopened.status()).warning, null);
      assert.ok((await reopened.search({query: "HTTP"})).matches.every(m => m.source_id !== sourceId));
      assert.equal(f.calls.embed, embed + 2, "only one query per runtime is refreshed; retained source vectors are reused");
    } finally {await reopened.stop();}
  } finally {LocalRetrievalIndex.prototype.eraseSources = erase; await f.close();}
});

test("a source deleted while its read or abort-ignoring embedding is in flight cannot return or reinsert stale content", {timeout: 20_000}, async () => {
  const f = await fixture(), id = "mat-" + "f".repeat(32), sourceId = "material:" + id;
  const rows: Array<{id: string; source_hash: string; original_cleanup: "complete"}> = [];
  (f.backend as SourceBackend).materialDeletions = async () => ({version: 1, deletions: rows, next_offset: null, catalog_version: JSON.stringify(rows)});
  let dispatched!: () => void, release!: () => void, releaseRead: () => void = () => {};
  const began = new Promise<void>(done => {dispatched = done;}), gate = new Promise<void>(done => {release = done;});
  let aborted = false;
  const embed = f.models.embed.bind(f.models);
  f.models.embed = async (texts, signal) => {
    if (!texts.some(text => text.includes("DELAYED_SOURCE"))) return embed(texts, signal);
    signal?.addEventListener("abort", () => {aborted = true;}, {once: true});
    dispatched(); await gate; return texts.map(() => [1, ...Array(63).fill(.01)]);
  };
  try {
    const oldId = "mat-" + "2".repeat(32), oldSource = "material:" + oldId;
    f.backend.sources = [descriptor(oldSource), ...f.backend.sources.filter(source => source.source_id !== "material:first")];
    f.backend.texts.set(oldSource, "HTTP READ_BEFORE_DELETE"); await f.runtime.sync();
    const found = await f.runtime.search({query: "HTTP"});
    const old = found.matches.find(match => match.source_id === oldSource)!.source_ref;
    const read = f.backend.read.bind(f.backend);
    let readBegan!: () => void;
    const reading = new Promise<void>(done => {readBegan = done;}), held = new Promise<void>(done => {releaseRead = done;});
    f.backend.read = async (...args) => {const value = await read(...args); readBegan(); await held; return value;};
    const pendingRead = f.runtime.read(old).then(() => null, error => error as Error); await reading;
    // 删除旧来源的同时开始另一本的后台请求，两个迟到路径均须被实际入口拒绝。
    f.backend.sources.push(descriptor(sourceId)); f.backend.texts.set(sourceId, "HTTP DELAYED_SOURCE");
    const syncing = f.runtime.sync(); await began;
    rows.push({id, source_hash: "1".repeat(64), original_cleanup: "complete"});
    rows.push({id: oldId, source_hash: "2".repeat(64), original_cleanup: "complete"});
    f.backend.sources = f.backend.sources.filter(source => source.source_id !== sourceId && source.source_id !== oldSource);
    const deleting = f.runtime.materialDeleted(id);
    release(); releaseRead(); await syncing; await deleting;
    assert.match((await pendingRead)?.message ?? "unexpected successful read", /SOURCE_CHANGED/);
    assert.ok(aborted, "Gateway invalidation must abort the same source's model request");
    assert.ok(!(await f.runtime.status()).sources.some(s => s.source_id === sourceId));
    const active = (await f.runtime.status()).active_generation!;
    const index = new LocalRetrievalIndex(join(f.directory, active, "lance"), 64);
    try {await index.open(); assert.equal((await index.sourceRows(sourceId)).length, 0);} finally {index.close();}
  } finally {release(); releaseRead(); await f.close();}
});

test("legacy index generations remain invalidated but are never physically pruned before an offline access-protocol migration", async () => {
  const f = await fixture(), id = "mat-" + "c".repeat(32), sourceId = "material:" + id;
  const rows: Array<{id: string; source_hash: string; original_cleanup: "complete"}> = [];
  (f.backend as SourceBackend).materialDeletions = async () => ({version: 1, deletions: rows, next_offset: null, catalog_version: JSON.stringify(rows)});
  try {
    f.backend.sources.push(descriptor(sourceId)); f.backend.texts.set(sourceId, "HTTP LEGACY_ACCESS_SOURCE"); await f.runtime.sync();
    const generation = (await f.runtime.status()).active_generation!, path = join(f.directory, generation, "manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8")); delete manifest.index_access; await writeFile(path, JSON.stringify(manifest));
    await f.settings.save({...await f.settings.get(), embeddingModel: "new-protocol-generation"}); await f.runtime.sync();
    const newer = (await f.runtime.status()).active_generation!; assert.notEqual(newer, generation);
    rows.push({id, source_hash: "f".repeat(64), original_cleanup: "complete"});
    f.backend.sources = f.backend.sources.filter(source => source.source_id !== sourceId);
    await f.runtime.sync(); assert.ok((await f.runtime.status()).warning);
    assert.equal(JSON.parse(await readFile(path, "utf8")).index_access, undefined, "a running process cannot silently bless legacy readers");
    for (const gen of [generation, newer]) {
      const index = new LocalRetrievalIndex(join(f.directory, gen, "lance"), 64);
      try {await index.open(); assert.equal((await index.sourceRows(sourceId)).length, 1, "physical pruning must be held for both legacy and new generations");} finally {index.close();}
    }
    assert.ok((await f.runtime.search({query: "HTTP"})).matches.every(match => match.source_id !== sourceId));
    await f.runtime.stop();
    // 夹具中旧实例已停止，模拟后续P7停写迁移，不在产品运行路径自动修改旧标记。
    manifest.index_access = 1; await writeFile(path, JSON.stringify(manifest));
    const reopened = new RetrievalRuntime(f.directory, f.backend, f.settings, f.factory);
    try {await reopened.start(); await reopened.sync(); assert.equal((await reopened.status()).warning, null);
      const check = new LocalRetrievalIndex(join(f.directory, generation, "lance"), 64);
      try {await check.open(); assert.equal((await check.sourceRows(sourceId)).length, 0);} finally {check.close();}
    } finally {await reopened.stop();}
  } finally {await f.close();}
});
