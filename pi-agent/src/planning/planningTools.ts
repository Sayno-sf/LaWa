import { createHash } from "node:crypto";
import {bindPreferenceRevision} from "../teachingPreferences.js";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { LearningToolHttpOptions } from "../learningWriteTools.js";
import {
  GoalOnboardingContext,
  type GoalUnderstandingInput,
} from "./goalOnboarding.js";
import type {
  ApplyCurriculumPlanInput,
  InitializeLearningGoalInput,
  LearningPlanRevision,
  LearningPlanRevisionInput,
} from "./planningTypes.js";
import {normalizeGoalProfile} from "./planningTypes.js";
import {planningHash, type PlanningReadingCoordinator} from "./planningReading.js";
import {planRevisionDecision} from "../learnerQuestions.js";
import type {TeachingSessionContext} from "../teachingSession.js";

const LearningDepthSchema = Type.Union([
  Type.Literal("OVERVIEW"),
  Type.Literal("PRACTICAL"),
  Type.Literal("DEEP"),
]);
const TeachingModeSchema = Type.Union([
  Type.Literal("EXPLAIN"),
  Type.Literal("QUIZ"),
  Type.Literal("BUILD"),
  Type.Literal("DEBUG"),
]);
const GoalProfileSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  goal_description: Type.String(),
  background_summary: Type.String(),
  desired_outcome: Type.String(),
  learning_domain: Type.Optional(Type.String({maxLength: 80, description: "稳定的具体学习领域名称，如英语、编程、历史、统计学；这是领域范围，不是教法或用途。确认目标前填写，复用已有规范领域名；旧目标未知可省略，禁止general/通用等占位。"})),
  learning_preferences: Type.Array(Type.String()),
  time_constraint: Type.String(),
  prior_knowledge_claims: Type.Array(Type.String()),
});
const MilestoneSchema = Type.Object({
  skill_ids: Type.Array(Type.String({minLength: 1}), {uniqueItems: true, maxItems: 200, description: "Explicit IDs of expanded Skills belonging to this stage in the current Goal; every near-frontier Skill should be assigned once. Future stages may be empty."}),
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  target_depth: LearningDepthSchema,
});
const PlannedSkillSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  description: Type.String(),
  prerequisites: Type.Array(Type.String()),
  target_depth: LearningDepthSchema,
});
const FrontierSchema = Type.Object({
  focus_skill_id: Type.String({ minLength: 1 }),
  supporting_skill_ids: Type.Array(Type.String()),
  reason: Type.String({ minLength: 1 }),
  target_depth: LearningDepthSchema,
  suggested_learning_mode: TeachingModeSchema,
  next_action: Type.String({ minLength: 1 }),
});
const PlanRevisionInputSchema = Type.Object({
  goal_profile: GoalProfileSchema,
  curriculum_spine: Type.Array(MilestoneSchema, {minItems: 5, maxItems: 8}),
  added_skills: Type.Array(PlannedSkillSchema, {maxItems: 50}),
  updated_skills: Type.Array(PlannedSkillSchema, {maxItems: 50}),
  remove_skill_ids: Type.Array(Type.String({minLength: 1, maxLength: 200}), {maxItems: 50}),
  frontier: FrontierSchema,
  reason: Type.String({minLength: 1, maxLength: 1200}),
});

/** 新模型写入必须给展开节点明确归属；历史回执恢复仍使用兼容的HTTP函数，不重写旧同意。 */
function requireMilestoneMembership(spine: InitializeLearningGoalInput["curriculum_spine"], skillIds: readonly string[]): void {
  for (const id of skillIds) {
    if (spine.filter(stage => stage.skill_ids?.includes(id)).length !== 1)
      throw new Error(`知识点 ${id} 必须明确归入一个路线阶段，请补齐对应阶段的skill_ids。`);
  }
}

function requestSignal(options: LearningToolHttpOptions, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep a non-JSON server response for an actionable error message.
  }
  if (!response.ok) {
    const detail =
      typeof body === "object" && body !== null && "detail" in body
        ? String((body as { detail: unknown }).detail)
        : text;
    throw new Error(`Learning API returned HTTP ${response.status}: ${detail}`);
  }
  return body;
}

