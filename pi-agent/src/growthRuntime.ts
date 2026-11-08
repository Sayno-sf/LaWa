import {createHash} from "node:crypto";
import type {ReadingSelection} from "./materialReading.js";
import {contextReserve, modelContextWindow} from "./modelContextBudget.js";
import {estimateSourceContextTokens} from "./retrieval/sourceContext.js";
import {readingModelActivity, type ReadingModelActivity} from "./readingModelActivity.js";
import {GROWTH_POLICY, GROWTH_PROMPTS} from "./growthPrompts.js";

type RecordValue = Record<string, unknown>;
export interface GrowthSummary {source_refs: string[]; summary: string}
export interface GrowthJob {
  key: string; lease: string; input_hash: string; model_id: string;
  input: {basis?: "integrated"; records?: Array<RecordValue & {id: string}>; goals?: RecordValue[]; sample?: RecordValue} & RecordValue;
  summaries: GrowthSummary[];
}
export class GrowthApiError extends Error {constructor(readonly status: number) {super(`GROWTH_API_${status}`);}}
export class GrowthClient {
  constructor(readonly baseUrl = process.env.LEARNING_API_BASE_URL ?? "http://127.0.0.1:8000", readonly fetcher: typeof fetch = fetch) {}
  async post<T>(action: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}/api/internal/growth/${action}`, {
      method: "POST", headers: {"Content-Type": "application/json", "x-lawa-worker": "growth-v1",
        ...(process.env.GROWTH_WORKER_TOKEN ? {"x-lawa-growth-token": process.env.GROWTH_WORKER_TOKEN} : {})},
      body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw new GrowthApiError(response.status);
    return response.json() as Promise<T>;
  }
}

export function growthModelIdentity(selection: ReadingSelection): string {
  const {model} = selection;
  // 同名模型指向不同部署时不能误用缓存；摘要中不保留密钥或完整服务URL。
  const endpoint = createHash("sha256").update(model.baseUrl ?? "").digest("hex").slice(0, 16);
  return `${model.provider}/${model.id}@${endpoint}`;
}

export class GrowthExecutor {
  constructor(readonly client: GrowthClient, readonly select: () => Promise<ReadingSelection>,
    readonly activity: ReadingModelActivity = readingModelActivity(client.baseUrl), readonly timeoutMs = 60_000) {}

  private async call(selection: ReadingSelection, prompt: string, input: unknown, signal: AbortSignal): Promise<RecordValue> {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {timer = setTimeout(() => {
      controller.abort(); reject(new Error("GROWTH_MODEL_TIMEOUT"));
    }, Math.min(this.timeoutMs, 60_000));});
    try {
      const {runtime, model} = selection;
      const response = await Promise.race([runtime.completeSimple(model, {
        systemPrompt: prompt, messages: [{role: "user", content: JSON.stringify(input), timestamp: Date.now()}],
      }, {signal: combined, sessionId: `growth-${GROWTH_POLICY}`, maxTokens: Math.min(8192, model.maxTokens),
        timeoutMs: Math.min(this.timeoutMs, 60_000), maxRetries: 0,
        ...(model.reasoning ? {reasoning: "low" as const} : {})}), timeout]);
      signal.throwIfAborted();
      const raw = response.content.filter(p => p.type === "text").map(p => p.text).join("").trim();
      // 不截取一个看似有效的JSON片段；截断、工具调用和混合输出都必须重试。
      if (response.stopReason !== "stop") throw new Error("GROWTH_MODEL_INCOMPLETE");
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GROWTH_MODEL_FORMAT");
      return value as RecordValue;
    } finally {if (timer) clearTimeout(timer);}
  }

  async step(stop?: AbortSignal): Promise<boolean> {
    const result = await this.activity.tryBackground(async preempt => {
      const controller = new AbortController();
      const signal = AbortSignal.any([preempt, controller.signal, ...(stop ? [stop] : [])]);
      let job: GrowthJob | null = null, timer: ReturnType<typeof setInterval> | undefined;
      try {
        const selection = await this.select();
        // 领取响应本身不因课堂抢占而取消，避免服务端已领取但客户端丢失租约。
        job = (await this.client.post<{job: GrowthJob | null}>("claim", {model_id: growthModelIdentity(selection), policy_version: GROWTH_POLICY})).job;
        if (!job) return false;
        signal.throwIfAborted();
        const lease = {key: job.key, lease: job.lease};
        timer = setInterval(() => {void this.client.post("renew", lease).catch(() => controller.abort());}, 25_000);
        const budget = Math.min(40_000, modelContextWindow(selection.model.id, selection.model.contextWindow)
          - contextReserve(selection.model.contextWindow) - Math.min(8192, selection.model.maxTokens) * 2 - 4096);
        if (budget < 3000) throw new Error("GROWTH_CONTEXT_TOO_SMALL");
        let output: RecordValue;
        if (job.key.startsWith("score:")) {
          const input = await this.scoreInput(job, selection, budget - estimateSourceContextTokens(GROWTH_PROMPTS.score), signal);
          output = await this.call(selection, GROWTH_PROMPTS.score, input, signal);
        } else if (job.key === "classify") {
          const goals: unknown[] = [];
          for (const batch of pack(job.input.goals ?? [], budget)) {
            const value = await this.call(selection, GROWTH_PROMPTS.classify, {goals: batch}, signal);
            if (!Array.isArray(value.goals)) throw new Error("GROWTH_MODEL_FORMAT");
            goals.push(...value.goals);
          }
          output = {goals};
        } else if (job.key.startsWith("review:")) {
          // 一份样本最多16000字符；预算不足明确失败，不截断原答后冒充完成评审。
          if (estimateSourceContextTokens(JSON.stringify(job.input)) > budget) throw new Error("GROWTH_SAMPLE_CONTEXT_EXCEEDED");
          output = await this.call(selection, GROWTH_PROMPTS.review, job.input, signal);
        } else {
          let input: unknown = job.input;
          if (estimateSourceContextTokens(JSON.stringify(input)) > budget) {
            const summaries: unknown[] = [];
            for (const batch of pack([...(job.input.goals ?? []), ...((job.input.self_reports ?? []) as RecordValue[])], budget / 2)) {
              summaries.push(await this.call(selection, GROWTH_PROMPTS.summary, batch, signal));
            }
            input = {capability: job.input.capability, summaries, goals: (job.input.goals ?? []).map(g => ({goal_id: g.goal_id, domain: g.domain, skills: g.skills, milestones: g.milestones})), adopted_branches: job.input.adopted_branches, adopted_intents: job.input.adopted_intents};
            if (estimateSourceContextTokens(JSON.stringify(input)) > budget) throw new Error("GROWTH_RECOMMEND_CONTEXT_EXCEEDED");
          }
          output = await this.call(selection, GROWTH_PROMPTS.recommend, input, signal);
        }
        signal.throwIfAborted();
        await this.client.post("complete", {...lease, result: output}, signal);
        return true;
      } catch (error) {
        if (job) {
          const code = error instanceof SyntaxError ? "GROWTH_MODEL_FORMAT" : error instanceof Error && /^GROWTH_[A-Z_]+$/.test(error.message) ? error.message : "GROWTH_MODEL_FAILED";
          // 被老师抢占不是模型失败；旧版本的提交/释放由Kernel拒绝，不覆盖新排队任务。
          await this.client.post("release", {key: job.key, lease: job.lease, failed: !preempt.aborted && !stop?.aborted,
            error_code: code}).catch(() => undefined);
        }
        return Boolean(job);
      } finally {if (timer) clearInterval(timer);}
    });
    return result.ran && result.value;
  }

  private async summarize(selection: ReadingSelection, records: unknown[], signal: AbortSignal): Promise<string> {
    const value = await this.call(selection, GROWTH_PROMPTS.summary, {records}, signal);
    if (typeof value.summary !== "string" || !value.summary.trim() || value.summary.length > 12000) throw new Error("GROWTH_MODEL_FORMAT");
    return value.summary;
  }

  private async scoreInput(job: GrowthJob, selection: ReadingSelection, budget: number, signal: AbortSignal): Promise<unknown> {
    if (budget < 1800) throw new Error("GROWTH_CONTEXT_TOO_SMALL");
    if (!job.summaries.length && estimateSourceContextTokens(JSON.stringify(job.input)) <= budget) return job.input;
    let summaries = [...job.summaries];
    const used = new Set(summaries.flatMap(s => s.source_refs));
    const checkpoint = async (summary: GrowthSummary) => {
      await this.client.post("checkpoint", {key: job.key, lease: job.lease, summary}, signal);
      const refs = new Set(summary.source_refs);
      summaries = [...summaries.filter(s => !s.source_refs.some(r => refs.has(r))), summary];
    };
    for (const batch of pack((job.input.records ?? []).filter(r => !used.has(r.id)), budget * .55)) {
      let summary: string;
      if (batch.length === 1 && estimateSourceContextTokens(JSON.stringify(batch)) > budget * .55) {
        // 一个很长的原答按同一个来源ID分片整理，最后才登记这一来源已处理。
        const raw = JSON.stringify(batch[0]);
        const size = Math.max(800, Math.floor(budget * .45));
        let carry = "";
        for (let offset = 0; offset < raw.length; offset += size) {
          carry = await this.summarize(selection, [{source_id: batch[0]!.id, previous_summary: carry,
            fragment: raw.slice(offset, offset + size), offset, total_chars: raw.length}], signal);
        }
        summary = carry;
      } else summary = await this.summarize(selection, batch, signal);
      await checkpoint({source_refs: batch.map(r => r.id), summary});
      while (estimateSourceContextTokens(JSON.stringify(summaries)) > budget * .65 && summaries.length > 1) {
        const group = pack(summaries, budget * .75)[0]!;
        if (group.length < 2) throw new Error("GROWTH_SUMMARY_TOO_LARGE");
        await checkpoint({source_refs: group.flatMap(s => s.source_refs), summary: await this.summarize(selection, group, signal)});
      }
    }
    if (estimateSourceContextTokens(JSON.stringify(summaries)) > budget) throw new Error("GROWTH_SUMMARY_TOO_LARGE");
    const input = {basis: job.input.basis, records: summaries, summarized: true,
      source_catalog: (job.input.records ?? []).map(r => ({id: r.id, origin: r.origin})),
      instruction: "记录是带来源引用的分组摘要。评分source_refs必须使用摘要内原始source_refs，不要引用分组或虚构ID。"};
    if (estimateSourceContextTokens(JSON.stringify(input)) > budget) throw new Error("GROWTH_SUMMARY_TOO_LARGE");
    return input;
  }
}

function pack<T>(values: T[], budget: number): T[][] {
  const groups: T[][] = []; let group: T[] = [], size = 0;
  for (const value of values) {
    const tokens = estimateSourceContextTokens(JSON.stringify(value));
    if (group.length && size + tokens > budget) {groups.push(group); group = []; size = 0;}
    group.push(value); size += tokens;
  }
  if (group.length) groups.push(group);
  return groups;
}

export class GrowthRuntime {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private stopped = false;
  private readonly controller = new AbortController();
  private unsubscribe?: () => void;
  constructor(readonly executor: GrowthExecutor) {}
  start(): void {this.unsubscribe = this.executor.activity.onIdle(() => this.wake()); this.wake();}
  wake(): void {
    if (this.stopped || this.running || this.timer) return;
    this.timer = setTimeout(() => {this.timer = undefined; void this.pump();}, 1000);
    this.timer.unref();
  }
  private async pump(): Promise<void> {
    if (this.stopped) return;
    this.running = true;
    try {await this.executor.step(this.controller.signal);} catch { /* 未配置模型时保留排队状态 */ }
    finally {
      this.running = false;
      if (!this.stopped) {this.timer = setTimeout(() => {this.timer = undefined; this.wake();}, 4000); this.timer.unref();}
    }
  }
  dispose(): void {this.stopped = true; this.controller.abort(); if (this.timer) clearTimeout(this.timer); this.unsubscribe?.();}
}
