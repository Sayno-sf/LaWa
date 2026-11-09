import {ExcerptNotesView} from "./excerptNotesView";
import {GrowthLibraryView} from "./growthLibraryView";
import type {LearningPaths, RouteBranchCommand} from "../../src/learningBranchTypes";
import {FormSaveState} from "./formSaveState";
import {attachmentReferences} from "../../src/conversationAttachments";
import "./designTokens.css";
import "./styles.css";
import "./workspace.css";
import "./learningFocus.css";
import "./learnerQuestions.css";
import "./speech.css";
import "./answerAssessments.css";
import { answerAssessmentMarkup, assessmentHistoryMarkup } from "./answerAssessmentView";
import type { AnswerAssessment, AnswerAssessmentCard } from "../../src/answerAssessmentTypes";
import "./assistant.css";
import "katex/dist/katex.min.css";
import { startLearningIntro } from "./learningIntro";
import { FeatureGuide } from "./featureGuide";
import "./featureGuide.css";
import { icon, mountIcons } from "./icons";
import { WorkspaceNavigation } from "./workspaceNavigation";
import { KnowledgeCardNotice } from "./knowledgeCardNotice";
import { LearnerQuestionView } from "./learnerQuestionView";
import { QuestionNavigation } from "./questionNavigation";
import {ConversationAttachmentPreview} from "./conversationAttachmentPreview";
import {renderLearningRoute} from "./learningRouteView";
import { TeachingProposalView } from "./teachingProposalView";
import { TeachingInstructionsView } from "./teachingInstructionsView";
import { LearningSkillsView } from "./learningSkillsView";
import "./learningSkillsView.css";
import { CardSourceNavigation, resolveCardSource } from "./cardSource";
import { captureReadingPosition, restoreReadingPosition, ReadingWidthAnchor, captureDisclosures, restoreDisclosures } from "./readingPosition";
import { ClassroomClient } from "./classroomClient";
import "./teachingProposals.css";
import type { LearnerQuestionsSnapshot, LearnerQuestionReply, LearnerQuestionRequest } from "../../src/learnerQuestionTypes";
import { renderMarkdown } from "./markdown";
import {LessonFigureView,illustrateMessage} from "./lessonFigureView";
import {mergeFigures,type PlacedFigure} from "../../src/lessonFigureTypes";
import { resolveCurrentTaskSkillId, skillStatusLabel } from "./skillStatus";
import type { SkillState } from "./skillStatus";
import { mountRetrievalViews, retrievalStatus, sourceIndexLabel } from "./retrievalView";
import { VoiceInput, type VoiceInputMetadata } from "./voiceInput";
import { SpeechPlayer, SpeechSettingsView, speechMarkup, type SpeechComponent } from "./speechView";
import { AnimationPlayer, animationMarkup, type AnimationViewContext } from "./animationView";
import type { AnimationAnchor, AnimationComponent } from "../../src/animationTypes";
import {ExplainerPlayer,explainerMarkup} from "./explainerView";
import type {ExplainerComponent} from "../../src/explainerTypes";
import "./animationView.css";
import "./explainerView.css";
import { preserveConversationAttachments } from "./conversationProjection";
import { StudyTimeView } from "./studyTimeView";
import { AssistantView } from "./assistantView";
// 手机壳层必须最后加载：会话/计时等模块的样式在导入阶段注入，需要覆盖它们的窄屏规则。
import "./focusedWorkspace.css";
import "./interiorWorkspace.css";
import "./learningExperience.css";
import "./routeNavigator.css";
import { learningRecordMarkup, plainTextSummary } from "./learningRecordView";
import { skillIntroductionMarkup } from "./skillIntroduction";
import { ProviderPresetPicker } from "./providerPresets";
import { confirmedProgress, latestRecordedTime } from "./learningProgress";
import { InteriorWorkspace, goalDisplayTitle } from "./interiorWorkspace";
import { FocusedWorkspace } from "./focusedWorkspace";
import "./mobileShell.css";

mountRetrievalViews();

interface Skill {
  id: string;
  name: string;
  description: string;
  status: SkillState;
  target_depth: string;
  evidence_ids: string[];
}

interface Evidence {
  id: string;
  skill_id: string;
  evidence_type: string;
  description: string;
  assistance_level: string;
  source?: string;
  created_at: string;
}

interface Task {
  activity_revision?: number;
  branch_id?: string | null;
  id: string;
  title: string;
  description: string;
  related_skill_ids: string[];
  status: string;
  review_parent_task_id?: string | null;
}

type CardFeedback = "KNOWN" | "UNSURE" | "UNKNOWN";

interface KnowledgeCard {
  id: string;
  skill_id: string;
  question: string;
  answer: string;
  created_at: string;
  source_conversation_id: string | null;
  feedback: CardFeedback | null;
  feedback_updated_at: string | null;
  feedback_revision?: number;
  learner_note: string | null;
  note_updated_at: string | null;
}

interface LearningState {
  animation_request?: AnimationRequest | null;
  classroom_version?: string;
  feedback_recovery?: {id: string; reason: "model_error" | "assessment_failed"} | null;
  assistant_busy?: boolean;
  restored_session?: SessionResponse;
  view_mode?: "CURRENT" | "ARCHIVED" | "UNAVAILABLE";
  active_goal_id?: string | null;
  view_goal_id?: string | null;
  overview: {
    learning_paths?: LearningPaths;
    imported_topics?: {goal_id: string; groups: Array<{id: string; name: string; skill_ids: string[]}>} | null;
    current_goal: string | null;
    current_goal_skill_ids: string[];
    curriculum_spine: Array<{
      skill_ids?: string[];
      id: string;
      name: string;
      description: string;
      target_depth: string;
    }>;
    current_frontier: {
      focus_skill_id: string;
      supporting_skill_ids: string[];
      reason: string;
      target_depth: string;
      next_action: string;
    } | null;
    skills: Skill[];
    recent_evidence: Evidence[];
    active_task: Task | null;
    knowledge_cards: KnowledgeCard[];
  };
  teaching: {
    active_skill_id: string | null;
    teaching_mode: string | null;
    learner_questions?: LearnerQuestionsSnapshot;
    active_recall?: {
      status: "ACTIVE" | "PAUSED";
      primary_index: number;
      primary_questions: string[];
      asked_count: number;
    } | null;
  };
  onboarding: { status: string; replace_existing: boolean };
  recoverable_confirmed_goal?: boolean;
  recommended_action: {
    status: "READY" | "STALE";
    text: string;
  } | null;
}

interface SessionResponse {
  sessionId: string;
  state: LearningState;
  messages: UiMessage[];
  previewEntryId?: string | null;
  previewSkillId?: string | null;
  branches?: Array<{ label: string; entryId: string; skillId: string }>;
}

interface ConversationSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
  goalId: string | null;
  goalDescription: string | null;
  goalObservedAt: string | null;
  active: boolean;
}

interface ConversationCatalogResponse {
  activeSessionId: string | null;
  sessions: ConversationSummary[];
  unlinkedGoals?: Array<{id: string; name: string}>;
}

interface RecycleItem {
  id: string; kind: "goal" | "draft" | "chat"; targetId: string; name: string;
  deletedAt: string; sessionIds: string[]; phase: string;
}

interface LearningLibraryProject {
  answer_assessments?: AnswerAssessmentCard[];
  assessment_count?: number;
  status: "CURRENT" | "ARCHIVED";
  goal_profile: {
    id: string;
    goal_description: string;
    desired_outcome: string;
    background_summary: string;
  };
  curriculum_spine: Array<{
    skill_ids?: string[];
    id: string;
    name: string;
    description: string;
    target_depth: string;
  }>;
  skills: Skill[];
  evidence: Evidence[];
  knowledge_cards: KnowledgeCard[];
  archived_at: string | null;
}

interface LearningLibraryResponse {
  projects: LearningLibraryProject[];
}

type ProviderThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface ProviderSettings {
  provider: string;
  model: string;
  baseUrl: string;
  thinkingLevel: ProviderThinkingLevel;
  maxOutputTokens: number;
  hasApiKey: boolean;
  apiKeyHint: string | null;
}

interface ProviderProfile extends ProviderSettings {
  id: string;
  name: string;
}

interface ProviderCatalog {
  activeProfileId: string | null;
  active: ProviderSettings;
  profiles: ProviderProfile[];
}

interface ProviderConnectionResult {
  ok: true;
  message: string;
}

interface StreamEvent {
  routeChanged?:boolean;
  figures?:PlacedFigure[];
  type: string;
  delta?: string;
  message?: string;
  label?: string;
  status?: string;
  toolName?: string;
  state?: LearningState;
  messages?: UiMessage[];
  request?: LearnerQuestionRequest;
}

interface UiMessage {
  figures?:PlacedFigure[];
  explainer?: ExplainerComponent;
  animation?: AnimationComponent;
  animation_question?: {presentation_id: string;source_entry_id: string;title: string;scene_id: string};
  assessment?: AnswerAssessment;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  entryId?: string;
  speech?: SpeechComponent;
  attachments?: UiAttachment[];
}

interface AnimationRequest {
  request_id: string;
  status: "PREPARED" | "ATTACHED" | "STARTED" | "COMPLETED" | "FAILED" | "INTERRUPTED" | "UNKNOWN";
  source_user_entry_id?: string;
  anchor: AnimationAnchor;
  question: string;
  title: string;
}

