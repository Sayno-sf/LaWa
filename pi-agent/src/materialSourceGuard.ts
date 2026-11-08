import type {Context} from "@earendil-works/pi-ai";

const materialReference = /^(?:material:)?(mat-[0-9a-f]{32})(?::|$)/;
const exactMaterialId = /^mat-[0-9a-f]{32}$/;
const sourceHash = /^[0-9a-f]{64}$/;
const MAX_SOURCE_RECEIPTS = 16;

export interface MaterialSourceIdentity {
  material_id: string;
  scope: string;
  source_hash: string;
  purpose_revision: number;
}

type Inspection =
  | {status: "ok"; source: MaterialSourceIdentity}
  | {status: "deleted"}
  | {status: "changed"}
  | {status: "unavailable"};

interface Receipt {
  material_id: string;
  source_hash?: string;
  purpose_revision?: number;
}

function scopeParams(scope: string | null | undefined): URLSearchParams {
  if (!scope) return new URLSearchParams();
  if (scope.startsWith("draft:")) return new URLSearchParams({draft_session_id: scope.slice(6)});
  return new URLSearchParams({expected_goal_id: scope});
}

function messageText(content: unknown): string {
  try {return JSON.stringify(content);}
  catch {return "";}
}

function collectReceipts(value: unknown, output: Receipt[], seen = new Set<unknown>(), depth = 0): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length <= 2_000_000) {
      try {collectReceipts(JSON.parse(trimmed), output, seen, depth + 1);} catch { /* Ordinary text is not a structured receipt. */ }
    }
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value) || depth > 16) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectReceipts(item, output, seen, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.material_id === "string" ? record.material_id
    : typeof record.id === "string" && exactMaterialId.test(record.id) ? record.id : undefined;
  if (id && exactMaterialId.test(id)) {
    const hash = typeof record.source_hash === "string" && sourceHash.test(record.source_hash) ? record.source_hash
      : typeof record.sha256 === "string" && sourceHash.test(record.sha256) ? record.sha256 : undefined;
    const revision = Number.isSafeInteger(record.purpose_revision) && Number(record.purpose_revision) >= 0
      ? Number(record.purpose_revision) : undefined;
    output.push({material_id: id, ...(hash ? {source_hash: hash} : {}), ...(revision === undefined ? {} : {purpose_revision: revision})});
  }
  for (const [key, nested] of Object.entries(record)) {
    if (typeof nested === "string" && /(?:material|source|citation)/i.test(key)) {
      const referenced = nested.match(materialReference)?.[1];
      if (referenced) output.push({material_id: referenced});
    }
    collectReceipts(nested, output, seen, depth + 1);
  }
}

