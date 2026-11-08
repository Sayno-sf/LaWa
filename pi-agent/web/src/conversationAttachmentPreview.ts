import {renderMarkdown} from "./markdown";
import "./conversationAttachmentPreview.css";

type Reference = {id: string; sessionId: string; entryId: string};
/** 原对话授权接口的原位只读预览；不切工作区、不改变资料用途或学习现场。 */
export class ConversationAttachmentPreview {
  readonly node = document.createElement("section");
  private reference: Reference | null = null;
  private generation = 0;
  private page = 1;
  private pages = 1;
  private format = "";
  private name = "附件";
  private controller?: AbortController;
  private container?: HTMLElement;
  get opened(): boolean { return this.reference !== null; }
  constructor(private readonly url: (ref: Reference, path?: string, params?: Record<string, string>) => string) {
    this.node.className = "conversation-attachment-preview";
    this.node.setAttribute("aria-label", "附件内容预览");
    this.node.addEventListener("click", event => {
      const action = (event.target as Element).closest<HTMLButtonElement>("button[data-preview-action]")?.dataset.previewAction;
      if (action === "close") this.close(true);
      if (action === "previous" && this.page > 1) { this.page--; void this.loadPage(); }
      if (action === "next" && this.page < this.pages) { this.page++; void this.loadPage(); }
    });
  }
  close(restoreFocus = false): void {
    if (restoreFocus && this.reference) this.container?.querySelector<HTMLElement>(`[data-conversation-attachment="${CSS.escape(this.reference.id)}"][data-attachment-entry="${CSS.escape(this.reference.entryId)}"]`)?.focus({preventScroll: true});
    this.controller?.abort(); this.generation++; this.reference = null; this.node.remove();
  }
  mount(container: HTMLElement): void {
    this.container = container;
    const ref = this.reference;
    if (!ref) return;
    const anchor = container.querySelector<HTMLElement>(`[data-conversation-attachment="${CSS.escape(ref.id)}"][data-attachment-entry="${CSS.escape(ref.entryId)}"]`);
    if (!anchor) { this.close(); return; }
    anchor.closest(".message-attachments")?.after(this.node);
  }
  async open(ref: Reference, container: HTMLElement): Promise<void> {
    if (this.reference?.id === ref.id && this.reference.entryId === ref.entryId && this.reference.sessionId === ref.sessionId) { this.close(); return; }
    this.close(); this.reference = ref; this.page = 1; this.name = "附件";
    this.controller = new AbortController(); const generation = ++this.generation;
    this.shell("正在读取附件……"); this.mount(container);
    try {
      const response = await fetch(this.url(ref, "/metadata"), {signal: this.controller.signal});
      if (!response.ok) throw new Error("附件已删除或暂时无法读取。");
      const meta = await response.json(); if (generation !== this.generation) return;
      this.name = typeof meta.name === "string" ? meta.name : "附件";
      this.format = String(meta.format ?? "");
      this.pages = Number.isSafeInteger(meta.unit_count) && meta.unit_count > 0 ? meta.unit_count : 1;
      await this.loadPage();
    } catch (error) {
      if (generation === this.generation) this.shell(error instanceof Error ? error.message : "附件暂时无法读取。");
    }
  }
  private shell(status: string): HTMLElement {
    this.node.innerHTML = `<header><strong></strong><button type="button" class="ghost-button" data-preview-action="close" aria-label="关闭附件预览">关闭预览</button></header><p class="attachment-preview-status" role="status"></p><div class="attachment-preview-content"></div><nav class="attachment-preview-pages" aria-label="附件翻页" hidden><button type="button" class="ghost-button" data-preview-action="previous">上一页</button><span></span><button type="button" class="ghost-button" data-preview-action="next">下一页</button></nav>`;
    this.node.querySelector("strong")!.textContent = this.name;
    this.node.querySelector("[role=status]")!.textContent = status;
    return this.node.querySelector<HTMLElement>(".attachment-preview-content")!;
  }
  private async loadPage(): Promise<void> {
    const ref = this.reference; if (!ref) return;
    const generation = ++this.generation, body = this.node.querySelector<HTMLElement>(".attachment-preview-content") ?? this.shell("正在读取附件……");
    this.node.querySelector("strong")!.textContent = this.name;
    this.node.querySelector("[role=status]")!.textContent = "正在读取附件……";
    body.replaceChildren();
    if (this.format === "pdf" || /^(png|jpg|jpeg|webp|tiff)$/.test(this.format)) {
      const image = document.createElement("img"); image.alt = this.name;
      image.addEventListener("load", () => {if (generation === this.generation) this.node.querySelector("[role=status]")!.textContent = this.format === "pdf" ? `第 ${this.page} / ${this.pages} 页` : "原图预览";});
      image.addEventListener("error", () => {if (generation === this.generation) this.node.querySelector("[role=status]")!.textContent = "附件原图暂时无法读取，请关闭后重新打开。";});
      image.src = this.url(ref, this.format === "pdf" ? `/visual/page-${this.page}` : "/visual/image-1"); body.append(image);
      const nav = this.node.querySelector<HTMLElement>("nav")!; nav.hidden = this.format !== "pdf" || this.pages < 2;
      nav.querySelector("span")!.textContent = `${this.page} / ${this.pages}`;
      nav.querySelector<HTMLButtonElement>('[data-preview-action="previous"]')!.disabled = this.page <= 1;
      nav.querySelector<HTMLButtonElement>('[data-preview-action="next"]')!.disabled = this.page >= this.pages;
    } else {
      try {
        const response = await fetch(this.url(ref, "", {start: "1", max_chars: "16000", preview: "1"}), {signal: this.controller?.signal});
        if (!response.ok) throw new Error("附件内容暂时无法读取。");
        const value = await response.json(); if (generation !== this.generation) return;
        body.innerHTML = renderMarkdown(String(value.text ?? ""));
        this.node.querySelector("[role=status]")!.textContent = value.truncated ? "当前显示部分正文预览" : "正文预览";
      } catch (error) { if (generation === this.generation) this.node.querySelector("[role=status]")!.textContent = error instanceof Error ? error.message : "附件暂时无法读取。"; }
    }
    if (generation === this.generation) {if (this.container) this.mount(this.container); this.node.scrollIntoView({block: "nearest"});}
  }
}
