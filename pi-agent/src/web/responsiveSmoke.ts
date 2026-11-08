import assert from "node:assert/strict";
import { chromium, type Page } from "playwright-core";

const browserPath = process.env.RESPONSIVE_BROWSER_PATH
  ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const baseUrl = process.env.RESPONSIVE_BASE_URL ?? "http://127.0.0.1:8787";
const skillDescription = "能够比较典型应用的边界、适用条件与常见误解，并结合实际例子解释为什么某个方案在一个场景有效，在另一个场景可能失效。".repeat(3);
const longParagraph = "老师把这一段拆成可执行的小步，并请你用一句话说明判断依据。".repeat(6);
const longCodeLine = `const veryLongIdentifier = resolveWorkspaceNavigationState(${Array.from({ length: 14 }, (_, index) => `value${index}`).join(", ")});`;
const fixtureSession = {
  sessionId: "responsive-smoke-session",
  messages: [
    { role: "assistant", content: `${longParagraph}\n\n\`\`\`ts\n${longCodeLine}\n\`\`\`` },
    { role: "user", content: "我先按这个顺序试一次。" },
    { role: "assistant", content: longParagraph },
  ],
  state: {
    view_mode: "CURRENT",
    active_goal_id: "responsive-goal",
    overview: {
      current_goal: "测试响应式学习页面",
      current_goal_skill_ids: ["responsive-skill"],
      curriculum_spine: [],
      current_frontier: { focus_skill_id: "responsive-skill", supporting_skill_ids: [], reason: "", target_depth: "OVERVIEW", next_action: "" },
      skills: [{ id: "responsive-skill", name: "复杂场景的分析能力", description: skillDescription, status: "LEARNING", target_depth: "OVERVIEW", evidence_ids: [] }],
      recent_evidence: [{ id: "responsive-evidence", skill_id: "responsive-skill", evidence_type: "EXPLANATION", description: "已经完成一段独立解释", assistance_level: "NONE", created_at: "2026-09-25T00:00:00Z" }],
      active_task: null,
      knowledge_cards: [],
    },
    teaching: { active_skill_id: "responsive-skill", teaching_mode: "EXPLAIN" },
    onboarding: { status: "IDLE", replace_existing: false },
    recommended_action: null,
  },
};
interface ElementMetrics { width: number; height: number; visible: boolean }
interface LayoutMetrics {
  documentWidth: number;
  viewportWidth: number;
  viewportHeight: number;
  messages: ElementMetrics;
  composer: ElementMetrics;
  route: ElementMetrics;
  cards: ElementMetrics;
  context: ElementMetrics;
  navToggle: ElementMetrics;
}
const sizes = [
  { width: 2560, height: 1440 },
  { width: 1751, height: 720 },
  { width: 1750, height: 720 },
  { width: 1535, height: 720 },
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1228, height: 576 },
  { width: 1101, height: 720 },
  { width: 1100, height: 720 },
  { width: 1024, height: 768 },
  { width: 900, height: 600 },
  { width: 821, height: 720 },
  { width: 820, height: 720 },
  { width: 768, height: 900 },
  { width: 390, height: 844 },
  { width: 360, height: 640 },
  { width: 320, height: 640 },
];

const browser = await chromium.launch({ executablePath: browserPath, headless: true });

