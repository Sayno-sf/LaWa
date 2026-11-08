import { AssistanceLevelSchema, combineAssistance } from "./assistanceJudgment.js";
import { createHash } from "node:crypto";
import { defineTool, type SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchLearningOverview, type LearningOverviewToolOptions } from "./learningOverviewTool.js";
import type { TeachingSessionContext } from "./teachingSession.js";
import { readAnswerAssessment, type AnswerAssessment } from "./answerAssessmentTypes.js";
import {routeMessageIds, ROUTE_TRANSITION} from "./web/routePathState.js";
import {teacherVisibility, savedQuestionSnapshot} from "./teacherTurn.js";

export interface AssessmentSource {
  sessionId: string; turnId: string; answer: string;
  goalId?: string; taskId?: string;
  questions: Array<{ entryId: string; text: string; hintLevel?: number; contractId?: string }>;
  savedAssessment?: AnswerAssessment;
  feedbackRetry?: boolean;
}
const textOf = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content)
  ? content.filter(v => v?.type === "text" && typeof v.text === "string").map(v => v.text).join("\n") : "";
const normalized = (text: string) => text.replace(/\s+/g, " ").trim();

// 普通回合保持原先的相邻问答边界；返回主线后额外恢复离开前的原题，不借用旁支讲解。
function questionEntries(manager: SessionManager, last: number) {
  const branch = manager.getBranch();
  let prior = branch.slice(0, last).findLastIndex(e => e.type === "message" && e.message.role === "user");
  const returned = branch.slice(prior + 1, last).findLast(e => e.type === "custom" && e.customType === ROUTE_TRANSITION &&
    ["return", "complete"].includes((e.data as {action?: string})?.action ?? ""));
  if (returned?.type !== "custom") return branch.slice(prior + 1, last);
  const route = returned.data as {branchId: string; path: string; taskId?: string};
  if (typeof route.path !== "string" || !route.path.endsWith(":main") || !route.branchId) return branch.slice(prior + 1, last);
  const enter = branch.slice(0, branch.indexOf(returned)).findLastIndex(e => e.type === "custom" && e.customType === ROUTE_TRANSITION &&
    (e.data as {action?: string})?.action === "enter" && (e.data as {branchId?: string}).branchId === route.branchId);
  if (enter < 0) return branch.slice(prior + 1, last);
  const mainIds = routeMessageIds(manager, route.path, branch[last]!.id);
  const proposal = branch.slice(0, enter).findLastIndex(e => {
    if (e.type !== "message" || e.message.role !== "toolResult" || e.message.isError || e.message.toolName !== "propose_learning_branch") return false;
    try {return JSON.parse(textOf(e.message.content)).branch?.id === route.branchId;} catch {return false;}
  });
  const firstEnter = proposal < 0 ? -1 : branch.findIndex((e, i) => i > proposal && e.type === "custom" && e.customType === ROUTE_TRANSITION &&
    (e.data as {action?: string}).action === "enter" && (e.data as {branchId?: string}).branchId === route.branchId);
  // 离开前的请求可能是“先补一下”，它不是对主线原题的作答。保留其前一教师回合及分支提案回合。
  const mainUsers = branch.slice(0, enter).flatMap((e, i) => e.type === "message" && e.message.role === "user" && mainIds.has(e.id) ? [i] : []);
  prior = mainUsers.at(-2) ?? -1;
  let start = prior + 1;
  // 新Task/Goal是硬边界，不能把旧任务的题目借给返回后的新任务。
  for (let i = start; i < last; i++) {
    const e = branch[i]!;
    if (e.type === "custom" && e.customType === "lawa.goal-observation" &&
        (e.data as {goalId?: string})?.goalId && !route.path.startsWith(`${(e.data as {goalId: string}).goalId}:`)) start = i + 1;
    if (e.type === "message" && e.message.role === "toolResult" && !e.message.isError && e.message.toolName === "activate_learning_task" && mainIds.has(e.id)) {
      try {const task = JSON.parse(textOf(e.message.content)); if (task.id && task.id !== route.taskId) start = i + 1;} catch {}
    }
  }
  return branch.slice(start, last).filter((e, i) => (mainIds.has(e.id) || e.type === "custom" && savedQuestionSnapshot(e) &&
    mainIds.has((e.data as {assistantEntryId: string}).assistantEntryId)) && !(proposal >= 0 && i + start >= proposal && i + start < firstEnter));
}

