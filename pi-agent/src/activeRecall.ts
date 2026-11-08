import { combineAssistance } from "./assistanceJudgment.js";
import type { AssistanceLevel, EvidenceType } from "./learningWriteTools.js";

export type RecallOutcome = "CORRECT" | "PARTIAL" | "INCORRECT";
export type RecallNext = "PRIMARY" | "FOLLOW_UP" | "RETEACH" | "PAUSE" | "FINISH";

/** 兼容旧观察的过程元数据；自动归因不再决定本题等级或写入权限。 */
export interface RecallAssistantAssistance {
  floor: AssistanceLevel | null;
  summary: string;
  revision: string;
  unknown: boolean;
  full_answer_exposed: boolean;
}
export interface RecallAssistantObservation extends RecallAssistantAssistance {
  observation_index: number;
  question: string;
}

export interface RecallObservation {
  primary_index: number;
  question: string;
  outcome: RecallOutcome;
  observation: string;
  assistance_level: AssistanceLevel | null;
  full_answer_exposed: boolean;
  assistant_assistance?: RecallAssistantAssistance;
}

export interface RecallEvidenceClaim {
  evidence_type: EvidenceType;
  description: string;
  supporting_interaction_summary: string;
  observation_indices: number[];
}

export interface ActiveRecallSnapshot {
  goal_id: string;
  session_id: string;
  skill_id: string;
  task_id: string;
  status: "ACTIVE" | "PAUSED";
  primary_questions: string[];
  primary_index: number;
  current_question: string;
  question_issued_at_turn: number;
  asked_count: number;
  hint_level: 0 | 1 | 2 | 3;
  full_answer_exposed: boolean;
  observations: RecallObservation[];
}

export interface RecallEvidenceDraft {
  evidence_type: EvidenceType;
  description: string;
  supporting_interaction_summary: string;
  assistance_level: AssistanceLevel;
  assistant_observations?: RecallAssistantObservation[];
}

export interface RecallAnswerInput {
  goal_id: string;
  session_id: string;
  skill_id: string;
  task_id: string;
  outcome: RecallOutcome;
  observation: string;
  next: RecallNext;
  next_question?: string;
  next_hint_level?: 0 | 1 | 2 | 3;
  full_answer_exposed?: boolean;
  used_reference?: boolean;
  assistance_level?: AssistanceLevel;
  evidence_claims?: RecallEvidenceClaim[];
  assistant_assistance?: RecallAssistantAssistance;
}

const MAX_ACTUAL_QUESTIONS = 6;

export class ActiveRecallContext {
  private current: ActiveRecallSnapshot | null = null;
  private turnStart: ActiveRecallSnapshot | null | undefined;
  private userTurnIndex = 0;

  beginUserTurn(): void {
    this.userTurnIndex += 1;
  }

  noteChoiceAssistance(): void {
    // 当前题的选项曝光属于真实提示，后续 Checkpoint 证据继续保留此帮助。
    if (this.current) this.current.hint_level = Math.max(this.current.hint_level, 1) as 1 | 2 | 3;
  }

  snapshot(): ActiveRecallSnapshot | null {
    return this.current ? structuredClone(this.current) : null;
  }

  restorePath(value: ActiveRecallSnapshot | null): void {
    this.current = value ? structuredClone(value) : null;
    this.turnStart = undefined;
  }

  // Tool 调用可以发生在流式回复中途；只有完整 turn 成功才确认进度。
  beginTurn(): void {
    this.turnStart = this.snapshot();
  }

  endTurn(success: boolean): void {
    if (!success && this.turnStart !== undefined) this.current = this.turnStart;
    this.turnStart = undefined;
  }

  invalidate(): void {
    this.current = null;
    this.turnStart = undefined;
  }