const $ = <T extends HTMLElement>(selector: string): T => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing UI element: ${selector}`);
  return node;
};

const elements = {
  greeting: $("#hero-greeting"),
  skillRoute: $("#skill-route"),
  taskKicker: $("#task-kicker"),
  sidebarToggle: $("#sidebar-toggle") as HTMLButtonElement,
  mobileNavBackdrop: $("#mobile-nav-backdrop") as HTMLButtonElement,
  taskFocusToggle: $("#task-focus-toggle") as HTMLButtonElement,
  cardsNewBadge: $("#cards-new-badge"),
  cardsNewStatus: $("#cards-new-status"),
  conversationToggle: $("#conversation-toggle") as HTMLButtonElement,
  learningViewTabs: $("#learning-view-tabs"),
  conversationPane: $("#conversation-panel"),
  cardsPane: $("#task-focus-card"),
  activeRecallBar: $("#active-recall-bar"),
  activeRecallProgress: $("#active-recall-progress"),
  activeRecallSkip: $("#active-recall-skip") as HTMLButtonElement,
  messages: $("#messages"),
  branches: $("#conversation-branches"),
  skill: $("#skill-card"),
  contextColumn: $(".context-column"),
  mobileSurfaceTabs: $("#mobile-surface-tabs"),
  evidence: $("#evidence-list"),
  activity: $("#activity-list"),
  activityCount: $("#activity-count"),
  activityPanel: $("#activity-panel") as HTMLDetailsElement,
  activityButton: $("#activity-button") as HTMLButtonElement,
  activityIndicator: $("#activity-indicator"),
  status: $("#connection-status"),
  input: $("#message-input") as HTMLTextAreaElement,
  composer: $("#composer") as HTMLFormElement,
  composerAttachments: $("#composer-attachments"),
  composerNote: $("#composer-note"),
  send: $("#send-button") as HTMLButtonElement,
  stop: $("#stop-button") as HTMLButtonElement,
  voiceInputButton: $("#voice-input-button") as HTMLButtonElement,
  voiceInputStatus: $("#voice-input-status"),
  error: $("#error-banner"),
  errorText: $("#error-text"),
  retry: $("#retry-button") as HTMLButtonElement,
  feedbackRetry: $("#retry-feedback-button") as HTMLButtonElement,
  profileButton: $("#profile-button") as HTMLButtonElement,
  profileMenu: $("#profile-menu"),
  newGoal: $("#new-goal-button") as HTMLButtonElement,
  newGoalDialog: $("#new-goal-dialog") as HTMLDialogElement,
  newGoalCopy: $("#new-goal-copy"),
  learningLibraryButton: $("#learning-library-button") as HTMLButtonElement,
  learningLibraryPage: $("#learning-library-page"),
  learningLibraryContent: $("#learning-library-content"),
  materialsButton: $("#materials-button") as HTMLButtonElement,
  materialsPage: $("#materials-page"),
  materialFile: $("#material-file") as HTMLInputElement,
  materialsList: $("#materials-list"),
  materialPreview: $("#material-preview"),
  materialsCount: $("#materials-count"),
  materialPreviewText: $("#material-preview-text"),
  materialPreviewTitle: $("#material-preview-title"),
  materialPreviewStatus: $("#material-preview-status"),
  closeMaterialPreview: $("#close-material-preview"),
  routeMaterials: $("#route-materials"),
  knowledgeCards: $("#knowledge-cards-panel"),
  headerTaskInfo: $("#header-task-info"),
  stageHeading: $(".learning-stage-heading"),
  notesButton: $("#notes-button") as HTMLButtonElement,
  notesPage: $("#notes-page"),
  notesContent: $("#notes-content"),
  newConversation: $("#new-conversation-button") as HTMLButtonElement,
  conversationList: $("#conversation-list"),
  conversationMenuButton: $("#conversation-library-menu-button") as HTMLButtonElement,
  conversationPage: $("#conversation-library-page"),
  dialogNewConversation: $("#dialog-new-conversation-button") as HTMLButtonElement,
  conversationPageList: $("#conversation-page-list"),
  managementStatus: $("#conversation-management-status"),
  recycleList: $("#conversation-recycle-list"),
  recycleCount: $("#conversation-recycle-count"),
  providerStatusButton: $("#provider-status-button") as HTMLButtonElement,
  providerStatusLabel: $("#provider-status-label"),
  settingsButton: $("#settings-button") as HTMLButtonElement,
  settingsPage: $("#provider-settings-page"),
  settingsForm: $("#provider-settings-form") as HTMLFormElement,
  currentProviderLabel: $("#current-provider-label"),
  profileList: $("#provider-profile-list"),
  newProviderProfile: $("#new-provider-profile-button") as HTMLButtonElement,
  profileNameInput: $("#profile-name-input") as HTMLInputElement,
  providerInput: $("#provider-input") as HTMLInputElement,
  modelInput: $("#model-input") as HTMLInputElement,
  thinkingLevelInput: $("#thinking-level-input") as HTMLSelectElement,
  maxOutputTokensInput: $("#max-output-tokens-input") as HTMLInputElement,
  baseUrlInput: $("#base-url-input") as HTMLInputElement,
  apiKeyInput: $("#api-key-input") as HTMLInputElement,
  apiKeyState: $("#api-key-state"),
  providerTestResult: $("#provider-test-result"),
  testProvider: $("#test-provider-button") as HTMLButtonElement,
  activateProvider: $("#activate-provider-profile-button") as HTMLButtonElement,
  deleteProvider: $("#delete-provider-profile-button") as HTMLButtonElement,
  saveProvider: $("#save-provider-button") as HTMLButtonElement,
};

let sessionId: string | null = null;
let state: LearningState | null = null;
let selectedSkillId: string | null = null;
let generating = false;
let masteryDecisionPending = false;
// 历史评分默认由真实对话顺序决定；手动开合只覆盖当前回合的阅读状态。
const assessmentDisclosure = new Map<string, boolean>();
// 只有当前页面刚收到的新评分默认展开；刷新和回看加载的评分全部视为历史。
const freshAssessments = new Set<string>();
let assessmentDisclosureTurn = "";
// 手机端学习界面：学习/路线/记录三块内容同屏切换，桌面端恒为 learn 且不显示切换栏。
type MobileSurface = "learn" | "route" | "records";
let mobileSurface: MobileSurface = "learn";
const mobileSurfaceScroll = new Map<MobileSurface, number>();
let alignedQuestionKey = "";
const studyTimeView = new StudyTimeView(document.querySelector<HTMLElement>("#study-time-strip")!,
  () => generating && messages.at(-1)?.role === "assistant" && !messages.at(-1)?.content.trim() || assistantView.waiting,
  () => !previewEntryId && ["learn", "materials"].includes(workspace.current));
let validationErrorVisible = false;
let retryingFeedback = false;
type UnreceivedAnswer = {sessionId: string; goalId: string | null; taskId: string | null; questionId: string;
  requestId: string; text: string; options: {learnerReply: LearnerQuestionReply; displayText?: string; voiceInput?: VoiceInputMetadata;
    attachments?: UiAttachment[]; imageMaterialIds?: string[]}};
// 仅是本页传输草稿，不是已提交作答或学习事实；服务端未确认接收前不可当作反馈中断。
let unreceivedAnswer: UnreceivedAnswer | null = null;
let checkingAnswerDelivery = false;

function currentUnreceivedAnswer(): UnreceivedAnswer | null {
  const pending = unreceivedAnswer, request = state?.teaching.learner_questions?.pending;
  return pending && pending.sessionId === sessionId && pending.goalId === (state?.active_goal_id ?? null) &&
    pending.taskId === state?.overview.active_task?.id && pending.questionId === request?.id ? pending : null;
}
const learnerQuestionView = new LearnerQuestionView(submitLearnerQuestion, () => {
  if (generating || remoteGenerating || assistantView.busy || learningRecordNavigationPending || voiceInput.busy) return;
  learnerQuestionView.previous("");
  syncComposerAvailability();
});
let providerCatalog: ProviderCatalog | null = null;
let remoteGenerating = false;
let sharedVersion: string | null = null;
const classroomClient = new ClassroomClient(value => {
  if (generating || !value.session || previewEntryId) return;
  const payload = value.session as SessionResponse;
  const changed = sharedVersion !== value.version || sessionId !== payload.sessionId;
  const goalChanged = state && state.active_goal_id !== payload.state.active_goal_id;
  const hadDraft = Boolean(elements.input.value.trim());
  const wasRemoteGenerating = remoteGenerating;
  sharedVersion = value.version;
  remoteGenerating = value.run?.status === "running";
  if (changed) applySessionPayload(payload);
  if (wasRemoteGenerating !== remoteGenerating) renderLearnerQuestions();
  if (goalChanged && hadDraft) setError("学习目标已在另一设备切换。草稿已保留，请核对当前目标后再发送。");
  void teachingProposalView.refresh(sessionId, viewMode(payload.state) === "CURRENT" && ["IDLE", "INITIALIZED"].includes(payload.state.onboarding.status)).then(() => {
    if (!teachingProposalView.node.hidden && teachingProposalView.node.childElementCount) elements.messages.append(teachingProposalView.node);
  }).catch(() => undefined);
  if (remoteGenerating && value.run && (value.run.text || value.run.figures?.length)) {
    const latest = messages.at(-1);
    if (latest?.streaming) {latest.content = value.run.text;latest.figures=value.run.figures;}
    else messages.push({role: "assistant", content: value.run.text, streaming: true,figures:value.run.figures});
    renderMessages();
  }
  elements.send.disabled = remoteGenerating;
  elements.stop.classList.toggle("hidden", !remoteGenerating);
  elements.send.classList.toggle("hidden", remoteGenerating);
  if (remoteGenerating) setConnection("老师正在回复，可在这里继续查看", "connecting");
  else if (wasRemoteGenerating) setConnection("本轮已结束，已保存内容已同步", "ready");
}, event => {
  if (generating || !remoteGenerating || previewEntryId) return;
  if (event.type === "figures_ready" && event.figures) {
    let latest=messages.at(-1);
    if (!latest?.streaming) {latest={role:"assistant",content:"",streaming:true};messages.push(latest);}
    addReadyFigures(latest,event.figures);
  } else if (event.type === "assistant_delta") {
    let latest = messages.at(-1);
    if (!latest?.streaming) {latest = {role: "assistant", content: "", streaming: true}; messages.push(latest);}
    latest.content += event.delta ?? ""; updateStreamingMessage(latest);
  } else if (event.type === "question_ready" && event.request) receiveQuestion(event.request as LearnerQuestionRequest);
  else if (event.type === "state" && event.state) renderState(event.state as LearningState, true);
  else if (event.type === "conversation_update" && event.messages) {messages.splice(0, messages.length, ...(event.messages as UiMessage[])); renderMessages();}
});
classroomClient.start();
const teachingProposalView = new TeachingProposalView(() => {
  const current = sessionId;
  if (current) void requestJson<LearningState>(`/api/web/sessions/${encodeURIComponent(current)}/state`).then(next => {
    if (sessionId === current) renderState(next);
  }).catch(() => undefined);
});
const teachingInstructionsView = new TeachingInstructionsView();
const learningSkillsView = new LearningSkillsView();
const confirmedHeading = document.createElement("h3");
confirmedHeading.className = "settings-section-title";
confirmedHeading.textContent = "已确认的教法";
teachingProposalView.management.prepend(confirmedHeading);
document.querySelector("#teaching-arrangements-page")!.append(teachingInstructionsView.node, learningSkillsView.node, teachingProposalView.management);
let providerSettingsLoading: Promise<void> | null = null;
let selectedProviderProfileId: string | null = null;
let conversationCatalog: ConversationCatalogResponse = {
  activeSessionId: null,
  sessions: [],
};
const messages: UiMessage[] = [];
let activeRouteUiKey = "";
type RouteUiState = {draft: string; reading: ReturnType<typeof captureReadingPosition>; question: ReturnType<LearnerQuestionView["captureDraft"]>};
const routeUiStates = new Map<string, RouteUiState>();
let pendingRouteReading: {key: string; position: ReturnType<typeof captureReadingPosition>} | undefined;
function saveRouteUi(): void {
  if (!activeRouteUiKey) return;
  const value: RouteUiState = {draft: elements.input.value,
    reading: pendingRouteReading?.key === activeRouteUiKey ? pendingRouteReading.position : captureReadingPosition(elements.messages),
    question: learnerQuestionView.captureDraft()};
  routeUiStates.set(activeRouteUiKey, value);
  try {localStorage.setItem(activeRouteUiKey, JSON.stringify(value));} catch { /* 本页内仍可恢复。 */ }
}
function restoreRouteUi(next: LearningState): void {
  // 只读记录有独立阅读位置；浏览旁支不能覆盖正在学习的主线草稿、待答题或滚动锚点。
  const key = `lawa:route-ui:${sessionId}:${next.view_goal_id ?? next.active_goal_id ?? "draft"}:${next.overview.learning_paths?.active_branch_id ?? "main"}${previewEntryId ? `:record:${previewEntryId}` : ""}`;
  if (key === activeRouteUiKey) return;
  saveRouteUi(); activeRouteUiKey = key;
  let saved = routeUiStates.get(key);
  try {saved ??= JSON.parse(localStorage.getItem(key) ?? "null") as RouteUiState | undefined;} catch {}
  elements.input.value = typeof saved?.draft === "string" ? saved.draft : "";
  if (saved?.question) learnerQuestionView.restoreDraft(saved.question);
  pendingRouteReading = saved?.reading ? {key, position: saved.reading} : undefined;
  if (pendingRouteReading) requestAnimationFrame(() => {
    if (activeRouteUiKey !== key || pendingRouteReading?.key !== key) return;
    restoreReadingPosition(elements.messages, pendingRouteReading.position);
    pendingRouteReading = undefined;
  });
}
let changingRoute = false;
async function changeRouteBranch(branchId: string, action: RouteBranchCommand["action"]): Promise<void> {
  if (!state || !sessionId || generating || remoteGenerating || changingRoute || skillActionPending || learningRecordNavigationPending) return;
  const branch = state.overview.learning_paths?.branches.find(b => b.id === branchId);
  if (!branch) throw new Error("学习分支已变化，请重新打开路线。");
  const task = state.overview.active_task;
  const key = `lawa:route-operation:${sessionId}:${branchId}:${branch.revision}:${action}`;
  let operationId: string = crypto.randomUUID();
  try {operationId = localStorage.getItem(key) ?? operationId; localStorage.setItem(key, operationId);} catch {}
  changingRoute = true; saveRouteUi(); setError();
  document.querySelectorAll<HTMLButtonElement>("button[data-route-action]").forEach(button => {button.disabled = true;});
  const resumeSnapshots = classroomClient.pauseSnapshots();
  try {
    const command: RouteBranchCommand = {sessionId, branchId, action, operationId, expectedRevision: branch.revision,
      goalId: state.active_goal_id!, taskId: task?.id ?? null, taskRevision: task?.activity_revision ?? 0};
    const payload = await requestJson<SessionResponse>("/api/web/learning-branches/transition", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(command)});
    applySessionPayload(payload);
    try {localStorage.removeItem(key);} catch {}
  } finally {
    changingRoute = false; resumeSnapshots();
    document.querySelectorAll<HTMLButtonElement>("button[data-route-action]").forEach(button => {button.disabled = generating || remoteGenerating;});
    if (state) renderHeaderTaskInfo(state);
  }
}
const pendingAttachments = new Map<string, PendingAttachment[]>();
let previewEntryId: string | null = null;
let currentBranches: SessionResponse["branches"] = [];
const activities: Array<{ label: string; status: string; toolName: string }> = [];

function viewMode(value: LearningState | null): "CURRENT" | "ARCHIVED" | "UNAVAILABLE" {
  // Web 静态文件可能先于 Gateway 进程更新；旧 Gateway 未发此字段时沿用原有当前视图。
  return value?.view_mode ?? "CURRENT";
}

// 卡片翻牌/编辑状态只是本机视觉偏好：overview 状态由 Gateway 决定，
// 这里只记录哪些卡片被展开、哪张正在编辑笔记，避免 renderState 重建后丢失。
const flippedCards = new Set<string>();
let editingNoteCardId: string | null = null;
let editingLibraryNoteCardId: string | null = null;
let editingCardId: string | null = null;
// 复习翻页会移除卡片DOM，草稿不能依赖旧textarea存活；仅明确保存或取消时清除。
const cardNoteDrafts = new Map<string, string>();
const cardEditDrafts = new Map<string, { question: string; answer: string }>();
// 笔记视图必须跨所有 Goal/Conversation：缓存全量 library 投影，而非当前 overview。
let notesLibraryCache: LearningLibraryResponse | null = null;
let notesLibraryRequest = 0;
let learningLibraryRequest = 0;
let conversationCatalogRequest = 0;
let classroomNavigationRequest = 0;
let classroomNavigationOperations = 0;
let classroomNavigationQueue: Promise<void> = Promise.resolve();
const cardSource = new CardSourceNavigation();

// 展示偏好不改变学习状态；卡片切页继续读取旧偏好键，保留已有浏览器选择。
const SIDEBAR_COLLAPSED_KEY = "learn-anything:sidebar-collapsed";
const TASK_FOCUS_COLLAPSED_KEY = "learn-anything:task-focus-collapsed";
const CARD_NOTICE_KEY = "learn-anything:knowledge-card-notice:v1";
let savedCardNotice: string | null = null;
try { savedCardNotice = localStorage.getItem(CARD_NOTICE_KEY); } catch { /* 仅本页内保留提示。 */ }
const cardNotice = new KnowledgeCardNotice(savedCardNotice);
const focusedWorkspace = new FocusedWorkspace();
new ReadingWidthAnchor(elements.messages);
new ReadingWidthAnchor(elements.knowledgeCards);
new ReadingWidthAnchor(elements.cardsPane);
const questionNavigation = new QuestionNavigation(elements.messages, learnerQuestionView.node, elements.composer.closest<HTMLElement>(".composer-wrap")!);
const interiorWorkspace = new InteriorWorkspace();
let suggestedGoalPrompt = "";
const growthLibrary = new GrowthLibraryView<LearningLibraryProject>(elements.learningLibraryContent, {
  records: (project, skillId, tab) => {
    if (tab === "records") return `<ol class="learning-record-list">${project.evidence.filter(e => e.skill_id === skillId)
      .map(e => `<li data-reading-key="${escapeHtml(e.id)}">${learningRecordMarkup(e)}</li>`).join("")}</ol>`;
    if (tab === "feedback") return assessmentHistoryMarkup((project.answer_assessments ?? []).filter(a => a.skill_id === skillId));
    const cards = (project.knowledge_cards ?? []).filter(c => c.skill_id === skillId);
    return cards.length ? cards.map(card => `<details class="library-card-item" data-reading-key="${escapeHtml(card.id)}" data-disclosure-key="card:${escapeHtml(card.id)}">
      <summary><span class="library-card-question">${escapeHtml(plainTextSummary(card.question, 180))}</span>${card.learner_note ? '<span class="library-card-note-badge">笔记</span>' : ''}</summary>
      <div class="library-card-answer"><div class="reading-content">${renderMarkdown(card.answer)}</div>${card.learner_note ? `<p class="library-card-note"><span class="kc-note-label">我的笔记</span>${escapeHtml(card.learner_note)}</p>` : ''}</div></details>`).join("") : '<p class="growth-empty">这个知识点还没有知识卡片。</p>';
  },
  newGoal: prompt => {requestNewGoal(); if (elements.newGoalDialog.open) suggestedGoalPrompt = prompt;},
  adopted: async (adoption, enter) => {
    if (!adoption.branch_id || !adoption.recommendation.goal_id) return;
    const goalId = adoption.recommendation.goal_id;
    // 稍后学习也要刷新当前目录；只读重绘不切课堂、不发送草稿。
    if (!enter) {
      if (sessionId && state?.active_goal_id === goalId) renderState(await requestJson<LearningState>(`/api/web/sessions/${encodeURIComponent(sessionId)}/state`));
      return;
    }
    if (state?.active_goal_id !== goalId) {
      applySessionPayload(await requestJson<SessionResponse>(`/api/web/goals/${encodeURIComponent(goalId)}/activate`, {method: "POST"}));
    } else if (sessionId) renderState(await requestJson<LearningState>(`/api/web/sessions/${encodeURIComponent(sessionId)}/state`));
    await changeRouteBranch(adoption.branch_id, "enter");
    workspace.navigate("learn");
  },
  refresh: () => interiorWorkspace.refreshCollections(),
});
const expandedSkillIntroductions = new Set<string>();
const mobileNavMedia = window.matchMedia("(max-width: 820px)");
const workspace = new WorkspaceNavigation((view) => {
  let loading: Promise<unknown> | undefined;
  growthLibrary.setActive(view === "library");
  cancelMedia();
  if (view !== "materials") {
    selectedConversationAttachment = null;
    materialListRequest++;
    materialPreviewRequest++;
    clearTimeout(materialPoll);
  }
  applyMobileNavOpen(false);
  elements.profileMenu.classList.add("hidden");
  elements.profileButton.setAttribute("aria-expanded", "false");
  if (view === "library") loading = openLearningLibrary();
  else if (view === "notes") loading = openNotesPage();
  else if (view === "teaching") {
    loading = Promise.all([teachingInstructionsView.load(), learningSkillsView.load()]);
    // 导航只回读用户安排，不能初始化教师或替用户接受候选。
    void teachingProposalView.refresh(sessionId, Boolean(state && viewMode(state) === "CURRENT" && !previewEntryId && ["IDLE", "INITIALIZED"].includes(state.onboarding.status)));
  }
  else if (view === "settings" && !providerCatalog) loading = loadProviderSettings();
  else if (view === "conversations") loading = loadConversationCatalog();
  else if (view === "materials") {
    $("#material-scope-label").textContent = isGoalDraft() ? "新目标草稿" : state?.overview.current_goal ?? "正在恢复学习目标…";
    if (sessionId) loading = loadMaterials();
    else elements.materialsList.textContent = "正在恢复学习资料…";
  }
  syncKnowledgeCardNotice(false, view === "learn" ? displayedKnowledgeCardIds() : []);
  syncComposerAvailability();
  return loading;
});
const excerptNotesView = new ExcerptNotesView(() => sessionId, () => workspace.navigate("learn"), (goalId, skillId) => {
  const project = notesLibraryCache?.projects.find(project => project.goal_profile.id === goalId);
  return [project ? goalDisplayTitle(project.goal_profile.goal_description) : "", project?.skills.find(skill => skill.id === skillId)?.name ?? (skillId ? "知识点笔记" : "未关联知识点")].filter(Boolean).join(" · ");
}, () => interiorWorkspace.refreshCollections(), () => workspace.navigate("notes"), () => cancelMedia());
document.addEventListener("note-source-change", () => syncComposerAvailability());
const speechSettings = new SpeechSettingsView(() => { voiceInput.sync(); speechPlayer.sync(); }, () => { cancelMedia(); speechPlayer.invalidateCache(); });
const speechPlayer = new SpeechPlayer(elements.messages, () => !voiceInput.busy, () => {voiceInput.cancel();animationPlayer.pauseAll();explainerPlayer.pauseAll();});
const voiceInput = new VoiceInput({
  input: elements.input, button: elements.voiceInputButton, status: elements.voiceInputStatus,
  canStart: () => Boolean(sessionId && state && viewMode(state) === "CURRENT" && !previewEntryId && !generating && !assistantView.busy && !assistantView.visibleInClassroom && !learningRecordNavigationPending && workspace.current === "learn"),
  isConfigured: () => speechSettings.configured,
  onConfigure: () => { workspace.navigate("settings"); speechSettings.open(); },
  sessionId: () => sessionId,
  questionKey: voiceScopeKey,
  beforeStart: () => { speechPlayer.stop(); animationPlayer.pauseAll(); explainerPlayer.pauseAll(); setError(); },
  onState: () => { renderLearnerQuestions(); speechPlayer.sync(); },
  onError: message => setError(message),
});
const assistantView = new AssistantView(() => {
  cancelMedia();
  syncLearningPanes();
  focusedWorkspace.setAssistantOpen(assistantView.isOpen);
  renderLearnerQuestions();
  if (state) elements.activeRecallSkip.disabled = generating || assistantView.busy;
  if (state) syncAnimationUi();
}, () => studyTimeView.flush(), async () => {
  if (!state) return;
  if (previewEntryId && sessionId) await navigateLearningRecord(`/api/web/sessions/${encodeURIComponent(sessionId)}/activate`);
  else if (viewMode(state) !== "CURRENT" && state.active_goal_id) {
    applySessionPayload(await requestJson<SessionResponse>(`/api/web/goals/${encodeURIComponent(state.active_goal_id)}/activate`, {method:"POST"}));
  }
  selectedSkillId = null;
  applyTaskFocusCollapsed(true);
  if (state) renderState(state);
});

let pageAnimationRequest: (AnimationRequest & {sessionId: string}) | null = null;
let animationSubmissionActive = false;
const animationRecovery = document.createElement("div");
animationRecovery.className="animation-request-actions";animationRecovery.hidden=true;
animationRecovery.innerHTML='<span></span><button type="button" data-animation-query>查询已保存回复</button><button type="button" data-animation-retry>重新解释这一步</button>';
elements.composer.before(animationRecovery);
// 动画只把服务端可核对的位置交给原助教，主输入栏继续承担普通教学与作答。
const animationPlayer = new AnimationPlayer(elements.messages,(selection)=>{
  explainerPlayer.clearSelection();
  assistantView.openForAnimation(selection.anchor);
},()=>assistantView.clearAnimationContext(),()=>{voiceInput.cancel();speechPlayer.stop();explainerPlayer.pauseAll();explainerPlayer.clearSelection();assistantView.clearAnimationContext();});
const explainerPlayer=new ExplainerPlayer(elements.messages,(selection)=>{
  animationPlayer.clearSelection();assistantView.openForAnimation(selection.anchor);
},()=>assistantView.clearAnimationContext(),()=>{voiceInput.cancel();speechPlayer.stop();animationPlayer.pauseAll();animationPlayer.clearSelection();assistantView.clearAnimationContext();});
function clearTeachingAnimationSelection():void{animationPlayer.clearSelection();explainerPlayer.clearSelection();assistantView.clearAnimationContext();assistantView.clearFigureContext();}
function teachingAnimationComponent(id:string):AnimationComponent|ExplainerComponent|undefined{
  for(const message of messages){if(message.animation?.id===id)return message.animation;if(message.explainer?.id===id)return message.explainer;}
}
animationRecovery.querySelector("[data-animation-query]")!.addEventListener("click",()=>void recoverAnimationQuestion(false));
animationRecovery.querySelector("[data-animation-retry]")!.addEventListener("click",()=>void recoverAnimationQuestion(true));

function animationViewContext(): AnimationViewContext {
  const receipt=state?.animation_request;
  const explaining=(generating&&animationSubmissionActive)||(remoteGenerating&&receipt?.status==="STARTED");
  return {sessionId,current:Boolean(state&&viewMode(state)==="CURRENT"&&!previewEntryId&&state.overview.active_task?.status==="ACTIVE"),
    goalId:state?.active_goal_id,taskId:state?.overview.active_task?.id,skillId:state?currentTaskSkillId(state):null,blocked:explaining||assistantView.busy,
    askBlocked:generating||remoteGenerating||masteryDecisionPending||learningRecordNavigationPending||assistantView.busy||Boolean(state?.feedback_recovery)};
}
function currentAnimationRequest(): AnimationRequest | null {
  const fromPage=pageAnimationRequest?.sessionId===sessionId?pageAnimationRequest:null;
  const receipt=fromPage&&state?.animation_request?.request_id!==fromPage.request_id?fromPage:state?.animation_request??fromPage;
  if(!receipt)return null;
  const component=teachingAnimationComponent(receipt.anchor.presentation_id);
  return component&&component.sourceSessionId===sessionId&&component.goalId===state?.active_goal_id&&component.taskId===state?.overview.active_task?.id&&component.skillId===(state?currentTaskSkillId(state):null)?receipt:null;
}
function syncAnimationUi(): void {
  const context=animationViewContext();
  const receipt=currentAnimationRequest();
  animationRecovery.hidden=!context.current||!receipt||receipt.status==="COMPLETED";
  if(receipt){
    const status={PREPARED:"问题正在保存",ATTACHED:"问题已保存",STARTED:"老师正在解释",COMPLETED:"解释已保存",FAILED:"这次解释未完成",INTERRUPTED:"这次解释已停止",UNKNOWN:"尚未确认这次解释的结果"}[receipt.status];
    animationRecovery.querySelector("span")!.textContent=`${status}。`;
    for(const b of animationRecovery.querySelectorAll<HTMLButtonElement>("button"))b.disabled=Boolean(context.askBlocked);
    // 未知结果先由用户查询；新尝试必须能关联服务端已经持久保存的原请求。
    animationRecovery.querySelector<HTMLButtonElement>("[data-animation-retry]")!.hidden=state?.animation_request?.request_id!==receipt.request_id||receipt.status==="PREPARED"||receipt.status==="ATTACHED"||receipt.status==="STARTED";
  }
  animationPlayer.sync(context);
  explainerPlayer.sync(context);
}
async function recoverAnimationQuestion(newAttempt: boolean): Promise<void> {
  const receipt=currentAnimationRequest();if(!receipt||animationViewContext().askBlocked)return;
  await sendMessage(receipt.question,{appendUser:false,animationContext:receipt.anchor,
    requestId:newAttempt?crypto.randomUUID():receipt.request_id,retryOf:newAttempt?receipt.request_id:undefined,queryAnimationRequest:!newAttempt});
}
elements.messages.addEventListener("click",event=>{
  const link=(event.target as Element).closest<HTMLElement>("[data-animation-locate]");
  if(link?.dataset.animationLocate){animationPlayer.locate(link.dataset.animationLocate);explainerPlayer.locate(link.dataset.animationLocate);}
});

function animationQuestionMarkup(message: UiMessage): string {
  const reference=message.animation_question;if(!reference)return "";
  const component=teachingAnimationComponent(reference.presentation_id);
  const index=component&&"lesson" in component.artifact?component.artifact.lesson.scenes.findIndex(scene=>scene.id===reference.scene_id):-1;
  return `<button type="button" class="animation-message-reference" data-animation-locate="${escapeHtml(reference.presentation_id)}">关于：${escapeHtml(reference.title)}${index>=0?` · 第${index+1}幕`:""}</button>`;
}

function syncAssistantContext(): void {
  const current = viewMode(state) === "CURRENT" && !previewEntryId;
  const task = state?.overview.active_task;
  assistantView.setContext({
    sessionId,
    key: `${sessionId ?? ""}:${state?.active_goal_id ?? ""}:${task?.id ?? ""}:${state?currentTaskSkillId(state)??"":""}:${state?.teaching.learner_questions?.pending?.id ?? ""}:${previewEntryId ?? ""}:${viewMode(state)}`,
    draftScope: {goalId: state?.active_goal_id ?? null, taskId: task?.id ?? null, skillId: state ? currentTaskSkillId(state) : null},
    available: Boolean(current && task?.status === "ACTIVE" && state?.overview.current_goal && ["IDLE", "INITIALIZED"].includes(state.onboarding.status)),
    taskTitle: state ? currentGoalSkills(state.overview).find(skill => skill.id === currentTaskSkillId(state!))?.name ?? "当前学习任务" : "",
    canReturn: Boolean(state?.active_goal_id && (!current || selectedSkillId && selectedSkillId !== currentTaskSkillId(state))),
    teacherBusy: generating || learningRecordNavigationPending,
  });
}
function voiceScopeKey(): string {
  const recall = state?.teaching.active_recall;
  return `${viewMode(state)}:${state?.active_goal_id ?? ""}:${state?.overview.active_task?.id ?? ""}:${previewEntryId ?? ""}:${state?.teaching.learner_questions?.pending?.id ?? ""}:${learnerQuestionView.currentQuestionKey}:${recall?.primary_index ?? ""}:${recall?.asked_count ?? ""}`;
}
const lessonFigureView=new LessonFigureView(anchor=>assistantView.openForFigure(anchor),()=>{cancelMedia();assistantView.clearFigureContext();});
function cancelMedia(): void { voiceInput.cancel(); speechPlayer.stop(); animationPlayer.pauseAll(); explainerPlayer.pauseAll(); lessonFigureView.pauseAll(); }
function canAskFigure(f:PlacedFigure):boolean {
  return !!state && !previewEntryId && viewMode(state)==="CURRENT" && sessionId===f.sessionId && state.active_goal_id===f.goalId &&
    state.overview.active_task?.id===f.taskId && currentTaskSkillId(state)===f.skillId && !generating && !remoteGenerating && !assistantView.busy;
}
function addReadyFigures(message:UiMessage,ready:PlacedFigure[]) {
  message.figures=mergeFigures(message.figures??[],ready);
}
let noticeTimer: number | undefined;

function readStoredFlag(key: string, defaultValue = false): boolean {
  try {
    const saved = localStorage.getItem(key);
    return saved === null ? defaultValue : saved === "true";
  } catch {
    return defaultValue;
  }
}

function storeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // 隐私模式下静默降级：折叠状态只在当前页面内有效。
  }
}

function syncSidebarToggle(): void {
  const expanded = mobileNavMedia.matches
    ? document.body.classList.contains("mobile-nav-open")
    : !document.body.classList.contains("sidebar-collapsed");
  elements.sidebarToggle.setAttribute("aria-expanded", String(expanded));
  elements.sidebarToggle.setAttribute("aria-label", expanded ? "收起左侧导航" : "展开左侧导航");
}

function applySidebarCollapsed(collapsed: boolean): void {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  storeFlag(SIDEBAR_COLLAPSED_KEY, collapsed);
  syncSidebarToggle();
}

function applyMobileNavOpen(open: boolean): void {
  document.body.classList.toggle("mobile-nav-open", open && mobileNavMedia.matches);
  syncSidebarToggle();
}

function applyTaskFocusCollapsed(collapsed: boolean): void {
  const leavingSource = collapsed && Boolean(cardSource.reference);
  if (collapsed) cardSource.clear();
  cancelMedia();
  document.body.classList.toggle("task-focus-collapsed", collapsed);
  storeFlag(TASK_FOCUS_COLLAPSED_KEY, collapsed);
  syncLearningPanes();
  if (state) {
    if (leavingSource) renderKnowledgeCards(currentSkill(state));
    else {
      renderSkillAndEvidence(state.overview, currentSkill(state), viewMode(state) !== "CURRENT");
      renderBranches();
    }
  }
  syncKnowledgeCardNotice(false, collapsed ? [] : displayedKnowledgeCardIds());
}

function syncLearningPanes(): void {
  const collapsed = document.body.classList.contains("task-focus-collapsed");
  // 原教学面板持续挂载；紧凑布局展开助教时只暂停交互，原题、草稿和滚动保留。
  const panes = [[elements.conversationToggle, elements.conversationPane, collapsed],
    [elements.taskFocusToggle, elements.cardsPane, !collapsed]] as const;
  for (const [tab, pane, selected] of panes) {
    const visible = selected && !assistantView.visibleInClassroom;
    tab.setAttribute("aria-selected", String(visible));
    tab.tabIndex = selected ? 0 : -1;
    pane.setAttribute("aria-hidden", String(!visible));
    pane.inert = !visible;
    if (!visible && !assistantView.visibleInClassroom && pane.contains(document.activeElement)) {
      (collapsed ? elements.conversationToggle : elements.taskFocusToggle).focus({ preventScroll: true });
    }
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[
        character
      ]!,
  );
}

function setGreeting(): void {
  const hour = new Date().getHours();
  elements.greeting.textContent = hour < 11 ? "早上好，" : hour < 18 ? "下午好，" : "晚上好，";
}

// 手机标题栏极窄：状态只显示短标签，完整含义保留在 title 与 aria-label。
function mobileConnectionLabel(label: string, status: "ready" | "connecting" | "error"): string {
  if (status === "error") return label;
  if (status === "connecting") {
    if (label.includes("切换")) return "切换中";
    if (label.includes("回复") || label.includes("生成")) return "老师回复中";
    return "连接中";
  }
  return label.includes("恢复") ? "已恢复" : "已保存";
}
let connectionState: { label: string; status: "ready" | "connecting" | "error" } = { label: "正在连接", status: "connecting" };
function setConnection(label: string, status: "ready" | "connecting" | "error"): void {
  connectionState = { label, status };
  const shown = mobileNavMedia.matches ? mobileConnectionLabel(label, status) : label;
  elements.status.dataset.status = status;
  elements.status.title = label;
  elements.status.innerHTML = `<span></span>${escapeHtml(shown)}`;
  if (shown === label) elements.status.removeAttribute("aria-label");
  else elements.status.setAttribute("aria-label", label);
}

function setError(message?: string, options: {retry?: boolean} = {}): void {
  validationErrorVisible = Boolean(message && options.retry === false);
  elements.error.classList.toggle("hidden", !message);
  elements.errorText.textContent = message ?? "";
  elements.retry.hidden = !message || options.retry === false || Boolean(state?.feedback_recovery);
  syncFeedbackRecovery();
  if (message && workspace.current !== "learn") {
    const notice = $("#toast");
    notice.textContent = message;
    notice.classList.remove("hidden");
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => notice.classList.add("hidden"), 5000);
  }
}

function syncFeedbackRecovery(): void {
  const admission = currentUnreceivedAnswer();
  const available = Boolean((state?.feedback_recovery || admission) && viewMode(state) === "CURRENT" && !previewEntryId && !validationErrorVisible);
  elements.feedbackRetry.hidden = !available;
  elements.feedbackRetry.disabled = checkingAnswerDelivery || generating || remoteGenerating || masteryDecisionPending || learningRecordNavigationPending || assistantView.busy || voiceInput.busy;
  const scorePending = state?.feedback_recovery?.reason === "assessment_failed";
  elements.feedbackRetry.textContent = retryingFeedback
    ? scorePending ? "正在核验与恢复评分…" : "正在重新生成反馈…"
    : admission && !state?.feedback_recovery ? "重新提交本次回答" : scorePending ? "恢复本次评分与反馈" : "重新生成本次反馈";
  if (available) {
    elements.error.classList.remove("hidden");
    elements.retry.hidden = Boolean(state?.feedback_recovery);
    if (admission && !state?.feedback_recovery) {
      elements.errorText.textContent = "这次提交尚未确认接收，原回答保留在本页。重新连接不会重新提交；可稍后点击“重新提交本次回答”。";
      return;
    }
    if (!elements.errorText.textContent) elements.errorText.textContent = state?.feedback_recovery?.reason === "assessment_failed"
      ? "这次作答的评分尚未完成保存，可以继续完成本次反馈。" : "本次反馈未完成，可以重新生成。";
  }
}

function setProviderControlsBusy(busy: boolean): void {
  elements.testProvider.disabled = busy;
  elements.saveProvider.disabled = busy || generating;
  elements.activateProvider.disabled = busy || generating;
  elements.deleteProvider.disabled = busy;
  elements.newProviderProfile.disabled = busy;
  elements.profileList.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.disabled = busy;
  });
  elements.settingsButton.disabled = false;
  elements.providerStatusButton.disabled = false;
}

function providerLabel(settings: ProviderSettings): string {
  return settings.provider && settings.model
    ? `${settings.provider} / ${settings.model}`
    : "未配置";
}

function thinkingLevelLabel(level: ProviderThinkingLevel): string {
  return `推理强度：${({off:"模型默认", minimal:"最少", low:"低", medium:"中", high:"高", xhigh:"极高", max:"最高"})[level]}`;
}

const providerPresetPicker = new ProviderPresetPicker(elements.providerInput, elements.baseUrlInput);
const providerSaveState = new FormSaveState(elements.settingsForm, document.querySelector<HTMLElement>("#provider-save-status")!);

function renderProviderEditor(profile?: ProviderProfile): void {
  elements.profileNameInput.value = profile?.name ?? "";
  elements.providerInput.value = profile?.provider ?? "";
  providerPresetPicker.sync();
  elements.modelInput.value = profile?.model ?? "";
  elements.thinkingLevelInput.value = profile?.thinkingLevel ?? "off";
  elements.maxOutputTokensInput.value = profile ? String(profile.maxOutputTokens) : "";
  elements.baseUrlInput.value = profile?.baseUrl ?? "";
  elements.apiKeyInput.value = "";
  elements.apiKeyInput.placeholder = profile?.hasApiKey
    ? "留空保留已保存密钥"
    : "输入 API Key";
  elements.apiKeyState.textContent = profile?.hasApiKey
    ? `已保存 ${profile.apiKeyHint ?? "密钥"}，仅保存在本机`
    : "新配置需要输入 API Key";
  const selectedIsActive = Boolean(
    profile && providerCatalog?.activeProfileId === profile.id,
  );
  elements.activateProvider.classList.toggle("hidden", !profile || selectedIsActive);
  elements.deleteProvider.classList.toggle("hidden", !profile || selectedIsActive);
  if (profile) providerSaveState.markClean();
  else providerSaveState.markClean("新配置 · 保存后使用", "initial");
}

function renderProviderCatalog(catalog: ProviderCatalog): void {
  providerCatalog = catalog;
  speechSettings.setProfiles(catalog.profiles);
  const activeLabel = catalog.active.provider
    ? `${providerLabel(catalog.active)} · ${thinkingLevelLabel(catalog.active.thinkingLevel)}`
    : providerLabel(catalog.active);
  elements.providerStatusLabel.textContent = catalog.active.model || "未配置";
  elements.providerStatusButton.title = `模型设置 · ${activeLabel}`;
  elements.currentProviderLabel.textContent = activeLabel;
  if (
    selectedProviderProfileId &&
    !catalog.profiles.some((profile) => profile.id === selectedProviderProfileId)
  ) {
    selectedProviderProfileId = null;
  }
  selectedProviderProfileId ??= catalog.activeProfileId ?? catalog.profiles[0]?.id ?? null;
  elements.profileList.innerHTML = catalog.profiles.length
    ? catalog.profiles.map((profile) => `
      <button class="provider-profile-item ${profile.id === selectedProviderProfileId ? "selected" : ""}" type="button" data-profile-id="${escapeHtml(profile.id)}">
        <strong>${escapeHtml(profile.name)}</strong>
        <small>${escapeHtml(providerLabel(profile))}</small><small>${escapeHtml(thinkingLevelLabel(profile.thinkingLevel))} · 输出上限 ${Math.round(profile.maxOutputTokens / 1024)}K</small>
        ${profile.id === catalog.activeProfileId ? '<span class="active-badge">当前使用</span>' : ""}
      </button>
    `).join("")
    : '<div class="provider-profile-empty">还没有保存配置。<br />点击“新建”添加第一组。</div>';
  renderProviderEditor(
    catalog.profiles.find((profile) => profile.id === selectedProviderProfileId),
  );
}

function providerInput(): {
  profileId?: string;
  name?: string;
  provider: string;
  model: string;
  baseUrl: string;
  thinkingLevel: ProviderThinkingLevel;
  maxOutputTokens?: number;
  apiKey?: string;
} {
  // Key 只从当前 password input 进入单次 HTTPS/localhost 请求；不写 localStorage、
  // 消息数组或 Activity。保存成功后 renderProviderSettings() 会立即清空输入框。
  return {
    ...(selectedProviderProfileId ? { profileId: selectedProviderProfileId } : {}),
    ...(elements.profileNameInput.value ? { name: elements.profileNameInput.value } : {}),
    provider: elements.providerInput.value,
    model: elements.modelInput.value,
    thinkingLevel: elements.thinkingLevelInput.value as ProviderThinkingLevel,
    ...(elements.maxOutputTokensInput.value ? { maxOutputTokens: Number(elements.maxOutputTokensInput.value) } : {}),
    baseUrl: elements.baseUrlInput.value,
    ...(elements.apiKeyInput.value ? { apiKey: elements.apiKeyInput.value } : {}),
  };
}

function showProviderResult(message: string, status: "success" | "error" | "pending"): void {
  elements.providerTestResult.className = `provider-test-result ${status}`;
  elements.providerTestResult.textContent = message;
}

function loadProviderSettings(): Promise<void> {
  // 同时从启动和设置页进入时共享读取，已加载的表单不因导航而重建或丢失未保存内容。
  return providerSettingsLoading ??= (async () => {
    try {
      renderProviderCatalog(await requestJson<ProviderCatalog>("/api/web/provider-settings"));
    } catch {
      elements.providerStatusLabel.textContent = "配置不可用";
      showProviderResult("暂时无法读取配置。你可以稍后重新进入设置，或填写配置后保存。", "error");
    } finally {
      providerSettingsLoading = null;
    }
  })();
}

function currentTaskSkillId(current: LearningState): string | null {
  if (viewMode(current) !== "CURRENT" || !current.overview.active_task) return null;
  // 旧多 Skill Task 仍能展示，但预览选中项不能冒充正在执行的教学焦点。
  return resolveCurrentTaskSkillId(
    current.overview.active_task.related_skill_ids,
    current.teaching.active_skill_id,
    current.overview.current_frontier?.focus_skill_id ?? null,
  );
}

function statusLabel(status: SkillState, skillId?: string): string {
  return skillStatusLabel(status, Boolean(skillId && state && currentTaskSkillId(state) === skillId));
}

function depthLabel(depth: string): string {
  return ({ OVERVIEW: "了解概念", PRACTICAL: "能够应用", DEEP: "深入理解" } as Record<string, string>)[depth] ?? depth;
}

function evidenceTypeLabel(value: string): string {
  return ({ EXPLAIN: "解释", EXPLANATION: "解释", BUILD: "实践", DEBUG: "排查问题", TRANSFER: "迁移应用" } as Record<string, string>)[value] ?? "学习记录";
}

function assistanceLabel(value: string): string {
  return ({ WITH_HELP: "在帮助下完成", WITH_HINT: "有提示", WITH_REFERENCE: "参考资料", INDEPENDENT: "独立完成", TRANSFERRED: "迁移到新场景", NONE: "独立完成" } as Record<string, string>)[value] ?? "学习过程";
}

function currentSkill(current: LearningState): Skill | undefined {
  const goalSkills = currentGoalSkills(current.overview);
  const selected = goalSkills.find((skill) => skill.id === selectedSkillId);
  if (selected) return selected;
  if (hasSavedEndChoice(current)) return;
  // ACTIVE Task 是当前学习的权威；旧教学上下文/规划只能在该 Task 内帮助选焦点。
  const taskSkills = (current.overview.active_task?.related_skill_ids ?? [])
    .filter((id) => goalSkills.some((skill) => skill.id === id));
  const id = resolveCurrentTaskSkillId(taskSkills, current.teaching.active_skill_id,
    current.overview.current_frontier?.focus_skill_id ?? null) ??
    current.teaching.active_skill_id ?? current.overview.current_frontier?.focus_skill_id;
  return goalSkills.find((skill) => skill.id === id) ??
    (viewMode(current) === "ARCHIVED"
      ? goalSkills.find((skill) => current.overview.knowledge_cards.some((card) => card.skill_id === skill.id)) ??
        goalSkills[0]
      : undefined);
}

function hasSavedEndChoice(current: LearningState): boolean {
  const progress = teachingProposalView.closureProgress;
  return !previewEntryId && viewMode(current) === "CURRENT" && ["IDLE", "INITIALIZED"].includes(current.onboarding.status) && !current.overview.active_task &&
    progress?.goal_id === current.active_goal_id && ["CONFIRMED", "PAUSED"].includes(progress?.latest_end_choice_status ?? "");
}

function currentGoalSkills(overview: LearningState["overview"]): Skill[] {
  const currentIds = new Set(overview.current_goal_skill_ids);
  return overview.skills.filter((skill) => currentIds.has(skill.id));
}

function renderMessages(): void {
  const scope = `${activeRouteUiKey}:${previewEntryId ?? "current"}`;
  const preserve = elements.messages.dataset.readingScope === scope;
  const position = captureReadingPosition(elements.messages);
  const focusedAnswer = learnerQuestionView.node.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  elements.messages.dataset.readingScope = scope;
  const attachmentScrollTop = elements.messages.scrollTop;
  let lastUserIndex = -1, latestAssessmentIndex = -1;
  for (let index = messages.length - 1; index >= 0 && (lastUserIndex < 0 || latestAssessmentIndex < 0); index--) {
    const message = messages[index]!;
    if (lastUserIndex < 0 && message.role === "user" && !message.animation_question) lastUserIndex = index;
    if (latestAssessmentIndex < 0 && message.role === "assistant" && message.assessment) latestAssessmentIndex = index;
  }
  // 不持久化另一套评分状态：刷新/历史恢复时，旧卡直接从消息顺序判定为收起。
  // 用户下一次发消息（包括题卡最终提交）后，清掉上一回合的手动展开覆盖。
  const turn = JSON.stringify([sessionId, lastUserIndex, messages[lastUserIndex]?.content]);
  if (turn !== assessmentDisclosureTurn) {
    assessmentDisclosure.clear();
    assessmentDisclosureTurn = turn;
  }
  if (messages.length === 0) {
    lessonFigureView.pauseAll();
    animationPlayer.mount([],animationViewContext());
    explainerPlayer.mount([],animationViewContext());
    speechPlayer.mount([]);
    elements.messages.innerHTML = `
      <div class="empty-conversation">
        <span class="teacher-avatar">AI</span>
        <div>${previewEntryId ? '<h3>这里还没有学习记录</h3><p>这段分支尚未留下讲解或作答，可以返回当前对话继续。</p>' : '<h3>准备好以后，从这里继续</h3><p>老师会结合目标、路线、任务和已有学习记录接着学习，而不是从零开始猜。</p>'}</div>
      </div>`;
    renderLearnerQuestions();
    if (pendingRouteReading?.key === activeRouteUiKey) {
      restoreReadingPosition(elements.messages, pendingRouteReading.position); return;
    }
    alignPendingQuestionOnMobile(true);
    return;
  }
  elements.messages.innerHTML = messages
    .map(
      (message, index) => {
        const attachmentMarkup = message.attachments?.length
          ? `<div class="message-attachments">${message.attachments.map((attachment) => {
            const reference = attachment.id && message.entryId && sessionId
              ? {id: attachment.id, entryId: message.entryId, sessionId} : null;
            const unavailable = reference && deletedConversationAttachments.has(`${reference.sessionId}:${reference.id}`);
            const previewUrl = attachment.previewUrl ?? (reference ? conversationAttachmentUrl(reference, "/visual/image-1") : undefined);
            const body = unavailable ? `${icon("document")}<span>${escapeHtml(attachment.name)} · 附件已删除</span>`
              : attachment.isImage && previewUrl ? `<img class="message-attachment-thumb" src="${escapeHtml(previewUrl)}" alt="${escapeHtml(attachment.name)}" />`
              : `${icon("document")}<span>${escapeHtml(attachment.name)}</span>`;
            return reference && !unavailable
              ? `<button type="button" class="message-attachment-open ${attachment.isImage ? "" : "message-attachment-file"}" data-conversation-attachment="${reference.id}" data-attachment-entry="${escapeHtml(reference.entryId)}" aria-label="查看附件：${escapeHtml(attachment.name)}">${body}</button>`
              : `<span class="message-attachment-file">${body}</span>`;
          }).join("")}</div>`
          : "";
        return `
        <article data-reading-key="${escapeHtml(message.entryId ?? `${sessionId}:message:${index}`)}" class="message ${message.role} ${previewEntryId && message.entryId === previewEntryId ? "located-message" : ""}" ${message.entryId ? `data-entry-id="${escapeHtml(message.entryId)}"` : ""} ${message.streaming ? 'data-streaming="true"' : ""}>
          <div class="message-meta">${message.role === "user" ? "你" : "老师"}</div>
          <div class="message-row">${message.role === "assistant" ? '<span class="teacher-avatar">AI</span>' : ""}<div class="message-content">${animationQuestionMarkup(message)}${attachmentMarkup}${message.entryId ? `<div data-note-message="${escapeHtml(message.entryId)}" data-note-session="${escapeHtml(sessionId ?? "")}" data-note-channel="teacher">${illustrateMessage(message)}</div>` : illustrateMessage(message)}${message.assessment && message.role === "assistant" ? answerAssessmentMarkup(message.assessment, false, assessmentDisclosure.get(message.assessment.id) ?? (!freshAssessments.has(message.assessment.id) || index < lastUserIndex || index !== latestAssessmentIndex)) : ""}${message.speech && message.role === "assistant" ? speechMarkup(message.speech) : ""}${message.animation && message.role === "assistant" ? animationMarkup(message.animation) : ""}${message.explainer && message.role === "assistant" ? explainerMarkup(message.explainer) : ""}${message.streaming ? '<span class="typing-caret"></span>' : ""}</div></div>
        </article>`;
      },
    )
    .join("");
  elements.messages.querySelectorAll<HTMLElement>("article.message").forEach((article,i)=>{
    if (messages[i]?.figures?.length) lessonFigureView.mount(article,messages[i]!,canAskFigure);
  });
  lessonFigureView.prune();
  conversationAttachmentPreview.mount(elements.messages);
  speechPlayer.mount(messages.flatMap(message => message.speech && message.role === "assistant" ? [message.speech] : []));
  animationPlayer.mount(messages.flatMap(message=>message.animation&&message.role==="assistant"?[message.animation]:[]),animationViewContext());
  explainerPlayer.mount(messages.flatMap(message=>message.explainer&&message.role==="assistant"?[message.explainer]:[]),animationViewContext());
  renderLearnerQuestions();
  // 路径恢复优先于普通的“跟随最新消息”；重绘期间的scroll事件也不能覆盖待恢复锚点。
  if (pendingRouteReading?.key === activeRouteUiKey) {
    restoreReadingPosition(elements.messages, pendingRouteReading.position); return;
  }
  if (preserve && focusedAnswer?.isConnected) focusedAnswer.focus({preventScroll:true});
  if (conversationAttachmentPreview.opened) {elements.messages.scrollTop = attachmentScrollTop; return;}
  // 手机端待答题就是最新内容：题干滚到阅读区顶部，长对话留在上方可回看；其余情况保持贴底。
  if (preserve) restoreReadingPosition(elements.messages, position, true);
  else if (learnerQuestionView.pending && mobileNavMedia.matches) alignPendingQuestionOnMobile(true);
  else {
    elements.messages.scrollTop = elements.messages.scrollHeight;
    // 程序跟随最新内容时已经回到消息底部：底部三格跟着回来。
    setMobileSurfaceTabsHidden(false);
  }
}

function receiveQuestion(request: LearnerQuestionRequest): void {
  if (!state || request.session_id !== sessionId || previewEntryId) return;
  state.teaching.learner_questions = {...state.teaching.learner_questions, pending: request,
    last_answer: state.teaching.learner_questions?.last_answer ?? null};
  // 真实题卡先挂载，之后的正文仍逐段更新；不等待整轮结束，也不从自然语言猜测出题成功。
  renderLearnerQuestions();
  syncComposerAvailability();
}

function renderLearnerQuestions(): void {
  const pending = state && viewMode(state) === "CURRENT" && !previewEntryId ? state.teaching.learner_questions?.pending ?? null : null;
  learnerQuestionView.render(pending, generating || remoteGenerating || masteryDecisionPending || learningRecordNavigationPending || voiceInput.busy);
  if (pending) elements.messages.append(learnerQuestionView.node);
  else learnerQuestionView.node.remove();
  if (!teachingProposalView.node.hidden && teachingProposalView.node.childElementCount) elements.messages.append(teachingProposalView.node);
  // 新题目出现时先对齐一次；重复渲染是否继续跟随由 renderMessages 决定。
  if (pending) alignPendingQuestionOnMobile(false);
  else alignedQuestionKey = "";
  syncComposerAvailability();
}

// 手机端待答题优先：题目起始位置滚到阅读区顶部，长对话被暂时推上去，向上滚动仍可回看讲解。
// 新题目一定对齐；同一题只在用户仍贴底跟随时对齐，不抢占用户自己向上回看的浏览位置。
function alignPendingQuestionOnMobile(follow: boolean): void {
  const key = learnerQuestionView.currentQuestionKey;
  if (!key || !mobileNavMedia.matches) return;
  const container = elements.messages;
  const newQuestion = alignedQuestionKey !== key;
  alignedQuestionKey = key;
  const following = container.scrollTop + container.clientHeight >= container.scrollHeight - 80;
  if (!newQuestion && !(follow && following)) return;
  window.requestAnimationFrame(() => {
    if (!mobileNavMedia.matches || !learnerQuestionView.pending) return;
    const previous = container.style.scrollBehavior;
    container.style.scrollBehavior = "auto";
    container.scrollTop += learnerQuestionView.node.getBoundingClientRect().top - container.getBoundingClientRect().top - 8;
    container.style.scrollBehavior = previous;
  });
}

// 流式阶段只更新当前 assistant 消息，避免每个 token 都重建整段历史并产生闪烁。
function updateStreamingMessage(assistant: UiMessage): void {
  const node = elements.messages.querySelector<HTMLElement>('.message.assistant[data-streaming="true"]');
  if (!node) { renderMessages(); return; }
  const contentNode = node.querySelector(".message-content");
  if (!contentNode) return;
  const position = captureReadingPosition(elements.messages);
  contentNode.innerHTML =
    illustrateMessage(assistant) +
    (assistant.streaming ? '<span class="typing-caret"></span>' : "");
  lessonFigureView.mount(contentNode,assistant,canAskFigure);
  restoreReadingPosition(elements.messages, position, true);
  if (position.following) setMobileSurfaceTabsHidden(false);
}

function renderActivities(): void {
  elements.activityCount.textContent = String(activities.length);
  elements.activityPanel.hidden = activities.length === 0;
  elements.activityIndicator.classList.toggle("hidden", activities.length === 0);
  elements.activity.innerHTML = activities.length
    ? activities
        .slice(-8)
        .reverse()
        .map(
          (activity) => `
            <div class="activity-item ${activity.status}">
              <span>${activity.status === "done" ? icon("check") : activity.status === "error" ? "!" : "·"}</span>
              <div><strong>${escapeHtml(activity.label)}</strong><small>${escapeHtml(activity.toolName)}</small></div>
            </div>`,
        )
        .join("")
    : '<p class="muted">老师调用学习工具时，会在这里留下简洁轨迹。</p>';
}

function renderRoute(overview: LearningState["overview"], selected?: Skill): void {
  const heading = document.querySelector<HTMLElement>(".route-card .card-heading > div");
  const mainIds = overview.learning_paths?.main_skill_ids;
  const skills = currentGoalSkills(overview).filter(s => !mainIds || mainIds.includes(s.id));
  const mastered = confirmedProgress(skills).confirmed;
  if (heading) heading.innerHTML = `<h2>学习路线</h2><p class="route-goal-name" title="${escapeHtml(overview.current_goal ?? "")}">${escapeHtml(goalDisplayTitle(overview.current_goal ?? "新目标"))}</p><div class="route-progress"><span>已确认掌握 ${mastered} 项 · 已展开 ${skills.length} 项</span></div>`;
  // 完整阶段树直接展示；阶段归属与学习状态仍只读投影Kernel事实。
  const disclosures = captureDisclosures(elements.skillRoute);
  elements.skillRoute.innerHTML = renderLearningRoute(overview, currentGoalSkills(overview), {
    selectedSkillId: selected?.id ?? null,
    currentTaskSkillId: state ? currentTaskSkillId(state) : null,
  });
  restoreDisclosures(elements.skillRoute, disclosures);
}

// 当前任务信息进入共享学习栏：只显示简短状态，不用长说明挤压阅读区。
// 手机端把任务行当作标题行（标题只占一行），是否显示通用标题由 task-titled 决定。
function renderHeaderTaskInfo(next: LearningState): void {
  const task = next.overview.active_task;
  const branch = next.overview.learning_paths?.branches.find(b => b.id === next.overview.learning_paths?.active_branch_id);
  elements.headerTaskInfo.classList.toggle("route-task-info", Boolean(branch));
  const savedEndChoice = hasSavedEndChoice(next);
  elements.stageHeading.classList.toggle("task-titled", Boolean(task) || savedEndChoice);
  if (!task && !branch) {
    elements.headerTaskInfo.textContent = savedEndChoice ? "此前结束选择已保存 · 可从路线继续复习" : "";
    elements.headerTaskInfo.classList.toggle("hidden", !savedEndChoice);
    return;
  }
  const reviewing = viewMode(next) === "CURRENT" && Boolean(task?.id.startsWith("review-")) && !previewEntryId;
  elements.headerTaskInfo.innerHTML = `<span class="header-task-label">${escapeHtml(currentSkill(next)?.name ?? plainTextSummary(task?.title ?? branch?.title ?? "", 36))}</span>${branch ? `<span class="route-active-branch"><span>${branch.purpose === "prerequisite" ? "补足中" : "拓展中"}</span><button type="button" data-route-branch="${escapeHtml(branch.id)}" data-route-action="return" ${generating || remoteGenerating || changingRoute ? "disabled" : ""}>返回主线</button></span>` : reviewing ? `<button class="inline-review-finish" type="button" data-review-finish ${generating || learningRecordNavigationPending ? "disabled" : ""}>结束复习</button>` : ""}`;
  elements.headerTaskInfo.classList.toggle("review-task-info", reviewing);
  elements.headerTaskInfo.classList.remove("hidden");
}

function renderTask(next: LearningState): void {
  renderHeaderTaskInfo(next);
}

function renderSkillAndEvidence(
  overview: LearningState["overview"],
  skill?: Skill,
  readOnly = false,
): void {
  // 来源浏览只替换展示上下文，不切换当前课堂，也不借历史卡片提供掌握操作。
  const browsingSource = Boolean(cardSource.reference) && !document.body.classList.contains("task-focus-collapsed");
  const source = browsingSource ? resolvedCardSource() : null;
  if (browsingSource) { skill = source?.skill; readOnly = true; }
  const introductionTitle = browsingSource ? "笔记来源介绍" : readOnly ? "历史学习介绍" : "当前学习介绍";
  const description = skill?.description || "围绕当前任务，一步步理解和练习。";
  const descriptionCharacters = Array.from(description);
  const descriptionPreview = descriptionCharacters.length > 90
    ? `${descriptionCharacters.slice(0, 90).join("")}…`
    : description;
  const descriptionMarkup
    = descriptionCharacters.length > 90
      ? `<div class="skill-description"><p class="skill-description-text"><span class="skill-description-preview">${escapeHtml(descriptionPreview)}</span><span class="skill-description-full" hidden>${escapeHtml(description)}</span></p><button type="button" class="skill-description-toggle" data-action="toggle-skill-description">查看完整介绍</button></div>`
      : `<div class="skill-description"><p class="skill-description-text">${escapeHtml(description)}</p></div>`;
  // Mastery/Reopen 是用户专属动作：按钮随「当前学习」卡渲染，直达 User API，不进入聊天文本。
  // 按钮文字自己说明了确认主体，不再配说明小字；未开始学习时不显示只有说明的空块。
  const masteryBlock = readOnly ? "" : skill
    ? skill.status === "LEARNING" || skill.status === "PRACTICING"
      ? `<div class="skill-mastery"><button class="mastery-button" data-action="master" data-skill="${escapeHtml(skill.id)}">我确认已经掌握</button></div>`
      : skill.status === "MASTERED_BY_USER"
        ? `<div class="skill-mastery"><button class="secondary-action" data-action="review" data-skill="${escapeHtml(skill.id)}">重新学习</button></div>`
        : ""
    : "";
  const introductionKey = `${browsingSource ? cardSource.reference!.goalId : state?.view_goal_id ?? state?.active_goal_id ?? ""}:${skill?.id ?? ""}`;
  const introductionOpen = expandedSkillIntroductions.has(introductionKey);
  elements.skill.dataset.introductionKey = introductionKey;
  elements.skill.dataset.context = browsingSource ? "source" : readOnly ? "history" : "current";
  elements.skill.innerHTML = skill && !mobileNavMedia.matches
    ? `<div class="focused-skill-heading"><span class="focused-skill-label">${browsingSource ? "笔记来源" : readOnly ? "历史" : previewEntryId ? "回顾" : "学习中"}</span><div class="current-skill-title"><h3 title="${escapeHtml(skill.name)}">${escapeHtml(skill.name)}</h3></div><span class="state-badge ${skill.status.toLowerCase()}">${statusLabel(skill.status, skill.id)}</span></div><div class="focused-skill-controls"><button type="button" class="skill-description-toggle" data-action="toggle-focused-introduction" aria-expanded="${introductionOpen}" aria-controls="focused-skill-details">${introductionOpen ? "收起介绍" : "查看介绍"}</button>${masteryBlock}</div>
       <div class="focused-skill-details" id="focused-skill-details" role="region" aria-label="${introductionTitle}" ${introductionOpen ? "" : "hidden"}><header class="skill-introduction-heading"><h3>${introductionTitle}</h3><button type="button" data-action="close-focused-introduction" aria-label="关闭学习介绍">${icon("close")}</button></header><p class="focused-skill-meta">目标深度：${escapeHtml(depthLabel(skill.target_depth))}</p><div class="skill-description-text reading-content">${skillIntroductionMarkup(description)}</div>${skillCardSummaryMarkup(skill)}<div class="focused-records-slot"></div></div>`
    : skill ? `
      <header class="context-card-head"><h2>${readOnly ? "历史学习" : previewEntryId ? "学习记录" : "当前学习"}</h2><span class="state-badge ${skill.status.toLowerCase()}">${statusLabel(skill.status, skill.id)}</span></header>
      <div class="current-skill-title"><span class="mini-book" aria-hidden="true">${icon("book")}</span><h3>${escapeHtml(skill.name)}</h3></div>
      <div class="meta-row"><span>目标深度</span><strong>${escapeHtml(depthLabel(skill.target_depth))}</strong></div>
      ${masteryBlock}
      ${descriptionMarkup}
      ${skillCardSummaryMarkup(skill)}`
    : `<header class="context-card-head"><h2>${readOnly ? "历史学习" : "当前学习"}</h2></header><div class="empty-context"><strong>${!readOnly && state && hasSavedEndChoice(state) ? "此前结束选择已保存" : readOnly ? "未找到关联技能" : "尚未选择学习内容"}</strong><p>${!readOnly && state && hasSavedEndChoice(state) ? "当前没有进行中的任务，原学习记录已保留；可从路线选择知识点继续复习。" : readOnly ? "这段对话仍可阅读，但关联目标的学习资料暂不可用。" : "建立路线后会显示当前学习重点。"}</p></div>`;

  const evidence = browsingSource
    ? notesLibraryCache?.projects.find(project => project.goal_profile.id === cardSource.reference!.goalId)?.evidence ?? []
    : overview.recent_evidence;
  const relevantEvidence = evidence
    .filter((item) => !skill || item.skill_id === skill.id)
    .slice(0, 4);
  // 右侧栏占满由真实记录决定：没有记录时紧凑排列，不让证据面板撑成空面板。
  elements.contextColumn.classList.toggle("no-evidence", relevantEvidence.length === 0);
  elements.evidence.innerHTML = relevantEvidence.length
    ? relevantEvidence.map(learningRecordMarkup).join("")
    : '<p class="muted">还没有近期学习记录。</p>';
  focusedWorkspace.sync();

}

// ===== Knowledge Cards（卡片为本地回忆/确认工具，不计算 Mastery、百分比或概率）=====

function overviewCards(): KnowledgeCard[] {
  return state?.overview.knowledge_cards ?? [];
}

function cardsForSkill(skillId: string | null): KnowledgeCard[] {
  if (!skillId) return [];
  const source = resolvedCardSource();
  if (source?.skill.id === skillId) return source.project.knowledge_cards.filter(card => card.skill_id === skillId);
  return overviewCards().filter((card) => card.skill_id === skillId);
}

function displayedKnowledgeCardIds(): string[] {
  return [...elements.knowledgeCards.querySelectorAll<HTMLElement>(".knowledge-card[data-card-id]")]
    .map((node) => node.dataset.cardId!);
}

function syncKnowledgeCardNotice(fromTeacher = false, viewedIds: readonly string[] = []): void {
  const onboarding = state && viewMode(state) === "CURRENT" &&
    !["IDLE", "INITIALIZED"].includes(state.onboarding.status);
  const goal = state && !onboarding && viewMode(state) !== "UNAVAILABLE"
    ? state.view_goal_id ?? (viewMode(state) === "CURRENT" ? state.active_goal_id : null)
    : null;
  let count = 0;
  if (goal && state) {
    const skillIds = new Set(currentGoalSkills(state.overview).map((skill) => skill.id));
    cardNotice.observe(goal, overviewCards().filter((card) => skillIds.has(card.skill_id)).map((card) => card.id), fromTeacher);
    const displayed = cardsForSkill(currentSkill(state)?.id ?? null).map((card) => card.id);
    // 只有用户实际打开/操作的既有 DOM 卡片才算查看；面板已打开时的状态刷新不读掉后来新增卡。
    // 隐藏的主区/后台标签不能代替查看，旧卡动作不能清除别的新卡。
    if (workspace.current === "learn" && mobileSurface === "learn" && !document.hidden && !assistantView.visibleInClassroom &&
      !document.body.classList.contains("task-focus-collapsed")) {
      const viewed = new Set(viewedIds);
      cardNotice.markViewed(goal, displayed.filter((id) => viewed.has(id)));
    }
    count = cardNotice.count(goal, displayed);
    const saved = cardNotice.serialize();
    if (saved !== savedCardNotice) {
      try { localStorage.setItem(CARD_NOTICE_KEY, saved); savedCardNotice = saved; }
      catch { /* 存储不可用时，本页内的提示仍然有效。 */ }
    }
  }
  const description = count ? `${count} 张新卡片待查看` : "";
  elements.cardsNewBadge.hidden = count === 0;
  elements.taskFocusToggle.setAttribute("aria-label", description ? `知识卡片，${description}` : "知识卡片");
  elements.taskFocusToggle.title = description || "查看当前技能的知识卡片";
  if (elements.cardsNewStatus.textContent !== description) elements.cardsNewStatus.textContent = description;
}

function cardFeedbackLabel(status: CardFeedback | null): string {
  return status === "KNOWN" ? "记得" : status === "UNSURE" ? "模糊" : status === "UNKNOWN" ? "忘了" : "";
}

function cardCounts(cards: KnowledgeCard[]): { known: number; unsure: number; unknown: number } {
  return {
    known: cards.filter((card) => card.feedback === "KNOWN").length,
    unsure: cards.filter((card) => card.feedback === "UNSURE").length,
    unknown: cards.filter((card) => card.feedback === "UNKNOWN").length,
  };
}

function updateLocalCard(updated: KnowledgeCard): void {
  updateNotesLibraryCard(updated);
  if (!state) return;
  const cards = state.overview.knowledge_cards;
  const index = cards.findIndex((card) => card.id === updated.id);
  if (index >= 0) cards[index] = updated;
  // 历史卡片编辑不能把另一目标的卡片插入当前课堂投影。
}

function noteBlockMarkup(card: KnowledgeCard): string {
  if (editingNoteCardId === card.id) {
    const draft = cardNoteDrafts.get(card.id);
    return `
      <div class="kc-note-editor">
        <textarea data-note-textarea="${escapeHtml(card.id)}" rows="3" placeholder="写下你的理解、疑问或提醒…">${escapeHtml(draft ?? card.learner_note ?? "")}</textarea>
        <div class="kc-note-actions">
          <button type="button" class="ghost-button" data-card-action="cancel-note" data-card-id="${escapeHtml(card.id)}">取消</button>
          <button type="button" class="primary-button" data-card-action="save-note" data-card-id="${escapeHtml(card.id)}">保存笔记</button>
        </div>
      </div>`;
  }
  if (card.learner_note) {
    return `
      <button type="button" class="kc-note-preview" data-card-action="edit-note" data-card-id="${escapeHtml(card.id)}">
        <span class="kc-note-label">我的笔记</span>
        <span class="kc-note-text">${escapeHtml(card.learner_note)}</span>
        <span class="kc-note-edit-hint">编辑</span>
      </button>`;
  }
  return `
    <button type="button" class="kc-note-add" data-card-action="edit-note" data-card-id="${escapeHtml(card.id)}">${icon("plus")} 添加我的笔记</button>`;
}

function cardEditMarkup(card: KnowledgeCard): string {
  const draft = cardEditDrafts.get(card.id) ?? card;
  return `
    <div class="kc-edit-editor">
      <label class="kc-edit-field"><span>问题</span><textarea data-edit-question="${escapeHtml(card.id)}" rows="2">${escapeHtml(draft.question)}</textarea></label>
      <label class="kc-edit-field"><span>答案</span><textarea data-edit-answer="${escapeHtml(card.id)}" rows="4">${escapeHtml(draft.answer)}</textarea></label>
      <div class="kc-edit-actions">
        <button type="button" class="ghost-button" data-card-action="cancel-edit" data-card-id="${escapeHtml(card.id)}">取消</button>
        <button type="button" class="primary-button" data-card-action="save-edit" data-card-id="${escapeHtml(card.id)}">保存</button>
      </div>
    </div>`;
}

function knowledgeCardMarkup(card: KnowledgeCard): string {
  const flipped = flippedCards.has(card.id);
  const back =
    editingCardId === card.id
      ? cardEditMarkup(card)
      : `
        <div class="kc-divider"></div>
        <span class="kc-label kc-answer-label">参考答案</span>
        <div class="kc-answer reading-content">${renderMarkdown(card.answer)}</div>
        <div class="kc-feedback-row">
          <button type="button" class="kc-feedback known ${card.feedback === "KNOWN" ? "selected" : ""}" data-card-action="feedback" data-card-id="${escapeHtml(card.id)}" data-feedback="KNOWN">记得</button>
          <button type="button" class="kc-feedback unsure ${card.feedback === "UNSURE" ? "selected" : ""}" data-card-action="feedback" data-card-id="${escapeHtml(card.id)}" data-feedback="UNSURE">模糊</button>
          <button type="button" class="kc-feedback unknown ${card.feedback === "UNKNOWN" ? "selected" : ""}" data-card-action="feedback" data-card-id="${escapeHtml(card.id)}" data-feedback="UNKNOWN">忘了</button>
        </div>
        <div class="kc-note-block">${noteBlockMarkup(card)}</div>
        <div class="kc-card-actions">
          <button type="button" data-card-action="edit" data-card-id="${escapeHtml(card.id)}">${icon("edit")} 编辑</button>
          <button type="button" class="kc-delete" data-card-action="delete" data-card-id="${escapeHtml(card.id)}">${icon("trash")} 删除</button>
        </div>`;
  return `
    <article data-reading-key="${escapeHtml(card.id)}" class="knowledge-card ${flipped ? "flipped" : ""}" data-card-id="${escapeHtml(card.id)}">
      <div class="kc-front">
          <div class="kc-question reading-content">${renderMarkdown(card.question)}</div>
        <button type="button" class="kc-flip-button" data-card-action="flip" data-card-id="${escapeHtml(card.id)}">${flipped ? "收起答案" : "显示答案"}</button>
      </div>
      <div class="kc-back">${back}
      </div>
    </article>`;
}

let cardReviewMode = false;
const cardReviewPositions = new Map<string, number>();

function resolvedCardSource() {
  return cardSource.reference && notesLibraryCache ? resolveCardSource(notesLibraryCache.projects, cardSource.reference) : null;
}

function cardScrollHost(): HTMLElement {
  return getComputedStyle(elements.knowledgeCards).overflowY === "visible" ? elements.cardsPane : elements.knowledgeCards;
}

function renderKnowledgeCards(skill?: Skill, fromTeacher = false): void {
  if (state) {
    renderSkillAndEvidence(state.overview, skill ?? currentSkill(state), viewMode(state) !== "CURRENT");
    renderBranches();
  }
  const host = cardScrollHost();
  const position = captureReadingPosition(host);
  const source = resolvedCardSource();
  let heading = "";
  elements.knowledgeCards.classList.toggle("is-source-browsing", Boolean(cardSource.reference));
  if (cardSource.reference) {
    const back = '<button type="button" class="text-button" data-card-source-return>返回笔记</button>';
    if (cardSource.phase !== "ready" || !source) {
      elements.knowledgeCards.innerHTML = `<div class="kc-empty" role="status"><h3>${cardSource.phase === "loading" ? "正在定位来源卡片…" : "来源卡片暂不可用"}</h3><p>${escapeHtml(cardSource.phase === "loading" ? "正在读取已保存的来源，当前学习任务没有改变。" : cardSource.error || "来源可能已删除或不可访问。当前学习任务没有改变。")}</p>${back}</div>`;
      return;
    }
    skill = source.skill;
    heading = `<header class="card-source-heading"><span>笔记来源 · ${escapeHtml(goalDisplayTitle(source.project.goal_profile.goal_description))}</span>${back}</header>`;
  }
  const cards = skill ? cardsForSkill(skill.id) : [];
  syncKnowledgeCardNotice(fromTeacher);
  elements.knowledgeCards.classList.toggle("is-reviewing", cardReviewMode);
  if (!cards.length) {
    elements.knowledgeCards.innerHTML = `<div class="kc-empty">${icon("cards")}<h3>这里会整理本节的关键知识</h3><p>老师会在合适的学习节点生成知识卡片，供你回忆、理解与自检。</p><button type="button" class="ghost-button" data-card-return-dialogue>返回对话</button></div>`;
    return;
  }
  const index = Math.min(cardReviewPositions.get(skill!.id) ?? 0, cards.length - 1);
  const toolbar = `<div class="card-review-toolbar"><span>${cardReviewMode ? `第 ${index + 1} / ${cards.length} 张 · 先回忆，再看答案` : `${cards.length} 张卡片`}</span><button type="button" class="text-button" data-card-mode>${cardReviewMode ? "返回列表" : "逐张复习"}</button></div>`;
  elements.knowledgeCards.innerHTML = heading + toolbar + (cardReviewMode ? knowledgeCardMarkup(cards[index]!) + `<div class="card-review-navigation"><button class="text-button" type="button" data-card-step="-1" ${index === 0 ? "disabled" : ""}>上一张</button><span role="status">${cards[index]!.feedback ? `自评：${cardFeedbackLabel(cards[index]!.feedback)}` : "尚未自评"}</span><button class="text-button" type="button" data-card-step="1" ${index === cards.length - 1 ? "disabled" : ""}>下一张</button></div>` : cards.map(knowledgeCardMarkup).join(""));
  restoreReadingPosition(host, position);
}

// 任务 2：当前 Skill 区域只显示 self-report 计数汇总，不渲染任何百分比/评分/概率。
function skillCardSummaryMarkup(skill: Skill): string {
  const cards = cardsForSkill(skill.id);
  if (!cards.length) return "";
  const counts = cardCounts(cards);
  return `
    <div class="kc-skill-summary">
      <button type="button" class="kc-skill-summary-toggle" data-card-action="summary-toggle" data-skill="${escapeHtml(skill.id)}">
        <span class="kc-skill-summary-title">知识卡片</span>
        <span class="kc-skill-summary-count">${cards.length} 张</span>
      </button>
      <div class="kc-skill-summary-rows">
        <span class="kc-skill-count known">会了 <b>${counts.known}</b></span>
        <span class="kc-skill-count unsure">有点模糊 <b>${counts.unsure}</b></span>
        <span class="kc-skill-count unknown">不会 <b>${counts.unknown}</b></span>
      </div>
    </div>`;
}

function rerenderCards(): void {
  if (!state) return;
  const skill = resolvedCardSource()?.skill ?? currentSkill(state);
  renderKnowledgeCards(skill);
  const summaryHost = document.querySelector<HTMLElement>(".kc-skill-summary");
  if (summaryHost) {
    summaryHost.outerHTML = skill ? skillCardSummaryMarkup(skill) : "";
  }
  renderNotesView();
}

async function postCardFeedback(cardId: string, feedback: CardFeedback): Promise<void> {
  try {
    const updated = await requestJson<KnowledgeCard>(
      `/api/web/cards/${encodeURIComponent(cardId)}/feedback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: feedback }),
      },
    );
    updateLocalCard(updated);
    rerenderCards();
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}

