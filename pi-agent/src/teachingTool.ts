import { AssistanceLevelSchema } from "./assistanceJudgment.js";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  fetchLearningOverview,
  type LearningOverviewToolOptions,
} from "./learningOverviewTool.js";
import type { EvidenceType } from "./learningWriteTools.js";
import { TeachingSessionContext } from "./teachingSession.js";

const TeachingModeSchema = Type.Union([
  Type.Literal("EXPLAIN"),
  Type.Literal("QUIZ"),
  Type.Literal("BUILD"),
  Type.Literal("DEBUG"),
]);

const TeachingFlowSchema = Type.Union([
  Type.Literal("LEARNING"),
  Type.Literal("REVIEW"),
]);

const ReviewReasonSchema = Type.Union([
  Type.Literal("USER_REQUEST"),
  Type.Literal("FINAL_REVIEW"),
  Type.Literal("ESTABLISHED_SKILL"),
]);

const OutcomeSchema = Type.Union([
  Type.Literal("START"),
  Type.Literal("CORRECT"),
  Type.Literal("PARTIAL"),
  Type.Literal("INCORRECT"),
  Type.Literal("DIRECT_ANSWER_REQUEST"),
]);

const EvidenceTypeSchema = Type.Union([
  Type.Literal("EXPLAIN"),
  Type.Literal("BUILD"),
  Type.Literal("DEBUG"),
  Type.Literal("TRANSFER"),
]);

export function createRecordTeachingTurnTool(
  context: TeachingSessionContext,
  options: LearningOverviewToolOptions = {},
) {
  return defineTool({
    name: "record_teaching_turn",
    label: "Record Teaching Turn",
    description:
      "Record factual process context for an ACTIVE teaching segment. The Teacher judges relevant help for this actual answer and sets candidate_evidence.assistance_level; prior TA consultations and automatic classifications are advisory. Runtime retains known choice/hint/reference exposure for this answer. This tool does not prescribe a response and never changes SkillState or Mastery.",
    parameters: Type.Object({
      active_skill_id: Type.String({ minLength: 1 }),
      active_task_id: Type.String({ minLength: 1 }),
      teaching_mode: TeachingModeSchema,
      teaching_flow: Type.Optional(TeachingFlowSchema),
      review_reason: Type.Optional(ReviewReasonSchema),
      outcome: OutcomeSchema,
      current_question: Type.Optional(Type.String({ minLength: 1 })),
      next_question: Type.Optional(Type.String({ minLength: 1 })),
      check_scope: Type.Optional(
        Type.Array(Type.String({ minLength: 1 })),
      ),
      check_questions: Type.Optional(
        Type.Array(Type.String({ minLength: 1 })),
      ),
      key_gap: Type.Optional(Type.String({ minLength: 1 })),
      hint_level: Type.Optional(
        Type.Union([
          Type.Literal(0),
          Type.Literal(1),
          Type.Literal(2),
          Type.Literal(3),
          Type.Literal(4),
        ]),
      ),
      candidate_evidence: Type.Optional(
        Type.Object({
          evidence_type: EvidenceTypeSchema,
          assistance_level: Type.Optional(AssistanceLevelSchema),
          description: Type.String({ minLength: 1 }),
          supporting_interaction_summary: Type.String({ minLength: 1 }),
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      // 这里仅核对教学记录确实绑定 Kernel 的权威 ACTIVE Task/Skill。
      // 讲多少、问几题、如何切换模式属于 Teacher 的软策略，不在 Tool Runtime 中硬编码。
      const overview = await fetchLearningOverview(options);
      const activeTask = overview.active_task as {
        id?: unknown;
        related_skill_ids?: unknown;
      } | null;
      if (!activeTask || typeof activeTask.id !== "string") {
        throw new Error(
          "Teaching requires an authoritative ACTIVE LearningTask; propose a next action and wait for the user to start it.",
        );
      }
      if (activeTask.id !== params.active_task_id) {
        throw new Error(
          `Teaching task ${params.active_task_id} does not match the authoritative ACTIVE LearningTask ${activeTask.id}.`,
        );
      }
      if (
        !Array.isArray(activeTask.related_skill_ids) ||
        !activeTask.related_skill_ids.includes(params.active_skill_id)
      ) {
        throw new Error(
          `Teaching skill ${params.active_skill_id} is not related to the authoritative ACTIVE LearningTask ${activeTask.id}.`,
        );
      }
      const result = context.recordTurn({
        ...params,
        candidate_evidence: params.candidate_evidence
          ? {
              ...params.candidate_evidence,
              evidence_type: params.candidate_evidence.evidence_type as EvidenceType,
            }
          : undefined,
      });
      const output = {
        ...result,
        candidate_persistence_status: "NOT_PERSISTED" as const,
        evidence_wording_rule:
          "A Candidate becomes persisted Evidence only after submit_evidence succeeds. Summarize it at a natural checkpoint rather than interrupting every teaching turn.",
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        details: {
          skillId: result.active_skill_id,
          mode: result.teaching_mode,
          attemptCount: result.attempt_count,
          hintLevel: result.hint_level,
          hasCandidateEvidence: result.candidate_evidence !== null,
        },
      };
    },
  });
}
