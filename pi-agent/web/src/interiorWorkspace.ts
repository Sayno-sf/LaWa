import { plainTextSummary } from "./learningRecordView";

/** Display-only headings. The full saved goal stays visible in the expanded record. */
export function goalDisplayTitle(description: string): string {
  // 优先明确的标题/书名；旧目标只有长描述时，去掉时间和任务开场白，不改保存的目标。
  const heading = description.match(/(?:^|\n)\s*#{1,6}\s+([^\n#]+)/u)?.[1];
  const plain = plainTextSummary(description, 1000);
  const book = plain.match(/《([^》]+)》/u)?.[1];
  const sourceTopic = plain.match(/^(?:以|学习|阅读)?\s*(.{1,40}?)的(?:公开)?源码/u)?.[1];
  let title = heading ? plainTextSummary(heading, 100) : sourceTopic ? `${sourceTopic.trim()} 源码学习` : book?.split(/[：:]/u)[0] || plain.replace(/[（(][^）)]*[）)]/gu, "").split(/[，,。；;：:\n]/u)[0]?.trim() || plain;
  if (!book && !heading && !sourceTopic) {
    title = title.replace(/^(?:(?:我(?:想要|希望|需要|想|要)?|希望|请帮我|请|在短时间内|在约?[^，,。；;]{1,8}(?:小时|分钟|天|周)内?|从近零基础|系统地?|以概览深度|概览|深度了解|深入了解|快速|从零开始|学习|学会|了解|理解|掌握|读懂)\s*)+/u, "");
  }
  title = title.replace(/任务$/u, "").trim();
  // 书名后的英文缩写可留下；其余长附注与个人背景放在详情，不进入标题。
  title = title.replace(/[（(](?=[^）)]{14})[^）)]*[）)]/gu, "").trim();
  return plainTextSummary(title || plain, /[\u3400-\u9fff]/u.test(title) ? 22 : 48);
}

export function matchesSearch(text: string, query: string): boolean {
  const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase();
  const haystack = normalize(text);
  return normalize(query).trim().split(/\s+/u).filter(Boolean).every(word => haystack.includes(word));
}

/** Search and settings tabs only manage existing DOM. They never save settings or start teaching. */
export class InteriorWorkspace {
  constructor() {
    document.querySelectorAll<HTMLInputElement>("[data-collection-search]").forEach(input => {
      input.addEventListener("input", () => this.refreshCollections());
    });
    document.querySelector("#library-status-filter")?.addEventListener("change", () => this.refreshCollections());
    const tabs = [...document.querySelectorAll<HTMLButtonElement>("[data-settings-pane]")];
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => this.selectSettings(tab));
      tab.addEventListener("keydown", event => {
        const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
          : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
          : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
        if (next === null) return;
        event.preventDefault(); this.selectSettings(tabs[next]!); tabs[next]!.focus();
      });
    });
    if (tabs[0]) {
      this.selectSettings(tabs[0]);
      document.querySelector("#provider-status-button")?.addEventListener("click", () => this.selectSettings(tabs[0]!));
    }
  }

  private selectSettings(active: HTMLButtonElement): void {
    document.querySelectorAll<HTMLButtonElement>("[data-settings-pane]").forEach(tab => {
      const selected = tab === active;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(tab.dataset.settingsPane!)!;
      panel.hidden = !selected;
      panel.classList.add("settings-pane");
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", tab.id);
      if (selected && panel.tagName === "DETAILS") (panel as HTMLDetailsElement).open = true;
    });
  }

  refreshCollections(): void {
    for (const name of ["library", "notes"] as const) {
      const input = document.querySelector<HTMLInputElement>(`[data-collection-search="${name}"]`);
      const root = document.querySelector(name === "library" ? "#learning-library-content" : "#notes-page");
      if (!root || !input) continue;
      if (name === "library" && (root as HTMLElement).dataset.growthManaged === "true") continue;
      const items = [...root.querySelectorAll<HTMLElement>(name === "library" ? ".learning-project-card" : ".notes-item")];
      const status = document.querySelector<HTMLSelectElement>("#library-status-filter")?.value ?? "all";
      let count = 0;
      for (const item of items) {
        const visible = matchesSearch(item.dataset.searchText ?? item.textContent ?? "", input.value) &&
          (name !== "library" || status === "all" || (status === "current" ? item.dataset.projectStatus === "CURRENT" : item.dataset.projectStatus !== "CURRENT"));
        item.hidden = !visible;
        if (visible) count++;
      }
      root.querySelectorAll<HTMLElement>(".notes-group").forEach(group => {
        group.hidden = ![...group.querySelectorAll<HTMLElement>(".notes-item")].some(item => !item.hidden);
      });
      const otherHeading = root.querySelector<HTMLElement>(".library-group-heading");
      if (otherHeading) otherHeading.hidden = !items.some(item => !item.hidden && item.dataset.projectStatus !== "CURRENT");
      const output = document.getElementById(`${name}-search-count`);
      if (output) output.textContent = items.length ? `${count} ${name === "library" ? "个目标" : "条笔记"}` : "";
      const empty = document.getElementById(`${name}-search-empty`);
      if (empty) empty.hidden = !items.length || count > 0;
    }
  }
}
