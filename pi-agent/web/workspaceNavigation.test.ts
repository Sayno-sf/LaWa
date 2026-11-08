import {test} from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {WorkspaceNavigation, type WorkspaceView} from "./src/workspaceNavigation.js";

const views: WorkspaceView[] = ["learn", "library", "notes", "teaching", "settings", "conversations", "materials"];
function fixture(onChange: (view: WorkspaceView) => void | Promise<unknown>) {
  const dom = new JSDOM(`<main id="main-content">${views.map(view => `<section tabindex="-1" data-workspace-view="${view}" ${view === "learn" ? "" : "hidden"}>${view === "learn" ? '<div id="messages"></div>' : ""}</section>`).join("")}</main>`, {url:"https://workspace.test/#learn"});
  const names = ["window", "document", "location", "history", "MouseEvent"] as const;
  const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  names.forEach(name => Object.defineProperty(globalThis, name, {value:dom.window[name], configurable:true, writable:true}));
  const frames = new Map<number, FrameRequestCallback>();
  let frame = 0;
  dom.window.requestAnimationFrame = callback => { frames.set(++frame, callback); return frame; };
  dom.window.cancelAnimationFrame = id => { frames.delete(id); };
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); };
  const main = dom.window.document.querySelector<HTMLElement>("main")!;
  let top = 0, limit = 2000;
  Object.defineProperty(main, "scrollTop", {get:()=>top, set:value=>{top=Math.min(limit, Math.max(0,value));}});
  const nav = new WorkspaceNavigation(onChange);
  nav.start(); flush();
  return {dom, main, nav, flush, limit(value: number) {limit=value;}, close() {
    dom.window.close();
    names.forEach((name,index) => { const descriptor=previous[index]; if (descriptor) Object.defineProperty(globalThis,name,descriptor); else Reflect.deleteProperty(globalThis,name); });
  }};
}

test("all seven pages start at the top and restore their own scroll and the retained classroom", () => {
  const f = fixture(() => undefined);
  try {
    const messages = f.dom.window.document.querySelector<HTMLElement>("#messages")!;
    messages.scrollTop = 420;
    views.forEach((view,index) => { f.nav.navigate(view); f.flush(); assert.equal(f.main.scrollTop,0); f.main.scrollTop=(index+1)*100; });
    views.forEach((view,index) => { f.nav.navigate(view); f.flush(); assert.equal(f.main.scrollTop,(index+1)*100); });
    f.nav.navigate("learn"); f.flush();
    assert.equal(messages.scrollTop,420);
    assert.equal(f.dom.window.document.querySelectorAll("[data-workspace-view]:not([hidden])").length,1);
  } finally { f.close(); }
});

test("a returned page restores after asynchronous content grows beyond its placeholder", async () => {
  let finish: (() => void) | undefined;
  let delayed = false;
  const f = fixture(view => view === "library" && delayed ? new Promise<void>(resolve=>{finish=resolve;}) : undefined);
  try {
    f.nav.navigate("library"); f.flush(); f.main.scrollTop=900;
    f.nav.navigate("notes"); f.flush(); f.main.scrollTop=360;
    delayed=true; f.limit(120); f.nav.navigate("library"); f.flush();
    assert.equal(f.main.scrollTop,120);
    f.limit(2000); finish!(); await Promise.resolve();
    assert.equal(f.main.scrollTop,900);
    f.nav.navigate("notes"); f.flush(); assert.equal(f.main.scrollTop,360);
  } finally { f.close(); }
});

test("late page loads cannot override user scrolling, explicit card positioning, or a newer navigation", async () => {
  const pending: (()=>void)[] = [];
  const f = fixture(view => view === "library" ? new Promise<void>(resolve=>pending.push(resolve)) : undefined);
  try {
    f.nav.navigate("library"); f.flush();
    f.main.dispatchEvent(new f.dom.window.WheelEvent("wheel", {bubbles:true})); f.main.scrollTop=280;
    pending.shift()!(); await Promise.resolve(); assert.equal(f.main.scrollTop,280);
    f.nav.navigate("notes"); f.flush(); f.nav.navigate("library");
    f.nav.afterRestore(()=>{f.main.scrollTop=640;}); f.flush();
    pending.shift()!(); await Promise.resolve(); assert.equal(f.main.scrollTop,640);
    f.nav.navigate("notes"); f.flush(); f.nav.navigate("library");
    f.nav.navigate("settings"); f.flush(); f.main.scrollTop=150;
    pending.shift()!(); await Promise.resolve(); assert.equal(f.main.scrollTop,150);
    assert.equal(f.nav.current,"settings");
  } finally { f.close(); }
});