// 来源只取真实Pi中的人类回合和可追溯原题；模型不能传入答案或任意来源身份。
export function assessmentSource(manager: SessionManager): AssessmentSource | null {
  const branch = manager.getBranch();
  const last = branch.findLastIndex(e => e.type === "message" && e.message.role === "user");
  const entry = branch[last];
  if (!entry || entry.type !== "message" || entry.message.role !== "user") return null;
  const answer = textOf(entry.message.content).replace(/\[LAWA_MATERIAL_CONTEXT\][\s\S]*?\[\/LAWA_MATERIAL_CONTEXT\]\n?/g, "").trim();
  if (!answer) return null;
  let goalId: string | undefined, taskId: string | undefined;
  for (const row of branch.slice(0, last)) {
    if (row.type === "custom" && row.customType === "lawa.goal-observation") {
      const next = (row.data as {goalId?: string})?.goalId;
      if (next !== goalId) taskId = undefined;
      goalId = next;
    }
    if (row.type === "custom" && row.customType === ROUTE_TRANSITION)
      taskId = (row.data as {taskId?: string})?.taskId;
    if (row.type === "message" && row.message.role === "toolResult" && row.message.toolName === "activate_learning_task" && !row.message.isError) {
      try {const task = JSON.parse(textOf(row.message.content)); if (typeof task.id === "string") taskId = task.id;} catch {}
    }
  }
  const questions: AssessmentSource["questions"] = [];
  const publications = teacherVisibility(manager);
  for (const e of questionEntries(manager, last)) {
    if (publications.deliveries.has(e.id)) {
      const pending = savedQuestionSnapshot(e)?.pending;
      if (pending?.purpose === "CHECK")
        for (const q of pending.questions) questions.push({entryId: e.id, text: q.prompt, hintLevel: 0, contractId: pending.assessment_contract_id});
    }
    if (e.type !== "message") continue;
    if (e.message.role === "assistant") {
      const text = publications.texts.get(e.id) ?? (publications.hidden.has(e.id) ? "" : textOf(e.message.content));
      if (text) questions.push({entryId: e.id, text});
    }
    if (e.message.role === "toolResult" && !e.message.isError && ["record_teaching_turn", "active_recall_checkpoint", "ask_learner_questions"].includes(e.message.toolName)) {
      try {
        const data = JSON.parse(textOf(e.message.content));
        for (const q of [data.current_question, data.checkpoint?.current_question, ...(data.request?.purpose === "CHECK" ? data.request.questions.map((q: {prompt: string}) => q.prompt) : [])]) {
          if (typeof q === "string" && q.trim()) questions.push({entryId: e.id, text: q, hintLevel: data.checkpoint?.hint_level ?? data.hint_level ?? 0,
            ...(data.request?.assessment_contract_id ? {contractId: data.request.assessment_contract_id} : {})});
        }
      } catch { /* 旧损坏记录不能授予评分来源；仍可核对实际公开题面。 */ }
    }
  }
  const savedAssessment = branch.slice(last + 1).flatMap(row => {
    if (row.type !== "message" || row.message.role !== "toolResult" || row.message.toolName !== "record_answer_assessment" || row.message.isError) return [];
    const saved = readAnswerAssessment((row.message.details as {assessment?: unknown} | undefined)?.assessment);
    return saved?.source_session_id === manager.getSessionId() && saved.source_turn_id === entry.id
      && saved.answer_sha256 === createHash("sha256").update(answer).digest("hex") ? [saved] : [];
  }).at(-1);
  const feedbackRetry = branch.slice(last + 1).some(row => row.type === "custom_message" &&
    row.customType === "lawa.feedback-retry" && (row.details as {source_user_entry_id?: string})?.source_user_entry_id === entry.id);
  return {sessionId: manager.getSessionId(), turnId: entry.id, answer, questions, ...(goalId ? {goalId} : {}), ...(taskId ? {taskId} : {}),
    ...(savedAssessment ? {savedAssessment} : {}), ...(feedbackRetry ? {feedbackRetry: true} : {})};
}

