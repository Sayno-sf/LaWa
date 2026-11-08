import {mergeFigures,type PlacedFigure} from "../lessonFigureTypes.js";
import {learnerTeachingSnapshot, learnerOverview} from "../learnerQuestionPresentation.js";
import {FIGURE_TOOL,placedFigures,readFigureBatch,referencedFigures,resolveFigureQuestion} from "../lessonFigures.js";
import {ExcerptNotes, ExcerptError, type NoteSource, type ResolvedNoteSource} from "./excerptNotes.js";
import {projectConversationAttachments, type ConversationAttachment} from "../conversationAttachments.js";
import {routePathKey, readRouteState, saveRouteState, branchHandoff, routeMessageIds, ROUTE_TRANSITION} from "./routePathState.js";
import type {RouteBranchCommand, LearningBranch} from "../learningBranchTypes.js";
import type {MaterialReadingRuntime} from "../materialReadingRuntime.js";
import { createHash, randomUUID } from "node:crypto";
import {readAnswerAssessment, type AnswerAssessment} from "../answerAssessmentTypes.js";
import { studyScope, type StudyScope } from "../studyTimeTypes.js";
import { resolve } from "node:path";
import { AssistantStore } from "../assistantStore.js";
import {recentAssistantAnimations,resolveAssistantAnimation} from "../assistantAnimationContext.js";
import {branchSource, type HandoffSummarizer, type TeacherRunStatus, type HelpEpisode} from "../assistantHandoff.js";
import {currentFeedbackRecovery, saveFeedbackRecovery, clearFeedbackRecovery, type FeedbackRecovery} from "./feedbackRecovery.js";
import {readAnimationPresentation} from "../animationCatalog.js";
import {readExplainerPresentation,resolveExplainerContext} from "../explainerCatalog.js";
import type {ExplainerComponent,ExplainerPresentation} from "../explainerTypes.js";
import {parseAnimationAnchor,resolveAnimationContext} from "../animationContext.js";
import type {AnimationComponent,AnimationPresentation} from "../animationTypes.js";
import {animationRequests,animationRequestHash,animationRequestView,saveAnimationRequest,assertAnimationPersisted,
  type AnimationRequest,type AnimationRequestView} from "../animationQuestionRequest.js";
import type { AssistantAgentFactory, AssistantContext, AssistantScope, AssistantSnapshot } from "../assistantTypes.js";
import { projectLearningContext } from "../modelLearningContext.js";
import { GoalRecycle, type RecycleItem } from "./goalRecycle.js";

import type { Api, Model } from "@earendil-works/pi-ai";
import {loadTeachingImageBatch,parseImageMaterialIds,type TeachingImageSource} from "../teachingImages.js";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  createLearningAgentSession,
  type LearningAgentEvent,
  type LearningAgentSession,
} from "../agentSession.js";
import {
  fetchLearningOverview,
  type LearningOverview,
} from "../learningOverviewTool.js";
import {
  fetchLearningLibrary,
  type LearningLibrary,
} from "./learningLibrary.js";
import { GoalOnboardingContext, type GoalOnboardingSnapshot } from "../planning/goalOnboarding.js";
import {capturePlanningWait, latestPlanningWait, provePlanningWait, transitionPlanningWait, planningInitializeAttempts} from "../planning/planningReadingWait.js";
import {ReadingExecutionError} from "../materialReading.js";
import {planningHash} from "../planning/planningReading.js";
import type { GoalProfileInput } from "../planning/planningTypes.js";
import { TeachingSessionContext } from "../teachingSession.js";
import {createLearnerQuestionTool} from "../learnerQuestionTool.js";
import { LEARNER_QUESTIONS_ENTRY, LearnerQuestionsContext, goalConfirmationSignature, learningStartSignature } from "../learnerQuestions.js";
import {teacherVisibility, savedQuestionSnapshot} from "../teacherTurn.js";
import {masteryReviewDecision, masteryReviewSignature} from "../masteryReview.js";
import {masteryDecisionReceipt, masteryReplyHash, saveMasteryDecisionReceipt, type MasteryDecisionReceipt} from "./masteryDecisionReceipt.js";
import { ClassroomFeed } from "./classroomFeed.js";
import type { LearnerQuestionsSnapshot } from "../learnerQuestionTypes.js";
import { parseVoiceInputMetadata, readSpeechPresentation, type SpeechPresentation, type SpeechReference,
  type SpeechComponent, type VoiceInputMetadata } from "../speechTypes.js";
import {
  type ProviderConnectionResult,
  type ProviderSettingsCoordinator,
  type ProviderSettingsInput,
  type ProviderThinkingLevel,
  type PublicProviderCatalog,
} from "./providerSettings.js";
import {
  ConversationCatalog,
  type ConversationSummary,
  type ReviewBranch,
} from "./conversationCatalog.js";
import {
  abandonTask,
  clearCardNote,
  confirmMastery,
  deleteCard,
  reopenSkill,
  setCardFeedback,
  setCardNote,
  startPracticing,
  updateCard,
  type UserSkillPayload,
  type UserTaskPayload,
} from "../userApi.js";

export type WebSessionEvent =
  | LearningAgentEvent
  | { type: "state"; state: WebLearningState }
  | { type: "conversation_update"; messages: WebConversationMessage[]; routeChanged?: boolean }
  | { type: "done" }
  | { type: "error"; message: string };

export interface WebLearningState {
  animation_request?: AnimationRequestView | null;
  feedback_recovery?: {id: string; reason: FeedbackRecovery["reason"]} | null;
  classroom_version?: string;
  assistant_busy?: boolean;
  restored_session?: WebSessionPayload;
  overview: LearningOverview;
  view_mode: "CURRENT" | "ARCHIVED" | "UNAVAILABLE";
  active_goal_id: string | null;
  view_goal_id: string | null;
  teaching: ReturnType<TeachingSessionContext["snapshot"]>;
  onboarding: ReturnType<GoalOnboardingContext["snapshot"]>;
  recoverable_confirmed_goal: boolean;
  recommended_action: {
    status: "READY" | "STALE";
    text: string;
  } | null;
}

export interface WebConversationMessage {
  figures?: PlacedFigure[];
  explainer?: ExplainerComponent;
  animation?: AnimationComponent;
  animation_question?: {presentation_id:string;source_entry_id:string;title:string;scene_id:string};
  attachments?: ConversationAttachment[];
  assessment?: AnswerAssessment;
  role: "user" | "assistant";
  content: string;
  entryId?: string;
  speech?: SpeechComponent;
}

// 与前端 MATERIAL_CONTEXT_MARKER 对应；剥离自动材料引用块，用户历史只保留自己的话。
function stripMaterialContext(content: string): string {
  return content
    .replace(/\[LAWA_MATERIAL_CONTEXT\][\s\S]*?\[\/LAWA_MATERIAL_CONTEXT\]\n?/g, "")
    .trim();
}


export type WebSessionCreateMode = "resume-recent" | "new" | "new-goal";

export interface WebSessionRecord {
  routeRequest?: {goalId: string; taskId: string | null; taskRevision: number; path: string; teaching: ReturnType<TeachingSessionContext["snapshot"]>};
  routePath?: string;
  animationRequestId?: string;
  handoffRunId?: string;
  assistantSubmissionScope?: AssistantScope | null;
  id: string;
  context: TeachingSessionContext;
  planningContext: GoalOnboardingContext;
  sessionManager: SessionManager;
  agent?: LearningAgentSession;
  activeSink?: (event: WebSessionEvent) => void;
  busy: boolean;
  masteryDecisionBusy?: boolean;
  abortRequested?: boolean;
  imageReadAbort?:AbortController;
  activeImageMaterialIds?:string[];
  invalidatedMaterials:Set<string>;
  modelFailed?: boolean;
  voiceScopeId?: string;
}

export interface WebSessionPayload {
  sessionId: string;
  state: WebLearningState;
  messages: WebConversationMessage[];
  previewEntryId?: string | null;
  previewSkillId?: string | null;
  branches?: Array<{ label: string; entryId: string; skillId: string }>;
}

export interface WebSessionStoreOptions {
  materialReading?: MaterialReadingRuntime;
  summarizeHandoff?: HandoffSummarizer;
  handoffTimeoutMs?: number;
  assistantStore?: AssistantStore;
  createAssistantAgent?: AssistantAgentFactory;
  studyTiming?: (overview: LearningOverview) => Promise<string> | string;
  speechStatus?: import("../agentSession.js").CreateLearningAgentSessionOptions["speechStatus"];
  lessonArt?:import("../lessonArtwork.js").LessonArtwork;
  scopePurged?: (goalId: string) => Promise<void>;
  scopeChanged?: (scope: string, deleted: boolean) => void;
  apiBaseUrl?: string;
  conversationDir?: string;
  /** 会话的原始工作目录身份；换代码工作树时仍按原身份恢复，不重写JSONL。 */
  conversationCwd?: string;
  fetchOverview?: () => Promise<LearningOverview>;
  fetchLibrary?: () => Promise<LearningLibrary>;
  createAgent?: (
    context: TeachingSessionContext,
    planningContext: GoalOnboardingContext,
    emit: (event: LearningAgentEvent) => void,
    sessionManager: SessionManager,
    branchProposed: (branch: LearningBranch) => Promise<unknown>,
  ) => Promise<LearningAgentSession>;
  skillAction?: (
    action: "master" | "reopen" | "practice",
    skillId: string,
    masteryScope?: {goalId: string; taskId: string},
  ) => Promise<UserSkillPayload>;
  taskAction?: (taskId: string) => Promise<UserTaskPayload>;
  cardAction?: (
    kind: "feedback" | "note-set" | "note-clear" | "delete" | "update",
    cardId: string,
    body?: Record<string, unknown>,
  ) => Promise<unknown>;
  log?: (message: string) => void;
  providerSettings?: ProviderSettingsCoordinator;
}

export class WebSessionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export class WebSessionStore {
  readonly classroom: ClassroomFeed;
  private readonly assistants: AssistantStore;
  private readonly createAssistantAgent: AssistantAgentFactory | undefined;
  private assistantBusy = false;
  private assistantOwner: string | null = null;
  private assistantStopRequested = false;
  private assistantGeneration = 0;
  private readonly summarizeHandoff: HandoffSummarizer | undefined;
  private readonly handoffTimeoutMs: number | undefined;
  private readonly sessions = new Map<string, WebSessionRecord>();
  private readonly studyTiming: WebSessionStoreOptions["studyTiming"];
  private readonly speechStatus: WebSessionStoreOptions["speechStatus"];
  private activeSessionId: string | null = null;
  private readonly apiBaseUrl: string | undefined;
  private readonly conversationDir: string | undefined;
  private readonly loadOverview: () => Promise<LearningOverview>;
  private readonly loadLibrary: () => Promise<LearningLibrary>;
  private readonly createAgentRuntime: WebSessionStoreOptions["createAgent"];
  private readonly runSkillAction: NonNullable<WebSessionStoreOptions["skillAction"]>;
  private readonly runTaskAction: NonNullable<WebSessionStoreOptions["taskAction"]>;
  private readonly runCardAction: NonNullable<WebSessionStoreOptions["cardAction"]>;
  private readonly log: (message: string) => void;
  private readonly lessonArt:WebSessionStoreOptions["lessonArt"];
  private readonly providerSettings: ProviderSettingsCoordinator | undefined;
  private readonly materialReading?: MaterialReadingRuntime;
  private readonly conversationCatalog: ConversationCatalog | undefined;
  private readonly recycle: GoalRecycle | undefined;
  private recovery?: Promise<void>;
  private changing = false;
  private planningDisposed = false;
  private planningWake = false;
  private planningPump?: Promise<void>;
  private planningRetry?: ReturnType<typeof setTimeout>;
  private planningLife = new AbortController();
  private planningUnsubscribe?: () => void;