async function putCardNote(cardId: string, note: string, origin: "card" | "notes" = "card"): Promise<void> {
  try {
    const updated = await requestJson<KnowledgeCard>(
      `/api/web/cards/${encodeURIComponent(cardId)}/note`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      },
    );
    updateLocalCard(updated);
    updateNotesLibraryCard(updated);
    cardNoteDrafts.delete(cardId);
    if (origin === "card" && editingNoteCardId === cardId) editingNoteCardId = null;
    if (origin === "notes" && editingLibraryNoteCardId === cardId) editingLibraryNoteCardId = null;
    rerenderCards();
    if (!elements.notesPage.hidden) renderNotesView();
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}

async function deleteCardNote(cardId: string): Promise<void> {
  try {
    const updated = await requestJson<KnowledgeCard>(
      `/api/web/cards/${encodeURIComponent(cardId)}/note`,
      { method: "DELETE" },
    );
    updateLocalCard(updated);
    updateNotesLibraryCard(updated);
    cardNoteDrafts.delete(cardId);
    editingNoteCardId = null;
    if (editingLibraryNoteCardId === cardId) editingLibraryNoteCardId = null;
    rerenderCards();
    if (!elements.notesPage.hidden) renderNotesView();
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}

// 删除/编辑卡片是用户动作：Agent 不参与。删除返回 204 No Content，这里不解析 JSON body。
async function deleteCard(cardId: string): Promise<void> {
  try {
    const response = await fetch(`/api/web/cards/${encodeURIComponent(cardId)}`, { method: "DELETE" });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { detail?: string };
      throw new Error(body.detail ?? `HTTP ${response.status}`);
    }
    if (state) {
      const cards = state.overview.knowledge_cards;
      const index = cards.findIndex((card) => card.id === cardId);
      if (index >= 0) cards.splice(index, 1);
    }
    notesLibraryCache?.projects.forEach(project => { project.knowledge_cards = project.knowledge_cards.filter(card => card.id !== cardId); });
    if (editingCardId === cardId) editingCardId = null;
    cardEditDrafts.delete(cardId);
    cardNoteDrafts.delete(cardId);
    rerenderCards();
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}

async function updateCard(cardId: string, question: string, answer: string): Promise<void> {
  try {
    const updated = await requestJson<KnowledgeCard>(
      `/api/web/cards/${encodeURIComponent(cardId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, answer }),
      },
    );
    updateLocalCard(updated);
    cardEditDrafts.delete(cardId);
    editingCardId = null;
    rerenderCards();
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}

function notesGroups(): Array<{ skill: Skill; goal: LearningLibraryProject["goal_profile"]; cards: KnowledgeCard[] }> {
  const groups = (notesLibraryCache?.projects ?? []).flatMap(project => project.skills.flatMap(skill => {
    const cards = project.knowledge_cards.filter(card => card.skill_id === skill.id && card.learner_note);
    return cards.length ? [{skill, goal:project.goal_profile, cards}] : [];
  }));
  const order = document.querySelector<HTMLSelectElement>("#notes-sort")?.value ?? "updated";
  for (const group of groups) group.cards.sort((a,b) => Date.parse(b.note_updated_at ?? b.created_at) - Date.parse(a.note_updated_at ?? a.created_at));
  return groups.sort((a,b) => order === "name" ? a.skill.name.localeCompare(b.skill.name, "zh-CN") : Date.parse(b.cards[0]!.note_updated_at ?? b.cards[0]!.created_at) - Date.parse(a.cards[0]!.note_updated_at ?? a.cards[0]!.created_at));
}

// 打开笔记前拉取全量账本；保存笔记后同样调用以刷新缓存。
async function refreshNotesLibrary(): Promise<LearningLibraryResponse> {
  const request = ++notesLibraryRequest;
  const library = await requestJson<LearningLibraryResponse>("/api/web/learning-library");
  if (request === notesLibraryRequest) notesLibraryCache = library;
  return library;
}

// 保存笔记后局部更新缓存，避免整表重拉。
function updateNotesLibraryCard(updated: KnowledgeCard): void {
  // 保存后的新笔记不能被更早发出的整库响应覆盖；草稿仍由原编辑入口保存。
  notesLibraryRequest++;
  if (!notesLibraryCache) return;
  for (const project of notesLibraryCache.projects) {
    const idx = project.knowledge_cards.findIndex((card) => card.id === updated.id);
    if (idx >= 0) {
      project.knowledge_cards[idx] = updated;
      return;
    }
  }
}

function renderNotesView(): void {
  excerptNotesView.refreshLabels();
  // 两个主区页面可以分别保留编辑草稿；刷新卡片反馈不应覆盖未保存笔记。
  const draft = editingLibraryNoteCardId ? elements.notesContent.querySelector<HTMLTextAreaElement>(`[data-note-textarea="${CSS.escape(editingLibraryNoteCardId)}"]`)?.value : undefined;
  const position = captureReadingPosition(document.querySelector<HTMLElement>("#main-content")!);
  const disclosures = new Set([...elements.notesContent.querySelectorAll<HTMLDetailsElement>("details[open][data-note-disclosure]")].map(node => node.dataset.noteDisclosure));
  const groups = notesGroups();
  if (!groups.length) {
    elements.notesContent.innerHTML =
      '<div class="library-empty-state"><h3>卡片笔记</h3><p>在知识卡片上添加的理解和疑问，也会集中显示在这里。</p></div>';
    interiorWorkspace.refreshCollections();
    if (workspace.current === "notes") restoreReadingPosition(document.querySelector<HTMLElement>("#main-content")!, position);
    return;
  }
  elements.notesContent.innerHTML = groups
    .map(
      ({ skill, goal, cards }) => `
      <section class="notes-group">
        <header class="notes-group-head"><strong>${escapeHtml(skill.name)}</strong><span>${cards.length} 条笔记</span></header>
        <div class="notes-list">
          ${cards
            .map((card) => {
              const noteBody =
                editingLibraryNoteCardId === card.id
                  ? `<textarea data-note-textarea="${escapeHtml(card.id)}" rows="3" class="notes-note-textarea" aria-label="编辑我的笔记">${escapeHtml(draft ?? card.learner_note ?? "")}</textarea>
                     <div class="kc-note-actions">
                       <button type="button" class="ghost-button" data-card-action="cancel-note" data-card-id="${escapeHtml(card.id)}">取消</button>
                       <button type="button" class="primary-button" data-card-action="save-note" data-card-id="${escapeHtml(card.id)}">保存笔记</button>
                     </div>`
                  : card.learner_note!.length > 600
                    ? `<details class="notes-long-body" data-note-disclosure="body:${escapeHtml(card.id)}" ${disclosures.has(`body:${card.id}`) ? "open" : ""}><summary><span class="notes-long-preview">${escapeHtml(plainTextSummary(card.learner_note!,220))} · 展开全文</span><span class="notes-long-collapse">收起长笔记</span></summary><div class="reading-content notes-note-preview">${renderMarkdown(card.learner_note!)}</div></details>`
                    : `<div class="reading-content notes-note-preview">${renderMarkdown(card.learner_note ?? "")}</div>`;
              return `
                <article class="notes-item" data-reading-key="${escapeHtml(card.id)}" data-search-text="${escapeHtml(`${skill.name} ${card.question} ${card.learner_note ?? ""}`)}">
                  <div class="notes-note">
                    ${noteBody}
                  </div>
                  <div class="notes-metadata"><time datetime="${escapeHtml(card.note_updated_at ?? card.created_at)}">${formatLocalTime(card.note_updated_at ?? card.created_at)} ${card.note_updated_at ? "更新" : "记录"}</time><span>${escapeHtml(goalDisplayTitle(goal.goal_description))}</span></div>
                  <details class="notes-question" data-note-disclosure="question:${escapeHtml(card.id)}" ${disclosures.has(`question:${card.id}`) ? "open" : ""}><summary><span>关联问题</span><span class="notes-question-preview">${escapeHtml(plainTextSummary(card.question, 180))}</span>${icon("chevronDown")}</summary><div class="reading-content">${renderMarkdown(card.question)}</div></details>
                  <div class="notes-item-actions">
                    <button type="button" class="ghost-button" data-card-action="open-card" data-card-id="${escapeHtml(card.id)}">查看卡片</button>
                    <button type="button" class="ghost-button" data-card-action="edit-note" data-card-id="${escapeHtml(card.id)}">编辑笔记</button>
                  </div>
                </article>`;
            })
            .join("")}
        </div>
      </section>`,
    )
    .join("");
  interiorWorkspace.refreshCollections();
  if (workspace.current === "notes") restoreReadingPosition(document.querySelector<HTMLElement>("#main-content")!, position);
}

function renderGoalOnboardingState(next: LearningState): void {
  const replacing = next.onboarding.replace_existing;
  const routeMessage = replacing
    ? "新目标确认后显示新路线；旧目标的路线与任务可随时切回。"
    : "目标确认后显示新的学习路线。";

  elements.skillRoute.innerHTML = `<li class="empty-item">${routeMessage}</li>`;
  const heading = document.querySelector(".route-card .card-heading > div");
  if (heading) heading.innerHTML = "<h2>学习路线</h2>";
  const progress = document.querySelector<HTMLProgressElement>("#learning-stage-progress");
  if (progress) progress.hidden = true;
  elements.headerTaskInfo.textContent = "正在建立新目标";
  elements.headerTaskInfo.classList.remove("hidden");
  elements.knowledgeCards.innerHTML = "";

  elements.skill.innerHTML = '<header class="context-card-head"><h2>当前学习</h2></header><div class="empty-context"><strong>正在建立新目标</strong><p>可先上传资料，老师依据内容规划学习。</p></div>';
  elements.branches.innerHTML = "";
  elements.branches.classList.add("hidden");
  delete elements.branches.dataset.skillId;
  elements.evidence.innerHTML = '<p class="muted">原有学习记录已保留；新记录会在路线建立后显示。</p>';
}

function syncComposerAvailability(): void {
  syncAnimationUi();
  assistantView.setTeacherBusy(generating || remoteGenerating || learningRecordNavigationPending);
  syncFeedbackRecovery();
  // 历史 Goal 只改变当前页面的展示；Pi Tool 仍面向 Kernel 当前 Goal，
  // 所以旧对话不能继续发送教学消息，避免旧聊天上下文污染新目标。
  const readOnly = !state || viewMode(state) !== "CURRENT" || previewEntryId !== null || Boolean(document.querySelector(".note-source-open"));
  const returning = previewEntryId !== null && sessionId !== null;
  const answering = !readOnly && Boolean(state?.teaching.learner_questions?.pending && ["CHECK", "PRACTICE_SET"].includes(state.teaching.learner_questions.pending.purpose));
  elements.composer.classList.toggle("is-question-support", answering);
  elements.input.setAttribute("aria-label", "学习消息");
  questionNavigation.update(learnerQuestionView.currentQuestionKey, answering, pendingRouteReading?.key === activeRouteUiKey);
  elements.input.disabled = generating || masteryDecisionPending || learningRecordNavigationPending || readOnly;
  // 预览不提交输入；复用发送入口返回原学习，草稿保持原样。
  elements.send.disabled = generating || masteryDecisionPending || remoteGenerating || learningRecordNavigationPending || voiceInput.busy || (readOnly && !returning);
  elements.send.toggleAttribute("data-branch-back", returning);
  elements.send.setAttribute("aria-label", returning ? "返回当前学习" : "发送");
  elements.send.innerHTML = `<span>${returning ? "返回学习" : "发送"}</span>${icon(returning ? "arrowRight" : "arrowUp")}`;
  elements.materialsButton.disabled = generating || masteryDecisionPending || learningRecordNavigationPending || voiceInput.busy || !materialsAvailable();
  elements.materialsButton.title = materialsAvailable()
    ? isGoalDraft() ? "上传资料，用于规划新目标" : "上传资料到当前学习目标"
    : "切回当前对话后上传资料";
  // 手机端输入框更窄：用短占位符，避免折行把输入区撑高、挤掉阅读高度。
  const narrowComposer = mobileNavMedia.matches;
  elements.input.placeholder = readOnly
    ? previewEntryId ? "正在查看学习记录" : narrowComposer ? "历史记录仅供查看" : "历史对话仅供查看；切回当前目标对话后继续学习"
    : isGoalDraft()
      ? narrowComposer ? "上传文件，或说说想学什么……" : "上传文件，或说说你想学会什么……"
      : narrowComposer ? "说说你的想法……" : "说说你的想法，或者继续学习……";
  elements.composerNote.textContent = readOnly
    ? previewEntryId ? "学习记录仅供查看；返回学习可接回当前课堂，保留输入草稿。" : "路线、知识点与学习记录按历史目标展示；这段对话不能继续教学，知识卡片仍可自评和维护。切回当前目标对话后可继续学习。"
    : "支持自然语言、公式、代码。按 Enter 发送，Shift + Enter 换行。";
  voiceInput.sync();
}

function renderState(next: LearningState, fromTeacher = false): void {
  restoreRouteUi(next);
  const previousVoiceScope = voiceScopeKey();
  state = next;
  const sourceSession = sessionId;
  void teachingProposalView.refresh(sessionId, viewMode(next) === "CURRENT" && !previewEntryId && ["IDLE", "INITIALIZED"].includes(next.onboarding.status)).then(() => {
    if (sourceSession !== sessionId || state !== next) return;
    if (!teachingProposalView.node.hidden && teachingProposalView.node.childElementCount) elements.messages.append(teachingProposalView.node);
    if (hasSavedEndChoice(next)) {
      renderRoute(next.overview, currentSkill(next));
      renderTask(next);
      renderKnowledgeCards(currentSkill(next));
    }
  }).catch(() => undefined);
  syncAssistantContext();
  studyTimeView.setContext(sessionId, `${next.active_goal_id ?? ""}:${next.overview.active_task?.id ?? ""}:${viewMode(next)}:${next.onboarding.status}`);
  if (previousVoiceScope !== voiceScopeKey()) cancelMedia();
  syncComposerAvailability();
  renderLearnerQuestions();
  const recall = viewMode(next) === "CURRENT" ? next.teaching.active_recall : null;
  elements.activeRecallBar.classList.toggle("hidden", !recall);
  elements.activeRecallSkip.disabled = generating || assistantView.busy;
  elements.activeRecallProgress.textContent = recall
    ? `Active Recall · ${recall.primary_index + 1} / ${recall.primary_questions.length}${recall.asked_count > recall.primary_index + 1 ? " · 追问" : ""}${recall.status === "PAUSED" ? " · 已暂停" : ""}`
    : "";
  const overview = next.overview;
  if (selectedSkillId && !currentGoalSkills(overview).some((skill) => skill.id === selectedSkillId)) {
    selectedSkillId = null;
  }
  const skill = currentSkill(next);
  const onboardingActive = viewMode(next) === "CURRENT" &&
    !["IDLE", "INITIALIZED"].includes(next.onboarding.status);

  $("#workspace-title").textContent = viewMode(next) !== "CURRENT"
    ? viewMode(next) === "ARCHIVED" ? "历史对话 · 教学只读" : "历史学习资料不可用"
    : onboardingActive
    ? overview.current_goal
      ? "建立新的学习目标"
      : "从目标开始"
    : "和你的老师一起学习";

  if (onboardingActive) {
    renderGoalOnboardingState(next);
    syncKnowledgeCardNotice();
    void renderRouteMaterials();
    return;
  }

  // Browser 只投影视图：Goal、Skill、Task、Evidence 与推荐都来自 Gateway。
  // 这里不推导业务状态，也不会因为点击路线就修改 Kernel。
  renderRoute(overview, skill);
  renderTask(next);
  renderKnowledgeCards(skill, fromTeacher);
  void renderRouteMaterials();
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as { detail?: string } & T;
  if (!response.ok) throw new Error(body.detail ?? `HTTP ${response.status}`);
  return body;
}

interface LearningMaterial {
  id: string;
  name: string;
  format: string;
  goal_id: string | null;
  unit_count: number;
  unit_kind: "page" | "line" | "block" | "slide";
  readable: boolean;
  warnings: string[];
  parse_status?: "queued" | "processing" | "ready" | "failed";
  parse_error?: { code: string; message: string } | null;
  size_bytes?: number;
  visual_count?: number;
  purpose?: "conversation_attachment" | "learning_material";
}
const materialUnit = (kind: string) => ({ page: "页", line: "行", block: "正文块", slide: "幻灯片" } as Record<string, string>)[kind] ?? "段";

// 已上传、待随下一条消息发送的资料；UI 上只显示缩略图/文件 chip，不占用输入框文字。
interface PendingAttachment {
  id: string;
  name: string;
  format: string;
  unitKind: "page" | "line" | "block" | "slide";
  draft: boolean;
  isImage: boolean;
  previewUrl?: string;
}

// 发送时才把材料引用拼进消息正文；这里生成的是给老师的自然语言读取请求，不是 Evidence。
function buildMaterialReference(attachment: PendingAttachment): string {
  const { id, name } = attachment;
  return `本轮对话附件「${name}」（material_id: ${id}），尚未加入长期资料库。请按用户本轮用途读取；若作为正式路线的主要依据，应完整阅读后再规划，不默认只读开头，也不因上传自动改变已有路线。`;
}

// 材料引用块对老师可见（据此读取资料），但在网页投影时整段剥离，用户气泡只显示自己的话和图片。
const MATERIAL_CONTEXT_MARKER = "LAWA_MATERIAL_CONTEXT";
function buildMaterialContextBlock(attachments: PendingAttachment[]): string {
  const references = attachments.map(buildMaterialReference).join("\n") + "\n"
    + attachmentReferences(attachments.map(({id,name,isImage}) => ({id,name,isImage})));
  return `[${MATERIAL_CONTEXT_MARKER}]\n${references}\n[/${MATERIAL_CONTEXT_MARKER}]`;
}

interface UiAttachment {
  id?: string;
  name: string;
  isImage: boolean;
  previewUrl?: string;
}

function materialWarnings(warnings: string[]): string {
  const labels: Record<string,string> = { PDF_LAYOUT_AND_IMAGE_CONTENT_NOT_VERIFIED:"图片、复杂表格与版面尚未核对",
    DOCX_IMAGES_FORMULAS_REVISIONS_AND_FLOATING_CONTENT_NOT_VERIFIED:"图片、公式、修订及浮动内容尚未核对",
    PPTX_IMAGES_CHARTS_SMARTART_AND_READING_ORDER_NOT_VERIFIED:"图片、图表及版面阅读顺序尚未核对",
    DOCX_REVISIONS_FLOATING_AND_OLE_CONTENT_NOT_VERIFIED:"修订、浮动排版及旧式嵌入对象尚未核对",
    PPTX_SMARTART_AND_READING_ORDER_NOT_VERIFIED:"SmartArt 及版面阅读顺序尚未核对",
    PPTX_VECTOR_DIAGRAMS_SMARTART_AND_READING_ORDER_NOT_VERIFIED:"矢量绘图、SmartArt 及版面阅读顺序尚未核对",
    MARKDOWN_IMAGE_REFERENCES_NOT_FETCHED:"Markdown 链接图片尚未读取，请直接上传图片",
    VISUAL_RECOGNITION_PENDING:"图片结构识别尚未完成", MACHINE_TRANSCRIPTION_REQUIRES_CHECK:"机器转录和图像说明请核对原图",
    OCR_LAYOUT_AND_FORMULA_NOT_VERIFIED:"文字顺序、表格结构和公式仍需核对原图",
    IMAGE_MULTIFRAME_FIRST_FRAME_ONLY:"多帧图片仅读取首帧",
    OCR_REQUIRED:"原生解析未提取文字，依赖视觉识别",NO_EXTRACTABLE_TEXT:"原生解析没有可提取文字" };
  const pages=warnings.filter(warning=>/^PAGE_\d+_NO_TEXT$/.test(warning)).length;
  const failed=warnings.filter(warning=>/^PAGE_\d+_EXTRACTION_FAILED$/.test(warning)).length;
  return [...warnings.filter(warning=>!/^PAGE_\d+_/.test(warning) && !warning.startsWith("LOCAL_OCR_"))
    .map(warning=>labels[warning]??warning),
    ...(pages?[pages+" 页原生解析没有文字"]:[]),...(failed?[failed+" 页提取失败"]:[])].join("；");
}
let materialPoll: ReturnType<typeof setTimeout> | undefined;
interface ConversationAttachmentReference {id: string; entryId: string; sessionId: string}
// 仅是原对话的预览现场，不改变当前Goal/Session或创建教学回合。
let selectedConversationAttachment: ConversationAttachmentReference | null = null;
const deletedConversationAttachments = new Set<string>();
let materialListRequest = 0;

function conversationAttachmentUrl(reference: ConversationAttachmentReference, path = "", params: Record<string, string> = {}): string {
  return `/api/web/conversation-attachments/${encodeURIComponent(reference.id)}${path}?${new URLSearchParams({
    ...params, sessionId: reference.sessionId, entryId: reference.entryId,
  })}`;
}

function materialRequestUrl(id: string, path = "", params: Record<string, string> = {}): string {
  if (selectedConversationAttachment) {
    if (selectedConversationAttachment.id !== id) throw new Error("附件页面已变化，请重新打开附件。");
    return conversationAttachmentUrl(selectedConversationAttachment, path, params);
  }
  return materialUrl(`/${encodeURIComponent(id)}${path}`, params);
}

function isGoalDraft(): boolean {
  return Boolean(state && !["IDLE", "INITIALIZED"].includes(state.onboarding.status));
}

function materialsAvailable(): boolean {
  return Boolean(sessionId && state && (state.active_goal_id || isGoalDraft()) &&
    viewMode(state) === "CURRENT" && previewEntryId === null);
}

function materialUrl(path = "", params: Record<string, string> = {}): string {
  if (!materialsAvailable()) throw new Error("请切回当前目标或新目标草稿对话，再上传资料。");
  return `/api/web/materials${path}?${new URLSearchParams({
    ...params, sessionId: sessionId!, ...(isGoalDraft() ? {} : { goalId: state!.active_goal_id! }),
  })}`;
}

async function loadMaterials(): Promise<void> {
  clearTimeout(materialPoll);
  const focused = selectedConversationAttachment;
  $("#materials-page-title").textContent = focused ? "对话附件" : "学习资料";
  const description = elements.materialsPage.querySelector<HTMLElement>(".page-heading p")!;
  description.dataset.original ??= description.textContent ?? "";
  description.textContent = focused ? "附件保存在原对话中，可在这里预览或删除。删除不会清除历史对话和学习记录。" : description.dataset.original;
  $("#retrieval-diagnostics").hidden = Boolean(focused);
  const listRequest = ++materialListRequest;
  const stillCurrent = () => listRequest === materialListRequest && focused === selectedConversationAttachment;
  if (!focused && !materialsAvailable()) {
    elements.materialsList.textContent = "请先建立或进入学习目标，再上传资料。";
    return;
  }
  const readingStarts = new Map([...elements.materialsList.querySelectorAll<HTMLElement>("[data-material]")]
    .map(item => [item.dataset.material, item.querySelector<HTMLInputElement>("input")?.value ?? "1"]));
  const referenceKey = focused ? `${focused.sessionId}:${focused.entryId}:${focused.id}` : `${sessionId}:${state?.active_goal_id}:${isGoalDraft()}`;
  if (elements.materialsList.dataset.referenceKey !== referenceKey) {
    elements.materialsList.dataset.referenceKey = referenceKey;
    elements.materialsList.textContent = "正在读取资料…";
  }
  if (!elements.materialsList.children.length) elements.materialsList.textContent = "正在读取资料列表…";
  try {
    const listedSession = sessionId;
    const listedGoal = state?.active_goal_id;
    const [result, index] = await Promise.all([
      focused ? (async () => {
        const response = await fetch(conversationAttachmentUrl(focused, "/metadata"));
        if (!response.ok) throw new Error(response.status === 404 ? "附件已删除或原资料不可用，历史对话和学习记录仍保留。" : "附件暂时无法打开，请重新点击附件重试。");
        return {materials: [await response.json() as LearningMaterial]};
      })() : requestJson<{ materials: LearningMaterial[] }>(materialUrl()),
      focused ? Promise.resolve(null) : retrievalStatus(),
    ]);
    if (!stillCurrent() || sessionId !== listedSession || state?.active_goal_id !== listedGoal) return;
    elements.materialsList.innerHTML = result.materials.length ? result.materials.map((item) => {
      const fmt = item.format.toUpperCase();
      const unit = materialUnit(item.unit_kind);
      const pending = item.parse_status === "queued" || item.parse_status === "processing";
      const failed = item.parse_status === "failed";
      const originalPreview = focused && /^(pdf|png|jpg|jpeg|webp|tiff)$/.test(item.format);
      const warnings = originalPreview ? item.warnings.filter(warning => ![
        "VISUAL_RECOGNITION_PENDING", "NO_EXTRACTABLE_TEXT", "OCR_REQUIRED", "PDF_LAYOUT_AND_IMAGE_CONTENT_NOT_VERIFIED",
      ].includes(warning) && !/^PAGE_\d+_NO_TEXT$/.test(warning)) : item.warnings;
      const status = item.purpose === "conversation_attachment" ? "对话附件" : pending ? (item.parse_status === "queued" ? "等待解析" : "正在解析") : failed ? "解析未完成" : item.readable ? sourceIndexLabel(index?.sources.find(job => job.source_id === "material:" + item.id)) :
        item.visual_count ? (/^(png|jpg|jpeg|webp|tiff)$/.test(item.format) ? "可随问题发送原图 · 文字索引未建立" : (index?.enabled ? "图片识别待完成" : "图片尚未识别，云端检索已关闭")) : "无可提取文字";
      return `
      <article class="material-item" data-material="${escapeHtml(item.id)}" data-unit-kind="${item.unit_kind}" data-format="${escapeHtml(item.format)}">
        <div class="material-item-head">
          <span class="material-badge fmt-${item.format.toLowerCase()}">${escapeHtml(fmt)}</span>
          <div class="material-name"><strong>${escapeHtml(item.name)}</strong>
          <small>${item.unit_count} ${unit} · ${status}${item.size_bytes ? " · " + (item.size_bytes / 1024 / 1024).toFixed(1) + " MiB" : ""}</small></div>
        </div>
        ${warnings.length ? `<small class="material-warning">${escapeHtml(materialWarnings(warnings))}</small>` : ""}
        ${failed && !originalPreview ? `<small class="material-warning">${escapeHtml(item.parse_error?.message ?? "文件已保留，请重试解析。")}</small>` : ""}
        <div class="material-actions">
          <label class="material-start">从第 <input type="number" min="1" max="${Math.max(1, item.unit_count)}" value="1" aria-label="起始${unit}" /> ${unit}读取</label>
          <span class="material-actions-spacer"></span>
          <button type="button" class="ghost-button" data-material-action="read" ${!focused && (pending || failed) ? "disabled" : ""}>预览</button>
          ${failed && !focused ? '<button type="button" class="ghost-button" data-material-action="retry">重试解析</button>' : ""}
          ${materialsAvailable() && !focused ? '<button type="button" class="ghost-button" data-material-action="attach">加入输入框</button>' : ""}
          <button type="button" class="ghost-button danger" data-material-action="delete">删除</button>
        </div>
      </article>`;
    }).join("") : `<div class="library-empty-state materials-empty-state">${icon("document")}<h3>还没有上传资料</h3><p>回到课堂，点击输入框左侧的 +，选择文档或图片。</p><button type="button" class="text-button" data-workspace-target="learn">返回课堂上传</button></div>`;
    elements.materialsCount.textContent = result.materials.length ? `共 ${result.materials.length} 份` : "";
    for (const item of elements.materialsList.querySelectorAll<HTMLElement>("[data-material]")) {
      const input = item.querySelector<HTMLInputElement>("input");
      if (input) input.value = readingStarts.get(item.dataset.material) ?? "1";
    }
    if (!focused && result.materials.some(item => ["queued", "processing"].includes(item.parse_status ?? "") ||
      (index && item.readable && !index.sources.some(job => job.source_id === "material:" + item.id)) ||
      index?.sources.some(job => job.source_id === "material:" + item.id && (["indexing", "waiting"].includes(job.state) ||
        Object.values(job.derived ?? {}).some(part => part.state !== "ready"))))) {
      materialPoll = setTimeout(() => {
        if (!elements.materialsPage.hidden) void loadMaterials();
      }, 2000);
    }
  } catch (error) {
    if (!stillCurrent()) return;
    elements.materialsList.textContent = error instanceof Error ? error.message : String(error);
    elements.materialsCount.textContent = "";
  }
}

// 文件选择和粘贴共用上传链路；整批固定为用户操作时的作用域，不能因切换对话错绑。
function currentPendingAttachments(): PendingAttachment[] {
  if (!sessionId) return [];
  return pendingAttachments.get(sessionId) ?? [];
}

function addPendingAttachment(attachment: PendingAttachment): void {
  if (!sessionId) return;
  const items = pendingAttachments.get(sessionId) ?? [];
  items.push(attachment);
  pendingAttachments.set(sessionId, items);
  renderComposerAttachments();
}

function renderComposerAttachments(): void {
  const items = currentPendingAttachments();
  if (!items.length) {
    elements.composerAttachments.hidden = true;
    elements.composerAttachments.textContent = "";
    return;
  }
  elements.composerAttachments.hidden = false;
  elements.composerAttachments.innerHTML = items.map((attachment) => {
    const preview = attachment.isImage && attachment.previewUrl
      ? `<img class="attachment-thumb" src="${attachment.previewUrl}" alt="${escapeHtml(attachment.name)}" />`
      : `<span class="attachment-file-icon">${icon("document")}</span>`;
    return `
      <span class="attachment-chip" data-attachment-id="${escapeHtml(attachment.id)}" title="${escapeHtml(attachment.name)}">
        ${preview}
        <span class="attachment-name">${escapeHtml(attachment.name)}</span>
        <button type="button" class="attachment-remove" data-attachment-remove="${escapeHtml(attachment.id)}" aria-label="移除附件：${escapeHtml(attachment.name)}" title="移除">${icon("close")}</button>
      </span>`;
  }).join("");
}

elements.composerAttachments.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-attachment-remove]");
  if (!button || !sessionId) return;
  const id = button.dataset.attachmentRemove!;
  const items = pendingAttachments.get(sessionId) ?? [];
  const removed = items.find(item => item.id === id);
  if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
  pendingAttachments.set(sessionId, items.filter(item => item.id !== id));
  renderComposerAttachments();
});

async function uploadMaterialFiles(files: File[]): Promise<void> {
  if (!materialsAvailable()) {
    setError("请切回当前目标或新目标草稿对话，再上传资料。");
    elements.materialFile.value = "";
    return;
  }
  const uploadSession = sessionId!;
  const uploadGoal = state!.active_goal_id;
  const uploadDraft = isGoalDraft();
  const uploadUrl = materialUrl();
  const inUploadScope = () => sessionId === uploadSession && materialsAvailable() &&
    isGoalDraft() === uploadDraft && (uploadDraft || state?.active_goal_id === uploadGoal);
  const failures: string[] = [];
  // 逐份上传控制同时在途请求；一份失败仍处理同批其他资料，权限仍由 Gateway/API 校验。
  for (const file of files) {
    if (file.size > 100 * 1024 * 1024) {
      failures.push(`「${file.name}」超过 100 MiB，无法上传。`);
      continue;
    }
    if (inUploadScope()) showUploadPending(file.name);
    try {
      const material = await requestJson<LearningMaterial>(`${uploadUrl}&filename=${encodeURIComponent(file.name)}`, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file,
      });
      const isImage = file.type.startsWith("image/");
      const attachment: PendingAttachment = {
        id: material.id,
        name: material.name,
        format: material.format,
        unitKind: material.unit_kind,
        draft: uploadDraft,
        isImage,
        previewUrl: isImage ? URL.createObjectURL(file) : undefined,
      };
      // 迟到的成功附件留在原会话，不能插入另一个对话；上传本身不触发教学或 Evidence。
      if (inUploadScope()) {
        addPendingAttachment(attachment);
      } else if (sessionId !== uploadSession) {
        const items = pendingAttachments.get(uploadSession) ?? [];
        items.push(attachment);
        pendingAttachments.set(uploadSession, items);
      }
    } catch (error) {
      failures.push(`「${file.name}」：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  elements.materialFile.value = "";
  if (!inUploadScope()) return;
  await renderRouteMaterials();
  if (inUploadScope() && failures.length) setError(failures.join("\n"));
}

function pastedMaterialFiles(data: DataTransfer): File[] {
  // 不重复读取 files/items，也不获取 HTML 中的图片 URL 或磁盘路径；仅上传浏览器交付的 File。
  const files = data.files.length ? Array.from(data.files) : Array.from(data.items).flatMap(item => {
    const file = item.kind === "file" ? item.getAsFile() : null;
    return file ? [file] : [];
  });
  const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
    "image/tiff": "tiff", "application/pdf": "pdf", "text/plain": "txt", "text/markdown": "md",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx" };
  return files.map((file, index) => {
    const extension = extensions[file.type];
    if (/\.[^.]+$/.test(file.name) || !extension) return file;
    return new File([file], `粘贴${file.type.startsWith("image/") ? "图片" : "文件"}-${Date.now()}-${index + 1}.${extension}`,
      { type: file.type, lastModified: file.lastModified });
  });
}

function showUploadPending(name: string): void {
  elements.routeMaterials.hidden = false;
  elements.routeMaterials.innerHTML = `<span class="route-material-row pending" role="status" title="正在上传：${escapeHtml(name)}"><span class="route-material-label">学习资料 ·</span><span class="route-material-name">正在上传…</span></span>`;
}

// Goal 教材收纳在路线底部的单行入口；管理和阅读进入主区资料页。
async function renderRouteMaterials(): Promise<void> {
  if (!materialsAvailable()) {
    elements.routeMaterials.hidden = true;
    elements.routeMaterials.textContent = "";
    return;
  }
  const listedSession = sessionId;
  const listedGoal = state!.active_goal_id;
  try {
    const result = await requestJson<{ materials: LearningMaterial[] }>(materialUrl());
    if (sessionId !== listedSession || state?.active_goal_id !== listedGoal || !materialsAvailable()) return;
    if (!result.materials.length) {
      elements.routeMaterials.hidden = true;
      elements.routeMaterials.textContent = "";
      return;
    }
    const first = result.materials[0]!;
    elements.routeMaterials.hidden = false;
    // 资料入口是路线卡底部的独立卡片：图标 + 名称/份数 + 箭头，整块可点进资料页。
    elements.routeMaterials.innerHTML = `
      <button type="button" class="route-material-row" data-materials-open data-material-id="${escapeHtml(first.id)}" title="${escapeHtml(first.name)}${result.materials.length > 1 ? `（共 ${result.materials.length} 份资料）` : ""}" aria-label="查看学习资料：${escapeHtml(first.name)}，共 ${result.materials.length} 份">
        <span class="route-material-heading">
          <span class="route-material-icon" aria-hidden="true">${icon("document")}</span>
          <span class="route-material-label">学习资料</span>
          <span class="route-material-count">${result.materials.length} 份</span>
          <span class="route-material-chevron" aria-hidden="true">${icon("arrowRight")}</span>
        </span>
        <span class="route-material-name">${escapeHtml(first.name)}</span>
      </button>`;
  } catch {
    if (sessionId !== listedSession || state?.active_goal_id !== listedGoal) return;
    elements.routeMaterials.hidden = true;
    elements.routeMaterials.textContent = "";
  }
}

elements.materialsButton.addEventListener("click", () => elements.materialFile.click());
elements.materialFile.addEventListener("change", () => {
  const files = Array.from(elements.materialFile.files ?? []);
  if (files.length) void uploadMaterialFiles(files);
});
elements.input.addEventListener("paste", event => {
  if (!event.clipboardData) return;
  const files = pastedMaterialFiles(event.clipboardData);
  if (!files.length) return; // 普通文字粘贴保留浏览器原生行为（光标、选区和撤销）。
  event.preventDefault();
  const text = event.clipboardData.getData("text/plain");
  if (text) {
    elements.input.setRangeText(text, elements.input.selectionStart, elements.input.selectionEnd, "end");
    elements.input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  void uploadMaterialFiles(files);
});
elements.closeMaterialPreview.addEventListener("click", () => {
  materialPreviewRequest++;
  elements.materialPreview.hidden = true;
});

// 资料入口仍收在路线底部；长内容在主区页阅读，引用后回到原输入框。
elements.routeMaterials.addEventListener("click", (event) => {
  if ((event.target as HTMLElement).closest("[data-materials-open]")) {
    selectedConversationAttachment = null;
    elements.materialPreview.hidden = true;
    workspace.navigate("materials");
  }
});
// toggle 不冒泡，使用捕获；忽略重渲染前已脱离消息区的延迟事件。
elements.messages.addEventListener("toggle", (event) => {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement) || !details.matches("details.answer-assessment") || !elements.messages.contains(details)) return;
  const id = details.dataset.assessmentId;
  if (id) assessmentDisclosure.set(id, !details.open);
}, true);
elements.messages.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-conversation-attachment]");
  if (!button || !sessionId) return;
  void conversationAttachmentPreview.open({id: button.dataset.conversationAttachment!, entryId: button.dataset.attachmentEntry!, sessionId}, elements.messages);
});
const conversationAttachmentPreview = new ConversationAttachmentPreview((ref, path, params) => conversationAttachmentUrl(ref, path, params));
let materialPreviewRequest = 0;
elements.materialsList.addEventListener("click", async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-material-action]");
  const item = button?.closest<HTMLElement>("[data-material]");
  if (!button || !item) return;
  const id = item.dataset.material!;
  const name = item.querySelector("strong")?.textContent ?? id;
  const start = Number(item.querySelector("input")?.value ?? "1");
  const actionListRequest = materialListRequest;
  let previewRequest: number | null = null;
  try {
    if (button.dataset.materialAction === "attach") {
      // 只把用户主动选择的 ID 与阅读请求加入输入框；上传本身不会触发教学或 Evidence。
      if(/^(png|jpg|jpeg|webp|tiff)$/.test(item.dataset.format ?? "")) {
        addPendingAttachment({id,name,format:item.dataset.format!,unitKind:"page",draft:isGoalDraft(),isImage:true,
          previewUrl:materialUrl(`/${encodeURIComponent(id)}/visual/image-1`)});
      } else {
        const reference = `请先读取学习资料「${name}」（material_id: ${id}）第 ${start} ${materialUnit(item.dataset.unitKind??"line")}，再结合原文讲解，来源请在回复末尾简短列出。`;
        elements.input.value = `${elements.input.value}${elements.input.value ? "\n" : ""}${reference}`;
      }
      workspace.navigate("learn");
      applyTaskFocusCollapsed(true);
      elements.input.focus();
    } else if (button.dataset.materialAction === "read") {
      previewRequest = ++materialPreviewRequest;
      button.disabled = true;
      elements.materialPreviewTitle.textContent = `内容预览 · ${name}`;
      elements.materialPreviewStatus.dataset.status = "loading";
      elements.materialPreviewStatus.textContent = "正在读取资料…";
      elements.materialPreviewText.replaceChildren();
      document.querySelector("#material-preview-assets")?.replaceChildren();
      elements.materialPreview.hidden = false;
      const focused = selectedConversationAttachment;
      const isPageImage = focused && /^(pdf|png|jpg|jpeg|webp|tiff)$/.test(item.dataset.format ?? "");
      const result = isPageImage ? {
        text: "", citation: item.dataset.format === "pdf" ? `${name} · 第 ${start} 页` : name, truncated: false,
        assets: [{id: item.dataset.format === "pdf" ? `page-${start}` : "image-1", label: name}],
      } : await requestJson<{ text: string; citation: string; truncated: boolean; assets?: Array<{id: string; label: string}> }>(materialRequestUrl(id, "", { start: String(start), max_chars: "3000", preview: "1" }));
      if (previewRequest !== materialPreviewRequest) return;
      elements.materialPreviewStatus.dataset.status = "ready";
      elements.materialPreviewStatus.textContent = `${result.citation}${result.truncated ? " · 还有后续内容，可修改这份资料的起始位置继续预览。" : ""}`;
      elements.materialPreviewText.innerHTML = renderMarkdown(result.text);
      const assets = document.querySelector("#material-preview-assets");
      assets?.replaceChildren(...(result.assets ?? []).map(asset => {
        const figure = document.createElement("figure"), image = document.createElement("img"), caption = document.createElement("figcaption");
        image.src = materialRequestUrl(id, `/visual/${encodeURIComponent(asset.id)}`);
        image.alt = asset.label; image.loading = "lazy"; image.style.maxWidth = "100%";
        image.addEventListener("error", () => { if (previewRequest === materialPreviewRequest) {
          elements.materialPreviewStatus.dataset.status = "error";
          elements.materialPreviewStatus.textContent = "原图暂时无法读取，请再次预览或检查附件是否已删除。";
        }});
        caption.textContent = asset.label;
        figure.append(image, caption); return figure;
      }));
      elements.materialPreview.hidden = false;
      elements.materialPreview.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else if (button.dataset.materialAction === "retry") {
      await requestJson(materialUrl("/" + encodeURIComponent(id) + "/retry"), { method: "POST" });
      await loadMaterials();
    } else if (button.dataset.materialAction === "delete") {
      if (!confirm(`删除学习资料「${name}」？`)) return;
      const focused = selectedConversationAttachment;
      const response = await fetch(materialRequestUrl(id), { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json() as { detail?: string };
        throw new Error(body.detail ?? `HTTP ${response.status}`);
      }
      if (focused) deletedConversationAttachments.add(`${focused.sessionId}:${focused.id}`);
      if (actionListRequest !== materialListRequest) return;
      elements.materialPreview.hidden = true;
      materialPreviewRequest++;
      if (focused) {
        renderMessages();
      }
      await loadMaterials();
      await renderRouteMaterials();
    }
  } catch (error) {
    if (actionListRequest !== materialListRequest) return;
    if (previewRequest !== null) {
      if (previewRequest !== materialPreviewRequest) return;
      elements.materialPreviewTitle.textContent = `未能预览 · ${name}`;
      elements.materialPreviewStatus.dataset.status = "error";
      elements.materialPreviewStatus.textContent = `资料暂时无法读取。${error instanceof Error ? error.message : ""}可以再次点击这份资料的“预览”；资料和学习记录没有改变。`;
      elements.materialPreviewText.replaceChildren();
      document.querySelector("#material-preview-assets")?.replaceChildren();
      elements.materialPreview.hidden = false;
      elements.materialPreview.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else setError(error instanceof Error ? error.message : "操作未完成，请再试一次。");
  } finally {
    if (previewRequest !== null) button.disabled = false;
  }
});

async function startReviewPayload(goalId: string, skillId: string): Promise<SessionResponse> {
  const key = `learn-anything:review-pending:${goalId}:${skillId}`;
  let operationId: string;
  try {
    operationId = localStorage.getItem(key) ?? crypto.randomUUID();
    localStorage.setItem(key, operationId);
  } catch {
    operationId = crypto.randomUUID();
  }
  const payload = await requestJson<SessionResponse>(`/api/web/goals/${encodeURIComponent(goalId)}/skills/${encodeURIComponent(skillId)}/review`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationId }),
  });
  try { localStorage.removeItem(key); } catch { /* Private browsing may disable storage. */ }
  return payload;
}

function formatLocalTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
}

function conversationCatalogMarkup(management = false): string {
  return conversationCatalog.sessions.length
    ? conversationCatalog.sessions
        .map((item) => {
          const mismatch = Boolean(item.goalId && state?.active_goal_id &&
            item.goalId !== state.active_goal_id);
          return `
            <article class="conversation-list-item ${item.active ? "active" : ""}">
              <button class="conversation-open" type="button" data-conversation-action="activate" data-session-id="${escapeHtml(item.id)}" ${generating ? "disabled" : ""}>
                <strong title="${escapeHtml(item.goalDescription ?? item.name)}">${escapeHtml(goalDisplayTitle(item.goalDescription ?? item.name))}</strong>
                <small title="${escapeHtml(item.goalDescription ?? "未关联学习目标")}">${item.goalDescription ? escapeHtml(plainTextSummary(item.name, 80)) : "未关联学习目标"}</small>
                <span>${formatLocalTime(item.updatedAt)} · ${item.messageCount} 条消息${mismatch ? " · 历史目标" : ""}</span>
              </button>
              <div class="conversation-actions">
                ${management ? `<details class="conversation-more"><summary aria-label="${escapeHtml(item.name)}的更多操作">更多</summary><div>
                  <button type="button" data-conversation-action="rename" data-session-id="${escapeHtml(item.id)}" ${generating ? "disabled" : ""}>重命名对话</button>
                  ${item.goalId ? `<button type="button" data-conversation-action="clear" data-session-id="${escapeHtml(item.id)}" ${generating ? "disabled" : ""}>仅清空聊天</button>` : ""}
                </div></details>` : `<button type="button" data-conversation-action="rename" data-session-id="${escapeHtml(item.id)}" aria-label="重命名 ${escapeHtml(item.name)}" ${generating ? "disabled" : ""}>${icon("edit")}</button>`}
                <button type="button" data-conversation-action="delete" data-session-id="${escapeHtml(item.id)}" aria-label="${item.goalId ? "删除学习目标" : "删除新目标草稿"} ${escapeHtml(item.goalDescription ?? item.name)}" ${generating ? "disabled" : ""}>${icon("trash")}</button>
              </div>
            </article>`;
        })
        .join("")
    : '<p class="conversation-list-empty">还没有已保存对话。</p>';
}