function validatePlanShape(input: InitializeLearningGoalInput): void {
  if (input.curriculum_spine.length < 5 || input.curriculum_spine.length > 8) {
    throw new Error("Initial Curriculum Spine must contain 5 to 8 milestones");
  }
  if (input.frontier_skills.length < 1 || input.frontier_skills.length > 3) {
    throw new Error("Initial Learning Frontier must contain 1 to 3 Skills");
  }
  const stableId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const ids = [
    input.goal_profile.id,
    ...input.curriculum_spine.map((item) => item.id),
    ...input.frontier_skills.map((item) => item.id),
  ];
  if (ids.some((id) => !stableId.test(id))) {
    throw new Error("Goal, milestone, and Skill IDs must be stable kebab-case IDs");
  }
}

export async function initializeLearningGoal(
  input: InitializeLearningGoalInput,
  options: LearningToolHttpOptions & { onboardingSessionId?: string; readingRequirementId?: string } = {},
  signal?: AbortSignal,
): Promise<unknown> {
  input = {...input, goal_profile: normalizeGoalProfile(input.goal_profile)};
  validatePlanShape(input);
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  const url = `${baseUrl}/api/learning/curriculum/initialize`;
  const payload = { ...bindPreferenceRevision(input, options.teachingPreferencesRevision?.()), ...(options.onboardingSessionId ? { onboarding_session_id: options.onboardingSessionId } : {}),
    ...(options.readingRequirementId ? {reading_requirement_id: options.readingRequirementId} : {}) };
  const request = async (recoverOnly = false) => (options.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    // 草稿 ID 由 Web runtime 注入，既不是模型规划字段，也不会代替用户确认。
    body: JSON.stringify({...payload, ...(recoverOnly ? {recover_only: true} : {})}),
    signal: requestSignal(options, signal),
  });
  const recover = async () => {
    const response = await request(true);
    if (response.status === 404 && (await response.clone().json() as {code?: string}).code === "PLANNING_RESULT_NOT_FOUND") return null;
    return responseJson(response);
  };
  // 无资料路线同样可能“已原子保存但HTTP回包丢失”。先只查询原提交，不能盲重建或替换另一个Goal。
  if (options.onboardingSessionId && !options.readingRequirementId) {
    const saved = await recover();
    if (saved !== null) return saved;
  }
  (options.log ?? console.error)(`[tool:http] POST ${url}`);
  try { return await responseJson(await request()); }
  catch (error) {
    if (options.onboardingSessionId && !signal?.aborted) {
      try { const saved = await recover(); if (saved !== null) return saved; }
      catch { /* 查询也失败时结果仍未知；保留原草案与错误，禁止自动第二次创建。 */ }
    }
    throw error;
  }
}

export async function applyCurriculumPlan(
  input: ApplyCurriculumPlanInput,
  options: LearningToolHttpOptions = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  const url = `${baseUrl}/api/learning/frontier/apply`;
  (options.log ?? console.error)(`[tool:http] POST ${url}`);
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(bindPreferenceRevision(input, options.teachingPreferencesRevision?.())),
    signal: requestSignal(options, signal),
  });
  return responseJson(response);
}

export async function prepareLearningPlanRevision(
  input: LearningPlanRevisionInput,
  options: LearningToolHttpOptions = {},
  signal?: AbortSignal,
): Promise<LearningPlanRevision> {
  input = {...input, goal_profile: normalizeGoalProfile(input.goal_profile)};
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  const url = `${baseUrl}/api/learning/plan-revisions`;
  (options.log ?? console.error)(`[tool:http] POST ${url}`);
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: {Accept: "application/json", "Content-Type": "application/json"},
    body: JSON.stringify(bindPreferenceRevision(input, options.teachingPreferencesRevision?.())),
    signal: requestSignal(options, signal),
  });
  const value = await responseJson(response);
  if (!value || typeof value !== "object" || (value as {id?: unknown}).id !== input.id
      || (value as {status?: unknown}).status !== "PENDING")
    throw new Error("Plan revision response did not bind the prepared candidate");
  return value as LearningPlanRevision;
}

