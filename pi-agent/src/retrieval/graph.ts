import {createHash, randomUUID} from "node:crypto";
import {mkdir, readFile, readdir, rename, rm, writeFile} from "node:fs/promises";
import {join} from "node:path";
import type {Candidate, GraphPath, IndexRow, Models, SourceChunk, SourceDescriptor, SourceKind} from "./types.js";
import type {LocalRetrievalIndex} from "./store.js";

export interface GraphEntity {name: string; aliases: string[]}
export interface GraphRelation extends GraphPath {vector: number[]}
interface GraphBatch {chunks: Array<{chunk_id: string; text_hash: string; source_ref: string}>;
  entities: GraphEntity[]; relations: GraphRelation[]; rejected: number; truncated_entities: number; rejection_reasons: Record<string, number>}
export interface GraphRecord {source_id: string; version: string; scope_id: string; kind: SourceKind;
  fingerprint: string; cursor: number; ready: boolean; entities: GraphEntity[]; relations: GraphRelation[];
  rejected_relations?: number; truncated_entities?: number; rejection_reasons?: Record<string, number>; batches?: GraphBatch[]}
const normalized = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s/gu, "");
const entityKey = (scope: string, name: string) => JSON.stringify([scope, normalized(name)]);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const bounded = (v: unknown, max: number): v is string => typeof v === "string" && !!v.trim() && v.length <= max && !/[\x00-\x08]/.test(v);

function decodeRecord(value: any): GraphRecord | null {
  const record = value?.record ?? value;
  if (value?.record && value.checksum !== digest(JSON.stringify(record))) return null;
  // 旧 JSON 按结构校验读取，新缓存带 checksum；损坏视为缺失，从真实来源重建。
  if (!record || !bounded(record.source_id, 256) || !bounded(record.version, 128) || !bounded(record.scope_id, 256)
    || !bounded(record.fingerprint, 128) || !["card", "note", "material"].includes(record.kind)
    || !Number.isSafeInteger(record.cursor) || record.cursor < 0 || typeof record.ready !== "boolean"
    || !Array.isArray(record.entities) || !Array.isArray(record.relations)) return null;
  if (record.entities.some((e: any) => !e || !bounded(e.name, 100) || !Array.isArray(e.aliases) || e.aliases.some((a: unknown) => !bounded(a, 100)))
    || record.relations.some((r: any) => !r || !bounded(r.from, 100) || !bounded(r.to, 100) || !bounded(r.relation, 200)
      || !bounded(r.quote, 600) || !bounded(r.source_ref, 2048) || !Array.isArray(r.vector) || !r.vector.length
      || r.vector.some((n: unknown) => typeof n !== "number" || !Number.isFinite(n)))) return null;
  if (record.batches !== undefined && (!Array.isArray(record.batches) || record.batches.some((b: any) => !b
    || !Number.isSafeInteger(b.rejected) || b.rejected < 0 || !Number.isSafeInteger(b.truncated_entities) || b.truncated_entities < 0
    || !b.rejection_reasons || typeof b.rejection_reasons !== "object" || Array.isArray(b.rejection_reasons)
    || Object.values(b.rejection_reasons).some(n => !Number.isSafeInteger(n) || (n as number) < 0)
    || !Array.isArray(b.chunks) || b.chunks.some((c: any) => !c || !bounded(c.chunk_id, 256)
      || !bounded(c.source_ref, 2048) || typeof c.text_hash !== "string" || !/^[a-f0-9]{64}$/.test(c.text_hash))
    || !Array.isArray(b.entities) || !Array.isArray(b.relations)
    || b.entities.some((e: any) => !e || !bounded(e.name, 100) || !Array.isArray(e.aliases) || e.aliases.some((a: unknown) => !bounded(a, 100)))
    || b.relations.some((r: any) => !r || !bounded(r.from, 100) || !bounded(r.to, 100) || !bounded(r.relation, 200)
      || !bounded(r.quote, 600) || !b.chunks.some((c: any) => c.source_ref === r.source_ref)
      || !Array.isArray(r.vector) || !r.vector.length || r.vector.some((n: unknown) => typeof n !== "number" || !Number.isFinite(n)))))) return null;
  return {...record, entities: record.entities.map((e: GraphEntity) => ({...e, aliases: e.aliases.filter(alias =>
    record.relations.some((r: GraphRelation) => [r.from, r.to].includes(e.name) && normalized(r.quote).includes(normalized(alias))))}))};
}

// 只修复空白差异；标点、数字和措辞必须逐字一致。最终保存原文连续子串。
function sourceQuote(text: string, quote: string): string | null {
  if (text.includes(quote)) return quote;
  let compact = ""; const positions: number[] = [];
  for (let i = 0; i < text.length; i++) if (!/\s/u.test(text[i]!)) {compact += text[i]; positions.push(i);}
  const needle = quote.replace(/\s/gu, "");
  if (needle.length < 10) return null;
  const at = compact.indexOf(needle);
  if (at < 0 || compact.indexOf(needle, at + 1) >= 0) return null;
  const original = text.slice(positions[at], positions[at + needle.length - 1]! + 1);
  return bounded(original, 600) ? original : null;
}