function renderConversationCatalog(): void {
  elements.newConversation.disabled = generating;
  elements.dialogNewConversation.disabled = generating;
  const markup = conversationCatalogMarkup();
  elements.conversationList.innerHTML = markup;
  elements.conversationPageList.innerHTML = conversationCatalogMarkup(true) + (conversationCatalog.unlinkedGoals ?? []).map(goal => `
    <article class="conversation-list-item">
      <button class="conversation-open" type="button" data-conversation-action="activate-goal" data-session-id="${escapeHtml(goal.id)}" ${generating ? "disabled" : ""}>
        <strong>${escapeHtml(goal.name)}</strong><small>学习目标已保留，聊天已移走或清空</small>
      </button>
      <div class="conversation-actions"><button type="button" data-conversation-action="delete-goal" data-session-id="${escapeHtml(goal.id)}" aria-label="删除学习目标 ${escapeHtml(goal.name)}" ${generating ? "disabled" : ""}>${icon("trash")}</button></div>
    </article>`).join("");
}

async function loadRecycle(): Promise<void> {
  try {
    const {items} = await requestJson<{items: RecycleItem[]}>("/api/web/recycle");
    elements.recycleCount.textContent = String(items.length);
    elements.recycleList.innerHTML = items.length ? items.map(item => `
      <article class="recycle-item">
        <div><strong>${escapeHtml(item.name)}</strong>
          <small>${item.kind === "goal" ? `学习目标 · ${item.sessionIds.length} 个对话` : item.kind === "draft" ? "新目标草稿" : "仅聊天记录"} · ${formatLocalTime(item.deletedAt)}</small>
          ${item.phase !== "deleted" ? '<p class="recycle-pending">上次操作未完成，可重试处理。</p>' : ""}
        </div>
        <div class="recycle-actions">
          <button type="button" class="small-ghost-button" data-recycle-action="restore" data-recycle-id="${escapeHtml(item.id)}" ${generating || item.phase === "purging" ? "disabled" : ""}>恢复</button>
          <button type="button" class="danger-ghost-button" data-recycle-action="purge" data-recycle-id="${escapeHtml(item.id)}" ${generating ? "disabled" : ""}>永久删除</button>
        </div>
      </article>`).join("") : '<p class="recycle-empty">回收区为空。</p>';
  } catch (error) {
    elements.recycleCount.textContent = "—";
    elements.recycleList.textContent = error instanceof Error ? error.message : "回收区暂时无法读取，请重新打开管理对话。";
  }
}

