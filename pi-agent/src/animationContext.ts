import {readAnimationPresentation} from "./animationCatalog.js";
import {animationTransitionProgress,parseAnimationAnchor,type AnimationAnchor,type AnimationPresentation,type AnimationQuestionContext,type AnimationScene,type CallStackState,type LinearBalanceState} from "./animationTypes.js";

export {parseAnimationAnchor} from "./animationTypes.js";
export type AnimationContext = AnimationQuestionContext;

// 把已核验的相邻状态转换成明确操作，减少教师从图形类比自行补造调用/算式。
function verifiedStep(scene:AnimationScene,previous:AnimationScene|undefined):Record<string,unknown>{
  if("equation" in scene.state){const state=scene.state as LinearBalanceState;return {kind:state.operation,operand:state.operand,beforeEquation:previous?.state&&"equation" in previous.state?previous.state.equation:state.equation,afterEquation:state.equation};}
  const state=scene.state as CallStackState,old=previous?.state as CallStackState|undefined;
  if(state.phase==="call")return {kind:"call",currentCall:state.frames.at(-1),frames:state.frames};
  if(state.phase==="base")return {kind:"base",currentCall:state.frames.at(-1),returnValue:state.return_value,frameRemoved:false,frames:state.frames};
  return {kind:state.phase,returningCall:old?.frames.at(-1),receivingCall:state.phase==="done"?"external":state.frames.at(-1),
    transferredValue:old?.return_value,receiverResult:state.return_value,remainingFrames:state.frames};
}

/** 客户端只报告位置；讲解事实由已验证材料快照重新取得。 */
export function resolveAnimationContext(presentation: AnimationPresentation, value: unknown): AnimationContext {
  const trusted=readAnimationPresentation(presentation); if (!trusted) throw new Error("这段演示材料已经失效。");
  const anchor:AnimationAnchor=parseAnimationAnchor(value);
  if(anchor.explainer_path!==undefined)throw new Error("原教学样例不接受解释动画分支路径。");
  if (anchor.presentation_id !== trusted.id || anchor.artifact_sha256 !== trusted.artifact.contentSha256) throw new Error("动画引用与原材料不一致。");
  const lesson=trusted.artifact.lesson,index=lesson.scenes.findIndex(scene => scene.id === anchor.scene_id),scene=lesson.scenes[index];
  if (!scene || anchor.scene_elapsed_ms > scene.duration_s*1000) throw new Error("动画位置不在有效范围内。");
  const transition=index>0 && anchor.scene_elapsed_ms<2000;
  return {presentationId:trusted.id,artifactSha256:trusted.artifact.contentSha256,title:lesson.title,target:lesson.target,recipe:lesson.recipe,
    templateVersion:trusted.artifact.templateVersion,skillVersion:trusted.artifact.skillVersion,sceneId:scene.id,sceneIndex:index,
    sceneElapsedMs:anchor.scene_elapsed_ms,sceneDurationMs:scene.duration_s*1000,caption:scene.caption,why:scene.why,
    parameters:structuredClone(lesson.parameters),assumptions:[...lesson.assumptions],scope:{goalId:trusted.goalId,taskId:trusted.taskId,skillId:trusted.skillId},
    previousState:index>0 ? structuredClone(lesson.scenes[index-1]!.state) : null,targetState:structuredClone(scene.state),
    transition,transitionProgress:animationTransitionProgress(index,anchor.scene_elapsed_ms),
    verifiedStep:verifiedStep(scene,lesson.scenes[index-1]),nextVerifiedStep:lesson.scenes[index+1]?verifiedStep(lesson.scenes[index+1]!,scene):null,
    observation:transition ? "客户端报告处于前一状态到目标状态的过渡；目标状态还未完全出现。没有截图，不能声称看见像素。" : "客户端报告当前为稳定场景；位置不证明用户已经观看或理解。没有截图。"};
}
