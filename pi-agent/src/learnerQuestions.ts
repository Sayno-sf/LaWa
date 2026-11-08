import { createHash } from "node:crypto";
import type { LearnerAnswerRecord, LearnerQuestionRequest, LearnerQuestionReply, LearnerQuestionsSnapshot } from "./learnerQuestionTypes.js";
import type { GoalProfileInput } from "./planning/planningTypes.js";
import type { LearningOverview } from "./learningOverviewTool.js";
import { parseVoiceInputMetadata } from "./speechTypes.js";
import {masteryReviewDecision, MASTERY_REVIEW_OPTIONS} from "./masteryReview.js";

export const LEARNER_QUESTIONS_ENTRY = "lawa.learner-questions";

export function isDecisionRequest(request: LearnerQuestionRequest): boolean {
  return request.purpose === "CONFIRM_GOAL" || request.purpose === "START_LEARNING"
    || request.purpose === "CONFIRM_PLAN_REVISION" || request.purpose === "CONFIRM_MASTERY";
}

// 绑定实际草案/教学现场，不能只凭同名 Goal、历史按钮或模型填入的 ID 恢复同意。
export function goalConfirmationSignature(profile: GoalProfileInput, readingRequirementId?: string): string {
  return createHash("sha256").update(JSON.stringify(readingRequirementId ? {profile, readingRequirementId} : profile)).digest("hex");
}
export function learningStartSignature(overview: LearningOverview): string {
  // 新增的空元数据与旧版省略等价；保持字段原顺序，保留旧按钮及持久阅读等待的身份。
  const copy = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? {...value} as Record<string, unknown> : value;
  const goal = copy(overview.goal_profile) as Record<string, unknown> | null;
  const frontier = copy(overview.current_frontier) as Record<string, unknown> | null;
  const task = copy(overview.active_task) as Record<string, unknown> | null;
  if (goal && !goal.learning_domain) delete goal.learning_domain;
  if (frontier && !frontier.teaching_preferences_revision) delete frontier.teaching_preferences_revision;
  if (task && !task.teaching_activity && !task.activity_revision) {
    delete task.teaching_activity;
    delete task.activity_revision;
  }
  return createHash("sha256").update(JSON.stringify({goal, frontier, task})).digest("hex");
}
export function planRevisionConfirmationSignature(revision: {
  id: string; goal_id: string; base_revision: number; base_signature: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    id: revision.id,
    goal_id: revision.goal_id,
    base_revision: revision.base_revision,
    base_signature: revision.base_signature,
  })).digest("hex");
}
export function learningStartApproved(answer: LearnerAnswerRecord): boolean {
  if (answer.request.purpose !== "START_LEARNING") return false;
  // 有补充说明时交还 Teacher 处理并重新询问，不能把「开始，但是先别开始」升级为同意。
  const reply = answer.reply?.answers[0];
  if (answer.reply && (reply?.selected_option_ids.length === 1
    ? reply.selected_option_ids[0] !== "proceed" || Boolean(reply.other_text)
    : reply?.selected_option_ids.length !== 0)) return false;
  return /^(?:开始|开始学习|开始吧|可以开始|现在开始|继续|继续学习|可以|确认|是的?|yes)[。.!！]?$/i.test(answer.text.trim());
}

export type PlanRevisionDecision = {
  revisionId: string;
  requestId: string;
  action: "CONFIRM" | "REJECT" | "REVISE";
  feedback: string;
};

export function planRevisionDecision(
  answer: LearnerAnswerRecord | null | undefined,
): PlanRevisionDecision | undefined {
  const request = answer?.request;
  if (!answer || !request || request.purpose !== "CONFIRM_PLAN_REVISION" || !request.plan_revision_id)
    return undefined;
  const reply = answer.reply?.answers[0];
  const selected = reply?.selected_option_ids ?? [];
  const feedback = reply?.other_text ?? answer.text;
  if (selected.length === 1 && selected[0] === "proceed" && !feedback.trim()) {
    return {revisionId: request.plan_revision_id, requestId: request.id, action: "CONFIRM", feedback: ""};
  }
  if (selected.length === 1 && selected[0] === "reject") {
    return {revisionId: request.plan_revision_id, requestId: request.id, action: "REJECT", feedback: feedback.trim()};
  }
  return {revisionId: request.plan_revision_id, requestId: request.id, action: "REVISE", feedback: feedback.trim()};
}

function boundedText(value: unknown, limit: number, name: string): string {
  if (typeof value !== "string" || value.length > limit) throw new Error(`${name}格式无效或过长。`);
  return value.trim();
}

