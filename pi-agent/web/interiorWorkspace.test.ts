import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { InteriorWorkspace, goalDisplayTitle, matchesSearch } from "./src/interiorWorkspace.js";

function fixture() {
  const dom = new JSDOM(`<input data-collection-search="library"><select id="library-status-filter"><option value="all">全部</option><option value="current">当前</option><option value="other">其他</option></select><span id="library-search-count"></span><p id="library-search-empty" hidden></p><div id="learning-library-content"><details class="learning-project-card" data-project-status="CURRENT" data-search-text="深度学习 PyTorch 张量"></details><details class="learning-project-card" data-project-status="ARCHIVED" data-search-text="TypeScript 函数"></details></div><input data-collection-search="notes"><span id="notes-search-count"></span><p id="notes-search-empty" hidden></p><section id="notes-page"><div id="notes-content"><section class="notes-group"><article class="notes-item" data-search-text="张量 广播"><textarea>我的未保存笔记</textarea></article></section><section class="notes-group"><article class="notes-item" data-search-text="函数 return"></article></section></div></section><button id="model-tab" data-settings-pane="model"></button><button id="speech-tab" data-settings-pane="speech"></button><button id="retrieval-tab" data-settings-pane="retrieval"></button><form id="model"><input value="原配置"></form><details id="speech"></details><details id="retrieval"></details>`);
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  const view = new InteriorWorkspace(); view.refreshCollections();
  return { dom, doc: dom.window.document, view };
}

test("display titles preserve full input when there is no separator; search accepts width and case variants", () => {
  assert.equal(goalDisplayTitle("学习《动手学深度学习》，理解原理"), "动手学深度学习");
  assert.equal(goalDisplayTitle("TypeScript"), "TypeScript");
  assert.equal(goalDisplayTitle("在短时间内以概览深度了解蚁群算法（ACO）：基本原理（信息素、概率选路），以及应用。"), "蚁群算法");
  assert.equal(goalDisplayTitle("以 Pi Agent 的公开源码（仓库：https://github.com/example/pi）为主要学习对象，理解内部机制。"), "Pi Agent 源码学习");
  assert.equal(goalDisplayTitle("# Pi Agent 源码学习任务\n## 我的学习背景\n我想理解事件循环。"), "Pi Agent 源码学习");
  assert.equal(goalDisplayTitle("从近零基础系统学习强化学习，方向聚焦深度强化学习。"), "强化学习");
  assert.equal(matchesSearch("深度学习 PyTorch 张量", "ＰＹＴＯＲＣＨ 张量"), true);
  assert.equal(matchesSearch("深度学习 PyTorch 张量", "pytorch 函数"), false);
});

test("library text and current status compose; no matches recovers after clearing", () => {
  const { dom, doc } = fixture();
  try {
    const input = doc.querySelector<HTMLInputElement>('[data-collection-search="library"]')!;
    input.value = "typescript"; input.dispatchEvent(new dom.window.Event("input"));
    assert.equal(doc.querySelector("#library-search-count")!.textContent, "1 个目标");
    const filter = doc.querySelector<HTMLSelectElement>("#library-status-filter")!;
    filter.value = "current"; filter.dispatchEvent(new dom.window.Event("change"));
    assert.equal(doc.querySelector<HTMLElement>("#library-search-empty")!.hidden, false);
    input.value = ""; input.dispatchEvent(new dom.window.Event("input"));
    assert.equal(doc.querySelector("#library-search-count")!.textContent, "1 个目标");
    assert.equal(doc.querySelector<HTMLElement>('[data-project-status="CURRENT"]')!.hidden, false);
    assert.equal(doc.querySelector<HTMLElement>("#library-search-empty")!.hidden, true);
  } finally { dom.window.close(); }
});

test("notes filtering hides empty groups without discarding an unsaved editor", () => {
  const { dom, doc } = fixture();
  try {
    const textarea = doc.querySelector("textarea")!;
    const input = doc.querySelector<HTMLInputElement>('[data-collection-search="notes"]')!;
    input.value = "return"; input.dispatchEvent(new dom.window.Event("input"));
    assert.equal(doc.querySelector<HTMLElement>(".notes-group")!.hidden, true);
    input.value = ""; input.dispatchEvent(new dom.window.Event("input"));
    assert.equal(doc.querySelector("textarea"), textarea);
    assert.equal(textarea.value, "我的未保存笔记");
    assert.equal(doc.querySelector("#notes-search-count")!.textContent, "2 条笔记");
  } finally { dom.window.close(); }
});

test("settings tabs preserve drafts and support keyboard selection with matching panels", () => {
  const { dom, doc } = fixture();
  try {
    const model = doc.querySelector<HTMLFormElement>("#model")!;
    model.querySelector("input")!.value = "未保存的配置名称";
    doc.querySelector<HTMLButtonElement>("#speech-tab")!.click();
    assert.equal(model.hidden, true);
    assert.equal(doc.querySelector<HTMLDetailsElement>("#speech")!.open, true);
    doc.querySelector("#speech-tab")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "End" }));
    assert.equal(doc.activeElement?.id, "retrieval-tab");
    assert.equal(doc.querySelector("#retrieval-tab")!.getAttribute("aria-selected"), "true");
    doc.querySelector<HTMLButtonElement>("#model-tab")!.click();
    assert.equal(model.hidden, false);
    assert.equal(model.querySelector("input")!.value, "未保存的配置名称");
    assert.equal(doc.querySelector("#retrieval-tab")!.getAttribute("tabindex"), "-1");
  } finally { dom.window.close(); }
});


test("chat excerpts outside the card container share notes search and counts", () => {
  const {dom,doc,view}=fixture();
  try {
    const excerpt=doc.createElement("article");excerpt.className="notes-item";excerpt.dataset.searchText="聊天摘录 缩进";
    doc.querySelector("#notes-content")!.before(excerpt);
    const input=doc.querySelector<HTMLInputElement>('[data-collection-search="notes"]')!;
    input.value="缩进";view.refreshCollections();
    assert.equal(excerpt.hidden,false);assert.equal(doc.querySelector("#notes-search-count")!.textContent,"1 条笔记");
    input.value="不存在";view.refreshCollections();assert.equal(excerpt.hidden,true);
  }finally{dom.window.close();}
});
