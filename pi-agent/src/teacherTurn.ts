import {readFileSync} from "node:fs";
import {FIGURE_TOOL,readFigureBatch} from "./lessonFigures.js";
import {defineTool, type SessionManager, type ToolDefinition} from "@earendil-works/pi-coding-agent";
import {Type} from "typebox";
import type {TeachingSessionContext} from "./teachingSession.js";
import type {LearnerQuestionsSnapshot, LearnerQuestionRequest} from "./learnerQuestionTypes.js";
import {learnerQuestionPrompt} from "./learnerQuestionPrompt.js";
import {publicAssistantText} from "./assistantProtocol.js";

export const BEGIN_REPLY = "begin_teacher_reply";
export const QUESTION_DELIVERY = "lawa.question-delivery/v1";
export const TURN_START = "lawa.teacher-actions/v1";
export const REPLY_START = "lawa.teacher-stream/v1";
export const TURN_END = "lawa.teacher-turn-end/v1";
const QUESTION_TOOLS = new Set(["ask_learner_questions", "present_practice_set"]);

export const TEACHER_TURN_POLICY = `Web课堂分为工具处理和流式讲解两阶段。
工具处理阶段不公开assistant正文，不要在这里写完整讲解。先完成所需读取、评分、记录与其他动作；学习者没有看到这阶段的文字，不能把内部草稿当作已经讲过的内容。
需要题卡时，最后单独调用ask_learner_questions或present_practice_set。题卡真正保存后，系统立即投递；教学题和CONFIRM_MASTERY收尾卡自动进入流式讲解阶段，无需再调用begin_teacher_reply。题卡只负责收集回答或决定，保存题卡不代表讲解、反馈已经完成。
时间讲解动画作为最后一批操作并成功保存后，宿主可直接开启公开讲解。仍需准备题卡或其他工具时，用keep_preparing保留工具阶段。其他无新题卡的讲解，处理完必要工具后单独调用begin_teacher_reply（无参数）。
公开正文按本轮学习需求与有效教学偏好完成讲解。新知识点先讲清要解决的问题、关键机制和必要过程，用具体例子把过程展开；有可核对的旧知识时说明联系。不因有题卡而缩成一句作答邀请，不以罗列更多主题替代讲透。已有正式题目需要独立尝试时，使用不同情境讲方法，不泄露待答题的答案或逐问提示。
收尾卡之后仍须根据本轮真实表现完成必要反馈、纠错与总结，再等待用户选择；等待的是用户决定，不是省略教师讲解。BACKGROUND和START_LEARNING仍按原流程等待，不提前开始未经授权的教学。
进入讲解阶段后工具关闭，本轮不能再修改学习状态；文字逐段显示，不必先生成完整稿件。只能依据已返回的真实结果说明完成情况。SAVED代表服务端保存，不能推断用户浏览器已显示；题卡的成功状态由页面组件自身呈现。
工具失败时可依据错误更正必要参数；无法处理则begin_teacher_reply后如实说明，不能把失败说成成功。已提交但未保存的评分仍保持原恢复入口。`;

interface QuestionDelivery {assistantEntryId: string; questions: LearnerQuestionsSnapshot}
/** 兼容上一版已保存的讲解；回退代码不回退用户聊天，更不把当时隐藏的草稿重新公开。 */
export function teacherVisibility(manager: SessionManager) {
  const hidden = new Set<string>(), texts = new Map<string, string>(), deliveries = new Set<string>();
  const phases = new Map<string, boolean>();
  const durable = durableLines(manager);
  for (const e of manager.getEntries()) {
    let privateText = e.parentId ? phases.get(e.parentId) ?? false : false;
    if (e.type === "custom" && [TURN_START, "lawa.teacher-delivery-start/v1"].includes(e.customType)) privateText = true;
    if (e.type === "custom" && [REPLY_START, TURN_END, "lawa.teacher-delivery-end/v1"].includes(e.customType)
        && (!durable || durable.has(JSON.stringify(e)))) privateText = false;
    phases.set(e.id, privateText);
    if (savedQuestionSnapshot(e) && (!durable || durable.has(JSON.stringify(e)))) deliveries.add(e.id);
    if (e.type === "message" && e.message.role === "assistant" && privateText) hidden.add(e.id);
    if (e.type === "custom" && e.customType === "lawa.teacher-delivery/v1" && (!durable || durable.has(JSON.stringify(e)))) {
      const data = e.data as {assistantEntryId?: string; text?: string};
      if (typeof data?.assistantEntryId === "string" && typeof data.text === "string") texts.set(data.assistantEntryId, data.text);
    }
  }
  // 旧Pi原件保留供诊断；聊天、笔记定位、题源和分支摘要共享同一公开投影。
  for (const e of manager.getEntries()) {
    if (e.type !== "message" || e.message.role !== "assistant" || hidden.has(e.id)) continue;
    const original = texts.get(e.id) ?? e.message.content.filter(p => p.type === "text").map(p => p.text).join("\n");
    const visible = publicAssistantText(original);
    if (visible !== original) texts.set(e.id, visible);
  }
  return {hidden, texts, deliveries};
}

