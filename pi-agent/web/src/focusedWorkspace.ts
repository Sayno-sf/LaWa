import {RouteNavigator} from "./routeNavigator";
/** 只移动既有视图节点；学习事实、事件监听和手机壳层保持原来的所有者。 */
export class FocusedWorkspace {
  private readonly desktop = matchMedia("(min-width: 821px)");
  private readonly sidebar = document.querySelector<HTMLElement>("#sidebar")!;
  private readonly route = document.querySelector<HTMLElement>(".route-card")!;
  private readonly skill = document.querySelector<HTMLElement>("#skill-card")!;
  private readonly evidence = document.querySelector<HTMLElement>(".evidence-card")!;
  private readonly routeHome = document.createComment("route-home");
  private readonly skillHome = document.createComment("skill-home");
  private readonly evidenceHome = document.createComment("evidence-home");
  private readonly sidebarScroll = document.createElement("div");
  private readonly taskSlot = document.createElement("div");
  private readonly primary = document.createElement("div");
  private readonly secondary = document.createElement("div");
  private readonly actions = document.createElement("div");
  private readonly assistantHome = document.createComment("assistant-home");
  private readonly assistant = document.querySelector<HTMLElement>("#assistant-entry")!;
  private readonly navigator: RouteNavigator;

  constructor() {
    this.sidebar.querySelectorAll<HTMLElement>(".nav-item").forEach(item => {
      const label = item.textContent?.trim() ?? "";
      item.setAttribute("aria-label", label);
      item.title = label;
    });
    this.route.before(this.routeHome);
    this.skill.before(this.skillHome);
    this.evidence.before(this.evidenceHome);
    this.sidebarScroll.className = "focused-sidebar-scroll";
    const conversations = this.sidebar.querySelector(".conversation-library")!;
    conversations.before(this.sidebarScroll);
    this.sidebarScroll.append(conversations);
    this.taskSlot.className = "focused-task-slot";
    const header = document.querySelector<HTMLElement>(".learning-stage-header")!;
    this.primary.className = "learning-header-primary";
    this.secondary.className = "learning-header-secondary";
    this.actions.className = "learning-header-actions";
    header.append(this.primary, this.secondary);
    this.primary.append(this.taskSlot);
    this.assistant.before(this.assistantHome);
    const tabs = header.querySelector<HTMLElement>(".learning-content-tools")!;
    this.secondary.append(tabs, this.actions, header.querySelector("#study-time-strip")!, header.querySelector(".connection-pill")!);
    this.navigator = new RouteNavigator(this.route, document.querySelector<HTMLElement>("#learning-workspace")!, header);
    tabs.append(this.navigator.toggle);
    this.desktop.addEventListener("change", () => this.sync());
    this.sync();
  }

  setAssistantOpen(open: boolean): void { this.navigator.setAssistantOpen(open); }

  sync(): void {
    const routeScroll = this.route.querySelector<HTMLElement>(".skill-route");
    const top = routeScroll?.scrollTop ?? 0;
    if (this.desktop.matches) {
      if (this.assistant.parentElement !== this.primary) this.primary.append(this.assistant);
      this.navigator.mount(true);
      if (this.skill.parentElement !== this.taskSlot) this.taskSlot.append(this.skill);
      const controls = this.skill.querySelector(".focused-skill-controls");
      if (controls) this.actions.replaceChildren(controls);
      else if (!this.skill.querySelector(".focused-skill-heading")) this.actions.replaceChildren();
      const details = this.skill.querySelector(".focused-skill-details");
      if (details) details.append(this.evidence);
      else this.evidenceHome.after(this.evidence);
    } else {
      this.navigator.mount(false);
      this.assistantHome.after(this.assistant);
      this.routeHome.after(this.route);
      this.skillHome.after(this.skill);
      this.evidenceHome.after(this.evidence);
    }
    if (routeScroll) routeScroll.scrollTop = top;
  }
}
