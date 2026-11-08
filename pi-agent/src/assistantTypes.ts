import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RetrievalRuntime } from "./retrieval/runtime.js";
import type {AnimationAnchor,AnimationQuestionContext} from "./animationTypes.js";
import type {ExplainerContext} from "./explainerTypes.js";
import type {FigureQuestion} from "./lessonFigureTypes.js";
import type {LearningSkillRuntime} from "./learningSkills.js";

/** 锚点及状态由主课堂受信工具快照重建，不接受浏览器自报教学事实。 */
export interface AssistantAnimationQuestion {anchor:AnimationAnchor;context:AnimationQuestionContext|ExplainerContext}
export interface AssistantAnimationSummary {
  presentationId:string;sourceEntryId:string;title:string;target:string;recipe:string;
  playback:"UNKNOWN";validation:"FIXED_EXAMPLE"|"STRUCTURE_ONLY";
  elements:Array<{id:string;kind:string;text:string}>;
  scenes:Array<{id:string;label:string;caption:string}>;truncated:boolean;
}

/** 只能由服务端当前 Kernel/主 Pi 派生；浏览器和模型不能指定归属。 */
export interface AssistantScope {
  goalId: string;
  taskId: string;
  skillId: string;
  mainSessionId: string;
  branchId: string;
  questionId: string | null;
  attemptId: string | null;
}
export type AssistantHelpKind = "NONE" | "CLARIFICATION" | "HINT" | "REFERENCE" | "ANSWER" | "UNKNOWN";
export type AssistantDelivery = "NOT_DELIVERED" | "POSSIBLY_DELIVERED" | "CONFIRMED";
export interface AssistantMessage { id: string; role: "user" | "assistant"; content: string; createdAt: string; consultationId: string;animationQuestion?:AssistantAnimationQuestion;figureQuestion?:FigureQuestion }
export interface AssistantClassification {
  kind: AssistantHelpKind;
  reason: string;
  /** 必须是实际助教回复的连续原文；NONE 也不能仅根据用户提问分类。 */
  replyQuote: string;
}
export interface AssistantConsultation {
  id: string;
  scope: AssistantScope;
  userMessageId: string;
  assistantMessageId: string;
  question: string;
  reply: string;
  createdAt: string;
  completedAt?: string;
  status: "RUNNING" | "COMPLETED" | "INTERRUPTED" | "FAILED" | "DELETED";
  delivery: AssistantDelivery;
  classification: AssistantClassification;
  sequence: number;
  archivedBy?: string[];
  animationQuestion?:AssistantAnimationQuestion;
  figureQuestion?:FigureQuestion;
}
export interface AssistantSnapshot {
  scope: AssistantScope;
  sessionId: string;
  messages: AssistantMessage[];
  consultations: AssistantConsultation[];
  busy: boolean;
  revision: string;
}
export interface AssistantAssistance {
  kind: AssistantHelpKind;
  revision: string;
  summary: string;
  records: AssistantConsultation[];
  priorRecords: AssistantConsultation[];
  unknown: boolean;
  hasHelp: boolean;
  truncated: boolean;
}
export interface AssistantContext {
  figureQuestion?:FigureQuestion;
  learningSkills?:LearningSkillRuntime;
  animationQuestion?:AssistantAnimationQuestion;
  animations?:AssistantAnimationSummary[];
  branchSource?: import("./assistantHandoff.js").BranchSource;
  mainContextTruncated?: boolean;
  questionTruncated?: boolean;
  goalName?: string;
  taskName?: string;
  skillName?: string;
  currentQuestion?: string;
  mainMessages?: Array<{ id?: string; role: "user" | "assistant"; content: string }>;
  overview?: unknown;
  apiBaseUrl?: string;
  modelRuntime?: ModelRuntime;
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  retrieval?: RetrievalRuntime | false;
  isCurrentScope?: () => boolean | Promise<boolean>;
  readMainMessages?: (options: { beforeId?: string; limit: number }) => Promise<{
    messages: Array<{ id?: string; role: "user" | "assistant"; content: string }>;
    truncated: boolean;
  }>;
}
export type AssistantEvent =
  | { type: "assistant_delta"; delta: string; consultationId: string }
  | { type: "tool_start"; toolName: string }
  | { type: "tool_end"; toolName: string; isError: boolean }
  | { type: "state"; state: AssistantSnapshot }
  | { type: "done" }
  | { type: "error"; message: string };
export type AssistantAgentEvent =
  | { type: "assistant_delta"; delta: string }
  | { type: "tool_start"; toolName: string }
  | { type: "tool_end"; toolName: string; isError: boolean }
  | { type: "model_error"; message: string };
export interface AssistantAgent {
  prompt(question: string): Promise<void>;
  classify?(reply: string): Promise<AssistantClassification | null>;
  materialDeleted?(materialId: string): boolean;
  abort(): Promise<void>;
  dispose(): void;
}
export interface AssistantAgentOptions {
  scope: AssistantScope;
  context: AssistantContext;
  history: AssistantMessage[];
  onEvent(event: AssistantAgentEvent): void | Promise<void>;
  onClassification(value: AssistantClassification): void;
  isCurrentScope(): Promise<boolean>;
}
export type AssistantAgentFactory = (options: AssistantAgentOptions) => Promise<AssistantAgent>;

export function sameAssistantScope(a: AssistantScope, b: AssistantScope): boolean {
  return a.goalId === b.goalId && a.taskId === b.taskId && a.skillId === b.skillId &&
    a.mainSessionId === b.mainSessionId && a.branchId === b.branchId &&
    a.questionId === b.questionId && a.attemptId === b.attemptId;
}
export function assistantScopeKey(scope: AssistantScope): string {
  return JSON.stringify([scope.goalId, scope.taskId, scope.skillId, scope.mainSessionId, scope.branchId]);
}
