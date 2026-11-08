import type {ExtensionFactory, SessionBeforeCompactEvent} from "@earendil-works/pi-coding-agent";
import {projectPreferenceMessages, PREFERENCE_HISTORY_NOTICE} from "./teachingPreferences.js";
import {protectTeachingCompaction} from "./teachingCompactionBudget.js";
import {compactOverviewMessages} from "./modelLearningContext.js";
import {projectAssistantProtocol} from "./assistantProtocol.js";
type CompactionPreparation = SessionBeforeCompactEvent["preparation"];

interface ContextMessage {role?: string; content?: unknown}
interface ContextModel {provider: string; id: string; contextWindow: number; maxTokens: number}

export function hasTeachingReasoningPolicy(model: Pick<ContextModel, "provider" | "id">): boolean {
  // 完成回合的旧思考不跨模型重放为正文；当前工具链的DeepSeek reasoning仍必须保留。
  // 未核对的签名Provider继续走原协议，不能仅凭相似模型名删除签名块。
  return (model.provider === "aliyun-bailian" && ["qwen3.8-flash", "qwen3.8-max"].includes(model.id)) ||
    (model.provider === "opencode-go" && model.id === "deepseek-v4.1-flash");
}

function withoutThinking<T extends ContextMessage>(message: T): T {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
  const content = message.content.filter(part => part?.type !== "thinking");
  return content.length === message.content.length ? message : {...message, content};
}

// 工作上下文与原始Pi记录分离：只移除已结束用户回合的过程思考。
// 最新user之后的思考属于当前工具链，必须继续回传；文字、图片、工具参数/结果及顺序均不改写。
export function projectTeachingReasoning<T extends ContextMessage>(model: Pick<ContextModel, "provider" | "id">,
  messages: readonly T[]): T[] {
  if (!hasTeachingReasoningPolicy(model)) return [...messages];
  const userAt = messages.findLastIndex(message => message.role === "user");
  if (userAt < 0) return [...messages];
  return messages.map((message, index) => index < userAt ? withoutThinking(message) : message);
}

export function projectTeachingCompaction(preparation: CompactionPreparation): void {
  // SDK摘要器会把thinking序列化成普通正文。摘要从可见对话与工具事实形成，不能重新固化已过期的思考。
  // 只替换preparation的输入数组；branchEntries、保留区以及持久化原消息均保持原样。
  preparation.messagesToSummarize = projectPreferenceMessages(projectAssistantProtocol(compactOverviewMessages(preparation.messagesToSummarize).map(withoutThinking)), undefined, true);
  preparation.turnPrefixMessages = projectPreferenceMessages(projectAssistantProtocol(preparation.turnPrefixMessages.map(withoutThinking)), undefined, true);
  if (preparation.previousSummary) preparation.previousSummary = PREFERENCE_HISTORY_NOTICE + "\n" + preparation.previousSummary;
}

export const teachingContextExtension: ExtensionFactory = pi => {
  pi.on("session_before_compact", event => {
    if (!protectTeachingCompaction(event)) return {cancel: true};
    projectTeachingCompaction(event.preparation);
  });
};
