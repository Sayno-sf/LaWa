// 固定 SVG 图标库只表达界面动作，不接受用户内容或外部 SVG。
const shapes = {
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  book: '<path d="M12 6c-2-2-5-2.7-9-2v15c4-.7 7 0 9 2 2-2 5-2.7 9-2V4c-4-.7-7 0-9 2Z"/><path d="M12 6v15"/>',
  library: '<rect x="3" y="4" width="4" height="16" rx="1"/><rect x="9" y="4" width="4" height="16" rx="1"/><path d="m16 5 3-1 4 15-3 1Z"/><path d="M3 8h4M9 8h4m8 6-3 1"/>',
  note: '<path d="M13 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-8"/><path d="m10 11 8-8 3 3-8 8-4 1Z"/>',
  settings: '<path d="M9 2h6v3l2 1 2.5-1.5 3 5L20 11v2l2.5 1.5-3 5L17 18l-2 1v3H9v-3l-2-1-2.5 1.5-3-5L4 13v-2l-2.5-1.5 3-5L7 6l2-1Z"/><circle cx="12" cy="12" r="3"/>',
  teaching: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2" fill="white"/><circle cx="16" cy="12" r="2" fill="white"/><circle cx="10" cy="18" r="2" fill="white"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  more: '<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>',
  goal: '<path d="M5 21V4m0 0c5-3 8 3 13 0v9c-5 3-8-3-13 0"/><path d="M17 17h6m-3-3v6"/>',
  conversations: '<path d="M15 16H7l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6a4 4 0 0 1-4 4Z"/><path d="M8 20h9l4 2V10M7 9h8"/>',
  chat: '<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V11a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z"/><path d="M7 10h10M7 14h6"/>',
  cards: '<rect x="5" y="7" width="16" height="14" rx="2"/><path d="M17 3H5a2 2 0 0 0-2 2v12M9 11h8M9 15h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrowUp: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  arrowRight: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  chevronUp: '<path d="m6 15 6-6 6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  panelClose: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m7-12-3 4 3 4"/>',
  panelOpen: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m4-12 3 4-3 4"/>',
  edit: '<path d="m4 16 12-12 4 4L8 20H4Z"/><path d="m13 7 4 4"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  microphone: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>',
  document: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
  route: '<path d="M4 20h4v-4h4v-4h4V8h4"/>',
  records: '<path d="M5 5h14M5 12h14M5 19h8"/><path d="m16 17 2 2 4-4"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
} as const;
export type IconName = keyof typeof shapes;

export function icon(name: IconName, extraClass = ""): string {
  return `<svg class="ui-icon ${extraClass}" data-icon-name="${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${shapes[name]}</svg>`;
}

/** 静态 HTML 和动态模板共用同一组图标，避免字形随系统字体变化。 */
export function mountIcons(): void {
  document.querySelectorAll<HTMLElement>("[data-icon]").forEach((node) => {
    const name = node.dataset.icon ?? "";
    if (Object.hasOwn(shapes, name)) node.outerHTML = icon(name as IconName, node.className);
  });
}
