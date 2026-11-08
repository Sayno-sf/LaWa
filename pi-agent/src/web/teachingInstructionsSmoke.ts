import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium, type Page } from "playwright-core";

/**
 * 教学安排页「自定义提示词」隔离验收：只提供构建资源和浏览器内 fixture，
 * 不读取真实学习账本、不调用教师模型。验证读写、清空、失败保留和窄屏排版。
 */

const staticDir = resolve(process.env.TEACHING_INSTRUCTIONS_STATIC_DIR ?? "../data/qa/teaching-instructions-web");
const screenshotDir = process.env.TEACHING_INSTRUCTIONS_SCREENSHOT_DIR;
const timestamp = "2026-10-19T12:00:00Z";
const maxChars = 4000;
const provider = { provider: "fixture", model: "fixture", thinkingLevel: "off", maxOutputTokens: 32768, hasApiKey: false };
const session = {
  sessionId: "instructions-session",
  messages: [{ role: "assistant", content: "我们从一个具体问题开始。", created_at: timestamp }],
  state: {
    view_mode: "CURRENT", active_goal_id: "goal-1", view_goal_id: "goal-1",
    overview: {
      current_goal: "读懂 JS 语法", current_goal_skill_ids: ["skill-0"],
      skills: [{ id: "skill-0", name: "读懂 JS 语法", description: "先看例子，再总结规则。", status: "LEARNING", target_depth: "APPLY", evidence_ids: [] }],
      curriculum_spine: [], recent_evidence: [], knowledge_cards: [],
      current_frontier: { focus_skill_id: "skill-0", supporting_skill_ids: [], reason: "", target_depth: "APPLY", next_action: "" },
      active_task: { id: "task-1", title: "读懂一段入口代码", description: "", related_skill_ids: ["skill-0"], status: "ACTIVE" },
    },
    teaching: { active_skill_id: "skill-0", teaching_mode: "EXPLAIN" },
    onboarding: { status: "IDLE", replace_existing: false }, recommended_action: null,
  },
};

const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".webp": "image/webp", ".wasm": "application/wasm", ".json": "application/json", ".task": "application/octet-stream" };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = resolve(staticDir, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!path.startsWith(staticDir + sep)) { response.writeHead(403); response.end(); return; }
    const bytes = await readFile(path);
    response.writeHead(200, { "Content-Type": mime[extname(path)] ?? "application/octet-stream" });
    response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise<void>(done => server.listen(Number(process.env.TEACHING_INSTRUCTIONS_PORT ?? 19996), "127.0.0.1", done));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.RESPONSIVE_BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
