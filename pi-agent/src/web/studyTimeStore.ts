import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sameStudyScope, type StudyInterval, type StudyObservation, type StudyScope, type StudyTimeSummary } from "../studyTimeTypes.js";

interface Segment { id: string; runId: string; scope: StudyScope; startedAt: number; lastSeen: number; endedAt: number | null; observedMs: number; focusedMs: number; waitingMs: number }
interface Run { id: string; seq: number; lastSeen: number; scope: StudyScope | null; observation: StudyObservation }
export class StudyTimeError extends Error { constructor(message: string, readonly statusCode = 400) { super(message); } }

/** 独立观察账本。原子串行保存，活跃租约只在进程内；重启/断线不补算空白时间。 */
export class StudyTimeStore {
  private segments: Segment[] = [];
  private run: Run | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly ready: Promise<void>;
  constructor(private readonly path: string, private readonly now = Date.now) { this.ready = this.load(); void this.ready.catch(() => undefined); }
  private async load(): Promise<void> {
    let text: string;
    try { text = await readFile(this.path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    let data: { version?: unknown; segments?: unknown };
    try { data = JSON.parse(text); } catch { throw new StudyTimeError("学习计时记录无法读取，请保留原文件并检查。", 503); }
    if (!data || typeof data !== "object") throw new StudyTimeError("学习计时记录无法读取，请保留原文件并检查。", 503);
    if (data.version !== 1 || !Array.isArray(data.segments) || data.segments.length > 20000) throw new StudyTimeError("学习计时记录无法读取，请保留原文件并检查。", 503);
    for (const s of data.segments as Segment[]) {
      if (!s || typeof s.id !== "string" || typeof s.runId !== "string" || typeof s.scope?.goalId !== "string" || typeof s.scope?.taskId !== "string" ||
        ![s.startedAt, s.lastSeen, s.observedMs, s.focusedMs, s.waitingMs].every(v => Number.isFinite(v) && v >= 0) || s.focusedMs + s.waitingMs > s.observedMs + 0.001) throw new StudyTimeError("学习计时记录损坏，未覆盖原文件。", 503);
      s.endedAt ??= s.lastSeen;
    }
    this.segments = data.segments as Segment[];
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => { await this.ready; return fn(); });
    this.tail = result.catch(() => undefined); return result;
  }
  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = this.path + ".tmp";
    await writeFile(temp, JSON.stringify({ version: 1, segments: this.segments }), "utf8");
    await rename(temp, this.path);
  }
  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      const previous = structuredClone({ segments: this.segments, run: this.run });
      try { return await fn(); } catch (error) { this.segments = previous.segments; this.run = previous.run; throw error; }
    });
  }
  private live(): boolean { return !!this.run && this.now() - this.run.lastSeen <= 15000; }
  private segment(): Segment | undefined { return this.segments.at(-1)?.runId === this.run?.id && this.segments.at(-1)?.endedAt === null ? this.segments.at(-1) : undefined; }
  private bind(scope: StudyScope | null, at: number): void {
    const old = this.segment(); if (old) old.endedAt = old.lastSeen;
    if (!this.run) return;
    this.run.scope = scope;
    if (scope) {
      if (this.segments.length >= 20000) throw new StudyTimeError("计时记录已达到容量上限，请先导出整理。", 507);
      this.segments.push({ id: randomUUID(), runId: this.run.id, scope, startedAt: at, lastSeen: at, endedAt: null, observedMs: 0, focusedMs: 0, waitingMs: 0 });
    }
  }
  private view(scope: StudyScope | null): StudyTimeSummary {
    let taskFocusedMs = 0, goalFocusedMs = 0, taskObservedMs = 0, taskWaitingMs = 0, runFocusedMs = 0;
    for (const s of this.segments) {
      if (s.scope.goalId === scope?.goalId) goalFocusedMs += s.focusedMs;
      if (sameStudyScope(s.scope, scope)) { taskFocusedMs += s.focusedMs; taskObservedMs += s.observedMs; taskWaitingMs += s.waitingMs; }
      if (s.runId === this.run?.id) runFocusedMs += s.focusedMs;
    }
    return { scope, taskFocusedMs, goalFocusedMs, runFocusedMs, taskObservedMs, taskWaitingMs,
      observation: this.live() ? this.run!.observation : "UNKNOWN", recording: this.live(),
      source: this.live() ? "browser" : null };
  }
  summary(scope: StudyScope | null): Promise<StudyTimeSummary> { return this.serial(async () => this.view(scope)); }
  /** 永久删除沿用用户已有的Goal回收授权；失败由回收日志重放，普通回收保留计时。 */
  purgeGoal(goalId: string): Promise<void> {
    return this.mutate(async () => {
      if (!this.segments.some(s => s.scope.goalId === goalId)) return;
      if (this.run?.scope?.goalId === goalId) this.bind(null, this.now());
      this.segments = this.segments.filter(s => s.scope.goalId !== goalId);
      await this.save();
    });
  }
  start(scope: StudyScope | null): Promise<StudyTimeSummary & { runId: string }> {
    return this.mutate(async () => {
      if (!scope) throw new StudyTimeError("当前需要有正在学习的任务，才能开始计时。", 409);
      if (this.live()) throw new StudyTimeError("另一个页面正在观察，请先在那个页面停止，或等待它断开。", 409);
      const old = this.segment(); if (old) old.endedAt = old.lastSeen;
      this.run = { id: randomUUID(), seq: 0, lastSeen: this.now(), scope: null, observation: "UNKNOWN" };
      this.bind(scope, this.run.lastSeen); await this.save();
      return { ...this.view(scope), runId: this.run.id };
    });
  }
  observe(runId: string, input: StudyInterval, scope: StudyScope | null): Promise<StudyTimeSummary> {
    return this.mutate(async () => {
      const run = this.run;
      if (!run || run.id !== runId) throw new StudyTimeError("观察会话已失效，请重新开启。", 409);
      if (input.seq === run.seq) return this.view(scope); // 同一请求重试不重复入账。
      if (!Number.isSafeInteger(input.seq) || input.seq !== run.seq + 1 ||
        ![input.observedMs, input.focusedMs, input.waitingMs].every(v => Number.isFinite(v) && v >= 0 && v <= 10000) ||
        input.focusedMs + input.waitingMs > input.observedMs + 0.001 || !["FOCUSED", "AWAY", "NO_FACE", "UNKNOWN", "HIDDEN"].includes(input.observation)) throw new StudyTimeError("观察时间或顺序无效。");
      const at = this.now(), gap = at - run.lastSeen;
      const changed = !sameStudyScope(run.scope, scope);
      // 跨任务时丢弃无法精确归属的最后短窗口；断线/休眠窗口不补算，不分配给新任务。
      if (changed) this.bind(scope, at);
      const segment = this.segment();
      const duration = !changed && gap >= 0 && gap <= 8000 ? Math.min(input.observedMs, gap, 6000) : 0;
      const scale = input.observedMs ? duration / input.observedMs : 0;
      const focused = Math.min(duration, input.focusedMs * scale), waiting = Math.min(duration - focused, input.waitingMs * scale);
      if (segment) { segment.observedMs += duration; segment.focusedMs += focused; segment.waitingMs += waiting; segment.lastSeen = at; }
      run.seq = input.seq; run.lastSeen = at; run.observation = scope ? input.observation : "UNKNOWN";
      await this.save(); return this.view(scope);
    });
  }
  stop(runId: string, scope: StudyScope | null): Promise<StudyTimeSummary> {
    return this.mutate(async () => {
      if (this.run?.id !== runId) throw new StudyTimeError("观察会话已失效。", 409);
      const segment = this.segment(); if (segment) segment.endedAt = segment.lastSeen;
      const result = this.view(scope); this.run = null; await this.save(); return { ...result, recording: false, observation: "UNKNOWN", source:null };
    });
  }

}
