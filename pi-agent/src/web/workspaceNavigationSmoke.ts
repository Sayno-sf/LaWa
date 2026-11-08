import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";

const baseUrl = process.env.WORKSPACE_BASE_URL ?? "http://127.0.0.1:8787";
const screenshotDir = process.env.WORKSPACE_SCREENSHOT_DIR;
const browser = await chromium.launch({ executablePath: process.env.RESPONSIVE_BROWSER_PATH
  ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
const timestamp = "2026-10-01T12:00:00Z";
const provider = { provider: "fixture", model: "teaching-model", baseUrl: "https://example.invalid/v1", thinkingLevel: "off", maxOutputTokens: 32768, hasApiKey: true, apiKeyHint: "fixture" };
const skills = ["理解问题", "拆解与实践", "独立完成"].map((name, i) => ({
  id: `skill-${i}`, name, description: "用自己的语言说明问题，找到清晰的下一步，再通过实践检验理解。",
  status: i === 0 ? "LEARNING" : "NOT_STARTED", target_depth: "PRACTICAL", evidence_ids: [],
}));
const cards = skills.map((skill, i) => ({ id: `card-${i}`, skill_id: skill.id,
  question: ["为什么要先把问题说清楚？", "怎样把一个目标拆成可执行的一步？", "如何判断自己已经能够独立完成？"][i],
  answer: "先说明目标和当前情况，找出差距，用一个具体行动验证自己的想法。",
  learner_note: "我可以先用自己的话描述问题，再做一个小练习验证。理解需要经过实践，不能只凭熟悉感。",
  source_conversation_id: null, feedback: null, feedback_updated_at: null, note_updated_at: timestamp, created_at: timestamp }));
const evidence = [{ id: "evidence-0", skill_id: skills[0]!.id, evidence_type: "EXPLAIN", assistance_level: "NONE", description: "独立解释了目标、现状与下一步行动的关系。", created_at: timestamp }];
const project = { status: "CURRENT", goal_profile: { id: "goal-0", goal_description: "从想学，到能够独立做到", desired_outcome: "建立清晰的学习方法，用实践检验理解，逐步完成自己的目标。", background_summary: "" },
  curriculum_spine: skills.map((skill, i) => ({ id: `milestone-${i}`, name: skill.name, description: skill.description, target_depth: "PRACTICAL" })), skills, evidence, knowledge_cards: cards, archived_at: null };
const oldProject = { ...project, status: "ARCHIVED", goal_profile: { ...project.goal_profile, id: "goal-old", goal_description: "把学习记录整理成自己的知识" },
  knowledge_cards: [{ ...cards[0]!, id: "card-old" }], archived_at: timestamp };
const fixture = { sessionId: "session-0", messages: Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "user" : "assistant", content: i % 2 ? "我会先做一个小练习，再记录自己的理解。" : "学习从一个清晰的问题开始。\n\n先说说你希望做到什么，再选择眼前的一步，通过尝试来检验理解。" })), state: {
  view_mode: "CURRENT", active_goal_id: "goal-0", overview: { current_goal: project.goal_profile.goal_description,
    current_goal_skill_ids: skills.map((skill) => skill.id), curriculum_spine: project.curriculum_spine,
    current_frontier: { focus_skill_id: "skill-0", supporting_skill_ids: [], reason: "", target_depth: "PRACTICAL", next_action: "" },
    skills, recent_evidence: evidence, knowledge_cards: cards, active_task: { id: "task-0", title: "用自己的话说明问题", description: "", related_skill_ids: ["skill-0"], status: "ACTIVE" } },
  teaching: { active_skill_id: "skill-0", teaching_mode: "EXPLAIN" }, onboarding: { status: "IDLE", replace_existing: false }, recommended_action: null,
} };
const material = { id: "material-0", name: "学习方法与实践记录.md", format: "md", goal_id: "goal-0", unit_count: 30, unit_kind: "line", readable: true, warnings: [] };
const writes: string[] = [];
const errors: string[] = [];
const retrievalSettings={version:1,enabled:true,profileId:"profile-0",embeddingModel:"text-embedding-v4",dimensions:1024,
  embeddingUrl:"https://example.invalid/embeddings",rerankModel:"qwen3-rerank",rerankUrl:"https://example.invalid/reranks",
  minimumRerankScore:.5,profiles:[{id:"profile-0",provider:"fixture",model:"teaching-model"}]};
