export type WorkspaceView = "learn" | "library" | "notes" | "teaching" | "settings" | "conversations" | "materials";
const views: readonly WorkspaceView[] = ["learn", "library", "notes", "teaching", "settings", "conversations", "materials"];

function resolveView(value: string): WorkspaceView {
  return views.includes(value as WorkspaceView) ? value as WorkspaceView : "learn";
}

/** 页面导航只管理展示、历史与滚动；Session/Goal 的恢复和写入仍由既有用户入口负责。 */
export class WorkspaceNavigation {
  current: WorkspaceView = "learn";
  private readonly main = document.querySelector<HTMLElement>("#main-content")!;
  private readonly panels = [...document.querySelectorAll<HTMLElement>("[data-workspace-view]")];
  private readonly positions = new Map<WorkspaceView, { main: number; inner: Map<HTMLElement, number> }>();
  private restoreFrame = 0;
  private restoreRevision = 0;

  constructor(private readonly onChange: (view: WorkspaceView) => void | Promise<unknown>) {}

  start(): void {
    // 迟到的列表加载不得拉回已经开始阅读或操作的用户。
    const cancelRestore = () => { this.restoreRevision++; window.cancelAnimationFrame(this.restoreFrame); };
    this.main.addEventListener("wheel", cancelRestore, { passive: true });
    this.main.addEventListener("touchstart", cancelRestore, { passive: true });
    this.main.addEventListener("pointerdown", cancelRestore);
    this.main.addEventListener("keydown", event => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Tab"].includes(event.key)) cancelRestore();
    });
    document.addEventListener("click", (event) => {
      const target = (event.target as Element).closest<HTMLElement>("[data-workspace-target]");
      if (!target || event instanceof MouseEvent && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0)) return;
      event.preventDefault();
      this.navigate(resolveView(target.dataset.workspaceTarget ?? ""));
    });
    window.addEventListener("hashchange", () => this.show(resolveView(location.hash.slice(1))));
    this.show(resolveView(location.hash.slice(1)), false);
  }

  navigate(view: WorkspaceView): void {
    if (location.hash !== `#${view}`) history.pushState(null, "", `#${view}`);
    this.show(view);
  }

  /** 显式定位卡片优先于页面通用恢复；避免下一帧把用户带回旧滚动位置。 */
  afterRestore(action: () => void): void {
    const revision = ++this.restoreRevision;
    window.cancelAnimationFrame(this.restoreFrame);
    const view = this.current;
    this.restoreFrame = window.requestAnimationFrame(() => { if (this.current === view && this.restoreRevision === revision) action(); });
  }

  private show(view: WorkspaceView, focus = true): void {
    const revision = ++this.restoreRevision;
    window.cancelAnimationFrame(this.restoreFrame);
    const previous = this.panels.find((panel) => panel.dataset.workspaceView === this.current);
    if (previous && !previous.hidden) {
      this.positions.set(this.current, {
        main: window.innerWidth <= 820 ? window.scrollY : this.main.scrollTop,
        inner: new Map([...previous.querySelectorAll<HTMLElement>("#messages, #task-focus-card, #knowledge-cards-panel, .skill-route, .context-column, #skill-card, .evidence-card"), ...document.querySelectorAll<HTMLElement>(".focused-sidebar-scroll, .focused-sidebar-scroll .skill-route")].map((node) => [node, node.scrollTop])),
      });
    }
    this.current = view;
    const panel = this.panels.find((node) => node.dataset.workspaceView === view)!;
    this.panels.forEach((node) => { node.hidden = node !== panel; });
    document.body.dataset.workspace = view;
    document.querySelectorAll<HTMLElement>(".nav-item[data-workspace-target]").forEach((item) => {
      const active = item.dataset.workspaceTarget === view;
      item.classList.toggle("active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
    const titles: Record<WorkspaceView, string> = { learn: "学习", library: "学习库", notes: "笔记", teaching: "教学偏好", settings: "设置", conversations: "对话管理", materials: "学习资料" };
    document.title = `${titles[view]} · Learn Anything`;
    // 首次布局和异步列表完成后均恢复；避免短暂占位内容把保存的位置截到页首。
    const saved = this.positions.get(view);
    const restore = () => {
      if (this.current !== view || this.restoreRevision !== revision) return;
      if (window.innerWidth <= 820) window.scrollTo({ top: saved?.main ?? 0, behavior: "instant" });
      else this.main.scrollTop = saved?.main ?? 0;
      saved?.inner.forEach((top, node) => { node.scrollTop = top; });
    };
    restore();
    if (focus) panel.focus({ preventScroll: true });
    const loading = this.onChange(view);
    this.restoreFrame = window.requestAnimationFrame(restore);
    if (loading) void loading.then(restore, restore);
  }
}
