/** 仅跟踪当前表单的保存状态，不保存配置、不触发请求，也不在浏览器持久化字段。 */
export class FormSaveState {
  private saved = "";
  private initialMessage: string | undefined;
  private ready = false;
  private locked = new Map<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement, boolean>();
  busy = false;
  constructor(private readonly form: HTMLFormElement, private readonly output: HTMLElement) {
    output.classList.add("settings-save-status");
    output.setAttribute("role", "status");
    output.setAttribute("aria-live", "polite");
    form.addEventListener("input", () => this.changed());
    form.addEventListener("change", () => this.changed());
  }
  private fingerprint(): string {
    return JSON.stringify([...this.form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea")]
      .map(field => [field.name || field.id, field.type === "checkbox" ? (field as HTMLInputElement).checked : field.value]));
  }
  markClean(message = "已保存", state: "saved" | "initial" = "saved"): void {
    this.ready = true;
    this.saved = this.fingerprint();
    this.initialMessage = state === "initial" ? message : undefined;
    this.show(state, message);
  }
  private changed(): void {
    if (!this.ready || this.busy) return;
    if (this.fingerprint() !== this.saved) this.show("dirty", "有未保存的修改 · 保存后生效");
    else if (this.initialMessage !== undefined) this.show("initial", this.initialMessage);
    else this.show("saved", "已保存");
  }
  begin(): boolean {
    if (this.busy) return false;
    this.busy = true;
    this.form.setAttribute("aria-busy", "true");
    this.form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>("input, select, textarea, button[type=submit]").forEach(field => {
      this.locked.set(field, field.disabled); field.disabled = true;
    });
    this.show("saving", "正在保存…");
    return true;
  }
  success(message = "已保存"): void { this.unlock(); this.markClean(message); }
  error(message: string): void { this.unlock(); this.show("error", message); }
  private unlock(): void {
    this.busy = false;
    this.form.removeAttribute("aria-busy");
    this.locked.forEach((disabled, field) => { field.disabled = disabled; });
    this.locked.clear();
  }
  private show(state: string, message: string): void {
    this.output.dataset.saveState = state;
    this.output.textContent = message;
  }
}
