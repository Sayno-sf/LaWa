export interface ReadingPosition { key: string | null; offset: number; top: number; following: boolean }
const selector = "[data-reading-key]";

/** 以稳定数据身份保留展开状态；重排或新增记录不能继承相邻条目的开合。 */
export function captureDisclosures(container: HTMLElement): Set<string> {
  return new Set([...container.querySelectorAll<HTMLDetailsElement>("details[open][data-disclosure-key]")]
    .map(node => node.dataset.disclosureKey!));
}

export function restoreDisclosures(container: HTMLElement, expanded: ReadonlySet<string>): void {
  container.querySelectorAll<HTMLDetailsElement>("details[data-disclosure-key]").forEach(node => {
    node.open = expanded.has(node.dataset.disclosureKey!);
  });
}

/** 用内容身份和视口内偏移恢复阅读；末尾跟随只在更新前确实贴底时发生。 */
export function captureReadingPosition(container: HTMLElement): ReadingPosition {
  const bounds = container.getBoundingClientRect();
  const anchor = [...container.querySelectorAll<HTMLElement>(selector)]
    .find(node => node.getBoundingClientRect().bottom > bounds.top + 4);
  return {
    key: anchor?.dataset.readingKey ?? null,
    offset: anchor ? anchor.getBoundingClientRect().top - bounds.top : 0,
    top: container.scrollTop,
    following: container.scrollHeight - container.clientHeight - container.scrollTop <= 64,
  };
}

export function restoreReadingPosition(container: HTMLElement, position: ReadingPosition, follow = false): void {
  if (follow && position.following) { container.scrollTop = container.scrollHeight; return; }
  const anchor = position.key ? [...container.querySelectorAll<HTMLElement>(selector)]
    .find(node => node.dataset.readingKey === position.key) : null;
  if (anchor) container.scrollTop += anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - position.offset;
  else container.scrollTop = position.top;
}

/** 面板开关／拖宽导致换行时保留原可见内容，而不是保留失效的像素坐标。 */
export class ReadingWidthAnchor {
  private width: number;
  private position: ReadingPosition;
  constructor(private readonly container: HTMLElement) {
    this.width = container.clientWidth;
    this.position = captureReadingPosition(container);
    container.addEventListener("scroll", () => {
      if (container.clientWidth === this.width) this.position = captureReadingPosition(container);
    }, {passive:true});
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => {
      const width = container.clientWidth;
      if (!width) return;
      if (this.width && this.width !== width && this.position.key) restoreReadingPosition(container, this.position);
      this.width = width;
      this.position = captureReadingPosition(container);
    }).observe(container);
  }
}
