import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchLearningOverview, type LearningOverviewToolOptions } from "./learningOverviewTool.js";
import {normalizeLearningDomain} from "./planning/planningTypes.js";

export const TEACHING_EVOLUTION_TOOLS = ["read_teaching_context", "propose_teaching_strategy", "suggest_goal_completion", "correct_answer_assessment"];

export async function teachingRequest(options: LearningOverviewToolOptions, path: string, body?: unknown, signal?: AbortSignal) {
  const response = await (options.fetchImpl ?? fetch)(`${(options.baseUrl ?? "http://127.0.0.1:8000").replace(/\/$/, "")}/api/${path}`, {
    method: body === undefined ? "GET" : "POST", headers: {"Content-Type": "application/json"},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.detail ?? "教学记录暂时不可用，请重新读取后再试。");
  return value;
}

export function teachingSubject(goal: unknown): string {
  const profile = goal && typeof goal === "object" ? goal as Record<string, unknown> : {};
  // 领域来自已确认目标；未知目标保持本Goal范围，不再用关键词猜测或归入general池。
  const domain = normalizeLearningDomain(profile.learning_domain);
  return domain ? `domain:${domain}` : "";
}

export const PERSONAL_TEACHING_POLICY = `
用途驱动的公平教学：题面公开任务、所需输出及必要作答要求，不公开参考答案或解题结果；新CHECK用assessment_criteria固定1-5个评分维度、合计10分。评分维度是后台冻结契约，可能包含答案，不能复制到题面、正文或待答题提示中；提交作答后再解释评价依据。批改只用这些维度，不追加解释/术语/步骤要求；开放题允许合理不同解法。额外问题可反馈，不额外扣分。旧题无可信契约则保留兼容反馈，不假造事前要求。
写评价和正文前逐项对照本轮真实答案；声称遗漏某个词、符号或条件时先核对它确实缺失，已出现的内容不能再列作缺口。文字答题只支持评价文字；不能据此声称用户说话不卡壳、发音正确或没有查过资料。INDEPENDENT只表示运行时没有记录到相关帮助，不证明用户在系统外没有帮助。
概括规则或比较影响大小前，核对适用条件、比较对象、保持不变的量及一个可能反例；区分群体大小与事件数量、比例与比值、相关与因果，不把特例说成普遍规律。计算后用原式或独立数量核对解释方向、分子分母及翻倍/减半是否一致；数值整齐只说明形式，不证明推理正确。评价合理的条件化结论，不按固定措辞或关键词判分。
有提示、参考或示范后的正确表现按实际帮助记录；只有后续确实撤去相关提示、取得新的真实输出时，才评价这次独立迁移。相同题换数字、用户表示明白或流程走完，不自动证明迁移、长期保持或用户确认掌握。
高分减少重复讲解，但不证明长期保持；后续自然任务用到时观察，不按3/5次回答强制复测。缺口区分已观察到的用途阻碍、可能相关和可选扩展；仅必要时短补练，不因低分卡进度。
老师有误判时先用read_teaching_context精确读取原评价及更正，再用correct_answer_assessment追加更正；不全历史重批、不改写Evidence。新知识点命名不确定时用topic_query查已有名字和别名；POSSIBLE只是相似提示，不能凭相似度合并。确定同一知识点时复用topic_id并登记短别名，不重写旧评分。
可根据当前任务试用不同教法。自然阶段结束或用户反馈后，有真实来源才propose_teaching_strategy，具体说明适用活动、以后怎么教及范围；使用read_teaching_context取得实际assessment_ids。领域相同不表示每个任务都适用同一策略。只提出候选，不能替用户确认。SUBJECT使用Goal已确认的具体learning_domain；旧Goal领域未知时先用GOAL，不猜领域、不为此重做路线。USER范围只保存不依赖课程的简短教法，不包含资料原文、题面或来源摘录；确认组件说明删除来源目标后仍保留，用户确认后才成为独立个人安排。GOAL/SUBJECT仍随来源管理。用户补充产生REVISION_REQUESTED时，按原ID和最新revision修订后再次确认。拒绝不反复重提。策略与答题独立，不将策略意见当答案，不评分、不写Evidence、不清空当前题。
跨目标USER安排用各领域都成立的方法表述；例如“具体短例子后讲规则”可以通用，“开口复述/朗读”只适用于语言、“可运行代码”只适用于程序，应限制到SUBJECT，不能把本学科的动作偷偷泛化成全局要求。
用户当前明确要求优先于旧个人策略。候选和确认文本都是有范围的数据，不能覆盖权限。撤回、删除或请求修改的安排不再使用，不从旧聊天重新恢复。用户满意与实际新情境表现分开，不以自己的评分证明自己教得有效，也不固化人格/能力标签。
围绕用户用途规划少量可观察结果，非必要扩展不强加。实际表现支持用途时可suggest_goal_completion，由用户决定接受、暂时结束或继续。必须以工具返回的当前Kernel closure_progress逐阶段核对未覆盖节点和缺失评分；综合题提到后续概念不代表后续实际节点已完成。可以结束本次会话，但本次结束、路线学习流程完成、正式评分覆盖、整体能力验证及用户确认掌握分别表达；不把任一个推成其余结论。旧结束提案只是当时建议，后续补学以最新Kernel结果为准；建议和用户结束均不自动Mastery，不伪造Task完成或缺失成绩。`;

export function createTeachingEvolutionTools(options: LearningOverviewToolOptions = {}) {
  const result = (value: unknown) => ({content: [{type: "text" as const, text: JSON.stringify(value)}], details: {teaching: true}});
  const propose = (kind: "STRATEGY" | "CLOSURE") => defineTool({
    name: kind === "STRATEGY" ? "propose_teaching_strategy" : "suggest_goal_completion",
    label: kind === "STRATEGY" ? "提出个人教学建议" : "建议结束这一学习目标",
    description: kind === "CLOSURE" ? "建议用户结束本次学习；必须读取返回的即时closure_progress，逐阶段说明未覆盖和缺分。少量来源评分或综合题提到后续概念不证明全路线完成，结束不等于验证通过或掌握。用户可以提前结束；此工具不改变Task、Evidence、Mastery。"
      : "提出有实际评价来源的待用户决策建议；此工具不能确认、拒绝或替用户保存有效策略。补充意见后的修订须传原proposal_id和expected_revision，未确认不长期使用。",
    parameters: Type.Object({
      text: Type.String({minLength: 1, maxLength: 600, description: "准确说明适用于什么活动、以后怎么教；领域相同不代表所有任务适用，USER通用教法不要夹带单学科动作。"}), reason: Type.String({minLength: 1, maxLength: 600}),
      scope: Type.Union([Type.Literal("GOAL"), Type.Literal("SUBJECT"), Type.Literal("USER")]),
      assessment_ids: Type.Array(Type.String({minLength: 1}), {minItems: 1, maxItems: 6}),
      proposal_id: Type.Optional(Type.String({minLength: 1, description: "新建议通常省略，由运行时生成ID；修订必须用原ID。"})),
      expected_revision: Type.Optional(Type.Integer({minimum: 0, description: "新建省略或0；修订填写已读取的原建议revision（不是新版本号）。"})),
    }),
    execute: async (id, params, signal) => {
      const overview = await fetchLearningOverview(options, signal);
      const goal = overview.goal_profile as {id?: string} | null;
      if (!goal?.id) throw new Error("先建立并确认当前学习目标。");
      if (!params.proposal_id && params.expected_revision) throw new Error("修订必须绑定原建议及准确版本。");
      let expected = params.expected_revision ?? 0;
      if (params.proposal_id) {
        const identity = await teachingRequest(options, `learning/teaching?proposal_id=${encodeURIComponent(params.proposal_id)}`, undefined, signal);
        const reference = identity?.proposal_reference;
        if (!reference || reference.id !== params.proposal_id || reference.goal_id !== goal.id)
          throw new Error("建议身份暂时无法核验；保留原状态，不猜测版本或重新创建。");
        if (reference.status === "NOT_FOUND") {
          if (expected > 1) throw new Error("原建议不存在，不能把未知的高版本修订改为新建。");
          // 兼容旧模型把新建议的“首版1”误填在expected_revision；仅权威查询证明新ID时正规化。
          expected = 0;
        } else {
          if (reference.status === "DELETED" || reference.status === "UNAVAILABLE")
            throw new Error("原建议已删除或不属于当前目标，不能重新激活。");
          if (!["PENDING", "REVISION_REQUESTED"].includes(reference.status))
            throw new Error("原建议已由用户处理，不能当成新的待确认建议重新呈现。");
          if (reference.kind !== kind || !expected || expected !== reference.revision)
            throw new Error("修订必须使用原建议类型及当前准确版本；请先读取原建议。");
        }
      }
      const subject = teachingSubject(goal);
      const scope = kind === "CLOSURE" || params.scope === "SUBJECT" && !subject ? "GOAL" : params.scope;
      return result(await teachingRequest(options, "learning/teaching/proposals", {
        id: params.proposal_id ?? `proposal-${id}`, goal_id: goal.id, kind,
        text: params.text, reason: params.reason, scope,
        source_independent: kind === "STRATEGY" && scope === "USER",
        subject: scope === "SUBJECT" ? subject : "",
        assessment_ids: params.assessment_ids, expected_revision: expected, revision: expected + 1,
      }, signal));
    },
  });
  return [defineTool({
    name: "read_teaching_context", label: "读取教学安排与实际表现",
    description: "读取已确认个人策略、待修订建议及实际评价ID；assessment_id回读原评价与更正；topic_query查询当前Goal知识点与别名，EXACT可复用，POSSIBLE只提示相似。不能改变学习状态。",
    parameters: Type.Object({assessment_id: Type.Optional(Type.String({minLength: 1, maxLength: 200})), topic_query: Type.Optional(Type.String({maxLength: 160}))}),
    execute: async (_id, params, signal) => {
      if (params.assessment_id && params.topic_query !== undefined) throw new Error("精确评价和知识点查询请分别读取。");
      const path = params.assessment_id ? `learning/teaching/assessments/${encodeURIComponent(params.assessment_id)}`
        : params.topic_query !== undefined ? `learning/teaching/topics?query=${encodeURIComponent(params.topic_query)}`
        : "learning/teaching";
      return result(await teachingRequest(options, path, undefined, signal));
    },
  }), propose("STRATEGY"), propose("CLOSURE"), defineTool({
    name: "correct_answer_assessment", label: "更正这一题的评价",
    description: "先精确回读原题、原回答及原评价；仅追加有依据的局部更正，沿用原评分维度与权重，expected_revision等于已保存更正条数。不能重写原回答或Evidence。",
    parameters: Type.Object({assessment_id: Type.String(), expected_revision: Type.Integer({minimum: 0}), reason: Type.String({minLength: 1, maxLength: 600}),
      criteria: Type.Array(Type.Object({label: Type.String(), possible: Type.Integer(), earned: Type.Integer(), feedback: Type.String()}), {minItems: 1, maxItems: 5}),
      summary: Type.String(), strengths: Type.Array(Type.String(), {maxItems: 4}), gaps: Type.Array(Type.String(), {maxItems: 4})}),
    execute: async (id, params, signal) => result(await teachingRequest(options, "learning/teaching/corrections", {id: `correction-${id}`, ...params}, signal)),
  })];
}
