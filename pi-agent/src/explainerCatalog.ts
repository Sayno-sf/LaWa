import {createHash} from "node:crypto";
import {validateExplainerScript as validateLegacyExplainerScript} from "./explainerLegacy.js";
import {replayExplainer,validateExplainerScript} from "./explainerTypes.js";
import type {ExplainerAnchor,ExplainerArtifact,ExplainerContext,ExplainerPresentation} from "./explainerTypes.js";
export type {ExplainerContext} from "./explainerTypes.js";

export const EXPLAINER_SKILL_VERSION="2.0.0";
export const EXPLAINER_VALIDATOR_VERSION="explainer-validator-v2";
const text=(v:unknown,n:number):v is string=>typeof v==="string"&&!!v.trim()&&v.length<=n&&!/[\u0000-\u001f\ufffd]/.test(v);
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
export function canonicalExplainerJson(value:unknown):string {
  if(Array.isArray(value))return "["+value.map(canonicalExplainerJson).join(",")+"]";
  if(value&&typeof value==="object")return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+canonicalExplainerJson((value as Record<string,unknown>)[k])).join(",")+"}";
  return JSON.stringify(value);
}
export function explainerArtifactHash(value:Omit<ExplainerArtifact,"contentSha256">):string {
  return createHash("sha256").update(canonicalExplainerJson(value)).digest("hex");
}

/** 快照来自通过结构校验的JSON；哈希只防快照漂移，不代表内容语义已证明。 */
export function createExplainerArtifact(value:unknown):ExplainerArtifact {
  const {script,stats,warnings}=validateExplainerScript(value);
  const scriptHash=createHash("sha256").update(canonicalExplainerJson(script)).digest("hex");
  const snapshot:Omit<ExplainerArtifact,"contentSha256">={id:"explainer-"+scriptHash.slice(0,16),version:"2",skillVersion:EXPLAINER_SKILL_VERSION,templateVersion:"explainer-v2",validatorVersion:EXPLAINER_VALIDATOR_VERSION,script,stats,warnings};
  return {...snapshot,contentSha256:explainerArtifactHash(snapshot)};
}

/** 历史记录只信受信details中的完整快照，不从聊天正文重建，也不依赖最新样例目录。 */
export function readExplainerPresentation(value:unknown):ExplainerPresentation|null {
  try{
    if(!object(value)||JSON.stringify(value).length>72000||!exact(value,["id","sourceSessionId","goalId","taskId","skillId","artifact"]))return null;
    for(const id of [value.id,value.sourceSessionId,value.goalId,value.taskId,value.skillId])if(!text(id,200))return null;
    const a=value.artifact;
    if(!object(a)||!exact(a,["id","version","contentSha256","skillVersion","templateVersion","validatorVersion","script","stats","warnings"]))return null;
    if(!text(a.id,100)||!text(a.version,50)||!text(a.skillVersion,50)||!((a.templateVersion==="explainer-v1"&&a.validatorVersion==="explainer-validator-v1")||(a.templateVersion==="explainer-v2"&&a.validatorVersion===EXPLAINER_VALIDATOR_VERSION))||typeof a.contentSha256!=="string"||!/^[a-f0-9]{64}$/.test(a.contentSha256))return null;
    const {script,stats,warnings}=a.templateVersion==="explainer-v1"?validateLegacyExplainerScript(a.script):validateExplainerScript(a.script);
    if(canonicalExplainerJson(a.script)!==canonicalExplainerJson(script)||canonicalExplainerJson(a.stats)!==canonicalExplainerJson(stats)||canonicalExplainerJson(a.warnings)!==canonicalExplainerJson(warnings))return null;
    const {contentSha256,...snapshot}=a as unknown as ExplainerArtifact;
    if(explainerArtifactHash(snapshot)!==contentSha256)return null;
    return structuredClone(value) as unknown as ExplainerPresentation;
  }catch{return null;}
}

/** 客户端只提交定位信息；舞台前后状态由服务端重放已选择的合法分支产生。 */
export function resolveExplainerContext(value:ExplainerPresentation,anchor:ExplainerAnchor):ExplainerContext {
  const p=readExplainerPresentation(value);if(!p)throw new Error("讲解动画快照无效。");
  if(!object(anchor)||Object.keys(anchor).some(key=>!["presentation_id","source_entry_id","artifact_sha256","scene_id","scene_elapsed_ms","selected_object_id","explainer_path"].includes(key))||typeof anchor.scene_id!=="string")throw new Error("讲解动画定位不能携带自定义事实。");
  if(anchor.presentation_id!==p.id||anchor.artifact_sha256!==p.artifact.contentSha256||!text(anchor.source_entry_id,200)||anchor.selected_object_id!==null)throw new Error("讲解动画定位与快照不匹配。");
  const match=/^([A-Za-z][A-Za-z0-9_-]{0,63}):(0|[1-9][0-9]{0,2})$/.exec(anchor.scene_id);
  if(!match||!Array.isArray(anchor.explainer_path)||anchor.explainer_path.at(-1)!==match[1])throw new Error("讲解动画节点或路径无效。");
  const path=anchor.explainer_path,opIndex=Number(match[2]),replay=replayExplainer(p.artifact.script,path,opIndex,anchor.scene_elapsed_ms);
  const node=p.artifact.script.nodes[replay.nodeId]!,next=node.ops[opIndex+1]??null;
  return {recipe:"explainer",presentationId:p.id,artifactSha256:p.artifact.contentSha256,title:p.artifact.script.title,target:p.artifact.script.subtitle??p.artifact.script.title,templateVersion:p.artifact.templateVersion,skillVersion:p.artifact.skillVersion,
    sceneId:anchor.scene_id,sceneIndex:path.length-1,sceneElapsedMs:anchor.scene_elapsed_ms,sceneDurationMs:replay.durationMs,caption:replay.caption,
    why:replay.operation?`当前脚本动作：${replay.operation[0]}；仅动作结构经过校验，知识与因果解释需要据题意核对。`:node.ask?`当前暂停等待预测：${node.ask.q}`:"已到达脚本结束位置。",
    parameters:{path:[...path],node:replay.nodeId,operationIndex:opIndex},assumptions:["舞台位置与队列是教学示意，不是物理或运行时状态的测量。","结构校验不等于知识内容或学习效果已验证。",...(p.artifact.script.subtitle?[p.artifact.script.subtitle]:[])],scope:{goalId:p.goalId,taskId:p.taskId,skillId:p.skillId},
    previousState:replay.previousState,targetState:replay.targetState,transition:replay.transition,transitionProgress:replay.transitionProgress,
    verifiedStep:{structureChecked:true,semanticVerified:false,node:replay.nodeId,operation:replay.operation,ask:replay.operation===null?node.ask??null:null},nextVerifiedStep:next?{structureChecked:true,semanticVerified:false,operation:next}:null,
    observation:"此定位来自学习者暂停提问；不构成观看、正确作答、Evidence、Mastery或Task推进。"};
}
