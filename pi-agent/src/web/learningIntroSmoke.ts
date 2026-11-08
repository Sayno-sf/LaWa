import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";

const baseUrl = process.env.INTRO_BASE_URL ?? "http://127.0.0.1:8787";
const browserPath = process.env.INTRO_BROWSER_PATH
  ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const screenshotDir = process.env.INTRO_SCREENSHOT_DIR;
const watchedKey = "learn-anything:intro-watched:v1";
const restoredText = "上次我们学到了这里。接下来继续原来的练习。";
const fixtureSession = {
  sessionId: "intro-fixture-session",
  messages: [{ role: "assistant", content: restoredText }],
  state: {
    view_mode: "CURRENT", active_goal_id: "intro-goal",
    overview: {
      current_goal: "学会提问", current_goal_skill_ids: ["intro-skill"], curriculum_spine: [],
      current_frontier: { focus_skill_id: "intro-skill", supporting_skill_ids: [], reason: "", target_depth: "PRACTICAL", next_action: "" },
      skills: [{ id: "intro-skill", name: "提出清晰的问题", description: "用自己的话说明问题。", status: "LEARNING", target_depth: "PRACTICAL", evidence_ids: [] }],
      recent_evidence: [], knowledge_cards: [],
      active_task: { id: "intro-task", title: "继续原来的练习", description: "", related_skill_ids: ["intro-skill"], status: "ACTIVE" },
    },
    teaching: { active_skill_id: "intro-skill", teaching_mode: "EXPLAIN" },
    onboarding: { status: "IDLE", replace_existing: false }, recommended_action: null,
  },
};
const provider = { provider: "fixture", model: "fixture", baseUrl: "https://example.invalid/v1", thinkingLevel: "off", maxOutputTokens: 32768, hasApiKey: false, apiKeyHint: null };
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
const errors: string[] = [];
const unexpectedWrites: string[] = [];
let resumes = 0;

// 所有 API 在浏览器边界替换，测试仅读取已构建静态文件，不接触用户账本/会话/Provider。
async function openPage(context: BrowserContext, sessionFailure = false): Promise<Page> {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let payload: unknown = {};
    if (path === "/api/web/sessions" && request.method() === "POST") {
      resumes += 1;
      assert.deepEqual(request.postDataJSON(), { mode: "resume-recent" });
      if (sessionFailure) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "隔离测试：服务暂不可用" }) });
        return;
      }
      payload = fixtureSession;
    } else if (request.method() !== "GET") {
      unexpectedWrites.push(`${request.method()} ${path}`);
    } else if (path === "/api/web/sessions") {
      payload = { activeSessionId: fixtureSession.sessionId, sessions: [] };
    } else if (path === "/api/web/provider-settings") {
      payload = { activeProfileId: null, active: provider, profiles: [] };
    } else if (path === "/api/web/materials") {
      payload = { materials: [] };
    } else if (path === "/api/web/learning-library") {
      payload = { projects: [] };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  return page;
}
async function capture(page: Page, name: string): Promise<void> {
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `${name}.png`) });
}
async function assertReleased(page: Page): Promise<void> {
  await page.locator("#learning-intro").waitFor({ state: "detached", timeout: 14000 });
  assert.equal(await page.locator("#app").evaluate((node) => (node as HTMLElement).inert), false);
  assert.equal(await page.locator("body").evaluate((node) => node.classList.contains("learning-intro-active")), false);
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), watchedKey), "true");
}

