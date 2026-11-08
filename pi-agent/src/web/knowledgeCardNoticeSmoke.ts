import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";

const baseUrl = process.env.WORKSPACE_BASE_URL ?? "http://127.0.0.1:8787";
const screenshotDir = process.env.WORKSPACE_SCREENSHOT_DIR;
const timestamp = "2026-10-08T12:00:00Z";
const skills = ["理解概念", "应用到新场景"].map((name, i) => ({ id: `skill-${i}`, name,
  description: "用自己的语言解释，再通过实践验证。", status: "LEARNING", target_depth: "PRACTICAL", evidence_ids: [] }));
const makeCard = (id: string, skill = "skill-0") => ({ id, skill_id: skill, question: "如何检验自己的理解？",
  answer: "试着独立解释，并把方法应用到一个新例子。", source_conversation_id: null,
  feedback: null as "KNOWN" | null, feedback_updated_at: null, learner_note: null, note_updated_at: null, created_at: timestamp });
const initial = { sessionId: "notice-session", messages: [{ role: "assistant", content: "我们从一个具体问题开始。理解概念后，试着解释它，并用新例子验证。" }],
  state: { view_mode: "CURRENT", active_goal_id: "goal-current", view_goal_id: "goal-current",
    overview: { current_goal: "建立自己的学习方法", current_goal_skill_ids: skills.map((s) => s.id), skills,
      curriculum_spine: [], recent_evidence: [], knowledge_cards: [makeCard("old")],
      current_frontier: { focus_skill_id: "skill-0", supporting_skill_ids: [], reason: "", target_depth: "PRACTICAL", next_action: "" },
      active_task: { id: "task", title: "解释概念", description: "", related_skill_ids: ["skill-0"], status: "ACTIVE" } },
    teaching: { active_skill_id: "skill-0", teaching_mode: "EXPLAIN" }, onboarding: { status: "IDLE", replace_existing: false }, recommended_action: null } };
