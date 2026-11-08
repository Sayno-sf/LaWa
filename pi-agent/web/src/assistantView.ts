import { renderMarkdown } from "./markdown";
import type {FigureAnchor} from "../../src/lessonFigureTypes";
import { AssistantLayout } from "./assistantLayout";
import type {AnimationAnchor} from "../../src/animationTypes";

export interface AssistantMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export interface AssistantSnapshot {
  available: boolean;
  scope: { goalId: string; taskId: string; skillId: string | null; attemptId: string | null; mainSessionId: string } | null;
  messages: AssistantMessage[];
  busy: boolean;
  teacher_busy?: boolean;
  notice?: string;
}

export interface AssistantContext {
  sessionId: string | null;
  key: string;
  available: boolean;
  taskTitle: string;
  teacherBusy: boolean;
  canReturn?: boolean;
  draftScope?: {goalId: string | null; taskId: string | null; skillId: string | null};
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

/** 助教只维护独立视图和草稿。任务、作答关联和帮助记录由服务端绑定，切换视图不发送教学消息。 */
export class AssistantView {
  private context: AssistantContext = { sessionId: null, key: "", available: false, taskTitle: "", teacherBusy: false };
  private snapshot: AssistantSnapshot | null = null;
  private opened = false;
  private loading = false;
  private generating = false;
  private stopping = false;
  private error = "";
  private requestVersion = 0;
  private loadController: AbortController | null = null;
  private streamController: AbortController | null = null;
  private pollTimer: number | undefined;
  private drafts = new Map<string, string>();
  private heldDraft: {key: string; title: string; goalId: string | null} | null = null;
  private figureDraft: {key:string;anchor:FigureAnchor} | null=null;
  private animationDraft: {key: string; anchor: AnimationAnchor} | null = null;
  private scrollPositions = new Map<string, number>();
  private focusedBeforeOpen: HTMLElement | null = null;
  private readonly wide = window.matchMedia("(min-width: 1751px)");
  private readonly layout: AssistantLayout | null;
  private readonly panel = document.querySelector<HTMLElement>("#assistant-panel")!;
  private readonly entry = document.querySelector<HTMLButtonElement>("#assistant-entry")!;
  private readonly close = document.querySelector<HTMLButtonElement>("#assistant-close")!;
  private readonly dock = document.querySelector<HTMLElement>("#assistant-dock")!;
  private readonly viewport = document.querySelector<HTMLElement>(".learning-stage-viewport")!;
  private readonly supplements = document.querySelector<HTMLElement>(".context-column")!;
  private readonly messages = document.querySelector<HTMLElement>("#assistant-messages")!;
  private readonly source = document.querySelector<HTMLElement>("#assistant-source")!;
  private readonly notice = document.querySelector<HTMLElement>("#assistant-notice")!;
  private readonly status = document.querySelector<HTMLElement>("#assistant-status")!;
  private readonly retry = document.querySelector<HTMLButtonElement>("#assistant-retry")!;
  private readonly form = document.querySelector<HTMLFormElement>("#assistant-composer")!;
  private readonly input = document.querySelector<HTMLTextAreaElement>("#assistant-input")!;
  private readonly send = document.querySelector<HTMLButtonElement>("#assistant-send")!;
  private readonly stop = document.querySelector<HTMLButtonElement>("#assistant-stop")!;
  private readonly backdrop = document.createElement("button");
  private readonly draftRecovery = document.createElement("p");
  private readonly draftAdopt = document.createElement("button");