/** 模型可选择受限原文片段，无须反复抄写长题面。ID只在本轮真实来源集合内解析。 */
export function assessmentQuestionSources(answer: AssessmentSource) {
  return answer.questions.flatMap((q, index) => {
    const parts = q.contractId ? [q.text] : q.text.split(/\n\s*\n/);
    return parts.flatMap((text, part) => text.trim() && text.length <= 2000
      ? [{...q, text: text.trim(), sourceId: `${q.entryId}:${index}:${part}`}]
      : []);
  });
}

function assessmentResult(assessment: AnswerAssessment) {
  return {content: [{type: "text" as const, text: JSON.stringify({status: "SAVED", assessment: {
    id: assessment.id, topic_id: assessment.topic_id, skill_id: assessment.skill_id, score: assessment.score,
    max_score: 10, assistance_level: assessment.assistance_level, follow_up: assessment.follow_up, review_after: assessment.review_after},
    instruction: "评分已保存并呈现。简短回应关键表现，随后继续适合的学习内容；不要重复整张评分表，不把分数写成Mastery或用低分卡住进度。"})}], details: {assessment}};
}

export function createRecordAnswerAssessmentTool(context: TeachingSessionContext,
  options: LearningOverviewToolOptions = {}, source?: () => AssessmentSource | null, onSourceValidated?: () => void) {
  return defineTool({
    name: "record_answer_assessment", label: "记录本题表现",
    description: "主教师检查学习者针对真实题目的实际回答后，保存单题10分制评分并显示评分表。优先传当前来源清单中的question_source_id，由系统原样引用题面；也可用question逐字引用真实原题。题目可以在正文中，不要求一定有题卡；返回主线时可继续评价离开前的原题。不要传入或改写用户答案；运行时绑定Pi实际作答和来源。criteria按题目目标给1-5个评分点，possible合计必须10，earned逐项说明；只评本次表现，不评人格或主观努力。topic用具体且稳定的知识点名称，已存在时复用practice_context里的topic/topic_id；穿插复测旧Skill时传其topic_id，成绩仍归旧知识点，不更换当前Task或伪造Evidence。普通聊天、背景自述、确认/开始、跳过不打分；语音转写只评文字内容，不评发音。主教师结合本题实际回答判断帮助并填写assistance_level；助教记录和自动分类仅供参考。当前题已知的提示/选项/参考仍如实保留。已保存回答的重试返回原分数，不重复记分。先成功记录，再在后续工具响应呈现下一题，不与ask_learner_questions并行；低分不成为继续学习的门槛。",
    parameters: Type.Object({
      question: Type.Optional(Type.String({minLength: 1, maxLength: 2000})),
      question_source_id: Type.Optional(Type.String({minLength: 1, maxLength: 200})),
      assistance_level: Type.Optional(Type.Union([AssistanceLevelSchema, Type.Literal("UNKNOWN")])),
      topic: Type.String({minLength: 1, maxLength: 160}),
      topic_id: Type.Optional(Type.String({minLength: 1, maxLength: 200})),
      topic_aliases: Type.Optional(Type.Array(Type.String({minLength: 1, maxLength: 160}), {maxItems: 6})),
      criteria: Type.Array(Type.Object({label: Type.String({minLength: 1, maxLength: 100}),
        earned: Type.Integer({minimum: 0, maximum: 10}), possible: Type.Integer({minimum: 1, maximum: 10}),
        feedback: Type.String({minLength: 1, maxLength: 400})}), {minItems: 1, maxItems: 5}),
      summary: Type.String({minLength: 1, maxLength: 600}),
      strengths: Type.Array(Type.String({minLength: 1, maxLength: 240}), {maxItems: 4}),
      gaps: Type.Array(Type.String({minLength: 1, maxLength: 240}), {maxItems: 4}),
    }),
    execute: async (_id, params, signal) => {
      const answer = source?.();
      const snapshot = context.snapshot();
      const lastAnswer = snapshot.learner_questions?.last_answer;
      if (!answer || snapshot.learner_questions?.chat_interruption || snapshot.learner_questions?.pending || lastAnswer && lastAnswer.request.purpose !== "CHECK" ||
          /^(跳过|先继续学|之后再问|稍后再检查|结束本次检查)[。！!\s]*$/.test(answer.answer)) throw new Error("本轮没有可评分的真实答题；确认、跳过与背景自述不打分。");
      const requiredContract = lastAnswer?.request.assessment_contract_id;
      const availableSources = assessmentQuestionSources(answer).filter(q => !requiredContract || q.contractId === requiredContract);
      const chosen = params.question_source_id ? availableSources.find(q => q.sourceId === params.question_source_id) : undefined;
      let question = chosen?.text ?? params.question?.trim() ?? "";
      if (lastAnswer?.request.review_topic_id && params.topic_id !== lastAnswer.request.review_topic_id) throw new Error("本题是穿插复测，评分必须沿用题目绑定的原topic_id。");
      const matching = params.question_source_id ? chosen ? [chosen] : []
        : question ? answer.questions.filter(q => (!requiredContract || q.contractId === requiredContract) && normalized(q.text).includes(normalized(question))) : [];
      const anchor = matching.find(q => q.contractId) ?? matching[0];
      if (!anchor) throw new Error("评分题面必须逐字对应本轮可追溯的真实题目，不能自造题面或给普通提问评分。没有题卡不等于不能评分；正文原题也可用。请用以下真实来源的question_source_id重试，系统会原样引用，不要再猜写题面。若无适用来源，只能说明无法评分，不能编造分数。\n" +
        JSON.stringify(availableSources.slice(-8).map(q => ({question_source_id: q.sourceId, text: q.text.slice(0, 600)}))));
      const contractId = lastAnswer?.request.assessment_contract_id ?? anchor.contractId;
      if (contractId) question = anchor.text;
      const overview = await fetchLearningOverview(options, signal);
      const goalId = (overview.goal_profile as {id?: string} | null)?.id;
      const task = overview.active_task as {id?: string; related_skill_ids?: string[]} | null;
      if (!goalId || !task?.id || !task.related_skill_ids?.[0]) throw new Error("评分须对应当前Goal的ACTIVE教学任务。");
      if (answer.goalId && answer.goalId !== goalId || answer.taskId && answer.taskId !== task.id)
        throw new Error("原作答所属的目标或任务已经变化，不能把旧回答评分写给新任务。");
      if (lastAnswer?.request.purpose === "CHECK" && (lastAnswer.request.goal_id !== goalId || lastAnswer.request.task_id !== task.id
          || !task.related_skill_ids.includes(lastAnswer.request.skill_id ?? ""))) throw new Error("原作答所属的目标或任务已经变化，不能把旧回答评分写给新任务。");
      onSourceValidated?.();
      // 原回合的成功回执已经绑定同一真实答案；恢复反馈无需再次POST或追加一份成绩。
      if (answer.savedAssessment && answer.savedAssessment.goal_id === goalId && answer.savedAssessment.source_task_id === task.id)
        return assessmentResult(answer.savedAssessment);
      // 旧题的hint_level不能污染新题；结构化提交中的题面也不是用户“参考了文档”的自报。
      const hintLevel = Math.max(0, ...matching.map(q => Number.isInteger(q.hintLevel) ? Math.min(4, Math.max(0, q.hintLevel!)) : 0),
        snapshot.current_question && normalized(snapshot.current_question).includes(normalized(question)) ? snapshot.hint_level : 0);
      const actualAnswerText = lastAnswer?.reply ? lastAnswer.reply.answers.map(a => a.other_text).join("\n") : answer.answer;
      const reportedReference = /照着|跟着|参考了|查阅了|(?:看了|看过|参考|查阅).{0,12}(?:文档|教程|资料|示例|模板|答案)/.test(actualAnswerText);
      const observed = hintLevel >= 3 || context.branchHelpForCurrentAnswer() ? "WITH_HELP"
        : reportedReference || snapshot.current_speech_reference ? "WITH_REFERENCE"
        : hintLevel > 0 || lastAnswer?.choices_exposed ? "WITH_HINT" : "INDEPENDENT";
      // 只合并本题已知曝光；助教分类不再被注入为强制最低帮助或 UNKNOWN。
      const level = params.assistance_level === "UNKNOWN" && !context.branchHelpForCurrentAnswer() ? "UNKNOWN"
        : combineAssistance(observed, params.assistance_level === "UNKNOWN" ? undefined : params.assistance_level);
      const answerCharacters = Array.from(answer.answer);
      const body = {id: "assessment-" + createHash("sha256").update(`${answer.sessionId}\0${answer.turnId}`).digest("hex").slice(0, 32),
        goal_id: goalId, skill_id: task.related_skill_ids[0], source_task_id: task.id,
        source_session_id: answer.sessionId, source_turn_id: answer.turnId, question_entry_id: anchor.entryId,
        answer_excerpt: answerCharacters.slice(0, 8000).join(""), answer_sha256: createHash("sha256").update(answer.answer).digest("hex"),
        answer_truncated: answerCharacters.length > 8000, assistance_level: level, question,
        topic: params.topic, ...(params.topic_id ? {topic_id: params.topic_id} : {}), ...(params.topic_aliases ? {topic_aliases: params.topic_aliases} : {}), ...(contractId ? {contract_id: contractId} : {}), criteria: params.criteria,
        summary: params.summary, strengths: params.strengths, gaps: params.gaps};
      const endpoint = `${(options.baseUrl ?? "http://127.0.0.1:8000").replace(/\/$/, "")}/api/learning/answer-assessments`;
      const validReceipt = (payload: unknown) => {
        const value = readAnswerAssessment(payload);
        return value && value.id === body.id && value.goal_id === goalId && value.source_task_id === task.id &&
          value.answer_sha256 === body.answer_sha256 && value.question === question && value.question_entry_id === anchor.entryId &&
          value.source_turn_id === answer.turnId && value.source_session_id === answer.sessionId ? value : null;
      };
      const reconcile = async () => {
        const response = await (options.fetchImpl ?? fetch)(`${endpoint}/${encodeURIComponent(body.id)}?goal_id=${encodeURIComponent(goalId)}`, {
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
        });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error("暂不能核验原评分是否已保存；请稍后恢复，不重复创建成绩。");
        const receipt = validReceipt(await response.json());
        if (!receipt) throw new Error("原评分核验来源不一致；请保留缺失状态，不能借用其他作答的成绩。");
        return receipt;
      };
      // 只有显式恢复才执行写前核验。未知结果不盲重放；真正没有记录才重新评估原提交。
      if (answer.feedbackRetry) {
        const recovered = await reconcile();
        if (recovered) return assessmentResult(recovered);
      }
      try {
        const response = await (options.fetchImpl ?? fetch)(endpoint, {
          method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(`评分未能保存：${payload.detail ?? response.status}。不能声称已经记录，可稍后重试。`);
        const assessment = validReceipt(payload);
        if (!assessment) throw new Error("评分响应来源无效，不能声称已经保存。");
        return assessmentResult(assessment);
      } catch (error) {
        // 请求失败不能证明写入失败；只从 Kernel 的原提交身份取回真实回执。
        try {const recovered = await reconcile(); if (recovered) return assessmentResult(recovered);} catch { /* 核验也失败时保留待恢复状态，不自动重发写入。 */ }
        throw error;
      }
    },
  });
}
