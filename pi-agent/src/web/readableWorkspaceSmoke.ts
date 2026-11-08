import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { chromium, type Page } from "playwright-core";

// 只提供隔离样例与构建资源。没有 Kernel、Pi 或外部模型连接。
const staticDir = resolve(process.env.READABLE_STATIC_DIR ?? "../data/qa/personal-bluewhite-web");
const output = resolve(process.env.READABLE_SCREENSHOT_DIR ?? "../data/qa/personal-bluewhite");
const sample = `# 理解模型如何学习\n\n从一个**具体例子**开始，把概念和实践联系起来。\n\n## 原文与解释\n\n> 学习需要通过实际尝试检验。\n> 来源：教材第 18–20 行。\n\n### 两个步骤\n\n1. 先说明目标和当前情况。\n2. 用小练习验证自己的理解。\n\n参考：[PyTorch 文档](https://pytorch.org/docs/)\n\n行内公式 $a < b$，以及损失函数：\n\n$$\\mathcal{L}=\\frac{1}{N}\\sum_{i=1}^{N}(y_i-\\hat y_i)^2$$\n\n\`\`\`python\nimport torch\nloss = ((prediction - target) ** 2).mean()\n\`\`\`\n\n| 阶段 | 当前输入与动作 | 要验证的现象 |\n| --- | --- | --- |\n| 解释 | 一个真实问题，不凭熟悉感确认掌握 | 能够说明输入、输出和边界 |\n| 实践 | 一个可运行的小练习 | 能用结果修正自己的理解 |`;
const timestamp = "2026-10-09T13:00:00Z";
const skills = ["理解神经网络的输入、输出与训练过程", "辨别常见问题", "独立解释结果"].map((name, i) => ({
  id: `skill-${i}`, name, description: "用自己的话解释概念，通过一个具体例子说明输入、输出和边界。".repeat(5),
  status: i === 0 ? "LEARNING" : "NOT_STARTED", target_depth: "PRACTICAL", evidence_ids: [] }));
const cards = [{ id: "card-0", skill_id: "skill-0", question: "## 为什么需要损失函数？\n\n请解释 $a < b$ 的含义。",
  answer: sample, feedback: null, learner_note: null, source_conversation_id: null, created_at: timestamp }];
const goal = { id: "goal-0", goal_description: "从概念到实践：理解模型训练", desired_outcome: "用实践检验理解", background_summary: "" };
const project = { status: "CURRENT", goal_profile: goal, curriculum_spine: skills.map((s, i) => ({ id: `milestone-${i}`, name: s.name, description: s.description, target_depth: s.target_depth })),
  skills, knowledge_cards: cards, evidence: [], archived_at: null };
const session = { sessionId: "readable-fixture", messages: [{ role: "assistant", content: sample }, ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "user" : "assistant", content: "学习记录：从概念走向一次独立尝试。\n\n通过结果判断理解是否清楚，而不是只凭熟悉感。" }))], state: {
  view_mode: "CURRENT", active_goal_id: goal.id, overview: { current_goal: goal.goal_description, current_goal_skill_ids: skills.map(s => s.id),
    skills, curriculum_spine: project.curriculum_spine, recent_evidence: [], knowledge_cards: cards,
    current_frontier: { focus_skill_id: "skill-0", supporting_skill_ids: [], reason: "", target_depth: "PRACTICAL", next_action: "" },
    active_task: { id: "task-0", title: "解释损失函数与训练结果", description: "", related_skill_ids: ["skill-0"], status: "ACTIVE" } },
  teaching: { active_skill_id: "skill-0", teaching_mode: "EXPLAIN" }, onboarding: { status: "IDLE", replace_existing: false }, recommended_action: null } };