const retrievalTrace={query:"怎样选择下一步？",scope:"current",timings_ms:{total:120},warnings:[],
  query_refinement:{status:"used",query:"怎样选择下一步？\n检索补充：可执行任务 学习步骤"},
  stages:{bm25:[],rerank_retry:[{name:material.name,goal_name:project.goal_profile.goal_description,snippet:"先说明目标，再做一个小练习。",
    score:.82,locator:{kind:"line",start:3,end:5}}]},reads:[{citation:material.name+"，第 3–5 行"}]};
let providerReads = 0;
let currentSession = fixture;

// 所有 API 在浏览器边界替换，只读取本地构建资源，不接触用户账本或调用教学模型。
async function openPage(width: number, height: number): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
  await context.addInitScript(() => localStorage.setItem("learn-anything:intro-watched:v1", "true"));
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    let payload: unknown;
    if (req.method() !== "GET") writes.push(`${req.method()} ${path}`);
    if (path === "/api/web/sessions" && req.method() === "POST") {
      assert.deepEqual(req.postDataJSON(), { mode: "resume-recent" });
      payload = currentSession;
    } else if (path === "/api/web/sessions") {
      payload = { activeSessionId: currentSession.sessionId, sessions: [fixture.sessionId, "session-old"].map((id, i) => ({ id, name: i ? "之前的学习对话" : "继续当前学习", createdAt: timestamp, updatedAt: timestamp,
        messageCount: 12, preview: "学习与实践", goalId: "goal-0", goalDescription: project.goal_profile.goal_description, goalObservedAt: timestamp, active: id === currentSession.sessionId })) };
    } else if (path === "/api/web/provider-settings") {
      providerReads++;
      payload = { activeProfileId: "profile-0", active: provider, profiles: [{ ...provider, id: "profile-0", name: "我的教学模型" }] };
    } else if(path==="/api/web/speech-settings") payload={enabled:false,profileId:null,region:"beijing",asrModel:"qwen3-asr-flash",ttsModel:"qwen3-tts-flash",voice:"Cherry"};
    else if(path==="/api/web/study-time") payload={scope:null,taskFocusedMs:0,goalFocusedMs:0,runFocusedMs:0,taskObservedMs:0,taskWaitingMs:0,observation:"UNKNOWN",recording:false};
    else if(path==="/api/web/retrieval-settings") payload=retrievalSettings;
    else if(path==="/api/web/retrieval-status") payload={enabled:true,chunks:3,building_generation:null,warning:null,
      sources:[{source_id:"material:"+material.id,state:"ready",derived:{graph:{state:"ready",completed:178,total:178,
        relations:169,rejected_relations:446,rejection_reasons:{quote_not_exact:200,endpoint_not_grounded:246}}}}]};
    else if(path==="/api/web/retrieval-traces") payload=new URL(req.url()).searchParams.has("id")?retrievalTrace:
      [{id:"fixture-trace",at:timestamp,query:retrievalTrace.query,scope:"current",warnings:[]}];
    else if (path === "/api/web/learning-library") payload = { projects: [project, oldProject] };
    else if (path === "/api/web/recycle") payload = { items: [] };
    else if (path === "/api/web/materials") payload = { materials: [material] };
    else if (path === "/api/web/materials/material-0") payload = { text: "从目标开始，选择可执行的一步。\n".repeat(35), citation: "学习方法与实践记录.md · 第 1–30 行", truncated: false };
    else if (path === "/api/web/cards/card-0/note") {
      cards[0]!.learner_note = req.postDataJSON().note;
      payload = cards[0];
    } else if (/\/goals\/[^/]+\/activate$/.test(path)) {
      currentSession = { ...fixture, state: { ...fixture.state, active_goal_id: path.includes("goal-old") ? "goal-old" : "goal-0", overview: { ...fixture.state.overview, knowledge_cards: path.includes("goal-old") ? oldProject.knowledge_cards : cards } } };
      payload = currentSession;
    } else if (path === "/api/web/sessions/session-old/activate") {
      currentSession = { ...fixture, sessionId: "session-old" };
      payload = currentSession;
    } else if (path === "/api/web/classroom/snapshot") {
      // 课堂只读订阅不参与界面切换断言，返回空快照即可。
      payload = { session: null, run: null, version: null, sequence: 0 };
    } else if (path === "/api/web/teaching") {
      payload = { proposals: [], current_goal_id: null };
    } else if (path === "/api/web/classroom/events") {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: ": fixture stream\n\n" });
      return;
    } else throw new Error(`Unexpected API ${req.method()} ${path}`);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#learning-intro").waitFor({ state: "detached" });
  // 手机端首屏是课堂界面，路线入口在「路线」界面里；桌面端两者同屏可见。
  if (page.viewportSize()!.width <= 820) await page.locator("#composer").waitFor();
  else await page.locator("#route-materials button").waitFor();
  return page;
}
async function view(page: Page, name: string): Promise<void> {
  await page.waitForFunction((value) => document.body.dataset.workspace === value, name);
  assert.equal(await page.locator("main [data-workspace-view]:visible").count(), 1);
  assert.equal(await page.locator("dialog[open]").count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${name}: horizontal overflow`);
}
async function nav(page: Page, name: string): Promise<void> {
  if (page.viewportSize()!.width <= 820) await page.locator("#sidebar-toggle").click();
  await page.locator(`.nav-item[data-workspace-target="${name}"]`).click();
  await view(page, name);
  assert.equal(await page.locator(`.nav-item[data-workspace-target="${name}"]`).getAttribute("aria-current"), "page");
  assert.equal(await page.locator("body").evaluate((node) => node.classList.contains("mobile-nav-open")), false);
}
async function capture(page: Page, name: string): Promise<void> {
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `${name}.png`) });
}

async function verifyNewGoalEntry(page: Page): Promise<void> {
  const button = page.locator(".topbar-actions > #new-goal-button");
  assert.equal(await button.isVisible(), true, "new goal must be available without opening a menu");
  const box = await button.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= page.viewportSize()!.width, "new goal must fit in the header");
  const before = writes.length;
  await button.click();
  await page.locator("#new-goal-dialog").waitFor({ state: "visible" });
  await page.locator('#new-goal-dialog button[value="cancel"]').click();
  assert.equal(writes.length, before, "opening and cancelling the confirmation must preserve the learning session");
}

try {
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  const page = await openPage(1535, 900);
  await view(page, "learn");
  await verifyNewGoalEntry(page);
  assert.equal(await page.locator("[data-icon]").count(), 0, "all static icons should be mounted");
  assert.equal(await page.locator('#task-focus-toggle [data-icon-name="cards"]').count(), 1);
  assert.equal(await page.locator('#conversation-toggle [data-icon-name="chat"]').count(), 1);
  await page.locator("#message-input").fill("尚未发送的学习想法");
  await page.locator("#messages").evaluate((node) => { node.scrollTop = 120; });
  const chatScroll = await page.locator("#messages").evaluate((node) => node.scrollTop);
  assert.ok(chatScroll > 0, "the scroll-restoration fixture must have scrolled chat content");
  assert.equal(await page.locator("#activity-panel").isVisible(), false, "zero tool activities must not occupy the learning area");
  await capture(page, "desktop-learning-conversation");
  // 同时检查真实过渡和系统减少动态效果，防止只有选中颜色变化而没有横向滑动。
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator("#task-focus-toggle").click();
  await page.waitForFunction(() => {
    const track = document.querySelector<HTMLElement>(".learning-stage-track")!;
    const x = new DOMMatrix(getComputedStyle(track).transform).m41;
    return x < -1 && x > -track.clientWidth + 1;
  });
  await page.waitForFunction(() => {
    const track = document.querySelector<HTMLElement>(".learning-stage-track")!;
    return Math.abs(new DOMMatrix(getComputedStyle(track).transform).m41 + track.clientWidth) < 1;
  });
  await page.locator("#conversation-toggle").click();
  await page.waitForFunction(() => Math.abs(new DOMMatrix(getComputedStyle(document.querySelector(".learning-stage-track")!).transform).m41) < 1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.locator(".learning-stage-track").evaluate((node) => getComputedStyle(node).transitionDuration), "0s");
  assert.equal(await page.locator("#message-input").inputValue(), "尚未发送的学习想法");
  assert.equal(await page.locator("#messages").evaluate((node) => node.scrollTop), chatScroll);
  await capture(page, "desktop-learning");
  const baselineWrites = writes.length;
  await nav(page, "library");
  await page.locator(".learning-project-card").first().locator("summary").first().click();
  await capture(page, "desktop-library");
  await nav(page, "notes");
  await page.locator('#notes-content [data-card-action="edit-note"]').first().click();
  await page.locator('#notes-content textarea').fill("保留这条尚未保存的笔记");
  await nav(page, "settings");
  await page.locator("#retrieval-settings > summary").click();
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('#retrieval-settings-form [name="embeddingModel"]')?.value==="text-embedding-v4");
  assert.match(await page.locator("#retrieval-settings").textContent()??"",/启用云端语义检索、精排与问题整理/);
  await page.locator('#retrieval-settings-form [name="embeddingModel"]').fill("unsaved-embedding");
  await page.locator("#model-input").fill("unsaved-model");
  await page.locator("#api-key-input").fill("synthetic-unsaved-key");
  await nav(page, "learn");
  await page.waitForTimeout(80);
  assert.equal(await page.locator("#message-input").inputValue(), "尚未发送的学习想法");
  assert.equal(await page.locator("#messages").evaluate((node) => node.scrollTop), chatScroll);
  await page.goBack(); await view(page, "settings");
  assert.equal(await page.locator("#model-input").inputValue(), "unsaved-model");
  assert.equal(await page.locator("#api-key-input").inputValue(), "synthetic-unsaved-key");
  assert.equal(await page.locator('#retrieval-settings-form [name="embeddingModel"]').inputValue(),"unsaved-embedding");
  await page.goBack(); await view(page, "notes");
  assert.equal(await page.locator('#notes-content textarea').inputValue(), "保留这条尚未保存的笔记");
  await page.goForward(); await view(page, "settings");
  assert.equal(providerReads, 1, "navigation must not reset the settings editor");
  assert.equal(await page.locator(".provider-profile-item").first().evaluate((node) => node.getBoundingClientRect().right <= node.closest(".provider-profile-panel")!.getBoundingClientRect().right), true, "long profile descriptions must stay in their column");
  assert.equal(writes.length, baselineWrites, "navigation must not mutate Session, Goal, notes, or teaching");
  await capture(page, "desktop-settings");
  // 同一卡片在两个持续保留的视图内编辑时，保存必须读取用户当前所在页的草稿。
  await nav(page, "learn");
  await page.locator("#task-focus-toggle").click();
  await page.locator('#knowledge-cards-panel [data-card-action="flip"]').first().click();
  await page.locator('#knowledge-cards-panel [data-card-action="edit-note"]').first().click();
  await page.locator('#knowledge-cards-panel textarea').fill("另一份卡片编辑草稿");
  // 滑动只切展示：按钮重复点击、键盘往返保留卡片编辑、输入和独立滚动。
  const beforeTabs = writes.length;
  await page.locator("#knowledge-cards-panel").evaluate((node) => { node.scrollTop = 48; });
  const cardsScroll = await page.locator("#knowledge-cards-panel").evaluate((node) => node.scrollTop);
  await page.locator("#task-focus-toggle").click();
  assert.equal(await page.locator("#task-focus-toggle").getAttribute("aria-selected"), "true");
  await page.locator("#conversation-toggle").click();
  assert.equal(await page.locator("#task-focus-card").evaluate((node) => (node as HTMLElement).inert), true);
  assert.equal(await page.locator("#message-input").inputValue(), "尚未发送的学习想法");
  assert.equal(await page.locator("#messages").evaluate((node) => node.scrollTop), chatScroll);
  await page.locator("#conversation-toggle").press("ArrowRight");
  assert.equal(await page.locator("#task-focus-toggle").getAttribute("aria-selected"), "true");
  assert.equal(await page.locator('#knowledge-cards-panel textarea').inputValue(), "另一份卡片编辑草稿");
  assert.equal(await page.locator("#knowledge-cards-panel").evaluate((node) => node.scrollTop), cardsScroll);
  await page.locator("#task-focus-toggle").press("Home");
  assert.equal(await page.locator("#conversation-toggle").getAttribute("aria-selected"), "true");
  await page.locator("#conversation-toggle").press("End");
  assert.equal(await page.locator("#task-focus-toggle").getAttribute("aria-selected"), "true");
  assert.equal(writes.length, beforeTabs, "tab changes must not call teaching or mutate learning data");
  await capture(page, "desktop-learning-cards");
  await nav(page, "notes");
  await page.locator('#notes-content [data-card-action="save-note"]').click();
  await page.locator('#notes-content textarea').waitFor({ state: "detached" });
  assert.equal(cards[0]!.learner_note, "保留这条尚未保存的笔记");
  await page.locator('#notes-content [data-card-action="open-card"][data-card-id="card-0"]').click();
  await view(page, "learn");
  assert.equal(await page.locator("body").evaluate((node) => node.classList.contains("task-focus-collapsed")), false);
  if (page.viewportSize()!.width <= 820) {
    await page.locator('#mobile-surface-tabs [data-mobile-surface="route"]').click();
    await page.locator("#skill-route").waitFor({ state: "visible" });
  }
  await page.locator("#route-materials button").click(); await view(page, "materials");
  await page.getByText(/169 条关系已纳入/).waitFor();
  assert.match(await page.getByText(/169 条关系已纳入/).textContent()??"", /446 条未通过校验.*引文不一致 200.*端点缺少出处 246/);
  await capture(page,"desktop-graph-status");
  await page.locator("#retrieval-diagnostics > summary").click();
  await page.locator("#retrieval-trace-content").getByText(/实际阅读/).waitFor();
  assert.match(await page.locator("#retrieval-trace-content").textContent()??"",/怎样选择下一步/);
  assert.match(await page.locator("#retrieval-trace-content").textContent()??"",/第 3–5 行/);
  assert.match(await page.locator("#retrieval-trace-content").textContent()??"",/检索补充（原问题精排）/);
  assert.match(await page.locator("#retrieval-trace-content").textContent()??"",/重查 · 精排结果/);
  await capture(page,"desktop-retrieval-refinement");
  await page.locator('[data-material-action="read"]').click();
  await page.locator("#material-preview").waitFor({ state: "visible" });
  assert.match(await page.locator("#material-preview-text").textContent() ?? "", /选择可执行/);
  await page.locator('[data-material-action="attach"]').click(); await view(page, "learn");
  await page.waitForTimeout(80);
  assert.match(await page.locator("#message-input").inputValue(), /尚未发送的学习想法[\s\S]*material_id: material-0/);
  assert.equal(await page.locator("#message-input").evaluate((node) => node === document.activeElement), true);
  await page.locator("#profile-button").click(); await page.locator("#conversation-library-menu-button").click(); await view(page, "conversations");
  await page.locator('#conversation-page-list [data-session-id="session-old"][data-conversation-action="activate"]').click(); await view(page, "learn");
  assert.equal(currentSession.sessionId, "session-old");
  await nav(page, "library");
  await page.locator('[data-library-action="goal"][data-goal="goal-0"]').click(); await view(page, "learn");
  await nav(page, "notes");
  await page.locator('#notes-content [data-card-action="open-card"][data-card-id="card-old"]').click(); await view(page, "learn");
  assert.equal(currentSession.state.active_goal_id, "goal-old");
  await nav(page, "settings"); await page.reload(); await view(page, "settings");
  await page.locator("#learning-intro").waitFor({ state: "detached" });
  await page.context().close();
  for (const [width, height] of [[320, 640], [390, 844], [844, 390], [2560, 1440]]) {
    const sized = await openPage(width!, height!);
    await verifyNewGoalEntry(sized);
    assert.equal(await sized.locator(".hero-card").isVisible(), false, "learning space uses the compact shared header");
    if (width! <= 820) {
      // 手机端是单屏应用：学习界面自己滚，文档只在学习库/笔记等独立页滚动。
      assert.equal(await sized.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), true, "mobile learning view must stay on one screen");
      assert.equal(await sized.locator('.context-column').evaluate(node => getComputedStyle(node).overflowY), "auto");
      assert.equal(await sized.locator('#skill-card').evaluate(node => getComputedStyle(node).overflowY), "visible");
      assert.equal(await sized.locator('.route-card').isVisible(), false, "route surface stays off the classroom screen");
      await sized.locator("#messages").evaluate(node => { node.scrollTop = 140; });
      await sized.locator('#mobile-surface-tabs [data-mobile-surface="route"]').click();
      await sized.locator("#skill-route").waitFor({ state: "visible" });
      assert.equal(await sized.locator(".center-column").isVisible(), false, "classroom hidden while the route surface is open");
      await sized.locator('#mobile-surface-tabs [data-mobile-surface="records"]').click();
      await sized.locator("#skill-card").waitFor({ state: "visible" });
      assert.equal(await sized.locator(".route-card").isVisible(), false, "route surface unmounted from the records screen");
      await sized.locator('#mobile-surface-tabs [data-mobile-surface="learn"]').click();
      await sized.locator(".center-column").waitFor({ state: "visible" });
      await sized.waitForFunction(() => (document.querySelector("#messages") as HTMLElement).scrollTop === 140);
      await nav(sized, "notes");
      await sized.evaluate(() => window.scrollTo(0, 320));
      const pageScroll = await sized.evaluate(() => window.scrollY);
      assert.ok(pageScroll > 0, "mobile workspace pages must still scroll the document");
      await nav(sized, "learn");
      assert.equal(await sized.evaluate(() => window.scrollY), 0, "coming back to the classroom starts on one screen");
      await nav(sized, "notes");
      await sized.waitForFunction(top => Math.abs(window.scrollY - top) < 2, pageScroll);
      await nav(sized, "learn");
      await sized.locator('#profile-button').click(); await sized.locator('#conversation-library-menu-button').click(); await view(sized, "conversations");
      const more = sized.locator('#conversation-page-list .conversation-more').first();
      await more.locator('summary').click();
      const action = await more.locator('button').last().boundingBox();
      assert.ok(action && action.width >= 100 && action.height >= 44, "mobile more-menu keeps full-width readable actions");
      await nav(sized, "learn");
      await sized.evaluate(() => window.scrollTo(0, 0));
    }
    await capture(sized, `${width}-learning`);
    if (width! <= 820) {
      await sized.locator('#mobile-surface-tabs [data-mobile-surface="route"]').click();
      await sized.locator("#skill-route").waitFor({ state: "visible" });
    }
    await sized.locator("#route-materials button").click(); await view(sized, "materials");
    await sized.getByText(/169 条关系已纳入/).waitFor();
    assert.equal(await sized.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "graph status fits narrow material views");
    await capture(sized, `${width}-graph-status`);
    await nav(sized, "learn");
    if (width! <= 820) {
      // 从资料页回到学习时界面记忆保留，这里显式回到课堂界面再验证输入框位置。
      await sized.locator('#mobile-surface-tabs [data-mobile-surface="learn"]').click();
      await sized.locator(".center-column").waitFor({ state: "visible" });
    }
    if (width === 390) {
      await sized.setViewportSize({ width: 390, height: 360 });
      const input = await sized.locator("#composer").boundingBox();
      assert.ok(input && input.y + input.height <= 360, "reduced mobile height must keep the composer reachable");
      assert.equal(await sized.locator("#conversation-toggle").isVisible(), true);
      assert.equal(await sized.locator("#task-focus-toggle").isVisible(), true);
      await sized.setViewportSize({ width: width!, height: height! });
    }
    for (const name of ["library", "notes", "settings"]) {
      await nav(sized, name);
      await sized.locator(name === "library" ? ".learning-project-card" : name === "notes" ? ".notes-group" : "#model-input").first().waitFor();
      await capture(sized, `${width}-${name}`);
    }
    await sized.locator(".settings-advanced summary").click();
    await sized.locator("#retrieval-settings > summary").click();
    await sized.locator('#retrieval-settings-form [name="embeddingModel"]').waitFor();
    assert.equal(await sized.locator("body").evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,"retrieval settings fit narrow screens");
    await sized.locator("#save-provider-button").scrollIntoViewIfNeeded();
    const bounds = await sized.locator("#save-provider-button").boundingBox();
    assert.ok(bounds && bounds.y >= 64 && bounds.y + bounds.height <= height! + 1, `${width}: settings actions must be reachable`);
    await sized.context().close();
  }
  assert.deepEqual(errors, []);
  assert.equal(writes.some((entry) => /messages|review|new-goal/.test(entry)), false);
  console.log("Workspace navigation passed: six main views; history/reload; drafts/scroll; notes/cards; goals/conversations; material preview/attach; four responsive sizes; no automatic teaching.");
} finally { await browser.close(); }
