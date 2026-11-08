import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import type {SessionManager} from "@earendil-works/pi-coding-agent";
import type {LearningOverview} from "../learningOverviewTool.js";

const ENTRY = "lawa.feedback-recovery";
function append(manager: SessionManager, value: FeedbackRecovery | null): void {
  const previousLeaf = manager.getLeafId();
  try {
    const id = manager.appendCustomEntry(ENTRY, value);
    const file = manager.getSessionFile();
    if (file) {
      const saved = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).find(row => row.id === id);
      if (!saved || JSON.stringify(saved.data) !== JSON.stringify(value)) throw new Error("反馈恢复状态未能保存，请检查本地存储后重试。");
    }
  } catch (error) {
    // SDK先改内存leaf再写文件；保存失败时退回原分支，不能把未落盘的清除当成成功。
    if (previousLeaf) manager.branch(previousLeaf); else manager.resetLeaf();
    throw error;
  }
}
export interface FeedbackRecovery {
  version: 1;
  id: string;
  reason: "model_error" | "assessment_failed";
  sourceUserEntryId: string;
  sessionId: string;
  goalId: string;
  taskId: string;
  skillId: string;
  imageMaterialIds: string[];
}

export function currentFeedbackRecovery(manager: SessionManager, overview: LearningOverview): FeedbackRecovery | null {
  const entry = manager.getBranch().findLast(row => row.type === "custom" && row.customType === ENTRY);
  if (entry?.type !== "custom" || !entry.data) return null;
  const value = entry.data as FeedbackRecovery;
  const task = overview.active_task as {id?: string; status?: string; related_skill_ids?: string[]} | null;
  const latestUser = manager.getBranch().findLast(row => row.type === "message" && row.message.role === "user");
  if (value.version !== 1 || typeof value.id !== "string" || !["model_error", "assessment_failed"].includes(value.reason)
      || value.sessionId !== manager.getSessionId() || value.goalId !== (overview.goal_profile as {id?: string} | null)?.id
      || value.taskId !== task?.id || task.status !== "ACTIVE" || !task.related_skill_ids?.includes(value.skillId)
      || latestUser?.id !== value.sourceUserEntryId || !Array.isArray(value.imageMaterialIds)
      || value.imageMaterialIds.length > 3 || value.imageMaterialIds.some(id => typeof id !== "string")) return null;
  return structuredClone(value);
}

// 恢复票据只指向真实Pi用户回合，不复制答案或代造用户意图；没有点击时不会执行模型。
export function saveFeedbackRecovery(manager: SessionManager, overview: LearningOverview,
  sourceUserEntryId: string, reason: FeedbackRecovery["reason"], imageMaterialIds: string[] = [], previous?: FeedbackRecovery): FeedbackRecovery | null {
  const task = overview.active_task as {id?: string; status?: string; related_skill_ids?: string[]} | null;
  const goalId = (overview.goal_profile as {id?: string} | null)?.id;
  const source = manager.getBranch().find(row => row.id === sourceUserEntryId);
  if (!goalId || !task?.id || task.status !== "ACTIVE" || !task.related_skill_ids?.[0]
      || source?.type !== "message" || source.message.role !== "user") return null;
  const value: FeedbackRecovery = {version: 1, id: previous?.id ?? randomUUID(), reason, sourceUserEntryId,
    sessionId: manager.getSessionId(), goalId, taskId: task.id, skillId: task.related_skill_ids[0], imageMaterialIds: [...imageMaterialIds]};
  append(manager, value);
  return value;
}

export function clearFeedbackRecovery(manager: SessionManager): void {
  const last = manager.getBranch().findLast(row => row.type === "custom" && row.customType === ENTRY);
  if (last?.type === "custom" && last.data !== null) append(manager, null);
}
