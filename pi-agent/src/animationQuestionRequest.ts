import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import type {SessionManager, SessionEntry} from "@earendil-works/pi-coding-agent";
import type {AnimationAnchor} from "./animationTypes.js";
import type {AnimationContext} from "./animationContext.js";
import type {ExplainerContext} from "./explainerCatalog.js";
import {LEARNING_SKILL_TOOL_NAMES} from "./learningSkills.js";

export const ANIMATION_REQUEST_ENTRY = "lawa.animation-question-request";
export type AnimationRequestStatus = "PREPARED" | "ATTACHED" | "STARTED" | "COMPLETED" | "FAILED" | "INTERRUPTED" | "UNKNOWN";
export interface AnimationQuestionInput { sourceUserEntryId: string; context: AnimationContext | ExplainerContext; question: string; skillId: string }
export interface AnimationRequest {
  version: 1; requestId: string; hash: string; sessionId: string; goalId: string; taskId: string; skillId: string;
  anchor: AnimationAnchor; question: string; title: string; status: AnimationRequestStatus;
  sourceUserEntryId?: string; retryOf?: string;
}
export interface AnimationRequestView {
  request_id: string; status: AnimationRequestStatus; source_user_entry_id?: string;
  anchor: AnimationAnchor; question: string; title: string;
}

// SDK先写内存再持久化；只把当前分支且已读回的entry当成提交成功。
export function assertAnimationPersisted(manager: SessionManager, entries: SessionEntry[]): void {
  const file=manager.getSessionFile();if(!file)return;
  const saved=new Map(readFileSync(file,"utf8").split(/\r?\n/).filter(Boolean).map(line=>{const row=JSON.parse(line);return [row.id,JSON.stringify(row)];}));
  if(entries.some(entry=>saved.get(entry.id)!==JSON.stringify(entry)))throw new Error("动画提问未能确认保存，请检查本地存储。");
}
export function saveAnimationRequest(manager: SessionManager, value: AnimationRequest): void {
  const leaf=manager.getLeafId();
  try {
    const id=manager.appendCustomEntry(ANIMATION_REQUEST_ENTRY,structuredClone(value));
    const row=manager.getBranch().find(entry=>entry.id===id);if(!row)throw new Error("动画提问回执不可读。");
    assertAnimationPersisted(manager,[row]);
  } catch(error) {if(leaf)manager.branch(leaf);else manager.resetLeaf();throw error;}
}
export function animationRequests(manager: SessionManager): AnimationRequest[] {
  const byId=new Map<string,AnimationRequest>();
  for(const row of manager.getBranch())if(row.type==="custom"&&row.customType===ANIMATION_REQUEST_ENTRY){
    const value=row.data as AnimationRequest|null;
    if(value?.version===1&&value.sessionId===manager.getSessionId()&&typeof value.requestId==="string"&&typeof value.hash==="string"&&
      ["PREPARED","ATTACHED","STARTED","COMPLETED","FAILED","INTERRUPTED","UNKNOWN"].includes(value.status))byId.set(value.requestId,structuredClone(value));
  }
  return [...byId.values()];
}
export function animationRequestHash(question: string, anchor: AnimationAnchor, retryOf?: string): string {
  return createHash("sha256").update(JSON.stringify({question,anchor,retryOf:retryOf??null})).digest("hex");
}
export function animationRequestView(value: AnimationRequest, running: boolean): AnimationRequestView {
  return {request_id:value.requestId,status:value.status==="STARTED"&&!running?"UNKNOWN":value.status,
    source_user_entry_id:value.sourceUserEntryId,anchor:structuredClone(value.anchor),question:value.question,title:value.title};
}

// 材料与题目均是有出处的数据；解释模式的权限只来自下面白名单，不来自提示词中的自称。
export const ANIMATION_READ_TOOLS = ["get_learning_overview","get_skill_learning_context","list_learning_materials",
  "read_learning_material","search_learning_material","read_learning_document","list_learning_visuals","read_learning_visual",
  "search_learning_sources","read_learning_source",...LEARNING_SKILL_TOOL_NAMES];
export function animationQuestionToolGuard(name: string,args: Record<string,unknown>,skillId: string): string|null {
  if(!ANIMATION_READ_TOOLS.includes(name))return "当前是动画解释回合，只能解释当前位置并只读查阅，不评分、出题、写证据或推进学习。";
  if(args.scope!==undefined&&args.scope!=="current")return "动画答疑只读取当前目标的资料。";
  if(["goal_id","goalId","draft_session_id","session_id","mainSessionId","task_id"].some(key=>key in args))return "动画答疑的归属由当前课堂绑定。";
  if(name==="get_skill_learning_context"&&args.skill_id!==skillId)return "动画答疑只读取当前知识点。";
  return null;
}
