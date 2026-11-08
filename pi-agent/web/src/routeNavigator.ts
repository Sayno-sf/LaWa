import {icon} from "./icons";

type RouteMode = "expanded" | "rail" | "hidden";
const PREFERENCE = "learn-anything:route-view:v1";

/** 路线只有原来的一个DOM；刻度仅定位该目录，绝不切换任务或推算掌握。 */
export class RouteNavigator {
  readonly node = document.createElement("aside");
  readonly panel = document.createElement("section");
  readonly toggle = document.createElement("button");
  private readonly rail = document.createElement("div");
  private readonly ticks = document.createElement("div");
  private readonly position = document.createElement("button");
  private assistantOpen = false;
  private temporarilyCollapsed = false;
  private mode: RouteMode = "rail";
  private signature = "";

  constructor(private readonly route: HTMLElement, private readonly workspace: HTMLElement, header: HTMLElement) {
    try { const saved = localStorage.getItem(PREFERENCE); if (saved === "expanded" || saved === "hidden") this.mode = saved; } catch { /* 浏览器存储受限时仍可折叠。 */ }
    this.node.className = "route-navigator";
    this.node.setAttribute("aria-label", "学习路线导航");
    this.panel.id = "route-directory";
    this.panel.className = "route-directory";
    this.panel.setAttribute("aria-label", "完整学习路线");
    this.panel.innerHTML = `<div class="route-directory-actions"><button type="button" data-route-mode="rail" aria-label="收起为路线刻度" title="收起为刻度">${icon("panelClose")}</button><button type="button" data-route-mode="hidden" aria-label="隐藏学习路线" title="完全隐藏路线">${icon("close")}</button></div>`;
    this.rail.className = "route-rail";
    this.ticks.className = "route-ticks";
    this.position.type = "button";
    this.position.className = "route-position";
    this.position.addEventListener("click", () => this.setMode("expanded"));
    this.rail.append(this.position, this.ticks);
    const hide = document.createElement("button");
    hide.className = "route-rail-hide";
    hide.type = "button";
    hide.dataset.routeMode = "hidden";
    hide.title = "隐藏刻度，从页头路线按钮恢复";
    hide.setAttribute("aria-label", "隐藏路线刻度");
    hide.innerHTML = icon("close");
    this.rail.append(hide);
    this.node.append(this.rail, this.panel);
    this.toggle.id = "route-toggle";
    this.toggle.className = "route-toggle";
    this.toggle.type = "button";
    this.toggle.setAttribute("aria-controls", this.panel.id);
    this.toggle.innerHTML = `${icon("route")}<span>路线</span>`;
    header.prepend(this.toggle);
    workspace.prepend(this.node);
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => {
      this.node.style.setProperty("--route-header-height", `${header.getBoundingClientRect().height}px`);
    }).observe(header);
    this.toggle.addEventListener("click", () => this.setMode(this.mode === "expanded" ? "rail" : "expanded"));
    this.node.addEventListener("click", event => {
      const button = (event.target as Element).closest<HTMLButtonElement>("[data-route-mode]");
      if (button) { this.setMode(button.dataset.routeMode as RouteMode); this.toggle.focus({preventScroll:true}); }
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && this.mode === "expanded" && !this.node.hidden && !this.workspace.hidden) {
        this.setMode("rail"); this.toggle.focus({preventScroll:true});
      }
    });
    document.addEventListener("click", event => {
      if ((event.target as Element).closest("#assistant-entry, #assistant-panel, .focused-assistant-backdrop")) return;
      if (this.mode === "expanded" && !this.node.contains(event.target as Node) && !this.toggle.contains(event.target as Node)) this.setMode("rail");
    });
    this.applyMode();
  }

  setAssistantOpen(open: boolean): void {
    if (open === this.assistantOpen) return;
    this.assistantOpen = open;
    if (open && this.mode === "expanded") { this.temporarilyCollapsed = true; this.mode = "rail"; }
    else if (!open && this.temporarilyCollapsed) { this.temporarilyCollapsed = false; this.mode = "expanded"; }
    this.applyMode();
  }

  mount(desktop: boolean): void {
    this.node.hidden = !desktop;
    this.toggle.hidden = !desktop;
    if (desktop && this.route.parentElement !== this.panel) this.panel.append(this.route);
    this.refresh();
  }

  refresh(): void {
    const stages = [...this.route.querySelectorAll<HTMLElement>(".skill-route > .learning-route-stage")];
    const entries = stages.map(stage => ({
      name: stage.querySelector(".learning-route-stage-name, .learning-route-skill-copy > strong")?.textContent ?? "学习阶段",
      unassigned: stage.classList.contains("learning-route-unassigned"),
      current: stage.classList.contains("is-current-stage"),
      mastered: stage.classList.contains("learning-route-merged") && Boolean(stage.querySelector(".learning-route-skill.is-mastered")),
    }));
    const signature = JSON.stringify(entries);
    if (signature === this.signature) return;
    this.signature = signature;
    const assigned = entries.filter(entry => !entry.unassigned);
    const current = assigned.findIndex(entry => entry.current);
    this.position.textContent = `${current >= 0 ? current + 1 : "—"} / ${assigned.length}\n阶段`;
    this.position.setAttribute("aria-label", `${this.position.textContent}，展开学习路线`);
    this.ticks.replaceChildren();
    entries.forEach((entry, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `route-tick${entry.current ? " is-current" : ""}${entry.mastered ? " is-mastered" : ""}`;
      const position = entry.unassigned ? "未归入路线的知识点" : `第 ${assigned.indexOf(entry) + 1} 阶段`;
      button.setAttribute("aria-label", `${position}：${entry.name}${entry.current ? "，正在学习" : entry.mastered ? "，已确认掌握" : ""}`);
      if (entry.current) button.setAttribute("aria-current", "step");
      const line = document.createElement("span"); line.className = "route-tick-line"; line.setAttribute("aria-hidden", "true");
      const tip = document.createElement("span"); tip.className = "route-tick-tip"; tip.setAttribute("aria-hidden", "true");
      const label = document.createElement("small"); label.textContent = `${position}${entry.current ? " · 正在学习" : ""}`;
      const name = document.createElement("strong"); name.textContent = entry.name;
      tip.append(label, name); button.append(line, tip);
      button.addEventListener("click", () => {
        this.setMode("expanded");
        // 每次取当前节点，状态刷新重绘目录后不保留已脱离DOM的引用。
        const stage = this.route.querySelectorAll<HTMLElement>(".skill-route > .learning-route-stage")[index];
        stage?.scrollIntoView({block:"nearest", behavior:"instant"});
        const target = stage?.querySelector<HTMLElement>("button") ?? stage;
        if (target) { if (target.tagName !== "BUTTON") target.tabIndex = -1; target.focus({preventScroll:true}); }
      });
      this.ticks.append(button);
    });
    this.rail.hidden = !entries.length;
  }

  private setMode(mode: RouteMode): void {
    this.temporarilyCollapsed = false;
    this.mode = mode;
    this.applyMode();
    try { localStorage.setItem(PREFERENCE, mode); } catch { /* 只保留当前页偏好。 */ }
  }

  private applyMode(): void {
    this.workspace.dataset.routeView = this.mode;
    this.node.dataset.mode = this.mode;
    this.panel.hidden = this.mode !== "expanded";
    this.toggle.setAttribute("aria-expanded", String(this.mode === "expanded"));
    this.toggle.title = this.mode === "expanded" ? "收起为路线刻度" : "展开学习路线";
  }
}
