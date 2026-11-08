import { randomUUID } from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { fetchLearningOverview, type LearningOverviewToolOptions } from "./learningOverviewTool.js";
import type { TeachingSessionContext } from "./teachingSession.js";
import type { GoalOnboardingContext } from "./planning/goalOnboarding.js";
import {requireTeachingActivity, type ActivityTask} from "./teachingActivity.js";

const questionSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 80 }),
  prompt: Type.String({ minLength: 1, maxLength: 600 }),
  selection: Type.Union([Type.Literal("single"), Type.Literal("multiple"), Type.Literal("freeform")]),
  options: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 80 }),
    label: Type.String({ minLength: 1, maxLength: 160 }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })),
  }), { maxItems: 5 }),
});

export function createPracticeSetTool(
  context: TeachingSessionContext,
  planning: GoalOnboardingContext,
  options: LearningOverviewToolOptions = {},
) {
  return defineTool({
    name: "present_practice_set",
    label: "呈现日常练习组",
    description: "Present 2-10 daily practice questions as one component in the current ACTIVE Task/Skill. The component collects every answer and submits them together. It is formative practice, not a formal single-question CHECK: it creates no per-question contract, score, Evidence or Mastery. Use this for ordinary chapter drills or mixed practice; use ask_learner_questions(CHECK) for one deliberately assessed question. Never dump a multi-question set as plain chat text.",
    parameters: Type.Object({
      active_skill_id: Type.String({ minLength: 1 }),
      active_task_id: Type.String({ minLength: 1 }),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      instructions: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      questions: Type.Array(questionSchema, { minItems: 2, maxItems: 10 }),
    }),
    execute: async (_id, params, signal) => {
      if (!["IDLE", "INITIALIZED"].includes(planning.snapshot().status))
        throw new Error("当前正在建立目标，不能以旧任务呈现练习组。");
      const overview = await fetchLearningOverview(options, signal);
      const goalId = (overview.goal_profile as { id?: string } | null)?.id;
      const task = overview.active_task as ActivityTask | null;
      if (!goalId || task?.status !== "ACTIVE" || task.id !== params.active_task_id
          || !task.related_skill_ids?.includes(params.active_skill_id))
        throw new Error("练习组须绑定当前 Goal 的 ACTIVE Task 与关联 Skill。");
      const activity = requireTeachingActivity(task, options.teachingPreferencesRevision?.());

      const request = context.learnerQuestions.ask({
        id: randomUUID(),
        purpose: "PRACTICE_SET",
        session_id: context.getSessionId(),
        goal_id: goalId,
        task_id: task.id,
        skill_id: params.active_skill_id,
        title: params.title,
        instructions: params.instructions,
        questions: params.questions,
      });
      if (request.questions.some(question => question.options.length)) {
        context.activeRecall.noteChoiceAssistance();
      }
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "WAITING_FOR_LEARNER",
            teaching_activity: activity,
            activity_revision: task.activity_revision,
            request,
            instruction: "题卡已在服务端创建，不保证浏览器已经渲染；若用户反馈没看到先核查当前待答状态，不重复创建。按本轮需要完成讲解，再邀请学习者统一提交整组答案；若本轮只要求练习，直接邀请尝试即可。题卡不代替教学，不泄露待答题答案。题组用于日常练习，不自动评分、不写 Evidence；作答后可给整体反馈，正式单题评价仍使用 CHECK。",
          }),
        }],
        details: { requestId: request.id, questionCount: request.questions.length },
      };
    },
  });
}