export function validateGraph(value: unknown, chunks: SourceChunk[]): {entities: GraphEntity[]; relations: Omit<GraphRelation, "vector">[]; rejected: number; truncated_entities: number; rejection_reasons: Record<string, number>} {
  // 引用由本地投影补充；模型不能选择其他Goal、来源版本或source_ref。
  const data = value as any;
  if (!data || Object.keys(data).some(k => !["entities", "relations"].includes(k)) || !Array.isArray(data.entities)
    || !Array.isArray(data.relations)) throw new Error("INVALID_GRAPH");
  const byName = new Map<string, GraphEntity>();
  for (const e of data.entities) {
    if (!e || Object.keys(e).some(k => !["name", "aliases"].includes(k)) || !bounded(e.name, 100)
      || !Array.isArray(e.aliases) || e.aliases.length > 8 || e.aliases.some((a: unknown) => !bounded(a, 100))) continue;
    const name = e.name.trim(), old = byName.get(name);
    byName.set(name, {name, aliases: [...new Set([...(old?.aliases ?? []), ...e.aliases as string[]])].slice(0, 8)});
  }
  const selected = new Map<string, GraphEntity>(), rejection_reasons: Record<string, number> = {};
  let rejected = 0;
  const reject = (reason: string) => {rejected++; rejection_reasons[reason] = (rejection_reasons[reason] ?? 0) + 1;};
  const relations: Omit<GraphRelation, "vector">[] = [];
  for (const r of data.relations) {
    if (!r || Object.keys(r).some(k => !["from", "to", "relation", "chunk_id", "quote"].includes(k))
      || !bounded(r.from, 100) || !bounded(r.to, 100) || !bounded(r.relation, 200) || !bounded(r.quote, 600)
      || r.quote.length < 10) {reject("invalid_relation"); continue;}
    const chunk = chunks.find(c => c.chunk_id === r.chunk_id);
    if (!chunk) {reject("unknown_chunk"); continue;}
    const quote = sourceQuote(chunk.text, r.quote);
    if (!quote) {reject("quote_not_exact"); continue;}
    // 漏列实体不应丢掉已有逐字出处的关系；仅能补充在该引文出现的字面端点。
    const endpoints: GraphEntity[] = [r.from, r.to].map(name => byName.get(name) ?? {name, aliases: []});
    if (endpoints.some(e => ![e.name, ...e.aliases].some(term => normalized(quote).includes(normalized(term))))) {
      reject("endpoint_not_grounded"); continue;
    }
    if (relations.length >= 60) {reject("relation_limit"); continue;}
    if (new Set([...selected.keys(), ...endpoints.map(e => e.name)]).size > 40) {reject("entity_limit"); continue;}
    endpoints.forEach(e => selected.set(e.name, e));
    relations.push({from: r.from, to: r.to, relation: r.relation, quote, source_ref: chunk.source_ref});
  }
  return {entities: [...selected.values()].map(e => ({...e, aliases: e.aliases.filter(alias =>
    relations.some(r => [r.from, r.to].includes(e.name) && normalized(r.quote).includes(normalized(alias))))})), relations, rejected,
    truncated_entities: Math.max(0, data.entities.length - 40), rejection_reasons};
}

function combineBatches(record: GraphRecord): void {
  record.entities = []; record.relations = []; record.rejected_relations = 0; record.truncated_entities = 0; record.rejection_reasons = {};
  // 长文档汇总用集合去重，避免每轮续作对全部历史关系做二次方扫描。
  const entities = new Map<string, GraphEntity>(), relations = new Set<string>();
  for (const batch of record.batches ?? []) {
    record.rejected_relations += batch.rejected; record.truncated_entities += batch.truncated_entities;
    for (const [reason, count] of Object.entries(batch.rejection_reasons)) record.rejection_reasons[reason] = (record.rejection_reasons[reason] ?? 0) + count;
    for (const entity of batch.entities) {
      const existing = entities.get(entity.name);
      if (existing) existing.aliases = [...new Set([...existing.aliases, ...entity.aliases])].slice(0, 8);
      else {const copy = {...entity, aliases: [...entity.aliases]}; entities.set(entity.name, copy); record.entities.push(copy);}
    }
    for (const relation of batch.relations) {
      const key = JSON.stringify([relation.source_ref, relation.from, relation.to, relation.relation]);
      if (!relations.has(key)) {relations.add(key); record.relations.push(relation);}
    }
  }
}

