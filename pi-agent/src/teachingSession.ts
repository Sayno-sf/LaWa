import { combineAssistance } from "./assistanceJudgment.js";
import type {
  AssistanceLevel,
  EvidenceType,
  SubmitEvidenceInput,
} from "./learningWriteTools.js";
import {
  ActiveRecallContext,
  type ActiveRecallSnapshot,
  type RecallEvidenceDraft,
  type RecallAssistantObservation,
} from "./activeRecall.js";
import { LearnerQuestionsContext } from "./learnerQuestions.js";
import type { LearnerQuestionsSnapshot } from "./learnerQuestionTypes.js";
import type { VoiceInputMetadata } from "./speechTypes.js";

export type TeachingMode = "EXPLAIN" | "QUIZ" | "BUILD" | "DEBUG";
export type TeachingFlow = "LEARNING" | "REVIEW";
export type ReviewReason =
  | "USER_REQUEST"
  | "FINAL_REVIEW"
  | "ESTABLISHED_SKILL";
export type TeachingPhase = "TEACH" | "CHECK" | "REMEDIATE" | "PRACTICE";
export type TeachingOutcome =
  | "START"
  | "CORRECT"
  | "PARTIAL"
  | "INCORRECT"
  | "DIRECT_ANSWER_REQUEST";

export interface CandidateEvidence {
  skill_id: string;
  evidence_type: EvidenceType;
  description: string;
  assistance_level: AssistanceLevel;
  source: "interactive-teaching-session";
  supporting_interaction_summary: string;
  assistant_observations?: RecallAssistantObservation[];
}

export interface CandidateEvidenceInput {
  evidence_type: EvidenceType;
  description: string;
  supporting_interaction_summary: string;
  assistance_level?: AssistanceLevel;
}

export interface TeachingTurnInput {
  active_skill_id: string;
  active_task_id: string;
  teaching_mode: TeachingMode;
  teaching_flow?: TeachingFlow;
  review_reason?: ReviewReason;
  outcome: TeachingOutcome;
  current_question?: string;
  next_question?: string;
  check_scope?: string[];
  check_questions?: string[];
  key_gap?: string;
  hint_level?: 0 | 1 | 2 | 3 | 4;
  candidate_evidence?: CandidateEvidenceInput;
}

export interface TeachingSessionSnapshot {
  route_help?: {task_id: string; request_id: string} | null;
  active_skill_id: string | null;
  active_task_id: string | null;
  teaching_mode: TeachingMode | null;
  teaching_flow: TeachingFlow | null;
  teaching_phase: TeachingPhase | null;
  current_question: string | null;
  check_scope: string[];
  check_questions: string[];
  attempt_count: number;
  hint_level: 0 | 1 | 2 | 3 | 4;
  candidate_evidence: CandidateEvidence | null;
  active_recall?: ActiveRecallSnapshot | null;
  learner_questions?: LearnerQuestionsSnapshot;
  current_voice_input?: VoiceInputMetadata | null;
  current_speech_reference?: boolean;
}

export type TeachingTurnResult = TeachingSessionSnapshot;

export interface TeachingEvidenceDecision {
  block: true;
  reason: string;
}

