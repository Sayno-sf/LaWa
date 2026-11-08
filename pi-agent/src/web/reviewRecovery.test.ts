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

// Kernel 已完成但 Pi 尚未返回，是跨进程中断及旧版暂停关系的真实恢复窗口。
for (const scenario of ["restart", "switch-conversation", "switch-goal", "cross-session", "master-from-original", "paused-parent", "legacy-mastered", "ongoing", "later-task", "no-parent"] as const) {
  test(`completed review recovery: ${scenario}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "lawa-review-recovery-"));
    const catalog = new ConversationCatalog(directory);
    const original = catalog.create();
    catalog.recordGoal(original, "goal-review", "Review goal");
    original.appendMessage({ role: "assistant", content: [{ type: "text", text: "Original unfinished lesson" }], timestamp: Date.now() } as Parameters<typeof original.appendMessage>[0]);
    catalog.recordSkillAnchor(original, "goal-review", "original-skill");
    const returnEntryId = original.getLeafId();
    const reviewed = scenario === "cross-session" || scenario === "master-from-original" ? catalog.create() : original;
    if (reviewed !== original) catalog.recordGoal(reviewed, "goal-review", "Review goal");
    catalog.recordReview(reviewed, {
      operationId: "operation-001", goalId: "goal-review", skillId: "review-skill", sourceEntryId: null,
      returnEntryId, returnSessionId: original.getSessionId(), reviewTaskId: "review-operation-001", createdAt: new Date().toISOString(),
    });
    reviewed.appendMessage({ role: "assistant", content: [{ type: "text", text: "Full review transcript" }], timestamp: Date.now() } as Parameters<typeof reviewed.appendMessage>[0]);
    const reviewLeaf = reviewed.getLeafId();
    let activeId: string | null = scenario === "paused-parent" || scenario === "no-parent" ? null
      : scenario === "ongoing" || scenario === "legacy-mastered" || scenario === "master-from-original" ? "review-operation-001" : scenario === "later-task" ? "later-task" : "original-task";
    let status = scenario === "ongoing" || scenario === "legacy-mastered" || scenario === "master-from-original" ? "ACTIVE" : "DONE";
    const parentId = scenario === "no-parent" ? null : "original-task";
    const calls: string[] = [];
    const overview = async (): Promise<LearningOverview> => ({
      current_goal: "Review goal", goal_profile: { id: "goal-review" }, curriculum_spine: [], current_frontier: null,
      current_focus: null, skills: [{ id: "review-skill", status: scenario === "ongoing" || (scenario === "master-from-original" && status === "ACTIVE") ? "PRACTICING" : "MASTERED_BY_USER" }, { id: "original-skill", status: "LEARNING" }],
      recent_evidence: [], active_task: activeId ? { id: activeId, related_skill_ids: [activeId.startsWith("review-") ? "review-skill" : "original-skill"] } : null,
      learning_history: [], current_goal_skill_ids: ["review-skill", "original-skill"],
    });
    const api = createServer((request, response) => {
      const path = request.url ?? ""; calls.push(`${request.method} ${path}`);
      if (path.endsWith("/finish-review")) activeId = parentId;
      if (path.endsWith("/confirm-mastery")) { activeId = parentId; status = "DONE"; }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(path.startsWith("/api/learning/tasks/")
        ? { id: "review-operation-001", goal_id: "goal-review", status, review_parent_task_id: parentId }
        : path.endsWith("/confirm-mastery") ? { id: "review-skill", status: "MASTERED_BY_USER" } : {}));
    });
    api.listen(0, "127.0.0.1"); await once(api, "listening");
    const address = api.address(); assert.ok(address && typeof address === "object");
    const store = new WebSessionStore({ conversationDir: directory, apiBaseUrl: `http://127.0.0.1:${address.port}`, fetchOverview: overview });
    try {
      let restored = scenario === "switch-conversation" ? await store.activateConversation(reviewed.getSessionId())
        : scenario === "switch-goal" ? await store.activateGoal("goal-review") : await store.create();
      if (scenario === "master-from-original") {
        await store.activateConversation(original.getSessionId());
        const state = await store.skillAction(original.getSessionId(), "master", "review-skill");
        assert.ok(state.restored_session);
        restored = state.restored_session;
      }
      if (scenario === "ongoing" || scenario === "later-task") {
        assert.equal(restored.messages.at(-1)?.content, "Full review transcript");
        assert.equal(catalog.currentReview(await catalog.open(reviewed.getSessionId()))?.reviewTaskId, "review-operation-001");
        assert.equal(calls.some((call) => call.endsWith("/finish-review")), false);
        if (scenario === "later-task") {
          await store.finishSkillReview();
          assert.equal((await catalog.open(reviewed.getSessionId())).getLeafId(), reviewLeaf, "late finish must not rewind a later task");
        }
      } else {
        assert.equal(restored.sessionId, original.getSessionId());
        assert.equal(restored.messages.at(-1)?.content, "Original unfinished lesson");
        assert.equal((restored.state.overview.active_task as { id?: string } | null)?.id ?? null, scenario === "no-parent" ? null : "original-task");
        assert.equal(catalog.currentReview(await catalog.open(original.getSessionId())), null);
        assert.equal(calls.filter((call) => call.endsWith("/finish-review")).length, scenario === "paused-parent" || scenario === "legacy-mastered" ? 1 : 0);
        const bytes = readFileSync(original.getSessionFile()!);
        const history = restored.branches?.find((branch) => branch.label === "复习 1");
        if (history) {
          const preview = await store.selectBranch(history.entryId);
          assert.equal(preview.previewSkillId, "review-skill");
          assert.equal(preview.messages.at(-1)?.content, "Full review transcript");
          assert.ok(preview.previewEntryId);
          assert.deepEqual(readFileSync(original.getSessionFile()!), bytes, "history must leave execution leaf/file unchanged");
          assert.equal((await store.create()).messages.at(-1)?.content, "Original unfinished lesson");
        }
      }
    } finally {
      store.dispose(); api.close(); await once(api, "close"); rmSync(directory, { recursive: true, force: true });
    }
  });
}
