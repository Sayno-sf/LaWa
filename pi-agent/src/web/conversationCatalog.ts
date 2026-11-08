import { existsSync, mkdirSync, renameSync, writeFileSync, readdirSync, lstatSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";

import { SessionManager, type CustomEntry } from "@earendil-works/pi-coding-agent";
import {routeBranchRecord} from "./routePathState.js";

const GOAL_METADATA = "lawa.goal-observation";
const SESSION_CREATED = "lawa.web-session";
const REVIEW_BRANCH = "lawa.review-branch";
const BRANCH_POSITION = "lawa.branch-position";
const SKILL_ANCHOR = "lawa.skill-anchor";

export interface ConversationSummary {
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

export interface GoalObservation {
  goalId: string | null;
  goalDescription: string;
  observedAt: string;
}

export interface ReviewBranch {
  operationId: string;
  goalId: string;
  skillId: string;
  sourceEntryId: string | null;
  returnEntryId: string | null;
  returnSessionId: string;
  reviewTaskId: string;
  createdAt: string;
}

export class ConversationCatalog {
  readonly directory: string;

  constructor(directory: string, private readonly cwd = process.cwd()) {
    this.directory = resolve(directory);
  }

  create(): SessionManager {
    const manager = SessionManager.create(this.cwd, this.directory);
    // 空对话也必须立刻可见；这里物化 JSONL 后重新打开，避免破坏 Pi 的延迟落盘协议。
    manager.appendCustomEntry(SESSION_CREATED, { surface: "WEB" });
    return this.materialize(manager);
  }

  resumeRecent(): SessionManager {
    const manager = SessionManager.continueRecent(this.cwd, this.directory);
    const file = manager.getSessionFile();
    if (file && existsSync(file)) return manager;
    manager.appendCustomEntry(SESSION_CREATED, { surface: "WEB" });
    return this.materialize(manager);
  }

  private materialize(manager: SessionManager): SessionManager {
    const header = manager.getHeader();
    const file = manager.getSessionFile();
    if (!header || !file) throw new Error("Unable to create a persistent conversation");
    writeFileSync(
      file,
      [header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      { flag: "wx" },
    );
    // Reopening marks the already materialized JSONL as flushed, so Pi safely appends
    // the first real assistant reply instead of attempting a second exclusive create.
    return SessionManager.open(file, this.directory, this.cwd);
  }

  async list(activeSessionId: string | null = null): Promise<ConversationSummary[]> {
    const items = await SessionManager.list(this.cwd, this.directory);
    return items
      .map((item) => {
        const manager = SessionManager.open(item.path, this.directory, this.cwd);
        const goal = this.latestGoalObservation(manager);
        // 最近学习按对话内容或返回课堂的时间排序；重命名等文件写入不应置顶。
        const learningTimes = manager.getEntries().flatMap(entry => {
          if ((entry.type === "message" && ["user", "assistant"].includes(entry.message.role)) ||
              (entry.type === "custom" && entry.customType === BRANCH_POSITION)) {
            const time = Date.parse(entry.timestamp);
            return Number.isFinite(time) ? [time] : [];
          }
          return [];
        });
        const lastLearningAt = learningTimes.length ? Math.max(...learningTimes) : item.created.getTime();
        // SDK目录首消息可能截断自动附件块；展示只保留用户文字，原Pi记录不改写。
        const firstMessage = item.firstMessage.replace(/\[LAWA_MATERIAL_CONTEXT\][\s\S]*?(?:\[\/LAWA_MATERIAL_CONTEXT\]|$)/g, "").trim();
        return {
          id: item.id,
          name: item.name?.trim() || this.defaultName(firstMessage, item.created),
          createdAt: item.created.toISOString(),
          updatedAt: new Date(lastLearningAt).toISOString(),
          messageCount: item.messageCount,
          preview: firstMessage,
          goalId: goal?.goalId ?? null,
          goalDescription: goal?.goalDescription ?? null,
          goalObservedAt: goal?.observedAt ?? null,
          active: item.id === activeSessionId,
        };
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async open(sessionId: string): Promise<SessionManager> {
    // 只能打开 SessionManager.list() 已枚举出的 id，禁止把用户输入直接拼成路径。
    const item = await this.find(sessionId);
    return SessionManager.open(item.path, this.directory, this.cwd);
  }

  async rename(sessionId: string, name: string): Promise<void> {
    const normalized = name.trim();
    if (!normalized || normalized.length > 80) {
      throw new Error("Conversation name must contain 1 to 80 characters");
    }
    const manager = await this.open(sessionId);
    manager.appendSessionInfo(normalized);
  }

  recordGoal(
    manager: SessionManager,
    goalId: string | null,
    goalDescription: string | null,
    force = false,
  ): void {
    if (!goalDescription?.trim()) return;
    const previous = this.latestGoalObservation(manager);
    if (!force && previous?.goalId === goalId && previous.goalDescription === goalDescription) return;
    manager.appendCustomEntry(GOAL_METADATA, {
      goalId,
      goalDescription: goalDescription.trim(),
      observedAt: new Date().toISOString(),
    } satisfies GoalObservation);
  }

  goalObservation(manager: SessionManager): GoalObservation | null {
    // 只暴露 Goal 关联标记，不把会话 JSONL 当成学习事实或状态恢复命令。
    return this.latestGoalObservation(manager);
  }

  goalAtEntry(manager: SessionManager, entryId: string): string | null {
    const marker = [...manager.getBranch(entryId)].reverse().find(entry =>
      entry.type === "custom" && entry.customType === GOAL_METADATA) as CustomEntry<GoalObservation> | undefined;
    return marker?.data?.goalId ?? null;
  }

  goalIds(manager: SessionManager): string[] {
    return [...new Set(manager.getEntries().flatMap(entry => entry.type === "custom" && entry.customType === GOAL_METADATA
      && typeof (entry.data as GoalObservation)?.goalId === "string" ? [(entry.data as GoalObservation).goalId!] : []))];
  }

  selectGoalBranch(manager: SessionManager, goalId: string): void {
    const target = manager.getEntries().filter(entry => {
      const owner = [...manager.getBranch(entry.id)].reverse().find(row => row.type === "custom" && row.customType === GOAL_METADATA) as CustomEntry<GoalObservation> | undefined;
      return owner?.data?.goalId === goalId;
    }).at(-1);
    if (target) {manager.branch(target.id); this.recordPosition(manager);}
  }

  async recycledFiles(): Promise<Array<{id: string; name: string; goalId: string | null; goalIds: string[]; path: string; deletedAt: string}>> {
    const root = join(this.directory, ".trash");
    if (!existsSync(root) || lstatSync(root).isSymbolicLink()) return [];
    const directories = [root];
    for (const name of readdirSync(root)) {
      const path = join(root, name);
      if (/^[a-f0-9]{64}$/.test(name) && lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink()) directories.push(path);
    }
    const rows = [];
    for (const directory of directories) {
      for (const item of await SessionManager.list(this.cwd, directory)) {
        if (lstatSync(item.path).isSymbolicLink()) continue;
        const manager = SessionManager.open(item.path, directory, this.cwd);
        rows.push({id: item.id, name: item.name?.trim() || this.defaultName(item.firstMessage, item.created),
          goalId: this.goalObservation(manager)?.goalId ?? null, goalIds: this.goalIds(manager),
          path: item.path, deletedAt: item.modified.toISOString()});
      }
    }
    return rows;
  }

  async goalFileIds(goalId: string): Promise<string[]> {
    const ids = (await this.recycledFiles()).filter(item => item.goalIds.length === 1 && item.goalIds[0] === goalId).map(item => item.id);
    for (const session of await this.list()) {
      const owners = this.goalIds(await this.open(session.id));
      // 一份旧 Pi 文件可能含多个目标；共享文件保留，禁止整份移动或永久销毁。
      if (owners.length === 1 && owners[0] === goalId) ids.push(session.id);
    }
    return [...new Set(ids)];
  }

  async archiveFiles(key: string, ids: string[]): Promise<void> {
    const directory = join(this.directory, ".trash", createHash("sha256").update(key).digest("hex"));
    mkdirSync(directory, {recursive: true});
    if (lstatSync(directory).isSymbolicLink()) throw new Error("Invalid recycle directory");
    for (const id of ids) {
      const normal = (await SessionManager.list(this.cwd, this.directory)).find(item => item.id === id);
      const item = normal ?? (await this.recycledFiles()).find(item => item.id === id);
      if (!item) continue;
      if (lstatSync(item.path).isSymbolicLink()) throw new Error("Invalid conversation file");
      const target = join(directory, basename(item.path));
      if (target === item.path) continue;
      if (existsSync(target)) throw new Error("Recycle destination already exists");
      renameSync(item.path, target);
    }
  }

  async restoreFiles(ids: string[]): Promise<void> {
    for (const id of ids) {
      if ((await this.list()).some(item => item.id === id)) continue;
      const item = (await this.recycledFiles()).find(row => row.id === id);
      if (!item) throw new Error("Conversation recovery file is missing");
      const target = join(this.directory, basename(item.path));
      if (existsSync(target)) throw new Error("Conversation recovery destination already exists");
      renameSync(item.path, target);
    }
  }

  async purgeFiles(ids: string[]): Promise<void> {
    for (const id of ids) {
      const item = (await this.recycledFiles()).find(row => row.id === id);
      if (item) unlinkSync(item.path);
    }
  }

  async materialReferencesOutside(goalId: string): Promise<Record<string, string>> {
    const references: Record<string, string> = {};
    const files = [...await SessionManager.list(this.cwd, this.directory), ...await this.recycledFiles()];
    for (const file of files) {
      if (lstatSync(file.path).isSymbolicLink()) continue;
      const manager = SessionManager.open(file.path, this.directory, this.cwd);
      const owners = this.goalIds(manager);
      for (const entry of manager.getEntries()) {
        if (entry.type !== "message") continue;
        const observed = [...manager.getBranch(entry.id)].reverse().find(row => row.type === "custom" && row.customType === GOAL_METADATA) as CustomEntry<GoalObservation> | undefined;
        const owner = observed?.data?.goalId ?? (owners.length === 1 ? owners[0] : null);
        if (!owner || owner === goalId) continue;
        // 引用仅用于保守保留原件，不制造学习事实，也不授予任意文件路径的权限。
        for (const materialId of JSON.stringify(entry.message).match(/mat-[a-f0-9]{32}/g) ?? []) references[materialId] ??= owner;
      }
    }
    return references;
  }

  async locateGoal(goalId: string): Promise<{ sessionId: string; entryId: string | null } | null> {
    const sessions = await SessionManager.list(this.cwd, this.directory);
    const candidates: Array<{ sessionId: string; entryId: string; priority: number; modifiedAt: number }> = [];
    for (const session of sessions) {
      const manager = SessionManager.open(session.path, this.directory, this.cwd);
      const entries = manager.getEntries();
      const markers = entries.filter((entry) => entry.type === "custom" && entry.customType === GOAL_METADATA);
      if (!markers.some((entry) => (entry as CustomEntry<GoalObservation>).data?.goalId === goalId)) continue;
      const scoped = entries.filter((entry) => {
        const lastGoal = [...manager.getBranch(entry.id)].reverse().find(
          (item) => item.type === "custom" && item.customType === GOAL_METADATA,
        ) as CustomEntry<GoalObservation> | undefined;
        return lastGoal?.data?.goalId === goalId;
      });
      const final = scoped.at(-1);
      if (!final) continue;
      // 独立目标会话优先于较新的混合会话；后者的旧 Goal 标记只是历史片段。
      const dedicated = markers.every((entry) => (entry as CustomEntry<GoalObservation>).data?.goalId === goalId);
      const active = this.latestGoalObservation(manager)?.goalId === goalId;
      candidates.push({
        sessionId: session.id, entryId: final.id,
        priority: dedicated ? 2 : active ? 1 : 0,
        modifiedAt: session.modified.getTime(),
      });
    }
    candidates.sort((a, b) => b.priority - a.priority || b.modifiedAt - a.modifiedAt);
    const selected = candidates[0];
    return selected ? { sessionId: selected.sessionId, entryId: selected.entryId } : null;
  }

  async locateRouteBranch(goalId: string, branchId: string): Promise<{sessionId: string; entryId: string; messageIds: string[]} | null> {
    const sessions = await SessionManager.list(this.cwd, this.directory);
    for (const session of sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime())) {
      const manager = SessionManager.open(session.path, this.directory, this.cwd);
      const source = routeBranchRecord(manager, goalId, branchId);
      if (source) return {sessionId: session.id, ...source};
    }
    return null;
  }

  async locateSkill(goalId: string, skillId: string): Promise<{ sessionId: string; entryId: string } | null> {
    const sessions = await SessionManager.list(this.cwd, this.directory);
    // 新会话由 Gateway 在完整教学轮次结束时记录锚点；旧会话再从成功教学 Tool Result 回填。
    for (const session of sessions.sort((a, b) => a.created.getTime() - b.created.getTime())) {
      const manager = SessionManager.open(session.path, this.directory, this.cwd);
      const anchor = manager.getEntries().find((entry) => entry.type === "custom" && entry.customType === SKILL_ANCHOR &&
        (entry.data as { goalId?: string; skillId?: string })?.goalId === goalId &&
        (entry.data as { goalId?: string; skillId?: string })?.skillId === skillId);
      const entryId = anchor?.type === "custom" ? (anchor.data as { entryId?: string })?.entryId : null;
      if (entryId && manager.getEntry(entryId)) return { sessionId: session.id, entryId };
    }
    for (const session of sessions.sort((a, b) => a.created.getTime() - b.created.getTime())) {
      const manager = SessionManager.open(session.path, this.directory, this.cwd);
      const entries = manager.getEntries();
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        if (entry?.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "record_teaching_turn" || entry.message.isError) continue;
        const branch = manager.getBranch(entry.id);
        const goal = [...branch].reverse().find((item) => item.type === "custom" && item.customType === GOAL_METADATA) as CustomEntry<GoalObservation> | undefined;
        if (goal?.data?.goalId !== goalId) continue;
        const value = entry.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        try {
          if ((JSON.parse(value) as { active_skill_id?: string }).active_skill_id !== skillId) continue;
        } catch { continue; }
        const later = entries.slice(i + 1).find((item) => {
          if (item.type !== "message" || item.message.role !== "assistant") return false;
          if (!manager.getBranch(item.id).some((ancestor) => ancestor.id === entry.id)) return false;
          return item.message.content.some((part) => part.type === "text" && Boolean(part.text.trim()));
        });
        return { sessionId: session.id, entryId: later?.id ?? entry.id };
      }
    }
    return null;
  }

  recordSkillAnchor(manager: SessionManager, goalId: string, skillId: string): void {
    const existing = manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === SKILL_ANCHOR &&
      (entry.data as { goalId?: string; skillId?: string })?.goalId === goalId &&
      (entry.data as { goalId?: string; skillId?: string })?.skillId === skillId);
    if (existing) return;
    const branch = manager.getBranch();
    const lastUser = branch.findLastIndex((entry) => entry.type === "message" && entry.message.role === "user");
    const assistant = branch.slice(lastUser + 1).findLast((entry) => entry.type === "message" && entry.message.role === "assistant" &&
      entry.message.content.some((part) => part.type === "text" && Boolean(part.text.trim())));
    if (!assistant) return;
    manager.appendCustomEntry(SKILL_ANCHOR, { goalId, skillId, entryId: assistant.id, recordedAt: new Date().toISOString() });
  }

  recordReview(manager: SessionManager, review: ReviewBranch): void {
    manager.appendCustomEntry(REVIEW_BRANCH, review);
  }

  recordPosition(manager: SessionManager): void {
    // Pi 重启后从最后一条 JSONL 恢复 leaf；持久化一次无模型内容的选择。
    manager.appendCustomEntry(BRANCH_POSITION, { selectedAt: new Date().toISOString() });
  }

  async restoreNaturalConversationLeaf(manager: SessionManager): Promise<boolean> {
    const branch = manager.getBranch();
    const lastGoalIndex = branch.findLastIndex((entry) => entry.type === "custom" && entry.customType === GOAL_METADATA);
    if (lastGoalIndex < 0) return false;
    const tail = branch.slice(lastGoalIndex + 1);
    // 只修复旧版 Goal 恢复留下的「目标标记 + 位置标记」空分支；真实教学/复习分支不动。
    if (!tail.length || !tail.every((entry) => entry.type === "custom" && entry.customType === BRANCH_POSITION)) return false;
    const currentGoal = (branch[lastGoalIndex] as CustomEntry<GoalObservation>).data?.goalId;
    const latestMessage = [...manager.getEntries()].reverse().find((entry) =>
      entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"),
    );
    if (!latestMessage) return false;
    const sourceGoal = [...manager.getBranch(latestMessage.id)].reverse().find((entry) =>
      entry.type === "custom" && entry.customType === GOAL_METADATA,
    ) as CustomEntry<GoalObservation> | undefined;
    if (!sourceGoal?.data?.goalId || sourceGoal.data.goalId === currentGoal) return false;
    // 仅当该目标另有专属会话，才把混合会话末尾的空导航分支视为旧版误归属。
    // 没有专属会话时，用户可能正有意停留在这个混合会话的旧目标分支。
    const sessions = await SessionManager.list(this.cwd, this.directory);
    const dedicatedElsewhere = sessions.some((session) => {
      if (session.id === manager.getSessionId()) return false;
      const other = SessionManager.open(session.path, this.directory, this.cwd);
      const markers = other.getEntries().filter((entry) => entry.type === "custom" && entry.customType === GOAL_METADATA);
      return markers.length > 0 && markers.every((entry) => (entry as CustomEntry<GoalObservation>).data?.goalId === currentGoal);
    });
    if (!dedicatedElsewhere) return false;
    manager.branch(latestMessage.id);
    this.recordPosition(manager);
    return true;
  }

  reviewByOperation(manager: SessionManager, operationId: string): ReviewBranch | null {
    for (const entry of [...manager.getEntries()].reverse()) {
      if (entry.type !== "custom" || entry.customType !== REVIEW_BRANCH) continue;
      const value = (entry as CustomEntry<ReviewBranch>).data;
      if (value?.operationId === operationId) return value;
    }
    return null;
  }

  async findReview(reviewTaskId: string): Promise<ReviewBranch | null> {
    const sessions = await SessionManager.list(this.cwd, this.directory);
    for (const session of sessions) {
      const manager = SessionManager.open(session.path, this.directory, this.cwd);
      const review = this.reviewByOperation(manager, reviewTaskId.replace(/^review-/, ""));
      if (review?.reviewTaskId === reviewTaskId) return review;
    }
    return null;
  }

  currentReview(manager: SessionManager): ReviewBranch | null {
    for (const entry of [...manager.getBranch()].reverse()) {
      if (entry.type !== "custom" || entry.customType !== REVIEW_BRANCH) continue;
      return (entry as CustomEntry<ReviewBranch>).data ?? null;
    }
    return null;
  }

  reviewTip(manager: SessionManager, entryId: string): string {
    const marker = manager.getEntry(entryId);
    if (marker?.type !== "custom" || marker.customType !== REVIEW_BRANCH) return entryId;
    const operationId = (marker as CustomEntry<ReviewBranch>).data?.operationId;
    if (!operationId) return entryId;
    // 只取同一次复习的最后消息，避免另一复习/返回位置的追加记录混入历史。
    for (const entry of [...manager.getEntries()].reverse()) {
      if (entry.type !== "message" || !["assistant", "user"].includes(entry.message.role)) continue;
      const review = [...manager.getBranch(entry.id)].reverse().find((ancestor) => ancestor.type === "custom" && ancestor.customType === REVIEW_BRANCH) as CustomEntry<ReviewBranch> | undefined;
      if (review?.data?.operationId === operationId) return entry.id;
    }
    return entryId;
  }

  branches(manager: SessionManager, goalId?: string | null): Array<{ label: string; entryId: string; skillId: string }> {
    const reviews = manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === REVIEW_BRANCH &&
      (goalId === undefined || (entry.data as ReviewBranch)?.goalId === goalId));
    const originals = new Map<string, string>();
    const counts = new Map<string, number>();
    const branches = reviews.map((entry) => {
      const review = (entry as CustomEntry<ReviewBranch>).data;
      const skillId = review?.skillId ?? "";
      if (review?.sourceEntryId && !originals.has(skillId)) originals.set(skillId, review.sourceEntryId);
      const count = (counts.get(skillId) ?? 0) + 1;
      counts.set(skillId, count);
      return {
      label: `复习 ${count}`,
      entryId: entry.id,
      skillId,
    }; });
    return [
      ...[...originals].map(([skillId, entryId]) => ({ label: "首次学习", entryId, skillId })),
      ...branches,
    ];
  }

  async trash(sessionId: string): Promise<void> {
    const item = await this.find(sessionId);
    const trashDirectory = join(this.directory, ".trash");
    mkdirSync(trashDirectory, { recursive: true });
    const originalName = basename(item.path);
    let target = join(trashDirectory, originalName);
    if (existsSync(target)) {
      target = join(
        trashDirectory,
        `${originalName.replace(/\.jsonl$/i, "")}-${Date.now()}.jsonl`,
      );
    }
    renameSync(item.path, target);
  }

  private async find(sessionId: string) {
    const items = await SessionManager.list(this.cwd, this.directory);
    const item = items.find((candidate) => candidate.id === sessionId);
    if (!item) throw new Error("Conversation session not found");
    return item;
  }

  private latestGoalObservation(manager: SessionManager): GoalObservation | null {
    const entries = manager.getBranch();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.type !== "custom" || entry.customType !== GOAL_METADATA) continue;
      const data = (entry as CustomEntry<unknown>).data;
      if (typeof data !== "object" || data === null) return null;
      const item = data as Record<string, unknown>;
      if (
        (typeof item.goalId === "string" || item.goalId === null) &&
        typeof item.goalDescription === "string" &&
        typeof item.observedAt === "string"
      ) {
        return item as unknown as GoalObservation;
      }
      return null;
    }
    return null;
  }

  private defaultName(firstMessage: string, created: Date): string {
    const compact = firstMessage.replace(/\s+/g, " ").trim();
    if (compact && compact !== "(no messages)") return compact.slice(0, 36);
    return `新对话 · ${created.toLocaleString("zh-CN", { hour12: false })}`;
  }
}