export class TeachingSessionContext {
  readonly learnerQuestions = new LearnerQuestionsContext();
  readonly activeRecall = new ActiveRecallContext();
  private sessionId = "cli-runtime";
  private checkpointCandidates: CandidateEvidence[] = [];
  private readonly evidenceReservations = new Map<string, CandidateEvidence>();
  private checkpointCandidatesAtTurnStart: CandidateEvidence[] | undefined;
  private candidateAtTurnStart: CandidateEvidence | null | undefined;
  private checkpointCandidateScope: Pick<ActiveRecallSnapshot, "goal_id" | "session_id" | "skill_id" | "task_id"> | null = null;
  private checkpointCandidateScopeAtTurnStart: typeof this.checkpointCandidateScope | undefined;
  private checkpointEvidencePersistedThisTurn = false;
  private state: TeachingSessionSnapshot = {
    active_skill_id: null,
    active_task_id: null,
    teaching_mode: null,
    teaching_flow: null,
    teaching_phase: null,
    current_question: null,
    check_scope: [],
    check_questions: [],
    attempt_count: 0,
    hint_level: 0,
    candidate_evidence: null,
  };
  private directAnswerRequested = false;
  private referenceUsed = false;
  private currentTurnReference = false;
  private skipRecallRequestedThisTurn = false;
  private evidenceHighestHintLevel = -1;
  private evidenceScope: string | null = null;
  private currentVoiceInput: VoiceInputMetadata | null = null;
  private currentSpeechReference = false;

