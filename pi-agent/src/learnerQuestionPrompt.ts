import type { LearnerQuestionRequest } from "./learnerQuestionTypes.js";

/** 仅兼容旧工具自动追加的评分尾段；原题与冻结契约仍留在教师/Kernel侧。 */
export function learnerQuestionPrompt(request: LearnerQuestionRequest, prompt: string): string {
  if (request.purpose !== "CHECK" || !request.assessment_contract_id) return prompt;
  return prompt.replace(/\r?\n本题检查：[^\r\n]+（\d+分）[ \t]*$/u, "");
}
