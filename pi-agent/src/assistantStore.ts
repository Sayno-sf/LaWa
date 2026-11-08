import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAssistantAgent } from "./assistantAgent.js";
import {AssistantHandoffs} from "./assistantHandoff.js";
import type {SessionManager} from "@earendil-works/pi-coding-agent";
import {parseAnimationAnchor} from "./animationTypes.js";
import { assistantScopeKey, sameAssistantScope, type AssistantAgent, type AssistantAgentFactory,
  type AssistantAssistance, type AssistantClassification, type AssistantConsultation, type AssistantContext,
  type AssistantEvent, type AssistantHelpKind, type AssistantScope, type AssistantSnapshot } from "./assistantTypes.js";

const UNKNOWN = (): AssistantClassification => ({kind: "UNKNOWN", reason: "帮助归因尚未完成，不能确认独立性。", replyQuote: ""});
const NONE = (): AssistantClassification => ({kind: "NONE", reason: "没有助教回复内容交付。", replyQuote: ""});
const kinds = new Set<AssistantHelpKind>(["NONE", "CLARIFICATION", "HINT", "REFERENCE", "ANSWER", "UNKNOWN"]);
const rank: Record<AssistantHelpKind, number> = {NONE: 0, CLARIFICATION: 1, REFERENCE: 2, HINT: 3, ANSWER: 4, UNKNOWN: 5};
export interface AssistantStoreOptions {
  rootDir?: string;
  isCurrentScope?: (scope: AssistantScope) => boolean | Promise<boolean>;
  agentFactory?: AssistantAgentFactory;
  readonly?: boolean;
}
export class AssistantStoreError extends Error {
  constructor(message: string, readonly statusCode = 409) { super(message); }
}

function validScope(value: unknown): value is AssistantScope {
  if (!value || typeof value !== "object") return false;
  const s = value as AssistantScope;
  return [s.goalId,s.taskId,s.skillId,s.mainSessionId,s.branchId].every(v => typeof v === "string" && v.length > 0 && v.length <= 200)
    && [s.questionId,s.attemptId].every(v => v === null || typeof v === "string" && v.length > 0 && v.length <= 200);
}
function validRecord(value: unknown): value is AssistantConsultation {
  if (!value || typeof value !== "object") return false;
  const r = value as AssistantConsultation;
  return validScope(r.scope) && typeof r.id === "string" && typeof r.question === "string" && typeof r.reply === "string"
    && typeof r.createdAt === "string" && typeof r.userMessageId === "string" && typeof r.assistantMessageId === "string"
    && Number.isInteger(r.sequence) && r.sequence >= 0 && ["RUNNING","COMPLETED","INTERRUPTED","FAILED","DELETED"].includes(r.status)
    && ["NOT_DELIVERED","POSSIBLY_DELIVERED","CONFIRMED"].includes(r.delivery)
    && !!r.classification && kinds.has(r.classification.kind) && typeof r.classification.reason === "string"
    && typeof r.classification.replyQuote === "string" && validAnimationQuestion(r.animationQuestion,r.scope) && validFigureQuestion(r.figureQuestion);
}
function validFigureQuestion(value:AssistantContext["figureQuestion"]):boolean {
  if (value===undefined) return true;
  if (value?.anchor?.prediction!==undefined) {
    const frame=value.motion?.prediction;
    if (!frame || value.anchor.prediction!==(frame.phase==="waiting"?"waiting":frame.id)) return false;
  }
  return !!value && typeof value.alt==="string" && typeof value.caption==="string" && !!value.anchor &&
    [value.anchor.messageId,value.anchor.batchId,value.anchor.key].every(v=>typeof v==="string" && v.length>0 && v.length<=200) &&
    Number.isInteger(value.anchor.tick) && value.anchor.tick>=0 && (value.motion ?
      value.anchor.tick===value.motion.elapsedMs && value.motion.elapsedMs<=value.motion.durationMs &&
      value.motion.durationMs<=90000 && typeof value.motion.caption==="string" && Array.isArray(value.motion.changes) : value.anchor.tick<=240) && Array.isArray(value.readings) &&
    value.readings.length<=4 && value.readings.every(r=>r && typeof r.label==="string" && Number.isFinite(r.value) && typeof r.unit==="string") &&
    JSON.stringify(value).length<=10000;
}
function validAnimationQuestion(value:AssistantContext["animationQuestion"],scope:AssistantScope):boolean {
  if(value===undefined)return true;
  try{
    if(!value||typeof value!=="object"||JSON.stringify(value).length>64000)return false;
    const anchor=parseAnimationAnchor(value.anchor),c=value.context;
    return !!c&&typeof c==="object"&&typeof c.title==="string"&&typeof c.caption==="string"&&
      ["explainer","linear_balance","call_stack"].includes(c.recipe)&&c.presentationId===anchor.presentation_id&&
      c.artifactSha256===anchor.artifact_sha256&&c.sceneId===anchor.scene_id&&c.sceneElapsedMs===anchor.scene_elapsed_ms&&
      c.scope?.goalId===scope.goalId&&c.scope.taskId===scope.taskId&&c.scope.skillId===scope.skillId;
  }catch{return false;}
}
function classified(value: AssistantClassification | null | undefined, reply: string): AssistantClassification {
  // 模型归因必须引用真实已输出文本；缺失、伪造或未完成归因均不能静默变成独立。
  if (!value || !kinds.has(value.kind) || typeof value.reason!=="string" || typeof value.replyQuote!=="string"
    || !value.reason.trim() || !value.replyQuote.trim()
    || !reply.includes(value.replyQuote) || value.replyQuote.length > 2000 || value.reason.length > 1200) return UNKNOWN();
  return {kind: value.kind, reason: value.reason, replyQuote: value.replyQuote};
}
function copy<T>(value: T): T { return structuredClone(value); }