const provider = { provider: "fixture", model: "fixture", thinkingLevel: "off", maxOutputTokens: 32768, hasApiKey: false };
const browser = await chromium.launch({ executablePath: process.env.RESPONSIVE_BROWSER_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
const errors: string[] = [];

async function badge(page: Page, visible: boolean, count = 0): Promise<void> {
  const actual = await page.locator("#cards-new-badge").evaluate((node) => !(node as HTMLElement).hidden);
  assert.equal(actual, visible);
  assert.equal(await page.locator("#task-focus-toggle").getAttribute("aria-label"),
    count ? `知识卡片，${count} 张新卡片待查看` : "知识卡片");
}

try {
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  for (const [width, height] of [[1535, 864], [390, 844]]) {
    const context = await browser.newContext({ viewport: { width: width!, height: height! }, reducedMotion: "reduce" });
    await context.addInitScript(() => localStorage.setItem("learn-anything:intro-watched:v1", "true"));
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    let payload = structuredClone(initial);
    payload.state.overview.knowledge_cards[0]!.feedback = "KNOWN";
    let writes = 0;
    let release: (() => void) | undefined;
    let delay = false;
    // 替换全部 API；仅访问当前构建静态资源，不读取账本、不调用教学模型。
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() !== "GET") writes++;
      let result: unknown;
      if (/\/messages$/.test(path)) {
        if (delay) { delay = false; await new Promise<void>((resolve) => { release = resolve; }); }
        await route.fulfill({ contentType: "application/x-ndjson", body:
          [JSON.stringify({ type: "state", state: payload.state }), JSON.stringify({ type: "state", state: payload.state }),
            JSON.stringify({ type: "assistant_delta", delta: "已整理本次学习内容。" })].join("\n") + "\n" });
        return;
      }
      if (path === "/api/web/sessions") result = request.method() === "POST" ? payload : { activeSessionId: payload.sessionId,
        sessions: ["notice-session", "history-session"].map((id) => ({ id, name: id === "notice-session" ? "当前学习" : "历史学习",
          messageCount: 1, preview: "学习", createdAt: timestamp, updatedAt: timestamp, active: id === payload.sessionId })) };
      else if (/\/activate$/.test(path)) result = payload;
      else if (path === "/api/web/provider-settings") result = { activeProfileId: "fixture", active: provider, profiles: [] };
      else if (path === "/api/web/speech-settings") result = { enabled: false, profileId: null, region: "beijing", asrModel: "qwen3-asr-flash", ttsModel: "qwen3-tts-flash", voice: "Cherry" };
      else if (path === "/api/web/study-time") result = { scope: null, taskFocusedMs: 0, goalFocusedMs: 0, runFocusedMs: 0, taskObservedMs: 0, taskWaitingMs: 0, observation: "UNKNOWN", recording: false };
      else if (path === "/api/web/materials") result = { materials: [] };
      else if (path === "/api/web/learning-library") result = { projects: [] };
      else throw new Error(`Unexpected API ${request.method()} ${path}`);
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(result) });
    });
    await page.goto(baseUrl);
    await page.locator("#learning-intro").waitFor({ state: "detached" });
    await page.locator('#knowledge-cards-panel article[data-card-id="old"]').waitFor({ state: "attached" });
    await page.locator("#message-input:not([disabled])").waitFor();
    await badge(page, false);
    const tabsBefore = await page.locator("#learning-view-tabs").boundingBox();
    const send = async () => {
      await page.locator("#message-input").fill("继续学习");
      const delivered = page.waitForResponse((r) => r.url().endsWith("/messages"));
      await page.locator("#send-button").click();
      await delivered;
      await page.locator("#stop-button").waitFor({ state: "hidden" });
    };
    payload.state.overview.knowledge_cards.push(makeCard("new-1"), makeCard("new-2"), makeCard("other-skill", "skill-1"));
    await send();
    await badge(page, true, 2);
    assert.equal(await page.locator("#cards-new-badge").isVisible(), true);
    assert.deepEqual(await page.locator("#learning-view-tabs").boundingBox(), tabsBefore, "new badge must not grow the header");
    const tabBox = await page.locator("#task-focus-toggle").boundingBox();
    const badgeBox = await page.locator("#cards-new-badge").boundingBox();
    const labelBox = await page.locator("#task-focus-toggle > span").first().boundingBox();
    await page.waitForFunction(() => [...document.querySelectorAll(".message")].every((node) => getComputedStyle(node).opacity === "1"));
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `card-notice-${width}-new.png`) });
    assert.ok(tabBox && badgeBox && labelBox && badgeBox.x >= tabBox.x && badgeBox.x + badgeBox.width <= tabBox.x + tabBox.width &&
      badgeBox.y + badgeBox.height <= labelBox.y + 1, "badge stays over the label without covering it");
    await page.reload();
    await page.locator("#learning-intro").waitFor({ state: "detached" });
    await page.locator('#knowledge-cards-panel article[data-card-id="new-1"]').waitFor({ state: "attached" });
    await page.locator("#message-input:not([disabled])").waitFor();
    await badge(page, true, 2);
    const beforeOpen = writes;
    await page.locator("#conversation-toggle").press("ArrowRight");
    await badge(page, false);
    assert.equal(await page.locator("#knowledge-cards-panel .knowledge-card").count(), 3);
    assert.equal(writes, beforeOpen, "opening cards must not write learning facts or call the model");
    await page.locator("#task-focus-toggle").press("Home");
    // 旧卡已查看/自评会了；用户在生成途中打开旧卡，新卡随后到达不能自动被读掉。
    delay = true;
    const lateResponse = page.waitForResponse((r) => r.url().endsWith("/messages"));
    const lateRequest = page.waitForRequest((r) => r.url().endsWith("/messages"));
    await page.locator("#message-input").fill("继续学习");
    await page.locator("#send-button").click();
    await lateRequest;
    await page.locator("#task-focus-toggle").click();
    await badge(page, false);
    payload.state.overview.knowledge_cards.push(makeCard("late-in-open-pane"), makeCard("another-late-card"));
    assert.ok(release); release();
    await lateResponse;
    await page.locator("#stop-button").waitFor({ state: "hidden" });
    await badge(page, true, 2);
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `card-notice-${width}-late.png`) });
    await page.locator('#knowledge-cards-panel [data-card-action="flip"][data-card-id="old"]').click();
    await badge(page, true, 2);
    await page.locator('#knowledge-cards-panel [data-card-action="flip"][data-card-id="late-in-open-pane"]').click();
    await badge(page, true, 1);
    await page.locator("#task-focus-toggle").click(); await badge(page, false);
    await page.locator("#conversation-toggle").click();
    // 当前技能以外的新增卡片保留，只有显示该技能的卡片页才清除。
    payload.state.teaching.active_skill_id = "skill-1";
    payload.state.overview.active_task.related_skill_ids = ["skill-1"];
    await send(); await badge(page, true, 1);
    await page.locator("#task-focus-toggle").click(); await badge(page, false);
    await page.locator("#conversation-toggle").click();
    payload.state.teaching.active_skill_id = "skill-0";
    payload.state.overview.active_task.related_skill_ids = ["skill-0"];
    payload.state.overview.knowledge_cards[0]!.answer = "修改答案";
    await send(); await badge(page, false);
    payload.state.overview.knowledge_cards.push(makeCard("deleted-new"));
    await send(); await badge(page, true, 1);
    payload.state.overview.knowledge_cards.pop();
    await send(); await badge(page, false);
    // 生成期间去设置页，卡片 DOM 虽保留且被选中，也不能代替实际查看。
    payload.state.overview.knowledge_cards.push(makeCard("hidden-new"));
    delay = true;
    await page.locator("#message-input").fill("继续学习");
    const sent = page.waitForRequest((r) => r.url().endsWith("/messages"));
    await page.locator("#send-button").click();
    await sent;
    await page.locator("#task-focus-toggle").click();
    await page.evaluate(() => { location.hash = "settings"; });
    await page.waitForFunction(() => document.body.dataset.workspace === "settings");
    assert.ok(release); release();
    await page.locator("#stop-button").waitFor({ state: "hidden" });
    await badge(page, true, 1);
    await page.evaluate(() => { location.hash = "learn"; });
    await page.waitForFunction(() => document.body.dataset.workspace === "learn");
    await badge(page, false);
    // 后台浏览器标签也不视为查看；重新前台显示卡片后清除。
    await page.locator("#conversation-toggle").click();
    await page.evaluate(() => Object.defineProperty(document, "hidden", { configurable: true, value: true }));
    payload.state.overview.knowledge_cards.push(makeCard("background-new"));
    await send();
    await page.locator("#task-focus-toggle").click(); await badge(page, true, 1);
    await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: false }); document.dispatchEvent(new Event("visibilitychange")); });
    await badge(page, false);
    await page.locator("#conversation-toggle").click();
    payload.state.overview.knowledge_cards.push(makeCard("pending-before-goal-switch"));
    await send(); await badge(page, true, 1);
    const current = structuredClone(payload);
    payload = { ...structuredClone(initial), sessionId: "history-session" };
    payload.state.view_mode = "ARCHIVED";
    payload.state.active_goal_id = "goal-current";
    payload.state.view_goal_id = "goal-history";
    await page.locator('#conversation-list [data-session-id="history-session"][data-conversation-action="activate"]').evaluate((node) => (node as HTMLButtonElement).click());
    await page.waitForFunction(() => document.querySelector("#workspace-title")?.textContent?.includes("历史对话"));
    await badge(page, false);
    payload = current;
    await page.locator('#conversation-list [data-session-id="notice-session"][data-conversation-action="activate"]').evaluate((node) => (node as HTMLButtonElement).click());
    await page.locator("#message-input:not([disabled])").waitFor();
    await badge(page, true, 1);
    await page.locator("#task-focus-toggle").click(); await badge(page, false);
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `card-notice-${width}-viewed.png`) });
    await page.locator("#conversation-toggle").click();
    payload.state.view_goal_id = "fresh-goal";
    payload.state.active_goal_id = "fresh-goal";
    payload.state.overview.knowledge_cards = [makeCard("first-card-in-live-goal")];
    await send(); await badge(page, true, 1);
    await page.locator("#task-focus-toggle").click(); await badge(page, false);
    await page.reload();
    await page.locator("#knowledge-cards-panel .knowledge-card").first().waitFor();
    await badge(page, false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log("Card notice passed: desktop/mobile; old KNOWN cards and late same-pane additions; repeated state; old-card actions preserve notices; single-card acknowledgement; new IDs/count; keyboard/reload; skill/goal isolation; edit/delete; hidden views/background; no card-view writes.");
} finally { await browser.close(); }
