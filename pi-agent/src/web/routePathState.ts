import type {SessionManager} from "@earendil-works/pi-coding-agent";
import type {LearningOverview} from "../learningOverviewTool.js";
import type {TeachingSessionSnapshot} from "../teachingSession.js";
import {teacherVisibility, savedQuestionSnapshot} from "../teacherTurn.js";
import {LEARNER_QUESTIONS_ENTRY} from "../learnerQuestions.js";
import type {LearnerQuestionsSnapshot} from "../learnerQuestionTypes.js";

const ENTRY = "lawa.route-path-state";
export const ROUTE_TRANSITION = "lawa.route-transition";
export function routePathKey(overview: LearningOverview): string {
  return `${(overview.goal_profile as {id?: string} | null)?.id ?? "draft"}:${overview.learning_paths?.active_branch_id ?? "main"}`;
}
export function readRouteState(manager: SessionManager, path: string): TeachingSessionSnapshot | undefined {
  const branch = manager.getBranch();
  const entry = [...branch].reverse().find(e => e.type === "custom" && e.customType === ENTRY &&
    (e.data as {path?: string})?.path === path);
  const saved = entry?.type === "custom" ? structuredClone((entry.data as {teaching: TeachingSessionSnapshot}).teaching) : undefined;
  if (!saved) return undefined;
  const scopes = routeScopes(manager);
  const deliveries = teacherVisibility(manager).deliveries;
  const latest = branch.slice(branch.indexOf(entry!) + 1).findLast(e => {
    if (e.type !== "custom" || !(e.customType === LEARNER_QUESTIONS_ENTRY || deliveries.has(e.id))) return false;
    const scope = scopes.get(e.id);
    return `${scope?.goalId ?? "draft"}:${scope?.branchId ?? "main"}` === path;
  });
  // 崩溃可能发生在发布成功与Store保存路线快照之间；不能用旧路线快照覆盖已发布题卡。
  if (latest?.type === "custom") saved.learner_questions = savedQuestionSnapshot(latest) ?? latest.data as LearnerQuestionsSnapshot;
  return saved;
}
export function saveRouteState(manager: SessionManager, path: string, teaching: TeachingSessionSnapshot): void {
  if (JSON.stringify(readRouteState(manager, path)) !== JSON.stringify(teaching))
    manager.appendCustomEntry(ENTRY, {path, teaching});
}

/** 只派生展示归属；不改写 Pi 记录或模型上下文，也不沿文件顺序串入旧复习的其他祖先链。 */
function routeScopes(manager: SessionManager) {
  const scopes = new Map<string, {goalId: string | null; branchId: string | null}>();
  for (const entry of manager.getEntries()) {
    let scope = entry.parentId ? scopes.get(entry.parentId) : undefined;
    scope ??= {goalId: null, branchId: null};
    if (entry.type === "custom" && entry.customType === "lawa.goal-observation") {
      const owner = (entry.data as {goalId?: string})?.goalId ?? null;
      scope = {goalId: owner, branchId: owner === scope.goalId ? scope.branchId : null};
    }
    if (entry.type === "custom" && entry.customType === ROUTE_TRANSITION) {
      const value = entry.data as {action?: string; branchId?: string; path?: string};
      scope = {...scope, branchId: scope.goalId && value?.action === "enter" && value.branchId &&
        value.path === `${scope.goalId}:${value.branchId}` ? value.branchId : null};
    }
    scopes.set(entry.id, scope);
  }
  return scopes;
}

/** 主线保留建目标前的原对话；旁支只取同目标、同路线的消息。所有组件随其原消息归属。 */
export function routeMessageIds(manager: SessionManager, path: string, entryId?: string): Set<string> {
  const scopes = routeScopes(manager);
  const chain = manager.getBranch(entryId);
  for (let index = 0; index < chain.length; index++) {
    const entry = chain[index]!;
    if (entry.type !== "custom" || entry.customType !== ROUTE_TRANSITION) continue;
    const scope = scopes.get(entry.id)!;
    const {startEntryId} = entry.data as {startEntryId?: string};
    if (!scope.branchId || !startEntryId) continue;
    // 自动切换发生在本轮工具中；整轮归入新分支。只处理所读祖先链上的标记，旧 Pi 分叉互不影响。
    const turn = chain.slice(0, index);
    const start = turn.findIndex(e => e.id === startEntryId && e.type === "message" && e.message.role === "user");
    if (start >= 0 && turn.slice(start).every(e => scopes.get(e.id)?.goalId === scope.goalId))
      for (const e of turn.slice(start)) scopes.set(e.id, scope);
  }
  return new Set(chain.filter(entry => {
    const scope = scopes.get(entry.id);
    return entry.type === "message" && (path.endsWith(":main") ? !scope?.branchId
      : Boolean(scope?.branchId && `${scope.goalId}:${scope.branchId}` === path));
  }).map(entry => entry.id));
}

/** 按每条记录的真实祖先归属定位旁支；进入标记本身也是有效的空记录位置。 */
export function routeBranchRecord(manager: SessionManager, goalId: string, branchId: string): {entryId: string; messageIds: string[]} | null {
  const scopes = routeScopes(manager);
  let entryId: string | undefined;
  for (const entry of manager.getEntries()) {
    const scope = scopes.get(entry.id)!;
    if (scope.goalId === goalId && scope.branchId === branchId) {
      entryId = entry.id;
    }
  }
  if (!entryId) return null;
  // 旧Pi复习仍可能存在其他祖先链；只读取所定位链上的该路线片段，不混入主线或别的Goal。
  return {entryId, messageIds: [...routeMessageIds(manager, `${goalId}:${branchId}`, entryId)]};
}
export function branchHandoff(manager: SessionManager, branchId: string): {handoff: string; assistance_provided: boolean} {
  const entries = manager.getBranch();
  const publications = teacherVisibility(manager);
  const entered = entries.findLast(e => e.type === "custom" && e.customType === ROUTE_TRANSITION &&
    (e.data as {branchId?: string; action?: string})?.branchId === branchId && (e.data as {action?: string}).action === "enter");
  const path = entered?.type === "custom" ? (entered.data as {path?: string}).path : undefined;
  const ids = path ? routeMessageIds(manager, path) : new Set<string>();
  // 小结与记录视图采用同一归属，包含直接补足请求及多次续学，不混入中间的主线聊天。
  const messages = entries.flatMap(e => {
    if (!ids.has(e.id) || e.type !== "message") return [];
    const message = e.message;
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return [];
    if (message.role === "toolResult" && !["record_answer_assessment", "record_teaching_turn"].includes(message.toolName)) return [];
    const raw = typeof message.content === "string" ? message.content : message.content.filter(p => p.type === "text").map(p => p.text).join("\n");
    const content = message.role === "assistant" ? publications.texts.get(e.id) ?? (publications.hidden.has(e.id) ? "" : raw) : raw;
    if (!content.trim()) return [];
    return [{role: message.role, entryId: e.id, text: content.slice(0, 600)}];
  });
  const assistance = messages.some(m => m.role === "assistant");
  return {assistance_provided: assistance,
    handoff: "以下是同一课堂分支中的原记录摘录；教师讲解不等于学习者已做到，普通发言不是正式评价。未出现的行为与未解决的问题保持未知。\n" +
      messages.slice(-8).map(m => `[entry:${m.entryId}] ${m.role === "user" ? "学习者发言/作答" : m.role === "assistant" ? "教师讲解/帮助" : "已保存教学记录"}：${m.text}`).join("\n")};
}
