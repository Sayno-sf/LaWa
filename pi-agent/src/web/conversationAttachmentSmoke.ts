import assert from "node:assert/strict";
import {spawn, spawnSync, type ChildProcess} from "node:child_process";
import {once} from "node:events";
import {mkdirSync, readFileSync, writeFileSync, existsSync} from "node:fs";
import {createServer} from "node:net";
import {basename, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium, type Browser, type Page} from "playwright-core";
import {attachmentReferences} from "../conversationAttachments.js";
import {stopSmokeProcess} from "../smokeProcess.js";
import {ConversationCatalog} from "./conversationCatalog.js";
import {createGateway} from "./gateway.js";
import {WebSessionStore} from "./sessionStore.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const qa = resolve(root, "../data/qa/conversation-attachment", Date.now().toString());
const webDir = process.env.ATTACHMENT_QA_WEB_DIR ?? resolve(root, "../data/qa/attachment-web", basename(root));
mkdirSync(qa, {recursive: true});
const python = existsSync(join(root, ".venv/Scripts/python.exe")) ? join(root, ".venv/Scripts/python.exe")
  : join(root, "../learn-anything-agent/.venv/Scripts/python.exe");
const previousApi = process.env.LEARNING_API_BASE_URL;
let api: ChildProcess | undefined, gateway: ReturnType<typeof createGateway> | undefined, browser: Browser | undefined;
let store: WebSessionStore | undefined;
let page: Page | undefined;
const failures: string[] = [];
let prompts = 0;
const report: Record<string, unknown> = {scope: "isolated desktop attachment management; no real model or classroom"};
try {
  assert.ok(existsSync(join(webDir, "index.html")), "先将Web构建到独立data/qa/attachment-web/<worktree>，不要覆盖运行入口");
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as {port: number}).port; reservation.close(); await once(reservation, "close");
  const apiUrl = `http://127.0.0.1:${port}`;
  api = spawn(python, ["-m", "uvicorn", "app.api.main:app", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: {...process.env,
      LEARNING_STATE_PATH: ":memory:", LEARNING_BOOTSTRAP: "gradient-demo", LEARNING_MATERIALS_DIR: join(qa, "materials")},
  });
  let errors = ""; api.stderr?.on("data", data => {errors += String(data);});
  let ready = false;
  for (let n = 0; n < 100; n++) {
    if (api.exitCode !== null) throw new Error(errors);
    try { if ((await fetch(apiUrl + "/api/learning/overview", {signal: AbortSignal.timeout(2000)})).ok) {ready = true; break;} } catch {}
    await new Promise(done => setTimeout(done, 100));
  }
  assert.ok(ready, "isolated Kernel startup");
  process.env.LEARNING_API_BASE_URL = apiUrl;
  const before = await (await fetch(apiUrl + "/api/learning/overview")).json() as {goal_profile: {id: string}};
  const goal = before.goal_profile.id;
  const catalog = new ConversationCatalog(join(qa, "sessions"));
  const manager = catalog.create(), sid = manager.getSessionId();
  catalog.recordGoal(manager, goal, "Isolated learning");
  const fixture = spawnSync(python, ["-c", "from PIL import Image; from pypdf import PdfWriter; import sys; from pathlib import Path; p=Path(sys.argv[1]); Image.new('RGB',(480,240),'#dce9f8').save(p/'sample.png'); w=PdfWriter(); [w.add_blank_page(width=300,height=400) for _ in range(4)]; w.write(p/'scan.pdf')", qa], {cwd: root, windowsHide: true});
  assert.equal(fixture.status, 0, String(fixture.stderr));
  async function upload(name: string, bytes: Uint8Array, legacy = false): Promise<string> {
    const query = new URLSearchParams({filename: name, expected_goal_id: goal,
      purpose: legacy ? "learning_material" : "conversation_attachment", ...(legacy ? {} : {conversation_id: sid})});
    const response = await fetch(`${apiUrl}/api/user/materials?${query}`, {method: "POST", body: bytes as BodyInit});
    assert.equal(response.status, 201); return (await response.json() as {id: string}).id;
  }
  const textId = await upload("原文笔记.md", Buffer.from("阅读首尾 SAMPLE_TAIL_41\n完整原文可以回看。"));
  const imageId = await upload("运行截图.png", readFileSync(join(qa, "sample.png")));
  const pdfId = await upload("扫描讲义.pdf", readFileSync(join(qa, "scan.pdf")));
  const legacyId = await upload("旧资料.md", Buffer.from("LEGACY_READ_17"), true);
  const refs = [{id: textId, name: "原文笔记.md", isImage: false}, {id: imageId, name: "运行截图.png", isImage: true}, {id: pdfId, name: "扫描讲义.pdf", isImage: false}];
  manager.appendMessage({role: "user", content: `看看附件\n[LAWA_MATERIAL_CONTEXT]\n${attachmentReferences(refs)}\n[/LAWA_MATERIAL_CONTEXT]`, timestamp: Date.now()});
  manager.appendMessage({role: "user", content: `[LAWA_MATERIAL_CONTEXT]\n请先读取「旧资料.md」（material_id: ${legacyId}）的开头部分，结合我当前的学习内容讲解，来源请在回复末尾简短列出。\n[/LAWA_MATERIAL_CONTEXT]`, timestamp: Date.now()});
  store = new WebSessionStore({apiBaseUrl: apiUrl, conversationDir: catalog.directory, createAgent: async () => ({
    prompt: async () => {prompts++; throw new Error("preview must not run the teacher");}, abort: async () => {}, dispose: () => {},
  })});
  gateway = createGateway({store, staticDir: webDir}); gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
  const webUrl = `http://127.0.0.1:${(gateway.address() as {port: number}).port}`;
  browser = await chromium.launch({executablePath: process.env.RESPONSIVE_BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true});
  page = await browser.newPage({viewport: {width: 1535, height: 960}});
  await page.addInitScript(() => localStorage.setItem("learn-anything:intro-watched:v1", "true"));
  page.on("pageerror", error => failures.push(error.message));
  page.on("response", response => {if (response.status() >= 400 && response.url().includes("conversation-attachments")) failures.push(`${response.status()} ${new URL(response.url()).pathname}`);});
  await page.goto(webUrl, {waitUntil: "domcontentloaded"});
  // 已观看也会有短品牌动画；等待它解除app.inert再验证真实键盘路径。
  await page.locator("#learning-intro").waitFor({state: "detached"});
  const chip = (id: string) => page!.locator(`[data-conversation-attachment="${id}"]`);
  await chip(textId).waitFor();
  const goBack = () => page!.locator('.nav-item[data-workspace-target="learn"]').click();
  await chip(textId).press("Enter");
  await page.locator(`[data-material="${textId}"]`).waitFor();
  await page.locator('[data-material-action="read"]').click();
  await page.locator("#material-preview-text").getByText(/SAMPLE_TAIL_41/).waitFor();
  let releasePreview!: () => void, previewStarted!: () => void;
  const held = new Promise<void>(done => {releasePreview = done;});
  const started = new Promise<void>(done => {previewStarted = done;});
  const previewPattern = `${webUrl}/api/web/conversation-attachments/${textId}?*`;
  await page.route(previewPattern, async route => {previewStarted(); await held; await route.continue();});
  await page.locator('[data-material-action="read"]').click();
  await started;
  await goBack();
  await chip(imageId).click(); await page.locator(`[data-material="${imageId}"]`).waitFor();
  const lateResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/web/conversation-attachments/${textId}`);
  releasePreview(); await (await lateResponse).finished();
  await page.unroute(previewPattern);
  assert.equal(await page.locator(`[data-material="${textId}"]`).count(), 0);
  assert.equal(await page.locator("#material-preview").isVisible(), false, "old preview must not reopen in another attachment");
  await page.locator('[data-material-action="read"]').click();
  await page.locator("#material-preview-assets img").waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>("#material-preview-assets img")].some(image => image.naturalWidth > 0));
  await page.screenshot({path: join(qa, "attachment-image-1535.png"), fullPage: true});
  await goBack();
  await chip(pdfId).click(); await page.locator(`[data-material="${pdfId}"]`).waitFor();
  await page.locator(".material-start input").fill("4"); await page.locator('[data-material-action="read"]').click();
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>("#material-preview-assets img")?.naturalWidth);
  assert.match(await page.locator("#material-preview-status").innerText(), /第 4 页/);
  await page.setViewportSize({width: 1920, height: 1080});
  await page.screenshot({path: join(qa, "attachment-pdf-1920.png"), fullPage: true});
  await goBack();
  await chip(legacyId).click(); await page.locator(`[data-material="${legacyId}"]`).waitFor();
  await page.locator('[data-material-action="read"]').click(); await page.getByText(/LEGACY_READ_17/).waitFor();
  await goBack();
  await chip(textId).click(); await page.locator(`[data-material="${textId}"]`).waitFor();
  page.once("dialog", dialog => dialog.accept()); await page.locator('[data-material-action="delete"]').click();
  await page.getByText("附件已删除或原资料不可用，历史对话和学习记录仍保留。", {exact: true}).waitFor();
  await goBack(); await page.locator(".message-attachment-file").getByText(/原文笔记.md · 附件已删除/).waitFor();
  await page.reload(); await chip(imageId).waitFor();
  await chip(textId).click(); await page.getByText("附件已删除或原资料不可用，历史对话和学习记录仍保留。", {exact: true}).waitFor();
  const after = await (await fetch(apiUrl + "/api/learning/overview")).json();
  assert.deepEqual(after, before); assert.equal(prompts, 0);
  const listed = await (await fetch(`${apiUrl}/api/learning/materials?expected_goal_id=${goal}`)).json() as {materials: Array<{id: string}>};
  assert.deepEqual(listed.materials.map(item => item.id), [legacyId]);
  report.passed = ["text keyboard open", "late preview discarded", "original image", "scan page4", "legacy attachment", "delete and refresh", "library exclusion", "learning ledger unchanged", "no teacher calls"];
  console.log(JSON.stringify({qa, passed: report.passed}));
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.failures = failures;
  if (page) {report.materialText = await page.locator("#materials-list").innerText(); await page.screenshot({path: join(qa, "failure.png"), fullPage: true});}
  console.error(JSON.stringify(report)); throw error;
} finally {
  writeFileSync(join(qa, "report.json"), JSON.stringify(report, null, 2));
  await browser?.close(); store?.dispose();
  if (gateway) await new Promise<void>(done => gateway!.close(() => done()));
  if (api) await stopSmokeProcess(api);
  if (previousApi === undefined) delete process.env.LEARNING_API_BASE_URL; else process.env.LEARNING_API_BASE_URL = previousApi;
}
