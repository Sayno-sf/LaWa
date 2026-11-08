import {createHash, randomUUID} from "node:crypto";
import type {LearningOverview} from "./learningOverviewTool.js";
import type {LearnerAnswerRecord, LearnerQuestionRequest} from "./learnerQuestionTypes.js";

export const MASTERY_REVIEW_OPTIONS = [
  {id: "proceed", label: "确认掌握并继续"},
  {id: "revise", label: "还有不清楚的地方"},
  {id: "skip", label: "暂不确认，继续下一节"},
];

export function masteryReviewSignature(overview: LearningOverview): string {
  const goal = overview.goal_profile as {id?: string} | null;
  const task = overview.active_task as {id?: string; status?: string; related_skill_ids?: string[]} | null;
  // 用户确认会改变Skill状态；身份锚点不包含该可预期变化，仍核对Goal/Task/Skill/路线版本。
  return createHash("sha256").update(JSON.stringify({goal: goal?.id, task: task?.id,
    status: task?.status, skills: task?.related_skill_ids, revision: overview.plan_revision ?? null})).digest("hex");
}

export function masteryReviewRequest(overview: LearningOverview, sessionId: string): LearnerQuestionRequest | undefined {
  const goal = overview.goal_profile as {id?: string} | null;
  const task = overview.active_task as {id?: string; status?: string; related_skill_ids?: string[]} | null;
  const skill = overview.skills.filter((s): s is {id: string; status: string; name?: string} =>
    !!s && typeof s === "object" && "id" in s && typeof s.id === "string" &&
    "status" in s && typeof s.status === "string").find(s => s.id === task?.related_skill_ids?.[0]);
  if (!goal?.id || !task?.id || task.status !== "ACTIVE" || task.related_skill_ids?.length !== 1 || !skill ||
      !overview.current_goal_skill_ids.includes(skill.id) || !["LEARNING", "PRACTICING"].includes(skill.status)) return;
  return {id: randomUUID(), purpose: "CONFIRM_MASTERY", session_id: sessionId, goal_id: goal.id,
    task_id: task.id, skill_id: skill.id, scope_signature: masteryReviewSignature(overview),
    title: "这一节，你觉得掌握了吗？", questions: [{id: "mastery-review", selection: "single",
      prompt: `关于「${String(skill.name ?? "当前知识点").slice(0, 120)}」，你觉得现在掌握得怎样？`,
      options: MASTERY_REVIEW_OPTIONS.map(option => ({...option}))}]};
}

export function masteryReviewDecision(answer: LearnerAnswerRecord): {action: "confirm" | "needs_work" | "skip"; feedback: string} | null {
  if (answer.request.purpose !== "CONFIRM_MASTERY") return null;
  const value = answer.reply?.answers[0];
  if (!value || answer.reply?.answers.length !== 1 || value.selected_option_ids.length !== 1) return null;
  const feedback = value.other_text.trim();
  switch (value.selected_option_ids[0]) {
    case "proceed": return feedback ? null : {action: "confirm", feedback};
    case "skip": return feedback ? null : {action: "skip", feedback};
    case "revise": return {action: "needs_work", feedback};
    default: return null;
  }
}