  constructor(private readonly onChange: () => void, private readonly beforeSend: () => Promise<void> = async () => undefined, private readonly returnToCurrent: () => Promise<void> = async () => undefined) {
    const grid = document.querySelector<HTMLElement>(".dashboard-grid");
    this.layout = grid ? new AssistantLayout(grid, this.dock, () => { this.syncLayout(); this.onChange(); }) : null;
    this.backdrop.className = "focused-assistant-backdrop";
    this.backdrop.type = "button";
    this.backdrop.tabIndex = -1;
    this.backdrop.setAttribute("aria-label", "关闭助教");
    this.backdrop.addEventListener("click", () => this.setOpen(false));
    this.viewport.append(this.backdrop);
    this.draftRecovery.className = "assistant-draft-recovery";
    this.draftRecovery.hidden = true;
    this.draftRecovery.setAttribute("role", "status");
    this.draftAdopt.type = "button";
    this.draftAdopt.className = "text-button";
    this.draftAdopt.setAttribute("data-assistant-adopt-draft", "");
    this.draftAdopt.textContent = "用于当前任务";
    this.draftAdopt.addEventListener("click", () => {
      if (!this.heldDraft || !this.context.available || this.loading || this.busy) return;
      this.drafts.set(this.heldDraft.key, this.input.value);
      const saved = this.drafts.get(this.taskDraftKey) ?? "";
      this.heldDraft = null;
      this.input.value = saved && saved !== this.input.value ? `${saved}\n\n${this.input.value}` : this.input.value;
      this.drafts.set(this.draftKey, this.input.value);
      this.syncControls(); this.input.focus({preventScroll: true});
    });
    this.form.before(this.draftRecovery);
    this.messages.addEventListener("click", event => {
      const button = (event.target as Element).closest<HTMLButtonElement>("button");
      if (button?.hasAttribute("data-return-current")) void this.returnToCurrent().catch(error => { this.error = String(error); this.syncControls(); });
      if (button?.dataset.suggestion && this.context.available && !this.input.disabled) {
        this.input.value = this.input.value.trim() ? `${this.input.value}\n${button.dataset.suggestion}` : button.dataset.suggestion;
        this.drafts.set(this.draftKey, this.input.value);
        this.syncControls(); this.input.focus();
      }
    });
    this.entry.addEventListener("click", () => this.setOpen(!this.opened));
    this.close.addEventListener("click", () => this.setOpen(false));
    this.retry.addEventListener("click", () => void this.load());
    this.form.addEventListener("submit", event => { event.preventDefault(); void this.submit(); });
    this.input.addEventListener("input", () => { this.drafts.set(this.draftKey, this.input.value); this.syncControls(); });
    this.input.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.form.requestSubmit(); }
    });
    this.stop.addEventListener("click", () => void this.stopGeneration());
    this.panel.addEventListener("keydown", event => {
      if (event.key === "Escape" && this.opened) { event.preventDefault(); this.setOpen(false); }
    });
    if (!this.layout) this.wide.addEventListener("change", () => { this.syncLayout(); this.onChange(); });
    this.syncLayout();
    this.render();
  }

  get busy(): boolean { return this.generating || Boolean(this.snapshot?.busy); }
  get waiting(): boolean { return this.busy && !this.snapshot?.messages.at(-1)?.content.trim(); }
  private get sideBySide(): boolean { return this.layout?.sideBySide ?? this.wide.matches; }
  get visibleInClassroom(): boolean { return this.opened && !this.sideBySide; }
  get isOpen(): boolean { return this.opened; }
  /** 动画位置随待发问题交给助教，不改主输入栏，也不替用户发送一条默认问题。 */
  openForFigure(anchor:FigureAnchor):void {
    if (!this.context.available || !this.context.sessionId || this.busy) return;
    this.drafts.set(this.draftKey,this.input.value);
    this.animationDraft=null;
    this.figureDraft={key:this.context.key,anchor:structuredClone(anchor)};
    this.setOpen(true);
    this.syncControls();
    this.input.focus({preventScroll:true});
  }
  clearFigureContext():void {this.figureDraft=null;}
  openForAnimation(anchor: AnimationAnchor): void {
    this.figureDraft=null;
    if (!this.context.available || !this.context.sessionId || this.busy) return;
    this.drafts.set(this.draftKey, this.input.value);
    this.animationDraft = {key: this.context.key, anchor: structuredClone(anchor)};
    this.setOpen(true);
    this.syncControls();
    this.input.focus({preventScroll: true});
  }
  clearAnimationContext(): void { this.animationDraft = null; this.syncControls(); }
  setTeacherBusy(busy: boolean): void {
    const finished = this.context.teacherBusy && !busy;
    this.context.teacherBusy = busy;
    if (finished && this.snapshot) this.snapshot.teacher_busy = false;
    this.syncControls();
  }
  private get draftKey(): string {
    return this.heldDraft?.key ?? this.taskDraftKey;
  }
  private get taskDraftKey(): string {
    const draftScope = this.context.draftScope;
    if (draftScope) return JSON.stringify([this.context.sessionId, draftScope.goalId, draftScope.taskId, draftScope.skillId]);
    const scope = this.snapshot?.scope;
    return scope ? `${scope.mainSessionId}:${scope.goalId}:${scope.taskId}` : this.context.key;
  }

  setContext(next: AssistantContext): void {
    if (next.key !== this.context.key) {
      this.figureDraft=null;
      this.animationDraft = null;
      const focused = document.activeElement === this.input;
      this.drafts.set(this.draftKey, this.input.value);
      this.scrollPositions.set(this.draftKey, this.messages.scrollTop);
      const oldScope = this.context.draftScope;
      const newScope = next.draftScope;
      const sameClassroom = this.context.sessionId === next.sessionId && oldScope && newScope &&
        (oldScope.goalId === newScope.goalId || this.heldDraft?.goalId === newScope.goalId || (!newScope.goalId && !newScope.taskId));
      const nextDraftKey = newScope ? JSON.stringify([next.sessionId, newScope.goalId, newScope.taskId, newScope.skillId]) : next.key;
      // 自动换题不等于用户放弃编辑；跨任务保留来源，只有显式采用才向新任务发送。
      if (this.heldDraft && (!sameClassroom || nextDraftKey === this.heldDraft.key)) this.heldDraft = null;
      else if (!this.heldDraft && sameClassroom && this.input.value.trim() && nextDraftKey !== this.taskDraftKey)
        this.heldDraft = {key: this.taskDraftKey, title: this.context.taskTitle, goalId: oldScope.goalId};
      this.requestVersion++;
      window.clearTimeout(this.pollTimer);
      this.loadController?.abort();
      // 迟到回复仍归属原服务端作用域；本地取消阅读流，不能把它附到新任务。
      this.streamController?.abort();
      this.context = next;
      this.snapshot = null;
      this.loading = false;
      this.generating = false;
      this.stopping = false;
      this.error = "";
      this.input.value = this.drafts.get(this.draftKey) ?? "";
      this.render();
      if (this.opened) void this.load();
      if (focused && this.opened) this.input.focus({preventScroll: true});
    } else {
      const changed = this.context.available !== next.available || this.context.canReturn !== next.canReturn || this.context.taskTitle !== next.taskTitle;
      this.context = next;
      if (changed) this.render();
      else this.syncControls();
    }
  }

  setOpen(open: boolean): void {
    if (this.opened === open) return;
    if (!open) {this.animationDraft=null;this.figureDraft=null;}
    if (open) this.focusedBeforeOpen = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    else this.scrollPositions.set(this.draftKey, this.messages.scrollTop);
    this.opened = open;
    this.syncLayout();
    this.syncControls();
    this.onChange();
    if (open) {
      if (!this.snapshot && !this.loading) void this.load();
      this.input.focus({ preventScroll: true });
      this.messages.scrollTop = this.scrollPositions.get(this.draftKey) ?? this.messages.scrollHeight;
    } else {
      const previous = this.focusedBeforeOpen;
      if (previous?.isConnected && !previous.closest("[inert], [hidden]")) previous.focus({ preventScroll: true });
      else this.entry.focus({ preventScroll: true });
    }
  }

  private syncLayout(): void {
    // 按课堂实际空间而非倍率/屏幕型号选布局；宽度偏好不能挤掉老师的最小阅读区。
    this.layout?.setOpen(this.opened);
    const parent = this.sideBySide ? this.dock : this.viewport;
    if (this.panel.parentElement !== parent) parent.append(this.panel);
    document.body.classList.toggle("assistant-open", this.opened);
    this.entry.setAttribute("aria-expanded", String(this.opened));
    this.entry.classList.toggle("active", this.opened);
    this.panel.hidden = !this.opened;
    this.dock.hidden = !this.opened || !this.sideBySide;
    this.supplements.hidden = this.opened && this.sideBySide;
    this.backdrop.hidden = !this.opened || this.sideBySide;
    this.panel.inert = !this.opened;
  }

  private async load(preserveError = false): Promise<void> {
    if (!this.context.sessionId || this.generating) { this.render(); return; }
    const version = ++this.requestVersion;
    this.loadController?.abort();
    const controller = this.loadController = new AbortController();
    this.loading = true; if (!preserveError) this.error = ""; this.render();
    try {
      const response = await fetch(`/api/web/sessions/${encodeURIComponent(this.context.sessionId)}/assistant`, { signal: controller.signal });
      const payload = await response.json() as AssistantSnapshot & { detail?: string; message?: string };
      if (!response.ok) throw new Error(payload.detail ?? payload.message ?? `HTTP ${response.status}`);
      if (version !== this.requestVersion) return;
      const previousKey = this.draftKey;
      this.snapshot = payload;
      if (this.draftKey !== previousKey) this.input.value = this.drafts.get(this.draftKey) ?? this.drafts.get(previousKey) ?? "";
      this.renderMessages();
      this.messages.scrollTop = this.scrollPositions.get(this.draftKey) ?? this.messages.scrollHeight;
    } catch (error) {
      if (version === this.requestVersion && !controller.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (version === this.requestVersion) {
        this.loading = false; this.render(); this.onChange();
        window.clearTimeout(this.pollTimer);
        // 刷新后的生成没有浏览器原流；有限轮询恢复实际保存的问答与互斥状态。
        if ((this.snapshot?.busy || this.snapshot?.teacher_busy) && !this.generating) this.pollTimer = window.setTimeout(() => void this.load(), 1500);
      }
    }
  }

  private renderMessages(): void {
    const items = this.snapshot?.messages ?? [];
    if (!items.length) {
      this.messages.innerHTML = `<div class="assistant-empty"><h3>${this.context.available ? "把这里没懂的地方问清楚" : "开始当前教学后，可在这里答疑"}</h3><p>${this.context.available ? "可以问概念、请求提示，或贴出自己的思路。当前题目和相关讲解会随问题带给助教。" : "助教会围绕正在学习的任务，帮助你理解讲解和资料。"}</p>${this.context.canReturn ? '<button class="text-button assistant-return" type="button" data-return-current>切回当前任务</button>' : this.context.available ? '<div class="assistant-suggestions"><button type="button" data-suggestion="请再解释一下这个概念：">问概念</button><button type="button" data-suggestion="给我一个提示，先不要告诉我答案。">要提示</button><button type="button" data-suggestion="我目前的思路是：">贴思路</button></div>' : ""}</div>`;
      return;
    }
    this.messages.innerHTML = items.map(message => `<article class="assistant-message ${message.role}" data-assistant-message="${escapeHtml(message.id)}"><div class="assistant-message-label">${message.role === "user" ? "你" : "助教"}</div><div class="message-content" data-note-message="${escapeHtml(message.id)}" data-note-session="${escapeHtml(this.snapshot?.scope?.mainSessionId ?? this.context.sessionId ?? "")}" data-note-channel="assistant" ${this.busy ? 'data-streaming="true"' : ""}>${renderMarkdown(message.content)}</div></article>`).join("")
      + (this.context.canReturn ? '<button class="text-button assistant-return" type="button" data-return-current>切回当前任务</button>' : "");
  }

  private render(): void {
    this.source.textContent = this.context.taskTitle || "当前教学任务";
    this.source.title = this.source.textContent;
    this.notice.textContent = this.snapshot?.notice ?? "老师会参考这里的问答，了解你需要的帮助。";
    this.notice.hidden = Boolean(this.snapshot?.messages.length);
    this.renderMessages();
    this.syncControls();
  }

  private syncControls(): void {
    const unavailable = !this.context.sessionId || !this.context.available || this.snapshot?.available === false;
    const teacherBusy = this.context.teacherBusy || Boolean(this.snapshot?.teacher_busy);
    // 无Task/目标收尾期间仍让已有草稿可聚焦、选择和复制；只读不授予助教发送权限。
    this.input.disabled = unavailable && !this.input.value.trim();
    this.input.readOnly = unavailable;
    this.send.disabled = unavailable || this.loading || this.busy || teacherBusy || Boolean(this.heldDraft) || !this.input.value.trim();
    this.send.hidden = this.busy;
    this.stop.hidden = !this.busy;
    this.stop.disabled = this.stopping;
    this.entry.title = unavailable ? "开始当前教学后，可向助教提问" : this.opened ? "收起助教，回到教学" : "展开助教，问清当前疑惑";
    this.input.placeholder = unavailable ? "当前没有可以答疑的教学任务" : this.animationDraft ? "想问动画的这一步什么？" : "哪一处还没理解？";
    this.status.textContent = this.error || (this.stopping ? "正在停止回复…" : this.loading ? "正在恢复助教问答…" : this.busy ? "助教正在答疑…" : teacherBusy ? "老师回复完成后，可以发送给助教。" : unavailable ? "切回当前学习任务后继续答疑。" : "");
    this.status.classList.toggle("assistant-status-error", Boolean(this.error));
    this.status.setAttribute("role", this.error ? "alert" : "status");
    this.retry.hidden = !this.error;
    this.retry.disabled = this.generating;
    this.entry.setAttribute("data-busy", String(this.busy));
    this.draftRecovery.hidden = !this.heldDraft;
    if (this.heldDraft) {
      this.draftRecovery.replaceChildren(document.createTextNode(`草稿仍属于「${this.heldDraft.title || "上一任务"}」。课堂已切换，发送前请确认用途。`), this.draftAdopt);
      this.draftAdopt.disabled = unavailable || this.loading || this.busy;
    }
  }

  private async submit(): Promise<void> {
    const text = this.input.value.trim();
    if (!text || this.heldDraft || !this.context.available || !this.context.sessionId || this.loading || this.busy || this.context.teacherBusy || this.snapshot?.teacher_busy) return;
    const version = ++this.requestVersion;
    const sid = this.context.sessionId;
    const figure=this.figureDraft?.key===this.context.key?this.figureDraft:null;
    const animation = this.animationDraft?.key === this.context.key ? this.animationDraft : null;
    const controller = this.streamController = new AbortController();
    this.snapshot ??= { available: true, scope: null, messages: [], busy: false };
    let reply: AssistantMessage = { id: `local-assistant-${version}`, role: "assistant", content: "" };
    this.snapshot.messages.push({ id: `local-user-${version}`, role: "user", content: text }, reply);
    this.generating = true; this.error = "";
    this.input.value = ""; this.drafts.set(this.draftKey, "");
    this.render(); this.onChange(); this.messages.scrollTop = this.messages.scrollHeight;
    try {
      await this.beforeSend();
      if (version !== this.requestVersion) return;
      const response = await fetch(`/api/web/sessions/${encodeURIComponent(sid)}/assistant`, { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, ...(animation ? {animation_context: animation.anchor} : {}), ...(figure?{figure_context:figure.anchor}:{}) }) });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({})) as { detail?: string; message?: string };
        throw new Error(body.detail ?? body.message ?? `HTTP ${response.status}`);
      }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      const consume = (line: string) => {
        if (!line.trim() || version !== this.requestVersion) return;
        const event = JSON.parse(line) as { type: string; text?: string; assistant?: AssistantSnapshot; message?: string };
        if (event.type === "text_delta") reply.content += event.text ?? "";
        else if (event.type === "assistant_state" && event.assistant) {
          this.snapshot = event.assistant;
          // 首个服务端状态只有已保存的问题；后续增量必须落在独立的临时回复节点。
          if (this.snapshot.busy) {
            const latest = this.snapshot.messages.at(-1);
            if (latest?.role === "assistant") reply = latest;
            else this.snapshot.messages.push(reply);
          }
        }
        else if (event.type === "error") this.error = event.message ?? "助教回复中断，请稍后重试。";
        const atBottom = this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight < 80;
        this.renderMessages(); this.syncControls();
        if (atBottom) this.messages.scrollTop = this.messages.scrollHeight;
        this.onChange();
      };
      while (true) {
        const { value, done } = await reader.read();
        if (version !== this.requestVersion) { await reader.cancel(); return; }
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        lines.forEach(consume);
        if (done) { consume(buffer); break; }
      }
    } catch (error) {
      if (version === this.requestVersion && !controller.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (version === this.requestVersion) {
        if (!this.error && this.figureDraft===figure) this.figureDraft=null;
        if (!this.error && this.animationDraft === animation) this.animationDraft = null;
        this.generating = false;
        if (this.snapshot) this.snapshot.busy = false;
        this.stopping = false;
        if (!reply.content && this.snapshot) this.snapshot.messages = this.snapshot.messages.filter(message => message !== reply);
        this.render(); this.onChange();
        // 断线或停止后回读服务端记录，草稿不被失败回复覆盖。
        if (this.error) { this.drafts.set(this.draftKey, this.input.value || text); if (!this.input.value) this.input.value = text; this.syncControls(); }
        void this.load(true);
      }
    }
  }

  private async stopGeneration(): Promise<void> {
    if (!this.context.sessionId || !this.busy || this.stopping) return;
    const version = this.requestVersion;
    this.stopping = true; this.syncControls();
    try {
      const response = await fetch(`/api/web/sessions/${encodeURIComponent(this.context.sessionId)}/assistant/stop`, { method: "POST" });
      if (!response.ok) throw new Error("暂时无法停止助教回复，请重试。");
      if (version === this.requestVersion && !this.generating) await this.load();
    } catch (error) { if (version === this.requestVersion) this.error = error instanceof Error ? error.message : String(error); }
    finally { if (version === this.requestVersion) { this.stopping = false; this.syncControls(); } }
  }
}