const errors: string[] = [];
const failures: string[] = [];
try {
  for (const [width, height] of [[1535, 900], [390, 844]] as const) {
    const label = `${width}x${height}`;
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
    await context.addInitScript(() => localStorage.setItem("learn-anything:intro-watched:v1", "true"));
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(`${label}: ${error.message}`));
    let saved = { text: "", updatedAt: null as string | null, maxChars };
    let failNextSave = false;
    const writes: string[] = [];
    await page.route("**/api/**", async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() !== "GET") writes.push(`${request.method()} ${path}`);
      const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (path === "/api/web/teaching-instructions") {
        if (request.method() === "GET") return json(saved);
        if (request.method() === "PUT") {
          if (failNextSave) { failNextSave = false; return json({ detail: "自定义提示词暂时无法保存，请稍后重试。" }, 503); }
          const body = request.postDataJSON() as { text?: unknown };
          if (typeof body?.text !== "string") return json({ detail: "自定义提示词格式不正确。" }, 400);
          saved = { text: body.text.trim(), updatedAt: timestamp, maxChars };
          return json(saved);
        }
      }
      if (path === "/api/web/sessions") return json(request.method() === "POST" ? session : { activeSessionId: session.sessionId, sessions: [] });
      if (path === "/api/web/provider-settings") return json({ activeProfileId: null, active: provider, profiles: [] });
      if (path === "/api/web/speech-settings") return json({ enabled: false, profileId: null, region: "beijing", asrModel: "qwen3-asr-flash", ttsModel: "qwen3-tts-flash", voice: "Cherry" });
      if (path === "/api/web/study-time") return json({ scope: null, taskFocusedMs: 0, goalFocusedMs: 0, runFocusedMs: 0, taskObservedMs: 0, taskWaitingMs: 0, observation: "UNKNOWN", recording: false });
      if (path === "/api/web/materials") return json({ materials: [] });
      if (path === "/api/web/recycle") return json({ items: [] });
      if (path === "/api/web/learning-library") return json({ projects: [] });
      if (path === "/api/web/teaching") return json({ proposals: [], current_goal_id: "goal-1" });
      return json({ detail: "隔离验收不提供该接口。" }, 404);
    });

    const openTeachingPage = async (): Promise<void> => {
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.locator("#learning-intro").waitFor({ state: "detached" });
      await page.locator("#composer").waitFor();
      if (width <= 820) await page.locator("#sidebar-toggle").click();
      await page.locator('.nav-item[data-workspace-target="teaching"]').click();
      await page.waitForFunction(() => document.body.dataset.workspace === "teaching");
      await page.locator("#teaching-arrangements-page:visible").waitFor();
      await page.locator("#teaching-instructions-input").waitFor();
    };
    const section = page.locator(".teaching-instructions");
    const input = page.locator("#teaching-instructions-input");
    const status = page.locator(".teaching-instructions-status");
    const saveButton = page.locator('.teaching-instructions [data-action="save"]');

    await openTeachingPage();
    await page.waitForFunction(() => document.querySelector(".teaching-instructions-status")?.textContent === "还没有自定义提示词。");
    assert.equal(await status.textContent(), "还没有自定义提示词。", `${label}: 初始空状态`);
    assert.equal(await page.locator(".teaching-instructions-count").textContent(), `0 / ${maxChars} 字`);
    assert.equal(await saveButton.isDisabled(), true, `${label}: 没有修改时不能保存`);

    await input.fill("  先用真实代码例子，再讲规则。\n每次只出一道题。  ");
    assert.equal(await saveButton.isDisabled(), false, `${label}: 有修改即可保存`);
    assert.match(await status.textContent() ?? "", /有未保存的修改/);
    await saveButton.click();
    await page.waitForFunction(() => document.querySelector(".teaching-instructions-status")?.textContent?.includes("已保存"));
    const puts = () => writes.filter(entry => entry === "PUT /api/web/teaching-instructions").length;
    const unrelatedWrites = () => writes.filter(entry => entry !== "PUT /api/web/teaching-instructions" && entry !== "POST /api/web/sessions");
    if (puts() !== 1) failures.push(`${label}: 保存应只发一次 PUT，实际 ${puts()} 次`);
    if (unrelatedWrites().length) failures.push(`${label}: 保存提示词触发了其它写入 ${unrelatedWrites().join(", ")}`);
    assert.equal(saved.text, "先用真实代码例子，再讲规则。\n每次只出一道题。", `${label}: 服务端保存去空白文本`);
    assert.equal(await input.inputValue(), saved.text, `${label}: 保存后编辑框同步为已保存文本`);

    // 重新打开页面：显示已保存内容，且不再产生写入。
    await openTeachingPage();
    assert.equal(await input.inputValue(), saved.text, `${label}: 重新打开后读回已保存提示词`);
    if (puts() !== 1) failures.push(`${label}: 重新打开不应重复保存`);

    // 清空只清编辑框；保存空文本才删除。
    await page.locator('.teaching-instructions [data-action="clear"]').click();
    assert.equal(await input.inputValue(), "");
    assert.match(await status.textContent() ?? "", /有未保存的修改/);
    if (puts() !== 1) failures.push(`${label}: 清空编辑框不应写服务端`);
    await saveButton.click();
    await page.waitForFunction(() => document.querySelector(".teaching-instructions-status")?.textContent?.includes("已清空"));
    assert.equal(saved.text, "");
    if (puts() !== 2) failures.push(`${label}: 保存空文本应发第二次 PUT`);

    // 保存失败必须保留输入并说明原因。
    failNextSave = true;
    await input.fill("这次保存会失败。");
    await saveButton.click();
    await page.waitForFunction(() => document.querySelector(".teaching-instructions-status")?.getAttribute("data-tone") === "error");
    assert.match(await status.textContent() ?? "", /暂时无法保存/);
    assert.equal(await input.inputValue(), "这次保存会失败。", `${label}: 失败不能丢失输入`);
    assert.equal(saved.text, "", `${label}: 失败不能写入服务端`);

    if (width <= 820) {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
      if (!overflow) failures.push(`${label}: 教学安排页出现横向溢出`);
    }
    if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/teaching-instructions-${width}.png` });
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
  console.log("Teaching instructions passed: empty state, save/reload, clear+save deletes, failed save keeps input, desktop/mobile layout, no teaching calls.");
} finally {
  await browser.close();
  await new Promise<void>(done => server.close(() => done()));
}
