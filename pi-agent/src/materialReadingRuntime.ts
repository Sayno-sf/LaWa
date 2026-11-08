import {defineTool} from "@earendil-works/pi-coding-agent";
import {Type} from "typebox";
import {MaterialReadingClient, MaterialReadingExecutor, ReadingExecutionError, type ReadingJob, type ReadingSelection} from "./materialReading.js";

const runnable = new Set(["QUEUED", "READING", "INTEGRATING"]);
const keyOf = (id: string, scope: string) => JSON.stringify([scope, id]);
/** 实例级有界阅读调度。只恢复资源工作，完成事件不伪造学生消息或推进Pi分支。 */
export class MaterialReadingRuntime {
  readonly client: MaterialReadingClient;
  private readonly executor: MaterialReadingExecutor;
  private jobs = new Map<string, {id: string; scope: string; role: "basis" | "supplementary"; after: number}>();
  private active?: {key: string; controller: AbortController};
  private pumping = false;
  private requested = false;
  private discover = false;
  private disposed = false;
  private lifecycle = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe: () => void;
  private completionListeners = new Set<() => void>();
  constructor(options: {baseUrl: string; selection: () => Promise<ReadingSelection>; fetcher?: typeof fetch;
    onComplete?: (job: ReadingJob) => void; onError?: (code: string) => void}) {
    this.client = new MaterialReadingClient(options.baseUrl, options.fetcher);
    this.executor = new MaterialReadingExecutor(this.client, options.selection);
    this.onComplete = options.onComplete; this.onError = options.onError;
    this.unsubscribe = this.executor.activity.onIdle(() => this.wake());
  }
  private readonly onComplete?: (job: ReadingJob) => void;
  private readonly onError?: (code: string) => void;
  start(): void {this.discover = true; this.wake();}
  onCompleted(listener: () => void): () => void {this.completionListeners.add(listener); return () => {this.completionListeners.delete(listener);};}
  wake(recheck = false): void {
    if (this.disposed) return;
    if (recheck) {for (const job of this.jobs.values()) job.after = 0;}
    this.requested = true;
    if (this.timer) {clearTimeout(this.timer); this.timer = undefined;}
    if (!this.pumping) void this.pump();
  }
  async enqueue(id: string, scope: string, role: "basis" | "supplementary", signal?: AbortSignal): Promise<ReadingJob> {
    const job = await this.client.enqueue(id, scope, role, signal);
    const key = keyOf(id, job.source.scope);
    if (runnable.has(job.state)) this.jobs.set(key, {id, scope: job.source.scope, role: job.role, after: 0});
    else this.jobs.delete(key);
    this.wake(); return job;
  }
  async cancel(id: string, scope: string): Promise<ReadingJob> {
    const key = keyOf(id, scope);
    if (this.active?.key === key) this.active.controller.abort(new Error("READING_CANCELED"));
    const job = await this.client.cancel(id, scope);
    this.jobs.delete(key); return job;
  }
  /** Kernel已确认删除，不再发cancel请求；取消本实例在途调用并从队列移除，避免404后再排回。 */
  materialDeleted(id: string): void {
    for (const [key, job] of this.jobs) if (job.id === id) {
      if (this.active?.key === key) this.active.controller.abort(new Error("READING_SOURCE_DELETED"));
      this.jobs.delete(key);
    }
  }
  async status(id: string, scope: string, signal?: AbortSignal): Promise<object> {
    return materialReadingSummary(await this.client.get(id, scope, signal));
  }
  private async pump(): Promise<void> {
    if (this.pumping || this.disposed) return;
    this.pumping = true;
    try {
      do {
        this.requested = false;
        if (this.discover) {
          this.discover = false;
          let offset = 0;
          for (;;) {
            const page = await this.client.pending(offset, this.lifecycle.signal);
            for (const job of page.jobs) this.jobs.set(keyOf(job.source.material_id, job.source.scope), {id: job.source.material_id, scope: job.source.scope, role: job.role, after: 0});
            if (page.next_offset === null) break;
            if (page.next_offset <= offset) throw new ReadingExecutionError("READING_DISCOVERY_INVALID");
            offset = page.next_offset;
          }
        }
        if (this.executor.activity.busy || this.disposed) break;
        const eligible = [...this.jobs.entries()].filter(([, job]) => job.after <= Date.now());
        const entry = eligible.find(([, job]) => job.role === "basis") ?? eligible[0];
        if (!entry) break;
        const [key, job] = entry;
        this.active = {key, controller: new AbortController()};
        try {
          const result = await this.executor.step(job.id, job.scope, this.active.controller.signal);
          if (!result.ran) break;
          if (runnable.has(result.value.state)) {this.jobs.delete(key); this.jobs.set(key, job); this.requested = true;}
          else {
            this.jobs.delete(key);
            if (result.value.state === "READY") {
              this.onComplete?.(result.value);
              for (const listener of this.completionListeners) {try {listener();} catch {}}
            }
          }
        } catch (error) {
          if (!this.disposed && this.jobs.has(key)) {
            // 前台抢占后由idle事件重唤；API故障/旧Goal/活跃租约慢重试，不高频扫全库。
            const preempted = this.active.controller.signal.aborted || this.executor.activity.busy;
            job.after = preempted ? 0 : Date.now() + 30_000;
            if (!preempted) {
              const code = error instanceof ReadingExecutionError ? error.code : "READING_RUNTIME_FAILED";
              this.onError?.(code);
              try {
                const actual = await this.client.get(job.id, job.scope);
                if (!runnable.has(actual.state)) this.jobs.delete(key);
              } catch (lookup) {
                if (lookup instanceof ReadingExecutionError && (lookup.status === 404 || lookup.code === "READING_SOURCE_CHANGED")) this.jobs.delete(key);
              }
            }
          }
        } finally {this.active = undefined;}
      } while (this.requested && !this.disposed && !this.executor.activity.busy);
    } catch (error) {
      if (!this.disposed) this.onError?.(error instanceof ReadingExecutionError ? error.code : "READING_RUNTIME_FAILED");
      // Kernel比Gateway晚启动时仍须自动接续，不能要求学习者再发一条消息来恢复后台任务。
      this.discover = true;
    } finally {
      this.pumping = false;
      if (!this.disposed && (this.discover || this.jobs.size) && !this.executor.activity.busy) {
        const delay = this.discover ? 30_000 : Math.max(1000, Math.min(...[...this.jobs.values()].map(job => Math.max(0, job.after - Date.now()))));
        this.timer = setTimeout(() => this.wake(), delay); this.timer.unref();
      }
    }
  }
  dispose(): void {
    this.completionListeners.clear();
    this.disposed = true; this.unsubscribe();
    this.lifecycle.abort();
    if (this.timer) clearTimeout(this.timer);
    this.active?.controller.abort(new Error("READING_RUNTIME_DISPOSED"));
  }
}