export function validateQuestionRequest(request: LearnerQuestionRequest): void {
  if (!request.id || !request.session_id || !["BACKGROUND", "CHECK", "PRACTICE_SET", "CONFIRM_GOAL", "START_LEARNING", "CONFIRM_PLAN_REVISION", "CONFIRM_MASTERY"].includes(request.purpose)) throw new Error("询问缺少会话或用途。");
  const decision = isDecisionRequest(request);
  if (request.purpose === "CONFIRM_MASTERY" && (!request.goal_id || !request.task_id || !request.skill_id ||
      request.assessment_contract_id || request.review_topic_id)) throw new Error("收尾自评须绑定当前Goal、Task及Skill，不能携带评分契约。");
  if (request.review_topic_id !== undefined && (request.purpose !== "CHECK" || !boundedText(request.review_topic_id, 200, "复测知识点") || !boundedText(request.review_skill_id, 200, "复测Skill"))) throw new Error("复测题须绑定原知识点及Skill。");
  if (request.purpose === "CONFIRM_PLAN_REVISION") {
    if (!boundedText(request.plan_revision_id, 200, "计划修订")) throw new Error("计划修订确认缺少候选修订。");
    if (!Number.isInteger(request.plan_revision_base) || Number(request.plan_revision_base) < 0)
      throw new Error("计划修订确认缺少有效的基础版本。");
    if (request.review_topic_id !== undefined || request.assessment_contract_id !== undefined)
      throw new Error("计划修订确认不能携带题目评价契约。");
  } else if (request.plan_revision_id !== undefined || request.plan_revision_base !== undefined) {
    throw new Error("只有计划修订确认可以绑定候选修订。");
  }
  if (decision && (request.questions.length !== 1 || !/^[a-f0-9]{64}$/.test(request.scope_signature ?? ""))) throw new Error("确认须绑定当前草案或学习现场，且一次只呈现一个动作。");
  if (request.purpose === "CHECK" && request.questions.length !== 1) throw new Error("教学检查一次只展示当前一道题。");
  if (request.purpose === "PRACTICE_SET" && (request.questions.length < 2 || request.questions.length > 10)) throw new Error("日常题组须有 2～10 道题。");
  if (request.purpose === "BACKGROUND" && (request.questions.length < 1 || request.questions.length > 5)) throw new Error("背景询问须有 1～5 个必要问题。");
  if (request.title !== undefined) boundedText(request.title, 100, "题组标题");
  if (request.instructions !== undefined) boundedText(request.instructions, 500, "题组说明");
  const ids = new Set<string>();
  for (const q of request.questions) {
    if (!boundedText(q.id, 80, "问题 ID") || ids.has(q.id) || !boundedText(q.prompt, 600, "问题")) throw new Error("问题 ID 必须唯一，题目不能为空。");
    ids.add(q.id);
    const fixedDecision = request.purpose === "CONFIRM_MASTERY"
      ? q.selection === "single" && q.options.length === 3 && q.options.every((option, index) =>
        option.id === MASTERY_REVIEW_OPTIONS[index]!.id && option.label === MASTERY_REVIEW_OPTIONS[index]!.label)
      : request.purpose === "CONFIRM_PLAN_REVISION"
      ? q.selection === "single" && q.options.length === 2
        && q.options[0]?.id === "proceed" && q.options[0]?.label === "确认修订"
        && q.options[1]?.id === "reject" && q.options[1]?.label === "暂不修订"
      : decision
        ? q.selection === "single" && q.options.length === 1 && q.options[0]?.id === "proceed"
          && q.options[0]?.label === (request.purpose === "CONFIRM_GOAL" ? "确认" : "开始学习")
        : false;
    if (decision ? !fixedDecision :
        q.selection === "freeform" ? !["BACKGROUND", "CHECK", "PRACTICE_SET"].includes(request.purpose) || q.options.length !== 0 :
        !["single", "multiple"].includes(q.selection) || q.options.length < 2 || q.options.length > 5) throw new Error("确认动作须使用固定按钮；普通问题提供 2～5 个选项，自由作答题组不展示选项。");
    const optionIds = new Set<string>();
    for (const option of q.options) {
      if (!boundedText(option.id, 80, "选项 ID") || optionIds.has(option.id) || !boundedText(option.label, 160, "选项")) throw new Error("选项 ID 必须唯一，标签不能为空。");
      optionIds.add(option.id);
      if (option.description !== undefined) boundedText(option.description, 400, "选项说明");
    }
  }
}

