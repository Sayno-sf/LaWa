import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright-core";

import type { LearningOverview } from "../learningOverviewTool.js";
import { ConversationCatalog } from "./conversationCatalog.js";
import { createGateway } from "./gateway.js";
import { WebSessionStore } from "./sessionStore.js";

const directory = mkdtempSync(join(tmpdir(), "lawa-goal-browser-"));
const screenshotDirectory = process.env.GOAL_ENTRY_SCREENSHOT_DIR;
if (screenshotDirectory) mkdirSync(screenshotDirectory, { recursive: true });
const catalog = new ConversationCatalog(directory, process.cwd());
const a = catalog.create();
a.appendMessage({
  role: "toolResult", toolCallId: "teach", toolName: "record_teaching_turn", isError: false,
  content: [{ type: "text", text: JSON.stringify({ active_skill_id: "skill-a" }) }], timestamp: Date.now(),
} as Parameters<typeof a.appendMessage>[0]);
a.appendMessage({ role: "assistant", content: [{ type: "text", text: "ACO 原教学内容" }], timestamp: Date.now() } as Parameters<typeof a.appendMessage>[0]);
// 首课先保存，Goal observation 与 Skill anchor 在轮末保存，重现真实历史记录的顺序。
catalog.recordGoal(a, "goal-a", "学习 ACO");
catalog.recordSkillAnchor(a, "goal-a", "skill-a");
const b = catalog.create();
// 旧混合会话：新 RL Session 早期观察过 ACO，之后才切到 RL。
catalog.recordGoal(b, "goal-a", "学习 ACO");
b.appendMessage({ role: "assistant", content: [{ type: "text", text: "旧目标边界" }], timestamp: Date.now() } as Parameters<typeof b.appendMessage>[0]);
catalog.recordGoal(b, "goal-b", "学习 RL");
b.appendMessage({ role: "assistant", content: [{ type: "text", text: "RL 教学内容" }], timestamp: Date.now() } as Parameters<typeof b.appendMessage>[0]);