export function materialReadingSummary(job: ReadingJob): object {
  return {material_id: job.source.material_id, source_hash: job.source.source_hash, state: job.state, role: job.role,
    reading_error: job.error_code ?? null,
    pages_completed: job.cursors?.pages ?? null, pages_total: job.layout?.pages ?? null,
    batches_completed: job.notes.length, summary: job.synthesis?.summary ?? null,
    has_reading_blockers: job.state === "NEEDS_REVIEW" || Boolean(job.synthesis?.reading_blockers?.length),
    content_caveats_count: job.synthesis?.uncertainties?.length ?? 0,
    note: "机器阅读结论是可复核参考，不是用户回答、路线确认或学习Evidence。batches_completed是已提交批次数，不能把页数当总批次数；按预算自动分批，只有READY才表示全部范围完成。"};
}

export function createMaterialReadingTools(runtime: MaterialReadingRuntime | undefined, draft: () => string | null) {
  const scope = async (id: string, signal?: AbortSignal) => {
    if (!runtime) throw new ReadingExecutionError("READING_RUNTIME_UNAVAILABLE", 503);
    const session = draft();
    const meta = await runtime.client.metadata(id, session ? "draft:" + session : undefined, signal);
    return meta.goal_id ?? (typeof meta.onboarding_session_id === "string" ? "draft:" + meta.onboarding_session_id : "");
  };
  const output = (value: object) => ({content: [{type: "text" as const, text: JSON.stringify(value)}], details: value});
  const parameters = Type.Object({material_id: Type.String({pattern: "^mat-[0-9a-f]{32}$"})});
  return [defineTool({name: "start_material_reading", label: "Read Complete Material",
    description: "Queue/resume complete original-source machine reading for an explicitly selected material in this Goal/draft. Use basis for a source actually intended to ground formal planning, supplementary otherwise. Default screenshots need no background library processing. Work yields to classroom requests and keeps committed progress. A queued/parsed/batch result does not mean the whole material is understood; inspect get_material_reading. No learner answer, confirmation, scoring or Evidence is created.",
    parameters: Type.Object({material_id: parameters.properties.material_id, role: Type.Optional(Type.Union([Type.Literal("basis"), Type.Literal("supplementary")]))}),
    execute: async (_id, args, signal) => {const owner = await scope(args.material_id, signal); return output(materialReadingSummary(await runtime!.enqueue(args.material_id, owner, args.role ?? "supplementary", signal)));}}),
    defineTool({name: "get_material_reading", label: "Get Material Reading",
      description: "Get the current original-version reading state and grounded machine integration summary. READY is a reading-resource conclusion, not learner mastery or permission to change a route. Failed/unresolved/queued sources cannot be described as fully read. Do not poll in a tight tool loop; normal teaching can continue while supplementary reading runs.", parameters,
      execute: async (_id, args, signal) => {const owner = await scope(args.material_id, signal); return output(await runtime!.status(args.material_id, owner, signal));}}),
    defineTool({name: "stop_material_reading", label: "Stop Material Reading",
      description: "Stop this material's machine reading and invalidate its current lease. Keeps valid committed notes and original; does not cancel a learner answer, delete conversation or alter learning facts.", parameters,
      execute: async (_id, args, signal) => {const owner = await scope(args.material_id, signal); return output(materialReadingSummary(await runtime!.cancel(args.material_id, owner)));}})];
}
