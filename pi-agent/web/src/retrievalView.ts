import {FormSaveState} from "./formSaveState.js";
interface Settings {
  version: 1; enabled: boolean; profileId: string; embeddingModel: string; dimensions: number;
  embeddingUrl: string; rerankModel: string; rerankUrl: string; minimumRerankScore: number;
  visionEnabled?: boolean; graphEnabled?: boolean; visionModel?: string; extractionModel?: string;
  profiles: Array<{ id: string; provider: string; model: string }>;
}
interface SourceJob { source_id: string; state: string; warning?: string; derived?: Record<string, {state: string; completed: number; total: number;
  relations?: number; rejected_relations?: number; truncated_entities?: number; rejection_reasons?: Record<string, number>}> }
interface Status { enabled: boolean; chunks: number; building_generation: string | null; warning: string | null; sources: SourceJob[] }
interface TraceSummary { id: string; at: string; query: string; scope: string; warnings: string[] }
interface Candidate { name: string; goal_name: string; snippet: string; score: number; locator: { kind: string; start: number; end: number };
  graph_context?: Array<{from: string; to: string; relation: string; quote: string}> }
interface Trace { query: string; scope: string; current_scope?: string; stages: Record<string, Candidate[]>; timings_ms: Record<string, number>;
  query_refinement?: { status: string; query?: string };
  warnings: string[]; reads: Array<{ citation: string }> }
