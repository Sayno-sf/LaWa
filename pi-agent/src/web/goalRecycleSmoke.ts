import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import {once} from "node:events";
import {mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, basename, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright-core";
import {ConversationCatalog} from "./conversationCatalog.js";
import {WebSessionStore} from "./sessionStore.js";
import {createGateway} from "./gateway.js";
import {RetrievalRuntime} from "../retrieval/runtime.js";
import {KernelSourceBackend} from "../retrieval/backend.js";
import {RetrievalSettingsStore} from "../retrieval/settings.js";
import {stopSmokeProcess} from "../smokeProcess.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const temp = mkdtempSync(join(tmpdir(), "lawa-goal-recycle-smoke-"));
const screenshots = process.env.RECYCLE_SCREENSHOT_DIR;
const python = join(root, ".venv", "Scripts", "python.exe");
const seed = spawnSync(python, ["-c", `
import json, sys
from pathlib import Path
from datetime import datetime, timezone
from app.application import LearningService
from app.persistence import JsonLearningStateStore
from app.materials import MaterialStore
from app.domain import *
root = Path(sys.argv[1])
s = JsonLearningStateStore(root/'state.json').bind(LearningService(SkillGraph([]), current_goal=None))
m = MaterialStore(root/'materials')
def install(letter):
    s.initialize_curriculum(GoalProfile('goal-'+letter, '学习'+letter+'：理解原理并通过真实练习独立掌握', '已有基础', '能够独立应用'),
        tuple(CurriculumMilestone(letter+str(i),'步骤'+str(i),'练习',LearningDepth.PRACTICAL) for i in range(5)),
        (SkillNode('skill-'+letter,'技能'+letter),),
        FrontierPlan(focus_skill_id='skill-'+letter, supporting_skill_ids=(), reason='根据真实状态',
            target_depth=LearningDepth.PRACTICAL, suggested_learning_mode='BUILD', next_action='继续练习'),
        replace_existing=s.get_learning_overview().current_goal is not None)
    s.create_task(LearningTask('task-'+letter,'原任务'+letter,'继续原练习',('skill-'+letter,),()))
    s.activate_task('task-'+letter)
install('a')
s.submit_evidence(Evidence('ev-a','skill-a',EvidenceType.EXPLAIN,'独立解释',AssistanceLevel.INDEPENDENT,'原对话#原条目'))
s.confirm_mastery_by_user('skill-a')
s.create_knowledge_card(KnowledgeCard('card-a','skill-a','原问题','原答案',datetime.now(timezone.utc),learner_note='用户原笔记'))
def upload(name, owner):
    p=root/name; p.write_text('资料原文，用于隔离生命周期测试。',encoding='utf-8')
    return m.create(p,name,owner)['id']
shared=upload('shared.txt','goal-a'); private=upload('private.txt','goal-a')
install('b')
s.create_knowledge_card(KnowledgeCard('card-b','skill-b','共享资料','引用原材料 '+shared,datetime.now(timezone.utc)))
install('c')
m.close()
print(json.dumps({'shared':shared,'private':private}))
`, temp], {cwd: root, encoding: "utf8", windowsHide: true});
if (seed.status !== 0) throw new Error(seed.stderr);
const materialIds = JSON.parse(seed.stdout) as {shared: string; private: string};
const apiUrl = "http://127.0.0.1:8139";
const api = spawn(python, ["-m", "uvicorn", "app.api.main:app", "--host", "127.0.0.1", "--port", "8139"], {
  cwd: root, env: {...process.env, LEARNING_STATE_PATH: join(temp, "state.json"), LEARNING_MATERIALS_DIR: join(temp, "materials")},
  windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
});
let errors = ""; api.stderr?.on("data", chunk => {errors += String(chunk);});
let server: ReturnType<typeof createGateway> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let runtime: RetrievalRuntime | undefined;
async function apiJson(path: string, method = "GET") {
  const response = await fetch(apiUrl + path, {method}); assert.equal(response.ok, true, `${method} ${path}: ${response.status}`);
  return response.json() as Promise<any>;
}
try {
  for (let i = 0; i < 100; i++) {
    if (api.exitCode !== null) throw new Error(errors);
    try {await apiJson("/api/learning/overview"); break;} catch {await new Promise(done => setTimeout(done, 100));}
  }
  await apiJson("/api/learning/overview");
  process.env.LEARNING_API_BASE_URL = apiUrl;
  process.env.PROVIDER_SETTINGS_PATH = join(temp, "provider-settings.json");
  process.env.PROVIDER_SECRETS_PATH = join(temp, "provider-secrets.json");
  process.env.SPEECH_SETTINGS_PATH = join(temp, "speech-settings.json");
  const settings = new RetrievalSettingsStore(join(temp, "retrieval.json"), join(temp, "providers.json"), join(temp, "secrets.json"));
  runtime = new RetrievalRuntime(join(temp, "index"), new KernelSourceBackend(apiUrl), settings);
  const catalog = new ConversationCatalog(join(temp, "sessions"));
  const a = catalog.create(); catalog.recordGoal(a, "goal-a", "学习A：理解原理并通过真实练习独立掌握");
  a.appendMessage({role: "assistant", content: [{type: "text", text: "A的原学习内容"}], timestamp: Date.now()} as any);
  const a2 = catalog.create(); catalog.recordGoal(a2, "goal-a", "学习A：理解原理并通过真实练习独立掌握");
  a2.appendMessage({role: "assistant", content: [{type: "text", text: "第二段原学习内容"}], timestamp: Date.now()} as any);
  await catalog.trash(a2.getSessionId());
  const b = catalog.create(); catalog.recordGoal(b, "goal-b", "学习B：理解原理并通过真实练习独立掌握");
  b.appendMessage({role: "assistant", content: [{type: "text", text: "B的原学习内容"}], timestamp: Date.now()} as any);
  const store = new WebSessionStore({apiBaseUrl: apiUrl, conversationDir: catalog.directory,
    scopeChanged: (scope, deleted) => runtime!.scopeChanged(scope, deleted)});
  server = createGateway({store, retrieval: runtime}); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({executablePath: process.env.RESPONSIVE_BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 900}, reducedMotion: "reduce"});
  await page.addInitScript(() => localStorage.setItem("learn-anything:intro-watched:v1", "true"));
  const pageErrors: string[] = []; page.on("pageerror", error => pageErrors.push(error.message));
  let accept = true; const confirmations: string[] = [];
  page.on("dialog", async dialog => {confirmations.push(dialog.message()); accept ? await dialog.accept() : await dialog.dismiss();});
  await page.goto(base + "/#conversations");
  await page.waitForFunction(() => document.querySelector("#conversation-recycle-count")?.textContent === "1");
  await page.locator("#learning-intro").waitFor({state: "hidden"});
  assert.equal(await page.locator("#conversation-recycle").getAttribute("open"), null);
  assert.equal(await page.locator('[data-conversation-action="delete-goal"]').count(), 1, "goal without chat remains manageable");
  if (screenshots) {mkdirSync(screenshots, {recursive: true}); await page.screenshot({path: join(screenshots, "desktop-collapsed.png")});}
  await page.locator('[data-conversation-action="delete-goal"]').click();
  await page.waitForFunction(() => document.querySelector("#conversation-recycle-count")?.textContent === "2");
  if (await page.locator("#conversation-recycle").getAttribute("open") === null) await page.locator("#conversation-recycle > summary").click();
  const orphan = page.locator(".recycle-item").filter({hasText: "学习C"}); await orphan.getByRole("button", {name: "永久删除"}).click();
  await page.waitForFunction(() => document.querySelector("#conversation-recycle-count")?.textContent === "1");
  await page.locator(`#conversation-page-list [data-conversation-action="delete"][data-session-id="${a.getSessionId()}"]`).click();
  await page.waitForFunction(() => document.querySelector(".recycle-item small")?.textContent?.includes("学习目标"));
  const library = await apiJson("/api/learning/library"); assert.deepEqual(library.projects.map((p: any) => p.goal_profile.id), ["goal-b"]);
  assert.equal((await apiJson("/api/learning/retrieval/catalog")).sources.some((s: any) => s.goal_id === "goal-a"), false);
  if (screenshots) await page.screenshot({path: join(screenshots, "desktop-expanded.png")});
  await page.locator(".recycle-item").getByRole("button", {name: "恢复", exact: true}).click();
  await page.waitForFunction(() => location.hash === "#learn");
  const restored = await apiJson("/api/learning/overview");
  assert.equal(restored.active_task.id, "task-a"); assert.equal(restored.skills[0].status, "MASTERED_BY_USER");
  assert.equal(restored.knowledge_cards[0].learner_note, "用户原笔记"); assert.equal(restored.recent_evidence[0].id, "ev-a");
  assert.match(await page.locator("#messages").innerText(), /原学习内容/);
  await page.goto(base + "/#conversations");
  await page.waitForFunction(() => document.querySelector("#conversation-recycle-count")?.textContent === "0");
  const active = (await (await fetch(base + "/api/web/sessions")).json() as any).activeSessionId;
  const originalLedger = readFileSync(join(temp, "state.json"), "utf8");
  const row = page.locator(`#conversation-page-list .conversation-list-item`).filter({has: page.locator(`[data-session-id="${active}"]`)});
  await row.locator("summary").click(); await row.getByRole("button", {name: "仅清空聊天"}).click();
  await page.waitForFunction(() => document.querySelector("#conversation-management-status")?.textContent?.includes("聊天已清空"));
  assert.equal(readFileSync(join(temp, "state.json"), "utf8"), originalLedger);
  await page.waitForFunction(() => document.querySelector("#conversation-recycle-count")?.textContent === "1");
  if (await page.locator("#conversation-recycle").getAttribute("open") === null) await page.locator("#conversation-recycle > summary").click();
  await page.locator(".recycle-item").getByRole("button", {name: "恢复", exact: true}).click();
  await page.waitForFunction(() => location.hash === "#learn");
  await page.goto(base + "/#conversations");
  await page.locator('#conversation-page-list [data-conversation-action="delete"]').filter({has: page.locator('svg')}).first().waitFor();
  const session = (await (await fetch(base + "/api/web/sessions")).json() as any).sessions.find((s: any) => s.goalId === "goal-a");
  await page.locator(`#conversation-page-list [data-conversation-action="delete"][data-session-id="${session.id}"]`).click();
  await page.waitForFunction(() => document.querySelector("#conversation-recycle-count")?.textContent === "1");
  if (await page.locator("#conversation-recycle").getAttribute("open") === null) await page.locator("#conversation-recycle > summary").click();
  accept = false; await page.locator(".recycle-item").getByRole("button", {name: "永久删除"}).click();
  assert.equal((await apiJson("/api/user/recycle")).goals.length, 1);
  accept = true; await page.locator(".recycle-item").getByRole("button", {name: "永久删除"}).click();
  await page.waitForFunction(() => document.querySelector("#conversation-recycle-count")?.textContent === "0");
  assert.equal(existsSync(join(temp, "materials", materialIds.private)), false);
  assert.equal(existsSync(join(temp, "materials", materialIds.shared, "source")), true);
  assert.equal(JSON.parse(readFileSync(join(temp, "materials", materialIds.shared, "metadata.json"), "utf8")).goal_id, "goal-b");
  const bSession = (await (await fetch(base + "/api/web/sessions")).json() as any).sessions.find((s: any) => s.goalId === "goal-b");
  await page.locator(`#conversation-page-list [data-conversation-action="delete"][data-session-id="${bSession.id}"]`).click();
  await page.waitForFunction(() => document.querySelector("#conversation-recycle-count")?.textContent === "1");
  assert.equal((await apiJson("/api/learning/overview")).current_goal, null);
  assert.deepEqual((await apiJson("/api/learning/overview")).skills, []);
  const mobile = await browser.newPage({viewport: {width: 390, height: 844}, reducedMotion: "reduce"});
  await mobile.addInitScript(() => localStorage.setItem("learn-anything:intro-watched:v1", "true"));
  mobile.on("pageerror", error => pageErrors.push(error.message));
  await mobile.goto(base + "/#conversations");
  await mobile.waitForFunction(() => document.querySelector("#conversation-recycle-count")?.textContent === "1");
  assert.equal(await mobile.locator("#conversation-recycle").getAttribute("open"), null);
  await mobile.locator("#conversation-recycle > summary").click();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (screenshots) await mobile.screenshot({path: join(screenshots, "mobile-expanded.png"), fullPage: true});
  await mobile.locator(".recycle-item").getByRole("button", {name: "恢复", exact: true}).click();
  await mobile.waitForFunction(() => location.hash === "#learn");
  assert.equal((await apiJson("/api/learning/overview")).active_task.id, "task-b");
  assert.deepEqual(pageErrors, []);
  assert.ok(confirmations.some(text => text.includes("所有对话、资料和学习记录")));
  console.log(JSON.stringify({status: "passed", desktop: true, mobile: true, kernel: "real isolated Python", models: 0,
    checks: ["orphan goal", "legacy trash", "whole goal", "exact facts restore", "clear chat keeps ledger bytes", "cancel purge", "shared material retained", "last goal empty", "mobile restore"]}));
} finally {
  await browser?.close();
  if (server) {server.close(); await once(server, "close");}
  await runtime?.stop();
  await stopSmokeProcess(api);
  assert.equal(dirname(resolve(temp)), resolve(tmpdir())); assert.ok(basename(temp).startsWith("lawa-goal-recycle-smoke-"));
  rmSync(temp, {recursive: true, force: true});
}
