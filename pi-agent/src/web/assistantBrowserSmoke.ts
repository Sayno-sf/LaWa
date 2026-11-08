import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { chromium } from "playwright-core";

// 隔离 API 样例覆盖视图与交付状态；不连接 Kernel、Pi、模型或用户摄像头。
const staticDir = resolve(process.env.ASSISTANT_STATIC_DIR ?? "../data/qa/teaching-assistant-web");
const output = resolve(process.env.ASSISTANT_SCREENSHOT_DIR ?? "../data/qa/teaching-assistant-ui");
const requests: string[] = [], errors: string[] = [];
const skills = [{ id: "async", name: "理解异步请求", description: "解释请求、等待与继续执行的关系。", status: "LEARNING", target_depth: "PRACTICAL", evidence_ids: [] }];
let taskId = "task-1", assistantBusy = false;
let stopReply: (() => void) | undefined;
const consultation = new Map<string, Array<{ id: string; role: "user" | "assistant"; content: string }>>();
const teacherMessages = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "user" : "assistant", content: i === 9 ? "我准备先自己解释。" : `## 请求发出后会发生什么？\n\n请用自己的话解释：调用 \`await fetch(url)\` 后，程序会怎样继续？\n\n${"先思考请求、等待与结果之间的关系。\n\n".repeat(3)}` }));
const state = () => ({ view_mode: "CURRENT", active_goal_id: "goal-1", overview: { current_goal: "理解异步请求，独立解释执行过程", current_goal_skill_ids: ["async"], skills,
  curriculum_spine: skills, recent_evidence: [], knowledge_cards: [{ id: "card-1", skill_id: "async", question: "await 是什么意思？", answer: "等待异步结果后，再继续这个函数。", feedback: null, learner_note: null, source_conversation_id: null, created_at: "2026-10-12T00:00:00Z" }],
  current_frontier: { focus_skill_id: "async", supporting_skill_ids: [], reason: "", target_depth: "PRACTICAL", next_action: "" }, active_task: { id: taskId, title: taskId === "task-1" ? "解释请求与等待" : "比较两个并发请求", description: "", related_skill_ids: ["async"], status: "ACTIVE" } },
  teaching: { active_skill_id: "async", teaching_mode: "CHECK_UNDERSTANDING" }, onboarding: { status: "IDLE", replace_existing: false }, recommended_action: null });