export async function getLearningPlanRevision(
  id: string,
  options: LearningToolHttpOptions = {},
  signal?: AbortSignal,
): Promise<LearningPlanRevision> {
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  const url = `${baseUrl}/api/learning/plan-revisions/${encodeURIComponent(id)}`;
  const response = await (options.fetchImpl ?? fetch)(url, {
    headers: {Accept: "application/json"},
    signal: requestSignal(options, signal),
  });
  const value = await responseJson(response);
  if (!value || typeof value !== "object" || (value as {id?: unknown}).id !== id)
    throw new Error("Plan revision response did not match the requested candidate");
  return value as LearningPlanRevision;
}

export async function decideLearningPlanRevision(
  id: string,
  input: {action: "CONFIRM" | "REJECT"; feedback: string; request_id: string},
  options: LearningToolHttpOptions = {},
  signal?: AbortSignal,
): Promise<LearningPlanRevision> {
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  const url = `${baseUrl}/api/learning/plan-revisions/${encodeURIComponent(id)}/decision`;
  (options.log ?? console.error)(`[tool:http] POST ${url}`);
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: {Accept: "application/json", "Content-Type": "application/json"},
    body: JSON.stringify(input),
    signal: requestSignal(options, signal),
  });
  const value = await responseJson(response);
  const expected = input.action === "CONFIRM" ? "CONFIRMED" : "REJECTED";
  if (!value || typeof value !== "object" || (value as {id?: unknown}).id !== id
      || (value as {status?: unknown}).status !== expected)
    throw new Error("Plan revision response did not confirm the user's decision");
  return value as LearningPlanRevision;
}

export function createProposePlanRevisionTool(options: LearningToolHttpOptions = {}) {
  return defineTool({
    name: "propose_plan_revision",
    label: "提出完整学习计划修订",
    description: "Prepare, but never apply, a user-confirmable revision that changes Goal Profile, Curriculum Spine, future Skills and Frontier together. Use this whenever exam scope, desired outcome, depth/approach or high-level milestones materially change. It rejects learned/Evidence-bearing Skills. After preparing, ask_learner_questions(CONFIRM_PLAN_REVISION) must present the exact Kernel summary and wait for the learner.",
    parameters: PlanRevisionInputSchema,
    execute: async (toolCallId, params, signal) => {
      const input = params as Omit<LearningPlanRevisionInput, "id">;
      requireMilestoneMembership(input.curriculum_spine, input.added_skills.map(skill => skill.id));
      const id = "plan-revision-" + createHash("sha256").update(toolCallId).digest("hex").slice(0, 32);
      const revision = await prepareLearningPlanRevision({...input, id}, options, signal);
      return {
        content: [{type: "text" as const, text: JSON.stringify({
          status: "PENDING_USER_CONFIRMATION",
          revision: {
            id: revision.id, base_revision: revision.base_revision, revision: revision.revision,
            summary: revision.summary, reason: revision.reason,
          },
          instruction: "候选修订尚未生效。下一步必须用 ask_learner_questions(CONFIRM_PLAN_REVISION, plan_revision_id) 单独请求用户确认；不得调用 apply_curriculum_plan 或声称已经修改。",
        })}],
        details: {revisionId: revision.id},
      };
    },
  });
}

export function createDecidePlanRevisionTool(
  context: TeachingSessionContext,
  options: LearningToolHttpOptions = {},
) {
  return defineTool({
    name: "decide_plan_revision",
    label: "提交计划修订决定",
    description: "Apply only the exact plan revision to which the learner just responded. The action and revision id come from the real submitted confirmation component, never from model arguments. Confirmation atomically updates all plan layers; rejection leaves the current plan untouched.",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params, signal) => {
      const answer = context.learnerQuestions.snapshot().last_answer;
      const decision = planRevisionDecision(answer);
      if (!decision) throw new Error("当前没有可提交的计划修订确认。");
      if (decision.action === "REVISE")
        throw new Error("用户要求调整候选修订；先读取补充意见并重新提议，不能确认或拒绝旧修订。");
      const revision = await decideLearningPlanRevision(decision.revisionId, {
        action: decision.action,
        feedback: decision.feedback,
        request_id: decision.requestId,
      }, options, signal);
      return {
        content: [{type: "text" as const, text: JSON.stringify({
          status: revision.status,
          revision: {id: revision.id, revision: revision.revision, summary: revision.summary},
          instruction: revision.status === "CONFIRMED"
            ? "完整计划修订已原子生效。下一实际请求会读取新的 Goal、Spine、Skills 与 Frontier；不得再用旧标题解释当前路线。"
            : "用户暂不修订，当前计划保持不变；不要重复提交同一修订。",
        })}],
        details: {revision},
      };
    },
  });
}