  start(input: {
    goal_id: string;
    session_id: string;
    skill_id: string;
    task_id: string;
    primary_questions: string[];
  }): ActiveRecallSnapshot {
    if (this.current) throw new Error("当前 Checkpoint 尚未结束；先完成或稍后再检查。");
    const questions = input.primary_questions.map((value) => value.trim());
    if (questions.length < 3 || questions.length > 5 || questions.some((value) => !value)) {
      throw new Error("章节 Checkpoint 必须规划 3～5 个非空主要问题。");
    }
    this.current = {
      goal_id: input.goal_id,
      session_id: input.session_id,
      skill_id: input.skill_id,
      task_id: input.task_id,
      status: "ACTIVE",
      primary_questions: questions,
      primary_index: 0,
      current_question: questions[0]!,
      question_issued_at_turn: this.userTurnIndex,
      asked_count: 1,
      hint_level: 0,
      full_answer_exposed: false,
      observations: [],
    };
    return this.snapshot()!;
  }

  skip(scope?: Pick<ActiveRecallSnapshot, "goal_id" | "session_id" | "skill_id" | "task_id">): void {
    if (scope) this.requireScope(scope);
    this.invalidate();
  }

  pause(scope: Pick<ActiveRecallSnapshot, "goal_id" | "session_id" | "skill_id" | "task_id">, exposure?: { hint_level?: 0 | 1 | 2 | 3; full_answer_exposed?: boolean }): ActiveRecallSnapshot {
    const current = this.requireScope(scope);
    current.status = "PAUSED";
    current.hint_level = Math.max(current.hint_level, exposure?.hint_level ?? 0) as 0 | 1 | 2 | 3;
    current.full_answer_exposed ||= Boolean(exposure?.full_answer_exposed) || current.hint_level === 3;
    return this.snapshot()!;
  }

  resume(scope: Pick<ActiveRecallSnapshot, "goal_id" | "session_id" | "skill_id" | "task_id">): ActiveRecallSnapshot {
    const current = this.requireScope(scope);
    if (current.status !== "PAUSED") throw new Error("Checkpoint 未暂停。");
    current.status = "ACTIVE";
    return this.snapshot()!;
  }

  answer(input: RecallAnswerInput): { checkpoint: ActiveRecallSnapshot | null; evidence: RecallEvidenceDraft[] } {
    const current = structuredClone(this.requireScope(input));
    if (current.status !== "ACTIVE") throw new Error("Checkpoint 已暂停，不能把这条消息记为回答。");
    // 同一 Agent turn 可以多次调用工具，但不能在刚发出问题后伪造下一条用户回答。
    if (this.userTurnIndex <= current.question_issued_at_turn) throw new Error("当前题目尚未收到用户的新回答。");
    if (!input.observation.trim()) throw new Error("需要先记录实际回答的观察，不能只推进题号。");
    let assistance: AssistanceLevel | null = input.outcome !== "CORRECT"
      ? null
      : current.hint_level >= 3
        ? "WITH_HELP"
        : input.used_reference
          ? "WITH_REFERENCE"
          : current.hint_level >= 1
            ? "WITH_HINT"
            : "INDEPENDENT";
    const assistant = input.assistant_assistance ? structuredClone(input.assistant_assistance) : undefined;
    if (assistance) assistance = combineAssistance(assistance, input.assistance_level);
    current.observations.push({
      primary_index: current.primary_index,
      question: current.current_question,
      outcome: input.outcome,
      observation: input.observation.trim(),
      assistance_level: assistance,
      full_answer_exposed: current.full_answer_exposed,
      ...(assistant ? {assistant_assistance: assistant} : {}),
    });

    if (input.next === "FINISH") {
      const evidence = this.evidenceFromClaims(current, input.evidence_claims ?? []);
      this.current = null;
      return { checkpoint: null, evidence };
    }
    if (input.evidence_claims?.length) throw new Error("只有结束 Checkpoint 时才能提出 Evidence Candidate。");
    if (input.next === "PAUSE") {
      current.status = "PAUSED";
      current.hint_level = Math.max(current.hint_level, input.next_hint_level ?? 0) as 0 | 1 | 2 | 3;
      current.full_answer_exposed ||= Boolean(input.full_answer_exposed) || current.hint_level === 3;
      this.current = current;
      return { checkpoint: this.snapshot(), evidence: [] };
    }
    if (current.asked_count >= MAX_ACTUAL_QUESTIONS) {
      throw new Error("本轮已提出 6 个问题；应结束 Checkpoint 或回到教学，不要无限追问。");
    }
    if (input.next === "PRIMARY") {
      if (current.primary_index + 1 >= current.primary_questions.length) {
        throw new Error("主要问题已问完，请结束 Checkpoint。");
      }
      current.primary_index += 1;
      current.current_question = input.next_question?.trim() || current.primary_questions[current.primary_index]!;
      current.hint_level = 0;
      current.full_answer_exposed = false;
    } else {
      if (!input.next_question?.trim()) throw new Error("追问或重新教学后验证必须给出下一道具体问题。");
      current.current_question = input.next_question.trim();
      current.hint_level = Math.max(current.hint_level, input.next_hint_level ?? 0) as 0 | 1 | 2 | 3;
      current.full_answer_exposed ||= Boolean(input.full_answer_exposed) || current.hint_level === 3;
    }
    current.asked_count += 1;
    current.question_issued_at_turn = this.userTurnIndex;
    this.current = current;
    return { checkpoint: this.snapshot(), evidence: [] };
  }