const material = { id: "material-0", name: "PyTorch 训练与实践课程.md", format: "md", goal_id: goal.id, unit_count: 120, unit_kind: "line", readable: true, warnings: [] };
const provider = { provider: "fixture", model: "隔离预览模型", baseUrl: "https://example.invalid/v1", thinkingLevel: "off", maxOutputTokens: 32768, hasApiKey: false, apiKeyHint: null };
let previewAttempts = 0;
const requests: string[] = [];
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const json = (payload: unknown, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(payload)); };
  try {
    if (url.pathname.startsWith("/api/")) {
      requests.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/api/web/sessions") return json(request.method === "POST" ? session : { activeSessionId: session.sessionId, sessions: [0,1].map(i => ({ id: i ? "old-session" : session.sessionId, name: "请先读取学习资料，然后依据资料规划学习路线", goalDescription: i ? "学会提问：解释论题与结论" : goal.goal_description, goalId: goal.id, updatedAt: timestamp, createdAt: timestamp, messageCount: 9, active: !i })) });
      if (url.pathname === "/api/web/provider-settings") return json({ activeProfileId: null, active: provider, profiles: [] });
      if (url.pathname === "/api/web/speech-settings") return json({ enabled: false, profileId: null, region: "beijing", asrModel: "qwen3-asr-flash", ttsModel: "qwen3-tts-flash", voice: "Cherry" });
      if (url.pathname === "/api/web/materials") return json({ materials: [material] });
      if (url.pathname === "/api/web/materials/material-0") {
        if (++previewAttempts === 1) return json({ detail: "预览服务暂不可用。" }, 503);
        return json({ text: sample, citation: material.name + " · 第 1–60 行", truncated: true });
      }
      if (url.pathname === "/api/web/retrieval-status") return json({ enabled: false, chunks: 1, building_generation: null, warning: null, sources: [] });
      if (url.pathname === "/api/web/retrieval-traces") return json(url.searchParams.has("id") ? { query: "怎样解释论题？", scope: "current", current_scope: "old-goal", warnings: [], reads: [], timings_ms: { total: 10 }, stages: { bm25: [{ name: "学会提问.txt", goal_name: "学会提问", snippet: "先找到论题。", score: 1, locator: { kind: "line", start: 5, end: 7 } }] } } : [{ id: "old-trace", at: timestamp, query: "怎样解释论题？", scope: "current", warnings: [] }]);
      if (url.pathname === "/api/web/learning-library") return json({ projects: [project] });
      return json({ detail: "隔离预览禁止该操作。" }, 400);
    }
    const path = resolve(staticDir, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!path.startsWith(staticDir + sep)) { response.writeHead(403); response.end(); return; }
    const bytes = await readFile(path);
    response.writeHead(200, { "Content-Type": ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2" } as Record<string,string>)[extname(path)] ?? "application/octet-stream" }); response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise<void>(resolve => server.listen(Number(process.env.READABLE_PORT ?? 19995), "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
if (process.argv.includes("--serve")) {
  console.log(`隔离学习界面预览：${base}（Ctrl+C 停止；没有真实学习数据）`);
  process.on("SIGINT", () => server.close(() => process.exit(0)));
} else {
  const browser = await chromium.launch({ executablePath: process.env.RESPONSIVE_BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
  const errors: string[] = [], issues: string[] = [], measurements: unknown[] = [];
  const open = async (width: number, height: number, suffix = "") => {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
    await context.addInitScript(() => localStorage.setItem("learn-anything:intro-watched:v1", "true"));
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    await page.goto(base + suffix); await page.locator("#learning-intro").waitFor({ state: "detached" }); await page.locator("#skill-card .mastery-button").waitFor(); return page;
  };
  const nav = async (page: Page, target: string) => {
    if (target === "materials") { await page.locator("#route-materials button").click(); return; }
    if (page.viewportSize()!.width <= 820) await page.locator("#sidebar-toggle").click();
    await page.locator(`.nav-item[data-workspace-target="${target}"]`).click();
  };
  try {
    await mkdir(output, { recursive: true });
    for (const [width, height] of [[1440,900],[1280,720],[1228,576],[390,844],[320,640],[390,360]]) {
      const page = await open(width!, height!);
      if (!await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)) issues.push(`${width}x${height}: page overflow`);
      const composer = await page.locator("#composer").boundingBox(); if (!composer || composer.y + composer.height > height! + 1) issues.push(`${width}x${height}: composer`);
      if (width! > 820) {
        const card = await page.locator("#skill-card").boundingBox(), action = await page.locator(".mastery-button").boundingBox();
        if (!card || !action || action.y < card.y || action.y + action.height > card.y + card.height) issues.push(`${width}: mastery is below initial card view`);
      }
      const textMetrics = await page.evaluate(() => [".route-card .card-heading p", ".route-material-row", ".conversation-open small", '.learning-view-tabs button[aria-selected="false"]', ".header-task-info", ".skill-description-text"].map(selector => {
        const node = document.querySelector(selector); if (!node) return { selector, missing: true };
        const style = getComputedStyle(node); let parent: Element | null = node; let bg = "rgb(255, 255, 255)";
        while (parent) { const color = getComputedStyle(parent).backgroundColor; if (color !== "rgba(0, 0, 0, 0)") { bg = color; break; } parent = parent.parentElement; }
        return { selector, color: style.color, background: bg, font: parseFloat(style.fontSize) };
      }));
      const luminance = (color: string) => color.match(/[\d.]+/g)!.slice(0,3).map(Number).map(c => c/255).map(c => c <= .04045 ? c/12.92 : ((c+.055)/1.055)**2.4).reduce((sum,c,i) => sum+c*[.2126,.7152,.0722][i]!,0);
      for (const metric of textMetrics) {
        if (metric.missing) { issues.push(`${width}: missing measured text ${metric.selector}`); continue; }
        const a = luminance(metric.color!), b = luminance(metric.background!); const ratio = (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
        if (ratio < 4.5) issues.push(`${width} ${metric.selector} contrast=${ratio.toFixed(2)}`);
        if (metric.font! < 12) issues.push(`${width} ${metric.selector} font=${metric.font}`);
      }
      measurements.push({ width, height, textMetrics });
      if (width === 1440 || width === 390 && height === 844) await page.screenshot({ path: resolve(output, `${width}-conversation.png`) });
      await page.locator("#task-focus-toggle").click(); await page.locator('[data-card-action="flip"]').click();
      assert.equal(await page.locator(".kc-answer blockquote").count(),1); assert.equal(await page.locator(".kc-answer ol li").count(),2);
      assert.equal(await page.locator(".kc-answer .katex-display").count(),1); assert.equal(await page.locator(".kc-answer pre code").count(),1);
      assert.equal(await page.locator(".kc-answer a[href^='https:']").count(),1);
      assert.equal(await page.locator('#knowledge-cards-panel').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, `${width}: long rich content must not widen the card panel`);
      if (width! <= 820) assert.equal(await page.locator('.kc-answer .markdown-table-wrap').evaluate(node => getComputedStyle(node).overflowX === 'auto' && node.scrollWidth > node.clientWidth), true, "wide tables own their horizontal scroll");
      if (width === 1440 || width === 390 && height === 844) await page.screenshot({ path: resolve(output, `${width}-cards.png`) });
      await page.context().close();
    }
    const page = await open(1280,720); await nav(page,"materials");
    await page.locator('[data-material-action="read"]').click(); await page.locator('#material-preview-status[data-status="error"]').waitFor();
    assert.equal(await page.locator('#material-preview-text').innerText(), "");
    await page.screenshot({ path: resolve(output,"material-error.png") });
    await page.locator('[data-material-action="read"]').click(); await page.locator('#material-preview-status[data-status="ready"]').waitFor();
    assert.match(await page.locator('#material-preview-status').innerText(), /第 1–60 行.*后续/); assert.equal(await page.locator('#material-preview-text blockquote').count(),1);
    await page.locator('#retrieval-diagnostics > summary').click(); await page.waitForFunction(() => document.querySelector('#retrieval-trace-content')?.textContent?.includes('检索当时的学习目标：学会提问'));
    await page.screenshot({ path: resolve(output,"material-ready-scope.png") });
    await page.context().close();
    assert.deepEqual(errors,[]); assert.ok(!requests.some(entry => /messages|mastery|review/.test(entry)),"no teaching or mastery writes");
    await writeFile(resolve(output,"report.json"),JSON.stringify({measurements,issues,errors,requests},null,2));
    assert.deepEqual(issues,[]);
    console.log("Readable workspace passed: six viewport sizes; contrast/type; mastery; cards math/code/quotes; preview error/retry; historical retrieval scope.");
  } finally { await browser.close(); await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); }
}
