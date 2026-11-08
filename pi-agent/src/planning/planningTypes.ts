export type LearningDepth = "OVERVIEW" | "PRACTICAL" | "DEEP";

export interface GoalProfileInput {
  id: string;
  goal_description: string;
  background_summary: string;
  desired_outcome: string;
  /** 确认目标时确定的领域；旧目标缺省为空，不能从关键词擅自补写。 */
  learning_domain?: string;
  learning_preferences: string[];
  time_constraint: string;
  prior_knowledge_claims: string[];
}

export function normalizeLearningDomain(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error("学习领域须为简短名称。");
  const domain = value.normalize("NFKC").replace(/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/gu, " ").replace(/^ +| +$/g, "").toLowerCase();
  if ([...domain].length > 80 || ["general", "generic", "other", "unknown", "通用", "其他", "其它", "未知", "不确定", "全领域", "全部"].includes(domain))
    throw new Error("请填写具体学习领域，不能用通用、其他或未知作为跨目标范围。");
  return domain;
}

export function normalizeGoalProfile(profile: GoalProfileInput): GoalProfileInput {
  const result = {...profile};
  const domain = normalizeLearningDomain(profile.learning_domain);
  // 空字段等同旧版省略，不能因此改变已保存的目标确认与资料阅读身份。
  if (domain) result.learning_domain = domain;
  else delete result.learning_domain;
  return result;
}

export interface CurriculumMilestoneInput {
  /** 当前Goal内已展开知识点的阶段归属；旧规划缺省为空。 */
  skill_ids?: string[];
  id: string;
  name: string;
  description: string;
  target_depth: LearningDepth;
}

export interface PlannedSkillInput {
  id: string;
  name: string;
  description: string;
  prerequisites: string[];
  target_depth: LearningDepth;
}

export interface FrontierPlanInput {
  focus_skill_id: string;
  supporting_skill_ids: string[];
  reason: string;
  target_depth: LearningDepth;
  suggested_learning_mode: "EXPLAIN" | "QUIZ" | "BUILD" | "DEBUG";
  next_action: string;
}

export interface InitializeLearningGoalInput {
  goal_profile: GoalProfileInput;
  curriculum_spine: CurriculumMilestoneInput[];
  frontier_skills: PlannedSkillInput[];
  frontier: FrontierPlanInput;
  replace_existing: boolean;
}

export interface ApplyCurriculumPlanInput {
  milestone_assignments?: Array<{skill_id: string; milestone_id: string}>;
  frontier: FrontierPlanInput;
  added_skills: PlannedSkillInput[];
  depth_changes: Array<{ skill_id: string; target_depth: LearningDepth }>;
  prerequisite_additions: Array<{
    skill_id: string;
    prerequisite_id: string;
  }>;
  remove_skill_ids: string[];
}

export interface LearningPlanRevisionInput {
  id: string;
  goal_profile: GoalProfileInput;
  curriculum_spine: CurriculumMilestoneInput[];
  added_skills: PlannedSkillInput[];
  updated_skills: PlannedSkillInput[];
  remove_skill_ids: string[];
  frontier: FrontierPlanInput;
  reason: string;
}

export interface LearningPlanRevision {
  id: string;
  goal_id: string;
  base_revision: number;
  revision: number;
  base_signature: string;
  goal_profile: GoalProfileInput & {created_at: string};
  curriculum_spine: CurriculumMilestoneInput[];
  added_skills: PlannedSkillInput[];
  updated_skills: PlannedSkillInput[];
  remove_skill_ids: string[];
  frontier: FrontierPlanInput;
  summary: string;
  reason: string;
  status: "PENDING" | "CONFIRMED" | "REJECTED" | "SUPERSEDED";
  feedback: string;
  decision_request_id: string;
  created_at: string;
  decided_at: string | null;
}