// 只保存服务端题目和用户实际提交的回答，不拥有 Kernel、评分或确认权限，也不在此做磁盘 I/O。
// 外层在接收完整答案后才开始模型回合；失败回滚只能撤销该回合新题，不能撤销已经提交的人类回答。
export class LearnerQuestionsContext {
  private state: LearnerQuestionsSnapshot = { pending: null, last_answer: null };
  private turnStart: LearnerQuestionsSnapshot | undefined;
  snapshot(): LearnerQuestionsSnapshot { return structuredClone(this.state); }
  beginUserTurn(): void {
    if (!this.state.pending) this.state.last_answer = null;
    if (this.state.transition_decision?.action === "needs_work") delete this.state.transition_decision;
  }
  restore(snapshot: LearnerQuestionsSnapshot, sessionId: string): void {
    if (snapshot.pending) validateQuestionRequest(snapshot.pending);
    if (snapshot.transition_decision) {
      // 复习fork可以继承原聊天，不能继承原会话的收尾同意；沿旧询问的忽略规则处理。
      if (snapshot.transition_decision.request.session_id !== sessionId) return;
      validateQuestionRequest(snapshot.transition_decision.request);
      if (snapshot.transition_decision.request.purpose !== "CONFIRM_MASTERY" ||
          !["confirm", "needs_work", "skip"].includes(snapshot.transition_decision.action) ||
          typeof snapshot.transition_decision.feedback !== "string") throw new Error("收尾决定的会话或内容无效。");
    }
    if (snapshot.pending?.session_id !== undefined && snapshot.pending.session_id !== sessionId) return;
    if (snapshot.last_answer?.request.session_id !== undefined && snapshot.last_answer.request.session_id !== sessionId) return;
    this.state = structuredClone(snapshot);
  }
  beginTurn(): void { this.turnStart = this.snapshot(); }
  endTurn(success: boolean): void {
    if (!success && this.turnStart) this.state = this.turnStart;
    this.turnStart = undefined;
  }
  invalidate(): void { this.state = { pending: null, last_answer: null }; this.turnStart = undefined; }
  consumePlanRevisionDecision(): void {
    if (this.state.last_answer?.request.purpose === "CONFIRM_PLAN_REVISION")
      this.state = {...this.state, last_answer: null};
  }
  ask(request: LearnerQuestionRequest): LearnerQuestionRequest {
    validateQuestionRequest(request);
    if (this.state.pending) throw new Error("已有待回答的问题，请等待学习者回答。");
    this.state.pending = structuredClone(request);
    return structuredClone(request);
  }
  /** 聊天打断教学题组；独立确认仍保留待决，不让普通文字绕过确认权限。 */
  chat(text: string): string {
    const request = this.state.pending;
    this.state = {pending: request && isDecisionRequest(request) ? request : null, last_answer: null,
      ...(this.state.transition_decision ? {transition_decision: this.state.transition_decision} : {}),
      ...(request ? {chat_interruption: {request_id: request.id, text}} : {})};
    return text;
  }
  answer(text: string, rawReply?: unknown): string {
    const request = this.state.pending;
    if (!request) {
      if (rawReply !== undefined) throw new Error("该问题已失效，请刷新当前学习后重新回答。");
      return text;
    }
    let reply: LearnerQuestionReply | null = null;
    let formatted = text.trim();
    if (rawReply !== undefined) {
      if (typeof rawReply !== "object" || rawReply === null) throw new Error("回答格式无效。");
      const value = rawReply as Partial<LearnerQuestionReply>;
      if (value.request_id !== request.id || !Array.isArray(value.answers) || value.answers.length !== request.questions.length) throw new Error("问题已变化或回答不完整，请核对当前问题。");
      const supplied = new Map<string, LearnerQuestionReply["answers"][number]>();
      for (const answer of value.answers) {
        if (!answer || typeof answer.question_id !== "string" || supplied.has(answer.question_id)) throw new Error("每个问题只能提交一次回答。");
        supplied.set(answer.question_id, answer);
      }
      const lines: string[] = [];
      reply = { request_id: request.id, answers: request.questions.map((question) => {
        const answer = supplied.get(question.id);
        if (!answer || !Array.isArray(answer.selected_option_ids) || answer.selected_option_ids.some((id) => typeof id !== "string")) throw new Error("缺少有效的问题回答。");
        const selected = [...new Set(answer.selected_option_ids)];
        if (selected.length !== answer.selected_option_ids.length || (question.selection === "single" && selected.length > 1) || selected.some((id) => !question.options.some((option) => option.id === id))) throw new Error("选项不属于当前题目或超出单选限制。");
        const other = boundedText(answer.other_text, 4000, "补充回答");
        const voiceInput = parseVoiceInputMetadata(answer.voice_input);
        if (voiceInput && !other) throw new Error("语音来源须对应实际自由回答。");
        if (!selected.length && !other) throw new Error("请选择一项或写下自己的回答。");
        const choices = selected.map((id) => question.options.find((option) => option.id === id)!.label).join("；");
        lines.push(question.selection === "freeform" ? `${question.prompt}\n回答：${other}` : isDecisionRequest(request)
          ? [choices, other].filter(Boolean).join("\n")
          : `${question.prompt}\n${choices ? `选择：${choices}` : ""}${choices && other ? "\n" : ""}${other ? `补充：${other}` : ""}`);
        return { question_id: question.id, selected_option_ids: selected, other_text: other, ...(voiceInput ? { voice_input: voiceInput } : {}) };
      }) };
      formatted = `${lines.join("\n\n")}${text.trim() ? `\n\n另外：${text.trim()}` : ""}`;
    }
    if (!formatted) throw new Error("回答不能为空。");
    const answer = { request: structuredClone(request), reply, text: formatted, used_choices: Boolean(reply?.answers.some((a) => a.selected_option_ids.length)), choices_exposed: !isDecisionRequest(request) && request.questions.some(q => q.options.length > 0) };
    const mastery = masteryReviewDecision(answer);
    if (request.purpose === "CONFIRM_MASTERY" && (!mastery || text.trim()))
      throw new Error("请使用收尾卡片选择一个动作；欠缺说明请在对应补充框中提交。");
    const previous = this.state.transition_decision;
    this.state = {pending: null, last_answer: answer,
      ...(mastery ? {transition_decision: {request: structuredClone(request), ...mastery}}
        : previous && previous.action !== "needs_work" ? {transition_decision: previous} : {})};
    return formatted;
  }
  writeGuard(toolName: string, askingInSameResponse = false): { block: true; reason: string } | undefined {
    if (this.state.chat_interruption && ["record_answer_assessment", "record_teaching_turn", "active_recall_checkpoint", "submit_evidence"].includes(toolName))
      return {block: true, reason: "本轮是围绕待答题的普通聊天或拒答，没有提交组件答案，不能评分、生成表现或写Evidence。"};
    if ((this.state.pending || askingInSameResponse) && ["record_goal_understanding", "initialize_learning_goal", "record_teaching_turn", "record_answer_assessment", "active_recall_checkpoint", "submit_evidence", "complete_learning_task", "activate_learning_task", "create_learning_task", "configure_teaching_activity", "apply_curriculum_plan", "present_practice_set", "propose_plan_revision", "decide_plan_revision"].includes(toolName)) return {
      block: true, reason: "问题尚未收到学习者回答。先向用户显示询问并等待，不得推断答案、确认目标或推进任务/证据。",
    };
    const answer = this.state.last_answer;
    if (answer?.request.purpose === "CONFIRM_MASTERY") {
      if (["record_answer_assessment", "record_teaching_turn", "active_recall_checkpoint", "submit_evidence"].includes(toolName))
        return {block: true, reason: "收尾自评只表达用户意图，不能评分、生成Candidate或写Evidence。先前真实表现应在呈现收尾卡片前保存。"};
      if (masteryReviewDecision(answer)?.action === "needs_work" &&
          ["complete_learning_task", "activate_learning_task", "create_learning_task", "apply_curriculum_plan"].includes(toolName))
        return {block: true, reason: "学习者表示仍有欠缺；本轮先解释或帮助定位欠缺，不结束当前任务或立刻重复催促确认掌握。"};
    }
    if (answer?.request.purpose === "START_LEARNING" && !learningStartApproved(answer) &&
        ["create_learning_task", "configure_teaching_activity", "activate_learning_task", "complete_learning_task", "record_teaching_turn", "active_recall_checkpoint", "submit_evidence"].includes(toolName)) return {
      block: true, reason: "学习者尚未同意开始，或提交了修改/暂缓说明。先处理说明并重新询问，不得推进教学或任务。",
    };
    if (answer?.request.purpose === "PRACTICE_SET"
        && ["record_answer_assessment", "record_teaching_turn", "active_recall_checkpoint", "submit_evidence"].includes(toolName)) {
      return {
        block: true,
        reason: "协议题组只用于日常练习，不能把整组答案聚合为 Candidate、Evidence 或正式评分；需要验证时另出一道 CHECK。",
      };
    }
    if (answer?.request.purpose === "CONFIRM_PLAN_REVISION") {
      const decision = planRevisionDecision(answer);
      const writes = ["record_goal_understanding", "initialize_learning_goal", "record_teaching_turn",
        "record_answer_assessment", "active_recall_checkpoint", "submit_evidence", "complete_learning_task",
        "activate_learning_task", "create_learning_task", "configure_teaching_activity", "apply_curriculum_plan", "present_practice_set",
        "ask_learner_questions", "propose_plan_revision"];
      if (decision?.action === "CONFIRM" || decision?.action === "REJECT") {
        if (toolName !== "decide_plan_revision" && writes.includes(toolName)) return {
          block: true,
          reason: "学习者刚提交计划修订决定；先调用 decide_plan_revision 保存真实决定，再继续其它操作。",
        };
      } else if (decision?.action === "REVISE" && toolName !== "propose_plan_revision" && writes.includes(toolName)) {
        return {
          block: true,
          reason: "学习者要求调整计划修订；先根据补充意见重新提出候选修订，不能确认旧候选。",
        };
      }
    }
    return undefined;
  }
}