export function createRecordGoalUnderstandingTool(context: GoalOnboardingContext, reading?: PlanningReadingCoordinator) {
  return defineTool({
    name: "record_goal_understanding",
    label: "Record Goal Understanding",
    description:
      "Store Goal understanding. Declare material_basis IDs for originals actually intended to ground the formal route, with primary_material_id when the user names a main text. Runtime binds versions and the real current user request and queues complete reading; ordinary screenshots/references are not automatically route bases. Omission retains existing bases; explicitly changing them requires a new Goal confirmation. READY asks the user to confirm; CONFIRMED only after separate real confirmation, without changing bases or profile. Prior knowledge is never Evidence.",
    // OpenAI-compatible providers require every function schema to have an
    // object root. Cross-field rules remain enforced by GoalOnboardingContext.
    parameters: Type.Object({
      outcome: Type.Union([
        Type.Literal("NEEDS_CLARIFICATION"),
        Type.Literal("READY_FOR_CONFIRMATION"),
        Type.Literal("CONFIRMED"),
      ]),
      profile: Type.Optional(GoalProfileSchema),
      missing_information: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      ),
      material_basis: Type.Optional(Type.Array(Type.String({pattern: "^mat-[0-9a-f]{32}$"}), {maxItems: 100, uniqueItems: true})),
      primary_material_id: Type.Optional(Type.String({pattern: "^mat-[0-9a-f]{32}$"})),
    }),
    execute: async (_toolCallId, params, signal) => {
      if (params.outcome !== "CONFIRMED" && !params.profile) {
        throw new Error(`${params.outcome} requires a structured Goal Profile`);
      }
      if (params.profile) params = {...params, profile: normalizeGoalProfile(params.profile)};
      if (params.outcome === "CONFIRMED") {
        const draft = context.snapshot();
        // 兼容模型按object schema回显原profile；比较内容而非“字段是否出现”，不授予改稿或换资料权限。
        if (params.material_basis !== undefined || params.primary_material_id !== undefined ||
            params.profile !== undefined && planningHash(params.profile) !== planningHash(draft.pending_profile))
          throw new Error("确认只接受原草案，不得同时改换资料或目标理解；请省略profile与资料字段，仅提交outcome=CONFIRMED。原草案已保留，无须让用户重复确认。");
        params = {outcome: "CONFIRMED"};
      }
      context.validateRecord(params as GoalUnderstandingInput);
      const before = planningHash(context.snapshot());
      const previous = context.snapshot().reading_requirement;
      const ids = params.material_basis ?? previous?.materials.map(material => material.id)
        ?? (params.primary_material_id ? [params.primary_material_id] : undefined);
      if (params.primary_material_id && !ids?.includes(params.primary_material_id)) throw new Error("主教材须包含在本次资料依据中。");
      let reference = previous;
      if (params.outcome !== "CONFIRMED" && ids && (ids.length || previous || reading && params.material_basis !== undefined)) {
        if (!reading) throw new Error("PLANNING_READING_UNAVAILABLE");
        reference = await reading.prepare(params.profile!, ids, params.primary_material_id ?? (params.material_basis === undefined ? previous?.primary_material_id : undefined), signal);
      }
      signal?.throwIfAborted();
      if (planningHash(context.snapshot()) !== before) throw new Error("PLANNING_CONTEXT_CHANGED");
      const snapshot = context.record(params as GoalUnderstandingInput, reference);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(snapshot) }],
        details: { status: snapshot.status },
      };
    },
  });
}

