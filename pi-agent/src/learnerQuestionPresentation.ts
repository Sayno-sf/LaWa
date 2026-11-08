import { learnerQuestionPrompt } from "./learnerQuestionPrompt.js";
import type { TeachingSessionSnapshot } from "./teachingSession.js";
import type { LearningOverview } from "./learningOverviewTool.js";

/** Web和助教只获得待答题面。复制投影，绝不改写持久会话或评分契约。 */
export function learnerTeachingSnapshot(snapshot: TeachingSessionSnapshot): TeachingSessionSnapshot {
  const result = structuredClone(snapshot);
  const request = result.learner_questions?.pending;
  if (!request) return result;
  const prompts = new Map(request.questions.map(q => [q.prompt, learnerQuestionPrompt(request, q.prompt)]));
  const clean = (text: string) => prompts.get(text) ?? text;
  request.questions.forEach(q => { q.prompt = clean(q.prompt); });
  if (result.current_question) result.current_question = clean(result.current_question);
  result.check_questions = result.check_questions.map(clean);
  if (result.active_recall) {
    result.active_recall.current_question = clean(result.active_recall.current_question);
    result.active_recall.primary_questions = result.active_recall.primary_questions.map(clean);
  }
  return result;
}

/** Task评价关注点可能含答案，仅教师使用；浏览器仍保留任务身份与真实状态。 */
export function learnerOverview(overview: LearningOverview): LearningOverview {
  const result = structuredClone(overview);
  for (const task of [result.active_task, result.current_focus]) {
    if (task && typeof task === "object") delete (task as Record<string, unknown>).teaching_activity;
  }
  return result;
}