  private async postKernel(path: string, body?: Record<string, unknown>): Promise<unknown> {
    const baseUrl = this.apiBaseUrl ?? process.env.LEARNING_API_BASE_URL ?? "http://127.0.0.1:8000";
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { detail?: string };
      throw new WebSessionError(data.detail || `Learning API returned HTTP ${response.status}`, response.status);
    }
    return response.json();
  }

  private async recycleKernel(path: string, method = "POST", body?: object): Promise<unknown> {
    const base = this.apiBaseUrl ?? process.env.LEARNING_API_BASE_URL ?? "http://127.0.0.1:8000";
    const response = await fetch(`${base.replace(/\/$/, "")}${path}`, {method,
      ...(body ? {headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)} : {}),
      signal: AbortSignal.timeout(30_000)});
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as {detail?: string};
      throw new WebSessionError(body.detail ?? "目标操作未完成，请重试。", response.status);
    }
    return response.json();
  }

  private async recoverRecycle(): Promise<void> {
    if (!this.recycle) return;
    this.recovery ??= this.recycle.recover().catch(error => { this.recovery = undefined; throw error; });
    await this.recovery;
  }

  private async recoverCompletedReview(manager: SessionManager, overview: LearningOverview, knownReview?: ReviewBranch): Promise<{ manager: SessionManager; overview: LearningOverview }> {
    const catalog = this.conversationCatalog;
    const review = knownReview ?? catalog?.currentReview(manager);
    const unchanged = { manager, overview };
    if (!catalog || !review || review.goalId !== this.currentGoalId(overview)) return unchanged;
    let active = overview.active_task as { id?: string } | null;
    const confirmed = overview.skills.some((skill) => (skill as { id?: string; status?: string }).id === review.skillId && (skill as { status?: string }).status === "MASTERED_BY_USER");
    if (active?.id === review.reviewTaskId && !confirmed) return unchanged;
    const base = this.apiBaseUrl ?? process.env.LEARNING_API_BASE_URL ?? "http://127.0.0.1:8000";
    const response = await fetch(`${base.replace(/\/$/, "")}/api/learning/tasks/${encodeURIComponent(review.reviewTaskId)}`, { signal: AbortSignal.timeout(10_000) });
    if (response.status === 404) return unchanged;
    if (!response.ok) throw new WebSessionError("无法核对复习任务，请稍后重试", response.status);
    const task = await response.json() as { id?: string; goal_id?: string; status?: string; related_skill_ids?: string[]; review_parent_task_id?: string | null };
    if (task.id !== review.reviewTaskId || task.goal_id !== review.goalId || (task.related_skill_ids && !task.related_skill_ids.includes(review.skillId))) return unchanged;
    // 旧版再次掌握只改 Skill；它已是用户确认的事实，允许收尾 ACTIVE 复习而不再做 Mastery。
    if (task.status === "ACTIVE" && active?.id === review.reviewTaskId && confirmed) {
      await this.postKernel(`/api/user/tasks/${encodeURIComponent(review.reviewTaskId)}/finish-review`);
      overview = await this.loadOverview(); active = overview.active_task as { id?: string } | null;
      task.status = "DONE";
    }
    // 仅恢复已经 DONE 且父任务匹配的返回点，进行中/失配/后续新任务不变。
    if (task.status !== "DONE" ||
        (active && active.id !== task.review_parent_task_id)) return unchanged;
    const returning = review.returnSessionId && review.returnSessionId !== manager.getSessionId()
      ? await catalog.open(review.returnSessionId) : manager;
    if (review.returnEntryId && !returning.getEntry(review.returnEntryId)) return unchanged;
    if (!active && task.review_parent_task_id) {
      await this.postKernel(`/api/user/tasks/${encodeURIComponent(review.reviewTaskId)}/finish-review`);
      overview = await this.loadOverview();
    }
    if (review.returnEntryId) returning.branch(review.returnEntryId);
    else returning.resetLeaf();
    catalog.recordGoal(returning, review.goalId, overview.current_goal, true);
    catalog.recordPosition(returning);
    return { manager: returning, overview };
  }

  readonly excerptNotes:ExcerptNotes;
  async repairNoteBindings(){
    for(const note of this.excerptNotes.list()){
      if(note.goalId&&note.skillId)continue;
      try{const source=await this.resolveNoteSource(note.source);
        if(source.goalId&&source.skillId)this.excerptNotes.bind(note.id,source.goalId,source.skillId);
      }catch(error){if(!(error instanceof ExcerptError&&error.statusCode===404))throw error;}
    }
    return this.excerptNotes.list();
  }
  async noteSourceContext(source:NoteSource){
    const resolved=await this.resolveNoteSource(source);
    const messages=source.channel==="assistant"?this.assistants.noteConversation(source.sessionId,source.messageId).map(m=>({id:m.id,role:m.role,content:m.content})):
      this.visibleMessages(await this.requireConversationCatalog().open(source.sessionId),source.messageId).map(m=>({id:m.entryId,role:m.role,content:m.content}));
    const index=messages.findIndex(m=>m.id===source.messageId);
    if(index<0)throw new ExcerptError("原消息已不可用。",404);
    return {...resolved,messages:messages.slice(Math.max(0,index-12),index+4)};
  }
  async resolveNoteSource(source:NoteSource):Promise<ResolvedNoteSource> {
    if(!source||typeof source.sessionId!=="string"||typeof source.messageId!=="string"||!["teacher","assistant"].includes(source.channel))throw new ExcerptError("原消息引用无效。");
    const catalog=this.requireConversationCatalog();
    let manager:SessionManager;
    try{manager=await catalog.open(source.sessionId);}catch{throw new ExcerptError("原对话已移除或不可用。",404);}
    if(source.channel==="assistant"){
      const message=this.assistants.noteMessage(source.sessionId,source.messageId);
      if(!message)throw new ExcerptError("原助教消息已不可用。",404);
      return {source,...message};
    }
    return this.resolveTeacherSource(manager,source);
  }

  private resolveTeacherSource(manager:SessionManager,source:NoteSource,branchOnly=false):ResolvedNoteSource {
    const catalog=this.requireConversationCatalog();
    const entry=manager.getEntry(source.messageId);
    if(!entry||entry.type!=="message"||!["user","assistant"].includes(entry.message.role))throw new ExcerptError("原消息不可用。",404);
    const message=this.visibleMessages(manager,source.messageId).find(m=>m.entryId===source.messageId);
    if(!message)throw new ExcerptError("原消息不可用。",404);
    let goalId=catalog.goalAtEntry(manager,source.messageId),skillId:string|null=null;
    // 精确消息锚点可位于消息之后；不能用其他分支或当前课堂猜测归属。
    const marker=(branchOnly?manager.getBranch():manager.getEntries()).find(row=>row.type==="custom"&&row.customType==="lawa.skill-anchor"&&(row.data as {entryId?:string}).entryId===source.messageId);
    if(marker?.type==="custom"){
      const anchor=marker.data as {goalId:string;skillId:string};
      if(!goalId||goalId===anchor.goalId){goalId=anchor.goalId;skillId=anchor.skillId;}
    }
    for(const row of [...manager.getBranch(source.messageId)].reverse()){
      if(skillId)break;
      if(row.type==="custom"&&row.customType==="lawa.goal-observation"){
        if((row.data as {goalId?:string}).goalId!==goalId)break;
        continue;
      }
      if(row.type!=="message"||row.message.role!=="toolResult"||row.message.isError)continue;
      try{
        const value=JSON.parse(row.message.content.filter(p=>p.type==="text").map(p=>p.text).join("\n"));
        const details=row.message.details as Record<string,any>|undefined;
        let scope:Record<string,any>|undefined;
        switch(row.message.toolName){
          case "record_teaching_turn":scope={skill_id:value.active_skill_id};break;
          case "present_practice_set":scope=value.request;break;
          case "record_answer_assessment":scope=details?.assessment??value.assessment;break;
          case "present_explainer_animation":scope=details?.explainer;break;
          case "present_teaching_animation":scope=value.animation??details?.animation;break;
          case "activate_learning_task":
            if(value.goal_id===goalId&&value.related_skill_ids?.length===1)skillId=value.related_skill_ids[0];
            // 多知识点任务不能继续沿用之前任务的知识点。
            return {source,content:message.content,role:message.role,goalId,skillId};
        }
        const owner=scope?.goal_id??scope?.goalId;
        const skill=scope?.skill_id??scope?.skillId;
        if(typeof skill==="string"&&goalId&&(!owner||owner===goalId))skillId=skill;
      }catch{}
    }
    return {source,content:message.content,role:message.role,goalId,skillId};
  }
  constructor(options: WebSessionStoreOptions = {}) {
    this.excerptNotes=new ExcerptNotes(options.conversationDir?resolve(options.conversationDir,"excerpt-notes-v1.json"):undefined);
    this.summarizeHandoff=options.summarizeHandoff;this.handoffTimeoutMs=options.handoffTimeoutMs;
    this.studyTiming = options.studyTiming;
    this.speechStatus = options.speechStatus;
    this.apiBaseUrl = options.apiBaseUrl;
    this.classroom = new ClassroomFeed(options.conversationDir);
    this.conversationDir = options.conversationDir
      ? resolve(options.conversationDir)
      : undefined;
    this.log = options.log ?? (() => undefined);
    this.providerSettings = options.providerSettings;
    this.lessonArt=options.lessonArt;
    this.materialReading = options.materialReading;
    this.planningUnsubscribe = this.materialReading?.onCompleted(() => this.wakePlanning());
    this.assistants = options.assistantStore ?? new AssistantStore({rootDir: this.conversationDir ? resolve(this.conversationDir, "assistants") : undefined});
    this.createAssistantAgent = options.createAssistantAgent;
    this.conversationCatalog = this.conversationDir
      ? new ConversationCatalog(this.conversationDir, options.conversationCwd)
      : undefined;
    this.recycle = this.conversationCatalog ? new GoalRecycle(this.conversationCatalog,
      (path, method, body) => this.recycleKernel(path, method, body), options.scopeChanged, async goal=>{this.lessonArt?.purgeGoal(goal);await options.scopePurged?.(goal);},
      async item => {
        if (item.phase === "deleting") await this.assistants.recycle(item);
        if (item.phase === "restoring") await this.assistants.restore(item);
        if (item.phase === "purging") await this.assistants.purge(item);
      }) : undefined;
    this.loadOverview =
      options.fetchOverview ??
      (() =>
        fetchLearningOverview({
          baseUrl: this.apiBaseUrl,
          log: () => undefined,
        }));
    this.loadLibrary =
      options.fetchLibrary ??
      (() => fetchLearningLibrary({ baseUrl: this.apiBaseUrl }));
    this.createAgentRuntime = options.createAgent;
    this.runSkillAction =
      options.skillAction ??
      ((action, skillId, masteryScope) => {
        const api = { baseUrl: this.apiBaseUrl };
        if (action === "master") return confirmMastery(skillId, {...api, ...(masteryScope ? {masteryScope} : {})});
        if (action === "reopen") return reopenSkill(skillId, api);
        return startPracticing(skillId, api);
      });
    this.runTaskAction =
      options.taskAction ??
      ((taskId) => abandonTask(taskId, { baseUrl: this.apiBaseUrl }));
    this.runCardAction =
      options.cardAction ??
      ((kind, cardId, body) => {
        const api = { baseUrl: this.apiBaseUrl };
        if (kind === "feedback") {
          return setCardFeedback(cardId, body as { status: string }, api);
        }
        if (kind === "note-set") {
          return setCardNote(cardId, body as { note: string }, api);
        }
        if (kind === "delete") return deleteCard(cardId, api);
        return updateCard(cardId, body as { question: string; answer: string }, api);
      });
  }

  async create(mode: WebSessionCreateMode = "resume-recent"): Promise<WebSessionPayload> {
    if (this.changing) throw new WebSessionError("正在整理学习目标，请稍后重试。", 409);
    await this.recoverRecycle();
    let overview = await this.loadOverview();
    let active = this.activeSessionId
      ? this.sessions.get(this.activeSessionId)
      : undefined;
    if (this.assistantBusy && active && mode === "resume-recent") return this.payload(active,overview);
    if (active && (overview.recycled_goal_ids ?? []).includes(this.conversationCatalog?.goalObservation(active.sessionManager)?.goalId ?? "")) {
      this.requireIdleForConversationChange("恢复保留的学习位置");
      this.releaseActiveRecord(); active = undefined;
    }
    if (active && mode === "resume-recent") {
      if (!active.busy && await this.conversationCatalog?.restoreNaturalConversationLeaf(active.sessionManager)) {
        active.agent?.dispose();
        active.agent = undefined;
        active.context = new TeachingSessionContext();
        active.context.bindSession(active.id);
        active.planningContext = new GoalOnboardingContext();
      }
      if (!active.busy) overview = await this.restoreConversationGoal(active.sessionManager, overview);
      const oldLeaf = active.sessionManager.getLeafId();
      const recovered = active.busy ? { manager: active.sessionManager, overview } : await this.recoverCompletedReview(active.sessionManager, overview);
      if (recovered.manager !== active.sessionManager || recovered.manager.getLeafId() !== oldLeaf) {
        this.releaseActiveRecord();
        const restored = this.createRecord(recovered.manager, recovered.overview);
        this.sessions.set(restored.id, restored); this.activeSessionId = restored.id;
        return this.payload(restored, recovered.overview);
      }
      return this.payload(active, recovered.overview);
    }

    if (mode === "new" || mode === "new-goal") {
      this.requireIdleForConversationChange("新建对话");
      // 新对话必须得到新的 Pi SessionManager；旧 JSONL 继续保留给会话库，
      // 但旧 messages / Tool Results 绝不能进入新会话的模型上下文。
      active?.agent?.dispose();
      if (active) this.sessions.delete(active.id);
    }

    // Web 对话使用 Pi 原生 JSONL Session 保存完整模型上下文；Learning Kernel 仍是
    // Goal、Skill、Task、Evidence 等长期学习事实的唯一权威来源。
    let sessionManager = this.conversationCatalog
      ? mode === "new" || mode === "new-goal"
        ? this.conversationCatalog.create()
        : this.conversationCatalog.resumeRecent()
      : SessionManager.inMemory(process.cwd());
    if (mode === "resume-recent" && this.conversationCatalog && overview.recycled_goal_ids?.length) {
      const listed = (await this.listConversations()).sessions;
      const recent = listed[0];
      sessionManager = recent ? await this.conversationCatalog.open(recent.id) : this.conversationCatalog.create();
      if (recent?.goalId && this.conversationCatalog.goalObservation(sessionManager)?.goalId !== recent.goalId) {
        this.conversationCatalog.selectGoalBranch(sessionManager, recent.goalId);
      }
    }
    if (mode === "resume-recent") await this.conversationCatalog?.restoreNaturalConversationLeaf(sessionManager);
    if (mode === "resume-recent") overview = await this.restoreConversationGoal(sessionManager, overview);
    if (mode === "resume-recent") {
      const recovered = await this.recoverCompletedReview(sessionManager, overview);
      sessionManager = recovered.manager; overview = recovered.overview;
    }
    const record = this.createRecord(sessionManager, overview);
    if (mode === "new-goal") {
      // 创建会话与进入引导必须原子完成，避免两次 HTTP 请求之间把附件挂到旧目标。
      record.planningContext.start({ replaceExisting: overview.current_goal !== null });
      record.sessionManager.appendCustomEntry("lawa.goal-onboarding-started", {
        replaceExisting: overview.current_goal !== null,
      });
    }
    // 恢复旧会话时不能把当前 Kernel Goal 追加成它的新归属。
    if (["IDLE", "INITIALIZED"].includes(record.planningContext.snapshot().status) &&
        mode !== "new-goal" && (mode === "new" || !this.conversationCatalog?.goalObservation(record.sessionManager))) {
      this.observeGoal(record.sessionManager, overview);
    }
    this.sessions.set(record.id, record);
    this.activeSessionId = record.id;
    return this.payload(record, overview);
  }

  private cancelPlanning(record: WebSessionRecord, reason: string): boolean {
    try {
      const wait = latestPlanningWait(record.sessionManager);
      if (wait && ["WAITING", "RUNNING", "FAILED"].includes(wait.data.state)) transitionPlanningWait(record.sessionManager, wait, "CANCELED", reason);
      return true;
    } catch {this.log("[planning-resume] wait metadata unavailable; automatic continuation disabled"); return false;}
  }

  /** 补齐已有准确草案/路线的固定决策；只展示，不代用户确认或开始。 */
  private async ensurePlanningDecisionQuestion(record: WebSessionRecord): Promise<void> {
    this.log(`[planning-resume] ensure-decision onboarding=${record.planningContext.snapshot().status} pending=${record.context.learnerQuestions.snapshot().pending?.purpose ?? "none"}`);
    const status = record.planningContext.snapshot().status;
    const purpose = status === "READY_FOR_CONFIRMATION" ? "CONFIRM_GOAL" : status === "INITIALIZED" ? "START_LEARNING" : null;
    if (!purpose || record.context.learnerQuestions.snapshot().pending) return;
    const startTool = createLearnerQuestionTool(record.context, record.planningContext,
      {baseUrl: this.apiBaseUrl, log: this.log});
    await startTool.execute("planning-decision", {purpose},
      this.planningLife.signal, undefined, {} as Parameters<typeof startTool.execute>[4]);
    this.saveLearnerQuestions(record);
    this.log(`[planning-resume] ensure-decision complete pending=${record.context.learnerQuestions.snapshot().pending?.purpose ?? "none"}`);
  }

  private wakePlanning(): void {
    if (this.planningDisposed || !this.materialReading) return;
    if (this.planningRetry) {clearTimeout(this.planningRetry); this.planningRetry = undefined;}
    this.planningWake = true;
    if (!this.planningPump) this.planningPump = Promise.resolve().then(async () => {
      do {this.planningWake = false; await this.resumeReadyPlanning();} while (this.planningWake && !this.planningDisposed);
    }).catch(() => {
      if (!this.planningDisposed) {
        this.log("[planning-resume] continuation deferred; original request retained");
        this.planningRetry = setTimeout(() => this.wakePlanning(), 30_000); this.planningRetry.unref();
      }
    }).finally(() => {this.planningPump = undefined;});
  }

  /** 只恢复当前真实分支的已确认规划；模型在课堂busy内执行，资源核验不长持课堂锁。 */
  private async resumeReadyPlanning(): Promise<void> {
    const record = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
    if (!record || !this.materialReading || this.planningDisposed || record.busy || this.changing || this.assistantBusy) return;
    const wait = latestPlanningWait(record.sessionManager);
    if (!wait || wait.data.state === "COMPLETED" || !provePlanningWait(record.sessionManager, wait)) return;
    const reference = wait.data.snapshot.reading_requirement!;
    const before = await this.loadOverview();
    if (wait.data.state === "CANCELED" && this.currentGoalId(before) !== wait.data.snapshot.pending_profile?.id) return;
    let readiness: {state: string; recovery_protocol?: number};
    try {
      readiness = await this.materialReading.client.request(`material-planning/${encodeURIComponent(record.id)}/requirements/${reference.id}`,
        "draft:" + record.id, undefined, this.planningLife.signal);
    } catch (error) {
      if (error instanceof ReadingExecutionError && [404, 409].includes(error.status)
          && latestPlanningWait(record.sessionManager)?.entryId === wait.entryId) {
        transitionPlanningWait(record.sessionManager, wait, "FAILED", "REQUIREMENT_CHANGED"); return;
      }
      throw error;
    }
    if (readiness.recovery_protocol === 1 && readiness.state !== "COMPLETED" && this.currentGoalId(before) === wait.data.snapshot.pending_profile?.id) {
      for (const input of planningInitializeAttempts(record.sessionManager, wait)) {
        if (this.planningDisposed || record.busy || this.changing || this.activeSessionId !== record.id
            || latestPlanningWait(record.sessionManager)?.entryId !== wait.entryId) return;
        try {
          await this.materialReading.client.request("curriculum/initialize", undefined,
            {...input, onboarding_session_id: record.id, reading_requirement_id: reference.id, recover_only: true}, this.planningLife.signal);
          readiness = {state: "COMPLETED"}; break;
        } catch (error) {if (!(error instanceof ReadingExecutionError) || error.status !== 409) throw error;}
      }
    }
    const current = await this.loadOverview();
    if (this.planningDisposed || this.activeSessionId !== record.id || this.sessions.get(record.id) !== record
        || record.busy || this.changing || this.assistantBusy || latestPlanningWait(record.sessionManager)?.entryId !== wait.entryId) return;
    const profile = current.goal_profile as Record<string, unknown> | null;
    const {created_at: _created, ...currentProfile} = profile ?? {};
    if (readiness.state === "COMPLETED" && planningHash(currentProfile) === planningHash(wait.data.snapshot.pending_profile)) {
      const snapshot = record.planningContext.snapshot();
      if (snapshot.status === "CONFIRMED" && snapshot.reading_requirement?.id === reference.id) record.planningContext.markInitialized();
      else if (["IDLE", "NEEDS_CLARIFICATION"].includes(snapshot.status) && !snapshot.pending_profile) record.planningContext.restoreReadingWait(wait.data.snapshot, true);
      else if (snapshot.status !== "INITIALIZED") return;
      await this.ensurePlanningDecisionQuestion(record);
      transitionPlanningWait(record.sessionManager, wait, "COMPLETED", "KERNEL_RECEIPT_CONFIRMED");
      this.observeGoal(record.sessionManager, current); this.classroom.changed(); return;
    }
    if (wait.data.state !== "WAITING") {
      if (wait.data.state === "RUNNING") transitionPlanningWait(record.sessionManager, wait, "FAILED", "RESUME_INTERRUPTED");
      return; // 未知中断不自动重放付费模型；真实用户继续可重试，已提交Kernel事实单独核验。
    }
    if (planningHash(record.planningContext.snapshot()) !== planningHash(wait.data.snapshot)) return;
    if (readiness.state === "BLOCKED") {transitionPlanningWait(record.sessionManager, wait, "FAILED", "READING_BLOCKED"); return;}
    if (readiness.state !== "READY" || learningStartSignature(current) !== wait.data.kernelSignature) return;
    record.busy = true; record.abortRequested = false; record.modelFailed = false;
    let completed = false, started = false, agentTurn = false;
    try {
      transitionPlanningWait(record.sessionManager, wait, "RUNNING");
      this.classroom.begin(record.id); started = true;
      record.activeSink = event => this.classroom.event(record.id, event);
      record.agent ??= await this.makeAgent(record);
      if (!record.agent.resumePlanning) throw new Error("PLANNING_RESUME_UNAVAILABLE");
      if (this.planningDisposed || this.activeSessionId !== record.id || record.abortRequested) return;
      record.context.beginAgentTurn(); agentTurn = true;
      const entriesBeforeResume = new Set(record.sessionManager.getBranch().map(entry => entry.id));
      const result = await record.agent.resumePlanning({waiterId: wait.data.id, requirementId: reference.id});
      const initializeSucceededThisRun = record.sessionManager.getBranch().some(entry =>
        !entriesBeforeResume.has(entry.id) && entry.type === "message" && entry.message.role === "toolResult" &&
        entry.message.toolName === "initialize_learning_goal" && !entry.message.isError);
      const actual = await this.loadOverview();
      const actualProfile = actual.goal_profile as Record<string, unknown> | null;
      if (record.planningContext.snapshot().status === "CONFIRMED" && actualProfile && initializeSucceededThisRun) {
        const {created_at: _createdAt, ...profileWithoutTimestamp} = actualProfile;
        if (planningHash(profileWithoutTimestamp) === planningHash(wait.data.snapshot.pending_profile))
          record.planningContext.markInitialized();
      }
      await this.ensurePlanningDecisionQuestion(record);
      const confirmedOnboarding = record.planningContext.snapshot().status === "CONFIRMED";
      const sourceClarificationPending = confirmedOnboarding &&
        record.context.learnerQuestions.snapshot().pending?.purpose === "BACKGROUND";
      const startDecisionPending = record.planningContext.snapshot().status === "INITIALIZED" &&
        record.context.learnerQuestions.snapshot().pending?.purpose === "START_LEARNING";
      const outcomePersisted = record.planningContext.snapshot().status === "INITIALIZED" ||
        sourceClarificationPending || startDecisionPending;
      completed = !record.abortRequested && outcomePersisted &&
        ((result?.status ?? (record.modelFailed ? "model_error" : "completed")) === "completed" ||
          sourceClarificationPending || startDecisionPending);
      record.context.endAgentTurn(completed); agentTurn = false;
      this.saveLearnerQuestions(record);
      if (record.planningContext.snapshot().status === "INITIALIZED") this.observeGoal(record.sessionManager, actual);
      this.classroom.event(record.id, {type: "conversation_update", messages: this.classroomMessages(record)} as WebSessionEvent);
      this.classroom.event(record.id, {type: "state", state: await this.viewState(record, actual)} as WebSessionEvent);
      const latest = latestPlanningWait(record.sessionManager);
      if (latest?.data.id === wait.data.id && latest.data.state === "RUNNING")
        transitionPlanningWait(record.sessionManager, latest, completed ? "COMPLETED" : "FAILED", completed ? undefined : "MODEL_OR_SAVE_INCOMPLETE");
      if (completed) this.classroom.event(record.id, {type: "done"});
    } catch (error) {
      completed = false;
      this.log(`[planning-resume] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      const latest = latestPlanningWait(record.sessionManager);
      if (latest?.data.id === wait.data.id && latest.data.state === "RUNNING") transitionPlanningWait(record.sessionManager, latest, "FAILED", "RESUME_FAILED");
      if (!this.planningDisposed) this.classroom.event(record.id, {type: "error", message: "这次规划暂未完成，可以发送“继续”接着处理。"} as WebSessionEvent);
    } finally {
      if (agentTurn) record.context.endAgentTurn(false);
      record.activeSink = undefined; record.busy = false; record.abortRequested = false; record.modelFailed = false;
      if (started) this.classroom.finish(record.id, completed);
      if (started && !completed && !this.planningDisposed) this.planningWake = true; // 只补核验Kernel回执，不自动重放未知模型运行。
    }
  }

  async state(sessionId: string): Promise<WebLearningState> {
    const record = this.require(sessionId);
    return this.viewState(record, await this.loadOverview());
  }

  async teaching(sessionId: string, decision?: {id: string; body: Record<string, unknown>}, all = false): Promise<unknown> {
    const record = this.require(sessionId);
    const overview = await this.loadOverview();
    this.assertCurrentConversation(record, overview);
    if (decision) {
      const proposals = await this.recycleKernel("/api/user/teaching", "GET") as {proposals: Array<{id: string; kind: string}>};
      if (record.busy && proposals.proposals.find(p => p.id === decision.id)?.kind === "CLOSURE") throw new WebSessionError("请等待本轮结束，再决定是否结束目标。", 409);
      if (record.busy && ["WITHDRAW", "DELETE", "SUPPLEMENT"].includes(String(decision.body.action))) await this.stop(sessionId);
      // 独立用户命令不调用Pi、不接触待答练习、Candidate或帮助归因。
      return this.postKernel(`/api/user/teaching/proposals/${encodeURIComponent(decision.id)}/decision`, decision.body);
    }
    return this.recycleKernel(all ? "/api/user/teaching" : "/api/learning/teaching", "GET");
  }

  async personalTeaching(decision?: {id: string; body: Record<string, unknown>}): Promise<unknown> {
    const context = await this.recycleKernel("/api/user/teaching", "GET") as {proposals: Array<{id: string; kind: string; status: string}>};
    if (!decision) return context;
    const proposal = context.proposals.find(v => v.id === decision.id);
    if (!proposal || proposal.kind !== "STRATEGY" || proposal.status === "PENDING" ||
        !["WITHDRAW", "RESTORE", "DELETE", "SUPPLEMENT"].includes(String(decision.body.action))) throw new WebSessionError("此操作只管理已有的个人教学安排；待确认建议请回到当前课堂。", 409);
    // 用户拥有的安排不依赖课堂会话；紧急停用仍取消使用旧策略的在途教师。
    const run = this.classroom.snapshot();
    if (run?.status === "running") await this.stop(run.sessionId, run.id);
    return this.postKernel(`/api/user/teaching/proposals/${encodeURIComponent(decision.id)}/decision`, decision.body);
  }

  async sharedClassroom() {
    const record = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
    if (!record) return {session: null, run: this.classroom.snapshot(), version: null, sequence: this.classroom.sequence};
    const overview = await this.loadOverview();
    return {session: await this.payload(record, overview), run: this.classroom.snapshot(), version: this.classroomVersion(record, overview), sequence: this.classroom.sequence};
  }

  private classroomVersion(record: WebSessionRecord, overview: LearningOverview, leaf=record.sessionManager.getLeafId()): string {
    return createHash("sha256").update(JSON.stringify({session: record.id, leaf,
      goal: overview.goal_profile, task: overview.active_task, question: record.context.learnerQuestions.snapshot().pending?.id})).digest("hex");
  }

  async currentStudyScope(sessionId: string): Promise<StudyScope | null> {
    const record = this.require(sessionId);
    if (sessionId !== this.activeSessionId) return null;
    const overview = await this.loadOverview();
    const view = await this.viewState(record, overview);
    return view.view_mode === "CURRENT" && ["IDLE", "INITIALIZED"].includes(record.planningContext.snapshot().status) ? studyScope(overview) : null;
  }

  async materialGoal(sessionId: string | null, expectedGoalId: string | null): Promise<string> {
    if (!sessionId) throw new WebSessionError("资料操作需要明确的对话。请刷新页面后重试。", 409);
    const record = this.require(sessionId);
    if (sessionId !== this.activeSessionId) throw new WebSessionError("当前对话已切换，请重试。", 409);
    const overview = await this.loadOverview();
    this.assertCurrentConversation(record, overview);
    if (!["IDLE", "INITIALIZED"].includes(record.planningContext.snapshot().status)) {
      return "draft:" + sessionId;
    }
    const goalId = this.currentGoalId(overview);
    if (!goalId || goalId !== expectedGoalId || sessionId !== this.activeSessionId) {
      throw new WebSessionError("当前目标或对话已切换。请刷新资料列表后重试。", 409);
    }
    return goalId;
  }

  /** 历史图只来自该对话、该次讲解的真实工具回执。读取本地插画不会触发生图。 */
  async lessonArtResource(sessionId:string,batchId:string,assetId:string,bytes:boolean,messageId:string|null) {
    const missing=()=>new WebSessionError("这幅插画的来源不可用。",404);
    if (!this.lessonArt) throw missing();
    let manager=this.sessions.get(sessionId)?.sessionManager;
    if (!manager) {
      try {manager=await this.requireConversationCatalog().open(sessionId);} catch {throw missing();}
    }
    const message=messageId?manager.getEntry(messageId):undefined;
    if (messageId && (message?.type!=="message" || message.message.role!=="assistant")) throw missing();
    const branch=manager.getBranch(messageId??undefined);
    let owner:string|undefined;
    for (const entry of [...branch].reverse()) {
      if (entry.type==="message" && entry.message.role==="user") break;
      if (entry.type!=="message" || entry.message.role!=="toolResult" || entry.message.isError || entry.message.toolName!==FIGURE_TOOL) continue;
      const batch=readFigureBatch((entry.message.details as {lessonFigures?:unknown}|undefined)?.lessonFigures);
      if (batch?.sessionId===sessionId && batch.id===batchId && batch.figures.some(f=>"art" in f && f.art.id===assetId)) {
        owner=batch.goalId;break;
      }
    }
    if (!owner || (await this.loadOverview()).recycled_goal_ids?.includes(owner)) throw missing();
    const result=bytes?this.lessonArt.image(sessionId,assetId):this.lessonArt.status(sessionId,assetId);
    if (!result) throw missing();
    return result;
  }
  /** 附件权限来自原 user entry 和所在分支，回看时无需切换教学会话。 */
  async resolveConversationAttachment(sessionId: string | null, entryId: string | null, materialId: string): Promise<Record<string, string>> {
    if (!sessionId || !entryId || !/^mat-[0-9a-f]{32}$/.test(materialId)) throw new WebSessionError("附件引用无效。", 400);
    const catalog = this.requireConversationCatalog();
    let manager = this.sessions.get(sessionId)?.sessionManager;
    if (!manager) {
      try { manager = await catalog.open(sessionId); }
      catch { throw new WebSessionError("原附件对话不可用。", 404); }
    }
    const entry = manager.getEntry(entryId);
    if (!entry || entry.type !== "message" || entry.message.role !== "user") throw new WebSessionError("原附件消息不可用。", 404);
    const raw = typeof entry.message.content === "string" ? entry.message.content : entry.message.content
      .filter(part => part.type === "text").map(part => part.text).join("\n");
    if (!projectConversationAttachments(raw).some(attachment => attachment.id === materialId)) throw new WebSessionError("附件不属于原消息。", 404);
    const goal = catalog.goalAtEntry(manager, entryId);
    return {reference_session_id: sessionId, ...(goal ? {reference_goal_id: goal} : {})};
  }

  /** 只读解析原会话的成功 ToolResult；历史朗读不激活 Goal、不移动执行分支。 */
  async resolveSpeech(reference: SpeechReference): Promise<SpeechPresentation> {
    if (!reference || typeof reference.sourceSessionId !== "string" || !reference.sourceSessionId ||
        typeof reference.entryId !== "string" || !reference.entryId ||
        typeof reference.presentationId !== "string" || !reference.presentationId) throw new WebSessionError("朗读引用无效。", 400);
    let manager = this.sessions.get(reference.sourceSessionId)?.sessionManager;
    if (!manager) {
      try { manager = await this.requireConversationCatalog().open(reference.sourceSessionId); }
      catch { throw new WebSessionError("原朗读对话已移除或不可用。", 404); }
    }
    const entry = manager.getEntry(reference.entryId);
    const speech = this.speechFromEntry(entry, manager.getSessionId());
    if (!speech || speech.id !== reference.presentationId) throw new WebSessionError("未找到有效的朗读组件。", 404);
    return speech;
  }

  /** 旁路识别固定录音开始时的执行现场；此 token 不推进 Pi leaf，也不授予教学权限。 */
  async voiceScope(sessionId: string): Promise<string> {
    const record = this.require(sessionId);
    if (this.activeSessionId !== sessionId || record.busy) throw new WebSessionError("当前对话不可录音，请等待回复结束。", 409);
    const overview = await this.loadOverview();
    this.assertCurrentConversation(record, overview);
    this.invalidateStaleRecall(record, overview);
    // 异步回读期间也可能发生切换或生成；结果须仍属于同一个活动 runtime。
    if (this.sessions.get(sessionId) !== record || this.activeSessionId !== sessionId || record.busy) throw new WebSessionError("当前对话已变化，请重新录音。", 409);
    const snapshot = record.context.snapshot();
    const pending = snapshot.learner_questions?.pending;
    const draft = !["IDLE", "INITIALIZED"].includes(record.planningContext.snapshot().status);
    const task = overview.active_task as { id?: string; status?: string } | null;
    const scope = { sessionId, runtime: record.voiceScopeId, active: true, leaf: record.sessionManager.getLeafId(), draft,
      goal: draft ? null : this.currentGoalId(overview), task: draft ? null : task?.id ?? null,
      taskStatus: draft ? null : task?.status ?? null, request: pending?.id ?? null,
      questions: pending?.questions.map(question => question.id) ?? [],
      recallQuestion: snapshot.active_recall?.current_question ?? snapshot.current_question };
    return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
  }

  async assertVoiceScope(sessionId: string, scope: string): Promise<void> {
    if (typeof scope !== "string" || !scope || await this.voiceScope(sessionId) !== scope) throw new WebSessionError("录音时的对话或问题已变化，请重新录音。", 409);
  }

  async learningLibrary(): Promise<LearningLibrary> {
    return this.loadLibrary();
  }

  async listConversations(): Promise<{
    activeSessionId: string | null;
    sessions: ConversationSummary[];
    unlinkedGoals?: Array<{id: string; name: string}>;
  }> {
    if (!this.conversationCatalog) {
      return { activeSessionId: this.activeSessionId, sessions: [] };
    }
    await this.recoverRecycle();
    const overview = await this.loadOverview();
    const profiles = [overview.goal_profile, ...overview.learning_history.map(p => (p as {goal_profile?: unknown}).goal_profile)]
      .filter(Boolean) as Array<{id: string; goal_description?: string}>;
    const available = new Set(profiles.map(p => p.id));
    const recycled = new Set(overview.recycled_goal_ids ?? []);
    const sessions = await this.conversationCatalog.list(this.activeSessionId);
    const listed: ConversationSummary[] = [];
    const linked = new Set<string>();
    for (const row of sessions) {
      const manager = await this.conversationCatalog.open(row.id);
      const owners = this.conversationCatalog.goalIds(manager);
      owners.filter(id => available.has(id)).forEach(id => linked.add(id));
      if (row.goalId && recycled.has(row.goalId)) {
        const remaining = owners.find(id => available.has(id));
        if (!remaining) continue;
        const project = profiles.find(p => p.id === remaining)!;
        listed.push({...row, goalId: remaining, goalDescription: project.goal_description ?? row.goalDescription});
      } else listed.push(row);
    }
    return {
      activeSessionId: this.activeSessionId,
      sessions: listed,
      unlinkedGoals: profiles.flatMap(profile => {
        return linked.has(profile.id) ? [] : [{id: profile.id, name: profile.goal_description ?? overview.current_goal ?? profile.id}];
      }),
    };
  }

  async activateConversation(sessionId: string): Promise<WebSessionPayload> {
    this.requireIdleForConversationChange("切换对话");
    if (sessionId === this.activeSessionId) {
      return this.create("resume-recent");
    }
    const catalog = this.requireConversationCatalog();
    const summary = (await this.listConversations()).sessions.find(item => item.id === sessionId);
    if (!summary) throw new WebSessionError("对话所属目标已回收，请先在管理对话中恢复。", 404);
    let manager: SessionManager;
    try {
      manager = await catalog.open(sessionId);
      await catalog.restoreNaturalConversationLeaf(manager);
      if (summary.goalId && catalog.goalObservation(manager)?.goalId !== summary.goalId) {
        catalog.selectGoalBranch(manager, summary.goalId);
      }
    } catch {
      throw new WebSessionError("对话不存在或已经移除。", 404);
    }
    let overview = await this.restoreConversationGoal(manager, await this.loadOverview());
    const recovered = await this.recoverCompletedReview(manager, overview);
    manager = recovered.manager; overview = recovered.overview;
    this.releaseActiveRecord();
    const record = this.createRecord(manager, overview);
    this.sessions.set(record.id, record);
    this.activeSessionId = record.id;
    return this.payload(record, overview);
  }

  async activateGoal(goalId: string): Promise<WebSessionPayload> {
    this.requireIdleForConversationChange("切换目标");
    const catalog = this.requireConversationCatalog();
    const location = await catalog.locateGoal(goalId);
    const manager = location ? await catalog.open(location.sessionId) : null;
    await this.postKernel(`/api/user/goals/${encodeURIComponent(goalId)}/activate`);
    this.releaseActiveRecord();
    let overview = await this.loadOverview();
    let selected = manager ?? catalog.create();
    if (manager && location?.entryId && manager.getEntry(location.entryId)) {
      manager.branch(location.entryId);
      catalog.recordGoal(manager, goalId, overview.current_goal, true);
      catalog.recordPosition(manager);
    }
    const recovered = await this.recoverCompletedReview(selected, overview);
    selected = recovered.manager; overview = recovered.overview;
    const record = this.createRecord(selected, overview);
    if (!location) this.observeGoal(selected, overview);
    this.sessions.set(record.id, record);
    this.activeSessionId = record.id;
    return this.payload(record, overview);
  }

  async locateSkill(goalId: string, skillId: string, branchId?: string): Promise<WebSessionPayload> {
    this.requireIdleForConversationChange("定位技能");
    const catalog = this.requireConversationCatalog();
    const active = this.activeSessionId ? this.require(this.activeSessionId) : null;
    if (!active) throw new WebSessionError("No active conversation", 409);
    const overview = await this.loadOverview();
    const branch = goalId === this.currentGoalId(overview) ? overview.learning_paths?.branches.find(b => branchId
      ? b.id === branchId && b.skill_ids.includes(skillId)
      : b.exclusive_skill_ids.includes(skillId)) : undefined;
    if (branchId && !branch) throw new WebSessionError("这条分支不属于当前目标或知识点，请重新打开路线。", 409);
    if (branch) {
      const source = await catalog.locateRouteBranch(goalId, branch.id);
      if (!source) throw new WebSessionError("这条分支的原记录暂不可用，请返回当前课堂后重试。", 404);
      const manager = await catalog.open(source.sessionId), ids = new Set(source.messageIds);
      const messages = this.visibleMessages(manager, source.entryId, ids);
      // 路线已有进入位置但未讲解是正常空状态；只读投影，不建复习、不移动执行leaf或Task。
      return {...await this.payload(active, overview), messages, previewSkillId: skillId,
        previewEntryId: messages.at(-1)?.entryId ?? source.entryId, branches: []};
    }
    const anchor = await catalog.locateSkill(goalId, skillId);
    if (!anchor) throw new WebSessionError("未找到原学习位置；可以从当前目标新建复习对话。", 404);
    const manager = await catalog.open(anchor.sessionId);
    manager.branch(anchor.entryId);
    // 原节点只在独立的 SessionManager 实例中预览；不移动当前执行 leaf，也不切换 Kernel Goal。
    const preview = this.createRecord(manager, overview);
    return {
      ...(await this.payload(active, overview)),
      state: await this.viewState(preview, overview, goalId),
      messages: this.visibleMessages(manager, anchor.entryId),
      previewEntryId: anchor.entryId,
      branches: active.id === anchor.sessionId ? catalog.branches(manager, goalId) : [],
    };
  }

  async transitionRouteBranch(command: RouteBranchCommand): Promise<WebSessionPayload> {
    this.requireIdleForConversationChange("切换学习路线");
    this.changing = true;
    try {
      const record = this.activeSessionId ? this.require(this.activeSessionId) : null;
      if (!record || command.sessionId !== record.id) throw new WebSessionError("课堂已变化，请刷新后重试。", 409);
      const before = await this.loadOverview();
      const branch = before.learning_paths?.branches.find(b => b.id === command.branchId);
      if (!branch || command.goalId !== this.currentGoalId(before)) throw new WebSessionError("学习分支不属于当前目标。", 409);
      // 在Kernel转换前落盘旧路径的问题。重试/进程重启只恢复匹配路径，不移动Pi leaf。
      saveRouteState(record.sessionManager, record.routePath ?? routePathKey(before), record.context.snapshot());
      const handoff = ["return", "complete"].includes(command.action) ? branchHandoff(record.sessionManager, branch.id) : {};
      await this.postKernel(`/api/user/learning-branches/${encodeURIComponent(branch.id)}/transition`, {
        action: command.action, operation_id: command.operationId, expected_revision: command.expectedRevision,
        expected_goal_id: command.goalId, expected_task_id: command.taskId, expected_task_revision: command.taskRevision,
        ...handoff,
      });
      const after = await this.loadOverview();
      const path = routePathKey(after);
      if (path !== record.routePath) {
        record.context.restoreLearningPath(readRouteState(record.sessionManager, path),
          !after.learning_paths?.active_branch_id && Boolean(after.learning_paths?.branches.find(b => b.id === branch.id)?.assistance_provided));
        record.routePath = path;
        record.agent?.dispose(); record.agent = undefined;
        record.sessionManager.appendCustomEntry(ROUTE_TRANSITION, {branchId: branch.id, action: command.action,
          operationId: command.operationId, path, taskId: (after.active_task as {id?: string} | null)?.id ?? null});
        this.saveLearnerQuestions(record);
      }
      this.classroom.changed();
      return this.payload(record, after);
    } finally {this.changing = false;}
  }

  async selectBranch(entryId: string): Promise<WebSessionPayload> {
    this.requireIdleForConversationChange("切换分支");
    const record = this.activeSessionId ? this.require(this.activeSessionId) : null;
    if (!record || !record.sessionManager.getEntry(entryId)) throw new WebSessionError("分支不存在", 404);
    const overview = await this.loadOverview();
    const catalog = this.requireConversationCatalog();
    const selected = catalog.branches(record.sessionManager, this.currentGoalId(overview)).find((branch) => branch.entryId === entryId);
    if (!selected) throw new WebSessionError("这个分支不属于当前学习目标的学习记录", 409);
    const manager = await catalog.open(record.id);
    const tip = catalog.reviewTip(manager, entryId);
    manager.branch(tip);
    const preview = this.createRecord(manager, overview);
    // 学习记录按钮仅浏览：不能把正在执行的 Pi leaf 移回首课/已结束复习。
    return {
      ...(await this.payload(record, overview)),
      state: await this.viewState(preview, overview, this.currentGoalId(overview) ?? undefined),
      messages: this.visibleMessages(manager), previewEntryId: tip, previewSkillId: selected.skillId,
    };
  }

  async startSkillReview(goalId: string, skillId: string, operationId: string): Promise<WebSessionPayload> {
    this.requireIdleForConversationChange("开始复习");
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(operationId)) throw new WebSessionError("Invalid review operation id", 400);
    const catalog = this.requireConversationCatalog();
    if (this.currentGoalId(await this.loadOverview()) !== goalId) await this.activateGoal(goalId);
    const currentTask = (await this.loadOverview()).active_task as { id?: string; related_skill_ids?: string[] } | null;
    if (currentTask?.id?.startsWith("review-") && currentTask.related_skill_ids && !currentTask.related_skill_ids.includes(skillId)) {
      throw new WebSessionError("请先结束当前复习，再复习其他内容。", 409);
    }
    if (currentTask?.id?.startsWith("review-") && currentTask.related_skill_ids?.includes(skillId) && this.activeSessionId) {
      const location = await catalog.locateGoal(goalId);
      if (!location) return this.payload(this.require(this.activeSessionId), await this.loadOverview());
      const manager = await catalog.open(location.sessionId);
      if (location.entryId && manager.getEntry(location.entryId)) manager.branch(location.entryId);
      this.releaseActiveRecord();
      const overview = await this.loadOverview();
      const record = this.createRecord(manager, overview);
      this.sessions.set(record.id, record);
      this.activeSessionId = record.id;
      return this.payload(record, overview);
    }
    const previous = this.activeSessionId ? this.require(this.activeSessionId) : null;
    const returnEntryId = previous?.sessionManager.getLeafId() ?? null;
    const returnSessionId = previous?.id ?? "";
    const anchor = await catalog.locateSkill(goalId, skillId);
    const manager = anchor ? await catalog.open(anchor.sessionId) : catalog.create();
    const existing = catalog.reviewByOperation(manager, operationId);
    if (existing) {
      const marker = manager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "lawa.review-branch" && (entry.data as { operationId?: string })?.operationId === operationId);
      if (marker) manager.branch(marker.id);
    } else {
      if (anchor && manager.getEntry(anchor.entryId)) manager.branch(anchor.entryId);
      // Pi JSONL 先记下幂等操作；Kernel 再按相同 operation_id 创建任务。
      // 重试时不会多开分支，也不会重复暂停原任务。
      catalog.recordReview(manager, {
        operationId, goalId, skillId,
        sourceEntryId: anchor?.entryId ?? null,
        returnEntryId,
        returnSessionId,
        reviewTaskId: `review-${operationId}`,
        createdAt: new Date().toISOString(),
      });
      catalog.recordGoal(manager, goalId, (await this.loadOverview()).current_goal, true);
    }
    await this.postKernel(`/api/user/skills/${encodeURIComponent(skillId)}/start-review`, { operation_id: operationId });
    this.releaseActiveRecord();
    const overview = await this.loadOverview();
    const record = this.createRecord(manager, overview);
    this.sessions.set(record.id, record);
    this.activeSessionId = record.id;
    return this.payload(record, overview);
  }

  async finishSkillReview(confirmedReviewId?: string): Promise<WebSessionPayload> {
    this.requireIdleForConversationChange("结束复习");
    return this.finishSkillReviewNow(confirmedReviewId);
  }

  private async finishSkillReviewNow(confirmedReviewId?: string): Promise<WebSessionPayload> {
    const current = this.activeSessionId ? this.require(this.activeSessionId) : null;
    if (!current) throw new WebSessionError("No active conversation", 409);
    const overviewBefore = await this.loadOverview();
    const taskId = (overviewBefore.active_task as { id?: string } | null)?.id;
    const catalog = this.requireConversationCatalog();
    const reviewId = confirmedReviewId ?? (taskId?.startsWith("review-") ? taskId : null);
    const review = reviewId
      ? await catalog.findReview(reviewId)
      : catalog.currentReview(current.sessionManager);
    if (!review) throw new WebSessionError("当前对话不是复习分支", 409);
    if (review.goalId !== this.currentGoalId(overviewBefore)) throw new WebSessionError("复习任务属于另一个目标", 409);
    if (taskId && !taskId.startsWith("review-")) {
      // 确认掌握已恢复 Kernel 时只恢复 Pi；迟到的旧结束请求不得回退新任务。
      const oldLeaf = current.sessionManager.getLeafId();
      const recovered = await this.recoverCompletedReview(current.sessionManager, overviewBefore, review);
      if (recovered.manager === current.sessionManager && recovered.manager.getLeafId() === oldLeaf) return this.payload(current, overviewBefore);
      this.releaseActiveRecord();
      const restored = this.createRecord(recovered.manager, recovered.overview);
      this.sessions.set(restored.id, restored); this.activeSessionId = restored.id;
      return this.payload(restored, recovered.overview);
    }
    const manager = review.returnSessionId && review.returnSessionId !== current.id
      ? await catalog.open(review.returnSessionId)
      : current.sessionManager;
    if (review.returnEntryId && !manager.getEntry(review.returnEntryId)) throw new WebSessionError("原学习位置暂时不可用，请重新打开原对话。", 409);
    await this.postKernel(`/api/user/tasks/${encodeURIComponent(review.reviewTaskId)}/finish-review`);
    const overview = await this.loadOverview();
    if (review.returnEntryId) manager.branch(review.returnEntryId);
    else manager.resetLeaf();
    catalog.recordGoal(manager, review.goalId, overview.current_goal, true);
    catalog.recordPosition(manager);
    this.releaseActiveRecord();
    const record = this.createRecord(manager, overview);
    this.sessions.set(record.id, record);
    this.activeSessionId = record.id;
    return this.payload(record, overview);
  }

  async renameConversation(sessionId: string, name: string): Promise<void> {
    this.requireIdleForConversationChange("重命名对话");
    try {
      await this.requireConversationCatalog().rename(sessionId, name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /not found/i.test(message) ? 404 : 400;
      throw new WebSessionError(
        status === 404 ? "对话不存在或已经移除。" : "对话名称需为 1～80 个字符。",
        status,
      );
    }
  }

  async deleteConversation(sessionId: string): Promise<WebSessionPayload> {
    this.requireIdleForConversationChange("删除目标");
    const catalog = this.requireConversationCatalog();
    const row = (await this.listConversations()).sessions.find(item => item.id === sessionId);
    if (!row) throw new WebSessionError("对话不存在或已经移除。", 404);
    return this.deleteGoalOrDraft(row.goalId, sessionId, row.goalDescription ?? row.name);
  }

  async deleteGoal(goalId: string): Promise<WebSessionPayload> {
    this.requireIdleForConversationChange("删除目标");
    const project = (await this.loadLibrary()).projects.find(p => (p.goal_profile as {id: string}).id === goalId);
    if (!project) throw new WebSessionError("学习目标不存在。", 404);
    return this.deleteGoalOrDraft(goalId, null, (project.goal_profile as {goal_description: string}).goal_description);
  }

  private async deleteGoalOrDraft(goalId: string | null, sessionId: string | null, name: string): Promise<WebSessionPayload> {
    this.requireIdleForConversationChange("删除目标");
    this.changing = true;
    try {
      await this.recycle!.recycle(goalId ? "goal" : "draft", goalId ?? sessionId!, name,
        goalId ? undefined : [sessionId!]);
      this.releaseActiveRecord();
    } finally { this.changing = false; }
    return this.returnToSavedGoal();
  }

  private async returnToSavedGoal(): Promise<WebSessionPayload> {
    const overview = await this.loadOverview();
    const goalId = this.currentGoalId(overview);
    if (goalId) return this.activateGoal(goalId);
    // 没有剩余目标时只创建空白聊天承载起点，绝不调用 Planner 或建立学习目标。
    return this.create("new");
  }

  async listRecycle(): Promise<{items: RecycleItem[]}> {
    return {items: this.recycle ? await this.recycle.list() : []};
  }

  async actOnRecycle(id: string, action: "restore" | "purge"): Promise<WebSessionPayload> {
    this.requireIdleForConversationChange("整理回收区");
    if (!this.recycle) throw new WebSessionError("回收区不可用。", 503);
    this.changing = true;
    let item: RecycleItem;
    try { item = await this.recycle.act(id, action); }
    finally { this.changing = false; }
    if (action === "restore") {
      if (item.kind === "goal") return this.activateGoal(item.targetId);
      return this.activateConversation(item.sessionIds[0]!);
    }
    if (this.activeSessionId) return this.payload(this.require(this.activeSessionId), await this.loadOverview());
    return this.returnToSavedGoal();
  }

  async clearConversation(sessionId: string): Promise<WebSessionPayload> {
    this.requireIdleForConversationChange("清空聊天");
    const catalog = this.requireConversationCatalog();
    const row = (await this.listConversations()).sessions.find(item => item.id === sessionId);
    if (!row) throw new WebSessionError("对话不存在。", 404);
    this.requireIdleForConversationChange("清空聊天");
    this.changing = true;
    try {
      await this.recycle!.recycle("chat", sessionId, row.name, [sessionId]);
      if (sessionId === this.activeSessionId) this.releaseActiveRecord();
    } finally { this.changing = false; }
    if (this.activeSessionId) return this.payload(this.require(this.activeSessionId), await this.loadOverview());
    const manager = catalog.create();
    const overview = await this.loadOverview();
    this.observeGoal(manager, overview);
    const record = this.createRecord(manager, overview);
    this.sessions.set(record.id, record); this.activeSessionId = record.id;
    return this.payload(record, overview);
  }

  private assistantQuestion(record: WebSessionRecord, taskId: string): {text: string | null; anchor: string | null} {
    const current = learnerTeachingSnapshot(record.context.snapshot());
    const pending = current.learner_questions?.pending;
    if (pending?.purpose === "CHECK" && pending.task_id === taskId) return {
      text: pending.questions.map(q => q.prompt).join("\n"), anchor: pending.id,
    };
    if (current.active_recall?.task_id === taskId) return {text: current.active_recall.current_question,
      anchor: String(current.active_recall.question_issued_at_turn)};
    if (current.active_task_id === taskId && current.current_question) return {text: current.current_question, anchor: null};
    // 只恢复用于帮助归因的题面定位，不复活进程内 Checkpoint 或 Candidate。
    const branch = record.sessionManager.getBranch();
    for (const entry of [...branch].reverse()) {
      if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError ||
          !["record_teaching_turn", "active_recall_checkpoint"].includes(entry.message.toolName)) continue;
      try {
        const text = entry.message.content.filter((part): part is {type:"text";text:string} => part.type === "text").map(part => part.text).join("\n");
        const data = JSON.parse(text) as {active_task_id?: string; current_question?: string | null; active_recall?: {task_id?: string; current_question?: string}};
        if (entry.message.toolName === "active_recall_checkpoint") {
          // Checkpoint 结果只含公开当前题；真实 Task 从同一次工具调用绑定，不能恢复隐藏题库或临时进度。
          const callId = entry.message.toolCallId;
          const call = branch.flatMap(row => row.type === "message" && row.message.role === "assistant"
            ? row.message.content.filter(part => part.type === "toolCall" && part.id === callId && part.name === "active_recall_checkpoint") : [])
            .find(part => part.type === "toolCall");
          if (call?.type === "toolCall" && call.arguments.active_task_id === taskId) return {
            text: typeof data.current_question === "string" ? data.current_question : null, anchor:entry.id,
          };
          continue;
        }
        if (data.active_task_id === taskId) return {text:typeof data.current_question === "string" ? data.current_question : null,anchor:entry.id};
        if (data.active_recall?.task_id === taskId && data.active_recall.current_question) return {text:data.active_recall.current_question,anchor:entry.id};
      } catch { /* 历史结果无法解析时仍可答疑；不得猜测正式检查已恢复。 */ }
    }
    return {text:null,anchor:null};
  }

  private assistantScope(record: WebSessionRecord, overview: LearningOverview, persist = false): AssistantScope | null {
    const goalId = this.currentGoalId(overview);
    const task = overview.active_task as {id?: string; goal_id?: string; status?: string; related_skill_ids?: string[]} | null;
    if (!goalId || !task?.id || task.status !== "ACTIVE" || task.goal_id !== goalId || this.pendingGoalDraft(record.sessionManager)) return null;
    const taught = record.context.snapshot().active_skill_id;
    const skillId = taught && task.related_skill_ids?.includes(taught) ? taught : task.related_skill_ids?.[0];
    if (!skillId) return null;
    const question = this.assistantQuestion(record, task.id);
    const previous = [...record.sessionManager.getBranch()].reverse().find(e => e.type === "custom" && e.customType === "lawa.assessment-attempt");
    const saved = previous?.type === "custom" ? previous.data as {scope?: AssistantScope; question?: string | null} : null;
    if (saved?.scope?.goalId === goalId && saved.scope.taskId === task.id && saved.scope.skillId === skillId &&
        saved.scope.mainSessionId === record.id && saved.question === question.text) return saved.scope;
    const branchId = saved?.scope?.taskId === task.id && saved.scope.goalId === goalId
      ? saved.scope.branchId : record.sessionManager.getLeafId() ?? "root";
    const questionId = question.text ? createHash("sha256").update(question.text).digest("hex") : null;
    const scope: AssistantScope = {goalId,taskId:task.id,skillId,mainSessionId:record.id,branchId,questionId,
      attemptId: questionId ? createHash("sha256").update(JSON.stringify([goalId,task.id,questionId,question.anchor ?? branchId])).digest("hex") : null};
    if (persist) record.sessionManager.appendCustomEntry("lawa.assessment-attempt", {scope,question:question.text});
    return scope;
  }

  private assistantPayload(snapshot: AssistantSnapshot) {
    return {available:true,scope:snapshot.scope,messages:snapshot.messages,busy:snapshot.busy,
      teacher_busy:[...this.sessions.values()].some(r => r.busy),revision:snapshot.revision};
  }

  async assistant(sessionId: string) {
    const record = this.require(sessionId);
    const overview = await this.loadOverview();
    if (this.activeSessionId !== sessionId || this.pendingGoalDraft(record.sessionManager)) return {
      available:false,scope:null,messages:[],busy:false,notice:"进入当前学习任务后即可向助教提问。",
    };
    this.assertCurrentConversation(record, overview);
    const scope = this.assistantScope(record, overview);
    return scope ? this.assistantPayload(this.assistants.get(scope)) : {
      available:false,scope:null,messages:[],busy:false,notice:"开始一个学习任务后，助教会在这里陪你答疑。",
    };
  }

  async sendAssistant(sessionId: string, text: string, emit: (event: Record<string, unknown>) => void, animationContext?:unknown, figureAnchor?:unknown): Promise<void> {
    this.requireIdleForConversationChange("向助教提问");
    if (this.activeSessionId !== sessionId) throw new WebSessionError("请在当前课堂向助教提问。", 409);
    if (!text.trim() || text.length > 20_000) throw new WebSessionError("请输入不超过两万字的问题。", 400);
    const record = this.require(sessionId);
    // 先占用课堂生成权，跨等待 Kernel/模型初始化也不能与主教师同时评价。
    this.assistantBusy = true; this.assistantOwner = sessionId; this.assistantStopRequested = false;
    const generation=++this.assistantGeneration;
    try {
      const overview = await this.loadOverview(); this.assertCurrentConversation(record, overview);
      const scope = this.assistantScope(record, overview);
      if (!scope) throw new WebSessionError("请先开始当前学习任务。", 409);
      // 先重建动画事实再保存提问归属；无效锚点不能凭空追加一次助教求助或更改主课题目。
      if (animationContext!==undefined && figureAnchor!==undefined) throw new WebSessionError("一次提问请选择一个位置。",400);
      const figureRoute=record.routePath;
      const figureQuestion=figureAnchor===undefined?undefined:resolveFigureQuestion(figureAnchor,this.classroomMessages(record),{
        sessionId,goalId:scope.goalId,taskId:scope.taskId,skillId:scope.skillId},
        assetId=>this.lessonArt?.status(sessionId,assetId)?.state==="ready");
      const animationQuestion=animationContext===undefined?undefined:resolveAssistantAnimation(record.sessionManager,scope,animationContext);
      this.assistantScope(record,overview,true);
      const boundedMessages = (beforeId?: string, limit = 12) => {
        // 旧 Pi 可以混合多个 Goal。只读权不能因共用文件扩展到其他学习目标。
        let owner: string | null = null;
        const allowed = new Set<string>();
        for (const entry of record.sessionManager.getBranch()) {
          if (entry.type === "custom" && entry.customType === "lawa.goal-observation") owner = (entry.data as {goalId?:string}).goalId ?? null;
          if (entry.type === "message" && entry.message.role === "toolResult" && !entry.message.isError && entry.message.toolName === "initialize_learning_goal") {
            const initializedGoal = (entry.message.details as {goalId?:unknown} | undefined)?.goalId;
            if (typeof initializedGoal === "string") owner = initializedGoal;
          }
          if (owner === scope.goalId && entry.type === "message") allowed.add(entry.id);
          // 首课的 Goal 标记可能在轮末追加。只补入运行时已明确绑定当前 Goal/Skill 的公开讲解锚点。
          if (entry.type === "custom" && entry.customType === "lawa.skill-anchor") {
            const anchor = entry.data as {goalId?:string;skillId?:string;entryId?:string};
            if (anchor.goalId === scope.goalId && anchor.skillId === scope.skillId && anchor.entryId) allowed.add(anchor.entryId);
          }
        }
        const all = this.visibleMessages(record.sessionManager).filter(message => !!message.entryId && allowed.has(message.entryId));
        const end = beforeId ? all.findIndex(m => m.entryId === beforeId) : all.length;
        if (end < 0) throw new WebSessionError("原讲解位置不可读取。", 404);
        const start = Math.max(0,end - Math.min(12,Math.max(1,limit)));
        return {messages:all.slice(start,end).map(m => ({id:m.entryId,role:m.role,content:m.content.slice(0,4_000)})),
          truncated:start > 0 || all.slice(start,end).some(m => m.content.length > 4_000)};
      };
      const binding = this.createAssistantAgent ? undefined : await this.providerSettings?.getActiveRuntime();
      const task = overview.active_task as {title?: string};
      const skill = overview.skills.find(s => (s as {id?:string}).id === scope.skillId) as {name?:string} | undefined;
      const context: AssistantContext = {goalName:overview.current_goal ?? undefined,taskName:task.title,skillName:skill?.name,
        ...(figureQuestion?{figureQuestion}:{}),
        animations:recentAssistantAnimations(record.sessionManager,scope),...(animationQuestion?{animationQuestion}:{}),
        branchSource:branchSource(record.sessionManager),
        currentQuestion:this.assistantQuestion(record,scope.taskId).text ?? undefined,mainMessages:boundedMessages().messages,
        overview:projectLearningContext(learnerOverview(overview)),apiBaseUrl:this.apiBaseUrl,model:binding?.model,modelRuntime:binding?.runtime,
        thinkingLevel:binding?.thinkingLevel,
        readMainMessages:async opts => boundedMessages(opts.beforeId,opts.limit),
        isCurrentScope:async () => {
          if (generation!==this.assistantGeneration || this.assistantStopRequested || this.activeSessionId !== sessionId || this.assistantOwner !== sessionId) return false;
          const current = await this.loadOverview(); const now = this.assistantScope(record,current);
          return !!now && now.goalId === scope.goalId && now.taskId === scope.taskId && now.skillId === scope.skillId && now.attemptId === scope.attemptId&&
            (!figureQuestion || record.routePath===figureRoute && record.sessionManager.getBranch().some(entry=>entry.id===figureQuestion.anchor.messageId)) &&
            (!animationQuestion||record.sessionManager.getBranch().some(entry=>entry.id===animationQuestion.anchor.source_entry_id));
        }};
      await this.assistants.send(scope,text,context,event => {
        if (event.type === "assistant_delta") emit({type:"text_delta",text:event.delta});
        if (event.type === "state") emit({type:"assistant_state",assistant:this.assistantPayload(event.state)});
        if (event.type === "error") emit({type:"error",message:event.message});
        if (event.type === "done") emit({type:"done"});
      }, this.createAssistantAgent);
    } finally { if (generation===this.assistantGeneration) {this.assistantBusy = false; this.assistantOwner = null; this.assistantStopRequested = false;this.wakePlanning();} }
  }

  async stopAssistant(sessionId: string): Promise<void> {
    this.require(sessionId);
    if (this.assistantOwner && this.assistantOwner !== sessionId) throw new WebSessionError("这不是当前答疑会话。",409);
    this.assistantStopRequested = true;
    await this.assistants.stop();
  }

  /**
   * Kernel 已确认删除后同步失效本实例的前台引用。只有确实持有该资料原图
   * 或当前文档批次的课堂会被中止；历史文本仍保留，后续模型输入由
   * MaterialSourceGuard 替换为失效墓碑。
   */
  materialDeleted(materialId:string):boolean {
    let affected=false;
    for(const record of this.sessions.values()) {
      record.invalidatedMaterials.add(materialId);
      const planningUsesMaterial = record.planningContext.snapshot().reading_requirement?.materials
        .some(source => source.id === materialId) ?? false;
      if (planningUsesMaterial) {
        affected = true;
        this.cancelPlanning(record, "MATERIAL_DELETED");
        if (record.busy) {
          record.abortRequested = true;
          void record.agent?.abort().catch(() => undefined);
        }
      }
      if(record.activeImageMaterialIds?.includes(materialId)) {
        affected=true;
        record.abortRequested=true;
        record.imageReadAbort?.abort();
      }
      let current=false;
      try {current=record.agent?.materialDeleted?.(materialId)??false;}
      catch {current=true;}
      if(current) {
        affected=true;
        if(record.busy) {
          record.abortRequested=true;
          void record.agent?.abort().catch(()=>undefined);
        }
      }
    }
    if(this.assistants.materialDeleted(materialId)) affected=true;
    return affected;
  }

  async sendAnimationQuestion(sessionId:string,text:string,emit:(event:WebSessionEvent)=>void,rawAnchor:unknown,
    requestId:unknown,expectedVersion:unknown,retryOf?:unknown,queryOnly=false):Promise<void>{
    if(typeof text!=="string"||!text.trim()||text.length>4000)throw new WebSessionError("请写下要问的问题（最多4000字）。",400);
    if(/^\/(?:master|reopen|practice)(?:\s|$)/i.test(text.trim()))throw new WebSessionError("动画提问不能执行学习状态命令，请清除引用后使用原入口。",400);
    if(typeof requestId!=="string"||!/^[a-zA-Z0-9_-]{8,128}$/.test(requestId))throw new WebSessionError("动画提交标识无效。",400);
    if(retryOf!==undefined&&(typeof retryOf!=="string"||!/^[a-zA-Z0-9_-]{8,128}$/.test(retryOf)))throw new WebSessionError("原动画提交标识无效。",400);
    const record=this.require(sessionId);
    if(this.activeSessionId!==sessionId)throw new WebSessionError("请回到当前课堂再提问。",409);
    let anchor;try{anchor=parseAnimationAnchor(rawAnchor);}catch(error){throw new WebSessionError((error as Error).message,400);}
    const hash=animationRequestHash(text.trim(),anchor,retryOf as string|undefined);
    const existing=animationRequests(record.sessionManager).find(item=>item.requestId===requestId);
    if(existing){
      if(existing.hash!==hash)throw new WebSessionError("同一提交标识不能用于不同问题或动画位置。",409);
      const current=await this.loadOverview();this.assertAnimationScope(record,this.animationFromReference(record,existing.anchor.source_entry_id),current);
      emit({type:"conversation_update",messages:this.classroomMessages(record)});
      emit({type:"state",state:await this.viewState(record,current)});emit({type:"done"});return;
    }
    if(queryOnly)throw new WebSessionError("尚未找到这次动画提问的已保存回执，请保留问题并明确重新发送。",409);
    this.requireNoMasteryDecision();
    if(this.changing||this.assistantBusy||[...this.sessions.values()].some(item=>item.busy))throw new WebSessionError("课堂正在回复，请等待后再问这一步。",409);
    if(typeof expectedVersion!=="string"||!expectedVersion)throw new WebSessionError("动画提问缺少课堂版本，请更新现场。",409);
    // 获得同一课堂互斥后才读取材料和现场，避免异步解析期间另一个回合先改变Task。
    record.busy=true;record.abortRequested=false;record.modelFailed=false;record.animationRequestId=requestId;
    let receipt:AnimationRequest|undefined,started=false,complete=false;
    const outerEmit=emit;
    emit=event=>{
      this.classroom.event(sessionId,event.type==="assistant_delta"?{...event,delta:event.delta}:event);
      try{outerEmit(event);}catch{this.log("[animation] 提交连接已断开，解释仍由课堂run结算。");}
    };
    record.activeSink=emit;
    try{
      const before=await this.loadOverview();
      if(this.classroomVersion(record,before)!==expectedVersion)throw new WebSessionError("课堂位置已变化，请更新后重新绑定演示。",409);
      const presentation=this.animationFromReference(record,anchor.source_entry_id);
      this.assertAnimationScope(record,presentation,before);
      if(currentFeedbackRecovery(record.sessionManager,before))throw new WebSessionError("请先处理本轮未完成的反馈，再问这一步。",409);
      // 通用分镜必须重放实际分支；不能只按合流节点恢复，更不能接受客户端自报舞台事实。
      const canonical="script" in presentation.artifact?resolveExplainerContext(presentation as ExplainerPresentation,anchor):resolveAnimationContext(presentation as AnimationPresentation,anchor);
      const source=retryOf?animationRequests(record.sessionManager).find(item=>item.requestId===retryOf):undefined;
      if(retryOf&&(!source||source.status==="COMPLETED"||source.question!==text.trim()||JSON.stringify(source.anchor)!==JSON.stringify(anchor)))
        throw new WebSessionError("原动画问题与这次重试不一致。",409);
      if(source?.sourceUserEntryId&&record.sessionManager.getBranch().findLast(entry=>entry.type==="message"&&entry.message.role==="user")?.id!==source.sourceUserEntryId)
        throw new WebSessionError("原问题已被后续对话替代，请重新绑定当前位置提问。",409);
      const preparationBranch=record.sessionManager.getBranch(),preparationLeaf=record.sessionManager.getLeafId();
      record.agent??=await this.makeAgent(record);
      if(!record.agent.askAnimation)throw new WebSessionError("当前教师尚未支持动画答疑。",503);
      const current=await this.loadOverview();this.assertAnimationScope(record,presentation,current);
      const preparedBranch=record.sessionManager.getBranch();
      // SDK首次创建Agent会追加自己的模型/推理设置；这些元数据不等于外部教学现场改变。
      const onlyOwnSettings=preparationBranch.every((entry,index)=>preparedBranch[index]?.id===entry.id)&&
        preparedBranch.slice(preparationBranch.length).every(entry=>["model_change","thinking_level_change","session_info"].includes(entry.type));
      if(!onlyOwnSettings||this.classroomVersion(record,current,preparationLeaf)!==expectedVersion)throw new WebSessionError("课堂位置已变化，请重新绑定演示。",409);
      receipt={version:1,requestId,hash,sessionId,goalId:presentation.goalId,taskId:presentation.taskId,skillId:presentation.skillId,
        anchor,question:text.trim(),title:"script" in presentation.artifact?presentation.artifact.script.title:presentation.artifact.lesson.title,status:"PREPARED",...(source?{retryOf:source.requestId}: {})};
      saveAnimationRequest(record.sessionManager,receipt);
      const originalLeaf=record.sessionManager.getLeafId();
      try{
        receipt.sourceUserEntryId=source?.sourceUserEntryId??record.sessionManager.appendMessage({role:"user",content:[{type:"text",text:receipt.question}],timestamp:Date.now()});
        const user=record.sessionManager.getBranch().find(entry=>entry.id===receipt!.sourceUserEntryId);
        if(user?.type!=="message"||user.message.role!=="user")throw new Error("原动画问题不可读。");
        assertAnimationPersisted(record.sessionManager,[user]);receipt.status="ATTACHED";saveAnimationRequest(record.sessionManager,receipt);
      }catch(error){
        if(originalLeaf)record.sessionManager.branch(originalLeaf);else record.sessionManager.resetLeaf();
        // ATTACHED失败后新user已退离当前分支，失败回执不能继续指向这个孤立entry。
        receipt.sourceUserEntryId=source?.sourceUserEntryId;
        throw error;
      }
      if(record.abortRequested){receipt.status="INTERRUPTED";saveAnimationRequest(record.sessionManager,receipt);return;}
      receipt.status="STARTED";saveAnimationRequest(record.sessionManager,receipt);
      this.classroom.begin(sessionId);started=true;
      emit({type:"conversation_update",messages:this.classroomMessages(record)});
      emit({type:"state",state:await this.viewState(record,current)});
      const result=await record.agent.askAnimation({sourceUserEntryId:receipt.sourceUserEntryId!,context:canonical,question:receipt.question,skillId:presentation.skillId});
      complete=!record.abortRequested&&result.status==="completed";
      receipt.status=complete?"COMPLETED":record.abortRequested||result.status==="stopped"?"INTERRUPTED":"FAILED";
      saveAnimationRequest(record.sessionManager,receipt);
      if(!complete)emit({type:"error",message:"这次解释没有完成；可查询原提交，或显式重试同一个问题。"});
    }catch(error){
      if(receipt){
        try{receipt.status=record.abortRequested?"INTERRUPTED":"FAILED";saveAnimationRequest(record.sessionManager,receipt);}catch{/* 未确认落盘仍保持原阶段，重连按UNKNOWN处理，不自动再请求。 */}
        emit({type:"error",message:error instanceof Error?error.message:"动画解释暂时失败，请查询原提交。"});
      }else throw error;
    }finally{
      try{
        if(receipt){emit({type:"conversation_update",messages:this.classroomMessages(record)});emit({type:"state",state:await this.viewState(record,await this.loadOverview())});emit({type:"done"});}
      }finally{
        // 最后一次异步状态读取也在锁内；旧run结算与释放之间不能让新run插入。
        try{if(started)this.classroom.finish(sessionId,complete);}
        finally{record.busy=false;record.activeSink=undefined;record.animationRequestId=undefined;this.wakePlanning();}
      }
    }
  }

  private animationFromReference(record:WebSessionRecord,entryId:string):AnimationPresentation|ExplainerPresentation{
    // 两类材料都只信当前Pi分支中的成功工具回执，聊天正文不是可执行组件来源。
    const entry=record.sessionManager.getBranch().find(item=>item.id===entryId);
    let animation:AnimationPresentation|ExplainerPresentation|null=null;
    if(entry?.type==="message"&&entry.message.role==="toolResult"&&entry.message.isError===false){
      const details=entry.message.details as {animation?:unknown;explainer?:unknown}|undefined;
      animation=entry.message.toolName==="present_teaching_animation"?readAnimationPresentation(details?.animation):
        entry.message.toolName==="present_explainer_animation"?readExplainerPresentation(details?.explainer):null;
    }
    if(!animation||animation.sourceSessionId!==record.id)throw new WebSessionError("这段演示不属于当前课堂分支。",409);
    return animation;
  }
  private assertAnimationScope(record:WebSessionRecord,animation:AnimationPresentation|ExplainerPresentation,overview:LearningOverview):void{
    const task=overview.active_task as {id?:string;status?:string;related_skill_ids?:string[]}|null;
    this.assertCurrentConversation(record,overview);
    if(this.activeSessionId!==record.id||this.changing||this.assistantBusy||
      !["IDLE","INITIALIZED"].includes(record.planningContext.snapshot().status)||
      this.currentGoalId(overview)!==animation.goalId||task?.status!=="ACTIVE"||task.id!==animation.taskId||!task.related_skill_ids?.includes(animation.skillId))
      throw new WebSessionError("课堂位置已变化，请回到当前课堂再提问。",409);
  }

  async sendMessage(
    sessionId: string,
    text: string,
    emit: (event: WebSessionEvent) => void,
    learnerReply?: unknown,
    voiceInput?: unknown,
    requestId?: unknown,
    expectedVersion?: unknown,
    signal?: AbortSignal,
    imageMaterialIds?:unknown,
  ): Promise<void> {
    if (this.changing) throw new WebSessionError("正在整理学习目标，请稍后重试。", 409);
    this.requireNoMasteryDecision();
    if (requestId!==undefined && (typeof requestId!=="string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId))) throw new WebSessionError("提交标识无效。",400);
    if (this.assistantBusy && this.assistantOwner!==sessionId) throw new WebSessionError("其他课堂的助教正在回复。",409);
    const record = this.require(sessionId);
    let imageIds:string[];
    try {imageIds=parseImageMaterialIds(imageMaterialIds);} catch(error){throw new WebSessionError((error as Error).message,400);}
    const requestHash=createHash("sha256").update(JSON.stringify({text,learnerReply,voiceInput,imageMaterialIds:imageIds})).digest("hex");
    let duplicate;
    try {duplicate=this.assistants.handoffs.existingRun(sessionId,requestId as string|undefined,requestHash);}
    catch {throw new WebSessionError("同一提交标识不能用于不同内容。",409);}
    if (duplicate) {
      if (duplicate.status!=="completed") throw new WebSessionError(duplicate.status==="running" ? "这次提交正在处理，请等待。" : "这次提交已结束；请通过重试发起新的回合。",409);
      emit({type:"conversation_update",messages:this.classroomMessages(record)});emit({type:"state",state:await this.viewState(record,await this.loadOverview())});emit({type:"done"});return;
    }
    if (!text.trim() && learnerReply === undefined && !imageIds.length) throw new WebSessionError("Message cannot be empty", 400);
    if (record.busy) {
      throw new WebSessionError("The Agent is already responding", 409);
    }
    record.busy = true;
    record.abortRequested = false;
    record.modelFailed = false;
    const cancel = () => { record.abortRequested = true; void record.agent?.abort().catch(() => undefined); };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    let turnStarted = false;
    let turnFinalized = false;
    let responseCompleted = false;
    let finalizationSaved = false;
    let runStatus:TeacherRunStatus="model_error";
    let finalOverview: LearningOverview | undefined;
    let acceptedVoice: VoiceInputMetadata | undefined;
    let acceptedQuestionAnswer: LearnerQuestionsSnapshot["last_answer"] = null;
    let feedbackIncomplete = false;
    let initialOverview: LearningOverview | undefined;
    let deferredHandoffs: HelpEpisode[] = [];
    const earlierUserEntries = new Set(record.sessionManager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user").map(entry => entry.id));
    const earlierMessages = new Set(record.sessionManager.getBranch().filter(entry => entry.type === "message").map(entry => entry.id));
    try {
      const before = await this.loadOverview();
      initialOverview = before;
      this.assertCurrentConversation(record, before);
      record.routeRequest = undefined;
      // 本次真实聊天中明确要求先补基础才授予这一次进入意图；提案参数不能自报用户授权。
      if (!before.learning_paths?.active_branch_id && text.length <= 160 &&
          /(?:先|帮我|我想|需要|现在).{0,16}(?:补一下|补一补|补足|补习|补充基础|学一下|开.{0,3}分支)/.test(text) &&
          !/(?:不要|不想|不用|无需|别|是否|能不能|可不可以|[?？])/.test(text)) {
        const task = before.active_task as {id: string; activity_revision?: number} | null;
        record.routeRequest = {goalId: this.currentGoalId(before)!, taskId: task?.id ?? null, taskRevision: task?.activity_revision ?? 0,
          path: routePathKey(before), teaching: record.context.snapshot()};
      }
      if (expectedVersion !== undefined && expectedVersion !== this.classroomVersion(record, before)) throw new WebSessionError("学习现场已在其他设备变化，请更新后再发送。", 409);
      this.classroom.begin(sessionId);
      const submitSink = emit;
      emit = event => {try {submitSink(event);} catch { /* 页面断线不等于停止教师。 */ } this.classroom.event(sessionId, event);};
      // 在用户作答前固定帮助作用域；之后生成的新题不能倒改本次表现的归因。
      record.assistantSubmissionScope = this.assistantScope(record, before);
      this.invalidateStaleRecall(record, before);
      const beforeGoalId = this.currentGoalId(before);
      record.activeSink = emit;
      if (!record.context.learnerQuestions.snapshot().pending && /^(跳过|先继续学|之后再问|稍后再检查|结束本次检查)[。！!\s]*$/.test(text.trim())) {
        record.context.skipCheckpoint();
      }
      record.agent ??= await this.makeAgent(record);
      if(imageIds.length && record.agent.supportsImages?.()===false) throw new WebSessionError("当前教师模型不支持图片，请使用支持图片的模型。",422);
      const imageOwner=!["IDLE","INITIALIZED"].includes(record.planningContext.snapshot().status) ? "draft:"+sessionId : beforeGoalId;
      if(imageIds.length && this.activeSessionId!==sessionId) throw new WebSessionError("当前对话已切换，请重新选择图片。",409);
      if(imageIds.length && !imageOwner) throw new WebSessionError("图片需要属于当前目标或新目标草稿。",409);
      let images:Awaited<ReturnType<typeof loadTeachingImageBatch>>["images"]=[];
      let imageSources:TeachingImageSource[]=[];
      if(imageIds.some(id=>record.invalidatedMaterials.has(id)))
        throw new WebSessionError("本轮引用的资料已经删除，请重新选择附件。",409);
      if(imageIds.length) {
        record.activeImageMaterialIds=[...imageIds];
        record.imageReadAbort=new AbortController();
        try {
          const loaded=await loadTeachingImageBatch(imageIds,imageOwner ?? "",(this.apiBaseUrl ?? process.env.LEARNING_API_BASE_URL ?? "http://127.0.0.1:8000").replace(/\/$/,""),
            AbortSignal.any([...(signal?[signal]:[]),...(record.imageReadAbort?[record.imageReadAbort.signal]:[])]));
          images=loaded.images;imageSources=loaded.sources;
        } catch(error){if(record.abortRequested)return;throw new WebSessionError((error as Error).message,400);}
      }
      if(imageIds.length) {
        const current=await this.loadOverview();this.assertCurrentConversation(record,current);
        const owner=!["IDLE","INITIALIZED"].includes(record.planningContext.snapshot().status) ? "draft:"+sessionId : this.currentGoalId(current);
        if(owner!==imageOwner || this.activeSessionId!==sessionId) throw new WebSessionError("图片所属目标或对话已切换，请重新选择图片。",409);
        if(imageIds.some(id=>record.invalidatedMaterials.has(id)))
          throw new WebSessionError("本轮引用的资料在读取过程中已被删除，请重新选择附件。",409);
      }
      if (record.abortRequested) return;
      const questionsBefore = record.context.learnerQuestions.snapshot();
      // 用户专属决定先经过独立路由并保存票据；普通消息不能伪造组件确认或绕过掌握写入结果。
      if (learnerReply !== undefined && questionsBefore.pending?.purpose === "CONFIRM_MASTERY") {
        const submitted = new LearnerQuestionsContext();
        submitted.restore(questionsBefore, record.id);
        try {submitted.answer("", learnerReply);} catch (error) {
          throw new WebSessionError(error instanceof Error ? error.message : "掌握决定无效。", 400);
        }
        const accepted = submitted.snapshot().last_answer;
        const receipt = masteryDecisionReceipt(record.sessionManager, questionsBefore.pending.id);
        if (!accepted?.reply || !receipt || receipt.phase !== "APPLIED" || receipt.replyHash !== masteryReplyHash(accepted.reply))
          throw new WebSessionError("请先通过当前掌握确认组件提交决定。", 409);
      }
      const wasQuestion = Boolean(questionsBefore.pending) || questionsBefore.last_answer?.text === text.trim();
      const submittedText = text.trim();
      try {
        acceptedVoice = parseVoiceInputMetadata(voiceInput);
        if (acceptedVoice && !text.trim()) throw new Error("语音来源须对应实际文字；逐题补充请附在对应题目的回答中。");
        // 只有组件最终提交才是作答；聊天直接结束待答题，不读取或提交逐题草稿。
        // 模型失败后的原文重试沿用已经最终提交的答案，不能把普通聊天当成一次新提交。
        const retryingAnswer = learnerReply === undefined && !questionsBefore.pending && questionsBefore.last_answer?.text === text.trim();
        text = learnerReply !== undefined
          ? record.context.learnerQuestions.answer(text, learnerReply)
          : retryingAnswer ? text : record.context.interruptLearnerQuestion(text);
        acceptedQuestionAnswer = learnerReply !== undefined || retryingAnswer ? record.context.learnerQuestions.snapshot().last_answer : null;
      }
      catch (error) { throw new WebSessionError(error instanceof Error ? error.message : "回答无效。", 400); }
      this.cancelPlanning(record, "USER_TURN");
      if(imageIds.length) text+="\n[LAWA_MATERIAL_CONTEXT]\n"+imageIds.map((id,index)=>`本轮原图${index+1}（material_id: ${id}），已直接随本轮问题提供给视觉教师，请依据原图回答。`).join("\n")+"\n[/LAWA_MATERIAL_CONTEXT]";
      // 仅校验通过的真实提交封存；停止令牌/高水位/快照均同步固定，不等待 abort 或模型总结。
      try {
        const {run,sealed}=this.assistants.beginTeacherRun(sessionId,requestId as string|undefined,requestHash,record.assistantSubmissionScope,record.sessionManager);
        record.handoffRunId=run.id;
        deferredHandoffs = sealed;
      } catch {this.log("[handoff] 交接存储不可用，本轮继续原帮助归因。");}
      if (this.assistantOwner===sessionId) {++this.assistantGeneration;this.assistantBusy=false;this.assistantOwner=null;this.assistantStopRequested=false;}
      this.assistantScope(record,before,true);
      record.context.beginUserTurn(text, wasQuestion, acceptedVoice);
      // 只约束紧随本轮范读的精确照读；下一次用户回合就离开此边界，旧示范不永久降低帮助归因。
      const branch = record.sessionManager.getBranch();
      const lastUser = branch.findLastIndex(entry => entry.type === "message" && entry.message.role === "user");
      const latestSpeech = branch.slice(lastUser + 1).map(entry => this.speechFromEntry(entry, record.id)).findLast(item => item !== null);
      const taskBefore = before.active_task as { id?: string; status?: string } | null;
      const submittedParts = [submittedText, ...(acceptedQuestionAnswer?.reply?.answers.map(answer => answer.other_text) ?? [])];
      if (latestSpeech?.purpose === "repeat" && latestSpeech.goalId === beforeGoalId && taskBefore?.status === "ACTIVE" &&
          latestSpeech.taskId === taskBefore.id && submittedParts.some(part => part === latestSpeech.text)) record.context.noteSpeechReference();
      record.planningContext.beginUserTurn(text);
      const planningStatusBefore = record.planningContext.snapshot().status;
      // 人类回答先落入 Pi 元数据；模型停止/失败不撤销已经提交的真实选择。
      this.saveLearnerQuestions(record);
      // 页面在服务端确认接收后立即撤下已答选项；不等待后续模型生成，也不提前撤掉无效回答。
      if (questionsBefore.pending) emit({ type: "state", state: await this.viewState(record, before) });
      record.agent ??= await this.makeAgent(record);
      record.context.beginAgentTurn();
      turnStarted = true;
      const result=record.abortRequested ? {status:"stopped" as const} : await record.agent.prompt(text,images,imageSources);
      runStatus=record.abortRequested ? "stopped" : result?.status ?? (record.modelFailed ? "model_error" : "completed");
      feedbackIncomplete = result?.feedbackIncomplete === true;
      record.modelFailed=runStatus!=="completed";
      record.context.endAgentTurn(runStatus==="completed");
      turnFinalized = true;
      const overview = await this.loadOverview();
      finalOverview = overview;
      const planningStatusAfter = record.planningContext.snapshot().status;
      if ((runStatus === "completed" && !record.abortRequested && planningStatusAfter === "READY_FOR_CONFIRMATION") ||
          (planningStatusBefore !== "INITIALIZED" && planningStatusAfter === "INITIALIZED"))
        await this.ensurePlanningDecisionQuestion(record);
      if (this.currentGoalId(overview) !== beforeGoalId) record.context.invalidateCheckpoint();
      if (["IDLE", "INITIALIZED"].includes(record.planningContext.snapshot().status)) {
        this.observeGoal(record.sessionManager, overview);
      }
      const task = overview.active_task as { related_skill_ids?: string[] } | null;
      const goalId = this.currentGoalId(overview);
      const taught = record.context.snapshot().active_skill_id;
      const skillId = taught && task?.related_skill_ids?.includes(taught)
        ? taught
        : task?.related_skill_ids?.[0];
      if (goalId && skillId && this.conversationCatalog) {
        this.conversationCatalog.recordSkillAnchor(record.sessionManager, goalId, skillId);
      }
      responseCompleted = true;
    } finally {
      signal?.removeEventListener("abort", cancel);
      try {
        if (turnStarted && !turnFinalized) record.context.endAgentTurn(false);
        this.saveLearnerQuestions(record);
        if (turnStarted) {
          const source = record.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "user" && !earlierUserEntries.has(entry.id));
          if (source && initialOverview && ["model_error", "truncated", "persist_error"].includes(runStatus))
            saveFeedbackRecovery(record.sessionManager, initialOverview, source.id, feedbackIncomplete ? "assessment_failed" : "model_error", imageIds);
          else if (runStatus === "completed" || runStatus === "stopped") clearFeedbackRecovery(record.sessionManager);
        }
        if (turnStarted) this.saveVoiceInput(record, earlierUserEntries, acceptedVoice, acceptedQuestionAnswer);
        finalizationSaved = true;
        if (record.handoffRunId) {
          const entries=record.sessionManager.getBranch().filter(e=>e.type==="message" && !earlierMessages.has(e.id));
          const user=entries.find(e=>e.type==="message" && e.message.role==="user");
          // 回合成功与 Pi/元数据保存是前提；账本确认失败可重投，不声称跨文件原子提交。
          try {this.assistants.handoffs.finishRun(record.handoffRunId,runStatus,record.sessionManager,user?.id);}
          catch {finalizationSaved=false;throw new WebSessionError("对话已生成，但交接确认未能保存；帮助记录保留，下次可重新投递。",503);}
        }
      } catch (error) {
        if (record.handoffRunId) {
          try {this.assistants.handoffs.finishRun(record.handoffRunId,"persist_error",record.sessionManager);} catch { /* 故障窗口保留待投递，重启将 running 标为未确认。 */ }
        }
        throw error;
      } finally {
        // 磁盘保存失败也必须释放会话；错误继续交给 Gateway，不能让用户永远处于生成中。
        record.activeSink = undefined;
        record.busy = false;
        record.abortRequested = false;
        record.imageReadAbort=undefined;
        record.activeImageMaterialIds=undefined;
        record.modelFailed = false;
        record.assistantSubmissionScope = undefined;
        record.handoffRunId=undefined;
        if (this.materialReading && responseCompleted && finalizationSaved && runStatus === "completed" && finalOverview) {
          try {capturePlanningWait(record.sessionManager, record.planningContext.snapshot(), finalOverview);}
          catch {this.log("[planning-resume] wait could not be saved; explicit user continuation remains available");}
        }
        // Pi 已完成 message_end 持久化后再投影真实 entryId；停止/模型失败仍保留已成功的展示工具。
        if (turnStarted && record.sessionManager.getBranch().some(entry => entry.type === "message" && !earlierMessages.has(entry.id))) {
          emit({ type: "conversation_update", messages: this.classroomMessages(record) });
        }
        // 恢复票据落盘后投影一次最终状态，保持原消息协议以done结束。
        if (responseCompleted && finalizationSaved && finalOverview) emit({type: "state", state: await this.viewState(record, finalOverview)});
        if (responseCompleted && finalizationSaved) emit({ type: "done" });
        this.classroom.finish(sessionId, responseCompleted && finalizationSaved && runStatus === "completed");
        // 先结束前台回合再总结已封存的帮助；否则同账号单并发模型网关可能被后台总结抢占。
        this.assistants.handoffs.schedule(deferredHandoffs, this.summarizeHandoff, this.handoffTimeoutMs);
        this.wakePlanning();
      }
    }
  }

  async retryFeedback(sessionId: string, recoveryId: unknown, submit: (event: WebSessionEvent) => void,
    expectedVersion?: unknown): Promise<void> {
    if (this.changing) throw new WebSessionError("正在整理学习目标，请稍后重试。", 409);
    this.requireNoMasteryDecision();
    const record = this.require(sessionId);
    if (record.busy || this.assistantBusy) throw new WebSessionError("课堂正在生成，请等待本轮结束后再重试。", 409);
    const before = await this.loadOverview();
    this.assertCurrentConversation(record, before);
    if (record.busy || this.assistantBusy || this.changing) throw new WebSessionError("课堂正在生成，请等待本轮结束后再重试。", 409);
    this.requireNoMasteryDecision();
    const recovery = currentFeedbackRecovery(record.sessionManager, before);
    if (!recovery || recovery.id !== recoveryId || this.activeSessionId !== sessionId)
      throw new WebSessionError("这次反馈恢复已经失效或完成，请更新当前课堂。", 409);
    if (typeof expectedVersion !== "string" || expectedVersion !== this.classroomVersion(record, before))
      throw new WebSessionError("学习现场已变化，请更新后再重试本次反馈。", 409);
    record.busy = true; record.abortRequested = false; record.modelFailed = false;
    let turnStarted = false, turnFinished = false, completed = false, metadataSaved = false;
    let status: TeacherRunStatus = "model_error";
    let incomplete = recovery.reason === "assessment_failed";
    const emit = (event: WebSessionEvent) => {
      try {submit(event);} catch { /* 页面断线不取消已明确提交的恢复操作。 */ }
      this.classroom.event(sessionId, event);
    };
    try {
      this.classroom.begin(sessionId); record.activeSink = emit;
      record.assistantSubmissionScope = this.assistantScope(record, before);
      record.agent ??= await this.makeAgent(record);
      if (!record.agent.retryFeedback) throw new WebSessionError("当前教师运行时不支持反馈恢复，请重载本地服务。", 503);
      let images: Awaited<ReturnType<typeof loadTeachingImageBatch>>["images"] = [], imageSources: TeachingImageSource[] = [];
      if (recovery.imageMaterialIds.length) {
        record.activeImageMaterialIds = [...recovery.imageMaterialIds]; record.imageReadAbort = new AbortController();
        const loaded = await loadTeachingImageBatch(recovery.imageMaterialIds, recovery.goalId,
          (this.apiBaseUrl ?? "http://127.0.0.1:8000").replace(/\/$/, ""), record.imageReadAbort.signal);
        images = loaded.images; imageSources = loaded.sources;
      }
      const current = await this.loadOverview();
      if (record.abortRequested) {status = "stopped"; return;}
      if (this.activeSessionId !== sessionId || this.changing || this.classroomVersion(record, current) !== expectedVersion
          || currentFeedbackRecovery(record.sessionManager, current)?.id !== recovery.id)
        throw new WebSessionError("原作答的目标或任务已经变化，请回到当前课堂。", 409);
      // 不调用beginUserTurn、不重新收答案或封存帮助。只有显式恢复入口能继续同一个真实Pi回合。
      record.context.beginAgentTurn(); turnStarted = true;
      const result = await record.agent.retryFeedback({sourceUserEntryId: recovery.sourceUserEntryId}, images, imageSources);
      status = record.abortRequested ? "stopped" : result.status;
      incomplete = result.feedbackIncomplete === true;
      record.context.endAgentTurn(status === "completed"); turnFinished = true;
      completed = status === "completed";
    } finally {
      try {
        if (turnStarted && !turnFinished) record.context.endAgentTurn(false);
        this.saveLearnerQuestions(record);
        if (status === "completed" || status === "stopped") clearFeedbackRecovery(record.sessionManager);
        else saveFeedbackRecovery(record.sessionManager, before, recovery.sourceUserEntryId,
          incomplete ? "assessment_failed" : "model_error", recovery.imageMaterialIds, recovery);
        metadataSaved = true;
      } catch {
        status = "persist_error"; completed = false;
        throw new WebSessionError("反馈已生成，但恢复状态未能保存；原恢复入口保留，请检查本地存储后重试。", 503);
      } finally {
        record.activeSink = undefined; record.busy = false; record.abortRequested = false; record.modelFailed = false;
        record.assistantSubmissionScope = undefined; record.imageReadAbort = undefined; record.activeImageMaterialIds = undefined;
        this.classroom.finish(sessionId, completed);
        emit({type: "conversation_update", messages: this.classroomMessages(record)});
        emit({type: "state", state: await this.viewState(record, await this.loadOverview())});
        if (metadataSaved) emit({type: "done"});
        this.wakePlanning();
      }
    }
  }

  async stop(sessionId: string, expectedRunId?: unknown): Promise<void> {
    if (expectedRunId !== undefined && (this.classroom.snapshot()?.id !== expectedRunId || this.classroom.snapshot()?.sessionId !== sessionId)) throw new WebSessionError("生成回合已变化，请更新后再停止。", 409);
    const record = this.require(sessionId);
    record.abortRequested = true;
    if(record.animationRequestId){await record.agent?.abort();return;}
    const savedStop = this.cancelPlanning(record, "USER_STOP");
    record.imageReadAbort?.abort();
    this.assistants.handoffs.stop(sessionId);
    await record.agent?.abort();
    if (!savedStop) throw new WebSessionError("本轮生成已停止，但停止状态未能保存，请重试。", 503);
  }

  async skipActiveRecall(sessionId: string): Promise<WebLearningState> {
    const record = this.require(sessionId);
    if (record.busy) throw new WebSessionError("老师正在回复，请先停止生成。", 409);
    this.assertCurrentConversation(record, await this.loadOverview());
    record.context.skipCheckpoint();
    return this.state(sessionId);
  }

  async getProviderSettings(): Promise<PublicProviderCatalog> {
    return this.requireProviderSettings().getPublicSettings();
  }

  async testProviderConnection(
    input: ProviderSettingsInput,
  ): Promise<ProviderConnectionResult> {
    return this.requireProviderSettings().testConnection(input);
  }

  async saveProviderSettings(
    input: ProviderSettingsInput,
  ): Promise<PublicProviderCatalog> {
    this.requireIdleForModelChange();
    const applied = await this.requireProviderSettings().saveAndUse(input);
    await this.applyModel(applied.model, applied.thinkingLevel);
    return applied.settings;
  }

  async activateProviderProfile(profileId: string): Promise<PublicProviderCatalog> {
    this.requireIdleForModelChange();
    const applied = await this.requireProviderSettings().activate(profileId);
    await this.applyModel(applied.model, applied.thinkingLevel);
    return applied.settings;
  }

  async deleteProviderProfile(profileId: string): Promise<PublicProviderCatalog> {
    this.requireIdleForModelChange();
    return this.requireProviderSettings().delete(profileId);
  }

  private async applyModel(
    model: Model<Api>,
    thinkingLevel: ProviderThinkingLevel,
  ): Promise<void> {
    for (const record of this.sessions.values()) {
      if (!record.agent) continue;
      if (!record.agent.setModel) {
        throw new WebSessionError("当前 Agent runtime 不支持安全切换模型。", 500);
      }
      // 使用 Pi 原生 setModel() 会保留 session identity/messages，并由 Pi 在
      // JSONL 追加 model_change；这里不重建或伪造对话历史。
      await record.agent.setModel(model);
      if (!record.agent.setThinkingLevel) {
        throw new WebSessionError("当前 Agent runtime 不支持安全切换推理强度。", 500);
      }
      record.agent.setThinkingLevel(thinkingLevel);
    }
  }

  private requireIdleForModelChange(): void {
    // ARCHITECTURE-CRITICAL：Pi 不允许在活跃 turn 中途更换 model。
    // Gateway 先拒绝 busy 状态，避免同一 JSONL 出现半轮使用两个 Provider。
    if (this.assistantBusy || [...this.sessions.values()].some((record) => record.busy || record.masteryDecisionBusy)) {
      throw new WebSessionError(
        "课堂正在生成回复，请等待本轮结束或先停止生成再切换模型。",
        409,
      );
    }
  }

  private requireNoMasteryDecision(): void {
    if ([...this.sessions.values()].some(record => record.masteryDecisionBusy))
      throw new WebSessionError("正在保存掌握决定，请稍后重试。", 409);
  }

  async masteryDecision(sessionId: string, rawReply: unknown, expectedVersion?: unknown): Promise<{
    state: WebLearningState; continue_teaching: boolean;
  }> {
    this.requireIdleForConversationChange("提交掌握决定");
    const record = this.require(sessionId);
    if (this.activeSessionId !== sessionId) throw new WebSessionError("请在当前课堂提交掌握决定。", 409);
    const requestId = (rawReply as {request_id?: unknown} | null)?.request_id;
    if (typeof requestId !== "string") throw new WebSessionError("掌握决定缺少有效询问。", 400);
    record.masteryDecisionBusy = true;
    try {
      const before = await this.loadOverview();
      this.assertCurrentConversation(record, before);
      const original = record.context.learnerQuestions.snapshot();
      let receipt = masteryDecisionReceipt(record.sessionManager, requestId);
      const request = original.pending?.id === requestId && original.pending.purpose === "CONFIRM_MASTERY"
        ? original.pending : receipt?.request;
      if (!request || request.session_id !== record.id || !request.goal_id || !request.task_id || !request.skill_id)
        throw new WebSessionError("该掌握询问已失效，请刷新当前课堂。", 409);
      const parsed = new LearnerQuestionsContext();
      parsed.restore({pending: request, last_answer: null}, record.id);
      try {parsed.answer("", rawReply);} catch (error) {
        throw new WebSessionError(error instanceof Error ? error.message : "掌握决定无效。", 400);
      }
      const answer = parsed.snapshot().last_answer!;
      const decision = masteryReviewDecision(answer);
      if (!decision || !answer.reply) throw new WebSessionError("请选择确认、说明欠缺或暂不确认；确认和跳过不能附加相反意见。", 400);
      const replyHash = masteryReplyHash(answer.reply);
      if (receipt && receipt.replyHash !== replyHash)
        throw new WebSessionError("同一掌握询问已经提交其他决定，请刷新课堂。", 409);
      const confirmed = before.skills.some(value => {
        const skill = value as {id?: string; status?: string};
        return skill.id === request.skill_id && skill.status === "MASTERED_BY_USER";
      });
      const currentReview = this.conversationCatalog?.currentReview(record.sessionManager);
      const recoveringReview = Boolean(receipt?.review && (receipt.action === "confirm" && confirmed || receipt.action === "skip")
        && currentReview?.reviewTaskId === request.task_id && currentReview.skillId === request.skill_id
        && currentReview.goalId === this.currentGoalId(before));
      const scopeMatches = request.goal_id === this.currentGoalId(before)
        && request.scope_signature === masteryReviewSignature(before)
        && (before.active_task as {id?: string; related_skill_ids?: string[]} | null)?.id === request.task_id
        && (before.active_task as {related_skill_ids?: string[]} | null)?.related_skill_ids?.includes(request.skill_id);
      if (!scopeMatches && !recoveringReview || !receipt && confirmed) {
        if (original.pending?.purpose === "CONFIRM_MASTERY" && original.pending.id === request.id) {
          record.context.learnerQuestions.invalidate();
          this.saveLearnerQuestions(record);
        }
        throw new WebSessionError("学习目标、任务或掌握状态已变化，请更新后再决定。", 409);
      }
      if (expectedVersion !== undefined && expectedVersion !== this.classroomVersion(record, before)
          && (!receipt || expectedVersion !== receipt.expectedVersion))
        throw new WebSessionError("学习现场已在其他设备变化，请更新后再提交。", 409);
      if (!receipt) {
        receipt = {version: 1, request: structuredClone(request), action: decision.action, feedback: decision.feedback,
          reply: answer.reply, replyHash, phase: "INTENT", review: request.task_id.startsWith("review-"),
          ...(typeof expectedVersion === "string" ? {expectedVersion} : {})};
        // 先持久化真实选择，再调用用户API；失败恢复仅凭这张票据协调，不能从模型文字推断同意。
        saveMasteryDecisionReceipt(record.sessionManager, receipt);
      }
      if (receipt.phase === "APPLIED" && !receipt.review) {
        return {state: await this.viewState(record, before),
          continue_teaching: record.context.learnerQuestions.snapshot().pending?.id === request.id};
      }
      const finishingReview = receipt.review && ["confirm", "skip"].includes(decision.action);
      if (finishingReview && record.context.learnerQuestions.snapshot().pending?.id === request.id) {
        record.context.learnerQuestions.answer("", answer.reply);
        this.saveLearnerQuestions(record);
      }
      if (decision.action === "confirm") {
        try {
          if (!confirmed) await this.runSkillAction("master", request.skill_id,
            {goalId: request.goal_id, taskId: request.task_id});
        } catch (error) {
          // 网络返回丢失时读回Kernel；只有已保存的相同用户决定才允许协调，不重复调用掌握API。
          const after = await this.loadOverview().catch(() => undefined);
          const applied = after?.goal_profile && this.currentGoalId(after) === request.goal_id
            && (request.scope_signature === masteryReviewSignature(after) || receipt.review && recoveringReview)
            && after.skills.some(value => {
              const skill = value as {id?: string; status?: string};
              return skill.id === request.skill_id && skill.status === "MASTERED_BY_USER";
            });
          if (!applied) {
            if (receipt.review) {
              record.context.learnerQuestions.restore(original, record.id);
              this.saveLearnerQuestions(record);
            }
            throw error;
          }
        }
      }
      receipt = {...receipt, phase: "APPLIED"};
      saveMasteryDecisionReceipt(record.sessionManager, receipt);
      if (finishingReview) {
        // 复习中的“暂不确认”也是用户结束复习的决定：恢复暂停课堂，但绝不确认Mastery。
        const restored = await this.finishSkillReviewNow(request.task_id);
        return {state: {...restored.state, restored_session: restored}, continue_teaching: false};
      }
      return {state: await this.viewState(record, await this.loadOverview()), continue_teaching: true};
    } finally {record.masteryDecisionBusy = false;}
  }

  async skillAction(
    sessionId: string,
    action: "master" | "reopen" | "practice",
    skillId: string,
  ): Promise<WebLearningState> {
    this.requireNoMasteryDecision();
    const record = this.require(sessionId);
    const before = await this.loadOverview();
    this.assertCurrentConversation(record, before);
    const task = before.active_task as { id?: string; related_skill_ids?: string[] } | null;
    const completingReview = action === "master" && Boolean(task?.id?.startsWith("review-") && task.related_skill_ids?.includes(skillId));
    const legacyReview = action === "master" && this.conversationCatalog?.currentReview(record.sessionManager)?.skillId === skillId;
    if (completingReview || legacyReview) this.requireIdleForConversationChange("确认复习掌握并返回原任务");
    // Mastery/Reopen 是用户点击产生的直达路径；这里绝不调用 Pi Agent。
    this.requireNoMasteryDecision();
    await this.runSkillAction(action, skillId);
    if (completingReview && this.conversationCatalog) {
      // Kernel 已原子恢复 Task；再用已保存的 Pi 返回位置重建 runtime，完整投影给页面。
      // finish-review 是幂等用户入口，兼容旧 Kernel 或确认已成功但返回失败后的重试。
      const restored = await this.finishSkillReview(task!.id);
      return { ...restored.state, restored_session: restored };
    }
    if (legacyReview) {
      const restored = await this.create("resume-recent");
      return { ...restored.state, restored_session: restored };
    }
    return this.state(sessionId);
  }

  async startGoalOnboarding(
    sessionId: string,
    replaceExisting: boolean,
  ): Promise<WebLearningState> {
    this.requireIdleForConversationChange("重新设定目标");
    const record = this.require(sessionId);
    const overview = await this.loadOverview();
    this.requireIdleForConversationChange("重新设定目标");
    this.assertCurrentConversation(record, overview);
    if (overview.current_goal !== null && !replaceExisting) {
      throw new WebSessionError(
        "A current Goal already exists. Explicit replacement confirmation is required.",
        409,
      );
    }
    this.cancelPlanning(record, "ONBOARDING_RESTARTED");
    record.context.invalidateCheckpoint();
    const pending = record.planningContext.snapshot();
    const recoverable = pending.status === "IDLE" && replaceExisting
      ? this.confirmedGoalFromHistory(record, overview)
      : null;
    if (
      overview.current_goal !== null &&
      replaceExisting &&
      pending.status === "CONFIRMED" &&
      !pending.replace_existing
    ) {
      // 用户可以在已确认路线后补点「新目标」：只补授权，不丢掉这段会话的草案。
      record.planningContext.authorizeReplacement();
    } else if (
      overview.current_goal !== null &&
      replaceExisting &&
      pending.status === "IDLE" &&
      recoverable
    ) {
      // 仅在用户再次点击「新目标」时，从同一会话的成功 Tool Result 恢复草案。
      record.planningContext.restoreConfirmedForReplacement(recoverable);
    } else {
      record.planningContext.start({
        replaceExisting: overview.current_goal !== null && replaceExisting,
      });
    }
    // 每次显式重开都固定新的周期边界，旧完成检查点不能把新引导误判为已初始化。
    record.sessionManager.appendCustomEntry("lawa.goal-onboarding-started", { replaceExisting: overview.current_goal !== null && replaceExisting });
    return this.viewState(record, overview);
  }

  async abandonTask(sessionId: string, taskId: string): Promise<WebLearningState> {
    const record = this.require(sessionId);
    this.assertCurrentConversation(record, await this.loadOverview());
    // Goal replacement 不得偷偷结束旧 Task；只有用户点击此入口才执行 User API。
    // 该动作与 Mastery 一样不进入 Pi Session 或消息历史。
    await this.runTaskAction(taskId);
    return this.state(sessionId);
  }

  async setCardFeedback(cardId: string, status: string): Promise<unknown> {
    // 知识卡片是跨 Conversation 的长期资产；自评只由用户入口触发。
    // Agent 只有建卡权，不能在这里或任何 Tool 中替用户自评。
    return this.runCardAction("feedback", cardId, { status });
  }

  async setCardNote(cardId: string, note: string): Promise<unknown> {
    return this.runCardAction("note-set", cardId, { note });
  }

  async clearCardNote(cardId: string): Promise<unknown> {
    return this.runCardAction("note-clear", cardId);
  }

  async deleteCard(cardId: string): Promise<unknown> {
    return this.runCardAction("delete", cardId);
  }

  async updateCard(cardId: string, question: string, answer: string): Promise<unknown> {
    return this.runCardAction("update", cardId, { question, answer });
  }

  dispose(): void {
    this.planningDisposed = true; this.planningLife.abort(); this.planningUnsubscribe?.();
    if (this.planningRetry) clearTimeout(this.planningRetry);
    this.materialReading?.dispose();
    this.assistants.handoffs.stop();
    void this.assistants.stop();
    for (const record of this.sessions.values()) record.agent?.dispose();
    this.sessions.clear();
    this.activeSessionId = null;
  }

  private require(sessionId: string): WebSessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw new WebSessionError("Browser session not found", 404);
    return record;
  }

  private async makeAgent(record: WebSessionRecord): Promise<LearningAgentSession> {
    const emit = (event: LearningAgentEvent) => {
      if (event.type === "model_error" || event.type === "output_limit") record.modelFailed = true;
      record.activeSink?.(event);
    };
    const branchProposed = (branch: LearningBranch) => this.enterExplicitlyRequestedBranch(record, branch);
    if (this.createAgentRuntime) {
      return this.createAgentRuntime(
        record.context,
        record.planningContext,
        emit,
        record.sessionManager,
        branchProposed,
      );
    }
    const binding = await this.providerSettings?.getActiveRuntime();
    return createLearningAgentSession(record.context, record.planningContext, {
      branchProposed,
      planningResumeCurrent: () => !this.planningDisposed && this.activeSessionId === record.id
        && this.sessions.get(record.id) === record && record.busy && !record.abortRequested && !this.changing,
      materialReading: this.materialReading,
      handoffs:maxChars=>record.handoffRunId ? this.assistants.handoffs.freeze(record.handoffRunId,maxChars) : [],
      assistantSupport:{read:async () => {
        const scope = record.assistantSubmissionScope !== undefined ? record.assistantSubmissionScope
          : this.assistantScope(record,await this.loadOverview());
        return scope ? this.assistants.getAssistance(scope,true) : {kind:"NONE",revision:"empty",summary:"没有关联助教答疑。",records:[],priorRecords:[],unknown:false,hasHelp:false,truncated:false};
      }},
      studyTiming: this.studyTiming,
      speechStatus: this.speechStatus,
      apiBaseUrl: this.apiBaseUrl,
      onEvent: emit,
      lessonArt:this.lessonArt,
      log: this.log,
      sessionManager: record.sessionManager,
      surface: "WEB",
      modelRuntime: binding?.runtime,
      model: binding?.model,
      thinkingLevel: binding?.thinkingLevel,
    });
  }

  private requireProviderSettings(): ProviderSettingsCoordinator {
    if (!this.providerSettings) {
      throw new WebSessionError("Provider 设置服务不可用。", 503);
    }
    return this.providerSettings;
  }

  private async enterExplicitlyRequestedBranch(record: WebSessionRecord, branch: LearningBranch): Promise<unknown> {
    const intent = record.routeRequest;
    if (!intent || record.abortRequested || branch.goal_id !== intent.goalId || branch.purpose !== "prerequisite") return;
    // 只承接本轮用户明确的补足请求。模型提案本身不构成授权，旧请求不能跨轮复用。
    record.routeRequest = undefined;
    saveRouteState(record.sessionManager, intent.path, intent.teaching);
    await this.postKernel(`/api/user/learning-branches/${encodeURIComponent(branch.id)}/transition`, {
      action: "enter", operation_id: randomUUID(), expected_revision: branch.revision,
      expected_goal_id: intent.goalId, expected_task_id: intent.taskId, expected_task_revision: intent.taskRevision,
    });
    const overview = await this.loadOverview();
    record.routePath = routePathKey(overview);
    record.context.restoreLearningPath(readRouteState(record.sessionManager, record.routePath));
    const startEntryId = record.sessionManager.getBranch().findLast(e => e.type === "message" && e.message.role === "user")?.id;
    record.sessionManager.appendCustomEntry(ROUTE_TRANSITION, {branchId: branch.id, action: "enter", path: record.routePath, startEntryId});
    this.saveLearnerQuestions(record);
    record.activeSink?.({type: "state", state: await this.viewState(record, overview)});
    record.activeSink?.({type: "conversation_update", messages: this.classroomMessages(record), routeChanged: true});
    return {entered: true, learning_context: projectLearningContext(overview)};
  }

  private requireConversationCatalog(): ConversationCatalog {
    if (!this.conversationCatalog) {
      throw new WebSessionError("对话库仅在持久化 Web 会话中可用。", 503);
    }
    return this.conversationCatalog;
  }

  private requireIdleForConversationChange(action: string): void {
    if (this.changing) throw new WebSessionError("正在整理学习目标，请稍后重试。", 409);
    if (this.assistantBusy || [...this.sessions.values()].some((record) => record.busy || record.masteryDecisionBusy)) {
      throw new WebSessionError(
        `课堂正在生成回复，请先停止或等待本轮结束再${action}。`,
        409,
      );
    }
  }

  private releaseActiveRecord(): void {
    if (!this.activeSessionId) return;
    const active = this.sessions.get(this.activeSessionId);
    active?.agent?.dispose();
    this.sessions.clear();
    this.activeSessionId = null;
  }

  private createRecord(
    sessionManager: SessionManager,
    overview: LearningOverview,
  ): WebSessionRecord {
    const record: WebSessionRecord = {
      id: sessionManager.getSessionId() || randomUUID(),
      context: new TeachingSessionContext(),
      planningContext: new GoalOnboardingContext(),
      sessionManager,
      busy: false,
      invalidatedMaterials:new Set(),
      voiceScopeId: randomUUID(),
    };
    record.context.bindSession(record.id);
    record.routePath = routePathKey(overview);
    const deliveries = teacherVisibility(sessionManager).deliveries;
    const savedQuestions = [...sessionManager.getBranch()].reverse().find((entry) => entry.type === "custom" && (entry.customType === LEARNER_QUESTIONS_ENTRY || deliveries.has(entry.id)));
    if (savedQuestions?.type === "custom") {
      try { record.context.learnerQuestions.restore(savedQuestionSnapshot(savedQuestions) ?? savedQuestions.data as LearnerQuestionsSnapshot, record.id); }
      catch { this.log("[web] invalid learner question metadata ignored"); }
    }
    const pathState = readRouteState(sessionManager, record.routePath);
    if (pathState || overview.learning_paths?.active_branch_id) {
      const activeTaskId = (overview.active_task as {id?: string} | null)?.id;
      const helped = !overview.learning_paths?.active_branch_id && overview.learning_paths?.branches.some(b => b.return_task_id === activeTaskId && b.assistance_provided);
      record.context.restoreLearningPath(pathState, Boolean(helped));
    }
    // 恢复草案内容，但不从旧确认回执授予新的初始化权限。
    // 成功初始化的 Tool Result 结束阻挡；重启不能让未完成的新目标恢复上传到旧目标。
    const pending = this.pendingGoalDraft(sessionManager);
    if (pending) record.planningContext.start({ replaceExisting: pending.replaceExisting === true });
    if (overview.current_goal === null) record.planningContext.start();
    if (!pending && overview.imported_goal_needs_route && overview.goal_profile) {
      const raw = overview.goal_profile as GoalProfileInput;
      const profile: GoalProfileInput = {id: raw.id, goal_description: raw.goal_description,
        background_summary: raw.background_summary, desired_outcome: raw.desired_outcome,
        learning_domain: raw.learning_domain, learning_preferences: raw.learning_preferences ?? [],
        time_constraint: raw.time_constraint ?? "", prior_knowledge_claims: raw.prior_knowledge_claims ?? []};
      record.planningContext.startImported(profile);
      // 确认回执绑定规范化后的草案；空领域等可选字段不能让刚发出的确认立即失效。
      const importedProfile = record.planningContext.snapshot().pending_profile!;
      const importedSignature = goalConfirmationSignature(importedProfile);
      const question = record.context.learnerQuestions.snapshot().pending;
      if (!question || question.purpose !== "CONFIRM_GOAL" || question.goal_id !== importedProfile.id || question.scope_signature !== importedSignature) {
        record.context.learnerQuestions.invalidate();
        record.context.learnerQuestions.ask({id: randomUUID(), purpose: "CONFIRM_GOAL", session_id: record.id,
          goal_id: importedProfile.id, task_id: null, skill_id: null, scope_signature: importedSignature,
          questions: [{id: "confirm-import-route", prompt: "保留已有记录，按这个目标补充接下来的学习路线吗？", selection: "single",
            options: [{id: "proceed", label: "确认"}]}]});
        this.saveLearnerQuestions(record);
      }
    }
    try {
      const wait = latestPlanningWait(sessionManager);
      if (pending && wait && provePlanningWait(sessionManager, wait) && (wait.data.state !== "CANCELED" || wait.data.reason === "USER_STOP")
          && wait.data.state !== "COMPLETED") record.planningContext.restoreReadingWait(wait.data.snapshot);
    } catch {this.log("[planning-resume] invalid wait metadata retained without automatic restore");}
    if (pending && record.planningContext.snapshot().status === "NEEDS_CLARIFICATION") {
      const draft = this.unconfirmedGoalDraft(sessionManager);
      if (draft) {
        record.planningContext.restoreUnconfirmedDraft({...draft, replace_existing: pending.replaceExisting === true});
        const question = record.context.learnerQuestions.snapshot().pending;
        if (question?.purpose === "CONFIRM_GOAL" && (question.session_id !== record.id || question.goal_id !== draft.pending_profile!.id ||
            question.scope_signature !== goalConfirmationSignature(draft.pending_profile!))) record.context.learnerQuestions.invalidate();
        if (record.planningContext.snapshot().status === "READY_FOR_CONFIRMATION" &&
            !record.context.learnerQuestions.snapshot().pending) {
          // 已消费的旧卡失效后提供同一草案的新确认入口，不能停在“建立中”或凭旧同意自动执行。
          record.context.learnerQuestions.invalidate();
          record.context.learnerQuestions.ask({id: randomUUID(), purpose: "CONFIRM_GOAL", session_id: record.id,
            goal_id: draft.pending_profile!.id, task_id: null, skill_id: null,
            scope_signature: goalConfirmationSignature(draft.pending_profile!),
            questions: [{id: "confirm-goal", prompt: "上次未完成的目标草案已保留。仍按这个目标继续吗？", selection: "single",
              options: [{id: "proceed", label: "确认"}]}]});
          this.saveLearnerQuestions(record);
        }
      }
    }
    return record;
  }

  private unconfirmedGoalDraft(manager: SessionManager): GoalOnboardingSnapshot | null {
    for (const entry of [...manager.getBranch()].reverse()) {
      if (entry.type === "custom" && entry.customType === "lawa.goal-onboarding-started") return null;
      if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError ||
          entry.message.toolName !== "record_goal_understanding") continue;
      try {
        const snapshot = JSON.parse(entry.message.content.filter(part => part.type === "text").map(part => part.text).join("\n")) as GoalOnboardingSnapshot;
        const profile = snapshot.pending_profile;
        if (!profile || snapshot.reading_requirement || !["READY_FOR_CONFIRMATION", "CONFIRMED", "NEEDS_CLARIFICATION"].includes(snapshot.status) ||
            ![profile.id, profile.goal_description, profile.background_summary, profile.desired_outcome, profile.time_constraint].every(value => typeof value === "string") ||
            !Array.isArray(profile.learning_preferences) || !profile.learning_preferences.every(value => typeof value === "string") ||
            !Array.isArray(profile.prior_knowledge_claims) || !profile.prior_knowledge_claims.every(value => typeof value === "string") ||
            !Array.isArray(snapshot.missing_information) || !snapshot.missing_information.every(value => typeof value === "string")) return null;
        return snapshot;
      } catch {return null;}
    }
    return null;
  }

  private pendingGoalDraft(manager: SessionManager): { replaceExisting?: boolean } | null {
    let completedEntry: string | undefined;
    try {const wait = latestPlanningWait(manager); if (wait?.data.state === "COMPLETED") completedEntry = wait.entryId;} catch { /* 未核验的机器记录不结束草稿。 */ }
    for (const entry of [...manager.getBranch()].reverse()) {
      if (entry.id === completedEntry) return null;
      if (entry.type === "message" && entry.message.role === "toolResult" &&
          entry.message.toolName === "initialize_learning_goal" && !entry.message.isError) return null;
      if (entry.type === "custom" && entry.customType === "lawa.goal-onboarding-started") {
        return entry.data as { replaceExisting?: boolean };
      }
    }
    return null;
  }

  private async restoreConversationGoal(manager: SessionManager, overview: LearningOverview): Promise<LearningOverview> {
    // 选择会话就是用户恢复学习位置的动作，沿用已有用户 Goal activate 权限。
    // 未确认的草稿不借旧 Goal 标记切换目标；Skill 预览也不会调用这个入口。
    if (this.pendingGoalDraft(manager)) return overview;
    const goalId = this.conversationCatalog?.goalObservation(manager)?.goalId;
    if (!goalId || goalId === this.currentGoalId(overview)) return overview;
    let library: LearningLibrary;
    try { library = await this.loadLibrary(); }
    catch { return overview; } // 无可靠 Kernel 项目时沿用 unavailable 只读视图。
    if (!library.projects.some((project) => (project.goal_profile as { id?: string }).id === goalId)) return overview;
    await this.postKernel(`/api/user/goals/${encodeURIComponent(goalId)}/activate`);
    return this.loadOverview();
  }

  private confirmedGoalFromHistory(
    record: WebSessionRecord,
    overview: LearningOverview,
  ): GoalProfileInput | null {
    const currentGoalId = typeof overview.goal_profile === "object" && overview.goal_profile !== null
      ? (overview.goal_profile as { id?: unknown }).id
      : null;
    for (const entry of [...record.sessionManager.getBranch()].reverse()) {
      if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError) continue;
      if (entry.message.toolName === "initialize_learning_goal") return null;
      if (entry.message.toolName !== "record_goal_understanding") continue;
      const content = entry.message.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      let result: unknown;
      try { result = JSON.parse(content); } catch { return null; }
      if (typeof result !== "object" || result === null) return null;
      const snapshot = result as { status?: unknown; pending_profile?: unknown };
      if (snapshot.status !== "CONFIRMED") return null;
      const profile = snapshot.pending_profile;
      if (typeof profile !== "object" || profile === null) return null;
      const candidate = profile as Record<string, unknown>;
      if (typeof candidate.id !== "string" || !candidate.id.trim() || candidate.id === currentGoalId) return null;
      if (
        typeof candidate.goal_description !== "string" ||
        typeof candidate.background_summary !== "string" ||
        typeof candidate.desired_outcome !== "string" ||
        typeof candidate.time_constraint !== "string" ||
        !Array.isArray(candidate.learning_preferences) ||
        !candidate.learning_preferences.every((item) => typeof item === "string") ||
        !Array.isArray(candidate.prior_knowledge_claims) ||
        !candidate.prior_knowledge_claims.every((item) => typeof item === "string")
      ) return null;
      return structuredClone(candidate) as unknown as GoalProfileInput;
    }
    return null;
  }

  private currentGoalId(overview: LearningOverview): string | null {
    const profile = overview.goal_profile;
    if (typeof profile !== "object" || profile === null) return null;
    const id = (profile as Record<string, unknown>).id;
    return typeof id === "string" ? id : null;
  }

  private assertCurrentConversation(record: WebSessionRecord, overview: LearningOverview): void {
    const associated = this.conversationCatalog?.goalObservation(record.sessionManager);
    if (associated?.goalId && associated.goalId !== this.currentGoalId(overview)) {
      throw new WebSessionError(
        "这是历史目标的对话。可查看路线和记录，但不能在此对话继续教学或修改技能；请切回当前目标对话。",
        409,
      );
    }
  }

  private async viewState(
    record: WebSessionRecord,
    authoritative: LearningOverview,
    previewGoalId?: string,
  ): Promise<WebLearningState> {
    this.invalidateStaleRecall(record, authoritative);
    // 首课可能早于轮末 Goal 标记。原学习位置已由 Goal/Skill 锚点校验，预览按请求的 Goal
    // 读取 Kernel 投影；不能因 Pi 祖先缺少标记（或仍是旧 Goal）而套用其他目标的资料。
    const associated = previewGoalId
      ? { goalId: previewGoalId, goalDescription: previewGoalId }
      : this.conversationCatalog?.goalObservation(record.sessionManager);
    if (!associated?.goalId || associated.goalId === this.currentGoalId(authoritative)) {
      return this.toState(record, authoritative, "CURRENT", authoritative);
    }

    // 对话归属只提供稳定的 Goal ID；所有路线、技能、证据和卡片仍从 Kernel 学习库读取。
    // 此处只生成资料视图，绝不隐式激活 Goal；用户对话导航在独立入口恢复工作区。
    let projects: LearningLibrary["projects"] = [];
    try {
      projects = (await this.loadLibrary()).projects;
    } catch {
      // 历史 Project 暂时不可读也允许打开聊天；宁可显示不可用，不能冒充当前 Goal。
      this.log("[web] historical learning project unavailable");
    }
    const project = projects.find(
      (candidate) => (candidate.goal_profile as { id?: unknown }).id === associated.goalId,
    );
    const profile = project?.goal_profile as Record<string, unknown> | undefined;
    const historical: LearningOverview = {
      ...authoritative,
      current_goal: typeof profile?.goal_description === "string"
        ? profile.goal_description
        : associated.goalDescription,
      goal_profile: project?.goal_profile ?? null,
      curriculum_spine: project?.curriculum_spine ?? [],
      current_frontier: null,
      current_focus: null,
      skills: project?.skills ?? [],
      recent_evidence: project?.evidence ?? [],
      active_task: null,
      current_goal_skill_ids: (project?.skills ?? []).flatMap((skill) => {
        const id = typeof skill === "object" && skill !== null
          ? (skill as Record<string, unknown>).id
          : null;
        return typeof id === "string" ? [id] : [];
      }),
      knowledge_cards: project?.knowledge_cards ?? [],
    };
    return this.toState(
      record,
      historical,
      project ? "ARCHIVED" : "UNAVAILABLE",
      authoritative,
    );
  }

  private invalidateStaleRecall(record: WebSessionRecord, authoritative: LearningOverview): void {
    const questions = record.context.learnerQuestions.snapshot();
    const questionScope = questions.pending ?? questions.last_answer?.request;
    const taskScope = authoritative.active_task as { id?: string; related_skill_ids?: string[] } | null;
    const planning = record.planningContext.snapshot();
    // 决策不能仅绑定 ID：同一草案被修改、Frontier/Task 改变或临时草案未恢复时，历史按钮不再授予同意。
    if (questionScope && (questionScope.session_id !== record.id ||
      (questionScope.purpose === "CHECK" && (questionScope.goal_id !== this.currentGoalId(authoritative) || questionScope.task_id !== taskScope?.id || !taskScope?.related_skill_ids?.includes(questionScope.skill_id ?? ""))) ||
      (questionScope.purpose === "CONFIRM_MASTERY" && (questionScope.goal_id !== this.currentGoalId(authoritative)
        || questionScope.task_id !== taskScope?.id || !taskScope?.related_skill_ids?.includes(questionScope.skill_id ?? "")
        || questionScope.scope_signature !== masteryReviewSignature(authoritative)
        || authoritative.skills.some(value => {
          const skill = value as {id?: string; status?: string};
          return skill.id === questionScope.skill_id && skill.status === "MASTERED_BY_USER"
            && masteryDecisionReceipt(record.sessionManager, questionScope.id)?.action !== "confirm";
        }))) ||
      (questionScope.purpose === "BACKGROUND" && ["IDLE", "INITIALIZED"].includes(planning.status)) ||
      (questionScope.purpose === "CONFIRM_GOAL" && (planning.status !== "READY_FOR_CONFIRMATION" || !planning.pending_profile ||
        questionScope.goal_id !== planning.pending_profile.id || questionScope.scope_signature !== goalConfirmationSignature(planning.pending_profile, planning.reading_requirement?.id))) ||
      (questionScope.purpose === "START_LEARNING" && (!["IDLE", "INITIALIZED"].includes(planning.status) ||
        questionScope.goal_id !== this.currentGoalId(authoritative) || questionScope.scope_signature !== learningStartSignature(authoritative))) ||
      (questionScope.purpose === "CONFIRM_PLAN_REVISION" && (
        !questionScope.plan_revision_id || questionScope.goal_id !== this.currentGoalId(authoritative) ||
        questionScope.plan_revision_base !== (authoritative.plan_revision ?? 0))))) record.context.learnerQuestions.invalidate();
    // 浏览器切换 Goal/Task/分支后以 Kernel 为准淘汰临时检查和未提交候选；Pi 历史消息不回滚。
    const recall = record.context.activeRecall.snapshot() ?? record.context.pendingCheckpointEvidenceScope();
    const currentTask = authoritative.active_task as { id?: string; related_skill_ids?: string[] } | null;
    if (recall && (
      recall.goal_id !== this.currentGoalId(authoritative) ||
      recall.session_id !== record.id ||
      recall.task_id !== currentTask?.id ||
      !currentTask?.related_skill_ids?.includes(recall.skill_id)
    )) record.context.invalidateCheckpoint();
  }

  private async payload(
    record: WebSessionRecord,
    overview: LearningOverview,
  ): Promise<WebSessionPayload> {
    if (this.activeSessionId === record.id) queueMicrotask(() => this.wakePlanning());
    return {
      sessionId: record.id,
      state: await this.viewState(record, overview),
      messages: this.classroomMessages(record),
      branches: this.conversationCatalog?.branches(record.sessionManager, this.currentGoalId(overview)) ?? [],
    };
  }

  private saveLearnerQuestions(record: WebSessionRecord): void {
    if (record.routePath && (!record.routePath.endsWith(":main") || readRouteState(record.sessionManager, record.routePath)))
      saveRouteState(record.sessionManager, record.routePath, record.context.snapshot());
    const snapshot = record.context.learnerQuestions.snapshot();
    const previous = [...record.sessionManager.getBranch()].reverse().find((entry) => entry.type === "custom" && entry.customType === LEARNER_QUESTIONS_ENTRY);
    if ((!previous && !snapshot.pending && !snapshot.last_answer) || (previous?.type === "custom" && JSON.stringify(previous.data) === JSON.stringify(snapshot))) return;
    record.sessionManager.appendCustomEntry(LEARNER_QUESTIONS_ENTRY, snapshot);
  }

  private saveVoiceInput(record: WebSessionRecord, earlierUsers: Set<string>, voice: VoiceInputMetadata | undefined,
    answered: LearnerQuestionsSnapshot["last_answer"]): void {
    const questionInputs = answered?.reply?.answers.flatMap(answer => answer.voice_input
      ? [{ question_id: answer.question_id, voice_input: answer.voice_input }] : []) ?? [];
    if (!voice && !questionInputs.length) return;
    const user = record.sessionManager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user" && !earlierUsers.has(entry.id));
    if (!user) return;
    record.sessionManager.appendCustomEntry("lawa.voice-input", { userEntryId: user.id,
      ...(voice ? { voice_input: voice } : {}),
      ...(questionInputs.length && answered ? { learner_reply: { request_id: answered.request.id, answers: questionInputs } } : {}) });
  }

  private speechFromEntry(entry: SessionEntry | undefined, sourceSessionId: string): SpeechPresentation | null {
    if (!entry || entry.type !== "message" || entry.message.role !== "toolResult" ||
        entry.message.toolName !== "present_speech" || entry.message.isError !== false) return null;
    const details = entry.message.details as { speech?: unknown } | undefined;
    const speech = readSpeechPresentation(details?.speech);
    return speech?.sourceSessionId === sourceSessionId ? speech : null;
  }

  private observeGoal(manager: SessionManager, overview: LearningOverview): void {
    const record = this.sessions.get(manager.getSessionId());
    if (record) record.routePath = routePathKey(overview);
    if (!this.conversationCatalog) return;
    const goalProfile = typeof overview.goal_profile === "object" && overview.goal_profile
      ? overview.goal_profile as Record<string, unknown>
      : null;
    const goalId = typeof goalProfile?.id === "string" ? goalProfile.id : null;
    this.conversationCatalog.recordGoal(manager, goalId, overview.current_goal);
  }

  private classroomMessages(record: WebSessionRecord): WebConversationMessage[] {
    return this.visibleMessages(record.sessionManager, undefined,
      routeMessageIds(record.sessionManager, record.routePath ?? "draft:main"));
  }

  // 历史定位、笔记引用仍可读取完整链；课堂投影在组件去重前筛选，避免别的路线吞掉本路线组件。
  private visibleMessages(sessionManager: SessionManager, entryId?: string, messageIds?: Set<string>): WebConversationMessage[] {
    const visibility = teacherVisibility(sessionManager);
    const shownAssessments = new Set<string>();
    let figures:PlacedFigure[]=[];
    const requests=animationRequests(sessionManager);
    const messages=sessionManager
      .getBranch(entryId)
      .flatMap((entry): WebConversationMessage[] => {
        // 即使某条用户消息属于另一条路线，它仍结束上一轮图址的作用域。
        if (entry.type==="message" && entry.message.role==="user") figures=[];
        if (messageIds && !messageIds.has(entry.id)) return [];
        if (entry.type==="message" && entry.message.role==="toolResult" && entry.message.toolName===FIGURE_TOOL && !entry.message.isError) {
          const batch=readFigureBatch((entry.message.details as {lessonFigures?:unknown}|undefined)?.lessonFigures);
          if (batch?.sessionId===sessionManager.getSessionId()) figures=mergeFigures(figures,placedFigures(batch));
          return [];
        }
        if(entry.type==="message"&&entry.message.role==="toolResult"&&entry.message.toolName==="present_explainer_animation"&&entry.message.isError===false){
          const explainer=readExplainerPresentation((entry.message.details as {explainer?:unknown}|undefined)?.explainer);
          return explainer?[{role:"assistant",content:"",entryId:entry.id,explainer:{...explainer,entryId:entry.id}}]:
            [{role:"assistant",content:"这段讲解动画的版本暂时无法播放。",entryId:entry.id}];
        }
        if(entry.type==="message"&&entry.message.role==="toolResult"&&entry.message.toolName==="present_teaching_animation"&&entry.message.isError===false){
          const raw=(entry.message.details as {animation?:unknown}|undefined)?.animation;
          const animation=readAnimationPresentation(raw);
          if(animation)return [{role:"assistant",content:"",entryId:entry.id,animation:{...animation,entryId:entry.id}}];
          // 未知旧绘制/校验版本只投影有界历史字幕，绝不执行或用新版替换旧材料。
          const lesson=(raw as {artifact?:{lesson?:{title?:unknown;scenes?:Array<{caption?:unknown}>}}}|undefined)?.artifact?.lesson;
          const captions=Array.isArray(lesson?.scenes)?lesson.scenes.slice(0,12).flatMap(scene=>typeof scene?.caption==="string"?[scene.caption.slice(0,140)]:[]):[];
          return [{role:"assistant",entryId:entry.id,content:"这段历史演示的版本暂时无法播放。"+(captions.length?"\n\n保存的字幕：\n"+captions.map(caption=>"- "+caption).join("\n"):"")}];
        }
        if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "record_answer_assessment" && entry.message.isError === false) {
          const assessment = readAnswerAssessment((entry.message.details as {assessment?: unknown} | undefined)?.assessment);
          if (assessment && !shownAssessments.has(assessment.id)) {
            shownAssessments.add(assessment.id);
            return [{role: "assistant", content: "", entryId: entry.id, assessment}];
          }
        }
        const speech = this.speechFromEntry(entry, sessionManager.getSessionId());
        if (speech) return [{ role: "assistant", content: "", entryId: entry.id, speech: { ...speech, entryId: entry.id } }];
        if (entry.type !== "message") return [];
        const message = entry.message;
        const messageId = entry.id;
        if (message.role !== "user" && message.role !== "assistant") return [];
        const rawText = typeof message.content === "string"
          ? message.content
          : message.content
              .filter(
                (item): item is { type: "text"; text: string } =>
                  item.type === "text" && typeof item.text === "string",
              )
              .map((item) => item.text)
              .join("\n");
        const raw = message.role === "assistant" ? visibility.texts.get(entry.id) ?? (visibility.hidden.has(entry.id) ? "" : rawText) : rawText;
        // 材料引用块只给老师读取资料用，用户气泡投影时整段剥离，保持和输入框一致的干净体验。
        const content = message.role === "user" ? stripMaterialContext(raw) : raw;
        // 纯附件回答剥离引用后文字为空，但仍是真实用户entry；保留以便页面对齐原附件。
        const attachments = message.role === "user" ? projectConversationAttachments(raw) : [];
        const inlineFigures=message.role==="assistant"?referencedFigures(content,figures):[];
        return content.trim() || (message.role === "user" && raw.trim()) ? [{ role: message.role, content, entryId: messageId,
          ...(inlineFigures.length ? {figures:inlineFigures} : {}),
          ...(attachments.length ? {attachments} : {}) }] : [];
      });
    return messages.map(message=>{
      const request=message.role==="user"?requests.findLast(item=>item.sourceUserEntryId===message.entryId):undefined;
      return request?{...message,animation_question:{presentation_id:request.anchor.presentation_id,source_entry_id:request.anchor.source_entry_id,title:request.title,scene_id:request.anchor.scene_id}}:message;
    });
  }

  private toState(
    record: WebSessionRecord,
    overview: LearningOverview,
    viewMode: WebLearningState["view_mode"],
    authoritative: LearningOverview,
  ): WebLearningState {
    const frontier = typeof overview.current_frontier === "object" && overview.current_frontier
      ? overview.current_frontier as Record<string, unknown>
      : null;
    const focusSkillId = typeof frontier?.focus_skill_id === "string"
      ? frontier.focus_skill_id
      : null;
    const nextAction = typeof frontier?.next_action === "string"
      ? frontier.next_action
      : null;
    const focusSkill = focusSkillId
      ? overview.skills.find(
          (skill) =>
            typeof skill === "object" &&
            skill !== null &&
            (skill as Record<string, unknown>).id === focusSkillId,
        ) as Record<string, unknown> | undefined
      : undefined;
    // Frontier 是 Planner 的工作假设，不是历史事实。焦点 Skill 已由用户确认掌握后，
    // 旧 next_action 只能标记为过期，不能继续伪装成“推荐下一步”。
    const recommendedAction = viewMode !== "CURRENT" || overview.active_task || !nextAction
      ? null
      : focusSkill?.status === "MASTERED_BY_USER"
        ? {
            status: "STALE" as const,
            text: "当前学习状态已变化，请让老师根据最新状态重新规划下一步。",
          }
        : { status: "READY" as const, text: nextAction };
    const onboarding = record.planningContext.snapshot();
    const teaching = learnerTeachingSnapshot(record.context.snapshot());
    const pending = teaching.learner_questions?.pending;
    if (viewMode === "CURRENT" && pending?.purpose === "CONFIRM_MASTERY"
        && pending.scope_signature === masteryReviewSignature(authoritative)) {
      const receipt = masteryDecisionReceipt(record.sessionManager, pending.id);
      // 仅公开副本提供断线续交所需的已保存选择；不写回题目、模型上下文或任何确认权限。
      if (receipt?.phase === "APPLIED" && receipt.request.scope_signature === pending.scope_signature
          && receipt.request.skill_id === pending.skill_id)
        pending.applied_reply = structuredClone(receipt.reply);
    }
    return {
      animation_request: viewMode==="CURRENT"?(()=>{
        const task=authoritative.active_task as {id?:string}|null;
        const request=animationRequests(record.sessionManager).findLast(item=>item.goalId===this.currentGoalId(authoritative)&&item.taskId===task?.id);
        return request?animationRequestView(request,record.busy&&record.animationRequestId===request.requestId):null;
      })():null,
      feedback_recovery: viewMode === "CURRENT" ? (() => {
        const recovery = currentFeedbackRecovery(record.sessionManager, authoritative);
        return recovery ? {id: recovery.id, reason: recovery.reason} : null;
      })() : null,
      assistant_busy: this.assistantBusy,
      classroom_version: this.classroomVersion(record, authoritative),
      // 教师/Kernel保留原始契约，公开快照只投影题面；共享课堂与重连必须走同一出口。
      overview: learnerOverview(overview),
      view_mode: viewMode,
      active_goal_id: this.currentGoalId(authoritative),
      view_goal_id: this.currentGoalId(overview),
      teaching,
      onboarding,
      recoverable_confirmed_goal: authoritative.current_goal !== null && (
        (onboarding.status === "CONFIRMED" && !onboarding.replace_existing) ||
        (onboarding.status === "IDLE" && this.confirmedGoalFromHistory(record, authoritative) !== null)
      ),
      recommended_action: recommendedAction,
    };
  }
}
