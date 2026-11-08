import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { LearningOverview } from "../learningOverviewTool.js";
import { ConversationCatalog } from "./conversationCatalog.js";
import { createGateway } from "./gateway.js";
import { WebSessionStore } from "./sessionStore.js";

// 重现真实分歧：Planner 仍指上一课，Kernel ACTIVE Task 已在下一课。
// 所有账本与 Pi 树为临时测试数据；不运行 Provider 或真实教学。
const directory = mkdtempSync(join(tmpdir(), "lawa-review-completion-"));
const catalog = new ConversationCatalog(directory);
const manager = catalog.create();
catalog.recordGoal(manager, "goal-review", "Review and continue");
const lesson = (text: string) => manager.appendMessage({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } as Parameters<typeof manager.appendMessage>[0]);
lesson("上一课：已经掌握的内容");
catalog.recordSkillAnchor(manager, "goal-review", "reviewed-skill");
lesson("下一课：尚未结束的原学习现场");
catalog.recordSkillAnchor(manager, "goal-review", "next-skill");
let reviewing = false;
let mastered = true;
let operation = "";
let teachingCalls = 0;
const calls: string[] = [];
const screenshotDirectory = process.env.REVIEW_UI_SCREENSHOT_DIR;
if (screenshotDirectory) mkdirSync(screenshotDirectory, { recursive: true });
const skills = () => [
  { id: "reviewed-skill", name: "已掌握的上一课", description: "Review", status: mastered ? "MASTERED_BY_USER" : "PRACTICING", target_depth: "PRACTICAL", evidence_ids: ["old-evidence"] },
  { id: "next-skill", name: "继续当前下一课", description: "Continue", status: "LEARNING", target_depth: "PRACTICAL", evidence_ids: [] },
];
const overview = async (): Promise<LearningOverview> => ({
  current_goal: "Review and continue", goal_profile: { id: "goal-review" }, curriculum_spine: [],
  current_frontier: { focus_skill_id: "reviewed-skill", supporting_skill_ids: [], reason: "old plan", target_depth: "PRACTICAL", next_action: "old action" },
  current_focus: null, skills: skills(),
  recent_evidence: [{ id: "old-evidence", skill_id: "reviewed-skill", description: "原有证据", evidence_type: "EXPLAIN", assistance_level: "NONE", created_at: "2026-10-06T00:00:00Z" }],
  active_task: reviewing
    ? { id: `review-${operation}`, title: "复习上一课", related_skill_ids: ["reviewed-skill"], review_parent_task_id: "next-task", status: "ACTIVE" }
    : { id: "next-task", title: "继续当前下一课", related_skill_ids: ["next-skill"], status: "ACTIVE" },
  learning_history: [], current_goal_skill_ids: ["reviewed-skill", "next-skill"], knowledge_cards: [],
});
const api = createServer(async (request, response) => {
  const path = request.url ?? "";
  calls.push(`${request.method} ${path}`);
  let result: unknown = {};
  if (path.endsWith("/start-review")) {
    let body = ""; for await (const chunk of request) body += chunk;
    operation = (JSON.parse(body) as { operation_id: string }).operation_id;
    reviewing = true; mastered = false;
  } else if (path.endsWith("/confirm-mastery")) {
    // Kernel 修复后的原子结果，让浏览器回归单独检验分支/选中状态。
    reviewing = false; mastered = true; result = skills()[0];
  } else if (path.endsWith("/finish-review")) reviewing = false;
  else if (path.startsWith("/api/learning/tasks/")) result = {
    id: `review-${operation}`, goal_id: "goal-review", status: reviewing ? "ACTIVE" : "DONE", review_parent_task_id: "next-task",
  };
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(result));
});
api.listen(0, "127.0.0.1"); await once(api, "listening");
const address = api.address(); assert.ok(address && typeof address === "object");
const store = new WebSessionStore({
  conversationDir: directory, apiBaseUrl: `http://127.0.0.1:${address.port}`, fetchOverview: overview,
  createAgent: async (_context, _planning, emit, sessionManager) => ({
    prompt: async () => {
      teachingCalls += 1;
      sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "复习的完整检查记录：本次再次掌握" }], timestamp: Date.now() } as Parameters<typeof sessionManager.appendMessage>[0]);
      emit({ type: "assistant_delta", delta: "复习的完整检查记录：本次再次掌握" });
    },
    abort: async () => undefined, dispose: () => undefined,
  }),
});
const gateway = createGateway({ store });
gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
const web = gateway.address(); assert.ok(web && typeof web === "object");
const browser = await chromium.launch({ executablePath: process.env.RESPONSIVE_BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await page.goto(`http://127.0.0.1:${web.port}`, { waitUntil: "domcontentloaded" });
  await page.locator("#learning-intro").waitFor({ state: "detached" });
  await page.locator("#header-task-info").getByText("当前任务：继续当前下一课").waitFor();
  assert.match(await page.locator("#skill-card .current-skill-title").innerText(), /继续当前下一课/, "ACTIVE Task must override the stale mastered Frontier");
  assert.equal(await page.locator('#skill-route [aria-current="step"]').getAttribute("data-select-skill"), "next-skill");
  assert.equal(await page.locator("#conversation-panel #conversation-branches").count(), 0, "history does not reserve a row in the conversation");
  assert.equal(await page.locator("#skill-card .skill-records-details").isVisible(), false, "the next Skill must not inherit the previous Skill's records");
  await page.locator("#message-input").fill("下一课尚未发送的想法");
  await page.locator('#skill-route [data-select-skill="reviewed-skill"]').click();
  await page.locator(".located-message").waitFor();
  assert.equal(await page.locator("#message-input").isDisabled(), true);
  assert.equal(await page.locator("#skill-card .skill-records-details").getAttribute("open"), null, "Skill records are collapsed by default");
  await page.locator("#send-button[data-branch-back]").click();
  await page.waitForFunction(() => !(document.querySelector("#message-input") as HTMLTextAreaElement).disabled);
  assert.match(await page.locator("#skill-card .current-skill-title").innerText(), /继续当前下一课/);
  assert.equal(await page.locator("#message-input").inputValue(), "下一课尚未发送的想法", "readonly preview and return preserve the current lesson draft");
  assert.equal(teachingCalls, 0, "returning from preview must not send the draft");
  await page.locator('#skill-route [data-select-skill="reviewed-skill"]').click();
  await page.locator(".located-message").waitFor();
  await page.locator('#skill-card [data-action="review"]').click();
  await page.locator("[data-review-finish]").waitFor();
  assert.match(await page.locator("#header-task-info").innerText(), /复习上一课/);
  await store.sendMessage(manager.getSessionId(), "隔离复习记录", () => undefined);
  await page.reload();
  await page.locator("[data-review-finish]").waitFor();
  await page.locator('#skill-card [data-action="master"]').click();
  await page.locator("#header-task-info").getByText("当前任务：继续当前下一课").waitFor();
  assert.match(await page.locator("#skill-card .current-skill-title").innerText(), /继续当前下一课/, "review confirmation must release the selected old Skill");
  assert.match(await page.locator("#messages").innerText(), /尚未结束的原学习现场/, "mastery must restore the original Pi leaf");
  assert.equal(await page.locator("#message-input").isDisabled(), false);
  assert.equal(await page.locator("[data-review-finish]").count(), 0);
  assert.equal(await page.locator("[data-branch-back]").count(), 0);
  assert.equal(await page.locator("#skill-card .skill-records-details").isVisible(), false, "completing review removes the previous Skill's records from the next lesson");
  assert.match(await page.locator("#send-button").innerText(), /发送/);
  assert.equal(await page.locator("#conversation-panel #conversation-branches").count(), 0);
  await page.reload();
  await page.locator("#learning-intro").waitFor({ state: "detached" });
  await page.locator("#header-task-info").getByText("当前任务：继续当前下一课").waitFor();
  assert.match(await page.locator("#skill-card .current-skill-title").innerText(), /继续当前下一课/);
  assert.match(await page.locator("#messages").innerText(), /尚未结束的原学习现场/);
  assert.equal(await page.locator("#skill-card .skill-records-details").isVisible(), false, "reload does not resurrect the old review toolbar");
  if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, "1440-current-learning.png"), animations: "disabled" });
  await page.locator("#message-input").fill("继续下一课时保留这段草稿");
  const beforeHistory = readFileSync(manager.getSessionFile()!);
  const teachingBeforeHistory = teachingCalls;
  const mutationsBeforeHistory = calls.filter((call) => call.startsWith("POST ")).length;
  await page.locator('#skill-route [data-select-skill="reviewed-skill"]').click();
  await page.locator(".located-message").waitFor();
  const records = page.locator("#skill-card .skill-records-details");
  assert.equal(await records.getAttribute("open"), null, "opening a Skill does not automatically expand its records");
  assert.match(await records.locator("summary").innerText(), /学习记录/);
  assert.equal(await records.locator("[data-branch-entry]").count(), 2, "record count represents the first lesson and the actual review");
  assert.equal(await records.locator("[data-branch-entry]").first().isVisible(), false, "records do not occupy space until requested");
  await records.locator("summary").click();
  if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, "1440-skill-records-expanded.png"), animations: "disabled" });
  await records.locator("button").filter({ hasText: "复习 1" }).click();
  await page.locator(".located-message").waitFor();
  assert.equal(await page.locator("#message-input").isDisabled(), true, "history is readonly");
  assert.match(await page.locator("#messages").innerText(), /复习的完整检查记录/, "history includes the entire review, not just its root");
  assert.match(await page.locator("#skill-card .current-skill-title").innerText(), /已掌握的上一课/);
  assert.deepEqual(readFileSync(manager.getSessionFile()!), beforeHistory, "history must not move the execution leaf");
  assert.equal((await overview()).active_task && ((await overview()).active_task as { id: string }).id, "next-task");
  const returnButton = page.locator("#send-button[data-branch-back]");
  assert.equal(await returnButton.isDisabled(), false, "the composer remains a usable return entrance in readonly preview");
  assert.match(await returnButton.innerText(), /返回学习/);
  await returnButton.focus();
  assert.equal(await returnButton.evaluate((node) => document.activeElement === node), true, "return is keyboard accessible");
  if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, "1440-review-preview.png"), animations: "disabled" });
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !(document.querySelector("#message-input") as HTMLTextAreaElement).disabled);
  assert.match(await page.locator("#skill-card .current-skill-title").innerText(), /继续当前下一课/);
  assert.match(await page.locator("#messages").innerText(), /尚未结束的原学习现场/);
  assert.equal(await page.locator("#message-input").inputValue(), "继续下一课时保留这段草稿");
  assert.equal(teachingCalls, teachingBeforeHistory, "keyboard return must not trigger teaching");
  assert.equal(calls.filter((call) => call.startsWith("POST ")).length, mutationsBeforeHistory, "browsing and returning do not change the Kernel");
  assert.equal(await page.locator("#skill-card .skill-records-details").isVisible(), false);

  // 手机与矮屏仍使用同一只读/返回语义；所有数据继续来自隔离 Pi 树。
  for (const [width, height] of [[390, 844], [320, 640]]) {
    await page.setViewportSize({ width: width!, height: height! });
    await page.locator("#message-input").fill(`${width} 屏幕的未发送草稿`);
    // 手机端技能路线在「路线」界面、学习记录在「记录」界面，切换界面本身不触发教学。
    const mobileSurfaces = width! <= 820;
    if (mobileSurfaces) await page.locator('#mobile-surface-tabs [data-mobile-surface="route"]').click();
    await page.locator('#skill-route [data-select-skill="reviewed-skill"]').click();
    if (mobileSurfaces) await page.locator('#mobile-surface-tabs [data-mobile-surface="records"]').click();
    const mobileRecords = page.locator("#skill-card .skill-records-details");
    assert.equal(await mobileRecords.getAttribute("open"), null, `${width}: records begin folded`);
    await mobileRecords.locator("summary").click();
    await mobileRecords.locator("button").filter({ hasText: "复习 1" }).click();
    if (mobileSurfaces) await page.locator('#mobile-surface-tabs [data-mobile-surface="learn"]').click();
    await page.locator(".located-message").waitFor();
    assert.match(await page.locator("#messages").innerText(), /复习的完整检查记录/);
    assert.equal(await page.locator("#message-input").isDisabled(), true);
    const mobileReturn = page.locator("#send-button[data-branch-back]");
    await mobileReturn.focus();
    const bounds = await mobileReturn.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width! && bounds.y >= 0 && bounds.y + bounds.height <= height! + 1, `${width}: keyboard focus makes return visible and reachable`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${width}: no horizontal overflow`);
    if (screenshotDirectory && width === 390) await page.screenshot({ path: join(screenshotDirectory, "390-review-preview.png"), animations: "disabled" });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !(document.querySelector("#message-input") as HTMLTextAreaElement).disabled);
    assert.equal(await page.locator("#message-input").inputValue(), `${width} 屏幕的未发送草稿`);
    assert.equal(await page.locator("#send-button").getAttribute("data-branch-back"), null);
    assert.match(await page.locator("#header-task-info").innerText(), /继续当前下一课/);
    assert.equal(await page.locator("#skill-card .skill-records-details").isVisible(), false, `${width}: records stay folded after returning`);
    assert.deepEqual(readFileSync(manager.getSessionFile()!), beforeHistory, `${width}: history leaves the original Pi file unchanged`);
  }
  assert.equal(calls.filter((call) => call.endsWith("/confirm-mastery")).length, 1);
  assert.equal(calls.some((call) => /messages|evidence|initialize/.test(call)), false);
  assert.equal(teachingCalls, teachingBeforeHistory);

  // 结束复习跨越 Kernel/Pi 恢复；等待响应时不能再提交、清空未发送草稿。
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('#skill-route [data-select-skill="reviewed-skill"]').click();
  await page.locator(".located-message").waitFor();
  await page.locator('#skill-card [data-action="review"]').click();
  await page.locator("#header-task-info [data-review-finish]").waitFor();
  await page.locator("#message-input").fill("等待结束复习时必须保留的草稿");
  const teachingBeforeFinish = teachingCalls;
  let releaseFinish: () => void = () => undefined;
  let notifyFinish: () => void = () => undefined;
  let notifyFinishHandled: () => void = () => undefined;
  let finishRequestStarted = false;
  let finishRouteError: unknown;
  const holdFinish = new Promise<void>((resolve) => { releaseFinish = resolve; });
  const finishObserved = new Promise<void>((resolve) => { notifyFinish = resolve; });
  const finishHandled = new Promise<void>((resolve) => { notifyFinishHandled = resolve; });
  const finishPattern = "**/api/web/reviews/finish";
  await page.route(finishPattern, async (route) => {
    finishRequestStarted = true;
    notifyFinish();
    await holdFinish;
    try {
      await route.continue();
    } catch (error) {
      // 异步 handler 不越过主断言抛错；成功路径仍显式核对转发错误。
      finishRouteError = error;
    } finally {
      notifyFinishHandled();
    }
  });
  try {
    await page.locator("#header-task-info [data-review-finish]").click();
    await finishObserved;
    assert.equal(await page.locator("#message-input").isDisabled(), true, "pending review finish blocks editing during Task/Pi restoration");
    assert.equal(await page.locator("#send-button").isDisabled(), true, "pending review finish blocks sending");
    await page.locator("#composer").evaluate((node) => node.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(await page.locator("#message-input").inputValue(), "等待结束复习时必须保留的草稿", "even a submit event during restoration must not clear the draft");
    assert.equal(teachingCalls, teachingBeforeFinish, "pending finish cannot trigger teaching");
  } finally {
    releaseFinish();
    if (finishRequestStarted) await finishHandled;
    await page.unroute(finishPattern);
  }
  assert.equal(finishRouteError, undefined, "delayed finish request forwards before removing its handler");
  await page.locator("#header-task-info").getByText("当前任务：继续当前下一课").waitFor();
  await page.waitForFunction(() => !(document.querySelector("#message-input") as HTMLTextAreaElement).disabled);
  assert.equal(await page.locator("#send-button").isDisabled(), false);
  assert.equal(await page.locator("#message-input").inputValue(), "等待结束复习时必须保留的草稿");
  assert.match(await page.locator("#messages").innerText(), /尚未结束的原学习现场/);
  assert.equal(await page.locator("#skill-card .skill-records-details").isVisible(), false);
  assert.equal(teachingCalls, teachingBeforeFinish);
  console.log("Review lifecycle passed: current Task; mastery return; collapsed Skill records; full readonly history; keyboard/composer return; draft/Pi preservation; desktop/mobile layouts; no automatic teaching.");
} finally {
  await browser.close(); store.dispose(); gateway.close(); api.close();
  await Promise.all([once(gateway, "close"), once(api, "close")]);
  rmSync(directory, { recursive: true, force: true });
}
