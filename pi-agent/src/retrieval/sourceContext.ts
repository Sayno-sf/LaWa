import type { FullContextResult, FullSourceIdentity, FullSourceRead, SourceBackend, SearchScope, SourceKind } from "./types.js";

import {MAX_FULL_SOURCE_TOKENS, contextReserve} from "../modelContextBudget.js";

export const FULL_SOURCE_THRESHOLD = MAX_FULL_SOURCE_TOKENS;
interface SourceMessage { role: string; toolName?: string; isError?: boolean; content: unknown }
const identity = (row: FullSourceRead): FullSourceIdentity => ({source_id: row.source.source_id,
  version: row.source.version, scope: row.scope, current_scope: row.current_scope});
const key = (row: FullSourceIdentity) => JSON.stringify([row.source_id, row.version, row.scope, row.current_scope]);

// 与Python来源估算分开：中文按每字一个，其他文本按每三字符一个保守预留。
// 模型窗口来自当前Pi Model元数据，不推测任意兼容供应商的真实容量。
export function estimateSourceContextTokens(value: string): number {
  const cjk = value.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  return cjk + Math.ceil((value.length - cjk) / 3);
}
export function fullSourceResult(message: SourceMessage): FullContextResult | undefined {
  if (message.role !== "toolResult" || message.toolName !== "search_learning_sources" || message.isError !== false
      || !Array.isArray(message.content)) return;
  for (const part of message.content) {
    if (part?.type !== "text" || typeof part.text !== "string") continue;
    try {
      const value = JSON.parse(part.text);
      if ((value.mode === "full_context" && value.complete === true || value.mode === "full_context_expired" && value.complete === false)
          && Array.isArray(value.sources)
          && value.sources.length <= 128 && value.sources.every((row: FullSourceRead) => row?.source
            && typeof row.source.source_id === "string" && typeof row.source.version === "string"
            && ["current", "library"].includes(row.scope) && typeof row.current_scope === "string"
            && typeof row.citation === "string" && typeof row.citation_ref === "string"
            && (typeof row.text === "string" || row.already_in_context === true))) return value;
    } catch { /* 坏结果不授予已读身份。 */ }
  }
}
export function fullSourceBodies(messages: readonly SourceMessage[]): Map<string, FullSourceRead> {
  const bodies = new Map<string, FullSourceRead>();
  for (const message of messages) for (const row of fullSourceResult(message)?.sources ?? []) {
    if (typeof row.text === "string" && row.text.trim()) bodies.set(key(identity(row)), row);
  }
  return bodies;
}

// 仅投影当前模型输入副本：失效全文移除，重复全文只保留最近一次，原Pi记录不改写。
export function projectFullSourceMessages<T extends SourceMessage>(messages: readonly T[], valid: FullSourceIdentity[]): T[] {
  const allowed = new Set(valid.map(key));
  const latest = new Map<string, number>();
  messages.forEach((message, index) => {
    for (const row of fullSourceResult(message)?.sources ?? []) if (typeof row.text === "string") latest.set(key(identity(row)), index);
  });
  return messages.map((message, index) => {
    const value = fullSourceResult(message);
    if (!value) return message;
    const rows = value.sources.filter(row => allowed.has(key(identity(row)))).map(row => {
      if (typeof row.text !== "string" || latest.get(key(identity(row))) === index) return row;
      const {text: _text, ...metadata} = row;
      return {...metadata, already_in_context: true};
    });
    // Pi details用于UI和持久化，也可能含完整正文；输入副本同时移除，避免重复计量/旧正文残留。
    const {details: _details, ...inputMessage} = message as T & {details?: unknown};
    return {...inputMessage, content: [{type: "text", text: JSON.stringify({...value, sources: rows,
      ...(rows.length !== value.sources.length ? {complete: false, mode: "full_context_expired",
        notice: "部分已读全文已删除、更新、改变作用域或暂时无法验证；当前输入已移除其正文，需重新查询。"} : {})})}]} as T;
  });
}

export class AdaptiveSourceContext {
  private prepared = false;
  private available = 0;
  private threshold = 0;
  private window = 0;
  private output = 8192;
  private loaded = new Map<string, FullSourceRead>();
  private tail: Promise<unknown> = Promise.resolve();

  get remainingTokens(): number { return this.available; }