function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {dot += a[i]! * b[i]!; aa += a[i]! ** 2; bb += b[i]! ** 2;}
  return dot / Math.sqrt(aa * bb || 1);
}

export class SourceGraphStore {
  constructor(readonly directory: string) {}
  private path(sourceId: string) {return join(this.directory, digest(sourceId) + ".json");}
  async load(sourceId: string): Promise<GraphRecord | null> {
    try {return decodeRecord(JSON.parse(await readFile(this.path(sourceId), "utf8")));} catch {return null;}
  }
  async save(record: GraphRecord) {
    await mkdir(this.directory, {recursive: true});
    const path = this.path(record.source_id), temporary = path + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify({record, checksum: digest(JSON.stringify(record))}), {mode: 0o600}); await rename(temporary, path);
  }
  async remove(sourceId: string) {
    const prefix = digest(sourceId) + ".json";
    await rm(this.path(sourceId), {force: true});
    // 中断发布的临时文件也可能含引文；同一目录writer.lock内清理，不碰其他来源。
    for (const file of await readdir(this.directory).catch((e: NodeJS.ErrnoException) => {if (e.code === "ENOENT") return []; throw e;}))
      if (file.startsWith(prefix + ".") && /^[0-9a-f-]{36}\.tmp$/.test(file.slice(prefix.length + 1)))
        await rm(join(this.directory, file), {force: true});
  }
  async records(): Promise<GraphRecord[]> {
    await mkdir(this.directory, {recursive: true});
    const files = (await readdir(this.directory)).filter(f => /^[a-f0-9]{64}\.json$/.test(f));
    const values = await Promise.all(files.map(async f => {
      try {return decodeRecord(JSON.parse(await readFile(join(this.directory, f), "utf8")));} catch {return null;}
    }));
    return values.filter((v): v is GraphRecord => v !== null);
  }
  async rebase(source: SourceDescriptor, fingerprint: string, rows: IndexRow[]): Promise<GraphRecord | null> {
    const record = await this.load(source.source_id), scope = source.goal_id ?? "draft:" + source.draft_session_id;
    if (!record) return null;
    if (record.scope_id !== scope || record.kind !== source.kind) {await this.remove(source.source_id); return null;}
    if (record.fingerprint !== fingerprint) return null;
    if (record.version === source.version) return record;
    const current = rows.filter(r => r.source_id === source.source_id && r.source_version === source.version && r.scope_id === scope && r.kind === source.kind).sort((a,b) => a.ordinal - b.ordinal);
    const byHash = new Map<string, IndexRow[]>();
    for (const row of current) {const key = digest(row.text), list = byHash.get(key) ?? []; list.push(row); byHash.set(key, list);}
    const batches: GraphBatch[] = [];
    for (const batch of record.batches ?? []) {
      const refs = new Map<string, IndexRow>(), mapped: GraphBatch["chunks"] = [];
      for (const chunk of batch.chunks) {
        const matches = byHash.get(chunk.text_hash) ?? [], match = matches.find(r => r.chunk_id === chunk.chunk_id) ?? (matches.length === 1 ? matches[0] : undefined);
        if (!match) break;
        refs.set(chunk.source_ref, match); mapped.push({chunk_id: match.chunk_id, source_ref: match.source_ref, text_hash: chunk.text_hash});
      }
      if (mapped.length !== batch.chunks.length || batch.relations.some(r => !refs.get(r.source_ref)?.text.includes(r.quote))) continue;
      batches.push({...batch, chunks: mapped, relations: batch.relations.map(r => ({...r, source_ref: refs.get(r.source_ref)!.source_ref}))});
    }
    // 仅复用同一作用域、同一模型、完全相同正文的批次；新版本引用由当前索引重绑。
    record.version = source.version; record.batches = batches; combineBatches(record);
    const covered = new Set(batches.flatMap(b => b.chunks.map(c => c.chunk_id)));
    record.cursor = current.findIndex(r => !covered.has(r.chunk_id));
    if (record.cursor < 0) record.cursor = current.length;
    record.ready = false; await this.save(record); return record;
  }
  async append(source: SourceDescriptor, fingerprint: string, chunks: SourceChunk[], cursor: number, ready: boolean, models: Models) {
    if (!models.extractGraph) throw new Error("图谱模型不可用。");
    const old = await this.load(source.source_id), scope = source.goal_id ?? "draft:" + source.draft_session_id;
    const record: GraphRecord = old?.version === source.version && old.scope_id === scope && old.fingerprint === fingerprint ? old :
      {source_id: source.source_id, version: source.version, scope_id: scope, kind: source.kind, fingerprint, cursor: 0, ready: false, entities: [], relations: [], batches: []};
    const covered = new Set(record.batches?.flatMap(b => b.chunks.map(c => c.chunk_id)) ?? []);
    const missing = chunks.filter(c => !covered.has(c.chunk_id));
    if (missing.length) {
      const checked = validateGraph(await models.extractGraph(missing.map(c => ({chunk_id: c.chunk_id, text: c.text}))), missing);
      const vectors = checked.relations.length ? await models.embed(checked.relations.map(r => r.from + " " + r.relation + " " + r.to)) : [];
      if (vectors.length !== checked.relations.length || vectors.some(v => !Array.isArray(v) || !v.length || v.some(n => !Number.isFinite(n)))) throw new Error("GRAPH_VECTOR_INVALID");
      const batch: GraphBatch = {chunks: missing.map(c => ({chunk_id: c.chunk_id, source_ref: c.source_ref, text_hash: digest(c.retrieval_text ?? c.text)})),
        entities: checked.entities, relations: checked.relations.map((r,i) => ({...r, vector: vectors[i]!})), rejected: checked.rejected,
        truncated_entities: checked.truncated_entities, rejection_reasons: checked.rejection_reasons};
      record.batches ??= []; record.batches.push(batch); combineBatches(record);
    }
    record.cursor = cursor; record.ready = ready; await this.save(record);
  }
  async search(query: string, vector: number[] | undefined, scopes: string[], index: LocalRetrievalIndex, kinds?: SourceKind[], materialId?: string): Promise<Candidate[]> {
    const records = (await this.records()).filter(r => scopes.includes(r.scope_id) && (!kinds?.length || kinds.includes(r.kind))
      && (!materialId || r.source_id === "material:" + materialId));
    // 同名/原文别名只在同一 Goal 内合并；图遍历不能借别名穿过其他草稿或未允许的来源类型。
    const parent = new Map<string, string>();
    const root = (key: string): string => {const p = parent.get(key); return p && p !== key ? root(p) : key;};
    for (const record of records) for (const entity of record.entities) {
      const keys = [entity.name, ...entity.aliases].map(n => entityKey(record.scope_id, n));
      const roots = keys.map(root).sort(); const canonical = roots[0]!;
      for (const key of [...keys, ...roots]) parent.set(key, canonical);
    }
    const edges = records.flatMap(record => record.relations.map(edge => ({...edge,
      a: root(entityKey(record.scope_id, edge.from)), b: root(entityKey(record.scope_id, edge.to)), scope: record.scope_id})));
    const terms = new Map<string, Set<string>>(), adjacency = new Map<string, typeof edges>();
    for (const record of records) for (const entity of record.entities) {
      const key = root(entityKey(record.scope_id, entity.name)), names = terms.get(key) ?? new Set<string>();
      for (const name of [entity.name, ...entity.aliases]) names.add(normalized(name)); terms.set(key, names);
    }
    for (const edge of edges) for (const key of new Set([edge.a, edge.b])) {
      const neighbors = adjacency.get(key) ?? []; neighbors.push(edge); adjacency.set(key, neighbors);
    }
    const q = normalized(query);
    const scored = edges.map(edge => {
      const exact = [...(terms.get(edge.a) ?? []), ...(terms.get(edge.b) ?? [])].some(n => n.length > 1 && q.includes(n));
      return {edge, score: (exact ? 1 : 0) + (vector ? Math.max(0, cosine(vector, edge.vector)) : 0)};
    }).filter(r => r.score >= .5).sort((a,b) => b.score - a.score);
    const paths = new Map<string, {score: number; path: GraphPath[]}>();
    const publicEdge = (edge: typeof edges[number]): GraphPath => ({from: edge.from, to: edge.to, relation: edge.relation, quote: edge.quote, source_ref: edge.source_ref});
    for (const seed of scored.slice(0, 4)) {
      const previous = paths.get(seed.edge.source_ref);
      paths.set(seed.edge.source_ref, {score: Math.max(seed.score, previous?.score ?? 0), path: previous?.path ?? [publicEdge(seed.edge)]});
      for (const next of [...new Set([...(adjacency.get(seed.edge.a) ?? []), ...(adjacency.get(seed.edge.b) ?? [])])]
        .filter(e => e.source_ref !== seed.edge.source_ref).slice(0, 12)) {
        const prior = paths.get(next.source_ref);
        if (!prior || prior.path.length === 1) paths.set(next.source_ref, {score: Math.max(seed.score * .8, prior?.score ?? 0),
          path: [publicEdge(seed.edge), publicEdge(next)]});
      }
    }
    const ranked = [...paths].sort((a,b) => b[1].score - a[1].score).slice(0, 20);
    const candidates = await index.references(ranked.map(([ref]) => ref), scopes, kinds, materialId);
    return candidates.map(c => ({...c, score: paths.get(c.source_ref)!.score, score_parts: {graph: paths.get(c.source_ref)!.score},
      graph_context: paths.get(c.source_ref)!.path})).sort((a,b) => b.score - a.score);
  }
}
