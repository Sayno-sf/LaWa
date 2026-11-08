import { mkdir, open, readFile, readdir, rename, rm, stat, lstat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { LocalRetrievalIndex } from "./store.js";
import { BailianRetrievalModels, RetrievalSettingsStore } from "./settings.js";
import {SourceGraphStore} from "./graph.js";
import {MaterialDeletionCache} from "./materialDeletion.js";
import type { Candidate, IndexRow, Models, RetrievalSettings, SearchScope, SourceBackend, SourceDescriptor, SourceKind } from "./types.js";

interface Job {
  version: string; scope_id: string; state: "waiting" | "indexing" | "ready" | "lexical_only";
  cursor: number; chunks: number; attempts: number; retry_at: number; updated_at: string;
  warning?: string;
  vector_enabled?: boolean;
  error_code?: string;
}
interface DerivedJob {state: "pending" | "ready" | "failed"; retry_at: number; completed: number; total: number;
  version?: string; scope_id?: string; fingerprint?: string; attempts?: number; warning?: string; error_code?: string;
  rejected_relations?: number; truncated_entities?: number; relations?: number; rejection_reasons?: Record<string, number>}
interface Manifest { config: RetrievalSettings; jobs: Record<string, Job>; derived?: Record<string, {vision?: DerivedJob; graph?: DerivedJob}>;
  visual_cursor?: string; index_access?: 1 }
interface Generation { id: string; index: LocalRetrievalIndex; graph: SourceGraphStore; manifest: Manifest }
export interface SearchInput { query: string; scope?: SearchScope; kinds?: SourceKind[]; material_id?: string; limit?: number }
export interface RetrievalTrace {
  id: string; at: string; query: string; scope: SearchScope; current_scope: string; generation: string;
  stages: Record<string, Array<Record<string, unknown>>>; timings_ms: Record<string, number>; warnings: string[];
  reads: Array<Record<string, unknown>>;
  query_refinement?: { status: string; query?: string };
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const derivedErrorCode = (error: unknown, fallback: string) => {
  // 仅接受受控适配器的错误码，绝不保存供应商响应或识别正文。
  const code = (error as {code?: unknown})?.code;
  if (typeof code === "string" && /^(MODEL_HTTP_\d{3}|DERIVED_OUTPUT_TRUNCATED|INVALID_DERIVED_(OUTPUT|JSON)|INVALID_VISUAL_ANALYSIS|VISUAL_RENDER_FAILED|MATERIAL_CHANGED|SOURCE_API_FAILED)$/.test(code)) return code;
  if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) return error.name;
  return error instanceof Error && /^(INVALID_GRAPH(?:_ENTITY)?|GRAPH_VECTOR_INVALID|SOURCE_CHANGED)$/.test(error.message) ? error.message : fallback;
};
const scopeId = (source: SourceDescriptor) => source.goal_id ?? "draft:" + source.draft_session_id;
const generationId = (config: RetrievalSettings) => hash([config.embeddingModel, config.dimensions, config.embeddingUrl]).slice(0, 24);
const preview = (row: Candidate) => ({ source_id: row.source_id, name: row.name, goal_name: row.goal_name,
  heading: row.heading || null,
  chunk_id: row.chunk_id, locator: JSON.parse(row.locator_json), snippet: row.text.slice(0, 240),
  score: row.score, score_parts: row.score_parts, ...(row.graph_context ? {graph_context: row.graph_context} : {}) });

async function atomicJson(path: string, value: unknown) {
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

export function fuseCandidates(lexical: Candidate[], dense: Candidate[], graph: Candidate[] = []): Candidate[] {
  const rows = new Map<string, Candidate>();
  for (const [stage, candidates] of [["bm25", lexical], ["dense", dense], ["graph", graph]] as const) {
    candidates.forEach((row, rank) => {
      const current = rows.get(row.id) ?? { ...row, score: 0, score_parts: {} };
      current.score += 1 / (60 + rank + 1);
      current.score_parts = { ...current.score_parts, [stage]: row.score, [stage + "_rank"]: rank + 1 };
      if (row.graph_context) current.graph_context = row.graph_context;
      rows.set(row.id, current);
    });
  }
  return [...rows.values()].sort((a,b) => b.score - a.score || a.id.localeCompare(b.id));
}
export function deduplicateCandidates(rows: Candidate[]): Candidate[] {
  const selected: Candidate[] = [];
  for (const row of rows) {
    const loc = JSON.parse(row.locator_json);
    if (selected.some(other => {
      if (row.source_id !== other.source_id) return false;
      if (row.text === other.text) return true;
      const previous = JSON.parse(other.locator_json);
      const overlap = Math.min(loc.char_end, previous.char_end) - Math.max(loc.char_start, previous.char_start);
      return overlap > 0 && overlap / Math.max(1, Math.min(loc.char_end - loc.char_start, previous.char_end - previous.char_start)) >= .8;
    })) continue;
    selected.push(row);
  }
  return selected;
}

// Node 持有模型凭据和可重建索引；Python 决定来源版本、当前 Goal/草稿权限和真实定位。
// 查询只访问索引及有界校验，不在这里重新扫描/解析原文。后台任务有持久游标，失败仍可关键词检索。
export class RetrievalRuntime {
  private generations = new Map<string, Generation>();
  private active?: Generation;
  private syncGeneration?: Generation;
  private timer?: NodeJS.Timeout;
  private background = false;
  private syncing?: Promise<void>;
  private stopping = false;
  private queryCache = new Map<string, { vector: number[]; until: number }>();
  private traceCache = new Map<string, RetrievalTrace>();
  private lastTraceByRef = new Map<string, string>();
  private syncWarning?: string;
  private unavailableScopes = new Set<string>();
  private scopeControllers = new Map<string, AbortController>();
  private restoredScopes = new Set<string>();
  private readonly deletions: MaterialDeletionCache;
  private materialControllers = new Map<string, AbortController>();
  private queryEpoch = 0;

  async materialDeleted(id: string): Promise<void> {
    this.deletions.block(id);
    await this.sync();
    // 若删除发生于旧sync收尾，仍需一次新核验，不能把事件合并后遗失清理请求。
    await this.sync();
  }

  scopeChanged(scope: string, deleted: boolean): void {
    if (deleted) {
      this.unavailableScopes.add(scope);
      this.scopeControllers.get(scope)?.abort();
    } else {
      this.unavailableScopes.delete(scope);
      this.scopeControllers.delete(scope);
      this.restoredScopes.add(scope);
    }
    // 权威回读立即拒绝，派生目录异步清理；不等待大文件/模型完成才响应用户。
    void this.sync().catch(() => undefined);
  }

  private scopedModels(models: Models, scope: string, sourceId?: string): Models {
    let controller = this.scopeControllers.get(scope);
    if (!controller) {
      controller = new AbortController(); this.scopeControllers.set(scope, controller);
      if (this.unavailableScopes.has(scope)) controller.abort();
    }
    let material = sourceId ? this.materialControllers.get(sourceId) : undefined;
    if (sourceId && !material) {material = new AbortController(); this.materialControllers.set(sourceId, material);}
    const signal = AbortSignal.any([controller.signal, ...(material ? [material.signal] : [])]);
    const run = async <T>(work: () => Promise<T>): Promise<T> => {
      await this.deletions.refresh();
      if (sourceId && this.deletions.has(sourceId)) throw new Error("SOURCE_CHANGED");
      signal.throwIfAborted();
      const result = await work();
      await this.deletions.refresh();
      signal.throwIfAborted();
      return result;
    };
    return {embed: texts => run(() => models.embed(texts, signal)), rerank: models.rerank.bind(models),
      ...(models.analyzeVisual ? {analyzeVisual: (asset, context) => run(() => models.analyzeVisual!(asset, context, signal))} : {}),
      ...(models.extractGraph ? {extractGraph: chunks => run(() => models.extractGraph!(chunks, signal))} : {})};
  }
  constructor(readonly directory: string, readonly backend: SourceBackend, readonly settings: RetrievalSettingsStore,
    private modelFactory: (config: RetrievalSettings) => Models = config =>
      new BailianRetrievalModels(config, () => settings.credential(config.profileId), fetch,
        () => settings.queryModel(config.profileId))) {
    this.deletions = new MaterialDeletionCache(directory, backend, sourceId => {
      this.queryEpoch++; this.queryCache.clear(); this.traceCache.clear(); this.lastTraceByRef.clear();
      this.materialControllers.get(sourceId)?.abort();
    });
  }

  async start(): Promise<void> {
    await mkdir(join(this.directory, "traces"), { recursive: true });
    try {
      const pointer = JSON.parse(await readFile(join(this.directory, "active.json"), "utf8")) as { generation: string };
      if (/^[a-f0-9]{24}$/.test(pointer.generation)) {
        const config = JSON.parse(await readFile(join(this.directory, pointer.generation, "manifest.json"), "utf8")).config;
        this.active = await this.generation(config);
      }
    } catch { /* 初次启动由后台建立索引，不阻塞教学入口。 */ }
    this.background = true;
    void this.sync().catch(() => undefined);
  }
  private async generation(config: RetrievalSettings): Promise<Generation> {
    const id = generationId(config);
    const cached = this.generations.get(id);
    if (cached) { cached.manifest.config = config; return cached; }
    const directory = join(this.directory, id);
    await mkdir(directory, { recursive: true });
    let manifest: Manifest = { config, jobs: {} };
    try { manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")); }
    catch (error) {
      // 只给真正新建、尚无Lance数据的代声明协议；损坏/丢失清单不能把旧数据库自动升级为安全独占。
      if ((error as NodeJS.ErrnoException).code === "ENOENT"
          && !await lstat(join(directory, "lance")).catch((e: NodeJS.ErrnoException) => {if (e.code === "ENOENT") return null; throw e;}))
        manifest.index_access = 1;
    }
    manifest.config = config;
    const index = new LocalRetrievalIndex(join(directory, "lance"), config.dimensions);
    await index.open();
    const generation = { id, index, graph: new SourceGraphStore(join(directory, "graph")), manifest };
    this.generations.set(id, generation);
    return generation;
  }
  private async persist(generation: Generation) {
    for (const id of this.deletions.sourceIds) {delete generation.manifest.jobs[id]; delete generation.manifest.derived?.[id];}
    await atomicJson(join(this.directory, generation.id, "manifest.json"), generation.manifest);
  }
  /** 只能在原目录writer.lock内运行；每个Lance表另等其跨进程在途读写退出后清历史版本。 */
  private async cleanDeletedMaterials(): Promise<void> {
    await this.deletions.refresh();
    const ids = this.deletions.sourceIds;
    if (!ids.length) return;
    const entries = await readdir(this.directory, {withFileTypes: true});
    // 必须先检查所有旧代；不能先清理新代再发现同目录仍有未迁移的旧客户端协议。
    for (const entry of entries.filter(row => /^[0-9a-f]{24}$/.test(row.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("DELETION_GENERATION_PATH_INVALID");
      const path = join(this.directory, entry.name, "manifest.json");
      if ((await lstat(path)).isSymbolicLink()) throw new Error("DELETION_GENERATION_PATH_INVALID");
      if (JSON.parse(await readFile(path, "utf8")).index_access !== 1) throw new Error("INDEX_ACCESS_MIGRATION_REQUIRED");
    }
    for (const entry of entries) {
      if (!/^[0-9a-f]{24}$/.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("DELETION_GENERATION_PATH_INVALID");
      if (!this.deletions.needsCleanup(entry.name)) continue;
      const directory = join(this.directory, entry.name), manifestPath = join(directory, "manifest.json"), lancePath = join(directory, "lance");
      if ((await lstat(manifestPath)).isSymbolicLink() || (await lstat(lancePath).catch(() => null))?.isSymbolicLink()
          || (await lstat(join(directory, "graph")).catch(() => null))?.isSymbolicLink()) throw new Error("DELETION_GENERATION_PATH_INVALID");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
      // 旧进程不会登记访问，不能仅凭新writer.lock假称排除了它的读操作。
      // 旧代须在停旧Gateway/CLI的迁移窗口核验后升级；运行中不能自动补这个标记。
      if (manifest.index_access !== 1) throw new Error("INDEX_ACCESS_MIGRATION_REQUIRED");
      if (!manifest.config || generationId(manifest.config) !== entry.name || !Number.isSafeInteger(manifest.config.dimensions)
          || manifest.config.dimensions < 1 || !manifest.jobs || Array.isArray(manifest.jobs)) throw new Error("DELETION_GENERATION_INVALID");
      const cached = this.generations.get(entry.name), index = cached?.index ?? new LocalRetrievalIndex(lancePath, manifest.config.dimensions);
      try {await index.eraseSources(ids);} finally {if (!cached) index.close();}
      const graph = cached?.graph ?? new SourceGraphStore(join(directory, "graph"));
      for (const id of ids) {await graph.remove(id); delete manifest.jobs[id]; delete manifest.derived?.[id];}
      if (manifest.visual_cursor && this.deletions.has(manifest.visual_cursor)) delete manifest.visual_cursor;
      await atomicJson(manifestPath, manifest);
      if (cached) cached.manifest = manifest;
      this.deletions.markCleaned(entry.name);
      await this.deletions.persist();
    }
    await this.deletions.retryOriginals();
    await this.deletions.cleanTraces();
    await this.deletions.persist();
  }
  async sync(): Promise<void> {
    if (this.stopping) return;
    if (this.syncing) return this.syncing;
    this.syncing = this.performSync().catch(() => { this.syncWarning = "后台索引暂不可用，将在下一次检查时重试。"; })
      .finally(() => { this.syncing = undefined; this.scheduleSync(); });
    return this.syncing;
  }
  private scheduleSync() {
    if (!this.background || this.stopping) return;
    clearTimeout(this.timer);
    const generation = this.syncGeneration ?? this.active;
    const config = generation?.manifest.config;
    const busy = Object.values(generation?.manifest.jobs ?? {}).some(job => job.state === "waiting" || job.state === "indexing")
      || config?.enabled && Object.values(generation?.manifest.derived ?? {}).some(jobs =>
        config.visionEnabled !== false && jobs.vision?.state === "pending"
        || config.graphEnabled !== false && jobs.graph?.state === "pending");
    // 完成后只低频检查权威目录；长模型请求结束后再计时，避免定时器反复排入相同任务。
    this.timer = setTimeout(() => { void this.sync().catch(() => undefined); }, busy ? 5000 : 30_000);
    this.timer.unref();
  }
  private async performSync() {
    await mkdir(this.directory, { recursive: true });
    // Web 与 CLI 可共享同一目录，但只有一个进程写 LanceDB。死进程的锁在下次启动恢复。
    const lockPath = join(this.directory, "writer.lock");
    let lock;
    try { lock = await open(lockPath, "wx"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const pid = Number(await readFile(lockPath, "utf8"));
        // 创建锁后、写 PID 前崩溃会留下空锁。短期视为正在发布，过期后恢复，避免永久卡住入库。
        if (!Number.isSafeInteger(pid) || pid < 1) {
          if (Date.now() - (await stat(lockPath)).mtimeMs > 30_000) await rm(lockPath, { force: true });
          return;
        }
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") await rm(lockPath, { force: true });
      }
      return;
    }
    try {
      await lock.writeFile(String(process.pid));
      await this.cleanDeletedMaterials();
      const config = await this.settings.get();
      const generation = await this.generation(config);
      this.syncGeneration = generation;
      try {
        const saved = JSON.parse(await readFile(join(this.directory,generation.id,"manifest.json"),"utf8")) as Manifest;
        generation.manifest.jobs = saved.jobs;
        generation.manifest.derived = saved.derived;
        generation.manifest.visual_cursor = saved.visual_cursor;
      } catch { /* 初次索引尚无清单。持锁后重新读取，避免 CLI/Web 用各自旧清单重复入库。 */ }
      for (const job of Object.values(generation.manifest.jobs)) {
        if (this.restoredScopes.has(job.scope_id) && job.error_code === "AbortError") job.retry_at = 0;
      }
      for (const jobs of Object.values(generation.manifest.derived ?? {})) for (const job of Object.values(jobs)) {
        if (job.scope_id && this.restoredScopes.has(job.scope_id) && job.error_code === "AbortError") job.retry_at = 0;
      }
      this.restoredScopes.clear();
      if (this.retryRequested) {
        for (const job of Object.values(generation.manifest.jobs)) if (job.state === "lexical_only") job.retry_at = 0;
        for (const jobs of Object.values(generation.manifest.derived ?? {})) for (const job of Object.values(jobs)) job.retry_at = 0;
        this.retryRequested = false;
      }
      // 尚未有完整旧代时，先提供本代关键词结果；换向量模型时保留旧代直到新代全部就绪。
      if (!this.active) {
        this.active = generation;
        await atomicJson(join(this.directory, "active.json"), { generation: generation.id });
      }
      const sources: SourceDescriptor[] = [];
      let offset: number | null = 0;
      let catalogVersion: string | undefined;
      while (offset !== null) {
        const page = await this.backend.catalog(offset);
        if (catalogVersion && catalogVersion !== page.catalog_version) return;
        catalogVersion = page.catalog_version;
        sources.push(...page.sources.filter(source => !this.deletions.has(source.source_id)));
        offset = page.next_offset;
      }
      const ids = new Set(sources.map(source => source.source_id));
      let changed = false;
      for (const sourceId of new Set([...Object.keys(generation.manifest.jobs), ...Object.keys(generation.manifest.derived ?? {})])) {
        if (!ids.has(sourceId)) {
          await generation.index.removeSource(sourceId);
          await generation.graph.remove(sourceId);
          delete generation.manifest.derived?.[sourceId];
          changed = true;
          delete generation.manifest.jobs[sourceId];
        }
      }
      let visualBudget = 3, graphBudget = 6;
      const models = this.modelFactory(config);
      let connection: unknown = config.profileId;
      if (config.enabled && (models.extractGraph || models.analyzeVisual)) {
        try {connection = await this.settings.queryModel(config.profileId);} catch { /* 测试适配器可自行提供模型。 */ }
      }
      const visionFingerprint = hash(["visual-v1", connection, config.visionModel ?? ""]);
      const graphFingerprint = hash(["graph-v2", connection, config.extractionModel ?? ""]);
      generation.manifest.derived ??= {};
      // 上轮最后处理的文件之后继续，避免一个大 PDF 永远占满三张图的预算。
      const cursor = sources.findIndex(source => source.source_id === generation.manifest.visual_cursor);
      const ordered = cursor < 0 ? sources : [...sources.slice(cursor + 1), ...sources.slice(0, cursor + 1)];
      for (let source of ordered) {
        if (this.stopping) break;
        if (this.unavailableScopes.has(scopeId(source)) || this.deletions.has(source.source_id)) continue;
        const scoped = this.scopedModels(models, scopeId(source), source.source_id);
        const job = generation.manifest.jobs[source.source_id];
        if (source.parse_status !== "ready") {
          generation.manifest.jobs[source.source_id] = { version: source.version, scope_id: scopeId(source),
            state: "waiting", cursor: 0, chunks: 0, attempts: 0, retry_at: 0, updated_at: new Date().toISOString(),
            warning: source.parse_status === "failed" ? "解析未完成，原文件已保留。" : "资料正在后台解析。" };
          continue;
        }
        const derived = generation.manifest.derived[source.source_id] ??= {};
        const visionEnabled = config.enabled && config.visionEnabled !== false && source.kind === "material" && models.analyzeVisual
          && this.backend.visualPlan && this.backend.visualAsset && this.backend.publishVisual;
        if (visionEnabled && (!derived.vision || derived.vision.version !== source.version
          || derived.vision.scope_id !== scopeId(source) || derived.vision.fingerprint !== visionFingerprint)) {
          derived.vision = {state: "pending", retry_at: 0, completed: 0, total: source.visual_count ?? 0,
            version: source.version, scope_id: scopeId(source), fingerprint: visionFingerprint};
        }
        if (visionEnabled && source.visual_count === 0) {
          derived.vision = {state: "ready", retry_at: 0, completed: 0, total: 0,
            version: source.version, scope_id: scopeId(source), fingerprint: visionFingerprint};
        }
        if (visionEnabled && derived.vision?.state !== "ready" && visualBudget > 0 && (derived.vision?.retry_at ?? 0) <= Date.now()) {
          const previousAttempts = derived.vision?.attempts ?? 0;
          let published = false;
          try {
            const materialId = source.source_id.slice(9), plan = await this.backend.visualPlan!(materialId, visionFingerprint);
            derived.vision = {state: plan.completed === plan.total ? "ready" : "pending", retry_at: 0, completed: plan.completed, total: plan.total,
              version: source.version, scope_id: scopeId(source), fingerprint: visionFingerprint};
            for (const asset of plan.assets) {
              if (visualBudget <= 0 || this.stopping || this.unavailableScopes.has(scopeId(source))) break;
              visualBudget--;
              generation.manifest.visual_cursor = source.source_id;
              const original = await this.backend.visualAsset!(materialId, asset.id);
              const analysis = await scoped.analyzeVisual!(original, asset.context);
              await this.backend.publishVisual!({material_id: materialId, source_hash: plan.source_hash, parser_version: plan.parser_version,
                fingerprint: visionFingerprint, asset_id: asset.id, analysis});
              published = true;
              derived.vision.completed++;
            }
            if (derived.vision.completed === plan.total) derived.vision.state = "ready";
          } catch (error) {
            const attempts = previousAttempts + 1;
            derived.vision = {...(derived.vision ?? {completed: 0, total: 0}), state: "failed", attempts,
              retry_at: Date.now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(attempts, 7)),
              error_code: derivedErrorCode(error, "VISUAL_PROCESSING_FAILED"),
              warning: "视觉识别未完成，文字可继续检索；请检查视觉模型配置后重试。"};
          } finally {
            // 发布改变 visual_revision；部分成功后失败也要保存新版本，防止下一轮绕过退避。
            if (published) {
              try {
                source = (await this.backend.chunks(source.source_id, 0)).source;
                derived.vision!.version = source.version; derived.vision!.scope_id = scopeId(source);
              } catch {
                derived.vision = {...derived.vision!, state: "failed", retry_at: Date.now() + 60_000,
                  error_code: "SOURCE_CHANGED", warning: "视觉结果发布后来源已变化，等待权威目录重新校验。"};
              }
            }
          }
        }
        if (this.unavailableScopes.has(scopeId(source))) continue;
        if (config.enabled && config.graphEnabled !== false && models.extractGraph &&
          (!derived.graph || derived.graph.version !== source.version || derived.graph.scope_id !== scopeId(source) || derived.graph.fingerprint !== graphFingerprint)) {
          derived.graph = {state: "pending", retry_at: 0, completed: 0, total: job?.chunks ?? 0,
            version: source.version, scope_id: scopeId(source), fingerprint: graphFingerprint};
        }
        if (!(job?.version === source.version && job.scope_id === scopeId(source) && job.vector_enabled === config.enabled
            && (job.state === "ready" || job.retry_at > Date.now()))) {
          await this.indexSource(generation, source, config); changed = true;
        }
        if (this.unavailableScopes.has(scopeId(source))) continue;
        if (config.enabled && config.graphEnabled !== false && models.extractGraph && graphBudget > 0
          && (derived.graph?.retry_at ?? 0) <= Date.now()) {
          const previousAttempts = derived.graph?.attempts ?? 0;
          try {
            let record = await generation.graph.load(source.source_id);
            if (record && (record.version !== source.version || record.scope_id !== scopeId(source) || record.fingerprint !== graphFingerprint)) {
              record = await generation.graph.rebase(source, graphFingerprint, await generation.index.sourceRows(source.source_id));
            }
            if (!record?.ready) {
              graphBudget--;
              derived.graph = {state: "pending", retry_at: 0, completed: record?.cursor ?? 0, total: generation.manifest.jobs[source.source_id]?.chunks ?? 0,
                version: source.version, scope_id: scopeId(source), fingerprint: graphFingerprint};
              await this.persist(generation);
              const offset = record?.cursor ?? 0, page = await this.backend.chunks(source.source_id, offset);
              if (page.source.version !== source.version || scopeId(page.source) !== scopeId(source)) throw new Error("SOURCE_CHANGED");
              const batch = page.chunks.slice(0, 5), next = offset + batch.length;
              const ready = batch.length === page.chunks.length && page.next_offset === null;
              await generation.graph.append(source, graphFingerprint, batch, next, ready, scoped);
              const check = (await this.backend.chunks(source.source_id, 0)).source;
              if (check.version !== source.version || scopeId(check) !== scopeId(source)) {await generation.graph.remove(source.source_id); throw new Error("SOURCE_CHANGED");}
              record = await generation.graph.load(source.source_id);
            }
            derived.graph = {state: record?.ready ? "ready" : "pending", retry_at: 0, completed: record?.cursor ?? 0,
              total: generation.manifest.jobs[source.source_id]?.chunks ?? 0, rejected_relations: record?.rejected_relations ?? 0,
              truncated_entities: record?.truncated_entities ?? 0,
              relations: record?.relations.length ?? 0, rejection_reasons: record?.rejection_reasons,
              version: source.version, scope_id: scopeId(source), fingerprint: graphFingerprint,
              ...(record?.rejected_relations || record?.truncated_entities ? {warning: "部分模型关系未通过出处或数量校验，已丢弃。"} : {})};
          } catch (error) {
            const attempts = previousAttempts + 1;
            derived.graph = {...(derived.graph ?? {completed: 0, total: 0}), state: "failed", attempts,
              retry_at: Date.now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(attempts, 7)),
              error_code: derivedErrorCode(error, "GRAPH_PROCESSING_FAILED"),
              warning: "图谱抽取或来源校验未完成，保留普通检索并自动重试。"};
          }
        }
      }
      await this.persist(generation);
      const allReady = sources.filter(source => source.parse_status === "ready").every(source =>
        generation.manifest.jobs[source.source_id]?.state === "ready");
      if (changed && allReady && !this.stopping) await generation.index.maintain();
      if (generation !== this.active && allReady) {
        this.active = generation;
        await atomicJson(join(this.directory, "active.json"), { generation: generation.id });
        this.queryCache.clear();
      }
      await this.cleanDeletedMaterials();
      this.syncWarning = undefined;
    } finally { await lock.close(); await rm(lockPath, { force: true }); }
  }
  private async indexSource(generation: Generation, source: SourceDescriptor, config: RetrievalSettings) {
    const existing = await generation.index.sourceRows(source.source_id);
    const vectors = new Map(existing.filter(row => row.has_vector).map(row =>
      [row.embedding_hash, Array.from(row.vector)]));
    let job = generation.manifest.jobs[source.source_id];
    const unchanged = job?.version === source.version && job.scope_id === scopeId(source);
    if (!unchanged) {
      await generation.index.removeSource(source.source_id);
      job = { version: source.version, scope_id: scopeId(source), state: "indexing", cursor: 0,
        chunks: 0, attempts: 0, retry_at: 0, updated_at: new Date().toISOString() };
      generation.manifest.jobs[source.source_id] = job;
      await this.persist(generation);
    }
    let offset: number | null = unchanged && job!.state === "indexing" ? job!.cursor : 0;
    job!.state = "indexing";
    job!.vector_enabled = config.enabled;
    const models = this.scopedModels(this.modelFactory(config), scopeId(source), source.source_id);
    let vectorFailed = false;
    let vectorFailure: unknown;
    try {
      while (offset !== null && !this.stopping && !this.unavailableScopes.has(scopeId(source))) {
        const page = await this.backend.chunks(source.source_id, offset);
        await this.deletions.refresh();
        if (this.deletions.has(source.source_id)) throw new Error("SOURCE_CHANGED");
        if (page.source.version !== source.version || scopeId(page.source) !== scopeId(source)) throw new Error("SOURCE_CHANGED");
        const rows: IndexRow[] = page.chunks.map(chunk => ({ id: hash([source.source_id, source.version, chunk.chunk_id]),
          source_id: source.source_id, source_version: source.version, kind: source.kind, name: source.name,
          scope_id: scopeId(source), goal_name: source.goal_name, skill_id: source.skill_id,
          chunk_id: chunk.chunk_id, ordinal: chunk.ordinal, text: chunk.retrieval_text ?? chunk.text, heading: chunk.heading ?? "",
          locator_json: JSON.stringify(chunk.locator), source_ref: chunk.source_ref, lexical_text: chunk.lexical_text,
          embedding_hash: chunk.embedding_hash, vector: vectors.get(chunk.embedding_hash) ?? Array(config.dimensions).fill(0),
          has_vector: vectors.has(chunk.embedding_hash) }));
        await generation.index.upsert(rows);
        job!.chunks = Math.max(job!.chunks, offset + rows.length);
        if (config.enabled && !vectorFailed) {
          // 每批先落关键词索引，再落向量；游标只在成功批次后提交，中断后允许重复批次但不丢来源。
          try { for (let at = 0; at < rows.length; at += 10) {
            const batch = rows.slice(at, at + 10);
            const missing = batch.filter(row => !row.has_vector);
            if (missing.length) {
              const textById = new Map(page.chunks.map(chunk => [chunk.chunk_id, chunk.embedding_text]));
              const embedded = await models.embed(missing.map(row => textById.get(row.chunk_id)!));
              missing.forEach((row,i) => { row.vector = embedded[i]!; row.has_vector = true; });
              await generation.index.upsert(missing);
            }
          } } catch (error) { vectorFailed = true; vectorFailure = error; }
        }
        offset = page.next_offset;
        job!.cursor = offset ?? job!.chunks;
        job!.updated_at = new Date().toISOString();
        await this.persist(generation);
      }
      if (vectorFailed) throw vectorFailure;
      if (!this.stopping && !this.unavailableScopes.has(scopeId(source))) { job!.state = "ready"; job!.retry_at = 0; delete job!.warning; delete job!.error_code; }
    } catch (error) {
      job!.state = "lexical_only";
      job!.attempts++;
      job!.retry_at = Date.now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(job!.attempts, 7));
      job!.warning = "来源已保留；本次向量入库未完成，稍后自动重试。";
      const message = error instanceof Error ? error.message : "";
      job!.error_code = /^检索模型 HTTP \d+(?: \([a-zA-Z0-9_.-]+\))?$/.test(message) ||
        /^向量模型返回/.test(message) || message === "SOURCE_CHANGED" ? message.slice(0,200)
        : derivedErrorCode(error, "INGESTION_FAILED");
    }
    await this.persist(generation);
  }
  async status() {
    await this.deletions.refresh();
    const config = await this.settings.get();
    const pending = this.generations.get(generationId(config));
    const generation = pending ?? this.active;
    const graphs = (await generation?.graph.records() ?? []).filter(record => !this.deletions.has(record.source_id));
    const bySource = new Map(graphs.map(record => [record.source_id, record]));
    return { enabled: config.enabled, active_generation: this.active?.id ?? null,
      building_generation: generation && generation !== this.active ? generation.id : null,
      chunks: await this.active?.index.count() ?? 0, warning: this.syncWarning ?? null,
      graph_entities: graphs.reduce((n,r) => n + r.entities.length, 0), graph_relations: graphs.reduce((n,r) => n + r.relations.length, 0),
      graph_rejected_relations: graphs.reduce((n,r) => n + (r.rejected_relations ?? 0), 0),
      graph_truncated_entities: graphs.reduce((n,r) => n + (r.truncated_entities ?? 0), 0),
      sources: Object.entries(generation?.manifest.jobs ?? {}).filter(([id]) => !this.deletions.has(id)).map(([source_id, job]) => {
        const derived = generation?.manifest.derived?.[source_id], record = bySource.get(source_id);
        const compatible = record && derived?.graph && record.version === job.version && record.scope_id === job.scope_id
          && record.version === derived.graph.version && record.fingerprint === derived.graph.fingerprint;
        return {source_id, ...job, derived: compatible ? {...derived, graph: {...derived.graph, relations: record.relations.length,
          rejected_relations: record.rejected_relations, truncated_entities: record.truncated_entities, rejection_reasons: record.rejection_reasons}} : derived};
      }) };
  }
  async retry() {
    for (const generation of this.generations.values()) {
      for (const job of Object.values(generation.manifest.jobs)) if (job.state === "lexical_only") job.retry_at = 0;
      // retry 不直接写共享清单；下次持锁同步会合并此请求，避免越过唯一写入者。
    }
    this.retryRequested = true;
    await this.sync();
  }
  private retryRequested = false;
  private async queryVector(query: string, generation: Generation, models: Models, signal: AbortSignal) {
    const epoch = this.queryEpoch;
    const key = generation.id + ":" + query;
    const cached = this.queryCache.get(key);
    if (cached && cached.until > Date.now()) return cached.vector;
    const vectors = await models.embed([query], signal);
    const vector = vectors[0]!;
    if (epoch === this.queryEpoch) this.queryCache.set(key, { vector, until: Date.now() + 15 * 60_000 });
    if (this.queryCache.size > 64) this.queryCache.delete(this.queryCache.keys().next().value!);
    return vector;
  }
  async search(input: SearchInput, draft?: string | null, signal?: AbortSignal) {
    await this.deletions.refresh();
    if (!input.query.trim() || input.query.length > 1000) throw new Error("问题须为 1–1000 个字符。");
    const scope = input.scope ?? "current";
    const started = performance.now();
    const deadline = AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]);
    const trace: RetrievalTrace = { id: randomUUID(), at: new Date().toISOString(), query: input.query, scope,
      current_scope: "", generation: "", stages: {}, timings_ms: {}, warnings: [], reads: [] };
    const timed = async <T>(stage: string, work: () => Promise<T>, budget?: number): Promise<T> => {
      const at = performance.now();
      const stageSignal = budget ? AbortSignal.any([deadline, AbortSignal.timeout(budget)]) : deadline;
      let onAbort: () => void = () => undefined;
      try {
        return await Promise.race([work(), new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error("RETRIEVAL_TIMEOUT"));
          if (stageSignal.aborted) onAbort(); else stageSignal.addEventListener("abort", onAbort, { once: true });
        })]);
      } finally {
        stageSignal.removeEventListener("abort", onAbort);
        trace.timings_ms[stage] = Math.round(performance.now() - at);
      }
    };
    const context = await timed("scope", () => this.backend.context(input.query, scope, draft));
    trace.current_scope = context.current_scope;
    const generation = this.active;
    if (!generation) {
      trace.warnings.push("INDEX_BUILDING");
      await this.saveTrace(trace);
      return { status: "index_building", matches: [], trace_id: trace.id, warnings: trace.warnings };
    }
    trace.generation = generation.id;
    if (Object.values(generation.manifest.jobs).some(job => context.allowed_scopes.includes(job.scope_id)
        && job.state !== "ready")) trace.warnings.push("SOURCE_INDEX_INCOMPLETE");
    const config = await this.settings.get();
    const embeddingConfig = { ...generation.manifest.config, enabled: config.enabled };
    if (config.enabled && Object.entries(generation.manifest.derived ?? {}).some(([sourceId,jobs]) =>
      context.allowed_scopes.includes(generation.manifest.jobs[sourceId]?.scope_id ?? "") &&
      Object.entries(jobs).some(([kind,j]) => (kind === "vision" ? config.visionEnabled : config.graphEnabled) !== false && j.state !== "ready"))) {
      trace.warnings.push("DERIVED_INDEX_INCOMPLETE");
    }
    if (config.enabled && config.graphEnabled !== false && Object.entries(generation.manifest.derived ?? {}).some(([id,jobs]) =>
      context.allowed_scopes.includes(generation.manifest.jobs[id]?.scope_id ?? "") &&
      (jobs.graph?.rejected_relations || jobs.graph?.truncated_entities))) trace.warnings.push("GRAPH_EXTRACTION_GAPS");
    let invalidCandidates = false;
    const attempt = async (query: string, suffix: string): Promise<Candidate[]> => {
      const stage = (name: string) => name + suffix;
      const queryContext = suffix ? await timed(stage("scope"), () => this.backend.context(query, scope, draft)) : context;
      // 重查只换检索词，不能跟着并发切换的 Goal 或模型输出扩大资料范围。
      if (queryContext.current_scope !== context.current_scope ||
          JSON.stringify([...queryContext.allowed_scopes].sort()) !== JSON.stringify([...context.allowed_scopes].sort())) {
        throw new Error("SOURCE_SCOPE_CHANGED");
      }
      const denseBudget = suffix ? 1500 : 3500;
      const lexicalWork = timed(stage("bm25"), () => generation.index.lexical(queryContext.lexical_query, context.allowed_scopes,
        input.kinds, input.material_id)).catch(() => { trace.warnings.push("LEXICAL_UNAVAILABLE"); return [] as Candidate[]; });
      const vectorWork = config.enabled ? this.queryVector(query, generation, this.modelFactory(embeddingConfig),
        AbortSignal.any([deadline, AbortSignal.timeout(denseBudget)])) : Promise.resolve(undefined);
      const denseWork = config.enabled ? timed(stage("dense"), async () => {
        const vector = (await vectorWork)!;
        if (deadline.aborted) throw new Error("RETRIEVAL_TIMEOUT");
        return generation.index.dense(vector, context.allowed_scopes, input.kinds, input.material_id);
      }, denseBudget).catch(() => { trace.warnings.push("DENSE_UNAVAILABLE_LEXICAL_FALLBACK"); return [] as Candidate[]; }) : Promise.resolve([]);
      const graphWork = config.enabled && config.graphEnabled !== false ? timed(stage("graph"), async () => {
        const vector = await vectorWork.catch(() => undefined);
        return generation.graph.search(query, vector, context.allowed_scopes, generation.index, input.kinds, input.material_id);
      }, denseBudget + 300).catch(() => {trace.warnings.push("GRAPH_UNAVAILABLE"); return [] as Candidate[];}) : Promise.resolve([] as Candidate[]);
      const [lexical, dense, graph] = await Promise.all([lexicalWork, denseWork, graphWork]);
      trace.stages[stage("bm25")] = lexical.map(preview); trace.stages[stage("dense")] = dense.map(preview);
      trace.stages[stage("graph")] = graph.map(preview);
      let fused = deduplicateCandidates(fuseCandidates(lexical, dense, graph)).slice(0, 30);
      trace.stages[stage("fusion")] = fused.map(preview);
      // 两轮均在精排前后核对真实版本。失效引用不是需要改写问题的信号。
      try {
        const valid = new Set(await timed(stage("validate"), () => this.backend.validate([...new Set(fused.flatMap(row =>
          [row.source_ref, ...(row.graph_context?.map(edge => edge.source_ref) ?? [])]))], scope, draft)));
        fused = fused.filter(row => {
          if (!row.graph_context?.some(edge => !valid.has(edge.source_ref))) return true;
          invalidCandidates = true; delete row.graph_context;
          return "bm25" in row.score_parts || "dense" in row.score_parts;
        });
        invalidCandidates ||= fused.some(row => !valid.has(row.source_ref));
        fused = fused.filter(row => valid.has(row.source_ref));
      } catch { trace.warnings.push("SOURCE_VALIDATION_UNAVAILABLE"); fused = []; }
      let selected = fused;
      if (config.enabled && fused.length && !deadline.aborted) {
        const rerankBudget = suffix ? 1200 : 3000;
        try {
          const reranked = await timed(stage("rerank"), () => this.modelFactory(config).rerank(input.query,
            fused.map(row => row.name + "\n" + row.heading + "\n" + row.text + (row.graph_context ? "\n机器抽取关联（需回读核对）：" +
              row.graph_context.map(edge => edge.from + " → " + edge.relation + " → " + edge.to + "；原文：" + edge.quote).join("\n") : "")),
            AbortSignal.any([deadline, AbortSignal.timeout(rerankBudget)])), rerankBudget);
          selected = reranked.map(row => ({ ...fused[row.index]!, score: row.score,
            score_parts: { ...fused[row.index]!.score_parts, rerank: row.score } })).sort((a,b) => b.score - a.score);
          trace.stages[stage("rerank")] = selected.map(preview);
          selected = selected.filter(row => row.score >= config.minimumRerankScore);
        } catch { trace.warnings.push("RERANK_UNAVAILABLE_FUSION_FALLBACK"); }
      }
      try {
        const valid = new Set(await timed(stage("validate_after_rerank"), () =>
          this.backend.validate([...new Set(selected.flatMap(row => [row.source_ref, ...(row.graph_context?.map(edge => edge.source_ref) ?? [])]))], scope, draft)));
        selected = selected.filter(row => {
          if (!row.graph_context?.some(edge => !valid.has(edge.source_ref))) return true;
          invalidCandidates = true; delete row.graph_context;
          return "bm25" in row.score_parts || "dense" in row.score_parts;
        });
        invalidCandidates ||= selected.some(row => !valid.has(row.source_ref));
        selected = selected.filter(row => valid.has(row.source_ref));
      } catch { trace.warnings.push("SOURCE_VALIDATION_UNAVAILABLE"); selected = []; }
      return selected;
    };
    let selected = await attempt(input.query, "");
    trace.query_refinement = { status: "not_needed" };
    const models = this.modelFactory(config);
    if (!selected.length && config.enabled && models.refineQuery && !trace.warnings.length && !invalidCandidates) {
      if (performance.now() - started <= 4000 && !deadline.aborted) {
        try {
          const expanded = await timed("query_refinement", () => models.refineQuery!(input.query,
            AbortSignal.any([deadline, AbortSignal.timeout(2000)])), 2000);
          if (expanded && !expanded.startsWith(input.query)) throw new Error("INVALID_QUERY_REFINEMENT");
          if (expanded && expanded !== input.query && expanded.length <= 1000) {
            trace.query_refinement = { status: "used", query: expanded };
            selected = await attempt(expanded, "_retry");
          } else trace.query_refinement = { status: "unchanged" };
        } catch {
          trace.query_refinement = { ...trace.query_refinement, status: "unavailable" };
          trace.warnings.push("QUERY_REFINEMENT_UNAVAILABLE");
        }
      } else trace.query_refinement = { status: "budget_skipped" };
    }
    trace.timings_ms.total = Math.round(performance.now() - started);
    await this.saveTrace(trace);
    await this.deletions.refresh();
    const matches = selected.filter(row => {
      if (this.deletions.has(row.source_id)) return false;
      if (row.graph_context?.some(edge => this.deletions.containsDeleted(edge.source_ref))) {
        delete row.graph_context;
        return "bm25" in row.score_parts || "dense" in row.score_parts;
      }
      return true;
    }).slice(0, Math.max(1, Math.min(input.limit ?? 5, 10))).map(row => {
      this.lastTraceByRef.delete(row.source_ref);
      this.lastTraceByRef.set(row.source_ref, trace.id);
      if (this.lastTraceByRef.size > 500) this.lastTraceByRef.delete(this.lastTraceByRef.keys().next().value!);
      return { ...preview(row), source_ref: row.source_ref, kind: row.kind, source_version: row.source_version,
        material_id: row.kind === "material" ? row.source_id.slice(9) : undefined,
        read_locator: { chunk_id: row.chunk_id, ...(row.kind === "material" ? { material_id: row.source_id.slice(9) } : {}) },
        scope, source_goal_id: row.scope_id.startsWith("draft:") ? null : row.scope_id };
    });
    return { query: input.query, scope, status: matches.length ? "matches" : "no_relevant_match", matches,
      trace_id: trace.id, query_refinement: trace.query_refinement, warnings: trace.warnings, degraded: trace.warnings.length > 0,
      notice: "排序分数不代表事实正确性。机器图谱路径是资料派生关系，需要逐一 Read 路径中的 source_ref；视觉转录/图像说明需核对原图。资料、笔记、卡片和图谱均不是学习 Evidence。" };
  }
  async read(ref: string, scope: SearchScope = "current", options: Record<string, string | number> = {},
    draft?: string | null, traceId?: string) {
    const value = await this.backend.read(ref, scope, options, draft);
    const id = traceId ?? this.lastTraceByRef.get(ref);
    if (id) {
      const trace = await this.trace(id);
      if (trace) {
        trace.reads.push({ source_ref: ref, citation: value.citation, citation_ref: value.citation_ref,
          locator: value.locator, estimated_tokens: value.estimated_tokens });
        if (Array.isArray(value.context)) for (const context of value.context) {
          trace.reads.push({source_ref:ref,citation:context.citation,citation_ref:context.citation_ref,locator:context.locator,context:true});
        }
        trace.reads = trace.reads.slice(-20);
        await this.saveTrace(trace);
      }
    }
    await this.deletions.refresh();
    if (this.deletions.containsDeleted(ref) || !(await this.backend.validate([ref], scope, draft)).includes(ref)) throw new Error("SOURCE_CHANGED");
    return value;
  }
  async recordMaterialRead(materialId: string, value: Record<string, unknown>) {
    // 兼容旧 Read 的真实范围也进入诊断；只关联该材料最近返回过的候选，不伪造新的阅读。
    const entry = [...this.lastTraceByRef.entries()].reverse().find(([ref]) => {
      const payload = JSON.parse(Buffer.from(ref, "base64url").toString("utf8"));
      return payload.source_id === "material:" + materialId &&
        (!value.chunk_id || payload.chunk_id === value.chunk_id);
    });
    if (!entry) return;
    const trace = await this.trace(entry[1]);
    if (!trace) return;
    trace.reads.push({ source_ref: entry[0], citation: value.citation, citation_ref: value.citation_ref,
      locator: value.locator, estimated_tokens: value.estimated_tokens });
    if (Array.isArray(value.context)) for (const context of value.context) {
      trace.reads.push({source_ref:entry[0],citation:context.citation,citation_ref:context.citation_ref,locator:context.locator,context:true});
    }
    trace.reads = trace.reads.slice(-20);
    await this.saveTrace(trace);
  }
  private async saveTrace(trace: RetrievalTrace) {
    try {await this.deletions.withTrace(() => this.saveTraceUnsafe(trace));}
    catch (error) {
      // 诊断清理短暂排他期间可以不留新诊断，不能因此阻断已经有效核验的检索结果。
      if (!(error instanceof Error) || error.message !== "INDEX_MAINTENANCE_PENDING") throw error;
    }
  }
  private async saveTraceUnsafe(trace: RetrievalTrace) {
    await this.deletions.refresh();
    if (this.deletions.containsDeleted(trace)) {
      this.traceCache.delete(trace.id);
      await rm(join(this.directory, "traces", trace.id + ".json"), {force: true}); return;
    }
    this.traceCache.set(trace.id, trace);
    if (this.traceCache.size > 100) this.traceCache.delete(this.traceCache.keys().next().value!);
    await atomicJson(join(this.directory, "traces", trace.id + ".json"), trace);
    await this.deletions.refresh();
    if (this.deletions.containsDeleted(trace)) {this.traceCache.delete(trace.id); await rm(join(this.directory, "traces", trace.id + ".json"), {force: true}); return;}
    const files = (await readdir(join(this.directory, "traces"))).filter(file => /^[a-f0-9-]{36}\.json$/.test(file));
    if (files.length > 100) {
      const dated = await Promise.all(files.map(async file => {
        const value = JSON.parse(await readFile(join(this.directory, "traces", file), "utf8"));
        return { file, at: value.at };
      }));
      dated.sort((a,b) => a.at.localeCompare(b.at));
      for (const old of dated.slice(0, files.length - 100)) await rm(join(this.directory, "traces", old.file), { force: true });
    }
  }
  async trace(id: string): Promise<RetrievalTrace | null> {
    if (!/^[a-f0-9-]{36}$/.test(id)) return null;
    await this.deletions.refresh();
    try {return await this.deletions.withTrace(async () => {
      const value = this.traceCache.get(id) ?? JSON.parse(await readFile(join(this.directory, "traces", id + ".json"), "utf8"));
      await this.deletions.refresh();
      if (this.deletions.containsDeleted(value)) {this.traceCache.delete(id); await rm(join(this.directory, "traces", id + ".json"), {force: true}); return null;}
      return value;
    });}
    catch { return null; }
  }
  async traces() {
    const files = (await readdir(join(this.directory, "traces"))).filter(file => /^[a-f0-9-]{36}\.json$/.test(file));
    const traces = await Promise.all(files.map(file => this.trace(file.slice(0,-5))));
    return traces.filter((value): value is RetrievalTrace => value !== null)
      .sort((a,b) => b.at.localeCompare(a.at)).slice(0, 20)
      .map(({ id, at, query, scope, warnings }) => ({ id, at, query, scope, warnings }));
  }
  async stop() {
    this.stopping = true;
    this.background = false;
    clearTimeout(this.timer);
    await this.syncing;
    for (const generation of this.generations.values()) generation.index.close();
  }
}