function referencedSources(content: unknown): Receipt[] {
  const text = messageText(content);
  const receipts: Receipt[] = [];
  try {collectReceipts(JSON.parse(text), receipts);} catch { /* Text citations still retain the material identity. */ }
  for (const match of text.matchAll(/material:(mat-[0-9a-f]{32})(?::|\\|"|$)/g))
    if (!receipts.some(receipt => receipt.material_id === match[1])) receipts.push({material_id: match[1]!});
  const unique = new Map<string, Receipt>();
  for (const receipt of receipts) if (!unique.has(receipt.material_id)) unique.set(receipt.material_id, receipt);
  return [...unique.values()].slice(0, MAX_SOURCE_RECEIPTS);
}

/**
 * Input-copy guard for original-source material. It never rewrites Pi history,
 * so the user's conversation remains intact while deleted/changed source
 * results are withheld from the next model request.
 */
export class MaterialSourceGuard {
  private readonly deleted = new Set<string>();
  constructor(private readonly options: {
    baseUrl: string;
    scope?: () => string | null | undefined;
    fetcher?: typeof fetch;
  }) {}

  markDeleted(id: string): void {
    if (exactMaterialId.test(id)) this.deleted.add(id);
  }

  isDeleted(id: string): boolean {
    return this.deleted.has(id);
  }

  materialIds(messages: Context["messages"]): Set<string> {
    const ids = new Set<string>();
    for (const message of messages) if (message.role === "toolResult")
      for (const receipt of referencedSources(message.content)) ids.add(receipt.material_id);
    return ids;
  }

  private async inspect(id: string, scope: string | null | undefined, signal?: AbortSignal): Promise<Inspection> {
    if (!exactMaterialId.test(id)) return {status: "changed"};
    if (this.deleted.has(id)) return {status: "deleted"};
    let response: Response;
    try {
      response = await (this.options.fetcher ?? fetch)(
        `${this.options.baseUrl.replace(/\/$/, "")}/api/learning/materials/${id}/metadata?${scopeParams(scope)}`,
        {
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]),
          redirect: "error",
        },
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      return {status: "unavailable"};
    }
    if (response.status === 404 || response.status === 410) {
      this.deleted.add(id);
      return {status: "deleted"};
    }
    if (response.status === 409 || response.status === 422) return {status: "changed"};
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return {status: "unavailable"};
    }
    let value: unknown;
    try {value = await response.json();}
    catch {return {status: "unavailable"};}
    if (!value || typeof value !== "object") return {status: "changed"};
    const meta = value as Record<string, unknown>;
    const returnedId = typeof meta.material_id === "string" ? meta.material_id
      : typeof meta.id === "string" ? meta.id : id;
    const hash = typeof meta.sha256 === "string" ? meta.sha256
      : typeof meta.source_hash === "string" ? meta.source_hash : "";
    const revision = meta.purpose_revision;
    if (returnedId !== id || !sourceHash.test(hash) || !Number.isSafeInteger(revision) || Number(revision) < 0)
      return {status: "changed"};
    return {status: "ok", source: {
      material_id: id,
      scope: scope ?? this.options.scope?.() ?? "",
      source_hash: hash,
      purpose_revision: Number(revision),
    }};
  }

  /** Return the current authoritative source or fail closed with a user-safe reason. */
  async current(id: string, scope?: string | null, signal?: AbortSignal): Promise<MaterialSourceIdentity> {
    const result = await this.inspect(id, scope ?? this.options.scope?.(), signal);
    if (result.status === "ok") return result.source;
    if (result.status === "deleted") throw new Error("这份资料已被删除，请重新选择。");
    if (result.status === "unavailable") throw new Error("暂时无法核对资料版本，请稍后重试。");
    throw new Error("资料归属或版本已经变化，请重新选择。");
  }

  /** Compare an already-delivered original against the current Kernel version. */
  async validate(source: MaterialSourceIdentity, signal?: AbortSignal): Promise<boolean> {
    const result = await this.inspect(source.material_id, source.scope, signal);
    return result.status === "ok" && result.source.source_hash === source.source_hash
      && result.source.purpose_revision === source.purpose_revision;
  }

  /**
   * Replace only stale tool-result copies in the provider input. User and
   * assistant messages stay untouched, and the durable Pi branch is never
   * rewritten.
   */
  async projectMessages(messages: Context["messages"], signal?: AbortSignal): Promise<Context["messages"]> {
    const receiptsByMessage = messages.map(message => message.role === "toolResult" ? referencedSources(message.content) : []);
    const ids = [...new Set(receiptsByMessage.flatMap(receipts => receipts.map(receipt => receipt.material_id)))]
      .slice(0, MAX_SOURCE_RECEIPTS);
    if (!ids.length) return messages;
    const inspections = new Map<string, Inspection>();
    await Promise.all(ids.map(async id => {
      let inspection: Inspection;
      try {inspection = await this.inspect(id, this.options.scope?.(), signal);}
      catch (error) {
        if (signal?.aborted) throw error;
        inspection = {status: "unavailable"};
      }
      inspections.set(id, inspection);
    }));
    const projected: Context["messages"] = [];
    let changed = false;
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]!;
      const receipts = receiptsByMessage[index]!;
      if (!receipts.length) {projected.push(message);continue;}
      let stale = false;
      for (const receipt of receipts) {
        const inspection = inspections.get(receipt.material_id) ?? {status: "unavailable" as const};
        if (inspection.status !== "ok"
            || receipt.source_hash && receipt.source_hash !== inspection.source.source_hash
            || receipt.purpose_revision !== undefined && receipt.purpose_revision !== inspection.source.purpose_revision) {
          stale = true;
          break;
        }
      }
      if (!stale) {
        projected.push(message);
        continue;
      }
      changed = true;
      const ids = [...new Set(receipts.map(receipt => receipt.material_id))];
      projected.push({
        ...message,
        content: [{type: "text", text: JSON.stringify({
          material_source_unavailable: true,
          material_ids: ids,
          notice: "这些资料工具结果已失效或无法核对当前版本，不能继续作为教学依据；需要时请重新列出并读取资料。",
        })}],
      });
    }
    return changed ? projected : messages;
  }
}