// 响应式验收仅消费构建资源；列表/配置也使用 fixture，避免读取真实用户数据。
async function mockReadApis(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const provider = { provider: "fixture", model: "fixture", baseUrl: "https://example.invalid/v1", thinkingLevel: "off", maxOutputTokens: 32768, hasApiKey: false, apiKeyHint: null };
    const payload = path === "/api/web/provider-settings" ? { activeProfileId: null, active: provider, profiles: [] }
      : path === "/api/web/speech-settings" ? { enabled: false, profileId: null, region: "beijing", asrModel: "qwen3-asr-flash", ttsModel: "qwen3-tts-flash", voice: "Cherry" }
      : path === "/api/web/sessions" ? { activeSessionId: fixtureSession.sessionId, sessions: [] }
      : path === "/api/web/materials" ? { materials: [] }
      : path === "/api/web/study-time" ? { scope: null, taskFocusedMs: 0, goalFocusedMs: 0, runFocusedMs: 0, taskObservedMs: 0, taskWaitingMs: 0, observation: "UNKNOWN", recording: false }
      : path === "/api/web/recycle" ? { items: [] }
      : path === "/api/web/learning-library" ? { projects: [] }
      : path === "/api/web/classroom/snapshot" ? { session: null, run: null, version: null, sequence: 0 }
      : path === "/api/web/teaching" ? { proposals: [], current_goal_id: null }
      : path === "/api/web/retrieval-status" ? { sources: [] } : null;
    // 课堂只读订阅在页面加载时建立；这里给空事件流，避免断言把正常订阅当成意外请求。
    if (path === "/api/web/classroom/events") {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: ": fixture stream\n\n" });
      return;
    }
    assert.ok(payload && route.request().method() === "GET", `Unexpected API ${route.request().method()} ${path}`);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
}
try {
  const failures: string[] = [];
  for (const size of sizes) {
    const context = await browser.newContext({ viewport: size, reducedMotion: "reduce" });
    const page = await context.newPage();
    await mockReadApis(page);
    await page.route("**/api/web/sessions", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixtureSession) });
      } else {
        await route.fallback();
      }
    });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#hero-greeting")?.textContent !== "你好，");
    // 桌面端当前学习卡与课堂同屏；手机端它属于「记录」界面，先用课堂输入框确认页面已就绪。
    await page.locator("#composer").waitFor();
    if (size.width > 820) await page.locator("#skill-card .skill-description-preview").waitFor();
    const metrics = await page.evaluate(`(() => {
      const measure = (selector) => {
        const node = document.querySelector(selector);
        if (!node) throw new Error('Missing layout element: ' + selector);
        const rect = node.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          visible: getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden',
        };
      };
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        messages: measure('#messages'),
        composer: measure('#composer'),
        route: measure('.route-card'),
        cards: measure('#task-focus-card'),
        context: measure('.context-column'),
        navToggle: measure('#sidebar-toggle'),
      };
    })()`) as LayoutMetrics;
    const label = `${size.width}x${size.height}`;
    if (metrics.documentWidth > metrics.viewportWidth + 1) failures.push(`${label}: horizontal page overflow`);
    const mobileShell = size.width <= 820;
    // 手机端是单屏应用：消息区只保证可读的最小高度，矮视口优先保住输入框。
    const messagesFloor = mobileShell ? 80 : 200;
    if (metrics.messages.height < messagesFloor) failures.push(`${label}: messages only ${Math.round(metrics.messages.height)}px high`);
    if (metrics.messages.height > size.height - 80) failures.push(`${label}: messages are not height-bounded`);
    if (!metrics.composer.visible || metrics.composer.height < 40) failures.push(`${label}: composer unavailable`);
    if (mobileShell) {
      if (!metrics.cards.visible) failures.push(`${label}: knowledge cards pane hidden on the mobile classroom`);
      if (metrics.route.height > 0 || metrics.context.height > 0) failures.push(`${label}: mobile route/records must not be stacked on the classroom`);
      const stacked = await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 1);
      if (stacked) failures.push(`${label}: mobile learning view must stay on one screen instead of document scrolling`);
    } else if (!metrics.route.visible || !metrics.cards.visible || !metrics.context.visible) {
      failures.push(`${label}: route, cards, or current-skill context hidden`);
    }
    const panel = await page.locator(".learning-stage").boundingBox();
    const composer = await page.locator("#composer").boundingBox();
    if (!panel || !composer || composer.y + composer.height > size.height + 1) failures.push(`${label}: composer exceeds the available viewport`);
    if (size.width > 820) {
      const rail = await page.locator(".route-card").boundingBox();
      const evidence = await page.locator(".evidence-card").boundingBox();
      if (!rail || rail.width > 214 || !panel || rail.x + rail.width > panel.x) failures.push(`${label}: learning route must stay in the narrower side column`);
      if (!evidence || evidence.y + Math.min(40, evidence.height) > size.height) failures.push(`${label}: evidence heading is pushed below the viewport`);
      // 桌面仍保留代码块横向滚动；手机端的换行规则不得外溢到宽屏。
      const desktopCodeOverflow = await page.evaluate(`(() => {
        const code = document.querySelector(".message-content .code-block pre");
        return code ? getComputedStyle(code).overflowX : "";
      })()`);
      if (desktopCodeOverflow !== "auto") failures.push(`${label}: desktop code blocks must keep horizontal scrolling`);
    }
    await page.locator("#task-focus-toggle").click();
    const cardPane = await page.locator("#task-focus-card").boundingBox();
    if (!cardPane || !panel || cardPane.x < panel.x || cardPane.x + cardPane.width > panel.x + panel.width + 1) failures.push(`${label}: cards do not slide into the shared viewport`);
    if (await page.locator("#conversation-panel").getAttribute("aria-hidden") !== "true") failures.push(`${label}: inactive conversation remains accessible`);
    await page.locator("#conversation-toggle").click();
    if (size.width === 2560 || size.width === 1751) {
      const sidebar = await page.evaluate(() => {
        const rail = document.querySelector(".context-column");
        const description = document.querySelector("#skill-card .skill-description");
        const evidence = document.querySelector(".evidence-card");
        if (!rail || !evidence) throw new Error("Missing right-sidebar element");
        const visibleText = description?.querySelector(".skill-description-preview")?.textContent ?? "";
        const toggle = description?.querySelector(".skill-description-toggle");
        return {
          previewLength: Array.from(visibleText).length,
          hasFullDescription: Boolean(toggle),
          railOverflow: getComputedStyle(rail).overflowY,
          evidenceOverflow: getComputedStyle(evidence).overflowY,
        };
      });
      if (sidebar.previewLength > 100 || !sidebar.hasFullDescription) failures.push(`${label}: skill introduction lacks bounded preview and full-text access`);
      if (!["hidden", "auto"].includes(sidebar.railOverflow)) failures.push(`${label}: right sidebar must remain height-bounded`);
      if (sidebar.evidenceOverflow !== "auto") failures.push(`${label}: evidence card must own the scroll area`);
      const railFill = await page.evaluate(() => {
        const column = document.querySelector(".context-column")?.getBoundingClientRect();
        const cards = [...document.querySelectorAll(".context-column > .surface-card")].map((node) => node.getBoundingClientRect());
        return { columnBottom: column?.bottom ?? 0, lastCardBottom: Math.max(...cards.map((rect) => rect.bottom)) };
      });
      const unoccupied = Math.round(railFill.columnBottom - railFill.lastCardBottom);
      // 有真实记录时证据面板吸收剩余高度：右侧栏不允许再留出无归属的空白区。
      if (unoccupied > 2) failures.push(`${label}: right sidebar leaves ${unoccupied}px unoccupied`);
      if (size.width === 1751) {
        if (process.env.RESPONSIVE_SCREENSHOT_PATH) {
          await page.screenshot({ path: process.env.RESPONSIVE_SCREENSHOT_PATH });
        }
        await page.locator("#skill-card .skill-description-toggle").click();
        const fullDescription = await page.locator("#skill-card .skill-description-full").textContent();
        if (fullDescription !== skillDescription) failures.push(`${label}: expanded introduction is not complete`);
      }
    }
    if (size.width <= 820) {
      if (!metrics.navToggle.visible) failures.push(`${label}: navigation toggle hidden`);
      else {
        await page.locator("#sidebar-toggle").click();
        try {
          await page.locator("#notes-button").waitFor({ state: "visible", timeout: 2000 });
        } catch {
          failures.push(`${label}: notes inaccessible from navigation`);
        }
        await page.locator("#mobile-nav-backdrop").click({ position: { x: size.width - 12, y: 80 } });
      }
      // 手机壳层：底部切换把路线/记录换成整屏界面，再切回课堂时输入框仍在同一屏内。
      const tabs = page.locator("#mobile-surface-tabs button");
      if (await tabs.count() !== 3) failures.push(`${label}: mobile surface bar must expose three entries`);
      const covered = async () => await page.evaluate(`(() => {
        const height = (selector) => {
          const node = document.querySelector(selector);
          if (!node) return 0;
          return getComputedStyle(node).display === "none" ? 0 : Math.round(node.getBoundingClientRect().height);
        };
        return { route: height(".route-card"), context: height(".context-column"), stage: height(".center-column") };
      })()`) as { route: number; context: number; stage: number };
      await page.locator('#mobile-surface-tabs [data-mobile-surface="route"]').click();
      let surfaces = await covered();
      if (surfaces.route <= 0 || surfaces.stage !== 0) failures.push(`${label}: route surface does not replace the classroom`);
      await page.locator('#mobile-surface-tabs [data-mobile-surface="records"]').click();
      surfaces = await covered();
      if (surfaces.context <= 0 || surfaces.route !== 0) failures.push(`${label}: records surface does not replace the route`);
      if (await page.locator('#mobile-surface-tabs [data-mobile-surface="records"]').getAttribute("aria-current") !== "true") failures.push(`${label}: active mobile surface is not announced`);
      await page.locator('#mobile-surface-tabs [data-mobile-surface="learn"]').click();
      surfaces = await covered();
      if (surfaces.stage <= 0 || surfaces.context !== 0) failures.push(`${label}: classroom does not come back from the records surface`);
      const composerAfter = await page.locator("#composer").boundingBox();
      if (!composerAfter || composerAfter.y + composerAfter.height > size.height + 1) failures.push(`${label}: composer lost after switching mobile surfaces`);
      // 手机标题栏：观察入口与任务标题同一行、控制行显示状态短文本，命中区不小于 44px。
      const chrome = await page.evaluate(`(() => {
        const box = (selector) => {
          const node = document.querySelector(selector);
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        };
        const hits = (selector, offsetY) => {
          const node = document.querySelector(selector);
          if (!node) return false;
          const rect = node.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + offsetY);
          return Boolean(hit && node.contains(hit));
        };
        const status = document.querySelector("#connection-status");
        const code = document.querySelector(".message-content .code-block pre");
        const assistantLabel = document.querySelector(".assistant-entry span");
        return {
          heading: box(".learning-stage-heading"),
          observer: box("#study-time-strip"),
          topbarTargets: ["#sidebar-toggle", "#activity-button", "#profile-button", "#new-goal-button"].map(box),
          assistantLabel: assistantLabel ? { text: assistantLabel.textContent.trim(), width: assistantLabel.getBoundingClientRect().width } : null,
          surfaceTabsVisible: getComputedStyle(document.querySelector("#mobile-surface-tabs")).display !== "none",
          tabHit: hits("#conversation-toggle", -3),
          observerHit: hits(".study-observer-trigger", -3),
          toggleHit: hits("[data-study-toggle]", -3),
          statusText: status ? status.textContent.trim() : "",
          statusFontSize: status ? getComputedStyle(status).fontSize : "",
          codeOverflowX: code ? getComputedStyle(code).overflowX : "",
          codeFits: code ? code.scrollWidth <= code.clientWidth + 1 : null,
        };
      })()`) as {
        heading: { x: number; y: number; width: number; height: number } | null;
        observer: { x: number; y: number; width: number; height: number } | null;
        topbarTargets: Array<{ x: number; y: number; width: number; height: number } | null>;
        assistantLabel: { text: string; width: number } | null;
        surfaceTabsVisible: boolean;
        tabHit: boolean;
        observerHit: boolean;
        toggleHit: boolean;
        statusText: string;
        statusFontSize: string;
        codeOverflowX: string;
        codeFits: boolean | null;
      };
      if (!chrome.heading || !chrome.observer || Math.abs(chrome.heading.y - chrome.observer.y) > 12) {
        failures.push(`${label}: observation entry must sit on the task row`);
      }
      for (const target of chrome.topbarTargets) {
        if (!target || target.height < 44 || target.width < 44) failures.push(`${label}: topbar target below 44px`);
      }
      // 助教是图标 + 文字按钮：首次使用只能看到图标时无法知道功能。
      if (chrome.assistantLabel?.text !== "助教" || chrome.assistantLabel.width <= 0) failures.push(`${label}: assistant entry must keep its text label`);
      // 底部三格默认可见，用户第一次进入就能看到界面切换入口。
      if (!chrome.surfaceTabsVisible) failures.push(`${label}: mobile surface tabs must be visible before any scrolling`);
      if (!chrome.tabHit) failures.push(`${label}: learning view tabs hit area below 44px`);
      if (!chrome.observerHit) failures.push(`${label}: observation entry hit area below 44px`);
      if (!chrome.toggleHit) failures.push(`${label}: observation toggle hit area below 44px`);
      if (chrome.statusFontSize === "0px" || !/已保存|已恢复|连接中|老师回复中|切换中|失败|中断/.test(chrome.statusText)) {
        failures.push(`${label}: mobile connection status must stay readable text`);
      }
      if (chrome.codeOverflowX !== "hidden" || chrome.codeFits === false) {
        failures.push(`${label}: mobile code blocks must wrap instead of scrolling sideways`);
      }
      // 底部三格滑到底才出现；输入栏固定不动，只在手势滚动时改变三格显隐。
      const scrollProbe = `(() => {
        const messages = document.querySelector("#messages");
        const composer = document.querySelector(".composer-wrap");
        return {
          tabsHidden: document.body.classList.contains("mobile-tabs-hidden"),
          composerDisplay: composer ? getComputedStyle(composer).display : "none",
          composerHeight: composer ? Math.round(composer.getBoundingClientRect().height) : 0,
          tabsVisible: getComputedStyle(document.querySelector("#mobile-surface-tabs")).display !== "none",
          messagesHeight: Math.round(messages.getBoundingClientRect().height),
          overflow: Math.round(messages.scrollHeight - messages.clientHeight),
          scrollTop: Math.round(messages.scrollTop),
        };
      })()`;
      const messagesBox = await page.locator("#messages").boundingBox();
      await page.evaluate(`(() => { const messages = document.querySelector("#messages"); messages.scrollTop = messages.scrollHeight; })()`);
      await page.waitForTimeout(160);
      const beforeScroll = await page.evaluate(scrollProbe) as { messagesHeight: number; scrollTop: number };
      if (messagesBox) {
        await page.mouse.move(messagesBox.x + messagesBox.width / 2, messagesBox.y + messagesBox.height / 2);
        await page.mouse.wheel(0, -600);
      }
      await page.waitForTimeout(320);
      const composerScroll = await page.evaluate(scrollProbe) as { tabsHidden: boolean; composerDisplay: string; composerHeight: number; tabsVisible: boolean; messagesHeight: number; overflow: number; scrollTop: number };
      await page.mouse.wheel(0, 3000);
      await page.waitForTimeout(320);
      const afterScroll = await page.evaluate(scrollProbe) as { tabsHidden: boolean; composerDisplay: string; tabsVisible: boolean; messagesHeight: number };
      if (composerScroll.scrollTop >= beforeScroll.scrollTop - 4) failures.push(`${label}: gesture scroll must move the lesson view`);
      // 输入栏固定：滚动查看时既不能收起，也不能被挤走。
      if (composerScroll.composerDisplay !== "block" || composerScroll.composerHeight <= 0) {
        failures.push(`${label}: composer must stay fixed while browsing the lesson`);
      }
      // 三格让位是常态；若收起后内容已几乎全部可见（溢出不超过一行的量级），三格回来也是正确结果。
      if (composerScroll.tabsHidden || !composerScroll.tabsVisible) {
        if (composerScroll.messagesHeight <= beforeScroll.messagesHeight) failures.push(`${label}: hidden surface tabs must give the reading area more room`);
      } else if (composerScroll.overflow > 60) {
        failures.push(`${label}: mobile surface tabs must give way until the lesson is scrolled to the bottom`);
      }
      if (afterScroll.tabsHidden || !afterScroll.tabsVisible) failures.push(`${label}: mobile surface tabs must return at the bottom of the lesson`);
      if (afterScroll.composerDisplay !== "block") failures.push(`${label}: composer must stay visible at the bottom of the lesson`);
    }
    if (size.width === 390 || size.width === 320 || size.width === 1535) {
      if (size.width <= 520) {
        await page.locator("#sidebar-toggle").click();
        await page.locator("#settings-button").click();
      } else await page.locator("#provider-status-button").click();
      const dialog = page.locator("#provider-settings-page");
      try {
        await dialog.waitFor({ state: "visible", timeout: 3000 });
      } catch {
        failures.push(`${label}: provider settings cannot open`);
      }
      const modal = await dialog.evaluate((node) => {
        const rect = node.parentElement!.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, overflowY: getComputedStyle(node.parentElement!).overflowY };
      });
      if (size.width > 820) {
        if (modal.top < -1 || modal.bottom > size.height + 1) failures.push(`${label}: provider page exceeds its bounded viewport`);
        if (modal.overflowY !== "auto" && modal.overflowY !== "scroll") failures.push(`${label}: provider page cannot scroll`);
      } else {
        const outer = await page.evaluate(() => ({ overflow: getComputedStyle(document.body).overflowY, scrollable: document.documentElement.scrollHeight > innerHeight }));
        if (modal.overflowY !== "visible" || !["auto", "scroll"].includes(outer.overflow) || !outer.scrollable) failures.push(`${label}: document must own mobile settings scrolling`);
      }
      await page.locator("#save-provider-button").scrollIntoViewIfNeeded();
      const saveRect = await page.locator("#save-provider-button").boundingBox();
      if (!saveRect || saveRect.y < 0 || saveRect.y + saveRect.height > size.height) failures.push(`${label}: provider actions not reachable`);
      await page.locator(".brand").click();
    }
    if (size.width <= 390) {
      await page.locator("#sidebar-toggle").click();
      await page.locator("#notes-button").click();
      const notes = page.locator("#notes-page");
      await notes.waitFor({ state: "visible" });
      const notesGeometry = await notes.evaluate((node) => {
        const modal = node.getBoundingClientRect();
        const content = node.querySelector(".notes-content")?.getBoundingClientRect();
        return { modalBottom: modal.bottom, contentBottom: content?.bottom ?? 0 };
      });
      if (notesGeometry.contentBottom > notesGeometry.modalBottom + 1) {
        failures.push(`${label}: notes dialog content clipped`);
      }
      await page.locator(".brand").click();
      await page.locator("#sidebar-toggle").click();
      await page.locator("#learning-library-button").click();
      const library = page.locator("#learning-library-page");
      await library.waitFor({ state: "visible" });
      const libraryGeometry = await library.evaluate((node) => {
        const modal = node.getBoundingClientRect();
        const content = node.querySelector(".learning-library-content")?.getBoundingClientRect();
        return { modalBottom: modal.bottom, contentBottom: content?.bottom ?? 0 };
      });
      if (libraryGeometry.contentBottom > libraryGeometry.modalBottom + 1) {
        failures.push(`${label}: learning library content clipped`);
      }
      await page.locator(".brand").click();
      await page.locator("#profile-button").click();
      await page.locator("#conversation-library-menu-button").click();
      const conversations = page.locator("#conversation-library-page");
      await conversations.waitFor({ state: "visible" });
      const conversationGeometry = await conversations.evaluate((node) => {
        const modal = node.getBoundingClientRect();
        const content = node.querySelector(".conversation-page-list")?.getBoundingClientRect();
        return { modalBottom: modal.bottom, contentBottom: content?.bottom ?? 0 };
      });
      if (conversationGeometry.contentBottom > conversationGeometry.modalBottom + 1) {
        failures.push(`${label}: conversation library content clipped`);
      }
      await page.locator(".brand").click();
    }
    if (size.width === 1535) {
      await page.locator("#task-focus-toggle").click();
      if (await page.locator("#task-focus-card").getAttribute("aria-hidden") !== "false") failures.push(`${label}: cards tab does not show its pane`);
      await page.locator("#conversation-toggle").click();
      if (await page.locator("#conversation-panel").getAttribute("aria-hidden") !== "false") failures.push(`${label}: conversation tab does not restore its pane`);
      await page.locator("#sidebar-toggle").click();
      const collapsedWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      if (collapsedWidth > size.width + 1) failures.push(`${label}: collapsed sidebar causes horizontal overflow`);
    }
    console.log(`${label}: messages=${Math.round(metrics.messages.height)}px, route=${metrics.route.visible}, cards=${metrics.cards.visible}, context=${metrics.context.visible}`);
    await context.close();
  }
  // 已确认但缺少替换标记的旧草案：用户点击「新目标」应补授权并保留原对话。
  const recoveryContext = await browser.newContext({ viewport: { width: 1751, height: 720 }, reducedMotion: "reduce" });
  try {
    const page = await recoveryContext.newPage();
    await mockReadApis(page);
    let sessionPosts = 0;
    let goalPosts = 0;
    const confirmedSession = {
      ...fixtureSession,
      state: {
        ...fixtureSession.state,
        onboarding: { status: "IDLE", replace_existing: false },
        recoverable_confirmed_goal: true,
      },
    };
    await page.route("**/api/web/sessions", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      sessionPosts += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(confirmedSession) });
    });
    await page.route("**/api/web/sessions/*/new-goal", async (route) => {
      goalPosts += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...confirmedSession.state,
          onboarding: { status: "CONFIRMED", replace_existing: true },
          recoverable_confirmed_goal: false,
        }),
      });
    });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator("#skill-card .skill-description-preview").waitFor();
    await page.locator("#new-goal-button").click();
    await page.locator("#confirm-new-goal").click();
    await page.waitForFunction(() => document.querySelector("#messages")?.textContent?.includes("已授权替换当前目标"));
    if (sessionPosts !== 1 || goalPosts !== 1) {
      failures.push(`confirmed-route recovery created ${sessionPosts} sessions and ${goalPosts} goal requests`);
    }
  } finally {
    await recoveryContext.close();
  }
  assert.deepEqual(failures, [], failures.join("\n"));
} finally {
  await browser.close();
}
