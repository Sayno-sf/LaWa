import { AssistanceLevelSchema } from "./assistanceJudgment.js";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { fetchLearningOverview, type LearningOverviewToolOptions } from "./learningOverviewTool.js";
import { TeachingSessionContext } from "./teachingSession.js";
import type { RecallAnswerInput, RecallEvidenceClaim } from "./activeRecall.js";

const EvidenceTypeSchema = Type.Union([
  Type.Literal("EXPLAIN"), Type.Literal("BUILD"), Type.Literal("DEBUG"), Type.Literal("TRANSFER"),
]);

export function createActiveRecallTool(context: TeachingSessionContext, options: LearningOverviewToolOptions = {}) {
  return defineTool({
    name: "active_recall_checkpoint",
    label: "Active Recall Checkpoint",
    description: "Manage one process-local, sequential chapter recall in the current ACTIVE Task. START plans 3–5 primary questions but shows only current_question. ANSWER records the learner's actual response and returns one adaptive next question or finishes. PAUSE/RESUME/SKIP never create Evidence. On FINISH, 0–2 justified Evidence Candidates may be proposed from correct observations; only the existing submit_evidence tool persists them. On ANSWER, choose assistance_level for this actual answer after judging relevant help; previous TA consultations and automatic classifications do not impose a minimum. Do not call once per ordinary teaching turn.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("START"), Type.Literal("ANSWER"), Type.Literal("PAUSE"), Type.Literal("RESUME"), Type.Literal("SKIP")]),
      active_skill_id: Type.String({ minLength: 1 }),
      active_task_id: Type.String({ minLength: 1 }),
      primary_questions: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 3, maxItems: 5 })),
      outcome: Type.Optional(Type.Union([Type.Literal("CORRECT"), Type.Literal("PARTIAL"), Type.Literal("INCORRECT")])),
      observation: Type.Optional(Type.String({ minLength: 1 })),
      next: Type.Optional(Type.Union([Type.Literal("PRIMARY"), Type.Literal("FOLLOW_UP"), Type.Literal("RETEACH"), Type.Literal("PAUSE"), Type.Literal("FINISH")])),
      next_question: Type.Optional(Type.String({ minLength: 1 })),
      next_hint_level: Type.Optional(Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)], { description: "实际给下一道追问/暂停中的当前题提供的帮助强度；0 无提示，3 完整解释。" })),
      full_answer_exposed: Type.Optional(Type.Boolean({ description: "若已经向学习者展示当前或下一验证题的完整答案，必须为 true；随后立即复述不能成为独立 Evidence。" })),
      assistance_level: Type.Optional(AssistanceLevelSchema),
      used_reference: Type.Optional(Type.Boolean({ description: "学习者刚才的回答是否依赖外部资料或参考；不可隐瞒。" })),
      evidence_claims: Type.Optional(Type.Array(Type.Object({
        evidence_type: EvidenceTypeSchema,
        description: Type.String({ minLength: 1 }),
        supporting_interaction_summary: Type.String({ minLength: 1 }),
        observation_indices: Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1, description: "支持该 claim 的本轮回答观察索引，从 0 开始。" }),
      }), { maxItems: 2 })),
    }),
    execute: async (_toolCallId, params, signal) => {
      // 每次操作只校验 Kernel 的 Goal/Task/Skill 归属，不把 Checkpoint 当成新的学习真相。
      const overview = await fetchLearningOverview(options, signal);
      const goal = overview.goal_profile as { id?: unknown } | null;
      const goalId = typeof goal?.id === "string" ? goal.id : null;
      const task = overview.active_task as { id?: unknown; related_skill_ids?: unknown } | null;
      if (!goalId || task?.id !== params.active_task_id || !Array.isArray(task.related_skill_ids) || !task.related_skill_ids.includes(params.active_skill_id)) {
        context.invalidateCheckpoint();
        throw new Error("Checkpoint 只可绑定当前前台 Goal 的 ACTIVE Task 和关联 Skill。");
      }
      const scope = {
        goal_id: goalId,
        session_id: context.getSessionId(),
        skill_id: params.active_skill_id,
        task_id: params.active_task_id,
      };
      let checkpoint = context.activeRecall.snapshot();
      let candidates: ReturnType<typeof context.snapshot>["candidate_evidence"][] = [];
      if (params.action === "START") {
        if (context.recallSkipRequestedInCurrentTurn()) throw new Error("用户本轮选择跳过检查，不得立即重新开始。");
        if (context.snapshot().candidate_evidence) throw new Error("先提交或放弃现有 Candidate Evidence，再开始 Checkpoint。");
        if (!params.primary_questions) throw new Error("START 需要规划 3～5 个主要问题。");
        checkpoint = context.activeRecall.start({ ...scope, primary_questions: params.primary_questions });
      } else if (params.action === "ANSWER") {
        if (!params.outcome || !params.observation || !params.next) throw new Error("ANSWER 需要真实回答观察、判断和下一步。");
        const result = context.activeRecall.answer({
          ...scope,
          outcome: params.outcome,
          observation: params.observation,
          next: params.next,
          next_question: params.next_question,
          next_hint_level: params.next_hint_level,
          full_answer_exposed: params.full_answer_exposed,
          used_reference: params.used_reference || context.usedReferenceInCurrentTurn(),
          assistance_level: params.assistance_level,
          evidence_claims: params.evidence_claims as RecallEvidenceClaim[] | undefined,
        } satisfies RecallAnswerInput);
        checkpoint = result.checkpoint;
        if (params.next === "FINISH") {
          const choiceAnswer = context.learnerQuestions.snapshot().last_answer;
          if (choiceAnswer?.request.purpose === "CHECK" && choiceAnswer.request.skill_id === params.active_skill_id && choiceAnswer.request.task_id === params.active_task_id) {
            for (const draft of result.evidence) {
              draft.description += `\n实际回答：${choiceAnswer.text}`;
              draft.supporting_interaction_summary += `\n实际题目与回答：${choiceAnswer.text}`;
              if (choiceAnswer.choices_exposed && ["INDEPENDENT", "TRANSFERRED"].includes(draft.assistance_level)) draft.assistance_level = "WITH_HINT";
            }
          }
          context.setCheckpointCandidates(scope, result.evidence);
          candidates = context.checkpointCandidatesSnapshot();
        }
      } else if (params.action === "PAUSE") {
        checkpoint = context.activeRecall.pause(scope, { hint_level: params.next_hint_level, full_answer_exposed: params.full_answer_exposed });
      } else if (params.action === "RESUME") {
        checkpoint = context.activeRecall.resume(scope);
      } else {
        context.activeRecall.skip(scope);
        checkpoint = null;
      }
      const output = {
        status: checkpoint?.status ?? (params.action === "SKIP" ? "SKIPPED" : "FINISHED"),
        current_question: checkpoint?.current_question ?? null,
        primary_progress: checkpoint ? `${checkpoint.primary_index + 1} / ${checkpoint.primary_questions.length}` : null,
        asked_count: checkpoint?.asked_count ?? null,
        observation_count: checkpoint?.observations.length ?? null,
        evidence_candidates: candidates,
        evidence_persistence: "NOT_PERSISTED",
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        details: { status: output.status, progress: output.primary_progress, candidateCount: candidates.length },
      };
    },
  });
}
