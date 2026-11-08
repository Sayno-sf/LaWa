import {readFileSync} from "node:fs";
import type {SessionManager, SessionEntry} from "@earendil-works/pi-coding-agent";
import {branchSource, proveHandoffBranch, type BranchSource} from "../assistantHandoff.js";
import {learningStartSignature} from "../learnerQuestions.js";
import type {LearningOverview} from "../learningOverviewTool.js";
import type {GoalOnboardingSnapshot} from "./goalOnboarding.js";
import {planningHash} from "./planningReading.js";
import type {InitializeLearningGoalInput} from "./planningTypes.js";

export const PLANNING_WAIT_ENTRY = "lawa.planning-reading-wait";
export const PLANNING_READY_MESSAGE = "lawa.planning-reading-ready";
export const PLANNING_RESUME_CORRECTION = "lawa.planning-reading-resume-correction";
export type PlanningWaitState = "WAITING" | "RUNNING" | "COMPLETED" | "CANCELED" | "FAILED";
export interface PlanningWait {
  version: 1; id: string; state: PlanningWaitState; sessionId: string;
  snapshot: GoalOnboardingSnapshot; source: BranchSource;
  confirmationUserId: string; latestUserId: string; kernelSignature: string; kernelGoalId: string | null;
  reason?: string;
}
export interface PlanningWaitRecord {entryId: string; initialEntryId: string; data: PlanningWait}
export interface PlanningResumeInput {waiterId: string; requirementId: string}
const badWrites = new WeakMap<SessionManager, Set<string>>();
const text = (message: {content?: unknown}) => typeof message.content === "string" ? message.content : Array.isArray(message.content)
  ? message.content.filter(part => part?.type === "text").map(part => part.text).join("\n") : "";

function validWait(value: unknown, sessionId: string): value is PlanningWait {
  const data = value as PlanningWait | undefined, snapshot = data?.snapshot, reference = snapshot?.reading_requirement;
  return !!(data && data.version === 1 && data.sessionId === sessionId && /^[a-f0-9]{64}$/.test(data.id)
    && ["WAITING", "RUNNING", "COMPLETED", "CANCELED", "FAILED"].includes(data.state)
    && snapshot?.status === "CONFIRMED" && snapshot.pending_profile && typeof snapshot.replace_existing === "boolean"
    && reference && reference.session_id === sessionId && /^[a-f0-9]{64}$/.test(reference.id)
    && reference.profile_hash === planningHash(snapshot.pending_profile)
    && Array.isArray(reference.materials) && reference.materials.every(source => /^mat-[a-f0-9]{32}$/.test(source.id))
    && data.source?.sessionId === sessionId && typeof data.source.leafId === "string" && typeof data.source.fingerprint === "string"
    && typeof data.confirmationUserId === "string" && typeof data.latestUserId === "string" && typeof data.kernelSignature === "string");
}

/** 只追加原分支机器元数据；落盘失败不能用未保存的内存WAITING授权自动运行。 */
function append(manager: SessionManager, data: PlanningWait): string {
  let id: string | undefined;
  try {
    id = manager.appendCustomEntry(PLANNING_WAIT_ENTRY, data);
    const file = manager.getSessionFile();
    if (file) {
      const actual = manager.getEntry(id);
      const saved = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).find(entry => entry.id === id);
      if (JSON.stringify(saved) !== JSON.stringify(actual)) throw new Error("PLANNING_WAIT_NOT_SAVED");
    }
  } catch {
    const leaf = manager.getLeafEntry();
    if (!id && leaf?.type === "custom" && leaf.customType === PLANNING_WAIT_ENTRY && (leaf.data as PlanningWait)?.id === data.id) id = leaf.id;
    if (!badWrites.has(manager)) badWrites.set(manager, new Set());
    if (id) badWrites.get(manager)!.add(id);
    throw new Error("PLANNING_WAIT_NOT_SAVED");
  }
  return id!;
}

export function latestPlanningWait(manager: SessionManager): PlanningWaitRecord | null {
  const branch = manager.getBranch();
  const entry = branch.findLast(item => item.type === "custom" && item.customType === PLANNING_WAIT_ENTRY);
  if (!entry || entry.type !== "custom") return null;
  if (badWrites.get(manager)?.has(entry.id) || !validWait(entry.data, manager.getSessionId())) throw new Error("PLANNING_WAIT_STORAGE_INVALID");
  const data = entry.data;
  const initial = branch.find(item => item.type === "custom" && item.customType === PLANNING_WAIT_ENTRY
    && (item.data as PlanningWait)?.id === data.id && (item.data as PlanningWait)?.state === "WAITING");
  if (!initial || initial.parentId !== data.source.leafId) throw new Error("PLANNING_WAIT_STORAGE_INVALID");
  return {entryId: entry.id, initialEntryId: initial.id, data};
}

function confirmedResult(manager: SessionManager, snapshot: GoalOnboardingSnapshot): SessionEntry | undefined {
  const entry = manager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "toolResult"
    && !entry.message.isError && entry.message.toolName === "record_goal_understanding");
  if (entry?.type === "message" && entry.message.role === "toolResult") {
    try {
      const saved = JSON.parse(text(entry.message)) as GoalOnboardingSnapshot;
      if (saved.status === "CONFIRMED" && planningHash(saved) === planningHash(snapshot)) return entry;
    } catch { /* 未知成功记录不能回落到更早的确认。 */ }
  }
  return undefined;
}

