import assert from "node:assert/strict";
import { once } from "node:events";

import { chromium } from "playwright-core";

import type { LearningAgentSession } from "../agentSession.js";
import type { LearningOverview } from "../learningOverviewTool.js";
import { createGateway } from "./gateway.js";
import { WebSessionStore } from "./sessionStore.js";

const browserPath = process.env.RESPONSIVE_BROWSER_PATH
  ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

function overview(): LearningOverview {
  return {
    current_goal: "学习 Session 与 Context", goal_profile: { id: "goal-browser" }, curriculum_spine: [],
    current_frontier: { focus_skill_id: "skill-browser", supporting_skill_ids: [], reason: "", target_depth: "OVERVIEW", next_action: "" },
    current_focus: null,
    skills: [{ id: "skill-browser", name: "Session 与 Context", description: "解释两者边界", status: "LEARNING", target_depth: "OVERVIEW", evidence_ids: [] }],
    recent_evidence: [], active_task: { id: "task-browser", title: "理解上下文", description: "闭卷解释", related_skill_ids: ["skill-browser"], status: "ACTIVE" },
    learning_history: [], current_goal_skill_ids: ["skill-browser"], knowledge_cards: [],
  };
}

const store = new WebSessionStore({
  fetchOverview: async () => overview(),
  fetchLibrary: async () => ({ projects: [] }),
  createAgent: async (context, _planning, emit): Promise<LearningAgentSession> => ({
    prompt: async (text) => {
      if (text === "开始检查") {
        const checkpoint = context.activeRecall.start({
          goal_id: "goal-browser", session_id: context.getSessionId(), skill_id: "skill-browser", task_id: "task-browser",
          primary_questions: ["Session 保留什么？", "Context 保留什么？", "为何压缩不删除历史？", "迁移到另一个 Agent 如何设计？"],
        });
        emit({ type: "assistant_delta", delta: `我们用 4 个问题逐个检查。${checkpoint.current_question}` });
      } else {
        const answer = context.activeRecall.answer({
          goal_id: "goal-browser", session_id: context.getSessionId(), skill_id: "skill-browser", task_id: "task-browser",
          outcome: "CORRECT", observation: text, next: "PRIMARY",
        });
        emit({ type: "assistant_delta", delta: `回答抓住了关键点。下一题：${answer.checkpoint?.current_question}` });
      }
    },
    abort: async () => undefined,
    dispose: () => undefined,
  }),
});
const server = createGateway({ store });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: "domcontentloaded" });
  await page.locator("#learning-intro").waitFor({ state: "detached" });
  await page.locator('#connection-status[data-status="ready"]').waitFor({ state: "attached" });
  if (await page.locator("#conversation-toggle").isVisible()) await page.locator("#conversation-toggle").click();
  await page.locator("#message-input").fill("开始检查");
  await page.locator("#send-button").click();
  await page.locator("#active-recall-progress").getByText("Active Recall · 1 / 4").waitFor();
  assert.match(await page.locator("#messages").innerText(), /Session 保留什么/);
  assert.doesNotMatch(await page.locator("#messages").innerText(), /Context 保留什么/);
  await page.locator("#message-input").fill("Session 保存完整对话历史");
  await page.locator("#send-button").click();
  await page.locator("#active-recall-progress").getByText("Active Recall · 2 / 4").waitFor();
  assert.match(await page.locator("#messages").innerText(), /Context 保留什么/);
  assert.equal(await page.locator("#message-input").isEnabled(), true);
  await page.locator("#active-recall-skip").click();
  await page.locator("#active-recall-bar").waitFor({ state: "hidden" });
  assert.doesNotMatch(await page.locator(".conversation-panel").innerText(), /分数|正确率|及格|掌握概率/);
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  await mobile.goto(`http://127.0.0.1:${address.port}`, { waitUntil: "domcontentloaded" });
  await mobile.locator("#learning-intro").waitFor({ state: "detached" });
  await mobile.locator('#connection-status[data-status="ready"]').waitFor({ state: "attached" });
  await mobile.locator("#message-input").fill("开始检查");
  await mobile.locator("#send-button").click();
  await mobile.locator("#active-recall-progress").getByText("Active Recall · 1 / 4").waitFor();
  assert.equal(await mobile.locator("#message-input").isVisible(), true);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await mobile.locator("#active-recall-skip").click();
  await mobile.locator("#active-recall-bar").waitFor({ state: "hidden" });
  await mobile.close();
  assert.equal(overview().recent_evidence.length, 0);
  process.stdout.write("Active Recall browser smoke passed: sequential chat, progress, composer, skip, no scoring.\n");
} finally {
  await browser.close();
  store.dispose();
  server.close();
  await once(server, "close");
}
