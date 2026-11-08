import {defineTool} from "@earendil-works/pi-coding-agent";
import {Type, type Static} from "typebox";
import {fetchLearningOverview, type LearningOverview} from "./learningOverviewTool.js";
import {teachingRequest} from "./teachingEvolution.js";
import type {LearningToolHttpOptions} from "./learningWriteTools.js";
import type {TeachingSessionContext} from "./teachingSession.js";

// 方法描述与工具参数放在同一处；领域只限定来源/策略范围，不选择固定老师。
export const TEACHING_METHODS = {
  COMPARE: {name: "比较辨认", activity: "比较正例、反例或易混案例，再判断一个新例子", observe: "关键区别与适用条件；选择正确不等于能独立解释"},
  RECALL: {name: "提取回忆", activity: "按用途回忆、概括或重建关键关系，再换提问方式", observe: "准确性、关联与遗漏；即时记住不证明长期保持"},
  APPLY: {name: "操作应用", activity: "根据示范完成小操作、预测改动、修改作品或诊断失败", observe: "实际输出及关键过程；AI代做、用户解释和真实操作分开"},
  DIALOGUE: {name: "情境表达", activity: "围绕真实目的对话或表达，再改变一个条件", observe: "是否达成交流目的；文字和转写不证明发音或实时流利度"},
  REASON: {name: "材料论证", activity: "比较资料、解释机制、提出判断并说明依据或反例", observe: "事实、观点、推断和依据；允许有支持的不同结论"},
} as const;

export const TeachingActivitySchema = Type.Object({
  method: Type.Union([Type.Literal("COMPARE"), Type.Literal("RECALL"), Type.Literal("APPLY"), Type.Literal("DIALOGUE"), Type.Literal("REASON")]),
  purpose: Type.String({minLength: 1, maxLength: 300, description: "本任务服务用户用途的具体能力，不扩大原学习目标。"}),
  learner_action: Type.String({minLength: 1, maxLength: 500, description: "让学习者实际做什么。不是强制步骤；尊重跳过、提问和直接讲解。"}),
  observable_output: Type.String({minLength: 1, maxLength: 300, description: "根据本次可接收的文字、图像或作品，实际能观察什么。"}),
  evaluation_focus: Type.Array(Type.String({minLength: 1, maxLength: 100}), {minItems: 1, maxItems: 5, uniqueItems: true, description: "任务评价关注点；新CHECK从这些准确标签中取所需维度，合计10分，不要求每题全部覆盖。"}),
  observation_limits: Type.String({minLength: 1, maxLength: 400, description: "未观察到什么、不能据此证明什么。转写不证明发音，老师代做不证明用户会做。"}),
});
export type TeachingActivity = Static<typeof TeachingActivitySchema> & {teaching_preferences_revision?: string | null};
export interface ActivityTask {id?: string; status?: string; related_skill_ids?: string[]; teaching_activity?: TeachingActivity | null; activity_revision?: number}

export function requireTeachingActivity(task: ActivityTask | null | undefined, preferenceRevision?: string): TeachingActivity {
  if (!task?.teaching_activity || !Number.isInteger(task.activity_revision) || Number(task.activity_revision) < 1)
    throw new Error("先用 configure_teaching_activity 为当前任务安排具体活动、可观察输出与评价边界，再出新题；旧题按原标准批改。");
  if (preferenceRevision && task.teaching_activity.teaching_preferences_revision !== preferenceRevision)
    throw new Error("个人教学偏好已经变化，先重新安排当前任务活动；不能沿用旧活动要求或改变已出题的评分契约。");
  return task.teaching_activity;
}

export const TASK_TEACHING_POLICY = `
任务教法：按当前任务要完成的用途、用户实际表现和可接收的作品选择活动，不按学科名称固定老师。
新建Task填写teaching_activity；旧任务缺活动或当前方法不合适时，用configure_teaching_activity调整原Task，不重复建任务。方法目录是可组合的选择，不是依次闯关；同一任务需要时可切换。先处理已提交旧题，再换活动或出新题。
CHECK的评分标签取活动evaluation_focus中与本题相关的子集，具体题面要清楚说明任务；检查原知识点的穿插复测可用该点专属维度。批改始终使用出题时的契约，不能把后来活动要求追加给旧回答。
活动是当前任务的工作安排，不是已确认的长期偏好或能力证据；用户明确要讲解/跳过/换方式时及时调整，不因少一项活动或低分卡住进度。实践、表达和论证可自然对话，不必都变成选择题；形成性题组沿用原独立通道。
新领域使用可组合方法和可靠资料；只评价实际收到的输出。当前语音输入为转写文字，不具备据此评价发音的证据。涉及实物操作时只说明可见部分，不能把自述当实操已验证。`;

export function teachingActivityPrompt(overview: LearningOverview | undefined, preferenceRevision?: string): string {
  const task = overview?.active_task as ActivityTask | null | undefined;
  // 逐次读取真实Task；同run工具成功后可以换活动，但旧题的公开契约始终独立保存。
  const status = task?.teaching_activity
    ? preferenceRevision && task.teaching_activity.teaching_preferences_revision !== preferenceRevision ? "NEEDS_REPLAN" : "READY"
    : "UNPLANNED";
  const data = task ? {task_id: task.id, activity_revision: task.activity_revision ?? 0, status,
    ...(status === "READY" ? {activity: task.teaching_activity} : {})} : {status: "NO_ACTIVE_TASK"};
  return `\n\n当前任务活动（只读安排，不是学习表现）：${JSON.stringify(data)}\n可选方法：${JSON.stringify(TEACHING_METHODS)}`;
}

export function createConfigureTeachingActivityTool(context: TeachingSessionContext, options: LearningToolHttpOptions = {}) {
  return defineTool({
    name: "configure_teaching_activity", label: "安排当前任务的教学活动",
    description: "为当前Goal的已有TODO/ACTIVE Task设置或调整教学活动，不改变任务状态、路线、评分或掌握。先读overview获取task_id与activity_revision；此工具成功后再出题，不与出题或评分同一组调用。旧题保持原标准。",
    parameters: Type.Object({task_id: Type.String({minLength: 1}), expected_revision: Type.Integer({minimum: 0}), teaching_activity: TeachingActivitySchema}),
    execute: async (_id, params, signal) => {
      const blocked = context.learnerQuestions.writeGuard("configure_teaching_activity");
      if (blocked) throw new Error(blocked.reason);
      const overview = await fetchLearningOverview(options, signal);
      const goalId = (overview.goal_profile as {id?: string} | null)?.id;
      if (!goalId) throw new Error("先确认当前学习目标。");
      const value = await teachingRequest(options, `learning/tasks/${encodeURIComponent(params.task_id)}/teaching-activity`, {
        expected_goal_id: goalId, expected_revision: params.expected_revision,
        teaching_activity: {...params.teaching_activity, teaching_preferences_revision: options.teachingPreferencesRevision?.() ?? null},
      }, signal);
      return {content: [{type: "text" as const, text: JSON.stringify(value)}], details: {taskId: params.task_id, teachingActivity: true}};
    },
  });
}