let guideCatalogReady = false;
async function loadConversationCatalog(): Promise<void> {
  const request = ++conversationCatalogRequest;
  if (workspace.current === "conversations") void loadRecycle();
  try {
    const catalog = await requestJson<ConversationCatalogResponse>("/api/web/sessions");
    if (request !== conversationCatalogRequest) return;
    conversationCatalog = catalog;
    guideCatalogReady = true;
    renderConversationCatalog();
  } catch (error) {
    if (request !== conversationCatalogRequest) return;
    const markup = `<p class="conversation-list-empty">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
    elements.conversationList.innerHTML = markup;
    elements.conversationPageList.innerHTML = markup;
  }
}

function applySessionPayload(payload: SessionResponse): void {
  // 会话切换后，迟到的预览不应显示为新目标资料。
  materialPreviewRequest++;
  materialListRequest++;
  selectedConversationAttachment = null;
  elements.materialPreview.hidden = true;
  cancelMedia();
  const records = elements.branches.querySelector<HTMLDetailsElement>("details");
  if (records) records.open = false;
  if (sessionId !== payload.sessionId) {
    conversationAttachmentPreview.close();
    freshAssessments.clear();
    assessmentDisclosure.clear();
    elements.activityPanel.open = false;
    renderComposerAttachments();
  }
  sessionId = payload.sessionId;
  previewEntryId = payload.previewEntryId ?? null;
  currentBranches = payload.branches ?? [];
  selectedSkillId = payload.previewSkillId ?? null;
  activities.splice(0, activities.length);
  messages.splice(0, messages.length, ...payload.messages);
  renderState(payload.state);
  renderActivities();
  renderMessages();
  renderBranches();
  void renderRouteMaterials();
  if (workspace.current === "materials") {
    $("#material-scope-label").textContent = isGoalDraft() ? "新目标草稿" : state?.overview.current_goal ?? "学习资料";
    void loadMaterials();
  }
}

function renderBranches(): void {
  if (cardSource.reference && !document.body.classList.contains("task-focus-collapsed")) {
    elements.branches.innerHTML = "";
    elements.branches.classList.add("hidden");
    return;
  }
  const skill = state ? currentSkill(state) : undefined;
  const busy = generating || learningRecordNavigationPending;
  const visibleBranches = (currentBranches ?? []).filter((branch) => branch.skillId === skill?.id);
  const wasOpen = elements.branches.dataset.skillId === skill?.id && Boolean(elements.branches.querySelector<HTMLDetailsElement>("details")?.open);
  const items = visibleBranches.map((branch) => `<li><button type="button" data-branch-entry="${escapeHtml(branch.entryId)}" ${busy ? "disabled" : ""}><span>${escapeHtml(branch.label)}</span>${icon("arrowRight")}</button></li>`).join("");
  // 旧 Pi 会话即使没有复习 metadata，只要找到教学锚点也有一条可回看的原学习路径。
  const original = previewEntryId && selectedSkillId && !visibleBranches.some((branch) => branch.label === "首次学习")
    ? `<li><button type="button" data-branch-original="${escapeHtml(selectedSkillId)}" ${busy ? "disabled" : ""}><span>首次学习</span>${icon("arrowRight")}</button></li>` : "";
  const count = visibleBranches.length + (original ? 1 : 0);
  elements.branches.dataset.skillId = skill?.id ?? "";
  elements.branches.innerHTML = count ? `<details class="skill-records-details" ${wasOpen ? "open" : ""}><summary><span>学习记录</span><span class="skill-records-meta"><span>${count} 条</span>${icon("chevronDown")}</span></summary><ol class="skill-records-list">${original}${items}</ol></details>` : "";
  elements.branches.classList.toggle("hidden", count === 0);
  // 保留同一个事件容器；技能卡重建后重新接入，记录不会再占对话顶部。
  const title = elements.skill.querySelector(".current-skill-title");
  const recordsSlot = elements.skill.querySelector(".focused-records-slot");
  if (recordsSlot) recordsSlot.append(elements.branches);
  else if (title) title.after(elements.branches);
}

let learningRecordNavigationPending = false;
async function navigateLearningRecord(url: string, body?: Record<string, string>): Promise<void> {
  if (generating || learningRecordNavigationPending) return;
  const resumeSnapshots = classroomClient.pauseSnapshots();
  cancelMedia();
  learningRecordNavigationPending = true;
  syncComposerAvailability();
  if (state) renderTask(state);
  renderBranches();
  const sourceSessionId = sessionId;
  try {
    const payload = await requestJson<SessionResponse>(url, { method: "POST", ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    if (sessionId !== sourceSessionId) return;
    applySessionPayload(payload);
    if (previewEntryId) {
      applyTaskFocusCollapsed(true);
      if (window.matchMedia("(max-width: 820px)").matches) elements.learningViewTabs.closest(".learning-stage")?.scrollIntoView({ block: "start" });
    }
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  } finally {
    resumeSnapshots();
    learningRecordNavigationPending = false;
    syncComposerAvailability();
    renderLearnerQuestions();
    if (state) renderTask(state);
    renderBranches();
    if (!previewEntryId && !elements.input.disabled) elements.input.focus({ preventScroll: true });
  }
}

async function renderLearningLibrary(library: LearningLibraryResponse): Promise<void> {
  await growthLibrary.load(library.projects);
}

async function openLearningLibrary(): Promise<void> {
  const request = ++learningLibraryRequest;
  const sourceSession = sessionId;
  const sourceState = state;
  elements.learningLibraryContent.setAttribute("aria-busy", "true");
  if (!elements.learningLibraryContent.children.length) elements.learningLibraryContent.innerHTML = '<p class="library-loading">正在读取学习库…</p>';
  for (const entry of elements.learningLibraryContent.querySelectorAll<HTMLElement>(".current-study-entry")) entry.innerHTML = '<span role="status">正在同步当前学习位置…</span>';
  try {
    const [library, position] = await Promise.all([
      requestJson<LearningLibraryResponse>("/api/web/learning-library"),
      sourceSession && !generating && !remoteGenerating && !previewEntryId
        ? requestJson<LearningState>(`/api/web/sessions/${encodeURIComponent(sourceSession)}/state`).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (request !== learningLibraryRequest) return;
    if (position && sourceSession === sessionId && state === sourceState && !generating && !remoteGenerating) renderState(position);
    await renderLearningLibrary(library);
  } catch (error) {
    if (request !== learningLibraryRequest) return;
    elements.learningLibraryContent.innerHTML = `<div class="library-empty-state"><h3>暂时无法读取学习库</h3><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p></div>`;
    interiorWorkspace.refreshCollections();
  } finally {
    if (request === learningLibraryRequest) elements.learningLibraryContent.removeAttribute("aria-busy");
  }
}

async function createSession(): Promise<void> {
  setConnection("正在连接", "connecting");
  setError();
  try {
    const payload = await requestJson<SessionResponse>("/api/web/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "resume-recent" }),
    });
    applySessionPayload(payload);
    syncKnowledgeCardNotice(false, displayedKnowledgeCardIds());
    setConnection("学习状态与对话已自动保存", "ready");
    await loadConversationCatalog();
  } catch (error) {
    setConnection("连接失败", "error");
    setError(error instanceof Error ? error.message : String(error));
  }
}

async function consumeStream(response: Response, assistant: UiMessage): Promise<void> {
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => ({}))) as { detail?: string };
    throw new Error(body.detail ?? `HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamError: Error | undefined;
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as StreamEvent;
      if (event.type === "figures_ready" && event.figures) {
        addReadyFigures(assistant,event.figures);
      } else if (event.type === "assistant_delta") {
        // 工具中自动进入路线时，服务端已重投影历史；后续文字需要新的流式气泡。
        if (!messages.includes(assistant)) {
          assistant.content = ""; messages.push(assistant); renderMessages();
        }
        // Tool Trace 与正文分开呈现，避免学习者把系统活动误认为教学内容。
        assistant.content += event.delta ?? "";
        updateStreamingMessage(assistant);
      } else if (event.type === "question_ready" && event.request) {
        receiveQuestion(event.request);
      } else if (event.type === "trace") {
        const existing = activities.find(
          (item) => item.toolName === event.toolName && item.status === "running",
        );
        if (existing && event.status !== "running") {
          existing.status = event.status ?? "done";
        } else {
          activities.push({
            label: event.label ?? "老师正在处理…",
            status: event.status ?? "running",
            toolName: event.toolName ?? "agent",
          });
        }
        renderActivities();
      } else if (event.type === "state" && event.state) {
        if (event.state.restored_session) applySessionPayload(event.state.restored_session);
        else renderState(event.state, true);
      } else if (event.type === "conversation_update" && event.messages) {
        if (event.routeChanged) assistant.figures=undefined;
        // 服务端重投影含受信语音组件的会话；不改变正在生成、停止按钮或待答题状态。
        const knownAssessments = new Set(messages.flatMap(message => message.assessment ? [message.assessment.id] : []));
        for (const message of event.messages) {
          if (message.role === "assistant" && message.assessment && !knownAssessments.has(message.assessment.id)) freshAssessments.add(message.assessment.id);
        }
        messages.splice(0, messages.length, ...preserveConversationAttachments(event.messages, messages));
        renderMessages();
      } else if (event.type === "error") {
        streamError ??= new Error(event.message ?? "Agent response failed");
      }
    }
    if (done) break;
  }
  if (streamError) throw streamError;
}

