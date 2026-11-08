import { randomUUID } from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchLearningOverview, type LearningOverviewToolOptions } from "./learningOverviewTool.js";
import type { TeachingSessionContext } from "./teachingSession.js";
import type { GoalOnboardingContext } from "./planning/goalOnboarding.js";
import { readSpeechPresentation, type SpeechPresentation } from "./speechTypes.js";

export function createPresentSpeechTool(context: TeachingSessionContext, planning: GoalOnboardingContext, options: LearningOverviewToolOptions = {}) {
  return defineTool({
    name: "present_speech", label: "准备朗读示范",
    description: "在Web对话呈现短朗读组件，用户点击才合成播放，CLI用文字示范而不调用本工具。当前语音能力摘要为CONFIGURED且有教学价值时，主动提供短语言/情景示范、跟读，或技术概念的1～3句口述要点；用户明确要求也可提供短朗读。purpose=example用于示范/技术要点，repeat用于跟读，requested_reading用于明确朗读请求。文字最多600字符，用自然口语，不整段朗读代码/公式，不为每条回复配音，不重复同一示范，不向待答题泄题，尊重只看文字的偏好。配置未知/未启用不承诺播放或反复推销，不改设置、不自动开麦。成功只证明组件呈现，配置齐备不证明服务可达或已播放。展示/播放不是用户答案、Evidence、评分或Mastery；依据示范照读按真实帮助归因。转写文字只能支持表达反馈，不能评价发音质量。",
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 600 }),
      language: Type.Union([Type.Literal("en"), Type.Literal("zh"), Type.Literal("auto")]),
      purpose: Type.Union([Type.Literal("example"), Type.Literal("repeat"), Type.Literal("requested_reading")]),
    }),
    execute: async (_id, params, signal) => {
      signal?.throwIfAborted();
      const speech: SpeechPresentation = { id: randomUUID(), text: params.text.trim(), language: params.language,
        purpose: params.purpose, sourceSessionId: context.getSessionId() };
      if (!readSpeechPresentation(speech)) throw new Error("朗读文字不能为空，且不得超过 600 字符。");
      // 归属由运行时补齐；新目标草稿不继承旧 Goal/Task，展示也不授予写入权限。
      if (["IDLE", "INITIALIZED"].includes(planning.snapshot().status)) {
        const overview = await fetchLearningOverview(options, signal);
        const goalId = (overview.goal_profile as { id?: string } | null)?.id;
        const task = overview.active_task as { id?: string; status?: string; related_skill_ids?: string[] } | null;
        if (goalId) speech.goalId = goalId;
        if (task?.status === "ACTIVE" && task.id) {
          speech.taskId = task.id;
          const current = context.snapshot().active_skill_id;
          const skill = current && task.related_skill_ids?.includes(current) ? current : task.related_skill_ids?.[0];
          if (skill) speech.skillId = skill;
        }
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ status: "PRESENTED", speech,
        instruction: "朗读组件已呈现，等待用户点击播放；未合成音频，不代表用户作答或学习 Evidence。" }) }], details: { speech } };
    },
  });
}
