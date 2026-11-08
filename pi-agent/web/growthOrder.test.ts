import assert from "node:assert/strict";
import {after, before, test} from "node:test";
import {fileURLToPath} from "node:url";
import {JSDOM} from "jsdom";
import {createServer, type ViteDevServer} from "vite";

// 加载真实展示模块（含CSS），模拟历史图节点顺序与导入/路线顺序不同。
let vite: ViteDevServer;
before(async () => {vite = await createServer({configFile: false, root: fileURLToPath(new URL("./", import.meta.url)),
  server: {middlewareMode: true}, appType: "custom"});});
after(async () => {await vite?.close();});
const skills = ["later", "first", "middle"].map(id => ({id, name: id, description: "", status: "NOT_STARTED"}));
const ordered = ["first", "middle", "later"];

test("classroom imported topic uses source order even when graph storage differs", async () => {
  const {renderLearningRoute} = await vite.ssrLoadModule("/src/learningRouteView.ts");
  const overview = {goal_profile: {id: "g"}, curriculum_spine: [], active_task: null,
    imported_topics: {goal_id: "g", groups: [{id: "t", name: "导入主题", skill_ids: ordered}]}};
  const dom = new JSDOM(renderLearningRoute(overview, skills));
  try {
    assert.deepEqual([...dom.window.document.querySelectorAll("[data-select-skill]")].map(n => n.getAttribute("data-select-skill")), ordered);
    assert.equal(dom.window.document.querySelector(".is-mastered"), null);
  } finally {dom.window.close();}
});

test("library follows explicit route order then imported topic order without switching classroom", async () => {
  const {GrowthLibraryView} = await vite.ssrLoadModule("/src/growthLibraryView.ts");
  const dom = new JSDOM('<main id="library"></main>', {url: "http://localhost"});
  const previous = {document: globalThis.document, localStorage: globalThis.localStorage, fetch: globalThis.fetch};
  const writes: string[] = [];
  let view: any;
  try {
    dom.window.localStorage.setItem("lawa-growth-library-view", "goals");
    Object.assign(globalThis, {document: dom.window.document, localStorage: dom.window.localStorage,
      fetch: async (url: string, init?: RequestInit) => {
        if (init?.method && init.method !== "GET") writes.push(url);
        return Response.json(url.endsWith("/goals/g")
          ? {topics: [{id: "t", name: "导入主题", skill_ids: ordered}], records: [], samples: []}
          : {points: [], imports: [], supplements: [], jobs: [], recommendations: []});
      }});
    const root = document.getElementById("library")!;
    view = new GrowthLibraryView(root, {records: () => "", newGoal: () => {throw new Error("unexpected goal creation");}, refresh: () => {}});
    await view.load([{status: "ARCHIVED", goal_profile: {id: "g", goal_description: "学习序列模型", desired_outcome: "继续学习"},
      curriculum_spine: [{id: "stage", name: "已确认阶段", description: "", skill_ids: ["stage-first", "stage-last"]}],
      skills: [{id: "stage-last", name: "stage-last", description: "", status: "LEARNING"}, ...skills,
        {id: "stage-first", name: "stage-first", description: "", status: "NOT_STARTED"}]}]);
    root.querySelector<HTMLElement>('[data-open-goal="g"]')!.click();
    for (let i = 0; i < 30 && !root.querySelector('[data-select-growth-skill="middle"]'); i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    // 等待异步主题读取完成，而非刚打开详情时的无归属占位。
    for (let i = 0; i < 30 && !root.textContent?.includes("导入主题"); i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual([...root.querySelectorAll("[data-select-growth-skill]")].map(n => n.getAttribute("data-select-growth-skill")),
      ["stage-first", "stage-last", ...ordered]);
    assert.deepEqual(writes, []);
  } finally {view?.setActive(false); Object.assign(globalThis, previous); dom.window.close();}
});
