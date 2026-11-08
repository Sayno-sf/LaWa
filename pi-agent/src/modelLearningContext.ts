import type { LearningOverview } from "./learningOverviewTool.js";

export interface LearningContextQuery { scope?: "current" | "route"; offset?: number; limit?: number }
export interface ModelLearningContext {
  learning_paths?: {active_branch_id: string | null; branches: Array<Record<string, unknown>>; omitted_branches: number};
  imported_goal_needs_route?: boolean;
  imported_learning?: LearningOverview["imported_learning"];
  practice_context?: {due_reviews: Array<Record<string, unknown>>; topics: Array<Record<string, unknown>>; omitted_topics: number};
  scope: "current" | "route";
  current_goal: string | null;
  plan_revision?: number;
  goal_profile: Record<string, unknown> | null;
  current_frontier: Record<string, unknown> | null;
  active_task: Record<string, unknown> | null;
  skills: Array<Record<string, unknown>>;
  curriculum_spine?: Array<Record<string, unknown>>;
  page?: { offset: number; limit: number; skills_total: number; milestones_total: number; next_offset: number | null };
  omitted_skills: number;
  truncated_fields: string[];
}
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

// 唯一的模型状态投影：原始 overview 仍供 Kernel 校验和页面使用，模型默认只见当前事实。
// 文本/条目超预算明确标记，不把截断当完整记录；身份 ID 保留原值，不生成不可查询的半截 ID。
export function projectLearningContext(overview: LearningOverview, query: LearningContextQuery = {}): ModelLearningContext {
  const truncated = new Set<string>();
  const text = (value: unknown, maximum: number, field: string): string | undefined => {
    if (typeof value !== "string") return undefined;
    if (value.length > maximum) truncated.add(field);
    return value.slice(0, maximum);
  };
  const list = (value: unknown, maximum: number, field: string): string[] => {
    const values = strings(value);
    if (values.length > maximum) truncated.add(field);
    return values.slice(0, maximum);
  };
  const profile = object(overview.goal_profile);
  const frontier = object(overview.current_frontier);
  const task = object(overview.active_task);
  const allowed = new Set(overview.current_goal_skill_ids);
  const allSkills = overview.skills.map(object).filter((item): item is Record<string, unknown> =>
    !!item && typeof item.id === "string" && allowed.has(item.id));
  const byId = new Map(allSkills.map(skill => [skill.id as string, skill]));
  const primary = [...new Set([
    ...strings(task?.related_skill_ids), frontier?.focus_skill_id, ...strings(frontier?.supporting_skill_ids),
  ].filter((id): id is string => typeof id === "string" && allowed.has(id)))];
  const relevant = [...new Set([...primary, ...primary.flatMap(id => strings(byId.get(id)?.prerequisites).filter(prior => allowed.has(prior)))])];
  const scope = query.scope === "route" ? "route" : "current";
  const offset = Number.isSafeInteger(query.offset) && query.offset! >= 0 ? query.offset! : 0;
  const limit = Number.isSafeInteger(query.limit) ? Math.max(1, Math.min(20, query.limit!)) : 10;
  const selected = scope === "route" ? allSkills.slice(offset, offset + limit)
    : relevant.slice(0, 12).flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
  const skillMetadata = (skill: Record<string, unknown>) => ({
    id: skill.id, name: text(skill.name, 120, `skill.${skill.id}.name`), status: skill.status,
    target_depth: skill.target_depth,
    prerequisites: list(skill.prerequisites, 10, `skill.${skill.id}.prerequisites`).filter(id => allowed.has(id)),
    evidence_count: Array.isArray(skill.evidence_ids) ? skill.evidence_ids.length : 0,
    ...(scope === "route" ? { description: text(skill.description, 240, `skill.${skill.id}.description`) } : {}),
  });
  const context: ModelLearningContext = {
    ...(overview.imported_goal_needs_route ? {imported_goal_needs_route: true} : {}),
    ...(overview.imported_learning ? {imported_learning: {...overview.imported_learning,
      topics: overview.imported_learning.topics.slice(0, 20).map(t => t.slice(0, 200))}} : {}),
    scope, current_goal: text(overview.current_goal, 600, "current_goal") ?? null,
    ...(overview.plan_revision !== undefined ? {plan_revision: overview.plan_revision} : {}),
    goal_profile: profile ? {
      id: profile.id,
      ...(profile.learning_domain ? {learning_domain: profile.learning_domain} : {}),
      desired_outcome: text(profile.desired_outcome, 400, "goal_profile.desired_outcome"),
      background_summary: text(profile.background_summary, 240, "goal_profile.background_summary"),
      learning_preferences: list(profile.learning_preferences, 6, "goal_profile.learning_preferences")
        .map((item, index) => text(item, 200, `goal_profile.learning_preferences.${index}`)),
      time_constraint: text(profile.time_constraint, 120, "goal_profile.time_constraint"),
      ...(scope === "route" ? { prior_knowledge_claims: list(profile.prior_knowledge_claims, 5, "goal_profile.prior_knowledge_claims")
        .map((item, index) => text(item, 200, `goal_profile.prior_knowledge_claims.${index}`)) } : {}),
    } : null,
    current_frontier: frontier ? {
      focus_skill_id: frontier.focus_skill_id,
      supporting_skill_ids: list(frontier.supporting_skill_ids, 12, "frontier.supporting_skill_ids"),
      target_depth: frontier.target_depth, suggested_learning_mode: frontier.suggested_learning_mode,
      next_action: text(frontier.next_action, 240, "frontier.next_action"),
      ...(frontier.teaching_preferences_revision ? {teaching_preferences_revision: frontier.teaching_preferences_revision} : {}),
      ...(frontier.next_action_status ? {next_action_status: frontier.next_action_status} : {}),
    } : null,
    active_task: task ? { id: task.id, title: text(task.title, 180, "task.title"), status: task.status,
      description: text(task.description, 800, "task.description"),
      activity_revision: task.activity_revision ?? 0,
      ...(task.teaching_activity ? {teaching_activity: task.teaching_activity} : {}),
      ...(task.teaching_activity_status ? {teaching_activity_status: task.teaching_activity_status} : {}),
      related_skill_ids: list(task.related_skill_ids, 12, "task.related_skill_ids") } : null,
    skills: selected.map(skillMetadata), omitted_skills: Math.max(0, allSkills.length - selected.length), truncated_fields: [],
  };
  if (scope === "route") {
    const milestones = overview.curriculum_spine.map(object).filter((item): item is Record<string, unknown> => !!item);
    context.curriculum_spine = milestones.slice(offset, offset + limit).map(item => ({
      id: item.id, name: text(item.name, 120, `milestone.${item.id}.name`), target_depth: item.target_depth,
      description: text(item.description, 240, `milestone.${item.id}.description`),
    }));
    context.page = { offset, limit, skills_total: allSkills.length, milestones_total: milestones.length,
      next_offset: offset + limit < Math.max(allSkills.length, milestones.length) ? offset + limit : null };
  }
  if (overview.practice_context) {
    const projectTopic = (value: unknown): Record<string, unknown> | null => {
      const topic = object(value);
      if (!topic || typeof topic.skill_id !== "string" || !allowed.has(topic.skill_id) || typeof topic.topic_id !== "string") return null;
      return {topic_id: topic.topic_id, skill_id: topic.skill_id, topic: text(topic.topic, 160, "practice.topic"),
        score: topic.score, assistance_level: topic.assistance_level, follow_up: topic.follow_up,
        remaining_answers: topic.remaining_answers, due: topic.due, summary: text(topic.summary, 180, "practice.summary"),
        gaps: list(topic.gaps, 2, "practice.gaps").map((gap, i) => text(gap, 160, `practice.gaps.${i}`))};
    };
    const projectTopics = (values: unknown[] | undefined, limit: number) => (values ?? []).slice(0, limit).map(projectTopic).filter((v): v is Record<string, unknown> => v !== null);
    const topics = projectTopics(overview.practice_context.topics, 6);
    context.practice_context = {due_reviews: projectTopics(overview.practice_context.due_reviews, 3), topics,
      omitted_topics: Math.max(0, (overview.practice_context.topic_count ?? topics.length) - topics.length)};
  }
  if (overview.learning_paths) {
    const paths = overview.learning_paths;
    const relevant = paths.branches.filter(b => scope === "route" || b.id === paths.active_branch_id ||
      b.status === "PROPOSED" || b.return_task_id === task?.id);
    // 活动分支优先保留；完整背景按需读取，避免长期学习后主提示词随历史分支无限膨胀。
    const page = scope === "route" ? relevant.slice(offset, offset + limit) :
      [...relevant.filter(b => b.id === paths.active_branch_id), ...relevant.filter(b => b.id !== paths.active_branch_id).slice(-3)];
    context.learning_paths = {active_branch_id: paths.active_branch_id, omitted_branches: relevant.length - page.length,
      branches: page.map(b => ({id: b.id, goal_id: b.goal_id, purpose: b.purpose, status: b.status,
        anchor_kind: b.anchor_kind, anchor_id: b.anchor_id, revision: b.revision, return_task_id: b.return_task_id,
        title: text(b.title, 120, `branch.${b.id}.title`), scope: text(b.scope, 500, `branch.${b.id}.scope`),
        reason: text(b.reason, 200, `branch.${b.id}.reason`), return_condition: text(b.return_condition, 250, `branch.${b.id}.return_condition`),
        skill_ids: list(b.skill_ids, 12, `branch.${b.id}.skill_ids`), source_goal_ids: b.source_goal_ids,
        handoff: text(b.handoff, 1600, `branch.${b.id}.handoff`), assistance_provided: b.assistance_provided}))};
  }
  context.truncated_fields = [...truncated];
  return context;
}

