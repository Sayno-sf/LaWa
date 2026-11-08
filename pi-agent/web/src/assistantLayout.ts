const WIDTH_PREFERENCE = "learn-anything:assistant-width:v1";
const MIN_ASSISTANT = 320;
const MAX_ASSISTANT = 420;
const MIN_TEACHER = 640;

/** 只保存浏览器阅读偏好。课堂宽度不由消息内容驱动，也不参与学习归属或模型调用。 */
export class AssistantLayout {
  private preference: number | null = null;
  private opened = false;
  private wide = false;
  private available = 0;
  private width = MIN_ASSISTANT;
  private drag: {id: number; x: number; width: number; preference: number | null} | null = null;
  private frame = 0;
  private readonly handle = document.createElement("div");
  private readonly route: HTMLElement | null;

  constructor(private readonly grid: HTMLElement, private readonly dock: HTMLElement,
    private readonly onModeChange: () => void) {
    this.route = grid.querySelector<HTMLElement>(".route-card");
    try {
      const saved = localStorage.getItem(WIDTH_PREFERENCE);
      const value = saved === null ? NaN : Number(saved);
      if (Number.isFinite(value) && value >= MIN_ASSISTANT && value <= 4000) this.preference = value;
    } catch { /* 存储受限时仍提供当前页调节。 */ }
    this.handle.id = "assistant-resize-handle";
    this.handle.className = "assistant-resize-handle";
    this.handle.tabIndex = 0;
    this.handle.setAttribute("role", "separator");
    this.handle.setAttribute("aria-orientation", "vertical");
    this.handle.setAttribute("aria-label", "调整助教宽度");
    this.handle.setAttribute("aria-controls", "assistant-panel");
    this.handle.title = "左右拖动或方向键调整宽度，双击恢复自适应";
    this.dock.append(this.handle);
    this.handle.addEventListener("pointerdown", event => {
      if (!this.wide || !this.opened || event.button !== 0 || this.drag) return;
      event.preventDefault();
      this.drag = {id:event.pointerId, x:event.clientX, width:this.width, preference:this.preference};
      this.handle.setPointerCapture(event.pointerId);
      document.body.classList.add("assistant-resizing");
    });
    this.handle.addEventListener("pointermove", event => {
      if (this.drag?.id !== event.pointerId) return;
      this.preference = this.clamp(this.drag.width + this.drag.x - event.clientX);
      this.applyWidth();
    });
    this.handle.addEventListener("pointerup", event => {
      if (this.drag?.id !== event.pointerId) return;
      this.finishDrag(false); this.savePreference();
    });
    this.handle.addEventListener("pointercancel", () => this.finishDrag(true));
    this.handle.addEventListener("lostpointercapture", () => this.finishDrag(true));
    this.handle.addEventListener("dblclick", () => this.reset());
    this.handle.addEventListener("keydown", event => {
      if (!this.wide || !this.opened || this.drag) return;
      const step = event.shiftKey ? 64 : 24;
      let next: number;
      if (event.key === "ArrowLeft") next = this.width + step;
      else if (event.key === "ArrowRight") next = this.width - step;
      else if (event.key === "Home") next = MIN_ASSISTANT;
      else if (event.key === "End") next = this.available - MIN_TEACHER;
      else if (event.key === "Enter") { event.preventDefault(); this.reset(); return; }
      else return;
      event.preventDefault(); this.preference = this.clamp(next); this.applyWidth(); this.savePreference();
    });
    this.refresh(false);
    const schedule = () => {
      if (this.frame) return;
      this.frame = window.requestAnimationFrame(() => { this.frame = 0; this.refresh(true); });
    };
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(schedule).observe(grid);
    window.addEventListener("resize", schedule);
  }

  get sideBySide(): boolean { return this.wide; }

  setOpen(open: boolean): void {
    this.opened = open;
    if (!open) this.finishDrag(true);
    this.refresh(false);
  }

  private refresh(notify: boolean): void {
    const gap = parseFloat(getComputedStyle(this.grid).columnGap) || 0;
    // 桌面路线独立于课堂网格；只扣仍在网格里的路线，按实际剩余空间分配助教。
    const routeInGrid = this.route?.parentElement === this.grid;
    const routeWidth = routeInGrid ? Math.max(212, this.route!.getBoundingClientRect().width) : 0;
    this.available = this.grid.clientWidth - routeWidth - (routeInGrid ? 2 : 1) * gap;
    const previous = this.wide;
    this.wide = getComputedStyle(this.grid).display === "grid" && this.available >= MIN_TEACHER + MIN_ASSISTANT;
    if (!this.wide) this.finishDrag(true);
    document.body.classList.toggle("assistant-side-by-side", this.opened && this.wide);
    this.handle.hidden = !this.opened || !this.wide;
    this.applyWidth();
    if (previous && !this.wide && document.activeElement === this.handle) document.querySelector<HTMLElement>("#assistant-entry")?.focus();
    if (notify && previous !== this.wide) this.onModeChange();
  }

  private clamp(value: number): number {
    return Math.round(Math.max(MIN_ASSISTANT, Math.min(value, MAX_ASSISTANT, this.available - MIN_TEACHER)));
  }

  private applyWidth(): void {
    const automatic = 360;
    this.width = this.clamp(this.preference ?? automatic);
    this.grid.style.setProperty("--assistant-width", `${this.width}px`);
    this.handle.setAttribute("aria-valuemin", String(MIN_ASSISTANT));
    this.handle.setAttribute("aria-valuemax", String(Math.max(MIN_ASSISTANT, Math.min(MAX_ASSISTANT, Math.floor(this.available - MIN_TEACHER)))));
    this.handle.setAttribute("aria-valuenow", String(this.width));
    this.handle.setAttribute("aria-valuetext", `助教宽度 ${this.width} 像素`);
  }

  private finishDrag(cancel: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    if (cancel) this.preference = drag.preference;
    document.body.classList.remove("assistant-resizing");
    if (this.handle.hasPointerCapture(drag.id)) this.handle.releasePointerCapture(drag.id);
    this.applyWidth();
  }

  private reset(): void {
    this.finishDrag(true); this.preference = null; this.applyWidth(); this.savePreference();
  }

  private savePreference(): void {
    try {
      if (this.preference === null) localStorage.removeItem(WIDTH_PREFERENCE);
      else localStorage.setItem(WIDTH_PREFERENCE, String(this.preference));
    } catch { /* 保存失败不影响当前阅读；窗口变小时仅约束显示，不改写用户原偏好。 */ }
  }
}