async function sendMessage(
  text: string,
  options: { appendUser?: boolean; learnerReply?: LearnerQuestionReply; displayText?: string; voiceInput?: VoiceInputMetadata; attachments?: UiAttachment[]; imageMaterialIds?:string[]; feedbackRecoveryId?: string; animationContext?: AnimationAnchor;requestId?:string;retryOf?:string;queryAnimationRequest?:boolean; transportRequestId?: string } = {},
): Promise<void> {
  if (!sessionId || !state || generating || masteryDecisionPending || remoteGenerating || voiceInput.busy || learningRecordNavigationPending || previewEntryId || viewMode(state) !== "CURRENT" || (!text.trim() && !options.learnerReply && !options.imageMaterialIds?.length && !options.feedbackRecoveryId)) return;
  const explaining=Boolean(options.animationContext);
  if(explaining&&(assistantView.busy||state.feedback_recovery)) {setError("请先结束当前回复或处理待恢复反馈，再问这一步。");return;}
  cancelMedia();
  if(!explaining){freshAssessments.clear();assessmentDisclosure.clear();clearTeachingAnimationSelection();}
  const sentSessionId = sessionId;
  const requestId=options.requestId??options.transportRequestId??crypto.randomUUID();
  animationSubmissionActive=explaining;
  if(options.animationContext)pageAnimationRequest={sessionId,request_id:requestId,status:"STARTED",anchor:structuredClone(options.animationContext),question:text.trim(),title:currentAnimationRequest()?.title??"这段演示"};
  const answeringQuestion = Boolean(options.learnerReply);
  const questionBefore = state.teaching.learner_questions?.pending;
  const outgoingAnswer: UnreceivedAnswer | null = !explaining && options.learnerReply && questionBefore?.purpose === "CHECK" ? {
    sessionId, goalId: state.active_goal_id ?? null, taskId: state.overview.active_task?.id ?? null, questionId: questionBefore.id,
    requestId, text, options: JSON.parse(JSON.stringify({learnerReply: options.learnerReply, displayText: options.displayText,
      voiceInput: options.voiceInput, attachments: options.attachments, imageMaterialIds: options.imageMaterialIds})),
  } : null;
  let optimisticUser: UiMessage | undefined;
  setError();
  if (options.appendUser !== false) {
    optimisticUser = {
      role: "user",
      content: options.displayText ?? text.trim(),
      attachments: options.attachments,
      ...(options.animationContext?{animation_question:{presentation_id:options.animationContext.presentation_id,source_entry_id:options.animationContext.source_entry_id,title:pageAnimationRequest!.title,scene_id:options.animationContext.scene_id}}:{}),
    };
    messages.push(optimisticUser);
  }
  const assistant: UiMessage = { role: "assistant", content: "", streaming: true };
  messages.push(assistant);
  generating = true;
  retryingFeedback = Boolean(options.feedbackRecoveryId);
  syncAssistantContext();
  renderTask(state);
  renderBranches();
  elements.activeRecallSkip.disabled = true;
  renderConversationCatalog();
  setProviderControlsBusy(false);
  elements.send.classList.add("hidden");
  elements.stop.classList.remove("hidden");
  elements.input.disabled = true;
  renderMessages();
  setConnection(retryingFeedback ? "正在重新生成反馈" : "老师正在生成", "connecting");
  syncFeedbackRecovery();
  try {
    if(!explaining)await studyTimeView.flush();
    const response = await fetch(`/api/web/sessions/${encodeURIComponent(sessionId)}/${options.feedbackRecoveryId ? "retry-feedback" : "messages"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 反馈恢复续接服务器保存的原作答；当前编辑中的聊天、题卡及附件都不能成为新输入。
      body: JSON.stringify(options.feedbackRecoveryId ? {recovery_id: options.feedbackRecoveryId, expected_version: state.classroom_version}
        : options.animationContext?{message:text.trim(),animation_context:options.animationContext,request_id:requestId,expected_version:state.classroom_version,...(options.retryOf?{retry_of_request_id:options.retryOf}:{}),...(options.queryAnimationRequest?{query_animation_request:true}:{})}
        : { message: text.trim(), learner_reply: options.learnerReply, voice_input: options.voiceInput,
          image_material_ids: options.imageMaterialIds, request_id: requestId, expected_version: state.classroom_version }),
    });
    if (response.status === 429 && outgoingAnswer) {
      unreceivedAnswer = outgoingAnswer;
      // 准入失败的乐观气泡不能继续冒充服务器已有回答，真实原文仍在题卡草稿和本页传输副本。
      if (optimisticUser) {const index = messages.indexOf(optimisticUser); if (index >= 0) messages.splice(index, 1);}
    }
    await consumeStream(response, assistant);
    assistant.streaming = false;
    if (unreceivedAnswer?.requestId === requestId) unreceivedAnswer = null;
    if(explaining&&pageAnimationRequest?.request_id===requestId)pageAnimationRequest.status=state?.animation_request?.request_id===requestId?state.animation_request.status:"UNKNOWN";
    if(explaining&&currentAnimationRequest()?.status!=="COMPLETED"){
      setError("这次解释的完成状态尚未确认，可以查询已保存的回复。",{retry:false});setConnection("解释结果待确认","error");
    }else{
      setError();setConnection(state?.feedback_recovery ? "反馈待恢复" : "学习状态与对话已自动保存", state?.feedback_recovery ? "error" : "ready");
    }
  } catch (error) {
    assistant.streaming = false;
    if(explaining&&pageAnimationRequest?.request_id===requestId){
      pageAnimationRequest.status=state?.animation_request?.request_id===requestId?state.animation_request.status:"UNKNOWN";
      if(sessionId===sentSessionId&&!elements.input.value.trim())elements.input.value=text;
    }
    if (!assistant.content) {
      const emptyPlaceholder = messages.indexOf(assistant);
      if (emptyPlaceholder >= 0) messages.splice(emptyPlaceholder, 1);
    }
    if ((answeringQuestion || options.feedbackRecoveryId) && sessionId === sentSessionId) {
      try { renderState(await requestJson<LearningState>(`/api/web/sessions/${encodeURIComponent(sentSessionId)}/state`)); }
      catch { /* 保留原问题草稿，下一次连接恢复后以服务器状态为准。 */ }
    }
    setError(error instanceof Error ? error.message : String(error),explaining?{retry:false}:{});
    setConnection(currentUnreceivedAnswer() ? "回答待提交" : "回复中断", "error");
  } finally {
    generating = false;
    animationSubmissionActive = false;
    retryingFeedback = false;
    syncAssistantContext();
    elements.activeRecallSkip.disabled = false;
    setProviderControlsBusy(false);
    elements.send.classList.remove("hidden");
    elements.stop.classList.add("hidden");
    syncComposerAvailability();
    if (state) renderTask(state);
    renderBranches();
    if (!assistantView.isOpen&&!explaining) elements.input.focus();
    renderMessages();
    void loadConversationCatalog();
    void classroomClient.refresh();
  }
}

let skillActionPending = false;
async function runSkillAction(action: string, skillId: string, branchId?: string): Promise<void> {
  if (!sessionId || skillActionPending || masteryDecisionPending || learningRecordNavigationPending || changingRoute) return;
  cancelMedia();
  skillActionPending = true; setError();
  const sourceSessionId = sessionId;
  try {
    if (action === "locate" || action === "review") {
      const goalId = state?.view_goal_id ?? state?.active_goal_id;
      if (!goalId) throw new Error("当前还没有学习目标");
      const payload = action === "locate"
        ? await requestJson<SessionResponse>(`/api/web/goals/${encodeURIComponent(goalId)}/skills/${encodeURIComponent(skillId)}/locate`, { method: "POST", ...(branchId ? {headers:{"Content-Type":"application/json"},body:JSON.stringify({branchId})} : {}) })
        : await startReviewPayload(goalId, skillId);
      if (sessionId !== sourceSessionId) return;
      applySessionPayload(payload);
      selectedSkillId = skillId;
      renderState(payload.state);
      if (payload.previewEntryId) elements.messages.querySelector(`[data-entry-id="${CSS.escape(payload.previewEntryId)}"]`)?.scrollIntoView({ block: "center" });
      return;
    }
    // Mastery/Reopen 是用户在网页上的独立动作，直接走 User API 边界；
    // 文本不会进入 LLM 历史，因此 Agent 依然没有毕业权。
    const next = await requestJson<LearningState>(
      `/api/web/sessions/${encodeURIComponent(sessionId)}/skills/${encodeURIComponent(skillId)}/${action}`,
      { method: "POST" },
    );
    if (sessionId !== sourceSessionId) return;
    if (next.restored_session) {
      applySessionPayload(next.restored_session);
      void loadConversationCatalog();
    } else renderState(next);
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error), {retry: action !== "locate"});
  } finally {
    skillActionPending = false;
  }
}

async function submitMasteryDecision(reply: LearnerQuestionReply, displayText: string): Promise<void> {
  if (!sessionId || !state || masteryDecisionPending || generating || remoteGenerating || skillActionPending) return;
  const sourceSessionId = sessionId;
  masteryDecisionPending = true;
  renderLearnerQuestions();
  syncComposerAvailability();
  setProviderControlsBusy(true);
  try {
    // 只有真实点击先经过用户决策入口，老师随后接收结果；不能把模型发言当成掌握确认。
    const result = await requestJson<{state: LearningState; continue_teaching: boolean}>(
      `/api/web/sessions/${encodeURIComponent(sourceSessionId)}/mastery-decision`, {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({learner_reply: reply, expected_version: state.classroom_version}),
      });
    if (sessionId !== sourceSessionId) return;
    if (result.state.restored_session) {
      // 复习确认沿原用户入口回到原课堂，不能向已经结束的复习分支继续发送。
      applySessionPayload(result.state.restored_session);
      void loadConversationCatalog();
      return;
    }
    renderState(result.state);
    if (result.continue_teaching) {
      masteryDecisionPending = false;
      await sendMessage("", {learnerReply: reply, displayText});
    }
  } catch (error) {
    if (sessionId !== sourceSessionId) return;
    // 应答丢失时保留同一请求的草稿，重试由服务端按真实决策回执协调，不猜测掌握结果。
    try {
      const refreshed = await requestJson<LearningState>(`/api/web/sessions/${encodeURIComponent(sourceSessionId)}/state`);
      if (sessionId === sourceSessionId) renderState(refreshed);
    } catch { /* 连接恢复后继续核对原请求。 */ }
    setError(error instanceof Error ? error.message : String(error));
  } finally {
    masteryDecisionPending = false;
    setProviderControlsBusy(false);
    renderLearnerQuestions();
    syncComposerAvailability();
  }
}

// 题卡只使用自身草稿；导航不发送请求，最终提交不消费聊天框文字或附件。
function submitLearnerQuestion(): void {
  if (!sessionId || !state || generating || masteryDecisionPending || remoteGenerating || assistantView.busy || voiceInput.busy || learningRecordNavigationPending || previewEntryId || viewMode(state) !== "CURRENT") return;
  try {
    const reply = learnerQuestionView.collect("");
    setError();
    if (!reply) { syncComposerAvailability(); return; }
    const displayText = learnerQuestionView.displayReply(reply, "");
    if (state.teaching.learner_questions?.pending?.purpose === "CONFIRM_MASTERY") void submitMasteryDecision(reply, displayText);
    else void sendMessage("", {learnerReply: reply, displayText});
  } catch (error) { setError(error instanceof Error ? error.message : String(error), {retry: false}); }
}

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (generating || masteryDecisionPending || remoteGenerating || learningRecordNavigationPending || voiceInput.busy) return;
  if (previewEntryId && sessionId) {
    void navigateLearningRecord(`/api/web/sessions/${encodeURIComponent(sessionId)}/activate`);
    return;
  }
  const text = elements.input.value;
  const voiceMetadata = voiceInput.metadata();
  const voiceQuestionKey = voiceScopeKey();
  const attachments = currentPendingAttachments();
  if(attachments.filter(item=>item.isImage).length>3) {setError("每次最多发送3张图片，请先移除多余附件。");return;}
  if (!text.trim() && !attachments.length) return;
  cancelMedia();
  voiceInput.clearMetadata(voiceQuestionKey);
  const displayText = text;
  elements.input.value = "";
  elements.input.style.height = "auto";
  // 实际发给老师的正文 = 用户文字 + 材料引用块；用户气泡只显示自己的话和缩略图。
  const contextBlock = attachments.length ? buildMaterialContextBlock(attachments) : "";
  const outgoingText = [text.trim(), contextBlock].filter(Boolean).join("\n");
  const uiAttachments: UiAttachment[] = attachments.map(item => ({
    id: item.id, name: item.name, isImage: item.isImage, previewUrl: item.previewUrl,
  }));
  if (sessionId) pendingAttachments.set(sessionId, []);
  renderComposerAttachments();
  void sendMessage(outgoingText, {
    displayText, voiceInput: voiceMetadata,
    attachments: uiAttachments,
    imageMaterialIds:attachments.filter(item=>item.isImage).map(item=>item.id),
  });
});

elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});

elements.input.addEventListener("input", () => {
  saveRouteUi();
  elements.input.style.height = "auto";
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 180)}px`;
});

elements.stop.addEventListener("click", async () => {
  if (!sessionId) return;
  await fetch(`/api/web/sessions/${encodeURIComponent(sessionId)}/stop`, { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({run_id: classroomClient.run?.id}) });
  void classroomClient.refresh();
});

elements.activeRecallSkip.addEventListener("click", async () => {
  if (!sessionId || generating) return;
  cancelMedia();
  try {
    const next = await requestJson<LearningState>(
      `/api/web/sessions/${encodeURIComponent(sessionId)}/active-recall/skip`,
      { method: "POST" },
    );
    renderState(next);
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
});


elements.retry.addEventListener("click", () => {
  if (generating || remoteGenerating) return;
  elements.retry.disabled = true;
  setConnection("正在重新连接", "connecting");
  void (sessionId ? requestJson<LearningState>(`/api/web/sessions/${encodeURIComponent(sessionId)}/state`).then(next => {
    renderState(next); setError(); setConnection(next.feedback_recovery ? "反馈待恢复" : currentUnreceivedAnswer() ? "回答待提交" : "已重新连接", next.feedback_recovery || currentUnreceivedAnswer() ? "error" : "ready");
    return classroomClient.refresh();
  }) : createSession()).catch(error => {setError(error instanceof Error ? error.message : String(error));setConnection("连接失败", "error");})
    .finally(() => {elements.retry.disabled = false;});
});

elements.feedbackRetry.addEventListener("click", async () => {
  // 恢复入口由服务端快照提供，不能依赖重连/同会话刷新时会清空的本地失败文本。
  const recovery = state?.feedback_recovery;
  if (checkingAnswerDelivery || generating || remoteGenerating || assistantView.busy) return;
  if (recovery) {void sendMessage("", {appendUser: false, feedbackRecoveryId: recovery.id}); return;}
  const pending = currentUnreceivedAnswer();
  if (!pending) return;
  checkingAnswerDelivery = true; syncFeedbackRecovery();
  try {
    const next = await requestJson<LearningState>(`/api/web/sessions/${encodeURIComponent(pending.sessionId)}/state`);
    if (sessionId !== pending.sessionId) return;
    renderState(next);
    const accepted = next.teaching.learner_questions?.last_answer;
    if (accepted?.request.id === pending.questionId && accepted.request.goal_id === pending.goalId && accepted.request.task_id === pending.taskId &&
        JSON.stringify(accepted.reply) === JSON.stringify(pending.options.learnerReply)) {
      unreceivedAnswer = null;
      if (next.feedback_recovery && next.active_goal_id === pending.goalId && next.overview.active_task?.id === pending.taskId)
        await sendMessage("", {appendUser: false, feedbackRecoveryId: next.feedback_recovery.id});
      else {setError(); setConnection("原回答已接收，学习状态已同步", "ready");}
      return;
    }
    if (!currentUnreceivedAnswer()) {
      setError("原题现场已变化，未确认接收的回答仍留在本页草稿中；请核对原任务，不能提交到新题。", {retry: false});
      return;
    }
    await sendMessage(pending.text, {...pending.options, transportRequestId: pending.requestId});
  } catch (error) {setError(error instanceof Error ? error.message : String(error));}
  finally {checkingAnswerDelivery = false; syncFeedbackRecovery();}
});

const selectRouteSkill = (event: Event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "button[data-select-skill]",
  );
  if (!button || !state) return;
  selectedSkillId = button.dataset.selectSkill ?? null;
  renderState(state);
  if (selectedSkillId && currentGoalSkills(state.overview).find((skill) => skill.id === selectedSkillId)?.status !== "NOT_STARTED") {
    void runSkillAction("locate", selectedSkillId, button.dataset.recordRoute);
  }
};
elements.skillRoute.addEventListener("click", selectRouteSkill);
document.addEventListener("click", event => {
  const target = (event.target as Element).closest<HTMLElement>("[data-route-branch][data-route-action]");
  if (target) void changeRouteBranch(target.dataset.routeBranch!, target.dataset.routeAction as RouteBranchCommand["action"])
    .catch(error => setError(error instanceof Error ? error.message : String(error)));
});
learnerQuestionView.node.addEventListener("input", saveRouteUi);
learnerQuestionView.node.addEventListener("change", saveRouteUi);
elements.messages.addEventListener("scroll", saveRouteUi, {passive: true});
window.addEventListener("beforeunload", saveRouteUi);

elements.learningLibraryContent.addEventListener("click", async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-library-action]");
  if (!button || generating) return;
  // 按钮位于 summary 内：阻止冒泡，避免点击它时触发 details 折叠。
  event.stopPropagation();
  const goalId = button.dataset.goal;
  const skillId = button.dataset.skill;
  if (!goalId) return;
  try {
    let payload: SessionResponse;
    if (button.dataset.libraryAction === "goal") {
      payload = await requestJson<SessionResponse>(`/api/web/goals/${encodeURIComponent(goalId)}/activate`, { method: "POST" });
    } else if (button.dataset.libraryAction === "review" && skillId) {
      payload = await startReviewPayload(goalId, skillId);
    } else return;
    applySessionPayload(payload);
    if (skillId) { selectedSkillId = skillId; renderState(payload.state); }
    workspace.navigate("learn");
    await loadConversationCatalog();
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
});

elements.branches.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!button || generating) return;
  if (button.dataset.branchOriginal) {
    const goalId = state?.view_goal_id ?? state?.active_goal_id;
    if (goalId) void navigateLearningRecord(`/api/web/goals/${encodeURIComponent(goalId)}/skills/${encodeURIComponent(button.dataset.branchOriginal)}/locate`);
    return;
  }
  if (button.dataset.branchEntry) void navigateLearningRecord("/api/web/branches/select", { entryId: button.dataset.branchEntry });
});

elements.headerTaskInfo.addEventListener("click", (event) => {
  if ((event.target as HTMLElement).closest("[data-review-finish]")) void navigateLearningRecord("/api/web/reviews/finish");
});

function closeSkillIntroduction(): void {
  const details = elements.skill.querySelector<HTMLElement>(".focused-skill-details");
  if (!details || details.hidden) return;
  details.hidden = true;
  expandedSkillIntroductions.delete(elements.skill.dataset.introductionKey!);
  const trigger = document.querySelector<HTMLButtonElement>("[data-action=toggle-focused-introduction]");
  trigger?.setAttribute("aria-expanded", "false");
  if (trigger) { trigger.textContent = "查看介绍"; trigger.focus({preventScroll:true}); }
}
document.addEventListener("keydown", event => { if (event.key === "Escape") closeSkillIntroduction(); });

document.addEventListener("click", (event) => {
  if (!(event.target as Element).closest("#skill-card, .learning-header-actions")) return;
  if ((event.target as Element).closest("[data-action=close-focused-introduction]")) { closeSkillIntroduction(); return; }
  const introductionToggle = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-action=toggle-focused-introduction]");
  if (introductionToggle) {
    const details = elements.skill.querySelector<HTMLElement>(".focused-skill-details");
    if (!details) return;
    const open = details.hidden;
    details.hidden = !open;
    introductionToggle.setAttribute("aria-expanded", String(open));
    introductionToggle.textContent = open ? "收起介绍" : "查看介绍";
    const key = elements.skill.dataset.introductionKey!;
    if (open) { expandedSkillIntroductions.add(key); details.querySelector<HTMLButtonElement>("[data-action=close-focused-introduction]")?.focus({preventScroll:true}); } else expandedSkillIntroductions.delete(key);
    return;
  }
  const descriptionToggle = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "button[data-action='toggle-skill-description']",
  );
  if (descriptionToggle) {
    const wrapper = descriptionToggle.closest(".skill-description");
    const preview = wrapper?.querySelector(".skill-description-preview") as HTMLElement | null;
    const full = wrapper?.querySelector(".skill-description-full") as HTMLElement | null;
    if (wrapper && preview && full) {
      const expanded = wrapper.classList.toggle("skill-description-expanded");
      preview.hidden = expanded;
      full.hidden = !expanded;
      descriptionToggle.textContent = expanded ? "收起介绍" : "查看完整介绍";
    }
    return;
  }
  const summaryBtn = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "button[data-card-action='summary-toggle']",
  );
  if (summaryBtn) {
    renderKnowledgeCards(state ? currentSkill(state) : undefined);
    applyTaskFocusCollapsed(false);
    elements.knowledgeCards.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
  if (button) void runSkillAction(button.dataset.action!, button.dataset.skill!);
});

// 卡片交互统一委托：翻牌、feedback、笔记编辑都走这里，避免每次重建后重新绑定。
elements.knowledgeCards.addEventListener("input", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLTextAreaElement)) return;
  if (input.dataset.noteTextarea) cardNoteDrafts.set(input.dataset.noteTextarea, input.value);
  const id = input.dataset.editQuestion ?? input.dataset.editAnswer;
  const card = id ? (resolvedCardSource()?.project.knowledge_cards ?? overviewCards()).find(card => card.id === id) : undefined;
  if (card) {
    const draft = cardEditDrafts.get(card.id) ?? {question: card.question, answer: card.answer};
    if (input.hasAttribute("data-edit-question")) draft.question = input.value;
    else draft.answer = input.value;
    cardEditDrafts.set(card.id, draft);
  }
});
elements.knowledgeCards.addEventListener("click", (event) => {
  if ((event.target as Element).closest("[data-card-source-return]")) {
    applyTaskFocusCollapsed(true); workspace.navigate("notes"); return;
  }
  if ((event.target as Element).closest("[data-card-return-dialogue]")) {
    applyTaskFocusCollapsed(true); return;
  }

  const target = event.target as HTMLElement;
  const mode = target.closest("[data-card-mode]");
  const step = target.closest<HTMLButtonElement>("[data-card-step]");
  if (mode || step) {
    const skill = resolvedCardSource()?.skill ?? (state ? currentSkill(state) : undefined);
    if (!skill) return;
    const cards = cardsForSkill(skill.id);
    if (mode) {
      cardReviewMode = !cardReviewMode;
      if (cardReviewMode) { cardReviewPositions.set(skill.id, 0); cards.forEach(card => flippedCards.delete(card.id)); }
    } else if (step && !step.disabled) {
      cardReviewPositions.set(skill.id, Math.max(0,Math.min(cards.length - 1,(cardReviewPositions.get(skill.id) ?? 0) + Number(step.dataset.cardStep))));
    }
    renderKnowledgeCards(skill);
    elements.knowledgeCards.querySelector<HTMLButtonElement>("[data-card-mode]")?.focus({preventScroll:true});
    return;
  }
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-card-action]");
  if (!button) return;
  const action = button.dataset.cardAction;
  const cardId = button.dataset.cardId;
  const skill = resolvedCardSource()?.skill ?? (state ? currentSkill(state) : undefined);
  if (!cardId) return;
  syncKnowledgeCardNotice(false, [cardId]);
  if (action === "flip") {
    if (flippedCards.has(cardId)) flippedCards.delete(cardId);
    else flippedCards.add(cardId);
    renderKnowledgeCards(skill);
  } else if (action === "feedback") {
    void postCardFeedback(cardId, button.dataset.feedback as CardFeedback);
  } else if (action === "edit-note") {
    editingNoteCardId = cardId;
    renderKnowledgeCards(skill);
    elements.knowledgeCards
      .querySelector<HTMLTextAreaElement>(`[data-note-textarea="${CSS.escape(cardId)}"]`)
      ?.focus();
  } else if (action === "cancel-note") {
    cardNoteDrafts.delete(cardId);
    editingNoteCardId = null;
    renderKnowledgeCards(skill);
  } else if (action === "save-note") {
    const note =
      elements.knowledgeCards.querySelector<HTMLTextAreaElement>(`[data-note-textarea="${CSS.escape(cardId)}"]`)
        ?.value ?? "";
    void putCardNote(cardId, note);
  } else if (action === "clear-note") {
    if (window.confirm("清空这条笔记？")) void deleteCardNote(cardId);
  } else if (action === "edit") {
    editingCardId = cardId;
    editingNoteCardId = null;
    renderKnowledgeCards(skill);
    document
      .querySelector<HTMLTextAreaElement>(`[data-edit-question="${CSS.escape(cardId)}"]`)
      ?.focus();
  } else if (action === "cancel-edit") {
    cardEditDrafts.delete(cardId);
    editingCardId = null;
    renderKnowledgeCards(skill);
  } else if (action === "save-edit") {
    const question =
      document.querySelector<HTMLTextAreaElement>(`[data-edit-question="${CSS.escape(cardId)}"]`)
        ?.value ?? "";
    const answer =
      document.querySelector<HTMLTextAreaElement>(`[data-edit-answer="${CSS.escape(cardId)}"]`)
        ?.value ?? "";
    void updateCard(cardId, question, answer);
  } else if (action === "delete") {
    if (window.confirm("删除这张知识卡片？删除后无法恢复。")) void deleteCard(cardId);
  }
});

