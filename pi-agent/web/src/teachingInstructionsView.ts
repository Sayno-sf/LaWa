import "./teachingInstructions.css";

interface InstructionsState {
  text: string;
  updatedAt: string | null;
  maxChars: number;
}

// 教学安排页的「教学偏好」：学习者亲自写给老师的长期偏好。
// 只读写 Node 侧偏好文件；不发聊天消息、不触发教学，也不写学习事实。
export class TeachingInstructionsView {
  readonly node = document.createElement("section");
  private readonly input: HTMLTextAreaElement;
  private readonly status: HTMLElement;
  private readonly count: HTMLElement;
  private readonly saveButton: HTMLButtonElement;
  private saved = "";
  private maxChars = 4000;
  private loading = false;
  private busy = false;
  // 最近一次读取/保存的结果：在输入未变化前保留（失败原因不能被“有未保存的修改”覆盖）。
  private outcome: { text: string; tone: "ok" | "error" | "info" } | null = null;
  private outcomeFor = "";

  constructor(private readonly onChange: () => void = () => {}) {
    this.node.className = "teaching-instructions";
    this.node.setAttribute("aria-label", "教学偏好");
    this.node.innerHTML = `<h3>你的教学偏好</h3>
      <p class="teaching-instructions-help" id="teaching-instructions-help">写给老师的长期教学偏好，例如讲解顺序、例子来源、练习密度。保存后从下一条教学消息开始生效；它不改变学习记录、评分或掌握判定，与老师必须遵守的教学规则冲突时以规则为准。</p>
      <label class="teaching-instructions-field" for="teaching-instructions-input"><span>你希望老师怎样教你</span>
        <textarea id="teaching-instructions-input" rows="3" maxlength="4000" aria-describedby="teaching-instructions-help teaching-instructions-status" placeholder="例如：先用真实代码例子再讲规则；每次只出一道题；遇到报错先让我自己判断，再给提示。"></textarea>
      </label>
      <div class="teaching-instructions-actions">
        <button type="button" class="primary-button" data-action="save" disabled>保存</button>
        <button type="button" class="ghost-button" data-action="clear" title="先清空编辑框；保存后才会删除已保存的偏好">清空</button>
        <span class="teaching-instructions-count" data-count>0 / 4000 字</span>
      </div>
      <p class="teaching-instructions-status" id="teaching-instructions-status" data-status role="status" aria-live="polite"></p>`;
    this.input = this.node.querySelector<HTMLTextAreaElement>("#teaching-instructions-input")!;
    this.status = this.node.querySelector<HTMLElement>("[data-status]")!;
    this.count = this.node.querySelector<HTMLElement>("[data-count]")!;
    this.saveButton = this.node.querySelector<HTMLButtonElement>('[data-action="save"]')!;
    this.input.addEventListener("input", () => this.render());
    this.node.querySelector<HTMLButtonElement>('[data-action="clear"]')!.addEventListener("click", () => {
      this.input.value = "";
      this.input.focus();
      this.render();
    });
    this.saveButton.addEventListener("click", () => void this.save());
    this.render();
  }

  /** 打开「教学安排」页时读取；失败保持输入可用，不阻断页面其它内容。 */
  async load(): Promise<void> {
    if (this.loading || this.busy) return;
    this.loading = true;
    this.render();
    try {
      const response = await fetch("/api/web/teaching-instructions");
      if (!response.ok) throw new Error("教学偏好暂时无法读取，请稍后重试。");
      const state = await response.json() as InstructionsState;
      if (typeof state?.text !== "string") throw new Error("教学偏好暂时无法读取，请稍后重试。");
      this.saved = state.text;
      this.maxChars = Number.isFinite(state.maxChars) && state.maxChars > 0 ? state.maxChars : 4000;
      this.input.maxLength = this.maxChars;
      this.input.value = state.text;
      this.remember(state.text.trim() ? `已保存 · 共 ${this.length()} 字。` : "还没有教学偏好。", "info");
    } catch (error) {
      this.remember(error instanceof Error ? error.message : "教学偏好暂时无法读取，请稍后重试。", "error");
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private length(): number {
    return Array.from(this.input.value.trim()).length;
  }

  private dirty(): boolean {
    return this.input.value.trim() !== this.saved.trim();
  }

  private setStatus(text: string, tone: "ok" | "error" | "info" = "info"): void {
    this.status.textContent = text;
    if (tone === "info") delete this.status.dataset.tone;
    else this.status.dataset.tone = tone;
  }

  private remember(text: string, tone: "ok" | "error" | "info"): void {
    this.outcome = { text, tone };
    this.outcomeFor = this.input.value;
    this.setStatus(text, tone);
  }

  private render(): void {
    const length = this.length();
    this.count.textContent = `${length} / ${this.maxChars} 字`;
    this.saveButton.disabled = this.loading || this.busy || !this.dirty();
    this.node.setAttribute("aria-busy", String(this.busy));
    if (this.loading) this.setStatus("正在读取…");
    else if (this.busy) this.setStatus("正在保存…");
    else if (this.outcome && this.outcomeFor === this.input.value) this.setStatus(this.outcome.text, this.outcome.tone);
    else if (this.dirty()) this.setStatus("有未保存的修改。");
  }

  private async save(): Promise<void> {
    if (this.busy || this.loading || !this.dirty()) return;
    const text = this.input.value;
    if (Array.from(text.trim()).length > this.maxChars) {
      this.setStatus(`最多 ${this.maxChars} 字，请先精简。`, "error");
      return;
    }
    this.busy = true;
    this.render();
    try {
      const response = await fetch("/api/web/teaching-instructions", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
      });
      const value = await response.json().catch(() => ({})) as { detail?: string; text?: string };
      if (!response.ok) throw new Error(typeof value.detail === "string" ? value.detail : "保存失败，请稍后重试。");
      this.saved = typeof value.text === "string" ? value.text : text.trim();
      this.input.value = this.saved;
      this.remember(this.saved ? "已保存，从下一条教学消息开始生效。" : "已清空；从下一条教学消息开始恢复默认教学。", "ok");
      this.onChange();
    } catch (error) {
      this.remember(error instanceof Error ? error.message : "保存失败，请稍后重试。", "error");
    } finally {
      this.busy = false;
      this.render();
    }
  }
}
