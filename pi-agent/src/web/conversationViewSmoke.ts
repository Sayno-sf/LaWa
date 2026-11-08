import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import type { LearningOverview } from "../learningOverviewTool.js";
import { createGateway } from "./gateway.js";
import { WebSessionStore } from "./sessionStore.js";

const browserPath = process.env.RESPONSIVE_BROWSER_PATH
  ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const temporary = mkdtempSync(join(tmpdir(), "lawa-conversation-view-"));
const acoSkill = {
  id: "aco-skill", name: "ACO 基础", description: "蚁群算法与信息素",
  status: "MASTERED_BY_USER", target_depth: "OVERVIEW", evidence_ids: ["aco-evidence"],
};
const rlSkill = {
  id: "rl-skill", name: "RL 基础", description: "马尔可夫决策过程",
  status: "LEARNING", target_depth: "DEEP", evidence_ids: [],
};
const acoEvidence = {
  id: "aco-evidence", skill_id: acoSkill.id, evidence_type: "EXPLANATION",
  description: "已解释信息素蒸发", assistance_level: "NONE",
};
const acoCard = {
  id: "aco-card", skill_id: acoSkill.id, question: "信息素为什么蒸发？",
  answer: "避免过早收敛", created_at: "2026-09-25T00:00:00Z",
  source_conversation_id: null, feedback: null, feedback_updated_at: null,
  learner_note: null, note_updated_at: null,
};
const archivedProject = {
  status: "ARCHIVED" as const,
  goal_profile: { id: "aco", goal_description: "学习 ACO" },
  curriculum_spine: [{ id: "aco-route", name: "ACO 路线", description: "", target_depth: "OVERVIEW" }],
  skills: [acoSkill], evidence: [acoEvidence], knowledge_cards: [acoCard],
  archived_at: "2026-09-25T00:00:00Z",
};
const rlProject = { ...archivedProject, goal_profile: { id: "rl", goal_description: "研究 RL" } };
let current: LearningOverview = {
  current_goal: "学习 ACO", goal_profile: archivedProject.goal_profile,
  curriculum_spine: archivedProject.curriculum_spine,
  current_frontier: { focus_skill_id: acoSkill.id, next_action: "继续 ACO" },
  current_focus: null, skills: [acoSkill], recent_evidence: [acoEvidence],
  active_task: null, learning_history: [], current_goal_skill_ids: [acoSkill.id],
  knowledge_cards: [acoCard],
};
const acoOverview = current;
let rlOverview: LearningOverview;
const kernel = createServer((request, response) => {
  current = request.url?.includes("/goals/aco/activate") ? acoOverview : rlOverview;
  response.writeHead(200, { "Content-Type": "application/json" }); response.end("{}");
}).listen(0, "127.0.0.1");
await once(kernel, "listening");
const kernelAddress = kernel.address(); assert.ok(kernelAddress && typeof kernelAddress === "object");
const store = new WebSessionStore({
  conversationDir: join(temporary, "sessions"),
  apiBaseUrl: `http://127.0.0.1:${kernelAddress.port}`,
  fetchOverview: async () => current,
  fetchLibrary: async () => ({ projects: [archivedProject, rlProject] }),
});
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
const server = createGateway({
  store,
  staticDir: fileURLToPath(new URL("../../web-dist/", import.meta.url)),
});
try {
  const old = await store.create("new");
  current = {
    ...current,
    current_goal: "研究 RL",
    goal_profile: { id: "rl", goal_description: "研究 RL" },
    curriculum_spine: [{ id: "rl-route", name: "RL 路线", description: "", target_depth: "DEEP" }],
    current_frontier: { focus_skill_id: rlSkill.id, next_action: "学习 MDP" },
    skills: [acoSkill, rlSkill], recent_evidence: [acoEvidence],
    current_goal_skill_ids: [rlSkill.id], knowledge_cards: [acoCard],
  };
  rlOverview = current;
  const latest = await store.create("new");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: "domcontentloaded" });
  await page.locator("#skill-route").getByText("RL 基础").waitFor();
  await page.locator(`#conversation-list button[data-conversation-action="activate"][data-session-id="${old.sessionId}"]`).click();
  await page.locator("#skill-route").getByText("ACO 基础").waitFor();
  assert.match(await page.locator("#skill-route").textContent() ?? "", /ACO 基础/);
  assert.doesNotMatch(await page.locator("#skill-route").textContent() ?? "", /RL 基础/);
  assert.match(await page.locator("#curriculum-list").textContent() ?? "", /ACO 路线/);
  assert.match(await page.locator("#skill-card").textContent() ?? "", /ACO 基础/);
  assert.match(await page.locator("#evidence-list").textContent() ?? "", /信息素蒸发/);
  assert.match(await page.locator("#knowledge-cards-panel").textContent() ?? "", /信息素为什么蒸发/);
  assert.equal(await page.locator("#message-input").isEnabled(), true);
  assert.equal(current.current_goal, "学习 ACO");
  await page.locator(`#conversation-list button[data-conversation-action="activate"][data-session-id="${latest.sessionId}"]`).click();
  await page.locator("#skill-route").getByText("RL 基础").waitFor();
  assert.equal(await page.locator("#message-input").isEnabled(), true);
  await page.close();
  console.log("Conversation view smoke passed: selecting a conversation restores its Goal; route, skill, Evidence and cards match and teaching is available.");
} finally {
  await browser.close();
  store.dispose();
  if (server.listening) {
    server.close();
    await once(server, "close");
  }
  kernel.close(); await once(kernel, "close");
  rmSync(temporary, { recursive: true, force: true });
}