const snapshot = () => ({ available: true, scope: { goalId: "goal-1", taskId, skillId: "async", attemptId: taskId, mainSessionId: "assistant-fixture" }, messages: consultation.get(taskId) ?? [], busy: assistantBusy, teacher_busy: false });
const session = () => ({ sessionId: "assistant-fixture", messages: teacherMessages, state: state() });
const provider = { provider: "fixture", model: "隔离样例", baseUrl: "https://example.invalid/v1", thinkingLevel: "off", maxOutputTokens: 32768, hasApiKey: false, apiKeyHint: null };
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const json = (body: unknown, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
  const body = async () => { let value = ""; for await (const part of request) value += String(part); return JSON.parse(value || "{}"); };
  try {
    if (url.pathname.startsWith("/api/")) {
      requests.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/api/web/sessions") return json(request.method === "POST" ? session() : { activeSessionId: "assistant-fixture", sessions: [{ id: "assistant-fixture", name: "理解异步请求", goalId: "goal-1", goalDescription: "理解异步请求", active: true, updatedAt: "2026-10-12T00:00:00Z", messageCount: teacherMessages.length }] });
      if (url.pathname.endsWith("/assistant/stop")) { stopReply?.(); return json({ ok: true }); }
      if (url.pathname.endsWith("/assistant")) {
        if (request.method === "GET") return json(snapshot());
        const { text } = await body();
        if (text === "失败样例") return json({ detail: "助教暂时不可用，请重试。" }, 503);
        assistantBusy = true;
        const target = taskId, messages = consultation.get(target) ?? [];
        const reply = { id: `reply-${messages.length}`, role: "assistant" as const, content: "可以把 await 理解为：这个函数先等待结果，再接着执行。\n\n" };
        messages.push({ id: `question-${messages.length}`, role: "user", content: text }, reply); consultation.set(target, messages);
        response.writeHead(200, { "Content-Type": "application/x-ndjson" });
        response.write(JSON.stringify({ type: "assistant_state", assistant: { ...snapshot(), messages: messages.slice(0, -1) } }) + "\n");
        response.write(JSON.stringify({ type: "text_delta", text: reply.content }) + "\n");
        if (text === "请慢慢解释") await new Promise<void>(done => { const timer = setTimeout(done, 5000); stopReply = () => { clearTimeout(timer); done(); }; });
        else await new Promise(done => setTimeout(done, 150));
        stopReply = undefined; assistantBusy = false;
        response.end(JSON.stringify({ type: "assistant_state", assistant: snapshot() }) + "\n" + JSON.stringify({ type: "done" }) + "\n"); return;
      }
      if (url.pathname.endsWith("/messages")) {
        stopReply?.();
        const { message } = await body();
        if (message === "下一任务") taskId = "task-2";
        else if (message === "原任务") taskId = "task-1";
        response.writeHead(200, { "Content-Type": "application/x-ndjson" });
        response.end(JSON.stringify({ type: "state", state: state() }) + "\n" + JSON.stringify({ type: "assistant_delta", delta: "我们继续当前练习。" }) + "\n"); return;
      }
      if (url.pathname.endsWith("/state")) return json(state());
      if (url.pathname === "/api/web/provider-settings") return json({ activeProfileId: null, active: provider, profiles: [] });
      if (url.pathname === "/api/web/speech-settings") return json({ enabled: false, profileId: null, region: "beijing", asrModel: "qwen3-asr-flash", ttsModel: "qwen3-tts-flash", voice: "Cherry" });
      if (url.pathname === "/api/web/materials") return json({ materials: [] });
      if (url.pathname === "/api/web/retrieval-status") return json({ enabled: false, chunks: 0, building_generation: null, warning: null, sources: [] });
      if (url.pathname === "/api/web/learning-library") return json({ projects: [] });
      if (url.pathname === "/api/web/study-time") return json({ recording: false, scope: null, taskFocusedMs: 0, taskWaitingMs: 0, goalFocusedMs: 0, runFocusedMs: 0 });
      return json({ detail: "隔离样例禁止该操作。" }, 400);
    }
    const path = resolve(staticDir, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!path.startsWith(staticDir + sep)) { response.writeHead(403); response.end(); return; }
    const bytes = await readFile(path); response.writeHead(200, { "Content-Type": ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2" } as Record<string, string>)[extname(path)] ?? "application/octet-stream" }); response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.RESPONSIVE_BROWSER_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
try {
  await mkdir(output, { recursive: true });
  for (const [width, height] of [[1920, 1080], [1535, 900], [390, 844], [320, 640]]) {
    const context = await browser.newContext({ viewport: { width: width!, height: height! }, reducedMotion: "reduce" });
    await context.addInitScript(() => { localStorage.setItem("learn-anything:intro-watched:v1", "true"); localStorage.setItem("learn-anything:task-focus-collapsed", "true"); });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    await page.goto(base); await page.locator("#learning-intro").waitFor({ state: "detached" }); await page.locator('#connection-status[data-status="ready"]').waitFor();
    await page.locator("#message-input").fill("我的独立作答草稿");
    assert.equal(await page.locator("#message-input").inputValue(), "我的独立作答草稿", "teacher draft filled before opening TA");
    const original = await page.locator("#messages").innerText();
    await page.locator("#messages").evaluate(node => { node.scrollTop = 60; });
    const scroll = await page.locator("#messages").evaluate(node => node.scrollTop);
    const beforePosts = requests.filter(value => value.startsWith("POST") && value.endsWith("/messages")).length;
    await page.locator("#assistant-entry").click(); await page.locator("#assistant-input:enabled").waitFor();
    await page.waitForFunction(() => !document.querySelector("#assistant-status")?.textContent?.includes("恢复"));
    assert.equal(await page.locator("#assistant-panel").isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: no overflow`);
    assert.equal(await page.locator("#conversation-panel").evaluate(node => (node as HTMLElement).inert), width! <= 1750);
    const mainBox = await page.locator(".learning-stage").boundingBox(), assistBox = await page.locator("#assistant-panel").boundingBox();
    assert.ok(mainBox && assistBox);
    if (width! > 1750) assert.ok(assistBox.x >= mainBox.x + mainBox.width, "TA reuses right supplement area");
    assert.equal(await page.locator("#message-input").inputValue(), "我的独立作答草稿", "teacher draft after opening TA");
    await page.locator("#assistant-input").fill("await 为什么要等待？");
    await page.screenshot({ path: resolve(output, `${width}-assistant-open.png`) });
    await page.locator("#assistant-close").click();
    assert.equal(await page.locator("#message-input").inputValue(), "我的独立作答草稿");
    assert.equal(await page.locator("#messages").innerText(), original);
    assert.equal(await page.locator("#messages").evaluate(node => node.scrollTop), scroll);
    assert.equal(requests.filter(value => value.startsWith("POST") && value.endsWith("/messages")).length, beforePosts, "view changes never invoke teacher");
    await page.locator("#assistant-entry").click(); assert.equal(await page.locator("#assistant-input").inputValue(), "await 为什么要等待？");
    await page.locator("#assistant-send").click(); await page.waitForFunction(() => document.querySelectorAll(".assistant-message").length >= 2 && document.querySelector("#assistant-stop")?.hasAttribute("hidden"));
    assert.match(await page.locator("#assistant-messages").innerText(), /这个函数先等待结果/);
    await page.screenshot({ path: resolve(output, `${width}-assistant-answer.png`) });
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 1535, height: 900 }, reducedMotion: "reduce" });
  await context.addInitScript(() => { localStorage.setItem("learn-anything:intro-watched:v1", "true"); localStorage.setItem("learn-anything:task-focus-collapsed", "true"); });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.goto(base); await page.locator("#learning-intro").waitFor({ state: "detached" }); await page.locator('#connection-status[data-status="ready"]').waitFor(); await page.locator("#assistant-entry").click();
  await page.waitForFunction(() => !document.querySelector("#assistant-status")?.textContent?.includes("恢复"));
  await page.locator("#assistant-input").fill("请慢慢解释"); await page.locator("#assistant-send").click(); await page.locator("#assistant-stop").waitFor();
  assert.equal(await page.locator("#send-button").isDisabled(), false, "valid teacher submission can seal in-flight TA generation");
  await page.locator("#assistant-close").click();
  await page.locator("#message-input").fill("我的实际解释");await page.locator("#send-button").click();
  await page.locator('#connection-status[data-status="ready"]').waitFor();await page.locator("#assistant-entry").click();await page.locator("#assistant-send").waitFor();
  assert.match(await page.locator("#assistant-messages").innerText(), /先等待结果/);
  await page.locator("#assistant-input").fill("失败样例"); await page.locator("#assistant-send").click(); await page.locator("#assistant-status.assistant-status-error").waitFor();
  assert.equal(await page.locator("#assistant-input").inputValue(), "失败样例"); await page.screenshot({ path: resolve(output, "error-draft.png") });
  await page.locator("#assistant-input").fill("原任务助教草稿");
  await page.locator("#assistant-close").click(); await page.locator("#message-input").fill("下一任务"); await page.locator("#send-button").click();
  await page.locator('#connection-status[data-status="ready"]').waitFor(); await page.locator("#assistant-entry").click();
  await page.waitForFunction(() => document.querySelector("#assistant-source")?.textContent === "比较两个并发请求" && !document.querySelector("#assistant-status")?.textContent?.includes("恢复"));
  assert.equal(await page.locator("#assistant-input").inputValue(), ""); assert.equal(await page.locator(".assistant-message").count(), 0);
  await page.locator("#assistant-close").click(); await page.locator("#message-input").fill("原任务"); await page.locator("#send-button").click(); await page.locator('#connection-status[data-status="ready"]').waitFor(); await page.locator("#assistant-entry").click();
  await page.waitForFunction(() => (document.querySelector("#assistant-input") as HTMLTextAreaElement)?.value === "原任务助教草稿");
  await page.locator("#assistant-panel").press("Escape"); assert.equal(await page.locator("#assistant-panel").isVisible(), false);
  await context.close();
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, "report.json"), JSON.stringify({ errors, viewports: [1920, 1535, 390, 320], requests, checks: ["draft-scroll-main-question-preserved", "scope-drafts", "teacher-submits-during-assistant-stream", "stop-keeps-partial-answer", "error-restores-draft", "keyboard-close", "no-overflow"] }, null, 2));
  console.log("TA browser UI passed: 1920/1535/390/320, natural expansion, drafts/scroll/task scope, mutual generation, stop/error and keyboard.");
} finally { await browser.close(); await new Promise<void>(done => server.close(() => done())); }
