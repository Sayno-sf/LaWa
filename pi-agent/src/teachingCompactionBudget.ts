import {buildContextEntries, estimateTokens, sessionEntryToContextMessages,
  type SessionBeforeCompactEvent} from "@earendil-works/pi-coding-agent";
import {compactOverviewMessages} from "./modelLearningContext.js";

type CompactionSettings = SessionBeforeCompactEvent["preparation"]["settings"];

export const TEACHING_WORKING_CONTEXT_TOKENS = 128_000;
export const TEACHING_RECENT_CONTEXT_TOKENS = 24_000;
export const TEACHING_SUMMARY_RESERVE_TOKENS = 4096;
export const TEACHING_SUMMARY_OUTPUT_TOKENS = 4096;
const MIN_ECONOMIC_SUMMARY_TOKENS = 2048;

export function teachingEconomicCompaction(model: {contextWindow: number; maxTokens: number},
  configured: CompactionSettings): CompactionSettings {
  // 经济预算仅影响本Session的压缩触发点；模型真实窗口仍供原件阅读和媒体容量校验使用。
  const reserve = Math.max(configured.reserveTokens, model.maxTokens + 8192,
    model.contextWindow - TEACHING_WORKING_CONTEXT_TOKENS);
  const ceiling = Math.max(1, model.contextWindow - Math.min(4096, Math.floor(model.contextWindow / 2)));
  const reserveTokens = Math.min(reserve, ceiling);
  // 用户明确选择24K近期目标；不能再被SDK默认20K悄悄收紧。只覆盖本实例，极小窗口按容量缩小。
  return {...configured, reserveTokens,
    keepRecentTokens: Math.min(TEACHING_RECENT_CONTEXT_TOKENS, model.contextWindow - reserveTokens)};
}

export function protectTeachingCompaction(event: SessionBeforeCompactEvent): boolean {
  const preparation = event.preparation;
  // SDK将reserve同时用于触发点和摘要输出。二者在这里拆开，避免1M窗口产生32K摘要。
  preparation.settings = {...preparation.settings,
    reserveTokens: Math.min(preparation.settings.reserveTokens, TEACHING_SUMMARY_RESERVE_TOKENS)};
  const active = buildContextEntries(event.branchEntries);
  let cut = active.findIndex(entry => entry.id === preparation.firstKeptEntryId);
  if (cut < 0) return false;
  const realUserStarts = active.flatMap((entry, index) => entry.type === "message" && entry.message.role === "user" ? [index] : []);
  const protectedStart = realUserStarts.at(-2) ?? realUserStarts.at(-1);
  if (protectedStart !== undefined) cut = Math.min(cut, protectedStart);
  // 完整保留最近的题面、真实回答和工具链。只在真实用户回合边界压缩，不能从toolResult开始。
  const turnStart = realUserStarts.findLast(index => index <= cut);
  if (turnStart !== undefined) cut = turnStart;
  const firstKept = active[cut];
  if (!firstKept || firstKept.type === "compaction") return false;
  const messagesToSummarize = active.slice(0, cut)
    .filter(entry => entry.type !== "compaction")
    .flatMap(sessionEntryToContextMessages);
  preparation.firstKeptEntryId = firstKept.id;
  preparation.messagesToSummarize = messagesToSummarize;
  preparation.turnPrefixMessages = [];
  preparation.isSplitTurn = false;
  // 单条大型原件或当前题目不能为了满足软预算反复购买无效摘要；保留完整输入继续处理。
  if (!messagesToSummarize.length) return false;
  if (event.reason !== "threshold") return true;
  const visible = compactOverviewMessages(messagesToSummarize).map(message => message.role === "assistant"
    ? {...message, content: message.content.filter(part => part.type !== "thinking")} : message);
  // 旧思考和重复状态不是值得付费归纳的新信息；避免大型受保护回合令每次工具续轮都重新摘要。
  return visible.reduce((sum, message) => sum + estimateTokens(message), 0) >= MIN_ECONOMIC_SUMMARY_TOKENS;
}
