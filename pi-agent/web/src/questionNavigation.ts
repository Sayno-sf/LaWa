/** 管理阅读定位，不收集/提交答案，也不触发教师。 */
export class QuestionNavigation {
  private key = "";
  private initialAlignment = false;
  private scheduled = false;
  private readonly row = document.createElement("div");
  private readonly back = document.createElement("button");

  constructor(private readonly messages: HTMLElement, private readonly question: HTMLElement, composerWrap: HTMLElement) {
    this.row.className = "question-support-heading";
    this.row.hidden = true;
    const label = document.createElement("label"); label.htmlFor = "message-input"; label.textContent = "与老师对话";
    this.back.id = "return-current-question"; this.back.type = "button"; this.back.textContent = "返回当前题目";
    this.row.append(label, this.back); composerWrap.prepend(this.row);
    this.back.addEventListener("click", () => {
      this.align(); this.updateVisibility();
      this.question.querySelector<HTMLElement>("textarea, input")?.focus({preventScroll:true});
    });
    messages.addEventListener("scroll", () => this.schedule(), {passive:true});
    window.addEventListener("resize", () => this.schedule());
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => this.schedule()).observe(messages);
  }

  update(key: string, enabled: boolean, preservePosition = false): void {
    const next = enabled ? key : "";
    if (next !== this.key) { this.key = next; this.initialAlignment = Boolean(next) && !preservePosition; }
    if (preservePosition) this.initialAlignment = false;
    this.row.hidden = !next;
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    window.requestAnimationFrame(() => {
      this.scheduled = false;
      if (!this.key || !this.messages.getBoundingClientRect().height) return;
      // 只首次对齐新题；异步状态刷新不能抢走回看历史时的位置。
      if (this.initialAlignment && window.innerWidth > 820) { this.align(); this.initialAlignment = false; }
      this.updateVisibility();
    });
  }

  private align(): void {
    this.messages.scrollTop += this.question.getBoundingClientRect().top - this.messages.getBoundingClientRect().top - 24;
  }

  private updateVisibility(): void {
    const viewport = this.messages.getBoundingClientRect(), question = this.question.getBoundingClientRect();
    // 长题下半部仍在屏内，也可能已看不到题首；此时保留显式返回入口。
    this.back.hidden = question.top >= viewport.top - 4 && question.top < viewport.bottom - 48;
  }
}