export function savedQuestionSnapshot(entry: {type: string; customType?: string; data?: unknown}): LearnerQuestionsSnapshot | undefined {
  return entry.type === "custom" && [QUESTION_DELIVERY, "lawa.teacher-delivery/v1"].includes(entry.customType ?? "")
    ? (entry.data as QuestionDelivery | undefined)?.questions : undefined;
}

function durableLines(manager: SessionManager): Set<string> | undefined {
  const file = manager.getSessionFile();
  if (!file) return;
  try {return new Set(readFileSync(file, "utf8").split(/\r?\n/));}
  catch {return new Set();}
}

/** 题卡提交与正文流是两个边界：先确认可恢复的题卡，再开放只读模型输出。 */
export class TeacherTurn {
  active = false;
  speaking = false;
  private startId = "";
  private deliveredId: string | undefined;
  get hasDeliveredQuestion() {return Boolean(this.deliveredId);}
  constructor(private manager: SessionManager, private context: TeachingSessionContext,
    private onQuestion: (request: LearnerQuestionRequest) => void) {}

  begin() {
    this.active = true; this.speaking = false; this.deliveredId = undefined;
    this.startId = this.manager.appendCustomEntry(TURN_START, {});
  }
  end() {
    try {if (this.active) this.manager.appendCustomEntry(TURN_END, {});}
    finally {this.active = false; this.speaking = false;}
  }
  guard(calls: Array<{name: string}>) {
    if (!this.active) return;
    if (this.speaking) return {block: true as const, reason: "流式讲解阶段只读，本轮工具处理已结束。"};
    if (calls.some(c => c.name === BEGIN_REPLY || QUESTION_TOOLS.has(c.name)) && calls.length !== 1)
      return {block: true as const, reason: "出题或开始讲解必须单独调用；先取得其它工具结果，再进入讲解。"};
  }
  private verify() {
    const saved = durableLines(this.manager);
    const branch = this.manager.getBranch();
    const start = branch.findIndex(e => e.id === this.startId);
    if (start < 0 || saved && branch.slice(start).some(e => !saved.has(JSON.stringify(e))))
      throw new Error("题卡或本轮来源尚未确认保存，请重试。");
  }
  private saveQuestion() {
    const questions = this.context.learnerQuestions.snapshot(), pending = questions.pending;
    if (!pending || this.deliveredId === pending.id) return;
    const assistant = this.manager.getBranch().findLast(e => e.type === "message" && e.message.role === "assistant");
    if (!assistant) throw new Error("缺少本轮出题来源。");
    const persisted = teacherVisibility(this.manager).deliveries;
    const existing = this.manager.getBranch().findLast(e => persisted.has(e.id) && savedQuestionSnapshot(e)?.pending?.id === pending.id);
    if (!existing) this.manager.appendCustomEntry(QUESTION_DELIVERY, {assistantEntryId: assistant.id, questions} satisfies QuestionDelivery);
    this.verify();
    this.deliveredId = pending.id;
    // 已落盘题卡独立于后续讲解成败；仅保留题目现场，不提交Candidate或授予掌握。
    this.context.learnerQuestions.beginTurn();
    this.context.activeRecall.beginTurn();
    const visible = structuredClone(pending);
    visible.questions.forEach(q => {q.prompt = learnerQuestionPrompt(pending, q.prompt);});
    this.onQuestion(visible);
  }
  /** 一整批工具成功归档后，已就绪的时间动画可以直接进入公开讲解。 */
  openAfterMotionBatch(goalId:string,taskId:string,skillIds:readonly string[]) {
    if (!this.active || this.speaking || this.context.learnerQuestions.snapshot().pending) return;
    const branch=this.manager.getBranch();
    const receipts=new Map<string,string>();
    let ready=false;
    for (let i=branch.length-1;i>=0;i--) {
      const entry=branch[i]!;
      if (entry.id===this.startId) return;
      if (entry.type!=="message") continue;
      const message=entry.message;
      if (message.role==="toolResult") {
        if (message.isError) return;
        receipts.set(message.toolCallId,message.toolName);
        if (message.toolName===FIGURE_TOOL && message.details?.streamAfterMotion===true) {
          const batch=readFigureBatch(message.details.lessonFigures);
          ready ||= !!batch && batch.sessionId===this.context.getSessionId() && batch.goalId===goalId && batch.taskId===taskId &&
            skillIds.includes(batch.skillId) && batch.figures.some(f=>"motion" in f && !!f.motion);
        }
        continue;
      }
      if (!ready || message.role!=="assistant") return;
      const calls=message.content.filter(p=>p.type==="toolCall");
      if (calls.length===receipts.size && calls.every(c=>receipts.get(c.id)===c.name)) {
        this.verify();
        this.openReply();
      }
      return;
    }
  }
  private openReply() {
    if (!this.active || this.speaking) throw new Error("本轮讲解阶段不可重复开启。");
    // 守卫产生的收尾/规划题卡也必须先保存，不能借普通回复绕过提交边界。
    this.saveQuestion();
    this.manager.appendCustomEntry(REPLY_START, {questionId: this.deliveredId ?? null});
    this.verify();
    this.speaking = true;
  }
  replyTool() {
    return defineTool({name: BEGIN_REPLY, label: "开始讲解", description: TEACHER_TURN_POLICY,
      parameters: Type.Object({}),
      execute: async () => {
        this.openReply();
        return {content: [{type: "text" as const, text: JSON.stringify({status: "READY_TO_STREAM", question_id: this.deliveredId ?? null,
          question_status: this.deliveredId ? "SAVED" : "NONE", instruction: "现在直接流式回答学习者；所有工具已关闭。只依据真实回执，页面题卡状态由系统显示。"})}], details: {readyToStream: true}};
      }});
  }
  wrap(tool: ToolDefinition): ToolDefinition {
    if (!QUESTION_TOOLS.has(tool.name)) return tool;
    return {...tool, description: tool.description + " Web: 请最后单独调用。题卡持久保存后自动开启流式讲解，下一响应直接输出正文。",
      execute: async (id, params, signal, onUpdate, ctx) => {
        const before = this.context.snapshot();
        try {
          const result = await tool.execute(id, params, signal, onUpdate, ctx);
          const pending = this.context.learnerQuestions.snapshot().pending;
          if (!pending || (result.details as {requestId?: string})?.requestId !== pending.id)
            throw new Error("题卡保存回执与当前题目不一致。");
          this.saveQuestion();
          // 原工具的终止用于等待用户决定。Web已隔离工具阶段，收尾后必须另给只读正文，
          // 否则评分/卡片成功会吞掉反馈。仍由公开阶段守卫阻止完成Task或代确认Mastery。
          const closingFeedback = this.active && pending.purpose === "CONFIRM_MASTERY";
          const terminate = Boolean(result.terminate) && !closingFeedback;
          if (!terminate) this.openReply();
          const payload = JSON.parse(result.content.filter(c => c.type === "text").map(c => c.text).join("\n"));
          return {...result, ...(closingFeedback ? {terminate: false} : {}), content: [{type: "text" as const, text: JSON.stringify({...payload,
            delivery: {question_status: "SAVED", request_id: pending.id, presentation: "SENT_NOT_ACKNOWLEDGED"},
            instruction: terminate ? "等待学习者实际决定。" : closingFeedback
              ? "收尾卡已保存。现在流式完成本轮作答反馈、必要纠错与小结；工具处理阶段的文字学习者没看到，不可省略正文。随后等待真实用户选择，不代确认掌握、不完成或切换Task；所有工具已关闭。"
              : "题卡已保存并投递。现在按本轮需求完整讲解或反馈，不能因题卡出现而只剩一句邀请作答；需要独立尝试的题目不泄露答案。工具已关闭，不重复生成题卡，不声称浏览器已经显示。"})}]};
        } catch (error) {
          if (!this.deliveredId) {
            this.context.learnerQuestions.restore(before.learner_questions!, this.context.getSessionId());
            this.context.activeRecall.restorePath(before.active_recall ?? null);
          }
          throw error;
        }
      }};
  }
}