let goal = "goal-b";
let reviewing = false;
let reviewOperation = "";
const kernelWrites: string[] = [];
const skill = (id: string) => ({ id: `skill-${id}`, name: id === "a" ? "ACO 基础" : "RL 基础", description: "理解核心机制", status: id === "a" ? reviewing ? "PRACTICING" : "MASTERED_BY_USER" : "LEARNING", target_depth: "PRACTICAL", evidence_ids: [] });
const rlRouteSkills = () => [
  skill("b"),
  { ...skill("b"), id: "skill-b-previous", name: "已开始的 RL 技能" },
  { ...skill("b"), id: "skill-b-next", name: "尚未开始的 RL 技能", status: "NOT_STARTED" },
];
const project = (id: string) => ({
  status: id === goal ? "CURRENT" as const : "ARCHIVED" as const,
  goal_profile: { id: `goal-${id}`, goal_description: id === "a" ? "学习 ACO" : "学习 RL", desired_outcome: "独立应用", background_summary: "" },
  curriculum_spine: [{ id: `route-${id}`, name: `${id.toUpperCase()} 路线`, description: "", target_depth: "PRACTICAL" }],
  skills: id === "b" ? rlRouteSkills() : [skill(id)], evidence: [], knowledge_cards: [], archived_at: id === goal ? null : new Date().toISOString(),
});
const fetchOverview = async (): Promise<LearningOverview> => ({
  current_goal: goal === "goal-a" ? "学习 ACO" : "学习 RL",
  goal_profile: project(goal.at(-1)!).goal_profile,
  curriculum_spine: project(goal.at(-1)!).curriculum_spine,
  current_frontier: { focus_skill_id: `skill-${goal.at(-1)}`, supporting_skill_ids: [], reason: "", target_depth: "PRACTICAL", next_action: "继续练习" },
  current_focus: null, skills: goal === "goal-b" ? rlRouteSkills() : [skill("a")], recent_evidence: [],
  active_task: { id: reviewing ? `review-${reviewOperation}` : `task-${goal}`, title: reviewing ? "复习 ACO 基础" : "原任务", related_skill_ids: [`skill-${goal.at(-1)}`] },
  learning_history: [], current_goal_skill_ids: goal === "goal-b" ? rlRouteSkills().map((item) => item.id) : ["skill-a"], knowledge_cards: [],
});
const api = createServer(async (request, response) => {
  const path = request.url ?? "";
  if (request.method === "POST") kernelWrites.push(path);
  if (path.includes("/goals/goal-a/activate")) goal = "goal-a";
  if (path.includes("/goals/goal-b/activate")) goal = "goal-b";
  if (path.includes("/skills/skill-a/start-review")) {
    let body = ""; for await (const chunk of request) body += chunk;
    reviewOperation = (JSON.parse(body) as { operation_id: string }).operation_id;
    reviewing = true;
  }
  if (path.includes("/finish-review")) reviewing = false;
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end("{}");
});
api.listen(0, "127.0.0.1");
await once(api, "listening");
const apiAddress = api.address();
assert.ok(apiAddress && typeof apiAddress === "object");
const store = new WebSessionStore({
  conversationDir: directory,
  apiBaseUrl: `http://127.0.0.1:${apiAddress.port}`,
  fetchOverview,
  fetchLibrary: async () => ({ projects: [project("a"), project("b")] }),
});
const gateway = createGateway({ store });
gateway.listen(0, "127.0.0.1");
await once(gateway, "listening");
const gatewayAddress = gateway.address();
assert.ok(gatewayAddress && typeof gatewayAddress === "object");
const browser = await chromium.launch({
  executablePath: process.env.RESPONSIVE_BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await page.goto(`http://127.0.0.1:${gatewayAddress.port}`, { waitUntil: "domcontentloaded" });
  await page.locator("#learning-intro").waitFor({ state: "detached" });
  // 新浏览器默认以对话为主；保留既有折叠偏好时仍可回到对话。
  if (await page.locator("#conversation-toggle").isVisible()) await page.locator("#conversation-toggle").click();
  await page.locator("#skill-route").getByText("RL 基础").waitFor();
  assert.match(await page.locator('#skill-route [data-select-skill="skill-b"]').innerText(), /正在学习/);
  assert.match(await page.locator('#skill-route [data-select-skill="skill-b-previous"]').innerText(), /待巩固/);
  assert.match(await page.locator('#skill-route [data-select-skill="skill-b-next"]').innerText(), /待学习/);
  await page.locator('#skill-card [data-action="master"]').waitFor();
  assert.equal(await page.locator('#skill-card [data-action="review"]').count(), 0, "未掌握 Skill 不应提供重新学习");
  assert.equal(await page.locator('#skill-card [data-action="master"]').count(), 1, "未掌握 Skill 应保留确认掌握");
  assert.equal(await page.locator('#skill-card [data-action="locate"]').count(), 0, "原对话定位由路线点击承担");
  assert.equal(await page.locator("#conversation-panel #conversation-branches").count(), 0, "对话正文不常驻历史按钮栏");
  assert.equal(await page.locator("#skill-card .skill-records-details").isVisible(), false, "当前 RL 技能不能显示 ACO 复习记录");
  await page.locator("#learning-library-button").click();
  assert.equal(await page.locator('[data-library-action="locate"]').count(), 0, "学习库不再显示查看原对话按钮");
  assert.equal(await page.locator('[data-library-action="review"][data-skill="skill-b"]').count(), 0, "未掌握 Skill 在学习库也不应重新学习");
  await page.locator(".learning-project-card").filter({ has: page.locator('[data-library-action="goal"][data-goal="goal-a"]') }).locator("summary").first().click();
  await page.locator('[data-library-action="goal"][data-goal="goal-a"]').click();
  await page.waitForFunction(() => document.querySelector("#skill-route")?.textContent?.includes("ACO 基础"));
  assert.match(await page.locator("#messages").innerText(), /ACO 原教学内容/);
  goal = "goal-b"; // 点击前 Kernel 已在另一 Goal；预览必须保持所选 ACO 的资料视图。
  await page.locator('#skill-route [data-select-skill="skill-a"]').click();
  await page.locator(".located-message").waitFor();
  assert.equal(goal, "goal-b", "首课预览不得激活 Kernel Goal");
  assert.match(await page.locator("#skill-route").innerText(), /ACO 基础/);
  assert.doesNotMatch(await page.locator("#skill-route").innerText(), /RL 基础/);
  assert.match(await page.locator("#skill-card").innerText(), /ACO 基础/);
  assert.equal(await page.locator("#message-input").isDisabled(), true);
  assert.equal(await page.locator("#send-button[data-branch-back]").isDisabled(), false, "历史预览仍有可用的返回入口");
  const originalRecords = page.locator("#skill-card .skill-records-details");
  assert.equal(await originalRecords.getAttribute("open"), null, "首次学习历史默认折叠");
  await originalRecords.locator("summary").click();
  assert.equal(await page.locator('[data-branch-original="skill-a"]').innerText(), "首次学习", "旧教学路径应可回看");
  assert.equal(await page.locator('#skill-card [data-action="master"]').count(), 0, "已掌握 Skill 不应重复显示确认掌握");
  goal = "goal-a";
  await page.locator("#send-button[data-branch-back]").click();
  await page.waitForFunction(() => !(document.querySelector("#message-input") as HTMLTextAreaElement)?.disabled);
  await page.locator('#skill-route [data-select-skill="skill-a"]').click();
  await page.locator(".located-message").waitFor();
  await page.locator('#skill-card [data-action="review"][data-skill="skill-a"]').click();
  await page.locator("[data-review-finish]").waitFor();
  assert.equal(await page.locator("#header-task-info [data-review-finish]").isVisible(), true, "复习结束动作在已有任务上下文中可见");
  const activeRecords = page.locator("#skill-card .skill-records-details");
  assert.equal(await activeRecords.getAttribute("open"), null, "进行复习不自动展开历史清单");
  await activeRecords.locator("summary").click();
  assert.match(await activeRecords.innerText(), /首次学习\s+复习 1/);
  await page.locator("[data-review-finish]").click();
  await page.waitForFunction(() => document.querySelector("#header-task-info")?.textContent?.includes("原任务"));
  assert.match(await page.locator("#messages").innerText(), /ACO 原教学内容/);
  assert.equal(await page.locator("[data-review-finish]").count(), 0, "结束后复习动作消失");
  assert.equal(await page.locator("#skill-card .skill-records-details").getAttribute("open"), null, "回到原任务时学习记录重新收起");
  assert.equal(await page.locator("#send-button").getAttribute("data-branch-back"), null);
  await page.locator("#learning-library-button").click();
  await page.locator(".learning-project-card").filter({ has: page.locator('[data-library-action="goal"][data-goal="goal-b"]') }).locator("summary").first().click();
  await page.locator('[data-library-action="goal"][data-goal="goal-b"]').click();
  await page.locator("#skill-route").getByText("RL 基础").waitFor();
  await page.locator(`#conversation-list button[data-conversation-action="activate"][data-session-id="${a.getSessionId()}"]`).click();
  await page.locator("#skill-route").getByText("ACO 基础").waitFor();
  assert.equal(goal, "goal-a", "选择原对话应恢复对应 Goal");
  await page.locator('#skill-route [data-select-skill="skill-a"]').click();
  await page.locator(".located-message").waitFor();
  assert.match(await page.locator("#messages").innerText(), /ACO 原教学内容/, "历史路线点击应恢复对应目标的原对话");
  await page.locator("#send-button[data-branch-back]").click();
  await page.locator(`#conversation-list button[data-conversation-action="activate"][data-session-id="${b.getSessionId()}"]`).click();
  await page.locator("#skill-route").getByText("RL 基础").waitFor({ timeout: 5000 });
  assert.match(await page.locator("#skill-card").innerText(), /RL 基础/, "切回 RL 对话时路线与当前学习必须一起切回");
  assert.equal(await page.locator("#skill-card .skill-records-details").isVisible(), false, "跨目标返回后不残留其他技能的复习清单");
  assert.equal(await page.locator("#conversation-panel #conversation-branches").count(), 0);

  // 走真实 DOM -> Gateway -> SessionStore：所有新建入口必须进入草稿，不能沿用旧 Goal 上传。
  const creationModes: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/web/sessions") {
      creationModes.push(request.postDataJSON().mode);
    }
  });
  for (const [selector, width, height] of [
    ["#new-conversation-button", 1440, 900],
    ["#dialog-new-conversation-button", 1440, 900],
    ["#new-goal-button", 1440, 900],
    ["#new-conversation-button", 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    const original = await store.listConversations();
    const originalOverview = await fetchOverview();
    const beforeWrites = kernelWrites.length;
    const beforeCreates = creationModes.length;
    const draftText = `原任务未发送的想法 ${width} ${selector}`;
    await page.locator("#message-input").fill(draftText);
    const openEntry = async () => {
      if (selector === "#dialog-new-conversation-button" &&
          !await page.locator(selector).isVisible()) {
        await page.locator("#profile-button").click();
        await page.locator("#conversation-library-menu-button").click();
      } else if (selector === "#new-conversation-button" &&
                 !await page.locator(selector).isVisible()) {
        await page.locator("#sidebar-toggle").click();
      }
      await page.locator(selector).click();
      await page.locator("#new-goal-dialog").waitFor({ state: "visible" });
    };
    await openEntry();
    assert.match(await page.locator("#new-goal-copy").innerText(), /先上传资料/);
    if (screenshotDirectory && selector === "#new-conversation-button") {
      await page.screenshot({ path: join(screenshotDirectory, `new-goal-confirm-${width}.png`) });
    }
    await page.locator('#new-goal-dialog button[value="cancel"]').click();
    assert.equal((await store.listConversations()).activeSessionId, original.activeSessionId);
    assert.equal(creationModes.length, beforeCreates, "取消不得创建对话或触发教学");
    assert.equal(await page.locator("#message-input").inputValue(), draftText);
    await openEntry();
    await page.locator('#new-goal-dialog button[value="confirm"]').click();
    await page.locator("#workspace-title").getByText("建立新的学习目标", { exact: true }).waitFor();
    const created = await store.listConversations();
    assert.ok(created.activeSessionId && created.activeSessionId !== original.activeSessionId);
    assert.equal(created.sessions.length, original.sessions.length + 1);
    assert.deepEqual(creationModes.slice(beforeCreates), ["new-goal"]);
    assert.equal((await store.state(created.activeSessionId)).onboarding.status, "NEEDS_CLARIFICATION");
    assert.equal(await store.materialGoal(created.activeSessionId, "goal-b"), `draft:${created.activeSessionId}`);
    assert.doesNotMatch(await page.locator("#messages").innerText(), /RL 教学内容|ACO 原教学内容/);
    assert.equal(await page.locator("#message-input").inputValue(), "");
    assert.deepEqual(await fetchOverview(), originalOverview, "创建草稿不得改变原学习目标或任务");
    assert.equal(kernelWrites.length, beforeWrites, "草稿入口不得写入 Kernel 学习事实");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.equal(await page.locator("body").evaluate(node => node.classList.contains("mobile-nav-open")), false);

    // 上次已确认后再打开并按 Escape，不能复用旧 confirm 而多创建一份草稿。
    await openEntry();
    await page.keyboard.press("Escape");
    await page.locator("#new-goal-dialog").waitFor({ state: "hidden" });
    assert.equal((await store.listConversations()).sessions.length, created.sessions.length);
    assert.equal(creationModes.length, beforeCreates + 1);
    if (width <= 820) await page.locator("#sidebar-toggle").click();
    await page.locator(`#conversation-list [data-conversation-action="activate"][data-session-id="${original.activeSessionId}"]`).click();
    await page.locator("#skill-route").getByText("RL 基础").waitFor();
    assert.equal(goal, "goal-b");
    assert.match(await page.locator("#messages").innerText(), /RL 教学内容/);
    assert.equal(await page.locator("#message-input").inputValue(), draftText, "自然返回原对话恢复未发送草稿");
    assert.deepEqual(await fetchOverview(), originalOverview);
  }
  console.log("Goal workspace browser smoke passed: Goal/Task restore; readonly Skill preview; collapsed review records; unified topbar/sidebar/library new Goal entries; draft material scope; cancel/Escape; original composer draft; desktop/mobile.");
} finally {
  await browser.close();
  store.dispose();
  gateway.close();
  api.close();
  await Promise.all([once(gateway, "close"), once(api, "close")]);
  rmSync(directory, { recursive: true, force: true });
}