  bindSession(sessionId: string): void {
    if (this.sessionId !== sessionId) this.invalidateCheckpoint();
    this.sessionId = sessionId;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** 路线切换保持同一session；只恢复此路径的问题与教学习惯，不恢复写入授权。 */
  restoreLearningPath(saved: TeachingSessionSnapshot | undefined, withHelp = false): void {
    const empty = new TeachingSessionContext().snapshot();
    const snapshot = structuredClone(saved ?? empty);
    this.invalidateCheckpoint();
    this.evidenceReservations.clear();
    this.state = {...snapshot, candidate_evidence: null};
    const original = snapshot.learner_questions?.pending ?? snapshot.learner_questions?.last_answer?.request;
    if (withHelp && original?.task_id) this.state.route_help = {task_id: original.task_id, request_id: original.id};
    this.learnerQuestions.restore(snapshot.learner_questions ?? new LearnerQuestionsContext().snapshot(), this.sessionId);
    this.activeRecall.restorePath(snapshot.active_recall ?? null);
    this.referenceUsed = withHelp;
    this.currentTurnReference = withHelp;
    this.evidenceScope = `${snapshot.active_task_id}\u0000${snapshot.active_skill_id}`;
    this.evidenceHighestHintLevel = Math.max(snapshot.hint_level, withHelp ? 3 : -1);
    if (withHelp) {
      this.state.hint_level = Math.max(this.state.hint_level, 2) as TeachingSessionSnapshot["hint_level"];
      this.activeRecall.noteChoiceAssistance();
    }
  }

  branchHelpForCurrentAnswer(): boolean {
    const request = this.learnerQuestions.snapshot().last_answer?.request;
    return Boolean(request && this.state.route_help?.request_id === request.id && this.state.route_help.task_id === request.task_id);
  }

  usedReferenceInCurrentTurn(): boolean {
    return this.currentTurnReference || this.currentSpeechReference;
  }

  noteSpeechReference(): void { this.currentSpeechReference = true; }

  checkpointCandidatesSnapshot(): CandidateEvidence[] { return structuredClone(this.checkpointCandidates); }

  recallSkipRequestedInCurrentTurn(): boolean {
    return this.skipRecallRequestedThisTurn;
  }

  pendingCheckpointEvidenceScope(): typeof this.checkpointCandidateScope {
    return this.checkpointCandidateScope ? { ...this.checkpointCandidateScope } : null;
  }

  beginAgentTurn(): void {
    this.learnerQuestions.beginTurn();
    this.activeRecall.beginTurn();
    this.checkpointCandidatesAtTurnStart = [...this.checkpointCandidates];
    this.candidateAtTurnStart = this.state.candidate_evidence;
    this.checkpointCandidateScopeAtTurnStart = this.checkpointCandidateScope;
    this.checkpointEvidencePersistedThisTurn = false;
  }

  endAgentTurn(success: boolean): void {
    this.learnerQuestions.endTurn(success);
    // 若本轮尚未写入 Kernel，则 Stop/模型错误回滚临时题目和候选；若 Evidence 已落盘，不回滚真实历史。
    this.activeRecall.endTurn(success || this.checkpointEvidencePersistedThisTurn);
    if (!success && !this.checkpointEvidencePersistedThisTurn) {
      this.checkpointCandidates = this.checkpointCandidatesAtTurnStart ?? [];
      this.state = { ...this.state, candidate_evidence: this.candidateAtTurnStart ?? null };
      this.checkpointCandidateScope = this.checkpointCandidateScopeAtTurnStart ?? null;
    }
    this.checkpointCandidatesAtTurnStart = undefined;
    this.candidateAtTurnStart = undefined;
    this.checkpointCandidateScopeAtTurnStart = undefined;
    this.checkpointEvidencePersistedThisTurn = false;
    this.evidenceReservations.clear();
  }

  /** 普通聊天结束题卡和关联临时检查；未提交答案不产生表现或 Evidence。 */
  interruptLearnerQuestion(text: string): string {
    const checking = this.learnerQuestions.snapshot().pending?.purpose === "CHECK";
    const message = this.learnerQuestions.chat(text);
    if (checking) {
      this.invalidateCheckpoint();
      this.state = {...this.state, current_question: null};
    }
    return message;
  }

  invalidateCheckpoint(): void {
    if (this.learnerQuestions.snapshot().pending?.purpose === "CHECK") this.learnerQuestions.invalidate();
    this.activeRecall.invalidate();
    this.checkpointCandidates = [];
    this.checkpointCandidateScope = null;
    this.state = { ...this.state, candidate_evidence: null };
  }

  skipCheckpoint(): void {
    if (this.activeRecall.snapshot()) this.invalidateCheckpoint();
  }

  setCheckpointCandidates(scope: Pick<ActiveRecallSnapshot, "goal_id" | "session_id" | "skill_id" | "task_id">, drafts: RecallEvidenceDraft[]): void {
    const voiceSummary = this.voiceInputSummary();
    this.checkpointCandidateScope = drafts.length ? { ...scope } : null;
    this.checkpointCandidates = drafts.map((draft) => {
      const candidate: CandidateEvidence = {
      skill_id: scope.skill_id,
      evidence_type: draft.evidence_type,
      description: `${draft.description}${voiceSummary}`,
      assistance_level: draft.assistance_level,
      source: "interactive-teaching-session",
      supporting_interaction_summary: `${draft.supporting_interaction_summary}${voiceSummary}`,
      ...(draft.assistant_observations ? {assistant_observations: structuredClone(draft.assistant_observations)} : {}),
      };
      // Checkpoint 的每条 Candidate 只继承它实际选用的逐题观察，不能套用 FINISH 最后一题的帮助。
      return candidate;
    });
    this.state = { ...this.state, candidate_evidence: this.checkpointCandidates[0] ?? null };
  }

  beginUserTurn(userText: string, preserveLearnerAnswer = false, voiceInput?: VoiceInputMetadata): void {
    this.currentVoiceInput = voiceInput ? { ...voiceInput } : null;
    this.currentSpeechReference = false;
    if (!preserveLearnerAnswer) this.learnerQuestions.beginUserTurn();
    this.activeRecall.beginUserTurn();
    this.skipRecallRequestedThisTurn = /^(跳过|先继续学|之后再问|稍后再检查|结束本次检查)[。！!\s]*$/.test(userText.trim());
    this.directAnswerRequested =
      /直接.{0,6}(告诉|给)|完整代码|参考版本|不想.{0,6}猜|有点累|累了/i.test(
        userText,
      );
    this.currentTurnReference =
      /照着|跟着|参考了|查阅了|教程|文档|示例代码|模板/i.test(userText);
    if (this.currentTurnReference) {
      this.referenceUsed = true;
    }
  }

  snapshot(): TeachingSessionSnapshot {
    return { ...structuredClone(this.state), active_recall: this.activeRecall.snapshot(), learner_questions: this.learnerQuestions.snapshot(),
      ...(this.currentVoiceInput ? { current_voice_input: { ...this.currentVoiceInput } } : {}),
      ...(this.currentSpeechReference ? { current_speech_reference: true } : {}) };
  }

  private voiceInputSummary(): string {
    const inputs: string[] = [];
    const describe = (item: VoiceInputMetadata) => item.transcriptEdited ? "语音转写，文本经用户编辑" : "语音转写，文本未经用户编辑";
    if (this.currentVoiceInput) inputs.push(describe(this.currentVoiceInput));
    for (const answer of this.learnerQuestions.snapshot().last_answer?.reply?.answers ?? []) {
      if (answer.voice_input) inputs.push(`题目 ${answer.question_id} 的自由补充：${describe(answer.voice_input)}`);
    }
    if (this.currentSpeechReference) inputs.push("紧随当前范读示范的原样复述，使用了参考");
    return inputs.length ? `\n输入来源：${inputs.join("；")}。仅依据最终文字评估表达，不证明原始发音、重音或语调。` : "";
  }

  evidenceWriteGuard(input: SubmitEvidenceInput): TeachingEvidenceDecision | undefined {
    if (this.currentSpeechReference && ["INDEPENDENT", "TRANSFERRED"].includes(input.assistance_level)) return {
      block: true, reason: "这段回答紧随当前范读原样复述，不能标为独立或无提示迁移。",
    };
    const questions = this.learnerQuestions.snapshot();
    if (questions.chat_interruption) return {block: true, reason: "普通聊天或拒答不是题目作答，不能写入Evidence。"};
    if (questions.pending) return { block: true, reason: "题目尚未收到真实回答，不能写入 Evidence。" };
    const answer = questions.last_answer;
    if (answer?.request.review_topic_id) return {block: true, reason: "穿插复测的评分归原知识点，不能用这次回答为当前任务创建Evidence；请另取当前Skill的真实表现。"};
    if (answer?.request.purpose === "BACKGROUND") return { block: true, reason: "基础自述属于规划档案，不能作为学习 Evidence。" };
    // 合法动作仅表达操作意图；即使已有 ACTIVE Task，也不能将点击本身升级为学习表现。
    if (answer?.request.purpose === "CONFIRM_GOAL" || answer?.request.purpose === "START_LEARNING" || answer?.request.purpose === "CONFIRM_MASTERY") return {
      block: true, reason: "确认或开始只表达用户意图，不是学习表现，不能作为 Evidence。",
    };
    if (answer?.choices_exposed && answer.request.skill_id === input.skill_id && ["INDEPENDENT", "TRANSFERRED"].includes(input.assistance_level)) return { block: true, reason: "这段回答已展示选项提示，不能标为独立或无提示迁移。" };
    if (this.activeRecall.snapshot()) return {
      block: true,
      reason: "Checkpoint 尚未结束；不得以任何 source 逐题写入 Evidence。",
    };
    if (this.checkpointCandidateScope && input.source !== "interactive-teaching-session") return {
      block: true,
      reason: "Checkpoint 提炼的 Evidence 必须经过运行时 Candidate 校验。",
    };
    return undefined;
  }

  validateEvidenceSubmission(
    input: SubmitEvidenceInput,
    toolCallId?: string,
  ): TeachingEvidenceDecision | undefined {
    const guard = this.evidenceWriteGuard(input);
    if (guard) return guard;
    // Checkpoint 最多可提炼两条 Candidate，仍逐条经过原 submit_evidence 精确匹配边界。
    const candidates = this.checkpointCandidates.length
      ? this.checkpointCandidates
      : this.state.candidate_evidence ? [this.state.candidate_evidence] : [];
    if (this.checkpointCandidateScope && this.checkpointCandidateScope.session_id !== this.sessionId) {
      this.invalidateCheckpoint();
      return { block: true, reason: "Checkpoint Evidence 所属会话已改变。" };
    }
    if (!candidates.length) {
      return {
        block: true,
        reason: "当前教学片段没有可提交的 Candidate Evidence。",
      };
    }
    const candidate = candidates.find((item) =>
      ![...this.evidenceReservations.entries()].some(([id, reserved]) => id !== toolCallId && reserved === item) &&
      input.skill_id === item.skill_id &&
      input.evidence_type === item.evidence_type &&
      input.description === item.description &&
      input.assistance_level === item.assistance_level &&
      input.source === item.source,
    );
    if (!candidate) return {
      block: true,
      reason: "教学 Evidence 必须与 TeachingSessionContext 中的 Candidate Evidence 完全一致。",
    };
    if (toolCallId) this.evidenceReservations.set(toolCallId, candidate);
    return undefined;
  }

  clearCandidateEvidence(toolCallId?: string, succeeded = true): void {
    const reserved = toolCallId ? this.evidenceReservations.get(toolCallId) : undefined;
    if (toolCallId) this.evidenceReservations.delete(toolCallId);
    if (!succeeded) return;
    if (reserved && this.checkpointCandidates.includes(reserved)) this.checkpointEvidencePersistedThisTurn = true;
    if (reserved && this.checkpointCandidates.length) {
      this.checkpointCandidates = this.checkpointCandidates.filter((item) => item !== reserved);
      if (!this.checkpointCandidates.length) this.checkpointCandidateScope = null;
      this.state = { ...this.state, candidate_evidence: this.checkpointCandidates[0] ?? null };
    } else {
      this.state = { ...this.state, candidate_evidence: null };
    }
    this.evidenceHighestHintLevel = -1;
    this.referenceUsed = false;
  }

  recordTurn(input: TeachingTurnInput): TeachingTurnResult {
    if (this.activeRecall.snapshot() && input.candidate_evidence) {
      throw new Error("Checkpoint 进行中不能逐题创建 Candidate Evidence；结束后统一提炼。");
    }
    if (!input.active_task_id?.trim()) {
      throw new Error(
        "Teaching requires an ACTIVE LearningTask id; runtime context cannot start or continue unbound teaching.",
      );
    }
    const teachingFlow =
      input.teaching_flow ??
      (input.outcome === "START"
        ? "LEARNING"
        : this.state.teaching_flow ?? "LEARNING");
    const question = input.next_question ?? input.current_question ?? null;
    const evidenceScope = `${input.active_task_id}\u0000${input.active_skill_id}`;
    const recall = this.activeRecall.snapshot();
    if (recall && (recall.task_id !== input.active_task_id || recall.skill_id !== input.active_skill_id)) this.invalidateCheckpoint();
    if (this.checkpointCandidateScope && (this.checkpointCandidateScope.task_id !== input.active_task_id || this.checkpointCandidateScope.skill_id !== input.active_skill_id)) this.invalidateCheckpoint();
    const isNewTeachingScope = this.evidenceScope !== evidenceScope;
    if (isNewTeachingScope) {
      this.evidenceScope = evidenceScope;
      this.evidenceHighestHintLevel = -1;
      this.referenceUsed = this.currentTurnReference;
      this.state = { ...this.state, candidate_evidence: null };
    }
    if (input.outcome === "START") {
      this.state = {
        ...this.state,
        active_skill_id: input.active_skill_id,
        active_task_id: input.active_task_id,
        teaching_mode: input.teaching_mode,
        teaching_flow: teachingFlow,
        // teaching_phase / teaching_flow 只是对当前教学意图的描述，供下一轮模型参考。
        // 它们不限制 Teacher 必须先问、问几题或按固定顺序切换模式。
        teaching_phase:
          input.teaching_mode === "EXPLAIN" ? "CHECK" : "PRACTICE",
        current_question: question,
        check_scope:
          teachingFlow === "REVIEW" && input.check_scope
            ? [...input.check_scope]
            : [],
        check_questions:
          teachingFlow === "REVIEW" && input.check_questions
          ? [...input.check_questions]
          : [],
        attempt_count: 0,
        hint_level: 0,
      };
      return this.snapshot();
    }

    const sameQuestion =
      input.current_question !== undefined &&
      input.current_question === this.state.current_question;
    const previousAttempts = sameQuestion ? this.state.attempt_count : 0;
    const attemptCount = previousAttempts + 1;
    const failed = input.outcome === "PARTIAL" || input.outcome === "INCORRECT";
    const forcedAnswer =
      input.outcome === "DIRECT_ANSWER_REQUEST" || this.directAnswerRequested;
    // hint_level 记录 Teacher 本轮实际选择的帮助强度，而不是由答错次数机械计算。
    // attempt_count 仅提供上下文；Teacher 可以第一次就充分解释，也可以在后续只做轻提示。
    const hintLevel =
      input.hint_level ?? (forcedAnswer ? 4 : this.state.hint_level);
    if (failed || forcedAnswer) {
      this.evidenceHighestHintLevel = Math.max(
        this.evidenceHighestHintLevel,
        hintLevel,
      );
    }

    let candidateEvidence = this.state.candidate_evidence;
    if (input.candidate_evidence && input.outcome === "CORRECT") {
      // 选项本身已提供帮助；即使用户自由作答，也不能降成独立表现。已有参考和更高帮助仍优先。
      const choiceAnswer = this.learnerQuestions.snapshot().last_answer;
      if (choiceAnswer?.choices_exposed && choiceAnswer.request.skill_id === input.active_skill_id && choiceAnswer.request.task_id === input.active_task_id) this.evidenceHighestHintLevel = Math.max(this.evidenceHighestHintLevel, 1);
      const assistanceLevel: AssistanceLevel =
        this.evidenceHighestHintLevel >= 3
          ? "WITH_HELP"
          : this.referenceUsed || this.currentSpeechReference
            ? "WITH_REFERENCE"
            : this.evidenceHighestHintLevel >= 1
              ? "WITH_HINT"
              : input.candidate_evidence.evidence_type === "TRANSFER"
                ? "TRANSFERRED"
                : "INDEPENDENT";
      candidateEvidence = {
        skill_id: input.active_skill_id,
        ...input.candidate_evidence,
        assistance_level: combineAssistance(assistanceLevel, input.candidate_evidence.assistance_level),
        source: "interactive-teaching-session",
      };
      if (choiceAnswer?.request.purpose === "CHECK" && choiceAnswer.request.skill_id === input.active_skill_id && choiceAnswer.request.task_id === input.active_task_id) {
        candidateEvidence.supporting_interaction_summary = `${input.candidate_evidence.supporting_interaction_summary}\n实际题目与回答：${choiceAnswer.text}`;
        candidateEvidence.description = `${candidateEvidence.description}\n实际回答：${choiceAnswer.text}`;
      }
      const voiceSummary = this.voiceInputSummary();
      candidateEvidence.description += voiceSummary;
      candidateEvidence.supporting_interaction_summary += voiceSummary;
    }

    this.state = {
      ...this.state,
      active_skill_id: input.active_skill_id,
      active_task_id: input.active_task_id,
      teaching_mode: input.teaching_mode,
      teaching_flow: teachingFlow,
      // phase 记录刚发生了什么，不是下一步回复模板；Teacher 可按真实回答自由补讲、追问或切换实践。
      teaching_phase:
        failed || forcedAnswer
          ? "REMEDIATE"
          : input.teaching_mode === "BUILD" || input.teaching_mode === "DEBUG"
            ? "PRACTICE"
            : "CHECK",
      current_question: question,
      attempt_count: input.next_question ? 0 : attemptCount,
      hint_level: input.next_question ? 0 : hintLevel,
      candidate_evidence: candidateEvidence,
    };
    return this.snapshot();
  }
}
