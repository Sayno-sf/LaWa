import type {SessionManager} from "@earendil-works/pi-coding-agent";
import {readAnimationPresentation} from "./animationCatalog.js";
import {parseAnimationAnchor,resolveAnimationContext} from "./animationContext.js";
import {readExplainerPresentation,resolveExplainerContext} from "./explainerCatalog.js";
import type {AnimationPresentation} from "./animationTypes.js";
import type {ExplainerPresentation} from "./explainerTypes.js";
import type {AssistantAnimationQuestion,AssistantAnimationSummary,AssistantScope} from "./assistantTypes.js";

type Presentation=AnimationPresentation|ExplainerPresentation;
function scoped(p:Presentation,scope:AssistantScope):boolean {
  return p.sourceSessionId===scope.mainSessionId&&p.goalId===scope.goalId&&p.taskId===scope.taskId&&p.skillId===scope.skillId;
}
function presentations(manager:SessionManager,scope:AssistantScope):Array<{entryId:string;presentation:Presentation}> {
  return manager.getBranch().flatMap(entry=>{
    if(entry.type!=="message"||entry.message.role!=="toolResult"||entry.message.isError!==false)return [];
    const details=entry.message.details as {animation?:unknown;explainer?:unknown}|undefined;
    const presentation=entry.message.toolName==="present_teaching_animation"?readAnimationPresentation(details?.animation):
      entry.message.toolName==="present_explainer_animation"?readExplainerPresentation(details?.explainer):null;
    return presentation&&scoped(presentation,scope)?[{entryId:entry.id,presentation}]:[];
  });
}

/** 用户只交位置；服务端校验同一课堂/任务/技能及真实路径，再给助教可重放的上下文。 */
export function resolveAssistantAnimation(manager:SessionManager,scope:AssistantScope,value:unknown):AssistantAnimationQuestion {
  const anchor=parseAnimationAnchor(value),found=presentations(manager,scope).find(p=>p.entryId===anchor.source_entry_id);
  if(!found)throw new Error("这段演示不属于当前助教课堂位置，请重新打开当前动画提问。");
  const p=found.presentation,context="script" in p.artifact?resolveExplainerContext(p as ExplainerPresentation,anchor):resolveAnimationContext(p as AnimationPresentation,anchor);
  return {anchor,context};
}

/** 普通答疑也知道本任务已呈现什么；没有客户端锚点时，绝不猜正在播放的那一帧。 */
export function recentAssistantAnimations(manager:SessionManager,scope:AssistantScope):AssistantAnimationSummary[] {
  return presentations(manager,scope).slice(-3).map(({entryId,presentation:p})=>{
    if("script" in p.artifact){
      const script=p.artifact.script,nodes=Object.entries(script.nodes),stage=script.stage;
      return {presentationId:p.id,sourceEntryId:entryId,title:script.title,target:(script.subtitle??script.title).slice(0,240),recipe:"explainer",
        playback:"UNKNOWN",validation:"STRUCTURE_ONLY",elements:stage.slice(0,8).map(e=>({id:e.id,kind:e.k,text:(Array.isArray(e.t)?e.t.join(" | "):e.t??"").slice(0,100)})),
        scenes:nodes.slice(0,8).map(([id,n])=>({id,label:n.label,caption:n.ops.filter(op=>op[0]==="say").map(op=>op[1]).join(" ").slice(0,160)})),
        truncated:stage.length>8||nodes.length>8||(script.subtitle?.length??0)>240||stage.some(e=>(Array.isArray(e.t)?e.t.join(" | "):e.t??"").length>100)||nodes.some(([,n])=>n.ops.filter(op=>op[0]==="say").map(op=>op[1]).join(" ").length>160)};
    }
    const lesson=p.artifact.lesson;
    return {presentationId:p.id,sourceEntryId:entryId,title:lesson.title,target:lesson.target.slice(0,240),recipe:lesson.recipe,
      playback:"UNKNOWN",validation:"FIXED_EXAMPLE",elements:[],scenes:lesson.scenes.slice(0,8).map(s=>({id:s.id,label:s.id,caption:s.caption.slice(0,160)})),truncated:lesson.scenes.length>8||lesson.target.length>240||lesson.scenes.some(s=>s.caption.length>160)};
  });
}