try {
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await desktop.addInitScript(() => localStorage.setItem("learn-anything:task-focus-collapsed", "true"));
  const page = await openPage(desktop);
  const started = Date.now();
  assert.equal(await page.locator("#learning-intro").getAttribute("data-mode"), "story");
  await page.waitForFunction((text) => document.querySelector("#messages")?.textContent?.includes(text), restoredText);
  assert.equal(await page.locator("#learning-intro").getAttribute("data-scene"), "0", "restore must run during the intro");
  assert.equal(await page.locator("#app").evaluate((node) => (node as HTMLElement).inert), true);
  await page.locator("#message-input").evaluate((node) => (node as HTMLElement).focus());
  assert.notEqual(await page.evaluate(() => document.activeElement?.id), "message-input");
  const expected = ["我想学会……", "把想学的，变成清晰的下一步。", "在对话中理解，在实践中前进。", "每一次尝试，都留下成长的足迹。", "把想学的，变成能做到的。"];
  for (let scene = 0; scene < 5; scene += 1) {
    await page.waitForFunction((index) => document.querySelector("#learning-intro")?.getAttribute("data-scene") === String(index), scene);
    assert.equal(await page.locator(".intro-caption").textContent(), expected[scene]);
    await page.waitForTimeout(850);
    assert.equal(await page.locator("#learning-intro").getAttribute("data-scene"), String(scene), "capture must remain in the requested scene");
    assert.equal(await page.locator("#learning-intro").evaluate((node) => getComputedStyle(node).backgroundColor), await page.locator("html").evaluate((node) => getComputedStyle(node).backgroundColor), "intro must share the workspace canvas");
    await capture(page, `desktop-scene-${scene}`);
  }
  await assertReleased(page);
  assert.ok(Date.now() - started >= 7400 && Date.now() - started < 10000, "full intro must finish around 8 seconds");
  await page.locator("#message-input").fill("继续原来的练习");
  assert.equal(await page.locator("#message-input").inputValue(), "继续原来的练习");
  assert.match(await page.locator("#messages").textContent() ?? "", /上次我们学到了这里/);
  await page.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await page.locator("#learning-intro").getAttribute("data-mode"), "brand");
  assert.equal(await page.locator(".intro-skip").isVisible(), false);
  await assertReleased(page);
  await desktop.close();

  const skipContext = await browser.newContext();
  const skipPage = await openPage(skipContext);
  await skipPage.keyboard.press("Tab");
  assert.equal(await skipPage.locator(".intro-skip").evaluate((node) => node === document.activeElement), true);
  await skipPage.locator(".intro-skip").click();
  await assertReleased(skipPage);
  await skipPage.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await skipPage.locator("#learning-intro").getAttribute("data-mode"), "brand");
  await assertReleased(skipPage);
  await skipContext.close();

  const keyboardContext = await browser.newContext();
  const keyboardPage = await openPage(keyboardContext);
  await keyboardPage.keyboard.press("Escape");
  await assertReleased(keyboardPage);
  await keyboardContext.close();

  const reduced = await browser.newContext({ reducedMotion: "reduce" });
  const reducedPage = await openPage(reduced);
  assert.equal(await reducedPage.locator("#learning-intro").getAttribute("data-mode"), "static");
  assert.equal(await reducedPage.locator(".intro-brand").evaluate((node) => getComputedStyle(node).animationName), "none");
  await assertReleased(reducedPage);
  await reduced.close();
  const changedMotion = await browser.newContext();
  const changedPage = await openPage(changedMotion);
  await changedPage.emulateMedia({ reducedMotion: "reduce" });
  await assertReleased(changedPage);
  await changedMotion.close();

  const blocked = await browser.newContext();
  await blocked.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException("blocked", "SecurityError"); };
    Storage.prototype.setItem = () => { throw new DOMException("blocked", "SecurityError"); };
  });
  const blockedPage = await openPage(blocked);
  assert.equal(await blockedPage.locator("#learning-intro").getAttribute("data-mode"), "brand");
  await blockedPage.locator("#learning-intro").waitFor({ state: "detached", timeout: 2500 });
  assert.equal(await blockedPage.locator("#app").evaluate((node) => (node as HTMLElement).inert), false);
  await blocked.close();

  const mobileSizes = process.env.INTRO_DESKTOP_ONLY === "true" ? [] : [{ width: 390, height: 844 }, { width: 320, height: 640 }, { width: 844, height: 390 }];
  for (const size of mobileSizes) {
    const context = await browser.newContext({ viewport: size });
    const mobilePage = await openPage(context);
    await mobilePage.waitForFunction(() => document.querySelector("#learning-intro")?.getAttribute("data-scene") === "2");
    await mobilePage.waitForTimeout(850);
    const bounds = await mobilePage.locator(".intro-caption").boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= size.width + 1 && bounds.y + bounds.height <= size.height + 1, "caption must fit the viewport");
    assert.ok(await mobilePage.locator(".intro-caption").evaluate((node) => parseFloat(getComputedStyle(node).fontSize)) >= 18);
    await capture(mobilePage, `mobile-${size.width}x${size.height}`);
    await mobilePage.keyboard.press("Escape");
    await assertReleased(mobilePage);
    await context.close();
  }

  const failed = await browser.newContext();
  await failed.addInitScript((key) => {
    localStorage.setItem(key, "true");
    localStorage.setItem("learn-anything:task-focus-collapsed", "true");
  }, watchedKey);
  const failedPage = await openPage(failed, true);
  await assertReleased(failedPage);
  assert.equal(await failedPage.locator("#error-banner").isVisible(), true, "connection errors remain actionable after the intro");
  assert.equal(await failedPage.locator("#retry-button").isEnabled(), true);
  await failed.close();
  const failedBoot = await browser.newContext();
  await failedBoot.route("**/assets/index-*.js", (route) => route.abort());
  const failedBootPage = await openPage(failedBoot);
  await failedBootPage.waitForFunction(() => !document.documentElement.classList.contains("intro-pending"));
  assert.equal(await failedBootPage.locator("#app").evaluate((node) => getComputedStyle(node).visibility), "visible", "missing entry script must not leave a blank intro screen");
  await failedBoot.close();
  assert.ok(resumes > 0);
  assert.deepEqual(unexpectedWrites, [], "intro must not send teaching/goal/user-action requests");
  assert.deepEqual(errors, [], "all intro modes must run without browser errors");
  console.log(`PASS: 8-second story, shared canvas, parallel restore, repeat, skip, keyboard, reduced motion, blocked storage, ${mobileSizes.length} mobile layouts, connection/entry-script failure; no teaching requests.`);
} finally {
  await browser.close();
}