export function createInitializeLearningGoalTool(
  context: GoalOnboardingContext,
  options: LearningToolHttpOptions & { onboardingSessionId?: string } = {},
) {
  return defineTool({
    name: "initialize_learning_goal",
    label: "Initialize Learning Goal",
    description:
      "After independent user confirmation and complete version-valid reading of all declared main sources, persist one unchanged Goal Profile, 5-8 coarse milestones and only 1-3 near-frontier Skills. Assign every expanded Skill exactly once through its milestone.skill_ids; distant unexpanded stages keep empty skill_ids. Queued/parsed/one-batch sources cannot finalize; a waiting result means end the turn, not a tight poll loop or repeated confirmation. Never creates or activates a LearningTask.",
    parameters: Type.Object({
      goal_profile: GoalProfileSchema,
      curriculum_spine: Type.Array(MilestoneSchema, { minItems: 5, maxItems: 8 }),
      frontier_skills: Type.Array(PlannedSkillSchema, { minItems: 1, maxItems: 3 }),
      frontier: FrontierSchema,
      replace_existing: Type.Boolean(),
    }),
    execute: async (_toolCallId, params, signal) => {
      const input = params as InitializeLearningGoalInput;
      requireMilestoneMembership(input.curriculum_spine, input.frontier_skills.map(skill => skill.id));
      // 初始化是 Human-in-the-loop 边界：用户只确认 Goal Understanding，
      // 不需要逐项审核专业 Curriculum，但没有确认就不能写入。
      context.validateInitialization(input);
      const reference = context.snapshot().reading_requirement;
      const plan = await initializeLearningGoal(input, {...options, onboardingSessionId: reference?.session_id ?? options.onboardingSessionId,
        readingRequirementId: reference?.id}, signal);
      context.markInitialized();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(plan) }],
        details: { goalId: input.goal_profile.id, focusSkillId: input.frontier.focus_skill_id },
      };
    },
  });
}

export function createApplyCurriculumPlanTool(
  options: LearningToolHttpOptions = {},
) {
  return defineTool({
    name: "apply_curriculum_plan",
    label: "Apply Curriculum Plan",
    description:
      "Adjust only the future Learning Frontier while the confirmed Goal Profile and Curriculum Spine remain unchanged. Use propose_plan_revision for any change to exam scope, desired outcome, purpose, depth, high-level milestones or cross-layer Skill identity. Use milestone_assignments to attach each new or existing expanded Skill to its actual existing milestone, without changing the milestone identity, order or meaning. These organization links do not change learning state/Evidence. The Kernel rejects content changes to learned/Evidence-bearing Skills and rejects all lower-level changes while a complete plan revision is pending. This never activates a task.",
    parameters: Type.Object({
      milestone_assignments: Type.Optional(Type.Array(Type.Object({skill_id: Type.String({minLength: 1}), milestone_id: Type.String({minLength: 1})}), {maxItems: 200, description: "Current-Goal Skill to existing milestone binding; reassignment moves the organization link, never the learning record."})),
      frontier: FrontierSchema,
      added_skills: Type.Array(PlannedSkillSchema, { maxItems: 3 }),
      depth_changes: Type.Array(
        Type.Object({ skill_id: Type.String(), target_depth: LearningDepthSchema }),
      ),
      prerequisite_additions: Type.Array(
        Type.Object({ skill_id: Type.String(), prerequisite_id: Type.String() }),
      ),
      remove_skill_ids: Type.Array(Type.String()),
    }),
    execute: async (_toolCallId, params, signal) => {
      for (const skill of params.added_skills) {
        if ((params.milestone_assignments ?? []).filter(item => item.skill_id === skill.id).length !== 1)
          throw new Error(`新增知识点 ${skill.id} 必须通过milestone_assignments明确归入一个既有阶段。`);
      }
      const result = await applyCurriculumPlan(
        params as ApplyCurriculumPlanInput,
        options,
        signal,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: { focusSkillId: params.frontier.focus_skill_id },
      };
    },
  });
}
