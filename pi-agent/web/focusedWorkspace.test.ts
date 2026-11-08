import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { FocusedWorkspace } from "./src/focusedWorkspace.js";
import { AssistantLayout } from "./src/assistantLayout.js";

function fixture() {
  const dom = new JSDOM(`<nav id="sidebar"><div class="conversation-library"></div></nav><section id="learning-workspace"><div class="dashboard-grid" style="display:grid;column-gap:0px"><aside class="route-card"><ol class="skill-route"></ol></aside><main><header class="learning-stage-header"><div class="learning-content-tools"><div class="learning-view-tabs"><button id="assistant-entry">助教</button></div></div><div id="study-time-strip"></div><span class="connection-pill"></span></header></main><aside class="context-column"><section id="skill-card"><div class="focused-skill-details"></div></section><section class="evidence-card"><button>原记录</button></section></aside><aside id="assistant-dock"></aside></div></section>`, { url: "http://localhost" });
  const media = { matches: true, addEventListener(_name: string, callback: () => void) { this.change = callback; }, change() {} };
  Object.assign(dom.window, { matchMedia: () => media });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, matchMedia: () => media, getComputedStyle: dom.window.getComputedStyle, localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement })) Object.defineProperty(globalThis, key, { value, configurable: true });
  return { dom, media, document: dom.window.document };
}

test("layout reuses the original route and evidence nodes, including listeners, after skill rerender", () => {
  const { dom, document } = fixture();
  try {
    const route = document.querySelector(".route-card")!;
    const evidence = document.querySelector(".evidence-card")!;
    let clicks = 0;
    evidence.addEventListener("click", () => clicks++);
    const layout = new FocusedWorkspace();
    assert.equal(route.parentElement?.id, "route-directory");
    document.querySelector("#skill-card")!.innerHTML = '<div class="focused-skill-details"></div>';
    layout.sync();
    assert.equal(document.querySelector(".focused-skill-details .evidence-card"), evidence);
    evidence.querySelector("button")!.click();
    assert.equal(clicks, 1);
    assert.equal(document.querySelectorAll(".route-card").length, 1);
  } finally { dom.window.close(); }
});

test("route expands, reduces to ticks and hides independently without replacing its original nodes", () => {
  const {dom, document} = fixture();
  try {
    const route = document.querySelector<HTMLElement>(".route-card")!;
    route.querySelector("ol")!.innerHTML = '<li class="learning-route-stage learning-route-merged is-current-stage"><button class="learning-route-skill"><span class="learning-route-skill-copy"><strong>函数阅读</strong></span></button></li><li class="learning-route-stage learning-route-unassigned"><strong class="learning-route-stage-name">当前学习知识点</strong></li>';
    const layout = new FocusedWorkspace();
    const workspace = document.querySelector<HTMLElement>("#learning-workspace")!;
    const toggle = document.querySelector<HTMLButtonElement>("#route-toggle")!;
    assert.equal(workspace.dataset.routeView, "rail");
    assert.equal(document.querySelector("#sidebar .route-card"), null);
    assert.match(document.querySelector(".route-tick")!.getAttribute("aria-label")!, /函数阅读.*正在学习/);
    assert.match(document.querySelectorAll(".route-tick")[1]!.getAttribute("aria-label")!, /^未归入路线的知识点/);
    assert.equal(document.querySelectorAll(".route-tick.is-mastered").length, 0);
    toggle.click();
    assert.equal(workspace.dataset.routeView, "expanded");
    document.querySelector<HTMLButtonElement>('[data-route-mode="rail"]')!.click();
    assert.equal(workspace.dataset.routeView, "rail");
    document.querySelector<HTMLButtonElement>('[data-route-mode="hidden"]')!.click();
    assert.equal(workspace.dataset.routeView, "hidden");
    assert.equal(localStorage.getItem("learn-anything:route-view:v1"), "hidden");
    document.body.classList.add("sidebar-collapsed"); layout.sync();
    assert.equal(workspace.dataset.routeView, "hidden");
    toggle.click();
    assert.equal(document.querySelector("#route-directory .route-card"), route);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {key:"Escape"}));
    assert.equal(workspace.dataset.routeView, "rail");
    assert.equal(document.activeElement, toggle);
  } finally {dom.window.close();}
});

test("crossing the existing shell boundary restores nodes to their original parents", () => {
  const { dom, document, media } = fixture();
  try {
    const route = document.querySelector(".route-card")!;
    const skill = document.querySelector("#skill-card")!;
    const routeHome = route.parentElement;
    const skillHome = skill.parentElement;
    new FocusedWorkspace();
    media.matches = false; media.change();
    assert.equal(route.parentElement, routeHome);
    assert.equal(skill.parentElement, skillHome);
    assert.equal(document.querySelector("#assistant-entry")!.parentElement?.className, "learning-view-tabs");
    assert.equal(document.querySelector(".evidence-card")!.parentElement, skillHome);
  } finally { dom.window.close(); }
});

test("assistant uses the released route space, preserves teacher width, and never opens from resizing alone", () => {
  const { dom, document } = fixture();
  try {
    new FocusedWorkspace();
    const grid = document.querySelector<HTMLElement>(".dashboard-grid")!;
    let width = 1050;
    Object.defineProperty(grid, "clientWidth", { get: () => width });
    const layout = new AssistantLayout(grid, document.querySelector("#assistant-dock")!, () => undefined);
    assert.equal(layout.sideBySide, true);
    assert.equal(document.body.classList.contains("assistant-side-by-side"), false);
    layout.setOpen(true);
    assert.equal(document.body.classList.contains("assistant-side-by-side"), true);
    width = 950; layout.setOpen(true);
    assert.equal(layout.sideBySide, false);
    width = 1050; layout.setOpen(false);
    assert.equal(document.body.classList.contains("assistant-side-by-side"), false);
  } finally { dom.window.close(); }
});


test("assistant temporary collapse restores expanded route without overriding an explicit hide", () => {
  const {dom,document} = fixture();
  try {
    const layout = new FocusedWorkspace();
    const toggle = document.querySelector<HTMLButtonElement>("#route-toggle")!;
    const workspace = document.querySelector<HTMLElement>("#learning-workspace")!;
    toggle.click();
    layout.setAssistantOpen(true);
    assert.equal(workspace.dataset.routeView,"rail");
    assert.equal(localStorage.getItem("learn-anything:route-view:v1"),"expanded");
    layout.setAssistantOpen(false);
    assert.equal(workspace.dataset.routeView,"expanded");
    layout.setAssistantOpen(true);
    document.querySelector<HTMLButtonElement>(".route-rail-hide")!.click();
    layout.setAssistantOpen(false);
    assert.equal(workspace.dataset.routeView,"hidden");
    assert.equal(localStorage.getItem("learn-anything:route-view:v1"),"hidden");
  } finally {dom.window.close();}
});