  async prepare<T extends SourceMessage>(model: {contextWindow: number; maxTokens: number},
    context: {systemPrompt?: string; messages: readonly T[]; tools?: unknown}, backend?: SourceBackend,
    draft?: string | null, signal?: AbortSignal): Promise<T[]> {
    this.prepared = true;
    const bodies = fullSourceBodies(context.messages);
    const identities = [...bodies.values()].slice(-128).map(identity);
    let valid: FullSourceIdentity[] = [];
    if (identities.length && backend?.validateFullContext) {
      try { valid = await backend.validateFullContext(identities, draft, signal); }
      catch { /* 验证失败时不继续把旧全文提供给模型。 */ }
    }
    const messages = projectFullSourceMessages(context.messages, valid);
    this.loaded = fullSourceBodies(messages);
    const window = Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : 0;

    // 已有对话、规则、工具schema和实际来源正文均计入；另留输出与下一轮工具活动空间。
    const used = estimateSourceContextTokens(JSON.stringify({...context, messages}));
    const output = Number.isFinite(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : 8192;
    this.window = window; this.output = output;
    // 全文可占据剩余窗口；已有正文继续保留，不因固定32K阈值提前退成片段。
    this.threshold = Math.max(0, Math.min(FULL_SOURCE_THRESHOLD, window - output - contextReserve(window)));
    this.available = Math.max(0, Math.min(this.threshold, window - used - output - contextReserve(window)));
    return messages;
  }

  /** 原件在工具执行中加入，与全文/片段走同一分配器，避免并行读取各自花掉剩余空间。 */
  reserveMedia(previous: number, next: number, isCurrent: () => boolean): Promise<void> {
    const reserved = this.tail.catch(() => undefined).then(() => {
      if (!isCurrent()) throw new Error("原件读取所属回合已变化。");
      if (![previous, next].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("原件输入预算无效。");
      if (!this.prepared) return;
      const window = this.window + previous - next;
      const before = this.window - this.output - contextReserve(this.window);
      const after = window - this.output - contextReserve(window);
      const available = this.available + after - before;
      if (window <= 0 || available < 1024) throw new Error("并行来源读取后原件已无足够上下文，请减少本批内容。");
      this.window = window;
      this.threshold = Math.max(0, Math.min(FULL_SOURCE_THRESHOLD, after));
      this.available = Math.min(this.threshold, available);
    });
    this.tail = reserved;
    return reserved;
  }

  // 片段与全文共用同一个剩余窗口和串行分配器，避免并行工具各自花掉整份空间。
  async readWithinContext<T>(maximum: number, work: (limit: number) => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(async () => {
      const limit = this.prepared ? Math.min(maximum, Math.max(0, this.available - 1024)) : maximum;
      if (limit < 1) throw new Error("当前模型上下文已无来源阅读空间，请先根据已读内容回答。");
      const value = await work(limit);
      if (this.prepared) this.available = Math.max(0, this.available - estimateSourceContextTokens(JSON.stringify(value)) - 256);
      return value;
    });
    this.tail = next;
    return next;
  }

  async select(input: {scope?: SearchScope; kinds?: SourceKind[]; material_id?: string}, backend: SourceBackend,
    draft?: string | null, signal?: AbortSignal): Promise<FullContextResult | undefined> {
    // 同一模型回复可并发查询，串行分配全文空间，避免多份正文各自误用整份剩余预算。
    const next = this.tail.catch(() => undefined).then(async (): Promise<FullContextResult | undefined> => {
      if (!this.threshold || !backend.fullContext) return undefined;
      const scope = input.scope ?? "current";
      let value: FullContextResult;
      try {
        value = await backend.fullContext(scope, {max_tokens: this.threshold, available_tokens: this.available,
          known_sources: [...this.loaded.values()].slice(-128).map(identity),
          ...(input.kinds ? {kinds: input.kinds} : {}), ...(input.material_id ? {material_id: input.material_id} : {})}, draft, signal);
      } catch {
        return {mode: "rag", reason: "FULL_CONTEXT_UNAVAILABLE", scope, current_scope: "", sources: []};
      }
      if (value.mode !== "full_context") return value;
      if (!fullSourceResult({role: "toolResult", toolName: "search_learning_sources", isError: false,
            content: [{type: "text", text: JSON.stringify(value)}]}) || !value.sources.length
          || value.sources.some(row => row.truncated !== false || row.scope !== scope
          || row.current_scope !== value.current_scope || (row.already_in_context && !this.loaded.has(key(identity(row)))))) {
        return {mode: "rag", reason: "FULL_CONTEXT_INVALID", scope, current_scope: value.current_scope, sources: []};
      }
      const completeRows = value.sources.map(row => row.already_in_context ? this.loaded.get(key(identity(row)))! : row);
      const total = estimateSourceContextTokens(JSON.stringify(completeRows)) + 512;
      const cost = Math.max(estimateSourceContextTokens(JSON.stringify(value)) + 256, (value.new_tokens ?? 0) + 512);
      if (total > this.threshold || cost > this.available) return {mode: "rag",
        reason: total > this.threshold ? "FULL_CONTEXT_LIMIT" : "CONTEXT_SPACE_LOW", scope,
        current_scope: value.current_scope, sources: []};
      this.available -= cost;
      for (const row of value.sources) if (typeof row.text === "string") this.loaded.set(key(identity(row)), row);
      return value;
    });
    this.tail = next;
    return next;
  }
}
