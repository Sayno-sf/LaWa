export interface AssessmentCriterion { label: string; earned: number; possible: number; feedback: string }
export interface AnswerAssessment {
  correction_reason?: string | null;
  id: string; goal_id: string; skill_id: string; topic_id: string; topic: string;
  source_task_id: string; source_session_id: string; source_turn_id: string; question_entry_id: string;
  question: string; answer_excerpt: string; answer_sha256: string; answer_truncated: boolean;
  criteria: AssessmentCriterion[]; summary: string; strengths: string[]; gaps: string[];
  assistance_level: string; score: number; max_score: 10;
  follow_up: "SECURE" | "RECHECK" | "REINFORCE"; review_after: number | null; created_at: string;
}
export type AnswerAssessmentCard = Pick<AnswerAssessment, "id" | "goal_id" | "skill_id" | "topic_id" | "topic" | "question" |
  "criteria" | "summary" | "strengths" | "gaps" | "assistance_level" | "score" | "max_score" | "follow_up" | "review_after" | "created_at" | "correction_reason">;

// Pi中的工具结果是已保存成绩的展示快照；界面和Gateway共用校验，不能把任意JSON当成绩。
export function readAnswerAssessment(value: unknown): AnswerAssessment | null {
  if (!value || typeof value !== "object") return null;
  const a = value as AnswerAssessment;
  for (const key of ["id", "goal_id", "skill_id", "topic_id", "source_task_id", "source_session_id", "source_turn_id", "question_entry_id"] as const) {
    if (typeof a[key] !== "string" || !a[key].trim() || a[key].length > 200) return null;
  }
  for (const [key, maximum] of [["topic", 160], ["question", 2000], ["answer_excerpt", 8000], ["summary", 600]] as const) {
    if (typeof a[key] !== "string" || !a[key].trim() || Array.from(a[key]).length > maximum) return null;
  }
  if (!Array.isArray(a.criteria) || a.criteria.length < 1 || a.criteria.length > 5 || a.criteria.some(c =>
    !c || typeof c !== "object" || typeof c.label !== "string" || !c.label.trim() || c.label.length > 100 || typeof c.feedback !== "string" || !c.feedback.trim() || c.feedback.length > 400 ||
    !Number.isInteger(c.earned) || !Number.isInteger(c.possible) || c.possible < 1 || c.possible > 10 || c.earned < 0 || c.earned > c.possible)) return null;
  if (a.max_score !== 10 || a.criteria.reduce((n, c) => n + c.possible, 0) !== 10 || a.criteria.reduce((n, c) => n + c.earned, 0) !== a.score) return null;
  if ([a.strengths, a.gaps].some(list => !Array.isArray(list) || list.length > 4 || list.some(t => typeof t !== "string" || !t.trim() || t.length > 240))) return null;
  if (a.score < 8 && !a.gaps.length || !["INDEPENDENT", "TRANSFERRED", "WITH_HINT", "WITH_REFERENCE", "WITH_HELP", "UNKNOWN"].includes(a.assistance_level)) return null;
  const plan = a.score >= 8 ? !a.gaps.length && ["INDEPENDENT", "TRANSFERRED"].includes(a.assistance_level) ? "SECURE" : "RECHECK" : "REINFORCE";
  if (a.follow_up !== plan || a.review_after !== null && a.review_after !== (plan === "SECURE" ? null : plan === "RECHECK" ? 5 : 3) || !Number.isFinite(Date.parse(a.created_at))) return null;
  if (typeof a.answer_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(a.answer_sha256) || typeof a.answer_truncated !== "boolean") return null;
  return structuredClone(a);
}
