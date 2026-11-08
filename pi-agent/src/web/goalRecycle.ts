import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ConversationCatalog } from "./conversationCatalog.js";

export interface RecycleItem {
  id: string;
  kind: "goal" | "draft" | "chat";
  targetId: string;
  name: string;
  deletedAt: string;
  sessionIds: string[];
  phase: "deleting" | "deleted" | "restoring" | "purging";
}
export interface KernelRecycle {
  goals: Array<{goal_id: string; name: string; deleted_at: string; skill_count: number; evidence_count: number; purge_started?: boolean}>;
  drafts: string[];
}
export type KernelRequest = (path: string, method?: string, body?: object) => Promise<unknown>;

// Kernel 标记和 Pi 文件属于不同存储：先写操作日志，重启重放同一步骤。
// 日志只有身份/阶段，不存聊天或学习事实；任何失败都保留可重试的回收项。
export class GoalRecycle {
  private readonly path: string;
  private queue = Promise.resolve();
  constructor(private catalog: ConversationCatalog, private kernel: KernelRequest,
    private scopeChanged: (scope: string, deleted: boolean) => void = () => undefined,
    private scopePurged: (goalId: string) => Promise<void> = async () => undefined,
    private relatedLifecycle: (item: RecycleItem) => Promise<void> = async () => undefined) {
    this.path = join(catalog.directory, ".trash", "recycle.json");
  }
  private async read(): Promise<RecycleItem[]> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      if (!Array.isArray(value) || value.some(item => !item || !["goal", "draft", "chat"].includes(item.kind)
        || !["deleting", "deleted", "restoring", "purging"].includes(item.phase) || typeof item.targetId !== "string"
        || typeof item.id !== "string" || !Array.isArray(item.sessionIds) || item.sessionIds.some((id: unknown) => typeof id !== "string"))) {
        throw new Error("回收记录损坏，请保留原文件并检查备份。");
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  private async save(items: RecycleItem[]): Promise<void> {
    await mkdir(join(this.catalog.directory, ".trash"), {recursive: true});
    const temporary = this.path + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(items), {mode: 0o600});
    await rename(temporary, this.path);
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const work = this.queue.then(run);
    this.queue = work.then(() => undefined, () => undefined);
    return work;
  }
  private async execute(item: RecycleItem, all: RecycleItem[]): Promise<void> {
    const encoded = encodeURIComponent(item.targetId);
    const goal = `/api/user/recycle/goals/${encoded}`;
    const draft = `/api/user/recycle/drafts/${encoded}`;
    const scope = item.kind === "goal" ? item.targetId : "draft:" + item.targetId;
    if (item.phase === "deleting") {
      if (item.kind === "goal") await this.kernel(`/api/user/goals/${encoded}`, "DELETE");
      if (item.kind === "draft") await this.kernel(`${draft}/delete`, "POST");
      if (item.kind !== "chat") this.scopeChanged(scope, true);
      await this.catalog.archiveFiles(item.id, item.sessionIds);
      // 助教原文和帮助记录与主会话一同回收；成功后才推进可重放的操作日志。
      await this.relatedLifecycle(item);
      item.phase = "deleted";
    } else if (item.phase === "restoring") {
      // 文件先回到原位、再解除 Kernel 标记；中断时内容仍不可教学或检索。
      await this.catalog.restoreFiles(item.sessionIds);
      await this.relatedLifecycle(item);
      if (item.kind === "goal") await this.kernel(`${goal}/restore`, "POST");
      if (item.kind === "draft") await this.kernel(`${draft}/restore`, "POST");
      if (item.kind !== "chat") this.scopeChanged(scope, false);
      all.splice(all.indexOf(item), 1);
    } else if (item.phase === "purging") {
      await this.catalog.archiveFiles(item.id, item.sessionIds);
      await this.catalog.purgeFiles(item.sessionIds);
      try {
        if (item.kind === "goal") await this.kernel(goal, "DELETE", {material_references: await this.catalog.materialReferencesOutside(item.targetId)});
        if (item.kind === "draft") await this.kernel(`${draft}/purge`, "POST");
      } catch (error) {
        // 若上次 Kernel 已完成但 Node 保存前中断，404 表示可完成这次重放。
        if ((error as {statusCode?: number}).statusCode !== 404) throw error;
      }
      // 计时等独立派生记录成功清理后才完成日志；中断重放不会留下已删除Goal的数据。
      if (item.kind === "goal") await this.scopePurged(item.targetId);
      await this.relatedLifecycle(item);
      all.splice(all.indexOf(item), 1);
    }
    await this.save(all);
  }
  async recover(): Promise<void> {
    return this.serial(async () => {
      const all = await this.read();
      for (const item of [...all]) if (item.phase !== "deleted") {
        // 单项跨存储清理失败留在回收区重试，不阻断其他课堂/正常对话读取。
        // 操作日志读取损坏仍向上抛出；不能把损坏日志当空库继续写。
        try {await this.execute(item, all);} catch { /* 持久阶段保留，用户可在回收区重试。 */ }
      }
    });
  }
  async recycle(kind: RecycleItem["kind"], targetId: string, name: string, sessionIds?: string[]): Promise<void> {
    return this.serial(async () => {
      const all = await this.read();
      let item = all.find(row => row.kind === kind && row.targetId === targetId);
      if (!item) {
        item = {id: randomUUID(), kind, targetId, name, deletedAt: new Date().toISOString(),
          sessionIds: sessionIds ?? await this.catalog.goalFileIds(targetId), phase: "deleting"};
        all.push(item);
        await this.save(all);
      }
      await this.execute(item, all);
    });
  }
  async list(): Promise<RecycleItem[]> {
    const all = await this.read();
    const kernel = await this.kernel("/api/user/recycle", "GET") as KernelRecycle;
    // API 直接回收的目标和旧版 .trash 聊天也能显示，不自动删除其关联目标。
    for (const goal of kernel.goals) if (!all.some(item => item.kind === "goal" && item.targetId === goal.goal_id)) {
      all.push({id: "goal:" + goal.goal_id, kind: "goal", targetId: goal.goal_id, name: goal.name,
        deletedAt: goal.deleted_at, sessionIds: await this.catalog.goalFileIds(goal.goal_id), phase: goal.purge_started ? "purging" : "deleted"});
    }
    const covered = new Set(all.flatMap(item => item.sessionIds));
    for (const file of await this.catalog.recycledFiles()) if (!covered.has(file.id)) {
      const isDraft = kernel.drafts.includes("draft:" + file.id);
      all.push({id: "chat:" + file.id, kind: isDraft ? "draft" : "chat", targetId: file.id,
        name: file.name, deletedAt: file.deletedAt, sessionIds: [file.id], phase: "deleted"});
    }
    return all.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }
  async act(id: string, action: "restore" | "purge"): Promise<RecycleItem> {
    return this.serial(async () => {
      const item = (await this.list()).find(row => row.id === id);
      if (!item) throw Object.assign(new Error("回收项不存在或已经处理。"), {statusCode: 404});
      const all = await this.read();
      const previous = all.find(row => row.id === id);
      const selected = previous ?? item;
      if (selected.phase === "purging" && action === "restore") throw new Error("永久删除已开始，请重试永久删除以完成剩余处理。");
      if (!previous) all.push(selected);
      selected.phase = action === "restore" ? "restoring" : "purging";
      await this.save(all);
      await this.execute(selected, all);
      return selected;
    });
  }
}
