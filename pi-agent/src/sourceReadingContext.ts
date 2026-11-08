import { fullSourceResult } from "./retrieval/sourceContext.js";

interface SourceMessage {
  role?: string;
  toolName?: string;
  isError?: boolean;
  content?: unknown;
}

// 每轮根据真正的 Tool Result 派生出处，防止老师凭旧印象编造文件名或行号。
// 片段只接受本轮成功Read；已校验的全文允许复用历史输入中的实际正文。搜索摘要不算阅读。
// 纯函数，不写账本/会话；坏 JSON 或不完整定位跳过，清单超过 20 项时明确标记截断。
export function summarizeReadSources(messages: readonly SourceMessage[]): string {
  const userAt = messages.findLastIndex(message => message.role === "user");
  const sources = new Map<string, { citation: string; citation_ref: string; medium?: string }>();
  for (const [index, message] of messages.entries()) {
    if (message.role !== "toolResult" || !["read_learning_material", "read_learning_source", "search_learning_sources", "read_learning_visual", "read_learning_document"].includes(message.toolName ?? "") || message.isError !== false || !Array.isArray(message.content)) continue;
    const full = fullSourceResult({...message, role: message.role, content: message.content});
    if (!full && (index <= userAt || userAt < 0 || message.toolName === "search_learning_sources")) continue;
    for (const part of message.content) {
      if (!part || typeof part !== "object" || part.type !== "text" || typeof part.text !== "string") continue;
      let value: unknown;
      try { value = JSON.parse(part.text); } catch { continue; }
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      if (["read_learning_visual", "read_learning_document"].includes(message.toolName ?? "")) {
        const visual = value as Record<string, unknown>;
        // 原PDF的实际file投影由运行时补充此标记；原Pi排队结果不含它，也不能伪装成全书已读。
        if (message.toolName === "read_learning_document" && visual.delivery === "native_pdf_attached"
            && typeof visual.material_id === "string" && /^mat-[0-9a-f]{32}$/.test(visual.material_id)
            && Number.isSafeInteger(visual.start) && Number(visual.start) > 0 && Number.isSafeInteger(visual.end) && Number(visual.end) >= Number(visual.start)
            && visual.citation_ref === `material:${visual.material_id}:page:${visual.start}-${visual.end}`
            && typeof visual.citation === "string" && !!visual.citation && visual.citation.length <= 1024) {
          const ref = String(visual.citation_ref);
          sources.delete(ref); sources.set(ref, {citation: visual.citation, citation_ref: ref, medium: "original_pdf"});
          continue;
        }
        // 只有供应商输入副本中实际携带图片的读取结果才列入；排队元数据/图像目录不算看图。
        const imageCount = message.content.filter(p => p?.type === "image").length;
        if (!imageCount || !Array.isArray(visual.assets) || visual.assets.length !== imageCount || imageCount > 3
            || typeof visual.material_id !== "string" || !/^mat-[0-9a-f]{32}$/.test(visual.material_id)) continue;
        for (const asset of visual.assets) {
          if (!asset || typeof asset !== "object" || typeof asset.asset_id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(asset.asset_id)
              || asset.citation_ref !== `material:${visual.material_id}:asset:${asset.asset_id}` || typeof asset.citation !== "string" || !asset.citation || asset.citation.length > 1024) continue;
          sources.delete(asset.citation_ref);
          sources.set(asset.citation_ref, {citation: asset.citation, citation_ref: asset.citation_ref, medium: "original_image"});
        }
        continue;
      }
      for (const main of full ? full.sources : [value as Record<string, unknown>]) {
      if (typeof main.text !== "string" || !main.text.trim() || typeof main.citation_ref !== "string"
          || !/^(?:material|card|note):([^:]+):(line|page|block|slide):([1-9]\d*)-([1-9]\d*)$/.test(main.citation_ref)) continue;
      const items = [main, ...(Array.isArray(main.context) ? main.context.slice(0, 4) : [])];
      for (const entry of items) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const item = entry as Record<string, unknown>;
        if (typeof item.text !== "string" || !item.text.trim() || typeof item.citation !== "string" ||
            item.citation.length > 1024 || typeof item.citation_ref !== "string") continue;
        const locator = /^(?:material|card|note):([^:]+):(line|page|block|slide):(\d+)-(\d+)$/.exec(item.citation_ref);
        if (!locator || item.citation_ref.length > 200) continue;
        if (entry !== main && !main.citation_ref.startsWith(item.citation_ref.split(":").slice(0,2).join(":") + ":")) continue;
        const start = Number(locator[3]); const end = Number(locator[4]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) continue;
        // 重读刷新最近顺序，确保刚回读的定位不会被有界清单继续淘汰。
        sources.delete(item.citation_ref);
        sources.set(item.citation_ref, { citation: item.citation, citation_ref: item.citation_ref });
      }
      }
    }
  }
  return JSON.stringify({ reads: [...sources.values()].slice(-20), omitted_count: Math.max(0, sources.size - 20) });
}