  private requireScope(scope: Pick<ActiveRecallSnapshot, "goal_id" | "session_id" | "skill_id" | "task_id">): ActiveRecallSnapshot {
    const current = this.current;
    if (!current || current.goal_id !== scope.goal_id || current.session_id !== scope.session_id || current.skill_id !== scope.skill_id || current.task_id !== scope.task_id) {
      // 教学现场变更后宁可丢掉临时题目，也不能把旧 Goal 的回答归到新 Skill。
      this.invalidate();
      throw new Error("Checkpoint 已失效：目标、对话、Skill 或任务发生变化。");
    }
    return current;
  }

  private evidenceFromClaims(current: ActiveRecallSnapshot, claims: RecallEvidenceClaim[]): RecallEvidenceDraft[] {
    if (claims.length > 2) throw new Error("一次 Checkpoint 最多提出 2 条值得长期记录的 Evidence。");
    return claims.map((claim) => {
      const indices = [...new Set(claim.observation_indices)];
      if (!claim.description.trim() || !claim.supporting_interaction_summary.trim() || !indices.length) {
        throw new Error("Evidence 必须描述真实能力，并指向支持它的回答观察。");
      }
      const support = indices.map((index) => current.observations[index]);
      // 完整答案曝光后的即时复述不是独立回忆；错误观察更不能升级为历史 Evidence。
      if (support.some((item) => !item || item.outcome !== "CORRECT" || item.full_answer_exposed)) {
        throw new Error("错误、未完成或刚看过完整答案的回答不能支持本轮 Evidence。");
      }
      const levels = support.map((item) => item!.assistance_level);
      const assistance_level: AssistanceLevel = levels.includes("WITH_HELP")
        ? "WITH_HELP"
        : levels.includes("WITH_REFERENCE")
          ? "WITH_REFERENCE"
          : levels.includes("WITH_HINT")
            ? "WITH_HINT"
            : claim.evidence_type === "TRANSFER"
              ? "TRANSFERRED"
              : "INDEPENDENT";
      const assistant_observations = indices.flatMap(index => {
        const item = current.observations[index]!;
        return item.assistant_assistance ? [{...structuredClone(item.assistant_assistance), observation_index: index, question: item.question}] : [];
      });
      const assistantSummary = assistant_observations.map(item =>
        `第 ${item.observation_index + 1} 条回答（${item.question}）历史自动归因参考（非本题结论）：${item.summary}；帮助版本：${item.revision}`).join("\n");
      return {
        evidence_type: claim.evidence_type,
        description: claim.description.trim(),
        supporting_interaction_summary: claim.supporting_interaction_summary.trim() + (assistantSummary ? `\n逐题帮助归因：${assistantSummary}` : ""),
        assistance_level,
        ...(assistant_observations.length ? {assistant_observations} : {}),
      };
    });
  }
}