/** 助教问答是可删除的运行记录；帮助索引不向 Kernel 写 Evidence，也不保存另一套学习状态。 */
export class AssistantStore {
  readonly handoffs = new AssistantHandoffs(()=>this.persist());
  private records: AssistantConsultation[] = [];
  private storageUnknown = false;
  private storageUnreadable = false;
  private readonly file?: string;
  private active?: {scope: AssistantScope; id: string; agent?: AssistantAgent; canceled: boolean; sealed?: boolean};
  constructor(private readonly options: AssistantStoreOptions = {}) {
    if (!options.rootDir) return;
    if (!options.readonly) mkdirSync(options.rootDir, {recursive: true});
    this.file = resolve(options.rootDir, "consultations-v1.json");
    this.load(!options.readonly);
  }
  private load(recover: boolean) {
    if (!this.file) return;
    if (!existsSync(this.file)) {
      this.records=[];
      this.handoffs.load(undefined,false);
      this.storageUnknown=existsSync(resolve(this.options.rootDir!,"initialized-v1.json"));
      this.storageUnreadable=this.storageUnknown;
      return;
    }
    let value: {version?: number; records: AssistantConsultation[]; storageUnknown?: boolean};
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as {version?: number; records?: unknown[]; storageUnknown?: boolean};
      if (parsed.version !== 1 || !Array.isArray(parsed.records) || !parsed.records.every(validRecord)) throw new Error("invalid ledger");
      value = parsed as typeof value;
    } catch {
      // 损坏文件不覆盖；全局缺口必须随 Teacher 上下文公开，不能凭空证明独立。
      this.records = []; this.storageUnknown = true; this.storageUnreadable=true;
      return;
    }
    this.records = value.records;
    this.storageUnknown = value.storageUnknown === true;
    this.storageUnreadable=false;
    let changed=false;
    // 解析与恢复写入分开：有效记录的落盘失败必须直接报告，不能落入损坏分支并清空已经读出的历史。
    for (const r of this.records) {
      if (recover && r.status === "RUNNING") {
        r.status = "INTERRUPTED";
        r.completedAt = new Date().toISOString();
        r.classification = r.reply && r.delivery !== "NOT_DELIVERED" ? UNKNOWN() : NONE();
        r.sequence++;changed=true;
      }
      if (r.status !== "DELETED" && r.reply && r.delivery !== "NOT_DELIVERED") {
        const normalized=classified(r.classification,r.reply);
        if (JSON.stringify(normalized)!==JSON.stringify(r.classification)) changed=true;
        r.classification=normalized;
      }
    }
    this.handoffs.load((value as {handoffs?:unknown}).handoffs,recover);
    if (recover && changed) this.persist();
  }
  private assertWritable() {
    if (this.options.readonly) throw new AssistantStoreError("只读助教记录不能修改。",403);
    if (this.storageUnreadable) throw new AssistantStoreError("助教历史记录无法读取，原文件已保留。请恢复有效记录并重新加载服务后再使用助教；老师仍可继续答疑。",503);
  }
  private persist() {
    this.assertWritable();
    if (!this.file) return;
    try {
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({version: 1, storageUnknown: this.storageUnknown, records: this.records, handoffs:this.handoffs.data()}), {encoding: "utf8", mode: 0o600});
      renameSync(temporary, this.file);
      const marker=resolve(this.options.rootDir!,"initialized-v1.json");
      if (!existsSync(marker)) writeFileSync(marker,JSON.stringify({version:1}),{encoding:"utf8",mode:0o600});
    } catch {
      throw new AssistantStoreError("助教记录无法保存，请检查本地存储权限并重新加载服务。",503);
    }
  }
  private scoped(scope: AssistantScope) { return this.records.filter(r => assistantScopeKey(r.scope) === assistantScopeKey(scope)); }
  private revision(scope: AssistantScope) {
    return createHash("sha256").update(JSON.stringify({unknown: this.storageUnknown,
      records: this.records.filter(r => r.scope.goalId === scope.goalId && r.scope.taskId === scope.taskId)})).digest("hex");
  }
  get(scope: AssistantScope): AssistantSnapshot {
    if (this.options.readonly) this.load(false);
    if (!validScope(scope)) throw new AssistantStoreError("助教学习归属无效。", 400);
    const records = this.scoped(scope).filter(r => r.status !== "DELETED" && !r.archivedBy?.length);
    return copy({scope, sessionId: createHash("sha256").update(assistantScopeKey(scope)).digest("hex").slice(0,32),
      messages: records.flatMap(r => [
        {id: r.userMessageId, role: "user" as const, content: r.question, createdAt: r.createdAt, consultationId: r.id,...(r.animationQuestion?{animationQuestion:copy(r.animationQuestion)}:{}),...(r.figureQuestion?{figureQuestion:copy(r.figureQuestion)}:{})},
        ...(r.reply ? [{id: r.assistantMessageId, role: "assistant" as const, content: r.reply, createdAt: r.completedAt ?? r.createdAt, consultationId: r.id}] : []),
      ]), consultations: records, busy: this.active !== undefined && assistantScopeKey(this.active.scope) === assistantScopeKey(scope), revision: this.revision(scope)});
  }
  getSnapshot(scope: AssistantScope) { return this.get(scope); }
  noteMessage(sessionId:string,messageId:string) {
    const record=this.records.find(r=>r.scope.mainSessionId===sessionId&&!r.archivedBy?.length&&r.status!=="DELETED"&&(r.userMessageId===messageId||r.assistantMessageId===messageId));
    if(!record)return null;
    const user=record.userMessageId===messageId;
    return {content:user?record.question:record.reply,role:user?"user":"assistant",goalId:record.scope.goalId,skillId:record.scope.skillId};
  }
  noteConversation(sessionId:string,messageId:string){
    const record=this.records.find(r=>r.scope.mainSessionId===sessionId&&!r.archivedBy?.length&&r.status!=="DELETED"&&(r.userMessageId===messageId||r.assistantMessageId===messageId));
    return record?this.get(record.scope).messages:[];
  }
  getAssistance(scope: AssistantScope, complete = false): AssistantAssistance {
    if (this.options.readonly) this.load(false);
    if (!validScope(scope)) throw new AssistantStoreError("助教学习归属无效。", 400);
    // 同 Task 的其他主会话/分支记录也必须出现；换对话、换题号不能洗掉已经曝光的解法。
    const all = this.records.filter(r => r.scope.goalId === scope.goalId && r.scope.taskId === scope.taskId);
    const exact = all.filter(r => sameAssistantScope(r.scope, scope));
    const prior = all.filter(r => !sameAssistantScope(r.scope, scope));
    const effective = exact.filter(r => r.delivery !== "NOT_DELIVERED" || r.status === "RUNNING" || r.status === "DELETED");
    let kind: AssistantHelpKind = "NONE";
    for (const r of effective) if (rank[r.classification.kind] > rank[kind]) kind = r.classification.kind;
    if (this.storageUnknown || exact.some(r => r.status === "RUNNING") || ((scope.attemptId === null || scope.questionId === null) && effective.some(r => r.reply))) kind = "UNKNOWN";
    const limit = 40;
    const boundedExact=exact.slice(-limit),boundedPrior=prior.slice(-limit);
    const records = complete ? exact : boundedExact, priorRecords = complete ? prior : boundedPrior;
    const truncated = records.length !== exact.length || priorRecords.length !== prior.length;
    const summaryExact=exact.slice(-8),summaryPrior=prior.slice(-8);
    const summaryTruncated=summaryExact.length!==exact.length||summaryPrior.length!==prior.length;
    // 有界摘要保留原消息 ID；Teacher 可以通过 record 回读全文，摘要省略不是无帮助。
    const briefClassification=(r:AssistantConsultation)=>({kind:r.classification.kind,reason:r.classification.reason.slice(0,500),
      replyQuote:r.classification.replyQuote.slice(0,500),truncated:r.classification.reason.length>500||r.classification.replyQuote.length>500});
    const summary = JSON.stringify({kind, storage_unknown: this.storageUnknown, truncated:summaryTruncated,
      exact_total:exact.length,prior_total:prior.length,
      records: summaryExact.map(r => ({id: r.id,scope: r.scope,created_at:r.createdAt,status:r.status,delivery:r.delivery,
        classification:briefClassification(r),question:r.question.slice(0,500),question_truncated:r.question.length>500,
        reply:r.reply.slice(0,1200),reply_truncated:r.reply.length > 1200})),
      prior_records: summaryPrior.map(r => ({id:r.id,scope:r.scope,created_at:r.createdAt,status:r.status,delivery:r.delivery,
        classification:briefClassification(r),question:r.question.slice(0,300),question_truncated:r.question.length>300,
        reply:r.reply.slice(0,700),reply_truncated:r.reply.length > 700}))});
    return copy({kind, revision: this.revision(scope), summary, records, priorRecords,
      unknown: kind === "UNKNOWN" || truncated, hasHelp: effective.some(r => ["HINT","REFERENCE","ANSWER","UNKNOWN"].includes(r.classification.kind)), truncated});
  }
  getTaskAssistance(scope: AssistantScope) { return this.getAssistance(scope); }
  getTaskRecords(scope: AssistantScope, options: {offset?:number;limit?:number} = {}) {
    if (this.options.readonly) this.load(false);
    if (!validScope(scope)) throw new AssistantStoreError("助教学习归属无效。", 400);
    const all=this.records.filter(r=>r.scope.goalId===scope.goalId&&r.scope.taskId===scope.taskId);
    const offset=Math.max(0,Math.floor(options.offset??0)),limit=Math.max(1,Math.min(20,Math.floor(options.limit??5)));
    const records=all.slice(offset,offset+limit);
    return copy({records,total:all.length,nextOffset:offset+records.length<all.length ? offset+records.length : null});
  }
  getRecord(scope: AssistantScope, id: string): AssistantConsultation | null {
    if (this.options.readonly) this.load(false);
    const r = this.records.find(r => r.id === id && r.scope.goalId === scope.goalId && r.scope.taskId === scope.taskId);
    return r ? copy(r) : null;
  }
  async send(scope: AssistantScope, question: string, context: AssistantContext,
    emit: (event: AssistantEvent) => void, agentFactory?: AssistantAgentFactory): Promise<AssistantSnapshot> {
    this.assertWritable();
    if (!validScope(scope)) throw new AssistantStoreError("助教学习归属无效。", 400);
    if (!question.trim() || question.length > 20000) throw new AssistantStoreError("请填写不超过20000字的问题。", 400);
    if(!validFigureQuestion(context.figureQuestion)) throw new AssistantStoreError("插画位置无效。",400);
    if(!validAnimationQuestion(context.animationQuestion,scope))throw new AssistantStoreError("动画提问位置无效，请重新打开这一步。",400);
    if (this.active) throw new AssistantStoreError("助教正在回复，请稍候或停止当前回复。");
    const isCurrentScope = async () => {
      if (active.canceled || this.active!==active) return false;
      if (!(await this.options.isCurrentScope?.(scope) ?? true) || active.canceled || this.active!==active) return false;
      if (!(await context.isCurrentScope?.() ?? true)) return false;
      // 停止可能发生在 Kernel 回读等待中；最后再查运行令牌，不能将已经取消的排队片段交付。
      return !active.canceled && this.active===active;
    };
    const active = {scope: copy(scope), id: randomUUID(), canceled: false, sealed:false, agent: undefined as AssistantAgent | undefined};
    this.active = active;
    try {
      if (!(await isCurrentScope())) throw new AssistantStoreError("学习现场已变化，请返回当前任务再提问。");
    } catch (error) { if (this.active===active) this.active = undefined; throw error; }
    const history = this.get(scope).messages;
    const r: AssistantConsultation = {id: active.id, scope: copy(scope), userMessageId: randomUUID(), assistantMessageId: randomUUID(),
      question: question.trim(), reply: "", createdAt: new Date().toISOString(), status: "RUNNING", delivery: "NOT_DELIVERED", classification: UNKNOWN(), sequence: 0,
      ...(context.animationQuestion?{animationQuestion:copy(context.animationQuestion)}:{}),...(context.figureQuestion?{figureQuestion:copy(context.figureQuestion)}:{})};
    this.records.push(r);
    // 原问答不加 episodeId 字段：交接元数据单独保存，不改变既有帮助 fingerprint 契约。
    let agentContext=context;
    try {
      const packet=this.handoffs.join(scope,context,r.id);
      agentContext={...context,currentQuestion:packet.currentQuestion||undefined,mainMessages:packet.messages,mainContextTruncated:packet.truncated,
        questionTruncated:packet.currentQuestion.length!==(context.currentQuestion??"").length};
    } catch { /* 交接扩展不可用仍可正常答疑及保存帮助事实。 */ }
    let eventTail:Promise<void>=Promise.resolve(),eventError:unknown;
    try {
      this.persist(); emit({type:"state",state:this.get(scope)});
      const agent = await (agentFactory ?? this.options.agentFactory ?? createAssistantAgent)({scope: copy(scope), context:agentContext, history,
        isCurrentScope, onClassification: value => {
          eventTail=eventTail.then(()=>{if (!active.canceled && !active.sealed && this.active===active) r.classification=classified(value,r.reply);})
            .catch(error=>{eventError=error;active.canceled=true;void active.agent?.abort();});
        },
        onEvent: event => {
          // 每个流片段也回查作用域。CLI/其他入口可能在模型请求期间改变 Kernel，不能只在开始时核对。
          eventTail=eventTail.then(async()=>{
            if (active.canceled || this.active !== active) return;
            if (!(await isCurrentScope())) {active.canceled=true;void active.agent?.abort();return;}
            if (event.type === "assistant_delta") {
              r.reply += event.delta; r.sequence++; r.classification = UNKNOWN();
              // 先保存可能交付的原文，再推送；断线/停止不会把关键提示曝光恢复成 NONE。
              r.delivery = "POSSIBLY_DELIVERED"; this.persist();
              emit({...event,consultationId:r.id});
            } else if (event.type === "model_error") throw new AssistantStoreError("助教回复失败，已收到的内容会保留。", 502);
            else emit(event);
          }).catch(error=>{eventError=error;active.canceled=true;void active.agent?.abort();});
          return eventTail;
        }});
      active.agent = agent;
      if (!(await isCurrentScope())) { active.canceled = true; await agent.abort(); throw new AssistantStoreError("学习现场已变化，本次助教回复已停止。"); }
      await agent.prompt(question);
      await eventTail;
      if (eventError) throw eventError;
      if (r.status === "DELETED") { /* 清空正文后的未知归因墓碑不被迟到生成覆盖。 */ }
      else if (active.canceled || !(await isCurrentScope())) r.status = "INTERRUPTED";
      else {
        if (r.reply && agent.classify) {
          const classification=await agent.classify(r.reply);
          if (!active.sealed && await isCurrentScope()) r.classification = classified(classification,r.reply);
        }
        if (!(await isCurrentScope())) r.status = "INTERRUPTED";
        else r.status = "COMPLETED";
      }
    } catch {
      await eventTail;
      if (!active.sealed && r.status !== "DELETED") r.status = active.canceled ? "INTERRUPTED" : "FAILED";
      try { emit({type:"error",message:active.canceled ? "助教回复已停止，已收到的内容会保留。" : "助教回复暂时失败，已收到的内容会保留。"}); } catch { /* 断线不阻断持久化。 */ }
    } finally {
      await eventTail;
      if (!active.sealed) {r.completedAt = new Date().toISOString(); r.sequence++;}
      if (!active.sealed && r.status !== "DELETED") {
        if (!r.reply || r.delivery === "NOT_DELIVERED") r.classification = NONE();
        else if (r.status !== "COMPLETED") r.classification = UNKNOWN();
      }
      active.agent?.dispose();
      if (this.active === active) this.active = undefined;
      if (!active.sealed) {
        this.persist();
        try { emit({type:"state",state:this.get(scope)}); emit({type:"done"}); } catch { /* HTTP 已关闭；记录仍可恢复。 */ }
      }
    }
    return this.get(scope);
  }
  async stop(scope?: AssistantScope) {
    const active = this.active;
    if (!active || scope && assistantScopeKey(scope) !== assistantScopeKey(active.scope)) return;
    active.canceled = true;
    await active.agent?.abort();
  }
  materialDeleted(materialId:string):boolean {
    const active=this.active;
    if (!active?.agent?.materialDeleted?.(materialId)) return false;
    active.canceled=true;
    void active.agent.abort().catch(()=>undefined);
    return true;
  }
  /** 已校验的主教师提交调用此同步临界段；不 await 助教 abort，封存后回调不能写原记录。 */
  beginTeacherRun(sessionId:string,requestId:string|undefined,requestHash:string,scope:AssistantScope|null,manager:SessionManager) {
    const active=this.active;
    if (active?.scope.mainSessionId===sessionId) {
      active.canceled=true;active.sealed=true;this.active=undefined;
      const record=this.records.find(r=>r.id===active.id);
      if (record && record.status!=="DELETED") {
        record.status="INTERRUPTED";record.completedAt=new Date().toISOString();record.sequence++;
        record.classification=record.reply && record.delivery!=="NOT_DELIVERED" ? UNKNOWN() : NONE();
      }
      void active.agent?.abort().catch(()=>undefined);
      this.persist();
    }
    return this.handoffs.beginRun(sessionId,requestId,requestHash,scope,manager,this.records);
  }
  confirmDelivery(scope: AssistantScope, consultationId: string) {
    this.assertWritable();
    const r = this.records.find(r => r.id === consultationId && sameAssistantScope(r.scope,scope));
    if (!r || !r.reply || r.delivery === "NOT_DELIVERED") return;
    r.delivery = "CONFIRMED"; r.sequence++; this.persist();
  }
  clearSession(mainSessionId: string) {
    this.assertWritable();
    if (this.active?.scope.mainSessionId === mainSessionId) { this.active.canceled = true; void this.active.agent?.abort(); }
    for (const r of this.records.filter(r => r.scope.mainSessionId === mainSessionId)) {
      // 全文确实删除；留下无文本的归因缺口，避免删除聊天暗中认证独立。
      r.question = ""; r.reply = ""; r.status = "DELETED";
      delete r.animationQuestion;
      delete r.figureQuestion;
      r.classification = r.delivery === "NOT_DELIVERED" ? NONE() : {kind:"UNKNOWN",reason:"助教聊天已清空，原帮助依据不可回读。",replyQuote:""}; r.sequence++;
    }
    this.handoffs.lifecycle(s=>s.mainSessionId===mainSessionId,"delete");
    this.persist();
  }
  purgeGoal(goalId: string) {
    this.assertWritable();
    if (this.active?.scope.goalId === goalId) { this.active.canceled = true; void this.active.agent?.abort(); }
    this.records = this.records.filter(r => r.scope.goalId !== goalId); this.persist();
    this.handoffs.lifecycle(s=>s.goalId===goalId,"delete");
  }
  async recycle(item: {kind:"goal"|"chat"|"draft";targetId:string;sessionIds:string[];id:string}) {
    this.assertWritable();
    const matches=(r:AssistantConsultation)=>item.kind==="goal" ? r.scope.goalId===item.targetId :
      item.sessionIds.includes(r.scope.mainSessionId) || r.scope.mainSessionId===item.targetId;
    if (this.active && (item.kind==="goal" ? this.active.scope.goalId===item.targetId :
      item.sessionIds.includes(this.active.scope.mainSessionId) || this.active.scope.mainSessionId===item.targetId)) await this.stop();
    for (const r of this.records.filter(matches)) r.archivedBy=[...new Set([...(r.archivedBy??[]),item.id])];
    this.handoffs.lifecycle(s=>matches({scope:s} as AssistantConsultation),"archive",item.id);
    this.persist();
  }
  async restore(item: {id:string}) {
    this.assertWritable();
    for (const r of this.records) r.archivedBy=r.archivedBy?.filter(id=>id!==item.id);
    this.handoffs.lifecycle(()=>true,"restore",item.id);
    this.persist();
  }
  async purge(item: {kind:"goal"|"chat"|"draft";targetId:string;sessionIds:string[];id:string}) {
    this.assertWritable();
    if (item.kind==="goal") this.purgeGoal(item.targetId);
    else for (const id of new Set([...item.sessionIds,item.targetId])) this.clearSession(id);
  }
}