export function capturePlanningWait(manager: SessionManager, snapshot: GoalOnboardingSnapshot, overview: LearningOverview): PlanningWaitRecord | null {
  if (snapshot.status !== "CONFIRMED" || !snapshot.reading_requirement || !snapshot.pending_profile) return null;
  const confirmation = confirmedResult(manager, snapshot);
  const source = branchSource(manager), branch = manager.getBranch();
  const latestUser = branch.findLast(entry => entry.type === "message" && entry.message.role === "user");
  const originUser = branch.find(entry => entry.id === snapshot.reading_requirement!.user_entry_id && entry.type === "message" && entry.message.role === "user");
  const confirmationUser = confirmation && manager.getBranch(confirmation.id).findLast(entry => entry.type === "message" && entry.message.role === "user");
  if (!source || !originUser || !latestUser || !confirmationUser || confirmationUser.id === originUser.id) return null;
  const data: PlanningWait = {version: 1, id: planningHash({request: snapshot.reading_requirement.id, source, confirmation: confirmationUser.id}),
    state: "WAITING", sessionId: manager.getSessionId(), snapshot: structuredClone(snapshot), source,
    confirmationUserId: confirmationUser.id, latestUserId: latestUser.id, kernelSignature: learningStartSignature(overview),
    kernelGoalId: (overview.goal_profile as {id?: string} | null)?.id ?? null};
  append(manager, data);
  return latestPlanningWait(manager);
}

export function provePlanningWait(manager: SessionManager, record: PlanningWaitRecord): boolean {
  const {data} = record, branch = manager.getBranch();
  if (!validWait(data, manager.getSessionId()) || !confirmedResult(manager, data.snapshot)) return false;
  if (branch.findLast(entry => entry.type === "message" && entry.message.role === "user")?.id !== data.latestUserId) return false;
  if (!branch.some(entry => entry.id === data.confirmationUserId && entry.type === "message" && entry.message.role === "user")
      || !branch.some(entry => entry.id === data.snapshot.reading_requirement!.user_entry_id && entry.type === "message" && entry.message.role === "user")) return false;
  if (proveHandoffBranch(manager, {...data.source, continuationId: record.initialEntryId}) !== "pending") return false;
  if (branch.slice(branch.findIndex(entry => entry.id === record.initialEntryId) + 1)
      .some(entry => entry.type === "custom" && entry.customType === "lawa.goal-onboarding-started")) return false;
  if (data.state === "WAITING") {
    const after = branch.slice(branch.findIndex(entry => entry.id === record.initialEntryId) + 1);
    if (after.some(entry => ["message", "custom_message", "compaction", "branch_summary"].includes(entry.type))) return false;
  }
  return true;
}

export function transitionPlanningWait(manager: SessionManager, record: PlanningWaitRecord, state: PlanningWaitState, reason?: string): PlanningWaitRecord {
  const current = latestPlanningWait(manager);
  if (!current || current.entryId !== record.entryId) throw new Error("PLANNING_WAIT_CHANGED");
  append(manager, {...record.data, state, ...(reason ? {reason} : {})});
  return latestPlanningWait(manager)!;
}

/** Kernel已显示目标时，只重试原分支真实初始化参数以补回执，不另请模型生成另一份路线。 */
export function planningInitializeAttempts(manager: SessionManager, record: PlanningWaitRecord): InitializeLearningGoalInput[] {
  const attempts: InitializeLearningGoalInput[] = [];
  for (const entry of [...manager.getBranch()].reverse()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const part of entry.message.content) {
      if (part.type !== "toolCall" || part.name !== "initialize_learning_goal") continue;
      const input = part.arguments as unknown as InitializeLearningGoalInput;
      if (input?.goal_profile && planningHash(input.goal_profile) === record.data.snapshot.reading_requirement?.profile_hash)
        attempts.push({goal_profile: input.goal_profile, curriculum_spine: input.curriculum_spine,
          frontier_skills: input.frontier_skills, frontier: input.frontier, replace_existing: record.data.snapshot.replace_existing});
      if (attempts.length >= 3) return attempts;
    }
  }
  return attempts;
}

/** SDK把custom message投影成user；只剔除真实custom来源的精确投影，不按用户可伪造的正文标记过滤。 */
export function projectPlanningMachineMessages<T extends {role: string; content?: unknown; timestamp?: number}>(messages: readonly T[],
  raw: readonly {role: string; content?: unknown; timestamp?: number; customType?: string}[], otherMachineTypes: readonly string[] = []): T[] {
  const key = (item: {content?: unknown; timestamp?: number}) => JSON.stringify([item.timestamp, text(item)]);
  const machines = new Set(raw.filter(item => item.role === "custom" &&
    [PLANNING_READY_MESSAGE, PLANNING_RESUME_CORRECTION, ...otherMachineTypes].includes(item.customType ?? "")).map(key));
  const humans = new Set(raw.filter(item => item.role === "user").map(key));
  if ([...machines].some(signature => humans.has(signature))) throw new Error("PLANNING_MACHINE_SOURCE_AMBIGUOUS");
  return messages.filter(message => message.role !== "user" || !machines.has(key(message)) || humans.has(key(message)));
}
