import { GUIDE_KEY, guideTips, parseGuidePreference } from "./featureGuideContent";
import type { GuideContext, GuidePreference, GuideTip } from "./featureGuideContent";

/** 只读取页面状态、保存浏览器引导偏好；不发送请求，也不替用户操作学习控件。 */
export class FeatureGuide {
  private preference: GuidePreference | null = null;
  private storageAvailable = true;
  private readonly panel = document.createElement("aside");
  private readonly outline = document.createElement("div");
  private current: {tip: GuideTip; anchor: HTMLElement; description: string | null} | null = null;
  private timer = 0;
  private idleUntil = 0;
  private autoAllowed = true;
  private eventKey = "";
  private interest: string | null = null;
  private previousFocus: HTMLElement | null = null;
  private focusNext = false;

  constructor(private readonly context: () => GuideContext) {
    try { this.preference = parseGuidePreference(localStorage.getItem(GUIDE_KEY)); }
    catch { this.storageAvailable = false; }
    this.panel.id = "feature-guide";
    this.panel.className = "feature-guide";
    this.panel.hidden = true;
    this.panel.setAttribute("role", "region");
    this.panel.setAttribute("aria-label", "功能介绍");
    this.panel.innerHTML = '<div aria-live="polite" aria-atomic="true"><h2 id="feature-guide-title"></h2><p id="feature-guide-description"></p></div><div class="feature-guide-actions"><button type="button" data-guide-stop>不再提示</button><button type="button" data-guide-next>知道了</button></div>';
    this.outline.className = "feature-guide-outline";
    this.outline.hidden = true;
    this.outline.setAttribute("aria-hidden", "true");
    document.body.append(this.outline, this.panel);
    this.mountReference();
    this.panel.querySelector("[data-guide-stop]")!.addEventListener("click", () => this.stop());
    this.panel.querySelector("[data-guide-next]")!.addEventListener("click", () => {
      const next = this.current && ["chat", "assistant", "route"].includes(this.current.tip.id);
      this.focusNext = Boolean(next && this.panel.contains(document.activeElement));
      this.dismiss(true);
      if (next) { this.autoAllowed = true; this.schedule(100); }
    });
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || !this.current) return;
      const inside = this.panel.contains(event.target as Node);
      this.dismiss(true);
      if (inside) { event.preventDefault(); event.stopPropagation(); }
    }, true);
    document.addEventListener("input", event => {
      if (this.panel.contains(event.target as Node)) return;
      this.idleUntil = Date.now() + 12000;
      this.dismiss(false);
    });
    document.addEventListener("pointerover", event => this.inspectInterest(event.target));
    document.addEventListener("focusin", event => this.inspectInterest(event.target));
    document.addEventListener("focusout", () => this.schedule());
    document.addEventListener("click", event => {
      if (this.current?.anchor.contains(event.target as Node)) this.dismiss(true);
      this.schedule();
    });
    document.addEventListener("visibilitychange", () => this.refresh());
    window.addEventListener("resize", () => this.reposition());
    document.addEventListener("scroll", () => { this.reposition(); this.schedule(); }, true);
    // 观察动态入口的出现/消失；忽略引导自身，避免流式正文每次更新都创建提示。
    new MutationObserver(() => this.schedule()).observe(document.querySelector("#app")!, {
      subtree:true,childList:true,attributes:true,attributeFilter:["hidden","class","disabled","inert","aria-expanded"],
    });
    new MutationObserver(() => this.schedule()).observe(document.body, {attributes:true,childList:true,attributeFilter:["class"]});
    this.schedule();
  }

  private mountReference(): void {
    const section = document.createElement("details");
    section.className = "feature-guide-reference";
    section.id = "feature-guide-reference";
    section.innerHTML = '<summary>使用指南</summary><p>按功能位置查找说明。入口提示可以随时关闭，不会代替你操作课堂。</p><button type="button" class="ghost-button" data-guide-replay data-workspace-target="learn">回到课堂，重新查看入口提示</button>';
    for (const group of ["开始与课堂", "资料与复习", "反馈与设置"] as const) {
      const heading = document.createElement("h3"); heading.textContent = group;
      const list = document.createElement("dl");
      for (const tip of guideTips.filter(item => item.group === group)) {
        const title = document.createElement("dt"); title.textContent = tip.title;
        const location = document.createElement("small"); location.textContent = tip.where; title.append(location);
        const description = document.createElement("dd"); description.textContent = tip.text;
        list.append(title, description);
      }
      section.append(heading, list);
    }
    const stop = document.createElement("button");
    stop.type = "button"; stop.className = "ghost-button"; stop.textContent = "关闭入口提示";
    stop.addEventListener("click", () => this.stop());
    const status = document.createElement("p"); status.dataset.guideStatus = ""; status.setAttribute("role", "status");
    section.append(stop, status);
    section.querySelector("[data-guide-replay]")!.addEventListener("click", () => {
      this.dismiss(false); this.preference = {mode:"active",seen:[]}; this.save();
      this.autoAllowed = true; this.idleUntil = 0; this.schedule();
    });
    document.querySelector("#provider-settings-page")!.append(section);
    this.updateStatus();
  }

  private updateStatus(): void {
    const status = document.querySelector<HTMLElement>("[data-guide-status]");
    if (status) status.textContent = `${this.preference?.mode === "active" ? "入口提示已开启。" : "入口提示未开启，功能说明始终可在这里查看。"}${this.storageAvailable ? "" : "浏览器无法保存偏好，本次选择仅在当前页面有效。"}`;
  }
  private save(): void {
    try { localStorage.setItem(GUIDE_KEY, JSON.stringify(this.preference)); }
    catch { this.storageAvailable = false; }
    this.updateStatus();
  }
  private stop(): void {
    this.preference = {mode:"off",seen:this.preference?.seen ?? []}; this.save(); this.dismiss(false);
  }
  private schedule(delay = 700): void {
    if (this.timer) return;
    this.timer = window.setTimeout(() => { this.timer = 0; this.refresh(); }, delay);
  }
  private inspectInterest(target: EventTarget | null): void {
    if (!(target instanceof Element) || this.panel.contains(target)) return;
    this.interest = guideTips.find(tip => tip.trigger === "interest" && target.closest(tip.target))?.id ?? null;
    this.schedule();
  }
  private blocked(c: GuideContext): boolean {
    const active = document.activeElement;
    return !c.ready || c.busy || document.hidden || Date.now() < this.idleUntil ||
      Boolean(document.querySelector("#learning-intro, dialog[open], [popover]:popover-open")) ||
      Boolean(active instanceof Element && active.matches('textarea, input, select, [contenteditable="true"]')) ||
      Boolean(window.getSelection()?.toString());
  }
  private visible(node: HTMLElement): boolean {
    if (node.closest('[hidden], [inert], .hidden') || node.matches(":disabled")) return false;
    const style = getComputedStyle(node), r = node.getBoundingClientRect();
    if (style.visibility === "hidden" || style.display === "none" || !r.width || !r.height) return false;
    // 不能把滚出阅读容器的题卡或藏在折叠导航里的入口当作可见目标。
    let top = 0, left = 0, right = innerWidth, bottom = innerHeight;
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const s = getComputedStyle(parent), box = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(s.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
      if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
    }
    return r.top >= top && r.left >= left && r.bottom <= bottom + 1 && r.right <= right + 1;
  }
  private anchor(tip: GuideTip): HTMLElement | undefined {
    return [...document.querySelectorAll<HTMLElement>(tip.target)].find(node => this.visible(node));
  }
  private refresh(): void {
    const c = this.context();
    if (!this.preference && c.ready) {
      // 不拿动画观看键当作新手身份；已有历史或存储受限时默认不打扰。
      this.preference = {mode:c.hasHistory || !this.storageAvailable ? "off" : "active",seen:[]}; this.save();
      if (!this.storageAvailable) { this.preference.mode = "off"; this.updateStatus(); }
    }
    if (this.preference?.mode !== "active" || this.blocked(c)) { this.focusNext = false; this.dismiss(false); return; }
    const contextualEntrances = ["materials","note","assessment","proposal"].map(id => {
      const tip = guideTips.find(item => item.id === id)!;
      return tip.eligible(c) && Boolean(this.anchor(tip));
    });
    const key = [c.view,c.hasGoal,c.classroom,c.hasCards,c.purpose,c.questionCount,...contextualEntrances].join(":");
    if (this.eventKey !== key) { this.eventKey = key; this.autoAllowed = true; this.dismiss(false); }
    if (this.current) { this.reposition(); return; }
    const candidates = guideTips.filter(tip => !this.preference!.seen.includes(tip.id) && tip.eligible(c));
    const core = candidates.filter(tip => ["start","chat","assistant","route","library"].includes(tip.id));
    const ordered = this.interest ? candidates.filter(tip => tip.id === this.interest) : this.autoAllowed ? [...core, ...candidates.filter(tip => tip.trigger === "auto" && !core.includes(tip))] : [];
    for (const tip of ordered) {
      const anchor = this.anchor(tip);
      if (anchor) { this.show(tip, anchor); break; }
    }
  }
  private show(tip: GuideTip, anchor: HTMLElement): void {
    this.autoAllowed = false; this.interest = null;
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.current = {tip,anchor,description:anchor.getAttribute("aria-describedby")};
    this.panel.dataset.tip = tip.id;
    this.panel.querySelector("h2")!.textContent = tip.title;
    this.panel.querySelector("p")!.textContent = tip.text;
    this.panel.querySelector("[data-guide-next]")!.textContent = ["chat","assistant","route"].includes(tip.id) ? "下一处" : "知道了";
    anchor.setAttribute("aria-describedby", [this.current.description,"feature-guide-description"].filter(Boolean).join(" "));
    this.panel.hidden = false; this.outline.hidden = false; this.reposition();
    if (this.current && this.focusNext) {
      this.panel.querySelector<HTMLButtonElement>("[data-guide-next]")!.focus({preventScroll:true});
      this.focusNext = false;
    }
  }
  private dismiss(seen: boolean): void {
    if (!this.current) return;
    const {tip,anchor,description} = this.current;
    const restoreFocus = this.panel.contains(document.activeElement);
    this.current = null;
    if (description === null) anchor.removeAttribute("aria-describedby"); else anchor.setAttribute("aria-describedby", description);
    this.panel.hidden = true; this.outline.hidden = true;
    if (seen && this.preference) { this.preference.seen = [...new Set([...this.preference.seen,tip.id])]; this.save(); }
    if (restoreFocus && this.previousFocus?.isConnected) this.previousFocus.focus({preventScroll:true});
  }
  private reposition(): void {
    if (!this.current) return;
    const anchor = this.current.anchor;
    if (!anchor.isConnected || !this.visible(anchor)) { this.dismiss(false); return; }
    const r = anchor.getBoundingClientRect(), gap = 12, margin = 12;
    const placementAnchor = anchor.closest("#composer, #assistant-composer")?.getBoundingClientRect() ?? r;
    const p = this.panel.getBoundingClientRect();
    const x = Math.max(margin, Math.min(r.left, innerWidth - p.width - margin));
    const sideY = Math.max(margin, Math.min(r.top, innerHeight - p.height - margin));
    const protectedAreas = [...document.querySelectorAll<HTMLElement>("#composer, #assistant-composer, #learner-questions textarea")]
      .filter(node => this.visible(node)).map(node => node.getBoundingClientRect());
    const candidates = [{x,y:placementAnchor.bottom+gap},{x,y:placementAnchor.top-gap-p.height},{x:placementAnchor.left-gap-p.width,y:sideY},{x:placementAnchor.right+gap,y:sideY}];
    // 题组的提交按钮与底部输入栏之间可能放不下一整条提示，向两侧空白区避让。
    for (const box of protectedAreas) {
      for (const y of [box.top-gap-p.height, box.bottom+gap]) {
        candidates.push({x:placementAnchor.left-gap-p.width,y},{x:placementAnchor.right+gap,y});
      }
    }
    const placement = candidates.find(pos => pos.x >= margin && pos.y >= margin && pos.x+p.width <= innerWidth-margin && pos.y+p.height <= innerHeight-margin &&
      !protectedAreas.some(box => pos.x < box.right && pos.x+p.width > box.left && pos.y < box.bottom && pos.y+p.height > box.top));
    if (!placement) { this.dismiss(false); return; }
    Object.assign(this.panel.style, {left:`${placement.x}px`,top:`${placement.y}px`});
    Object.assign(this.outline.style, {left:`${r.left-3}px`,top:`${r.top-3}px`,width:`${r.width+6}px`,height:`${r.height+6}px`});
  }
}
