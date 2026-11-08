import {randomUUID} from "node:crypto";
import {defineTool} from "@earendil-works/pi-coding-agent";
import {Type} from "typebox";
import {fetchLearningOverview,type LearningOverviewToolOptions} from "./learningOverviewTool.js";
import type {TeachingSessionContext} from "./teachingSession.js";
import type {GoalOnboardingContext} from "./planning/goalOnboarding.js";
import {getAnimationArtifact,readAnimationPresentation} from "./animationCatalog.js";
import type {AnimationPresentation} from "./animationTypes.js";

export function createPresentAnimationTool(context: TeachingSessionContext, planning: GoalOnboardingContext, options: LearningOverviewToolOptions = {}, surface: "WEB" | "CLI" = "WEB") {
  return defineTool({name:"present_teaching_animation",label:"准备教学演示",
    description:"在当前Web课堂呈现已审查的短动画样例，用户点击才播放。artifact_id=factorial-3-return表示factorial(3)（n≤1返回1，否则n*factorial(n-1)）；linear-2x-plus3表示2x+3=11。必须告知精确样例，不把参数不同的题伪装成已生成。仅解释适合动画的关系，模板之外用文字或澄清。预测与暂停提问不是正式答题、Evidence、评分或Mastery。CLI、目标规划及无ACTIVE Task不可用。不生成动画代码，不修改材料、模型或学习状态。",
    parameters:Type.Object({artifact_id:Type.Union([Type.Literal("factorial-3-return"),Type.Literal("linear-2x-plus3")]),teaching_goal:Type.String({minLength:1,maxLength:250})}),
    execute:async (_id,params,signal) => {
      signal?.throwIfAborted();
      if (surface !== "WEB") throw new Error("当前界面没有教学动画播放器，请使用文字解释。");
      if (!["IDLE","INITIALIZED"].includes(planning.snapshot().status)) throw new Error("请先完成目标确认并开始学习，再呈现教学演示。");
      if (!params.teaching_goal.trim()) throw new Error("教学目标不能为空。");
      const overview=await fetchLearningOverview(options,signal);signal?.throwIfAborted();
      const goal=overview.goal_profile as {id?:string}|null,task=overview.active_task as {id?:string;status?:string;related_skill_ids?:string[]}|null;
      if (!goal?.id || !task?.id || task.status !== "ACTIVE" || !task.related_skill_ids?.length) throw new Error("教学演示需要当前已开始的学习任务。");
      const current=context.snapshot().active_skill_id,skillId=current && task.related_skill_ids.includes(current) ? current : task.related_skill_ids[0]!;
      const animation:AnimationPresentation={id:randomUUID(),sourceSessionId:context.getSessionId(),goalId:goal.id,taskId:task.id,skillId,artifact:getAnimationArtifact(params.artifact_id)};
      if (!readAnimationPresentation(animation)) throw new Error("教学演示材料校验失败。");
      return {content:[{type:"text" as const,text:JSON.stringify({status:"PRESENTED",animation,instruction:"已呈现这个固定参数样例，等待用户点击；尚未证明观看、理解或作答。继续围绕当前困惑解释，不写入学习事实。"})}],details:{animation}};
    }});
}
