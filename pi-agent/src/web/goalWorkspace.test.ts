import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { LearningOverview } from "../learningOverviewTool.js";
import { ConversationCatalog } from "./conversationCatalog.js";
import { WebSessionStore } from "./sessionStore.js";

test("first lesson preview uses the requested Goal even when its observation was recorded after the lesson", async () => {
  for (const priorGoal of [null, "previous-goal"]) {
    const directory = mkdtempSync(join(tmpdir(), "lawa-first-lesson-preview-"));
    const catalog = new ConversationCatalog(directory);
    const original = catalog.create();
    if (priorGoal) catalog.recordGoal(original, priorGoal, "Previous Goal");
    const lessonId = original.appendMessage({
      role: "assistant", content: [{ type: "text", text: "First lesson of requested Goal" }], timestamp: Date.now(),
    } as Parameters<typeof original.appendMessage>[0]);
    // 真实顺序：初始化和首课在同一轮发生，Gateway 到轮次结束才写 Goal 标记与 Skill 锚点。
    catalog.recordGoal(original, "requested-goal", "Requested Goal");
    catalog.recordSkillAnchor(original, "requested-goal", "first-skill");
    const originalFile = original.getSessionFile()!;
    const originalBytes = readFileSync(originalFile);
    const overview: LearningOverview = {
      current_goal: "Current unrelated Goal", goal_profile: { id: "current-goal" }, curriculum_spine: [],
      current_frontier: null, current_focus: null, skills: [{ id: "unrelated-skill" }],
      recent_evidence: [], active_task: { id: "current-task" }, learning_history: [], current_goal_skill_ids: ["unrelated-skill"],
    };
    let projectAvailable = true;
    const store = new WebSessionStore({
      conversationDir: directory, fetchOverview: async () => overview,
      fetchLibrary: async () => ({ projects: projectAvailable ? [{
        status: "ARCHIVED", goal_profile: { id: "requested-goal", goal_description: "Requested Goal" },
        curriculum_spine: [{ id: "requested-route" }],
        skills: [{ id: "first-skill" }, { id: "second-skill" }, { id: "third-skill" }],
        evidence: [{ id: "requested-evidence" }], knowledge_cards: [{ id: "requested-card" }], archived_at: null,
      }] : [] }),
    });
    try {
      const active = await store.create("new");
      const preview = await store.locateSkill("requested-goal", "first-skill");
      assert.equal((preview.state.overview.goal_profile as { id: string }).id, "requested-goal");
      assert.equal(preview.state.view_mode, "ARCHIVED");
      assert.equal(preview.state.active_goal_id, "current-goal");
      assert.deepEqual(preview.state.overview.current_goal_skill_ids, ["first-skill", "second-skill", "third-skill"]);
      assert.deepEqual(preview.state.overview.curriculum_spine, [{ id: "requested-route" }]);
      assert.deepEqual(preview.state.overview.knowledge_cards, [{ id: "requested-card" }]);
      assert.equal(preview.previewEntryId, lessonId);
      assert.equal(preview.messages.at(-1)?.content, "First lesson of requested Goal");
      assert.equal(preview.sessionId, active.sessionId);
      assert.deepEqual((await store.state(active.sessionId)).overview.active_task, { id: "current-task" });
      assert.deepEqual(readFileSync(originalFile), originalBytes, "preview must not rewrite the original Pi tree");
      projectAvailable = false;
      const unavailable = await store.locateSkill("requested-goal", "first-skill");
      assert.equal(unavailable.state.view_mode, "UNAVAILABLE");
      assert.deepEqual(unavailable.state.overview.skills, []);
      assert.equal(unavailable.state.overview.goal_profile, null);
    } finally { store.dispose(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test("switching Goals, locating a Skill, and finishing a review restores the original Pi branch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-goal-workspace-"));
  const catalog = new ConversationCatalog(directory, process.cwd());
  const original = catalog.create();
  catalog.recordGoal(original, "goal-a", "Learn A");
  original.appendMessage({
    role: "toolResult", toolCallId: "t1", toolName: "record_teaching_turn", isError: false,
    content: [{ type: "text", text: JSON.stringify({ active_skill_id: "skill-a" }) }], timestamp: Date.now(),
  } as Parameters<typeof original.appendMessage>[0]);
  const sourceId = original.appendMessage({
    role: "assistant", content: [{ type: "text", text: "Original lesson" }], timestamp: Date.now(),
  } as Parameters<typeof original.appendMessage>[0]);
  const other = catalog.create();
  catalog.recordGoal(other, "goal-b", "Learn B");
  other.appendMessage({ role: "assistant", content: [{ type: "text", text: "Other lesson" }], timestamp: Date.now() } as Parameters<typeof other.appendMessage>[0]);

  let goal = "goal-b";
  let reviewing = false;
  const api = createServer((request, response) => {
    const path = request.url ?? "";
    if (path.includes("/goals/goal-a/activate")) goal = "goal-a";
    if (path.includes("/skills/skill-a/start-review")) reviewing = true;
    if (path.includes("/finish-review")) reviewing = false;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{}");
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const address = api.address();
  assert.ok(address && typeof address === "object");
  const apiBaseUrl = `http://127.0.0.1:${address.port}`;
  const fetchOverview = async (): Promise<LearningOverview> => ({
    current_goal: goal === "goal-a" ? "Learn A" : "Learn B",
    goal_profile: { id: goal }, curriculum_spine: [], current_frontier: null,
    current_focus: null, skills: [{ id: goal === "goal-a" ? "skill-a" : "skill-b" }],
    recent_evidence: [], active_task: { id: reviewing ? "review-operation-001" : `task-${goal}` },
    learning_history: [], current_goal_skill_ids: [goal === "goal-a" ? "skill-a" : "skill-b"],
  });
  const makeStore = () => new WebSessionStore({ conversationDir: directory, apiBaseUrl, fetchOverview });
  try {
    const store = makeStore();
    await store.create();
    const activated = await store.activateGoal("goal-a");
    assert.equal(activated.state.view_mode, "CURRENT");
    assert.equal(activated.messages.at(-1)?.content, "Original lesson");
    const located = await store.locateSkill("goal-a", "skill-a");
    assert.equal(located.previewEntryId, sourceId);
    assert.equal(located.messages.at(-1)?.entryId, sourceId);

    const review = await store.startSkillReview("goal-a", "skill-a", "operation-001");
    assert.deepEqual(review.branches?.map((item) => item.label), ["首次学习", "复习 1"]);
    assert.equal(review.state.overview.active_task && (review.state.overview.active_task as { id: string }).id, "review-operation-001");
    const repeated = await store.startSkillReview("goal-a", "skill-a", "operation-001");
    assert.deepEqual(repeated.branches?.map((item) => item.label), ["首次学习", "复习 1"]);
    const finished = await store.finishSkillReview();
    assert.equal(finished.messages.at(-1)?.content, "Original lesson");
    assert.equal(finished.state.overview.active_task && (finished.state.overview.active_task as { id: string }).id, "task-goal-a");
    const secondReview = await store.startSkillReview("goal-a", "skill-a", "operation-002");
    assert.deepEqual(secondReview.branches?.map((item) => item.label), ["首次学习", "复习 1", "复习 2"]);
    await store.finishSkillReview();
    store.dispose();

    const restarted = makeStore();
    const resumed = await restarted.create();
    assert.equal(resumed.state.view_mode, "CURRENT");
    assert.equal(resumed.messages.at(-1)?.content, "Original lesson");
    restarted.dispose();
    assert.ok((await catalog.open(original.getSessionId())).getEntry(sourceId));
  } finally {
    api.close();
    await once(api, "close");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("returning from an A preview does not turn a mixed RL conversation into the A workspace", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-mixed-goal-return-"));
  const catalog = new ConversationCatalog(directory, process.cwd());
  const originalA = catalog.create();
  catalog.recordGoal(originalA, "goal-a", "Learn A");
  originalA.appendMessage({
    role: "toolResult", toolCallId: "teach-a", toolName: "record_teaching_turn", isError: false,
    content: [{ type: "text", text: JSON.stringify({ active_skill_id: "skill-a" }) }], timestamp: Date.now(),
  } as Parameters<typeof originalA.appendMessage>[0]);
  originalA.appendMessage({ role: "assistant", content: [{ type: "text", text: "A lesson" }], timestamp: Date.now() } as Parameters<typeof originalA.appendMessage>[0]);
  const mixedRL = catalog.create();
  catalog.recordGoal(mixedRL, "goal-a", "Learn A");
  const oldAEntry = mixedRL.appendMessage({ role: "assistant", content: [{ type: "text", text: "Old A context" }], timestamp: Date.now() } as Parameters<typeof mixedRL.appendMessage>[0]);
  catalog.recordGoal(mixedRL, "goal-b", "Learn B");
  mixedRL.appendMessage({ role: "assistant", content: [{ type: "text", text: "RL lesson" }], timestamp: Date.now() } as Parameters<typeof mixedRL.appendMessage>[0]);

  let activeGoal = "goal-b";
  const api = createServer((request, response) => {
    if (request.url?.includes("/goals/goal-a/activate")) activeGoal = "goal-a";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{}");
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const address = api.address();
  assert.ok(address && typeof address === "object");
  const project = (id: "a" | "b") => ({
    status: id === activeGoal.at(-1) ? "CURRENT" as const : "ARCHIVED" as const,
    goal_profile: { id: `goal-${id}`, goal_description: `Learn ${id.toUpperCase()}` },
    curriculum_spine: [], skills: [{ id: `skill-${id}` }], evidence: [], knowledge_cards: [], archived_at: null,
  });
  const makeStore = () => new WebSessionStore({
    conversationDir: directory,
    apiBaseUrl: `http://127.0.0.1:${address.port}`,
    fetchOverview: async (): Promise<LearningOverview> => ({
      current_goal: `Learn ${activeGoal.at(-1)!.toUpperCase()}`,
      goal_profile: { id: activeGoal }, curriculum_spine: [], current_frontier: null,
      current_focus: null, skills: [{ id: `skill-${activeGoal.at(-1)}` }], recent_evidence: [],
      active_task: null, learning_history: [], current_goal_skill_ids: [`skill-${activeGoal.at(-1)}`],
    }),
    fetchLibrary: async () => ({ projects: [project("a"), project("b")] }),
  });
  const store = makeStore();
  try {
    // 明确选中 RL，避免临时文件同时写入时“最近对话”排序碰巧先选到 A。
    await store.activateConversation(mixedRL.getSessionId());
    const preview = await store.locateSkill("goal-a", "skill-a");
    assert.ok(preview.previewEntryId);
    assert.equal(activeGoal, "goal-b", "只读 Skill 预览不能切换 Kernel 前台目标");
    await store.activateConversation(preview.sessionId); // 返回当前分支
    const rl = await store.activateConversation(mixedRL.getSessionId()); // 最近对话：RL
    assert.equal(rl.state.overview.current_goal, "Learn B");
    assert.equal(rl.state.view_goal_id, "goal-b");
    assert.equal(rl.messages.at(-1)?.content, "RL lesson");

    // 旧版本曾把 A 的导航标记追加到 RL JSONL 的末尾；再次打开 RL 应恢复其真实对话。
    store.dispose();
    const polluted = await catalog.open(mixedRL.getSessionId());
    polluted.branch(oldAEntry);
    catalog.recordGoal(polluted, "goal-a", "Learn A", true);
    catalog.recordPosition(polluted);
    activeGoal = "goal-a";
    const restarted = makeStore();
    try {
      const resumed = await restarted.create();
      assert.equal(resumed.state.overview.current_goal, "Learn B", "重启后也应修复旧混合会话的误归属");
      const repaired = await restarted.activateConversation(mixedRL.getSessionId());
      assert.equal(repaired.state.overview.current_goal, "Learn B");
      assert.equal(repaired.messages.at(-1)?.content, "RL lesson");
      const saved = await catalog.open(mixedRL.getSessionId());
      assert.equal(catalog.goalObservation(saved)?.goalId, "goal-b");
      assert.ok(saved.getEntry(oldAEntry), "原 A 分支必须保留");
    } finally {
      restarted.dispose();
    }
  } finally {
    store.dispose();
    api.close();
    await once(api, "close");
    rmSync(directory, { recursive: true, force: true });
  }
});
