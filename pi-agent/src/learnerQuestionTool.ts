import { randomUUID } from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TeachingSessionContext } from "./teachingSession.js";
import { GoalOnboardingContext } from "./planning/goalOnboarding.js";
import { fetchLearningOverview, type LearningOverviewToolOptions } from "./learningOverviewTool.js";
import type { LearnerQuestion } from "./learnerQuestionTypes.js";
import {
  goalConfirmationSignature,
  learningStartSignature,
  planRevisionConfirmationSignature,
} from "./learnerQuestions.js";
import { validateQuestionRequest } from "./learnerQuestions.js";
import { teachingRequest } from "./teachingEvolution.js";
import { getLearningPlanRevision } from "./planning/planningTools.js";
import {requireTeachingActivity, type ActivityTask, type TeachingActivity} from "./teachingActivity.js";
import {masteryReviewRequest} from "./masteryReview.js";

export function createLearnerQuestionTool(context: TeachingSessionContext, planning: GoalOnboardingContext, options: LearningOverviewToolOptions = {}) {
  return defineTool({
    name: "ask_learner_questions", label: "询问学习者",
    description: "呈现必要询问或用户决策。BACKGROUND 只问影响路线的缺失背景/偏好，1～5题，Web逐题填写后统一发送。CHECK 绑定当前 ACTIVE Task/Skill，一次一道，用于需要逐题评价契约的形成性诊断；日常多题必须使用 present_practice_set，不能把整组题塞进一个 CHECK。CONFIRM_GOAL 在 READY_FOR_CONFIRMATION 后使用；START_LEARNING 询问当前Goal/Skill的必要开始授权；CONFIRM_PLAN_REVISION 绑定已持久化的完整计划修订候选，必须传plan_revision_id并显示服务端summary。确认/开始/修订均不填questions，由运行时生成固定动作；补充意味着先处理调整。确认动作不是知识提示或Evidence。呈现询问不能同响应教学写入。教学题卡不能替代必要讲解和反馈；完成后等待实际回答或决定，不代选、不写Evidence。",
    parameters: Type.Object({
      purpose: Type.Union([Type.Literal("BACKGROUND"), Type.Literal("CHECK"), Type.Literal("CONFIRM_GOAL"), Type.Literal("START_LEARNING"), Type.Literal("CONFIRM_PLAN_REVISION"), Type.Literal("CONFIRM_MASTERY")],
        {description: "CONFIRM_MASTERY在当前知识点可收尾、进入下一节前使用；先保存已有Evidence，不填questions，由运行时提供确认掌握/欠缺/跳过确认三个动作，等待真实用户选择。"}),
      active_skill_id: Type.Optional(Type.String({ minLength: 1 })),
      active_task_id: Type.Optional(Type.String({ minLength: 1 })),
      plan_revision_id: Type.Optional(Type.String({minLength: 1, maxLength: 200})),
      review_topic_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      assessment_criteria: Type.Optional(Type.Array(Type.Object({label: Type.String({minLength: 1, maxLength: 100}), possible: Type.Integer({minimum: 1, maximum: 10})}), {minItems: 1, maxItems: 5})),
      questions: Type.Optional(Type.Array(Type.Object({
        id: Type.String({ minLength: 1, maxLength: 80 }),
        prompt: Type.String({ minLength: 1, maxLength: 600, description: "给学习者的题面，可用Markdown代码块和列表。明确要求的任务与输出，不含参考答案、解题要点或评分答案；评分维度单独放assessment_criteria。" }),
        selection: Type.Union([Type.Literal("single"), Type.Literal("multiple"), Type.Literal("freeform")]),
        options: Type.Array(Type.Object({
          id: Type.String({ minLength: 1, maxLength: 80 }), label: Type.String({ minLength: 1, maxLength: 160 }),
          description: Type.Optional(Type.String({ maxLength: 400 })),
        }), { minItems: 0, maxItems: 5 }),
      }), { minItems: 1, maxItems: 5 })),
    }),
    execute: async (_id, params, signal) => {
      if (params.purpose === "CONFIRM_MASTERY") {
        if (context.learnerQuestions.snapshot().last_answer?.request.purpose === "CONFIRM_MASTERY")
          throw new Error("本轮已经收到收尾决定，先处理用户选择或欠缺，不重复催促确认掌握。");
        if (!["IDLE", "INITIALIZED"].includes(planning.snapshot().status)) throw new Error("先完成当前目标确认与规划，再进行知识点收尾。");
        const overview = await fetchLearningOverview(options, signal);
        const request = masteryReviewRequest(overview, context.getSessionId());
        if (!request || (params.active_skill_id && params.active_skill_id !== request.skill_id) ||
            (params.active_task_id && params.active_task_id !== request.task_id)) throw new Error("收尾自评须对应当前正在学习的知识点与任务。");
        if (context.snapshot().active_task_id === request.task_id && context.snapshot().candidate_evidence)
          throw new Error("先保存已经形成的真实Evidence候选，再呈现收尾自评；不能把之后的自评决定当作该表现。");
        if (params.questions || params.assessment_criteria || params.plan_revision_id || params.review_topic_id)
          throw new Error("收尾自评使用固定用户动作，不接受自造选项、题目或评分要求。");
        context.learnerQuestions.ask(request);
        return {content: [{type: "text" as const, text: JSON.stringify({status: "WAITING_FOR_LEARNER", request,
          instruction: "收尾卡片已呈现。等待真实用户选择，不代为确认掌握，不完成或切换Task；用户可以说明欠缺或跳过确认继续。"})}],
          details: {requestId: request.id, questionCount: 1}, terminate: true};
      }
      const onboarding = planning.snapshot();
      let goalId: string | null = null;
      let skillId: string | null = null;
      let taskId: string | null = null;
      let scopeSignature: string | undefined;
      let planRevisionBase: number | undefined;
      let reviewSkillId: string | undefined;
      let activity: TeachingActivity | undefined;
      let activityRevision: number | undefined;
      if (params.review_topic_id && params.purpose !== "CHECK") throw new Error("穿插复测只适用于CHECK教学题目。");
      let questions = params.questions as LearnerQuestion[] | undefined;
      if (params.purpose === "BACKGROUND") {
        if (!["NEEDS_CLARIFICATION", "READY_FOR_CONFIRMATION"].includes(onboarding.status) &&
            !(onboarding.status === "CONFIRMED" && onboarding.reading_requirement))
          throw new Error("基础询问只用于正在建立的目标，先登记需要澄清的目标理解。");
      } else if (params.purpose === "CONFIRM_GOAL") {
        // 模型只选择用途；固定动作及草案绑定由运行时提供，不能自造已同意的选项或复用旧草案。
        if (onboarding.status !== "READY_FOR_CONFIRMATION" || !onboarding.pending_profile) throw new Error("先记录待独立确认的目标理解，再呈现确认按钮。");
        goalId = onboarding.pending_profile.id;
        scopeSignature = goalConfirmationSignature(onboarding.pending_profile, onboarding.reading_requirement?.id);
        const sources = onboarding.reading_requirement?.materials ?? [];
        const names = sources.slice(0, 3).map(source => source.name.slice(0, 60)).join("、");
        questions = [{ id: "confirm-goal", prompt: "这个学习目标和刚才的理解符合你的想法吗？"
          + (onboarding.pending_profile.learning_domain ? `学习领域：${onboarding.pending_profile.learning_domain}。` : "")
          + (sources.length ? `主要依据：${names}${sources.length > 3 ? `等${sources.length}份资料` : ""}。` : ""),
          selection: "single", options: [{ id: "proceed", label: "确认" }] }];
      } else if (params.purpose === "START_LEARNING") {
        // 开始请求重新读取 Kernel，绑定现场后才展示；工具成功仅表示等待用户，不会启动 Task。
        if (!["IDLE", "INITIALIZED"].includes(onboarding.status)) throw new Error("先独立确认并初始化目标，再询问是否开始学习。");
        const overview = await fetchLearningOverview(options, signal);
        goalId = (overview.goal_profile as { id?: string } | null)?.id ?? null;
        const task = overview.active_task as { id?: string; related_skill_ids?: string[] } | null;
        const frontier = overview.current_frontier as { focus_skill_id?: string; supporting_skill_ids?: string[] } | null;
        skillId = params.active_skill_id ?? task?.related_skill_ids?.[0] ?? frontier?.focus_skill_id ?? null;
        const allowed = task?.related_skill_ids ?? [frontier?.focus_skill_id, ...(frontier?.supporting_skill_ids ?? [])];
        if (!goalId || !skillId || !allowed.includes(skillId)) throw new Error("开始按钮须对应当前 Goal 的任务或近期 Skill。");
        taskId = task?.id ?? null;
        if (params.active_task_id && params.active_task_id !== taskId) throw new Error("开始按钮的 Task 已变化。");
        scopeSignature = learningStartSignature(overview);
        const skill = overview.skills.find(value => (value as { id?: string }).id === skillId) as { name?: string } | undefined;
        questions = [{ id: "start-learning", prompt: `准备好开始${skill?.name ? `「${skill.name.slice(0, 160)}」` : "这一段学习"}了吗？`, selection: "single", options: [{ id: "proceed", label: "开始学习" }] }];
      } else if (params.purpose === "CONFIRM_PLAN_REVISION") {
        if (!["IDLE", "INITIALIZED"].includes(onboarding.status))
          throw new Error("先完成当前目标建立流程，再确认已有计划的修订。");
        if (!params.plan_revision_id) throw new Error("计划修订确认缺少候选 ID。");
        const revision = await getLearningPlanRevision(params.plan_revision_id, options, signal);
        if (revision.status !== "PENDING") throw new Error("该计划修订候选已失效，请重新读取当前路线。");
        const overview = await fetchLearningOverview(options, signal);
        const currentGoalId = (overview.goal_profile as {id?: string} | null)?.id;
        if (revision.goal_id !== currentGoalId || revision.base_revision !== (overview.plan_revision ?? 0))
          throw new Error("当前学习目标或计划版本已经变化，请重新提出修订。");
        goalId = revision.goal_id;
        planRevisionBase = revision.base_revision;
        scopeSignature = planRevisionConfirmationSignature(revision);
        questions = [{
          id: "confirm-plan-revision",
          prompt: `学习计划需要按以下修订调整：${revision.summary.split("\n").sort((a, b) => Number(b.includes("学习领域：")) - Number(a.includes("学习领域："))).join("\n").slice(0, 420)}\n原因：${revision.reason.slice(0, 150)}`,
          selection: "single",
          options: [{id: "proceed", label: "确认修订"}, {id: "reject", label: "暂不修订"}],
        }];
      } else {
        if (!["IDLE", "INITIALIZED"].includes(onboarding.status)) throw new Error("当前正在建立目标，不能以旧任务进行教学检查。");
        if (questions?.length !== 1) throw new Error("教学检查一次只展示当前一道题。");
        const overview = await fetchLearningOverview(options, signal);
        goalId = (overview.goal_profile as { id?: string } | null)?.id ?? null;
        // CHECK 每次重新读取 Kernel。浏览器缓存或老师填入的 ID 都不授予旧任务教学权限。
        const task = overview.active_task as ActivityTask | null;
        if (!goalId || !params.active_skill_id || task?.status !== "ACTIVE" || task?.id !== params.active_task_id || !task?.related_skill_ids?.includes(params.active_skill_id)) throw new Error("题目须绑定当前目标的 ACTIVE Task 与关联 Skill。");
        const recall = context.activeRecall.snapshot();
        if (recall && (recall.status !== "ACTIVE" || recall.current_question !== questions[0]!.prompt)) throw new Error("章节检查的选择题须对应正在等待回答的当前题目。");
        taskId = params.active_task_id!;
        skillId = params.active_skill_id!;
        activity = requireTeachingActivity(task, options.teachingPreferencesRevision?.());
        activityRevision = task!.activity_revision;
        if (params.review_topic_id) {
          const reply = await (options.fetchImpl ?? fetch)(`${(options.baseUrl ?? "http://127.0.0.1:8000").replace(/\/$/, "")}/api/learning/answer-assessments/topics/${encodeURIComponent(params.review_topic_id)}?goal_id=${encodeURIComponent(goalId)}`,
            {signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000)});
          if (!reply.ok) throw new Error("复测知识点不属于当前Goal或已经不可用。");
          const topic = await reply.json() as {skill_id?: string; goal_id?: string; topic_id?: string};
          if (topic.goal_id !== goalId || topic.topic_id !== params.review_topic_id || typeof topic.skill_id !== "string") throw new Error("复测知识点归属无效。");
          reviewSkillId = topic.skill_id;
        }
      }
      if (!questions?.length) throw new Error("基础/教学询问须提供真实问题及选项。");
      let contractId: string | undefined;
      if (params.purpose === "CHECK") {
        if (context.learnerQuestions.snapshot().pending) throw new Error("先等待当前练习的实际回答。");
        const criteria = params.assessment_criteria ?? (activity?.evaluation_focus.length === 1 && !params.review_topic_id
          ? [{label: activity.evaluation_focus[0]!, possible: 10}] : undefined);
        if (!criteria) throw new Error("请给出本题明确评分维度及10分权重；普通CHECK的标签取当前任务evaluation_focus的相关子集。");
        if (!params.review_topic_id && criteria.some(c => !activity!.evaluation_focus.includes(c.label)))
          throw new Error("本题评分维度须来自已安排活动的evaluation_focus；如需改变要求，先调整活动，再在下一次工具调用出题。");
        if (criteria.reduce((sum, c) => sum + c.possible, 0) !== 10 || new Set(criteria.map(c => c.label)).size !== criteria.length) throw new Error("评分要求须互不重复且合计10分。");
        // 题面与评分契约分别传递：评分点可能包含正确结果，不能拼入待答题。
        if (questions.some(q => /(?:^|\n)本题检查：/u.test(q.prompt)))
          throw new Error("题面只写任务与作答要求；请把评分标准和参考结果放在assessment_criteria，不要追加本题检查。");
        validateQuestionRequest({id: "validate", purpose: "CHECK", session_id: context.getSessionId(), goal_id: goalId, task_id: taskId, skill_id: skillId, questions});
        contractId = `question-${randomUUID()}`;
        const saved = await teachingRequest(options, "learning/question-contracts", {id: contractId, goal_id: goalId,
          task_id: taskId, skill_id: reviewSkillId ?? skillId, ...(params.review_topic_id ? {review_topic_id: params.review_topic_id} : {}), session_id: context.getSessionId(), question: questions[0]!.prompt,
          criteria: criteria.map(c => [c.label, c.possible]), activity_revision: activityRevision}, signal);
        if (saved.id !== contractId) throw new Error("出题要求未能确认保存，请重新出题。");
      }
      const request = context.learnerQuestions.ask({
        id: randomUUID(), purpose: params.purpose, session_id: context.getSessionId(), goal_id: goalId,
        task_id: taskId, skill_id: skillId, ...(scopeSignature ? { scope_signature: scopeSignature } : {}), questions,
        ...(params.purpose === "CONFIRM_PLAN_REVISION" ? {
          plan_revision_id: params.plan_revision_id,
          plan_revision_base: planRevisionBase,
        } : {}),
        ...(reviewSkillId ? {review_topic_id: params.review_topic_id, review_skill_id: reviewSkillId} : {}),
        ...(contractId ? {assessment_contract_id: contractId} : {}),
      });
      if (params.purpose === "CHECK" && questions.some(q => q.options.length > 0)) context.activeRecall.noteChoiceAssistance();
      return { content: [{ type: "text" as const, text: JSON.stringify({ status: "WAITING_FOR_LEARNER", request, instruction: "等待用户实际回答；确认/开始只是用户意图，基础自述不是 Evidence，选项检查不等于独立解释或 Mastery。" }) }],
        details: { requestId: request.id, questionCount: request.questions.length },
        ...(["BACKGROUND", "START_LEARNING"].includes(params.purpose) ? {terminate: true} : {}) };
    },
  });
}