const warningLabels: Record<string, string> = {
  INDEX_BUILDING: "首次入库尚未完成", LEXICAL_UNAVAILABLE: "关键词检索暂不可用",
  SOURCE_INDEX_INCOMPLETE: "部分来源仍在入库或等待重试，结果可能不完整",
  DENSE_UNAVAILABLE_LEXICAL_FALLBACK: "语义检索暂不可用，使用关键词候选",
  RERANK_UNAVAILABLE_FUSION_FALLBACK: "精排暂不可用，使用合并候选",
  SOURCE_VALIDATION_UNAVAILABLE: "来源版本暂无法核对，已停止返回候选",
  QUERY_REFINEMENT_UNAVAILABLE: "问题整理或重查暂不可用，保留首次检索结果",
  GRAPH_UNAVAILABLE: "图谱召回暂不可用", DERIVED_INDEX_INCOMPLETE: "视觉识别或图谱抽取尚未完成，结果可能不完整",
  GRAPH_EXTRACTION_GAPS: "部分模型关系未通过出处或数量校验，已丢弃",
};
const unitLabels: Record<string, string> = { page: "页", line: "行", block: "正文块", slide: "幻灯片" };
/** 历史记录的范围来自该次检索，不能用当前页面的 Goal 名称回填。 */
export function traceScopeLabel(trace: Pick<Trace, "scope" | "current_scope" | "stages">): string {
  if (trace.scope === "library") return "检索当时的个人学习库";
  if (trace.current_scope?.startsWith("draft:")) return "检索当时的新目标草稿";
  const names = [...new Set(Object.values(trace.stages).flat().map(row => row.goal_name?.trim()).filter(Boolean))];
  return names.length === 1 ? `检索当时的学习目标：${names[0]}` : "检索当时的学习目标（名称未记录）";
}
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.detail ?? "请求未完成。");
  return body;
}
export async function retrievalStatus(): Promise<Status | null> {
  try {
    const status = await api<Status>("/api/web/retrieval-status");
    return Array.isArray(status.sources) ? status : null;
  } catch { return null; }
}
export function sourceIndexLabel(job?: SourceJob) {
  if (!job) return "等待检索入库";
  const base = ({ ready: "可检索", indexing: "正在准备检索", lexical_only: "可关键词检索，语义入库待重试",
    waiting: "等待检索入库" } as Record<string, string>)[job.state] ?? "等待检索入库";
  return base + Object.entries(job.derived ?? {}).filter(([,j]) => j.total || j.state === "failed").map(([kind,j]) => {
    const state = j.state === "failed" ? "待重试" : j.state === "ready" ? "已完成" : ` ${j.completed}/${j.total}`;
    if (kind === "vision") return " · 视觉" + state;
    const reasons: Record<string, string> = {quote_not_exact: "引文不一致", endpoint_not_grounded: "端点缺少出处",
      unknown_chunk: "引用块无效", invalid_relation: "关系格式不完整", relation_limit: "关系数量超限", entity_limit: "端点数量超限"};
    const detail = Object.entries(j.rejection_reasons ?? {}).filter(([key,count]) => reasons[key] && count > 0)
      .map(([key,count]) => `${reasons[key]} ${count}`).join("；");
    return " · 图谱" + state + (j.relations !== undefined ? j.relations > 0 ? `，${j.relations} 条关系已纳入` :
      j.state === "ready" ? "，未提取到有出处的关系" : "" : "") +
      (j.rejected_relations ? `，${j.rejected_relations} 条未通过校验` + (detail ? `（${detail}）` : "") : "") +
      (j.truncated_entities ? `，模型超额提出 ${j.truncated_entities} 个实体` : "");
  }).join("");
}
export function mountRetrievalViews() {
  const details = document.querySelector<HTMLDetailsElement>("#retrieval-settings");
  const form = document.querySelector<HTMLFormElement>("#retrieval-settings-form");
  const message = document.querySelector<HTMLElement>("#retrieval-settings-message");
  if (!details || !form || !message) return;
  let loaded = false;
  let loading = false;
  const saveState = new FormSaveState(form, message);
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
  details.addEventListener("toggle", () => {
    if (!details.open || loaded || loading) return;
    loading = true;
    void api<Settings>("/api/web/retrieval-settings").then(config => {
      const profiles = field("profileId") as HTMLSelectElement;
      profiles.replaceChildren(...config.profiles.map(profile => {
        const option = document.createElement("option");
        option.value = profile.id; option.textContent = profile.provider + " · " + profile.model;
        return option;
      }));
      for (const name of ["profileId", "embeddingModel", "dimensions", "embeddingUrl", "rerankModel", "rerankUrl", "minimumRerankScore"]) {
        field(name).value = String(config[name as keyof Settings]);
      }
      (field("enabled") as HTMLInputElement).checked = config.enabled;
      for (const name of ["visionEnabled", "graphEnabled"] as const) (field(name) as HTMLInputElement).checked = config[name] !== false;
      for (const name of ["visionModel", "extractionModel"] as const) field(name).value = config[name] ?? "";
      loaded = true;
      saveState.markClean();
    }).catch(error => { saveState.error(error instanceof Error ? error.message : String(error)); }).finally(() => { loading = false; });
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (!loaded || saveState.busy) return;
    const config = { version: 1, enabled: (field("enabled") as HTMLInputElement).checked,
      profileId: field("profileId").value, embeddingModel: field("embeddingModel").value,
      dimensions: Number(field("dimensions").value), embeddingUrl: field("embeddingUrl").value,
      rerankModel: field("rerankModel").value, rerankUrl: field("rerankUrl").value,
      minimumRerankScore: Number(field("minimumRerankScore").value) };
    Object.assign(config, {visionEnabled: (field("visionEnabled") as HTMLInputElement).checked,
      graphEnabled: (field("graphEnabled") as HTMLInputElement).checked,
      visionModel: field("visionModel").value, extractionModel: field("extractionModel").value});
    if (!saveState.begin()) return;
    void api("/api/web/retrieval-settings", { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config) }).then(() => {
        saveState.success("已保存 · 模型或维度变化将在新索引建立后生效");
      }).catch(error => { saveState.error(error instanceof Error ? error.message : String(error)); });
  });
  const traces = document.querySelector<HTMLDetailsElement>("#retrieval-diagnostics");
  const select = document.querySelector<HTMLSelectElement>("#retrieval-trace-select");
  const output = document.querySelector<HTMLElement>("#retrieval-trace-content");
  if (!traces || !select || !output) return;
  async function renderTrace() {
    if (!select!.value) { output!.textContent = "还没有检索记录。"; return; }
    try {
      const trace = await api<Trace>("/api/web/retrieval-traces?id=" + encodeURIComponent(select!.value));
      output!.replaceChildren();
      const paragraph = (text: string) => {
        const p = document.createElement("p"); p.textContent = text; output!.append(p);
      };
      paragraph("问题：" + trace.query);
      paragraph("范围：" + traceScopeLabel(trace));
      if (trace.query_refinement?.query) {
        const expanded = trace.query_refinement.query;
        const supplement = expanded.startsWith(trace.query) ? expanded.slice(trace.query.length).replace(/^\s*检索补充[:：]\s*/, "").trim() : expanded;
        paragraph("检索补充（原问题精排）：" + supplement);
      }
      else if (trace.query_refinement?.status === "budget_skipped") paragraph("本次剩余检索时间不足，未整理问题重查。");
      if (trace.warnings.length) paragraph(trace.warnings.map(warning => warningLabels[warning] ?? warning).join("；"));
      const stages: Record<string, string> = { bm25: "关键词候选", dense: "语义候选", graph: "图谱候选", fusion: "合并排序", rerank: "精排结果" };
      for (const [key, label] of Object.entries({ ...stages })) stages[key + "_retry"] = "重查 · " + label;
      for (const [stage, rows] of Object.entries(trace.stages)) {
        const section = document.createElement("details"), heading = document.createElement("summary");
        heading.textContent = (stages[stage] ?? stage) + " · " + rows.length + " 个片段";
        section.append(heading);
        for (const row of rows) {
          const item = document.createElement("p");
          item.textContent = row.name + "（" + row.goal_name + "） · 第 " + row.locator.start + "–" + row.locator.end
            + " " + (unitLabels[row.locator.kind] ?? row.locator.kind) + " · 排序值 " + row.score.toFixed(3) + "\n" + row.snippet;
          section.append(item);
          if (row.graph_context) {
            const path = document.createElement("p"); path.textContent = "机器抽取关联（需回读核对）：\n" + row.graph_context.map(edge =>
              edge.from + " → " + edge.relation + " → " + edge.to + "；原文：" + edge.quote).join("\n"); section.append(path);
          }
        }
        output!.append(section);
      }
      paragraph("实际阅读：" + (trace.reads.map(read => read.citation).join("；") || "尚未回读原文"));
      paragraph("检索耗时：" + (trace.timings_ms.total ?? 0) + " ms。排序值用于比较候选，不代表事实正确性。");
    } catch (error) { output!.textContent = error instanceof Error ? error.message : String(error); }
  }
  select.addEventListener("change", () => { void renderTrace(); });
  traces.addEventListener("toggle", () => {
    if (!traces.open) return;
    void api<TraceSummary[]>("/api/web/retrieval-traces").then(items => {
      const previous = select.value;
      select.replaceChildren(...items.map(item => {
        const option = document.createElement("option"); option.value = item.id;
        option.textContent = new Date(item.at).toLocaleString() + " · " + item.query.slice(0,60);
        return option;
      }));
      if (items.some(item => item.id === previous)) select.value = previous;
      return renderTrace();
    }).catch(error => { output.textContent = error instanceof Error ? error.message : String(error); });
  });
}
