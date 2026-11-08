import {renderMarkdown} from "./markdown";
import {icon} from "./icons";
import {goalDisplayTitle, matchesSearch} from "./interiorWorkspace";
import {captureDisclosures, restoreDisclosures} from "./readingPosition";
import {mapPositions, radarVertex, type MapPosition} from "./growthGeometry";
import {orderedGrowthProjects, growthProjectTimes} from "./growthLibraryModel";
import {parseGrowthImportJson} from "./growthImportJson";
import "./growthLibraryView.css";

const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]!));
const time = (value?: string | null) => value ? new Date(value).toLocaleString("zh-CN", {month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"}) : "时间未知";
const directions = {science: "数理与自然", technology: "技术与工程", humanities: "人文与社会", expression: "表达与艺术"};
const helpLabels: Record<string, string> = {UNKNOWN: "帮助情况未知", WITH_HELP: "有帮助", WITH_HINT: "有提示", WITH_REFERENCE: "参考资料", INDEPENDENT: "独立完成", TRANSFERRED: "迁移应用"};
type Tab = "records" | "feedback" | "cards";
interface Provenance {source?: {platform: string; conversation_title?: string; reference?: string | null; media_descriptions?: string[]} | string | null; imported_at?: string | null}
interface Source extends Provenance {id: string; goal_id?: string | null; skill_id?: string | null; origin: string; title?: string; statement?: string; task?: string; response?: string; summary?: string; review?: string; assistance?: string; occurred_at?: string | null}
interface Sample extends Provenance {id: string; skill_id: string; question: string | null; learner_answer: string; assistance_level: string; occurred_at: string | null; review: {supported: boolean; reason: string} | null}
interface GoalContext {records: Source[]; samples: Sample[]; requires_initial_route: boolean; topic_revision?: string; topics?: Array<{id: string; name: string; skill_ids: string[]}>}
interface Dimension {id: string; score: number; rationale: string; coverage: string[]; missing: string[]; source_refs: string[]; observed_refs?: string[]; self_report_refs?: string[]; awaiting_practice?: boolean}
interface Layer {status: string; error?: string | null; evaluation: {dimensions: Dimension[]; created_at: string | null; model_id: string | null} | null}
interface Supplement {id: string; text: string; updated_at: string}
interface ImportBatch {id: string; withdrawn: boolean; source: {platform: string; conversation_title: string}; created_at: string; goal_count?: number; sample_count: number; reviewed: number; failed: number; state: string; supported: number; entries: Array<{goal_id: string}>}
export interface Recommendation {id: string; outcome: string; source_goal_ids: string[]; anchor_id: string | null; anchor_kind: string | null; kind: "deepen" | "bridge" | "explore"; title: string; reason: string; goal_id: string | null; prompt: string}
export interface GrowthAtlas {
  points: Array<{goal_id: string; title: string; status: string; x: number | null; y: number | null; classification: null | {weights: Record<string, number>; reason: string}}>;
  dimensions: Array<{id: string; name: string}>;
  capability: Layer; recommendations: Recommendation[];
  supplements: Supplement[]; imports: ImportBatch[]; jobs: Array<{key: string; status: string; error: string | null}>;
}
export interface AtlasProject {
  archived_at?: string | null;
  evidence?: Array<{created_at: string}>; answer_assessments?: Array<{created_at: string}>;
  knowledge_cards?: Array<{created_at: string; note_updated_at?: string | null; feedback_updated_at?: string | null}>;
  status: string; goal_profile: {id: string; goal_description: string; desired_outcome: string};
  curriculum_spine: Array<{id: string; name: string; description: string; skill_ids?: string[]}>;
  skills: Array<{id: string; name: string; description: string; status: string}>;
}
interface Preview {preview_hash: string; source: {platform: string}; suggested_title?: string; goals: Array<{ref: string; title: string; duplicate: boolean; skills: number; self_reports: number; samples: number; warnings?: string[]; suggestions: Array<{goal_id: string; title: string}>}>; invalid: Array<{ref: string; error: string}>}
interface GroupPreview {preview_hash: string; title: string; goal_id: string; goal_ids: string[]; topic_count: number; skill_count: number}
interface DetailState {skill: string; tab: Tab; positions: Map<string, number>; disclosures: Map<string, Set<string>>}

/** 图谱只读状态与课堂会话分离。唯一课堂写入口由主壳层的继续学习/新目标回调持有。 */
export class GrowthLibraryView<P extends AtlasProject> {
  private projects: P[] = [];
  private atlas?: GrowthAtlas;
  private mode: "atlas" | "goals" = "atlas";
  private goal: string | null = null;
  private axis: string | null = null;
  private recommendation?: Recommendation;
  private source?: Source;
  private details = new Map<string, DetailState>();
  private contexts = new Map<string, GoalContext>();
  private locations = new Map<string, MapPosition>();
  private viewport = {x: 0, y: 0, zoom: 1};
  private editor: "text" | "json" | "prompt" | null = null;
  private draft = "";
  private jsonDraft = "";
  private editing?: string;
  private preview?: Preview;
  private importPayload?: unknown;
  private selections = new Map<string, string>();
  private importMode: "together" | "separate" = "together";
  private importTitle = "";
  private grouping?: GroupPreview & {batchId: string};
  private assignment?: {goalId: string; skillId: string; revision: string; mode: string; name: string};
  private exportPrompt = "";
  private notice = "";
  private error = false;
  private busy = false;
  private active = false;
  private timer?: ReturnType<typeof setTimeout>;
  private request = 0;
  constructor(private readonly root: HTMLElement, private readonly options: {
    records: (project: P, skillId: string, tab: Tab) => string;
    newGoal: (prompt: string) => void;
    adopted?: (value: {branch_id: string | null; recommendation: Recommendation}, enter: boolean) => Promise<void>;
    refresh: () => void;
  }) {
    try {if (localStorage.getItem("lawa-growth-library-view") === "goals") this.mode = "goals";} catch {}
    root.addEventListener("click", event => {void this.click(event).catch(error => this.fail(error));});
    root.addEventListener("keydown", event => {
      const target = (event.target as Element).closest("[data-map-goal], [data-axis]");
      if (target && ["Enter", " "].includes(event.key)) {event.preventDefault(); target.dispatchEvent(new MouseEvent("click", {bubbles: true}));}
    });
    root.addEventListener("input", event => {
      const target = event.target as HTMLInputElement;
      if (target.dataset.growthDraft === "text") this.draft = target.value;
      if (target.dataset.growthDraft === "import-title") this.importTitle = target.value;
      if (target.dataset.growthDraft === "group-title" && this.grouping) this.grouping.title = target.value;
      if (target.dataset.growthDraft === "topic-name" && this.assignment) this.assignment.name = target.value;
      if (target.dataset.growthDraft === "json") {this.jsonDraft = target.value; this.preview = undefined; this.importPayload = undefined;
        this.root.querySelector(".growth-import-preview")?.remove();}
    });
    root.addEventListener("change", event => {void this.change(event).catch(error => this.fail(error));});
    document.querySelector("[data-collection-search=library]")?.addEventListener("input", () => this.filter());
    document.querySelector("#library-status-filter")?.addEventListener("change", () => this.filter());
  }

  private async api<T>(path = "", method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(`/api/web/growth${path}`, {method,
      ...(body === undefined ? {} : {headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)})});
    const value = await response.json();
    if (!response.ok) throw new Error(typeof value.detail === "string" ? value.detail : "操作未完成，请稍后重试。");
    return value as T;
  }
  async load(projects: P[]): Promise<void> {
    const request = ++this.request;
    this.projects = projects; this.active = true;
    const atlas = await this.api<GrowthAtlas>();
    if (request !== this.request) return;
    this.atlas = atlas;
    if (this.goal && !projects.some(p => p.goal_profile.id === this.goal)) this.goal = null;
    this.render(); this.poll();
  }
  setActive(active: boolean): void {this.active = active; if (!active) {clearTimeout(this.timer); this.remember();} else this.poll();}
  private poll(): void {
    clearTimeout(this.timer);
    if (!this.active) return;
    this.timer = setTimeout(async () => {
      try {
        const next = await this.api<GrowthAtlas>();
        const changed = JSON.stringify(next) !== JSON.stringify(this.atlas);
        this.atlas = next;
        if (changed && !this.busy && !this.goal && (!this.editor || this.editor === "json" && !this.jsonDraft && !this.preview)) this.render();
      } catch { /* 暂时离线不清空已有图谱；用户操作会显示具体失败。 */ }
      this.poll();
    }, 5000);
  }
  private current(): P | undefined {return this.projects.find(p => p.goal_profile.id === this.goal);}
  private detail(project: P): DetailState {
    const id = project.goal_profile.id;
    if (!this.details.has(id)) this.details.set(id, {skill: project.skills[0]?.id ?? "", tab: "records", positions: new Map(), disclosures: new Map()});
    return this.details.get(id)!;
  }
  private remember(): void {
    const current = this.root.querySelector<HTMLElement>("[data-detail-goal]");
    if (!current) return;
    const memory = this.details.get(current.dataset.detailGoal!);
    const reader = current.querySelector<HTMLElement>(".growth-reader");
    if (memory && reader) {
      memory.positions.set(reader.dataset.positionKey!, reader.scrollTop);
      memory.disclosures.set(reader.dataset.positionKey!, captureDisclosures(reader));
    }
  }
  private fail(error: unknown): void {this.notice = error instanceof Error ? error.message : String(error); this.error = true; this.busy = false; this.render();}
  private async update(work: () => Promise<unknown>, message: string): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.error = false; this.notice = "正在保存…"; this.render();
    try {await work(); this.atlas = await this.api<GrowthAtlas>(); this.notice = message;}
    finally {this.busy = false; this.render();}
  }

  private render(): void {
    this.remember();
    if (!this.atlas) return;
    this.root.classList.add("growth-library");
    this.root.dataset.growthManaged = "true";
    this.root.innerHTML = `<div class="growth-topbar"><div class="growth-view-tabs" aria-label="学习库视图">
      <button data-view="atlas" aria-pressed="${this.mode === "atlas" && !this.goal}">成长图谱</button><button data-view="goals" aria-pressed="${this.mode === "goals" && !this.goal}">学习目标</button></div>
      <button class="growth-add" data-growth="add">＋ 补充学习记录</button></div>
      <p class="growth-notice ${this.error ? "is-error" : ""}" role="status" ${this.notice ? "" : "hidden"}>${esc(this.notice)}</p>
      ${this.editor ? this.editorMarkup() : ""}
      ${this.current() ? this.detailMarkup(this.current()!) : this.mode === "atlas" ? this.atlasMarkup() : this.goalsMarkup()}`;
    const project = this.current();
    if (project) {
      const state = this.detail(project), reader = this.root.querySelector<HTMLElement>(".growth-reader");
      if (reader) {restoreDisclosures(reader, state.disclosures.get(reader.dataset.positionKey!) ?? new Set()); reader.scrollTop = state.positions.get(reader.dataset.positionKey!) ?? 0;}
    }
    this.bindMap(); this.filter();
    this.root.querySelectorAll<HTMLButtonElement>("[data-mutation]").forEach(b => b.disabled = this.busy);
  }

  private atlasMarkup(): string {
    const atlas = this.atlas!;
    this.locations = mapPositions(atlas.points, this.locations);
    return `<div class="growth-panels"><section class="growth-map-panel"><header><div><span class="growth-eyebrow">学过什么</span><h3>知识地图</h3></div><span class="growth-count">${atlas.points.length} 个目标</span></header>
      <div class="growth-map-wrap"><svg class="growth-map" viewBox="0 0 640 420" aria-label="知识地图，可拖动或缩放" tabindex="0">
        <g class="growth-map-plane" transform="translate(${this.viewport.x} ${this.viewport.y}) translate(320 210) scale(${this.viewport.zoom}) translate(-320 -210)">
          <path class="growth-map-grid" d="M70 210H570M320 52V368 M195 95V325M445 95V325 M120 141H520M120 279H520"/>
          <circle class="growth-map-origin" cx="320" cy="210" r="3"/>
          ${atlas.points.filter(p => this.locations.has(p.goal_id)).map(p => {const location = this.locations.get(p.goal_id)!;
            const title = this.projects.find(project => project.goal_profile.id === p.goal_id)?.goal_profile.goal_description ?? p.title;
            return `<g class="growth-point" data-map-goal="${esc(p.goal_id)}" data-goal-filter="${esc(p.goal_id)}" transform="translate(${location.x} ${location.y})" role="button" tabindex="0" aria-label="${esc(title)}"><title>${esc(title)}</title><circle class="growth-point-hit" r="11"/><circle class="growth-point-dot ${p.status === "CURRENT" ? "current" : ""}" r="5.5"/><g class="growth-point-label" aria-hidden="true"><rect x="-115" y="-41" width="230" height="27" rx="4"/><text x="0" y="-23" text-anchor="middle">${esc(goalDisplayTitle(title))}</text></g></g>`;}).join("")}
        </g><g class="growth-map-directions"><text x="320" y="24" text-anchor="middle">数理与自然</text><text x="320" y="407" text-anchor="middle">表达与艺术</text><text x="15" y="204">人文</text><text x="15" y="222">社会</text><text x="625" y="204" text-anchor="end">技术</text><text x="625" y="222" text-anchor="end">工程</text></g>
      </svg><div class="growth-zoom"><button data-zoom="out" aria-label="缩小地图">−</button><button data-zoom="reset" aria-label="恢复地图位置">复位</button><button data-zoom="in" aria-label="放大地图">＋</button></div></div>
      <footer><span>位置表示知识方向，中心表示跨领域。</span><span>拖动平移 · 滚轮缩放</span></footer>
      ${!atlas.points.length ? '<p class="growth-empty">从一个想学的目标开始，慢慢看见自己的知识版图。</p>' : ""}
      ${atlas.points.some(p => p.x === null) ? `<div class="growth-unsorted"><span>待整理</span>${atlas.points.filter(p => p.x === null).map(p => `<button data-open-goal="${esc(p.goal_id)}" data-goal-filter="${esc(p.goal_id)}">${esc(goalDisplayTitle(p.title))}</button>`).join("")}</div>` : ""}</section>
      <section class="growth-radar-panel"><header><div><span class="growth-eyebrow">能做到什么</span><h3>能力雷达</h3></div><span class="growth-count">0–5</span></header>${this.radarMarkup()}
        <div class="growth-legend"><span><i class="solid"></i>综合能力画像</span><span>0 表示暂无记录</span></div><p class="growth-caption">综合已有记录，点击维度查看依据。${atlas.capability.status !== "READY" ? "有资料待更新。" : ""}</p>
        ${atlas.jobs.some(j => j.status === "FAILED") ? '<button class="growth-retry" data-growth="retry" data-mutation>更新未完成 · 重试</button>' : ""}</section></div>
      ${this.recommendation ? this.recommendationMarkup() : ""}${this.axis ? this.axisMarkup() : ""}${this.source && !this.source.goal_id ? `<section class="growth-source">${this.sourceMarkup(this.source)}</section>` : ""}
      ${atlas.recommendations.length ? `<section class="growth-recommendations"><h3>接下来，可以试试</h3><div>${atlas.recommendations.map((r, i) => `<button data-recommend="${i}"><small>${{deepen: "目标深化", bridge: "跨领域应用", explore: "新领域探索"}[r.kind]}</small><strong>${esc(r.title)}</strong><p>${esc(r.reason)}</p><span aria-hidden="true">↗</span></button>`).join("")}</div></section>` : ""}`;
  }

  private radarMarkup(): string {
    const points = (values: number[]) => values.map((v, i) => radarVertex(i, v).join(",")).join(" ");
    return `<svg class="growth-radar" viewBox="0 0 360 308" aria-label="六维能力雷达">
      ${[1, 2, 3, 4, 5].map(n => `<polygon class="growth-radar-grid" points="${points(Array(6).fill(n))}"/>`).join("")}
      ${Array.from({length: 6}, (_, i) => `<line class="growth-radar-grid" x1="180" y1="154" x2="${radarVertex(i, 5)[0]}" y2="${radarVertex(i, 5)[1]}"/>`).join("")}
      ${this.atlas!.capability.evaluation ? `<polygon class="growth-radar-shape observed" points="${points(this.atlas!.dimensions.map(d => this.atlas!.capability.evaluation!.dimensions.find(v => v.id === d.id)?.score ?? 0))}"/>` : ""}
      <text class="growth-radar-tick" x="187" y="138">1</text><text class="growth-radar-tick" x="187" y="57">5</text>
      ${this.atlas!.dimensions.map((d, i) => {const [x, y] = radarVertex(i, 5, 137), score = this.atlas!.capability.evaluation?.dimensions.find(v => v.id === d.id)?.score;
        return `<g role="button" tabindex="0" data-axis="${d.id}" aria-label="${d.name}，${score === undefined ? "待评价" : score.toFixed(1) + "分"}，查看依据" class="growth-axis ${this.axis === d.id ? "selected" : ""}"><rect x="${x - 39}" y="${y - 13}" width="78" height="37" rx="4"/><text x="${x}" y="${y}" text-anchor="middle">${d.name}</text><text class="growth-axis-score" x="${x}" y="${y + 17}" text-anchor="middle">${score === undefined ? "待评价" : score.toFixed(1)}</text></g>`;}).join("")}</svg>`;
  }
  private axisMarkup(): string {
    const title = this.atlas!.dimensions.find(d => d.id === this.axis)?.name ?? "";
    const layer = this.atlas!.capability, d = layer.evaluation?.dimensions.find(v => v.id === this.axis);
    const links = (refs: string[] | undefined) => (refs ?? []).map((id, index) => `<button data-source="${esc(id)}">来源 ${index + 1} ↗</button>`).join("");
    return `<section class="growth-axis-detail"><header><h3>${title} <small>${d ? d.score.toFixed(1) + " / 5" : "待评价"}</small></h3><button data-growth="close-axis" aria-label="关闭维度详情">×</button></header>
      <p>${esc(d?.rationale ?? "资料已保存，等待后台评估。")}</p>
      ${layer.status !== "READY" ? `<p class="growth-caption">${layer.status === "FAILED" ? "更新未完成，保留仍有效的旧评价。" : "有资料待更新。"}</p>` : ""}
      ${d?.awaiting_practice ? '<p class="growth-caption">目前来自具体自述，尚待实践体现。</p>' : ""}
      ${d?.coverage.length ? `<h5>覆盖范围</h5><p>${d.coverage.map(esc).join(" · ")}</p>` : ""}
      ${d?.missing.length ? `<h5>尚未体现</h5><p>${d.missing.map(esc).join(" · ")}</p>` : ""}
      <div class="growth-sources"><h5>实际表现</h5>${links(d?.observed_refs ?? d?.source_refs) || '<span class="growth-caption">暂无相关表现记录</span>'}</div>
      <div class="growth-sources"><h5>自述线索</h5>${links(d?.self_report_refs) || '<span class="growth-caption">暂无相关补充</span>'}</div>
      ${layer.evaluation?.created_at ? `<small class="growth-caption">更新于 ${time(layer.evaluation.created_at)}</small>` : ""}</section>`;
  }

  private recommendationMarkup(): string {
    const r = this.recommendation!;
    return `<section class="growth-recommendation-detail" role="region" aria-label="学习建议详情"><header><h3>${esc(r.title)}</h3><button type="button" data-growth="close-recommendation" aria-label="关闭建议详情">${icon("close")}</button></header>
      <p class="growth-recommendation-reason">${esc(r.reason)}</p><dl><dt>试着做</dt><dd>${esc(r.prompt)}</dd><dt>你会收获</dt><dd>${esc(r.outcome)}</dd></dl>
      <p class="growth-caption">${r.goal_id ? "作为原路线旁的拓展分支，主线进度保留。" : "从一个小起点了解新领域，确认后再建立目标。"}</p>
      <div class="growth-actions"><button type="button" class="primary-button" data-mutation data-adopt-recommendation="enter">${r.goal_id ? "开始学习" : "规划新目标"}</button>${r.goal_id ? '<button type="button" class="text-button" data-mutation data-adopt-recommendation="later">加入路线，稍后再学</button>' : ""}</div></section>`;
  }

  private goalsMarkup(): string {
    return `<div class="growth-goal-list">${this.projects.length ? orderedGrowthProjects(this.projects).map(p => {const latest = growthProjectTimes(p).recorded; return `<button class="growth-goal-row" data-open-goal="${esc(p.goal_profile.id)}" data-goal-filter="${esc(p.goal_profile.id)}"><span><small>${p.status === "CURRENT" ? "当前目标" : "学习目标"}</small><strong>${esc(goalDisplayTitle(p.goal_profile.goal_description))}</strong><span>${esc(p.goal_profile.desired_outcome)}</span><small>${latest ? `最近记录 ${time(latest)}` : "尚无学习记录"}</small></span><span>${p.skills.length} 个知识点 <b aria-hidden="true">↗</b></span></button>`;}).join("") : '<p class="growth-empty">还没有学习目标。</p>'}</div>`;
  }

  private detailMarkup(project: P): string {
    const memory = this.detail(project), skill = project.skills.find(s => s.id === memory.skill);
    const assigned = new Set(project.curriculum_spine.flatMap(m => m.skill_ids ?? []));
    const context = this.contexts.get(project.goal_profile.id);
    const topic = context?.topics?.find(group => group.skill_ids.includes(memory.skill));
    const milestone = project.curriculum_spine.find(m => m.skill_ids?.includes(memory.skill));
    const edit = this.assignment?.goalId === project.goal_profile.id && this.assignment.skillId === memory.skill ? this.assignment : undefined;
    const byId = new Map(project.skills.map(s => [s.id, s]));
    const orderedSkills = (ids: string[]) => ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
    const groups = project.curriculum_spine.map(m => ({...m, skills: orderedSkills(m.skill_ids ?? [])}));
    for (const topic of context?.topics ?? []) {
      const skills = orderedSkills(topic.skill_ids).filter(s => !assigned.has(s.id));
      skills.forEach(s => assigned.add(s.id));
      if (skills.length) groups.push({id: topic.id, name: topic.name, description: "", skills});
    }
    if (project.skills.some(s => !assigned.has(s.id))) groups.push({id: "unassigned", name: "已有知识点", description: "", skills: project.skills.filter(s => !assigned.has(s.id))});
    const point = this.atlas!.points.find(p => p.goal_id === project.goal_profile.id);
    const source = this.source?.goal_id === project.goal_profile.id && (!this.source.skill_id || this.source.skill_id === memory.skill) ? this.source : undefined;
    return `<section class="growth-goal-detail" data-detail-goal="${esc(project.goal_profile.id)}"><header class="growth-detail-heading"><div><button data-growth="back" class="growth-back">← 返回${this.mode === "atlas" ? "图谱" : "目标"}</button><h3>${esc(goalDisplayTitle(project.goal_profile.goal_description))}</h3><p>${esc(project.goal_profile.desired_outcome)}</p>${growthProjectTimes(project).switched ? `<small class="growth-caption" title="最近离开当前学习工作区的时间，不表示首次归档或最近学习。">最近切出 ${time(growthProjectTimes(project).switched)}</small>` : ""}</div><button class="primary-button" data-library-action="goal" data-goal="${esc(project.goal_profile.id)}">继续学习 →</button></header>
      <details class="growth-classification"><summary>知识方向${point?.classification ? " · " + Object.entries(directions).filter(([k]) => point.classification!.weights[k]! > 0).map(([, label]) => label).join(" / ") : " · 待整理"}</summary><p>${esc(point?.classification?.reason ?? "可自行调整四类关联程度。")}</p><div>${Object.entries(directions).map(([key, label]) => `<label>${label}<select data-weight="${key}">${[0, 1, 2, 3].map(n => `<option value="${n}" ${point?.classification?.weights[key] === n ? "selected" : ""}>${["无关联", "次要", "明显", "主要"][n]}</option>`).join("")}</select></label>`).join("")}<button data-growth="save-classification" data-mutation>保存方向</button></div></details>
      <div class="growth-detail-layout"><nav class="growth-skill-tree" aria-label="阶段与知识点">${groups.map(g => `<details open><summary>${esc(g.name)}</summary>${g.skills.length ? g.skills.map(s => `<button data-select-growth-skill="${esc(s.id)}" aria-current="${s.id === memory.skill}">${esc(s.name)}</button>`).join("") : '<small>尚未展开</small>'}</details>`).join("") || '<p class="growth-caption">继续学习后补充路线。</p>'}</nav>
      <section class="growth-skill-panel"><header><h4>${esc(skill?.name ?? "目标记录")}</h4><p>${esc(skill?.description ?? project.goal_profile.goal_description)}</p>
        ${topic && context?.topic_revision ? `<div class="growth-topic-summary"><small>归属：${esc(milestone?.name ?? topic.name)}</small><button data-growth="edit-topic">调整归属</button></div>` : ""}
        ${edit ? `<div class="growth-topic-editor"><label>归入<select data-topic-mode><option value="topic" ${edit.mode === "topic" ? "selected" : ""}>主题</option>${project.curriculum_spine.map(m => `<option value="milestone:${esc(m.id)}" ${edit.mode === `milestone:${m.id}` ? "selected" : ""}>路线阶段：${esc(m.name)}</option>`).join("")}</select></label>${edit.mode === "topic" ? `<label>主题名称<input data-growth-draft="topic-name" list="growth-topic-names" maxlength="200" value="${esc(edit.name)}"/><datalist id="growth-topic-names">${(context?.topics ?? []).map(t => `<option value="${esc(t.name)}"></option>`).join("")}</datalist></label>` : ""}<div><button data-growth="cancel-topic">取消</button><button data-growth="save-topic" data-mutation>保存归属</button></div></div>` : ""}</header>
        <div class="growth-record-tabs" aria-label="记录类型">${([['records', '学习记录'], ['feedback', '答题反馈'], ['cards', '知识卡片']] as const).map(([tab, name]) => `<button data-record-tab="${tab}" aria-pressed="${memory.tab === tab}">${name}</button>`).join("")}</div>
        <div class="growth-reader" tabindex="0" aria-label="知识点记录" data-position-key="${esc(memory.skill + ':' + memory.tab)}">
          ${source ? `<div class="growth-source is-highlighted" tabindex="-1">${this.sourceMarkup(source)}<button data-growth="clear-source">取消定位</button></div>` : ""}
          ${skill ? this.options.records(project, skill.id, memory.tab) : ""}
          ${memory.tab === "records" ? (context?.records ?? []).filter(r => r.origin === "self_report" && (!r.skill_id || r.skill_id === memory.skill)).map(r => `<article class="growth-external-record"><small>本人自述 · ${time(r.occurred_at)}</small>${renderMarkdown(r.statement ?? "")}${this.provenanceMarkup(r)}</article>`).join("") : ""}
          ${memory.tab === "feedback" ? (context?.samples ?? []).filter(s => s.skill_id === memory.skill).map(s => `<article class="growth-external-record"><small>外部作答 · ${time(s.occurred_at)} · ${esc(helpLabels[s.assistance_level] ?? "帮助情况未知")}</small><h5>原题</h5>${s.question ? renderMarkdown(s.question) : '<p class="growth-caption">原题未提供，按原答可见内容评审。</p>'}<h5>我的作答</h5>${renderMarkdown(s.learner_answer)}<h5>${s.review ? "文字 / 代码评审" : "待评审"}</h5><p>${esc(s.review?.reason ?? "保存后由后台处理，当前不计入学习表现评分。")}</p>${this.provenanceMarkup(s)}</article>`).join("") : ""}
          ${!skill ? '<p class="growth-empty">已保留目标与来源，继续学习时可以补充知识点。</p>' : ""}
        </div></section></div></section>`;
  }
  private sourceMarkup(source: Source): string {
    return `<small>${source.origin === "self_report" ? "本人自述" : "学习表现"} · ${time(source.occurred_at)}</small><h4>${esc(source.title ?? "评价来源")}</h4>
      ${source.task ? `<h5>原题</h5>${renderMarkdown(source.task)}` : ""}${renderMarkdown(source.statement ?? source.response ?? "")}
      ${source.summary || source.review ? `<p>${esc(source.summary ?? source.review)}</p>` : ""}${this.provenanceMarkup(source)}`;
  }
  private provenanceMarkup(record: Provenance): string {
    const source = record.source;
    if (!source) return "";
    if (typeof source === "string") return `<small>来源：${esc(source)}</small>`;
    return `<details class="growth-provenance"><summary>来源：${esc(source.platform)}${record.imported_at ? " · 导入于 " + time(record.imported_at) : ""}</summary>
      ${source.conversation_title ? `<p>${esc(source.conversation_title)}</p>` : ""}
      ${source.reference ? `<p>${esc(source.reference)}</p>` : ""}
      ${(source.media_descriptions ?? []).map(s => `<p>媒体来源说明：${esc(s)}</p>`).join("")}</details>`;
  }

  private editorMarkup(): string {
    const atlas = this.atlas!;
    return `<section class="growth-editor"><header><h3>补充学习记录</h3><button data-growth="close-editor" aria-label="关闭补充记录">×</button></header><div class="growth-editor-tabs">${([['text', '自己描述'], ['json', '导入 JSON'], ['prompt', '获取导出提示词']] as const).map(([mode, name]) => `<button data-editor="${mode}" aria-pressed="${this.editor === mode}">${name}</button>`).join("")}</div>
      ${this.editor === "text" ? `<label class="growth-field">学过什么，做过什么，现在能做到什么程度？<textarea data-growth-draft="text" maxlength="16000" rows="5" placeholder="例如：学过基础统计，能用表格分析一组销售数据，回归分析还需要参考教程。">${esc(this.draft)}</textarea></label><div class="growth-editor-footer"><small>保留原文，计入自述；不会自动创建目标。</small><button class="primary-button" data-growth="save-supplement" data-mutation>${this.editing ? "保存修改" : "保存记录"}</button></div>
        ${atlas.supplements.length ? `<div class="growth-supplements">${atlas.supplements.map(s => `<article><p>${esc(s.text)}</p><footer><time>${time(s.updated_at)}</time><button data-edit-supplement="${s.id}">修改</button><button data-withdraw-supplement="${s.id}" data-mutation>撤回</button></footer></article>`).join("")}</div>` : ""}` : ""}
      ${this.editor === "json" ? `<div class="growth-import-input"><label class="growth-file">选择 JSON 文件<input type="file" accept=".json,application/json" data-growth-file/></label><span>1 MiB 以内 · 最多 20 个目标</span></div><label class="growth-field">或粘贴 JSON<textarea data-growth-draft="json" rows="5" spellcheck="false" placeholder='{"schema_version":"lawa.learning-import/v1",…}'>${esc(this.jsonDraft)}</textarea></label><div class="growth-editor-footer"><button data-growth="schema">下载格式说明</button><button data-growth="preview" data-mutation>预览导入</button></div>${this.preview ? this.previewMarkup() : ""}${this.grouping ? `<section class="growth-import-preview"><h4>整理为一个学习目标</h4><p>${this.grouping.topic_count} 个主题、${this.grouping.skill_count} 个知识点；保留原文与来源。</p><label class="growth-field">目标名称<input data-growth-draft="group-title" maxlength="200" value="${esc(this.grouping.title)}"/></label><div class="growth-editor-footer"><button data-growth="cancel-group">取消</button><button data-growth="save-group" data-mutation>确认整合</button></div></section>` : ""}
        ${atlas.imports.length ? `<div class="growth-batches"><h4>导入记录</h4>${atlas.imports.map(b => `<article><div><strong>${esc(b.source.conversation_title || b.source.platform)}</strong><small>${time(b.created_at)} · ${b.withdrawn ? "已撤回" : `${b.goal_count ?? new Set(b.entries.map(e => e.goal_id)).size} 个目标 · 作答已评审 ${b.reviewed}/${b.sample_count}${b.failed ? " · " + b.failed + " 份失败" : b.state === "PENDING_REVIEW" ? " · 待评审" : " · 已完成"}`}</small></div>${b.withdrawn ? "" : `${(b.goal_count ?? new Set(b.entries.map(e => e.goal_id)).size) > 1 ? `<button data-group-batch="${b.id}" data-mutation>合为一个目标</button>` : ""}${b.failed ? `<button data-retry-batch="${b.id}" data-mutation>重试失败项</button>` : ""}<button data-withdraw-batch="${b.id}" data-mutation>撤回本批</button>`}</article>`).join("")}<p class="growth-caption">撤回只移除本批记录的有效贡献，保留已确认目标和后续学习。</p></div>` : ""}` : ""}
      ${this.editor === "prompt" ? `<p>在原来的 AI 对话中使用这段提示词，再把生成的 JSON 带回来。</p><pre class="growth-export-prompt">${esc(this.exportPrompt || "正在读取…")}</pre><button data-growth="copy-prompt">复制提示词</button>` : ""}</section>`;
  }
  private previewMarkup(): string {
    const preview = this.preview!;
    return `<section class="growth-import-preview"><h4>确认要带入的内容</h4><div class="growth-import-organization"><label>保存方式<select data-import-mode><option value="together" ${this.importMode === "together" ? "selected" : ""}>合为一个学习目标</option><option value="separate" ${this.importMode === "separate" ? "selected" : ""}>分别保存或追加已有目标</option></select></label>${this.importMode === "together" ? `<label class="growth-field">目标名称<input data-growth-draft="import-title" maxlength="200" value="${esc(this.importTitle)}"/></label><p class="growth-caption">各项作为内部主题，原知识点、作答和来源一起保留。</p>` : ""}</div>${preview.goals.map(g => `<article><label><input type="checkbox" data-import-ref="${esc(g.ref)}" ${this.selections.has(g.ref) ? "checked" : ""} ${g.duplicate ? "disabled" : ""}/><span><strong>${esc(g.title)}</strong><small>${g.duplicate ? "精确重复，已存在" : `${g.skills} 个知识点 · ${g.self_reports} 条自述 · ${g.samples} 份待评审作答`}</small>${(g.warnings ?? []).map(w => `<small class="growth-caption">${esc(w)}</small>`).join("")}</span></label>${!g.duplicate && this.importMode === "separate" ? `<select data-merge-ref="${esc(g.ref)}" aria-label="${esc(g.title)}的导入方式"><option value="">新增目标</option>${this.projects.map(p => `<option value="${esc(p.goal_profile.id)}" ${this.selections.get(g.ref) === p.goal_profile.id ? "selected" : ""}>追加到：${esc(goalDisplayTitle(p.goal_profile.goal_description))}${g.suggestions.some(s => s.goal_id === p.goal_profile.id) ? "（相近）" : ""}</option>`).join("")}</select>` : ""}</article>`).join("")}
      ${preview.invalid.map(i => `<p class="growth-invalid">无效目标 ${esc(i.ref)}：${esc(i.error)}</p>`).join("")}
      <div class="growth-editor-footer"><small>同名目标不会自动合并，追加保留原路线与学习进度。</small><button class="primary-button" data-growth="commit" data-mutation>保存所选内容</button></div></section>`;
  }

  private async change(event: Event): Promise<void> {
    const target = event.target as HTMLInputElement;
    if (target.hasAttribute("data-topic-mode") && this.assignment) {this.assignment.mode = target.value; this.render(); return;}
    if (target.hasAttribute("data-import-mode")) {this.importMode = target.value as "together" | "separate"; this.render(); return;}
    if (target.dataset.importRef) {
      const ref = target.dataset.importRef;
      const merge = this.root.querySelector<HTMLSelectElement>(`[data-merge-ref="${CSS.escape(ref)}"]`);
      if (target.checked) this.selections.set(ref, merge?.value ?? ""); else this.selections.delete(ref);
    }
    if (target.dataset.mergeRef) {const check = this.root.querySelector<HTMLInputElement>(`[data-import-ref="${CSS.escape(target.dataset.mergeRef)}"]`); if (check?.checked) this.selections.set(target.dataset.mergeRef, target.value);}
    if (target.hasAttribute("data-growth-file")) {
      const file = target.files?.[0]; if (!file) return;
      if (file.size > 1048576) throw new Error("文件超过 1 MiB，请在原 AI 对话中分批导出。");
      this.jsonDraft = await file.text(); this.preview = undefined; this.importPayload = undefined; this.render();
    }
  }

  private async click(event: MouseEvent): Promise<void> {
    const target = (event.target as Element).closest<HTMLElement>("button, [data-map-goal], [data-axis]");
    if (!target) return;
    if (target.dataset.view) {this.goal = null; this.source = undefined; this.mode = target.dataset.view as "atlas" | "goals";
      try {localStorage.setItem("lawa-growth-library-view", this.mode);} catch {} this.render(); return;}
    if (target.dataset.mapGoal || target.dataset.openGoal) {await this.openGoal((target.dataset.mapGoal ?? target.dataset.openGoal)!); return;}
    if (target.dataset.axis) {this.axis = this.axis === target.dataset.axis ? null : target.dataset.axis; this.render(); return;}
    if (target.dataset.source) {
      this.source = await this.api<Source>(`/sources/${encodeURIComponent(target.dataset.source)}`);
      if (this.source.goal_id) await this.openGoal(this.source.goal_id, this.source.skill_id ?? undefined);
      else this.render(); return;
    }
    if (target.dataset.selectGrowthSkill && this.current()) {this.remember(); this.detail(this.current()!).skill = target.dataset.selectGrowthSkill; this.source = undefined; this.render(); return;}
    if (target.dataset.recordTab && this.current()) {this.remember(); this.detail(this.current()!).tab = target.dataset.recordTab as Tab; this.render(); return;}
    if (target.dataset.zoom) {this.zoom(target.dataset.zoom === "reset" ? 0 : target.dataset.zoom === "in" ? 1.25 : .8); return;}
    if (target.dataset.editor) {
      this.editor = target.dataset.editor as typeof this.editor; this.notice = "";
      if (this.editor === "prompt") this.exportPrompt = (await this.api<{text: string}>("/export-prompt")).text;
      this.render(); return;
    }
    if (target.dataset.recommend !== undefined) {
      const rec = this.atlas!.recommendations[Number(target.dataset.recommend)]!;
      this.recommendation = rec; this.render(); this.root.querySelector(".growth-recommendation-detail")?.scrollIntoView({block: "nearest"}); return;
    }
    if (target.dataset.adoptRecommendation && this.recommendation) {
      const r = this.recommendation;
      const enter = target.dataset.adoptRecommendation === "enter";
      await this.update(async () => {
        const adopted = await this.api<{branch_id: string | null; recommendation: Recommendation}>(`/recommendations/${encodeURIComponent(r.id)}/adopt`, "POST", {});
        if (r.kind === "explore") this.options.newGoal(`${r.prompt}\n预期收获：${r.outcome}`);
        else await this.options.adopted?.(adopted, enter);
        this.recommendation = undefined;
      }, r.kind === "explore" ? "学习意图已保存，确认后建立目标。" : "已加入学习路线。");
      return;
    }
    if (target.dataset.editSupplement) {
      const item = this.atlas!.supplements.find(s => s.id === target.dataset.editSupplement)!;
      this.editing = item.id; this.draft = item.text; this.render(); this.root.querySelector<HTMLTextAreaElement>("[data-growth-draft=text]")?.focus(); return;
    }
    if (target.dataset.withdrawSupplement) {await this.update(() => this.api(`/supplements/${encodeURIComponent(target.dataset.withdrawSupplement!)}`, "DELETE"), "记录已撤回。"); return;}
    if (target.dataset.withdrawBatch) {await this.update(() => this.api(`/imports/${encodeURIComponent(target.dataset.withdrawBatch!)}/withdraw`, "POST", {}), "本批贡献已撤回，后续学习保留。"); this.contexts.clear(); return;}
    if (target.dataset.groupBatch) {this.grouping = {...await this.api<GroupPreview>(`/imports/${encodeURIComponent(target.dataset.groupBatch)}/group-preview`), batchId: target.dataset.groupBatch}; this.render(); return;}
    if (target.dataset.retryBatch) {await this.update(() => this.api("/retry", "POST", {key: target.dataset.retryBatch}), "失败项目已重新排队。"); return;}
    switch (target.dataset.growth) {
      case "close-recommendation": this.recommendation = undefined; this.render(); return;
      case "edit-topic": {
        const project = this.current(); if (!project) break;
        const skillId = this.detail(project).skill, context = this.contexts.get(project.goal_profile.id);
        const topic = context?.topics?.find(t => t.skill_ids.includes(skillId)); if (!context?.topic_revision || !topic) break;
        const milestone = project.curriculum_spine.find(m => m.skill_ids?.includes(skillId));
        this.assignment = {goalId: project.goal_profile.id, skillId, revision: context.topic_revision, mode: milestone ? `milestone:${milestone.id}` : "topic", name: topic.name.slice(0, 200)};
        this.render(); break;
      }
      case "cancel-topic": this.assignment = undefined; this.render(); break;
      case "save-topic": {
        const edit = this.assignment; if (!edit) break;
        if (edit.mode === "topic" && !edit.name.trim()) throw new Error("请填写所属主题。");
        await this.update(async () => {
          const context = await this.api<GoalContext>(`/goals/${encodeURIComponent(edit.goalId)}/topic-assignment`, "PUT", {
            skill_ids: [edit.skillId], target_kind: edit.mode === "topic" ? "topic" : "milestone", target: edit.mode === "topic" ? edit.name.trim() : edit.mode.slice("milestone:".length), expected_revision: edit.revision});
          this.contexts.set(edit.goalId, context); this.assignment = undefined;
          const response = await fetch("/api/web/learning-library"); if (!response.ok) throw new Error("归属已保存，请重新打开学习库。");
          this.projects = (await response.json()).projects; this.options.refresh();
        }, "归属已保存，学习记录与当前任务保留。"); break;
      }
      case "add": this.editor = this.editor ? null : "text"; this.notice = ""; this.render(); break;
      case "close-editor": this.editor = null; this.render(); break;
      case "close-axis": this.axis = null; this.render(); break;
      case "clear-source": this.source = undefined; this.render(); break;
      case "back": this.goal = null; this.source = undefined; this.render(); break;
      case "retry": await this.update(() => this.api("/retry", "POST", {}), "已安排在课堂空闲时重试。"); break;
      case "save-supplement":
        if (!this.draft.trim()) throw new Error("先写下想补充的学习记录。");
        await this.update(async () => {await this.api(this.editing ? `/supplements/${encodeURIComponent(this.editing)}` : "/supplements", this.editing ? "PATCH" : "POST", {text: this.draft}); this.draft = ""; this.editing = undefined;}, "记录已保存，能力画像将在空闲时更新。"); break;
      case "cancel-group": this.grouping = undefined; this.render(); break;
      case "save-group": {
        if (!this.grouping?.title.trim()) throw new Error("请填写目标名称。");
        const group = this.grouping;
        await this.update(async () => {
          await this.api(`/imports/${encodeURIComponent(group.batchId)}/group`, "POST", {preview_hash: group.preview_hash, title: group.title.trim()});
          this.grouping = undefined; this.contexts.clear();
          const library = await fetch("/api/web/learning-library").then(r => r.json()); this.projects = library.projects;
          this.options.refresh();
        }, "已整理为一个目标，原主题与来源保留。"); break;
      }
      case "preview": {
        if (new TextEncoder().encode(this.jsonDraft).length > 1048576) throw new Error("JSON 超过 1 MiB，请分批导入。");
        const draft = this.jsonDraft;
        const payload = parseGrowthImportJson(draft);
        const preview = await this.api<Preview>("/imports/preview", "POST", {payload});
        // 用户编辑了原文时丢弃迟到预览；提交始终绑定同一份内容和预览版本。
        if (draft !== this.jsonDraft) break;
        this.importPayload = payload; this.preview = preview; this.importMode = "together"; this.importTitle = (preview.suggested_title ?? preview.goals[0]?.title ?? "导入的学习记录").slice(0, 200);
        this.selections = new Map(this.preview.goals.filter(g => !g.duplicate).map(g => [g.ref, ""])); this.notice = ""; this.render(); break;
      }
      case "commit": {
        if (!this.preview || !this.importPayload || !this.selections.size) throw new Error("请选择至少一个有效的新内容。");
        if (this.importMode === "together" && !this.importTitle.trim()) throw new Error("请填写目标名称。");
        await this.update(async () => {await this.api("/imports/commit", "POST", {payload: this.importPayload, preview_hash: this.preview!.preview_hash,
          selected_refs: [...this.selections.keys()], merge_targets: this.importMode === "separate" ? Object.fromEntries([...this.selections].filter(([, v]) => v)) : {},
          ...(this.importMode === "together" ? {group_title: this.importTitle.trim()} : {})});
          this.preview = undefined; this.jsonDraft = ""; this.importPayload = undefined;
          const library = await fetch("/api/web/learning-library").then(r => {if (!r.ok) throw new Error("导入已保存，学习库读取失败，请重新打开。"); return r.json();}); this.projects = library.projects;
        }, "已导入。外部作答将在后台评审。"); break;
      }
      case "save-classification": {
        const weights = Object.fromEntries([...this.root.querySelectorAll<HTMLSelectElement>("[data-weight]")].map(s => [s.dataset.weight!, Number(s.value)]));
        await this.update(() => this.api(`/classifications/${encodeURIComponent(this.goal!)}`, "PUT", {weights}), "知识方向已保存。"); break;
      }
      case "copy-prompt": await navigator.clipboard.writeText(this.exportPrompt); this.notice = "提示词已复制。"; this.render(); break;
      case "schema": {
        const schema = await this.api("/import-schema"), url = URL.createObjectURL(new Blob([JSON.stringify(schema, null, 2)], {type: "application/json"}));
        const a = document.createElement("a"); a.href = url; a.download = "lawa.learning-import.v1.schema.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); break;
      }
    }
  }
  private async openGoal(id: string, skill?: string): Promise<void> {
    this.remember(); this.goal = id;
    const project = this.current(); if (!project) throw new Error("目标已不可用，请重新打开学习库。");
    if (skill && project.skills.some(s => s.id === skill)) {const memory = this.detail(project); memory.skill = skill; memory.tab = this.source?.id.startsWith("assessment:") || this.source?.id.startsWith("sample-") ? "feedback" : "records";}
    this.render();
    const context = await this.api<GoalContext>(`/goals/${encodeURIComponent(id)}`);
    this.contexts.set(id, context); if (this.goal === id) this.render();
    if (this.source) {const highlight = this.root.querySelector<HTMLElement>(".growth-source.is-highlighted"); highlight?.scrollIntoView({block: "nearest"}); highlight?.focus({preventScroll: true});}
  }

  private filter(): void {
    const query = document.querySelector<HTMLInputElement>("[data-collection-search=library]")?.value ?? "";
    const status = document.querySelector<HTMLSelectElement>("#library-status-filter")?.value ?? "all";
    const visible = new Set(this.projects.filter(p => matchesSearch([p.goal_profile.goal_description, ...p.skills.map(s => s.name)].join(" "), query)
      && (status === "all" || (status === "current" ? p.status === "CURRENT" : p.status !== "CURRENT"))).map(p => p.goal_profile.id));
    this.root.querySelectorAll<HTMLElement | SVGElement>("[data-goal-filter]").forEach(node => {
      const show = visible.has(node.dataset.goalFilter!); node.style.display = show ? "" : "none"; node.setAttribute("aria-hidden", String(!show));
    });
    const count = document.querySelector("#library-search-count"); if (count) count.textContent = `${visible.size} 个目标`;
    const empty = document.querySelector<HTMLElement>("#library-search-empty"); if (empty) empty.hidden = Boolean(visible.size || !this.projects.length || this.goal);
    const toolbar = document.querySelector<HTMLElement>("#learning-library-page .collection-toolbar"); if (toolbar) toolbar.hidden = Boolean(this.goal);
  }
  private zoom(factor: number): void {
    if (factor === 0) this.viewport = {x: 0, y: 0, zoom: 1};
    else this.viewport.zoom = Math.max(.65, Math.min(4, this.viewport.zoom * factor));
    this.transformMap();
  }
  private transformMap(): void {this.root.querySelector(".growth-map-plane")?.setAttribute("transform", `translate(${this.viewport.x} ${this.viewport.y}) translate(320 210) scale(${this.viewport.zoom}) translate(-320 -210)`);}
  private bindMap(): void {
    const svg = this.root.querySelector<SVGSVGElement>(".growth-map"); if (!svg) return;
    let drag: {x: number; y: number; panX: number; panY: number} | undefined;
    svg.addEventListener("pointerdown", event => {
      if ((event.target as Element).closest("[data-map-goal]")) return;
      drag = {x: event.clientX, y: event.clientY, panX: this.viewport.x, panY: this.viewport.y}; svg.setPointerCapture(event.pointerId);
    });
    svg.addEventListener("pointermove", event => {if (!drag) return;
      const ratio = 640 / svg.getBoundingClientRect().width;
      this.viewport.x = drag.panX + (event.clientX - drag.x) * ratio; this.viewport.y = drag.panY + (event.clientY - drag.y) * ratio; this.transformMap();
    });
    svg.addEventListener("pointerup", () => {drag = undefined;}); svg.addEventListener("pointercancel", () => {drag = undefined;});
    svg.addEventListener("wheel", event => {event.preventDefault(); this.zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1);}, {passive: false});
    svg.addEventListener("keydown", event => {
      if (event.target !== svg) return;
      if (["+", "="].includes(event.key)) this.zoom(1.25); else if (event.key === "-") this.zoom(.8);
      else if (event.key.startsWith("Arrow")) {event.preventDefault(); this.viewport.x += event.key === "ArrowLeft" ? 24 : event.key === "ArrowRight" ? -24 : 0; this.viewport.y += event.key === "ArrowUp" ? 24 : event.key === "ArrowDown" ? -24 : 0; this.transformMap();}
    });
  }
}
