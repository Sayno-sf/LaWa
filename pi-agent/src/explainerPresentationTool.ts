import {randomUUID} from "node:crypto";
import {defineTool} from "@earendil-works/pi-coding-agent";
import {Type} from "typebox";
import {fetchLearningOverview,type LearningOverviewToolOptions} from "./learningOverviewTool.js";
import type {TeachingSessionContext} from "./teachingSession.js";
import type {GoalOnboardingContext} from "./planning/goalOnboarding.js";
import {createExplainerArtifact,readExplainerPresentation} from "./explainerCatalog.js";
import type {ExplainerPresentation} from "./explainerTypes.js";

/** 只创建呈现快照；作用域取当前任务，播放和预测不能代替Kernel学习事实。 */
export function createPresentExplainerTool(context:TeachingSessionContext,planning:GoalOnboardingContext,options:LearningOverviewToolOptions={},surface:"WEB"|"CLI"="WEB") {
  return defineTool({name:"present_explainer_animation",label:"准备互动讲解",
    description:"为当前困惑呈现一个会暂停提问和分支的短教学动画。teaching_goal说明一个教学目标；script传完整的explainer JSON。固定原生播放器只执行白名单动作；不生成HTML/JS，不渲染视频。新题可写新脚本，结构通过不代表知识语义正确。用户点击播放。预测选择与完成不是评分、Evidence、Mastery或Task推进。CLI、目标规划和无ACTIVE Task时不可用。",
    parameters:Type.Object({teaching_goal:Type.String({minLength:1,maxLength:250}),script:Type.Unknown()}),
    execute:async (_id,params,signal)=>{
      signal?.throwIfAborted();
      if(surface!=="WEB")throw new Error("当前界面没有互动讲解播放器，请使用文字解释。");
      if(!["IDLE","INITIALIZED"].includes(planning.snapshot().status))throw new Error("请先完成目标确认并开始学习，再呈现互动讲解。");
      if(!params.teaching_goal.trim())throw new Error("教学目标不能为空。");
      const artifact=createExplainerArtifact(params.script);
      const overview=await fetchLearningOverview(options,signal);signal?.throwIfAborted();
      const goal=overview.goal_profile as {id?:string}|null,task=overview.active_task as {id?:string;status?:string;related_skill_ids?:string[]}|null;
      if(!goal?.id||!task?.id||task.status!=="ACTIVE"||!task.related_skill_ids?.length)throw new Error("互动讲解需要当前已开始的学习任务。");
      const current=context.snapshot().active_skill_id,skillId=current&&task.related_skill_ids.includes(current)?current:task.related_skill_ids[0]!;
      const explainer:ExplainerPresentation={id:randomUUID(),sourceSessionId:context.getSessionId(),goalId:goal.id,taskId:task.id,skillId,artifact};
      if(!readExplainerPresentation(explainer))throw new Error("互动讲解快照校验失败。");
      return {content:[{type:"text" as const,text:JSON.stringify({status:"PRESENTED",presentation_id:explainer.id,title:artifact.script.title,stats:artifact.stats,warnings:artifact.warnings,instruction:"已呈现互动讲解，等待用户点击。结构已校验；尚未证明知识语义、观看、理解或作答，不写学习事实。"})}],details:{explainer}};
    }});
}
