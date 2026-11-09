import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createGateway } from "./gateway.js";
import { WebSessionStore } from "./sessionStore.js";
import { StudyTimeStore } from "./studyTimeStore.js";
import type { LearningOverview } from "../learningOverviewTool.js";
import type { RetrievalRuntime } from "../retrieval/runtime.js";
import type { ProviderSettingsCoordinator } from "./providerSettings.js";

// 浏览器、Worker、模型和摄像头管线真实运行；虚拟摄像头不访问用户设备，学习事实全部隔离。
const temporary = await mkdtemp(join(tmpdir(), "lawa-study-browser-"));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const artifacts = join(root, "data/qa/study-time"); await mkdir(artifacts, { recursive: true });
let current: LearningOverview = {
  current_goal: "理解异步任务", goal_profile: { id: "camera-goal", goal_description: "理解异步任务" },
  curriculum_spine: [], current_frontier: { focus_skill_id: "async", supporting_skill_ids: [] },
  current_focus: null, skills: [{ id: "async", name: "异步请求", description: "理解任务等待与并发执行的关系。", target_depth: "PRACTICAL", evidence_ids: [], status: "LEARNING" }],
  recent_evidence: [], active_task: { id: "camera-task", goal_id: "camera-goal", title: "解释异步请求", status: "ACTIVE", related_skill_ids: ["async"] },
  learning_history: [], current_goal_skill_ids: ["async"], knowledge_cards: [],
};
const api = createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ materials: [], total: 0, projects: [] })); });
api.listen(0, "127.0.0.1"); await once(api, "listening");
const apiAddress = api.address(); assert.ok(apiAddress && typeof apiAddress === "object");
process.env.LEARNING_API_BASE_URL = `http://127.0.0.1:${apiAddress.port}`;
const provider = { getPublicSettings: async () => ({ activeProfileId: null, active: null, profiles: [] }) } as unknown as ProviderSettingsCoordinator;
const store = new WebSessionStore({ apiBaseUrl: process.env.LEARNING_API_BASE_URL, conversationDir: join(temporary, "sessions"), fetchOverview: async () => current,
  fetchLibrary: async () => ({ projects: [] }), providerSettings: provider,
  createAgent: async (_context, _planning, emit) => ({
    prompt: async text => {
      if (text === "等待测试") await new Promise(done => setTimeout(done, 3500));
      if (text === "下一任务") current = { ...current, active_task: { id: "camera-task-2", goal_id: "camera-goal", title: "练习并发请求", status: "ACTIVE", related_skill_ids: ["async"] } };
      emit({ type: "assistant_delta", delta: "我们继续针对性练习。" });
    }, abort: async () => undefined, dispose: () => undefined,
  }),
});
const first = await store.create("new"), second = await store.create("new");
const studyTime = new StudyTimeStore(join(temporary, "time.json"));
const retrieval = { scopeChanged: () => undefined } as unknown as RetrievalRuntime;
const server = createGateway({ store, studyTime, retrieval }); server.listen(0, "127.0.0.1"); await once(server, "listening");
const address = server.address(); assert.ok(address && typeof address === "object"); const url = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.RESPONSIVE_BROWSER_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
const errors: string[] = [];
async function pageWithObservation(scripted: boolean) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", permissions: ["camera"] });
  await context.addInitScript(() => { localStorage.setItem("learn-anything:intro-watched:v1", "true"); localStorage.setItem("learn-anything:task-focus-collapsed", "true"); });
  if (scripted) await context.addInitScript(() => {
    const OriginalWorker = window.Worker;
    (window as unknown as { studyFixture: string }).studyFixture = "FOCUSED";
    window.Worker = class {
      onmessage: ((event: { data: object }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(url: string | URL, options?: WorkerOptions) { if (!String(url).includes("studyCamera.worker")) return new OriginalWorker(url, options) as unknown as this; }
      postMessage(message: { type: string; frame?: ImageBitmap }) {
        message.frame?.close();
        setTimeout(() => this.onmessage?.({ data: message.type === "init" ? { type: "ready" } : { type: "observation", observation: (window as unknown as { studyFixture: string }).studyFixture } }), 0);
      }
      terminate() { this.onmessage = null; }
    } as unknown as typeof Worker;
  });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.goto(url); await page.locator("#learning-intro").waitFor({ state: "detached" });
  await page.locator('#connection-status[data-status="ready"]').waitFor({ state: "attached" });
  await page.locator(".study-observer-trigger").click();
  await page.locator("[data-study-toggle]:enabled").waitFor(); return { context, page };
}
async function summary(sid: string) { return await (await fetch(`${url}/api/web/study-time?sessionId=${sid}`)).json(); }

async function checkMissingAssets() {
  const { context, page } = await pageWithObservation(false);
  try {
    await page.route("**/assets/study-camera/ready.txt", route => route.fulfill({
      status: 200, contentType: "text/html", body: "<!doctype html><title>App fallback</title>",
    }));
    await page.evaluate(() => {
      const target = window as unknown as { cameraPermissionRequests: number };
      target.cameraPermissionRequests = 0;
      navigator.mediaDevices.getUserMedia = async () => {
        target.cameraPermissionRequests++;
        throw new Error("unexpected camera access");
      };
    });
    await page.locator("[data-study-toggle]").click();
    await page.locator("[data-study-error]").waitFor({ state: "visible" });
    assert.match(await page.locator("[data-study-error]").innerText(), /摄像头模型尚未安装/);
    assert.equal(await page.evaluate(() => (window as unknown as { cameraPermissionRequests: number }).cameraPermissionRequests), 0);
    assert.equal((await summary(second.sessionId)).recording, false);
    assert.deepEqual(errors, []);
    console.log("optional camera assets absent: passed without requesting permission");
  } finally { await context.close(); }
}

async function checkCamera() {
  const denied = await fetch(url + "/api/web/study-time", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "start", sessionId: second.sessionId }) });
  assert.equal(denied.status, 403);
  const image = await fetch(url + "/api/web/study-time", { method: "POST", headers: { "Content-Type": "application/json", Origin: url }, body: JSON.stringify({ op: "start", sessionId: second.sessionId, image: "forbidden" }) });
  assert.equal(image.status, 400);
  const real = await pageWithObservation(false); const assetRequests: string[] = [];
  real.page.on("request", request => { if (/study-camera|vision_wasm|studyCamera/.test(request.url())) assetRequests.push(request.url()); });
  await real.page.locator("[data-study-toggle]").click();
  await real.page.waitForFunction(() => document.querySelector("[data-study-toggle]")?.textContent === "停止观察" && !document.querySelector("[data-study-status]")?.textContent?.includes("正在开启"), { timeout: 25000 });
  await real.page.waitForFunction(() => document.querySelector("[data-study-status]")?.textContent?.includes("未检测到人脸"), { timeout: 15000 });
  assert.ok(assetRequests.some(value => value.includes("face_landmarker.task")));
  assert.ok(assetRequests.some(value => value.endsWith(".wasm")));
  assert.ok(assetRequests.every(value => value.startsWith(url + "/")));
  assert.equal(await real.page.locator("#study-time-strip video, #study-time-strip canvas").count(), 0);
  await real.page.waitForTimeout(5500); assert.equal((await summary(second.sessionId)).taskFocusedMs, 0);
  await real.page.locator("[data-study-toggle]").click(); await real.page.locator('[data-study-toggle]:has-text("开启摄像头观察")').waitFor();
  await real.context.close(); console.log("real browser model + local WASM + no-face pause: passed");
  if (process.argv.includes("--model-only")) return;
  const scripted = await pageWithObservation(true); const { page } = scripted; const packets: object[] = [];
  page.on("request", request => { if (request.url().endsWith("/api/web/study-time") && request.method() === "POST") packets.push(request.postDataJSON()); });
  await page.locator("[data-study-toggle]").click(); await page.waitForFunction(() => document.querySelector("[data-study-status]")?.textContent === "专注中");
  await page.waitForTimeout(5500); const beforeAway = await summary(second.sessionId);
  assert.ok(beforeAway.taskFocusedMs > 1000, "stable focus must reach the persisted summary");
  await page.evaluate(() => { (window as unknown as { studyFixture: string }).studyFixture = "AWAY"; });
  await page.waitForFunction(() => document.querySelector("[data-study-status]")?.textContent?.includes("朝向偏离"));
  await page.waitForTimeout(5500); const paused = await summary(second.sessionId);
  await page.waitForTimeout(5500); assert.equal((await summary(second.sessionId)).taskFocusedMs, paused.taskFocusedMs);
  await page.evaluate(() => { (window as unknown as { studyFixture: string }).studyFixture = "FOCUSED"; });
  await page.waitForFunction(() => document.querySelector("[data-study-status]")?.textContent === "专注中");
  // 复用真实对话导航，不通过刷新页面模拟切换。
  await page.locator("#profile-button").click();
  await page.locator("#conversation-library-menu-button").click();
  const activation = page.waitForResponse(response => response.url().endsWith(`/${first.sessionId}/activate`));
  await page.locator(`#conversation-library-page [data-conversation-action="activate"][data-session-id="${first.sessionId}"]`).click();
  const activated = await activation; assert.equal(activated.status(), 200, await activated.text());
  await page.locator("#conversation-library-page").waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector("[data-study-toggle]")?.textContent === "停止观察");
  await page.locator("#message-input").fill("等待测试"); await page.locator("#send-button").click();
  await page.waitForFunction(() => document.querySelector("[data-study-status]")?.textContent === "等待老师 · 单独记录");
  await page.locator('#connection-status[data-status="ready"]').waitFor({ state: "attached" }); await page.waitForTimeout(5500);
  assert.ok((await summary(first.sessionId)).taskWaitingMs >= 2500);
  await page.screenshot({ path: join(artifacts, "desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(500);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(artifacts, "mobile.png") });
  for (const size of [{width: 320, height: 640}, {width: 390, height: 360}]) {
    await page.setViewportSize(size); await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await page.locator("[data-study-toggle]").isVisible());
    await page.screenshot({ path: join(artifacts, `mobile-${size.width}-${size.height}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("#message-input").fill("下一任务"); await page.locator("#send-button").click();
  await page.locator('#connection-status[data-status="ready"]').waitFor({ state: "attached" }); await page.waitForTimeout(8000);
  const nextTask = await summary(first.sessionId); assert.equal(nextTask.scope.taskId, "camera-task-2"); assert.ok(nextTask.taskFocusedMs > 0);
  assert.ok(nextTask.goalFocusedMs > nextTask.taskFocusedMs); assert.equal(nextTask.taskWaitingMs, 0);
  await page.locator("[data-study-toggle]").click(); await page.locator('[data-study-toggle]:has-text("开启摄像头观察")').waitFor();
  assert.equal((await summary(first.sessionId)).recording, false);
  const ledger = JSON.parse(await readFile(join(temporary, "time.json"), "utf8"));
  const recorded = ledger.segments.filter((s: {focusedMs: number}) => s.focusedMs > 0);
  assert.equal(new Set(recorded.map((s: {runId: string}) => s.runId)).size, 1, "same-task conversation change must preserve the run");
  assert.equal(new Set(recorded.map((s: {scope: {taskId: string}}) => s.scope.taskId)).size, 2);
  const allowed = ["op", "sessionId", "runId", "seq", "observedMs", "focusedMs", "waitingMs", "observation"];
  assert.ok(packets.every(packet => Object.keys(packet).every(key => allowed.includes(key))));
  const persisted = (await summary(first.sessionId)).taskFocusedMs;
  await page.reload(); await page.locator(".study-observer-trigger").click();
  await page.locator('[data-study-toggle]:has-text("开启摄像头观察")').waitFor();
  assert.equal((await summary(first.sessionId)).taskFocusedMs, persisted);
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("denied fixture", "NotAllowedError"); }; });
  await page.locator("[data-study-toggle]").click(); await page.locator("[data-study-error]").waitFor({ state: "visible" });
  assert.match(await page.locator("[data-study-error]").innerText(), /权限/);
  assert.equal((await summary(first.sessionId)).recording, false);
  await scripted.context.close(); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ focusPause: "passed", sameRunConversation: "passed", taskSegments: "passed", separateWaiting: "passed", summariesOnly: "passed", desktopMobile: "passed", goalFocusedMs: nextTask.goalFocusedMs }));
}

try {
  await checkMissingAssets();
  if (!process.argv.includes("--missing-assets")) await checkCamera();
} finally {
  await browser.close(); store.dispose();
  await new Promise<void>(done => server.close(() => done())); await new Promise<void>(done => api.close(() => done()));
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir())); assert.ok(basename(temporary).startsWith("lawa-study-browser-"));
  await rm(temporary, { recursive: true, force: true });
}