document.querySelector("#notes-sort")?.addEventListener("change", () => renderNotesView());

// Notes 视图：分组浏览、就地编辑，或跳回对应卡片。
elements.notesContent.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-card-action]");
  if (!button) return;
  const action = button.dataset.cardAction;
  const cardId = button.dataset.cardId;
  if (!cardId) return;
  if (action === "edit-note") {
    editingLibraryNoteCardId = cardId;
    renderNotesView();
  } else if (action === "cancel-note") {
    editingLibraryNoteCardId = null;
    renderNotesView();
  } else if (action === "save-note") {
    const note =
      elements.notesContent.querySelector<HTMLTextAreaElement>(`[data-note-textarea="${CSS.escape(cardId)}"]`)
        ?.value ?? "";
    void putCardNote(cardId, note, "notes");
  } else if (action === "open-card") {
    void openCardFromNotes(cardId);
  }
});

// 「查看卡片」只定位原 Goal / Skill / Card；跨目标浏览不激活目标，也不改当前教学。
async function openCardFromNotes(cardId: string): Promise<void> {
  const project = notesLibraryCache?.projects.find(item => item.knowledge_cards.some(card => card.id === cardId));
  const card = project?.knowledge_cards.find(item => item.id === cardId);
  const revision = cardSource.begin({goalId: project?.goal_profile.id ?? "", skillId: card?.skill_id ?? "", cardId});
  cardReviewMode = false;
  workspace.navigate("learn");
  applyTaskFocusCollapsed(false);
  renderKnowledgeCards();
  try {
    // 只读取库投影，绝不调用 activate，也不覆盖正在学习的 session/task。
    const library = await requestJson<LearningLibraryResponse>("/api/web/learning-library");
    const source = cardSource.reference && resolveCardSource(library.projects, cardSource.reference);
    if (!cardSource.finish(revision, Boolean(source))) return;
    notesLibraryCache = library;
    flippedCards.add(cardId);
    renderKnowledgeCards();
    workspace.afterRestore(() => {
      const node = elements.knowledgeCards.querySelector<HTMLElement>(`.knowledge-card[data-card-id="${CSS.escape(cardId)}"]`);
      if (!node || cardSource.reference?.cardId !== cardId) return;
      const host = cardScrollHost();
      host.scrollTop += node.getBoundingClientRect().top - host.getBoundingClientRect().top - 20;
      node.tabIndex = -1;
      node.focus({preventScroll:true});
    });
  } catch (error) {
    if (cardSource.finish(revision, false, error instanceof Error ? error.message : String(error))) renderKnowledgeCards();
  }
}

async function openNotesPage(): Promise<void> {
  // 暂离正在编辑的笔记时保留原 DOM 和草稿，返回后继续编辑。
  if (elements.notesContent.querySelector("textarea")) return;
  if (!elements.notesContent.children.length) elements.notesContent.innerHTML = '<p class="library-loading">正在读取全部笔记…</p>';
  try {
    await refreshNotesLibrary();
    renderNotesView();
  } catch (error) {
    elements.notesContent.innerHTML = `<div class="library-empty-state"><h3>暂时无法读取笔记</h3><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p></div>`;
  }
}

elements.activityButton.addEventListener("click", () => {
  if (!activities.length) return;
  workspace.navigate("learn");
  applyTaskFocusCollapsed(true);
  elements.activityPanel.open = true;
  elements.activityPanel.scrollIntoView({ behavior: "smooth", block: "center" });
});

elements.profileButton.addEventListener("click", () => {
  const willOpen = elements.profileMenu.classList.contains("hidden");
  elements.profileMenu.classList.toggle("hidden", !willOpen);
  elements.profileButton.setAttribute("aria-expanded", String(willOpen));
});

document.addEventListener("click", (event) => {
  if ((event.target as HTMLElement).closest(".profile-wrap")) return;
  elements.profileMenu.classList.add("hidden");
  elements.profileButton.setAttribute("aria-expanded", "false");
});

function requestNewGoal(): void {
  if (generating || learningRecordNavigationPending || !sessionId || elements.newGoalDialog.open) return;
  cancelMedia();
  applyMobileNavOpen(false);
  elements.profileMenu.classList.add("hidden");
  elements.newGoalCopy.textContent = state && viewMode(state) !== "CURRENT"
    ? "新目标会另开草稿，原学习记录会保留。你可以先上传资料，再和老师规划；切回原对话即可继续原任务。"
    : state?.overview.current_goal
    ? "当前学习记录会保留。你可以先上传资料，再和老师规划新目标；切回原对话即可继续原任务。"
    : "你可以先上传资料，也可以直接告诉老师希望学会什么，再一起规划学习。";
  // 重开确认框后，Escape 不能沿用上次的 confirm 而创建目标草稿。
  elements.newGoalDialog.returnValue = "";
  elements.newGoalDialog.showModal();
}
elements.newGoal.addEventListener("click", requestNewGoal);

elements.newGoalDialog.addEventListener("close", async () => {
  const suggestedPrompt = suggestedGoalPrompt;
  suggestedGoalPrompt = "";
  if (elements.newGoalDialog.returnValue !== "confirm" || !sessionId) return;
  const navigation = ++classroomNavigationRequest;
  const resumeSnapshots = classroomClient.pauseSnapshots();
  learningRecordNavigationPending = true;
  syncComposerAvailability();
  workspace.navigate("learn");
  applyTaskFocusCollapsed(true);
  try {
    const replaceExisting = viewMode(state) === "CURRENT"
      ? Boolean(state?.overview.current_goal)
      : Boolean(state?.active_goal_id);
    const preserveConfirmedRoute = replaceExisting && viewMode(state) === "CURRENT" && (
      state?.recoverable_confirmed_goal === true ||
      (state?.onboarding.status === "CONFIRMED" && !state.onboarding.replace_existing)
    );
    if (!preserveConfirmedRoute) {
      // 通常新 Goal 使用全新 Pi Session；唯一例外是给本会话已确认的路线补授权。
      const created = await requestJson<SessionResponse>("/api/web/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "new-goal" }),
      });
      if (navigation !== classroomNavigationRequest) return;
      // 第一份权威草稿返回便同步标题、对话和操作对象，第二个慢请求期间不再显示旧课堂。
      applySessionPayload(created);
    }
    // Major Goal Change 仍要求用户在独立对话框中明确确认；视觉改版不放宽这个边界。
    const next = await requestJson<LearningState>(
      `/api/web/sessions/${encodeURIComponent(sessionId)}/new-goal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ replaceExisting }),
      },
    );
    if (navigation !== classroomNavigationRequest) return;
    if (replaceExisting && !next.onboarding.replace_existing) {
      throw new Error("新目标替换授权未生效，请勿继续规划；请重试「新目标」。");
    }
    renderState(next);
    messages.push({
      role: "assistant",
      content: preserveConfirmedRoute
        ? "已授权替换当前目标，并保留刚才确认的路线。请发送「继续初始化已确认路线」，无需重新回答目标问题。"
        : next.onboarding.replace_existing
          ? "可以先上传资料，让我依据内容帮你规划学习；也可以直接描述目标。原对话仍保留，切回即可继续原任务。"
          : "可以先点击 + 上传文件，让我依据资料规划学习；也可以告诉我最终希望做到什么、相关经历和可投入的时间。",
    });
    renderMessages();
    await loadConversationCatalog();
    if (suggestedPrompt) elements.input.value = suggestedPrompt;
    elements.input.focus();
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  } finally {
    learningRecordNavigationPending = false;
    syncComposerAvailability();
    renderLearnerQuestions();
    resumeSnapshots();
  }
});

elements.newConversation.addEventListener("click", requestNewGoal);
elements.dialogNewConversation.addEventListener("click", requestNewGoal);

/** 激活请求顺序执行，只展示最后一次选择。旧响应不渲染，最终服务端位置也按最后意图恢复。 */
async function activateClassroom(url: string): Promise<boolean> {
  const request = ++classroomNavigationRequest;
  const resumeSnapshots = classroomClient.pauseSnapshots();
  classroomNavigationOperations++;
  learningRecordNavigationPending = true;
  syncComposerAvailability();
  const operation = classroomNavigationQueue.then(async () => {
    if (request !== classroomNavigationRequest) return false;
    const payload = await requestJson<SessionResponse>(url, {method: "POST"});
    if (request !== classroomNavigationRequest) return false;
    applySessionPayload(payload);
    return true;
  });
  classroomNavigationQueue = operation.then(() => undefined, () => undefined);
  try { return await operation; }
  catch (error) {
    if (request !== classroomNavigationRequest) return false;
    throw error;
  }
  finally {
    learningRecordNavigationPending = --classroomNavigationOperations > 0;
    syncComposerAvailability();
    renderLearnerQuestions();
    resumeSnapshots();
  }
}

async function handleConversationAction(event: Event): Promise<void> {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "button[data-conversation-action]",
  );
  if (!button || generating) return;
  const id = button.dataset.sessionId;
  const action = button.dataset.conversationAction;
  if (!id || !action) return;
  cancelMedia();
  const summary = conversationCatalog.sessions.find((item) => item.id === id);
  try {
    if (action === "activate") {
      if (id === sessionId && !classroomNavigationOperations) { workspace.navigate("learn"); return; }
      setConnection("正在切换对话", "connecting");
      if (!await activateClassroom(`/api/web/sessions/${encodeURIComponent(id)}/activate`)) return;
      setConnection(
        viewMode(state) === "CURRENT" ? "已切换对话" : "历史目标只读；学习资料已随对话切换",
        "ready",
      );
    } else if (action === "rename") {
      const name = window.prompt("新的对话名称", summary?.name ?? "");
      if (name === null) return;
      await requestJson<ConversationCatalogResponse>(
        `/api/web/sessions/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
      );
    } else if (action === "activate-goal") {
      if (!await activateClassroom(`/api/web/goals/${encodeURIComponent(id)}/activate`)) return;
    } else if (action === "delete" || action === "delete-goal") {
      const goal = (conversationCatalog.unlinkedGoals ?? []).find(item => item.id === id);
      const name = goal?.name ?? summary?.goalDescription ?? summary?.name ?? "新目标草稿";
      const isGoal = Boolean(goal || summary?.goalId);
      if (!window.confirm(isGoal
        ? `删除学习目标“${name}”？它的所有对话、资料和学习记录都会移入回收区，可以恢复。其他目标保留。`
        : `删除草稿“${name}”？此草稿及其未绑定资料会移入回收区，可以恢复。`)) return;
      applySessionPayload(
        await requestJson<SessionResponse>(
          action === "delete-goal" ? `/api/web/goals/${encodeURIComponent(id)}` : `/api/web/sessions/${encodeURIComponent(id)}`,
          { method: "DELETE" },
        ),
      );
      elements.managementStatus.textContent = `${isGoal ? "学习目标" : "草稿"}已移入回收区。`;
      setConnection("已恢复保留的学习位置", "ready");
    } else if (action === "clear") {
      if (!window.confirm(`仅清空“${summary?.name ?? "这个对话"}”的聊天记录？学习进度、资料和知识卡片保留，原聊天可从回收区恢复。`)) return;
      applySessionPayload(await requestJson<SessionResponse>(`/api/web/sessions/${encodeURIComponent(id)}/clear`, {method: "POST"}));
      elements.managementStatus.textContent = "聊天已清空，学习进度与资料保留。";
    }
    await loadConversationCatalog();
    if (action === "activate" || action === "activate-goal") workspace.navigate("learn");
  } catch (error) {
    elements.managementStatus.textContent = error instanceof Error ? error.message : String(error);
    setError(error instanceof Error ? error.message : String(error));
    if (workspace.current === "conversations") void loadRecycle();
  }
}

elements.conversationList.addEventListener("click", (event) => {
  void handleConversationAction(event);
});
elements.conversationPageList.addEventListener("click", (event) => {
  void handleConversationAction(event);
});
elements.conversationMenuButton.addEventListener("click", () => {
  workspace.navigate("conversations");
});

elements.recycleList.addEventListener("click", async event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-recycle-action]");
  if (!button || generating || button.disabled) return;
  const action = button.dataset.recycleAction;
  const id = button.dataset.recycleId;
  if (!id || !action) return;
  const name = button.closest(".recycle-item")?.querySelector("strong")?.textContent ?? "这个回收项";
  if (action === "purge" && !window.confirm(`永久删除“${name}”？此回收项独占的资料和学习记录将无法恢复；其他目标正在使用的共享内容保留。`)) return;
  elements.recycleList.querySelectorAll<HTMLButtonElement>("button").forEach(item => {item.disabled = true;});
  elements.managementStatus.textContent = action === "restore" ? "正在恢复…" : "正在永久删除…";
  try {
    applySessionPayload(await requestJson<SessionResponse>(`/api/web/recycle/${encodeURIComponent(id)}/${action}`, {method: "POST"}));
    elements.managementStatus.textContent = action === "restore" ? "已恢复，可以接着原进度学习。" : "已永久删除。";
    await loadConversationCatalog();
    if (action === "restore") workspace.navigate("learn");
  } catch (error) {
    elements.managementStatus.textContent = error instanceof Error ? error.message : "操作未完成，请重试。";
    await loadRecycle();
  }
});

function openProviderSettings(): void {
  workspace.navigate("settings");
}

elements.providerStatusButton.addEventListener("click", openProviderSettings);
elements.newProviderProfile.addEventListener("click", () => {
  selectedProviderProfileId = null;
  renderProviderEditor();
  elements.profileList.querySelectorAll(".provider-profile-item").forEach((item) => {
    item.classList.remove("selected");
  });
  elements.providerTestResult.classList.add("hidden");
  elements.profileNameInput.focus();
});

elements.profileList.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-profile-id]");
  if (!button || !providerCatalog) return;
  selectedProviderProfileId = button.dataset.profileId ?? null;
  renderProviderCatalog(providerCatalog);
  elements.providerTestResult.classList.add("hidden");
});

elements.testProvider.addEventListener("click", async () => {
  setProviderControlsBusy(true);
  showProviderResult("正在验证 URL、Key、模型与推理强度…", "pending");
  try {
    const result = await requestJson<ProviderConnectionResult>(
      "/api/web/provider-settings/test",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(providerInput()),
      },
    );
    showProviderResult(result.message, "success");
  } catch (error) {
    showProviderResult(error instanceof Error ? error.message : String(error), "error");
  } finally {
    setProviderControlsBusy(false);
  }
});

elements.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (generating) {
    showProviderResult("老师正在生成回复，请先停止或等待本轮结束。", "error");
    return;
  }
  if (!providerSaveState.begin()) return;
  setProviderControlsBusy(true);
  elements.providerTestResult.classList.add("hidden");
  try {
    const catalog = await requestJson<ProviderCatalog>("/api/web/provider-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(providerInput()),
    });
    selectedProviderProfileId = catalog.activeProfileId;
    renderProviderCatalog(catalog);
    providerSaveState.success("已保存并使用 · 下一轮教学生效");
    elements.providerTestResult.classList.add("hidden");
  } catch (error) {
    providerSaveState.error(error instanceof Error ? error.message : String(error));
  } finally {
    setProviderControlsBusy(false);
  }
});

elements.activateProvider.addEventListener("click", async () => {
  if (!selectedProviderProfileId) return;
  setProviderControlsBusy(true);
  showProviderResult("正在切换模型…", "pending");
  try {
    const catalog = await requestJson<ProviderCatalog>(
      "/api/web/provider-settings/activate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: selectedProviderProfileId }),
      },
    );
    renderProviderCatalog(catalog);
    showProviderResult("已切换模型与推理强度。当前对话历史保持不变。", "success");
  } catch (error) {
    showProviderResult(error instanceof Error ? error.message : String(error), "error");
  } finally {
    setProviderControlsBusy(false);
  }
});

elements.deleteProvider.addEventListener("click", async () => {
  if (!selectedProviderProfileId || !providerCatalog) return;
  const selected = providerCatalog.profiles.find(
    (profile) => profile.id === selectedProviderProfileId,
  );
  if (!selected || !window.confirm(`删除配置“${selected.name}”？本机保存的对应 API Key 也会删除。`)) {
    return;
  }
  setProviderControlsBusy(true);
  try {
    const catalog = await requestJson<ProviderCatalog>("/api/web/provider-settings", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: selected.id }),
    });
    selectedProviderProfileId = catalog.activeProfileId ?? catalog.profiles[0]?.id ?? null;
    renderProviderCatalog(catalog);
    showProviderResult("配置及其本机 Secret 已删除。", "success");
  } catch (error) {
    showProviderResult(error instanceof Error ? error.message : String(error), "error");
  } finally {
    setProviderControlsBusy(false);
  }
});

elements.sidebarToggle.addEventListener("click", () => {
  if (mobileNavMedia.matches) {
    applyMobileNavOpen(!document.body.classList.contains("mobile-nav-open"));
  } else {
    applySidebarCollapsed(!document.body.classList.contains("sidebar-collapsed"));
  }
});
elements.mobileNavBackdrop.addEventListener("click", () => applyMobileNavOpen(false));
$("#sidebar").addEventListener("click", (event) => {
  if (mobileNavMedia.matches && (event.target as Element).closest(".nav-item")) {
    applyMobileNavOpen(false);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && mobileNavMedia.matches) applyMobileNavOpen(false);
});
mobileNavMedia.addEventListener("change", () => {
  applyMobileNavOpen(false);
  setMobileSurfaceTabsHidden(false);
  setConnection(connectionState.label, connectionState.status);
  syncComposerAvailability();
});
document.addEventListener("visibilitychange", () => syncKnowledgeCardNotice(false, displayedKnowledgeCardIds()));

// 手机端界面切换只换显示与滚动位置；不触发教学回合、不重建会话、不写学习记录。
// 底部三格只在滑到底时出现：阅读位置离开底部就让位，输入栏保持固定不动。
function setMobileSurfaceTabsHidden(hidden: boolean): void {
  const next = hidden && mobileNavMedia.matches;
  if (next === document.body.classList.contains("mobile-tabs-hidden")) return;
  document.body.classList.toggle("mobile-tabs-hidden", next);
  // 收起后阅读区变高：内容不再溢出时没有手势滚动，必须立刻让三格回来，避免无处可切。
  if (next) window.requestAnimationFrame(() => syncMobileSurfaceTabs(true));
}

function syncMobileSurfaceTabs(force = false): void {
  if (!mobileNavMedia.matches) { setMobileSurfaceTabsHidden(false); return; }
  const node = mobileSurfaceScroller(mobileSurface);
  if (!node || node.scrollHeight <= node.clientHeight + 4) { setMobileSurfaceTabsHidden(false); return; }
  // 渲染、恢复滚动位置和容器高度变化也会触发 scroll：那些不改变三格显隐，只有真实手势才切换。
  if (!force && performance.now() - lastSurfaceGestureAt >= 400) return;
  const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 24;
  setMobileSurfaceTabsHidden(!atBottom);
}

// 初值必须早于任何真实手势：0 会让页面加载后 400ms 内的渲染滚动被误判成手势。
let lastSurfaceGestureAt = Number.NEGATIVE_INFINITY;
const markSurfaceGesture = (): void => { lastSurfaceGestureAt = performance.now(); };
for (const node of [elements.messages, elements.skillRoute, elements.contextColumn]) {
  node.addEventListener("wheel", markSurfaceGesture, { passive: true });
  node.addEventListener("touchmove", markSurfaceGesture, { passive: true });
  node.addEventListener("pointermove", (event) => { if (event.buttons) markSurfaceGesture(); }, { passive: true });
  node.addEventListener("scroll", () => syncMobileSurfaceTabs(false), { passive: true });
}

function mobileSurfaceScroller(surface: MobileSurface): HTMLElement | null {
  if (surface === "route") return elements.skillRoute;
  if (surface === "records") return elements.contextColumn;
  return elements.messages;
}

function applyMobileSurface(surface: MobileSurface): void {
  const current = mobileSurfaceScroller(mobileSurface);
  if (current) mobileSurfaceScroll.set(mobileSurface, current.scrollTop);
  mobileSurface = surface;
  if (surface === "learn") delete document.body.dataset.mobileScreen;
  else document.body.dataset.mobileScreen = surface;
  elements.mobileSurfaceTabs.querySelectorAll<HTMLElement>("[data-mobile-surface]").forEach((button) => {
    if (button.dataset.mobileSurface === surface) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  });
  const saved = mobileSurfaceScroll.get(surface) ?? 0;
  window.requestAnimationFrame(() => {
    const node = mobileSurfaceScroller(surface);
    if (mobileSurface === surface && node) node.scrollTop = saved;
  });
  setMobileSurfaceTabsHidden(false);
  syncKnowledgeCardNotice(false, surface === "learn" ? displayedKnowledgeCardIds() : []);
}

elements.mobileSurfaceTabs.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLElement>("[data-mobile-surface]");
  if (button) applyMobileSurface((button.dataset.mobileSurface ?? "learn") as MobileSurface);
});
elements.mobileSurfaceTabs.querySelectorAll<HTMLElement>("[data-mobile-surface]").forEach((button) => {
  if (button.dataset.mobileSurface === mobileSurface) button.setAttribute("aria-current", "true");
});

elements.taskFocusToggle.addEventListener("click", () => {
  assistantView.setOpen(false);
  applyTaskFocusCollapsed(false);
});

elements.conversationToggle.addEventListener("click", () => {
  assistantView.setOpen(false);
  applyTaskFocusCollapsed(true);
});
elements.learningViewTabs.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  assistantView.setOpen(false);
  const conversation = event.key === "Home" || event.key !== "End" &&
    !document.body.classList.contains("task-focus-collapsed");
  applyTaskFocusCollapsed(conversation);
  (conversation ? elements.conversationToggle : elements.taskFocusToggle).focus({ preventScroll: true });
});

mountIcons();
startLearningIntro();
new FeatureGuide(() => ({
  ready: Boolean(state && guideCatalogReady),
  hasHistory: Boolean(state?.overview.current_goal || state?.overview.skills.length || messages.length ||
    conversationCatalog.sessions.some(item => item.messageCount > 0 || item.goalId) || conversationCatalog.unlinkedGoals?.length),
  hasGoal: Boolean(state?.overview.current_goal),
  classroom: Boolean(state?.overview.active_task?.status === "ACTIVE" && viewMode(state) === "CURRENT" && !previewEntryId && ["IDLE", "INITIALIZED"].includes(state.onboarding.status)),
  busy: generating || remoteGenerating || assistantView.busy || voiceInput.busy || learningRecordNavigationPending,
  hasCards: Boolean(state?.overview.knowledge_cards.length),
  voice: speechSettings.configured,
  purpose: state?.teaching.learner_questions?.pending?.purpose ?? null,
  questionCount: state?.teaching.learner_questions?.pending?.questions.length ?? 0,
  view: workspace.current,
}));
applySidebarCollapsed(readStoredFlag(SIDEBAR_COLLAPSED_KEY));
applyMobileNavOpen(false);
applyTaskFocusCollapsed(readStoredFlag(TASK_FOCUS_COLLAPSED_KEY, true));
workspace.start();

setGreeting();
renderActivities();
void loadProviderSettings();
void speechSettings.load();
void createSession();

mobileNavMedia.addEventListener("change", () => {
  if (state) { renderState(state); renderBranches(); }
  focusedWorkspace.sync();
});