interface ContextMessage { role?: string; toolName?: string; isError?: boolean; content?: unknown }
// 老对话可能含完整账本投影。仅复制模型输入中的旧 overview，保留工具 ID/时间/其他消息，绝不重写 Pi JSONL。
// 已经是按需 route 的新结果不再缩成 current；历史快照不能冒充每轮最新 Kernel 状态。
export function compactOverviewMessages<T extends ContextMessage>(messages: readonly T[]): T[] {
  return messages.map(message => {
    if (message.role !== "toolResult" || message.toolName !== "get_learning_overview" || message.isError === true || !Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map(part => {
      if (!part || typeof part !== "object" || part.type !== "text" || typeof part.text !== "string") return part;
      let value: unknown;
      try { value = JSON.parse(part.text); } catch { return part; }
      const full = object(value);
      if (!full || !Array.isArray(full.skills) || !Array.isArray(full.current_goal_skill_ids) ||
        !Array.isArray(full.curriculum_spine) || !Array.isArray(full.learning_history) ||
        !(typeof full.current_goal === "string" || full.current_goal === null)) return part;
      changed = true;
      return { ...part, text: JSON.stringify({ ...projectLearningContext(full as unknown as LearningOverview), historical_snapshot: true }) };
    });
    return changed ? { ...message, content } : message;
  });
}
