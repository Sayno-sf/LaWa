interface GoalCards {
  known: Set<string>;
  unread: Set<string>;
}

/** 只记录浏览器展示状态；首次观察建立旧卡基线，不推导学习掌握度。 */
export class KnowledgeCardNotice {
  private readonly goals = new Map<string, GoalCards>();

  constructor(saved: string | null = null) {
    try {
      const data = JSON.parse(saved ?? "null");
      if (data?.version !== 1 || !Array.isArray(data.goals)) return;
      for (const entry of data.goals.slice(-32)) {
        if (!Array.isArray(entry) || entry.length !== 3) continue;
        const [goal, known, unread] = entry;
        if (typeof goal !== "string" || !Array.isArray(known) || !Array.isArray(unread) ||
          ![...known, ...unread].every((id) => typeof id === "string")) continue;
        this.goals.set(goal, { known: new Set(known), unread: new Set(unread.filter((id) => known.includes(id))) });
      }
    } catch { /* 损坏或旧版偏好按首次使用处理，不影响学习。 */ }
  }

  observe(goal: string, ids: readonly string[], fromTeacher = false): void {
    const previous = this.goals.get(goal);
    const known = new Set(ids);
    const unread = new Set(previous?.unread ?? []);
    // 恢复历史快照以旧卡为基线；当前教学流第一次带来新 Goal 的卡片仍要提示。
    if (previous || fromTeacher) for (const id of known) if (!previous?.known.has(id)) unread.add(id);
    // 删除的卡片不留下无法消除的提示；编辑、笔记和自评沿用同一 ID。
    for (const id of unread) if (!known.has(id)) unread.delete(id);
    this.goals.delete(goal);
    this.goals.set(goal, { known, unread });
    if (this.goals.size > 32) this.goals.delete(this.goals.keys().next().value!);
  }

  markViewed(goal: string, visibleIds: readonly string[]): void {
    const cards = this.goals.get(goal);
    for (const id of visibleIds) cards?.unread.delete(id);
  }

  count(goal: string, visibleIds: readonly string[]): number {
    const unread = this.goals.get(goal)?.unread;
    return new Set(visibleIds.filter((id) => unread?.has(id))).size;
  }

  serialize(): string {
    return JSON.stringify({ version: 1, goals: [...this.goals].map(([goal, cards]) =>
      [goal, [...cards.known], [...cards.unread]]) });
  }
}
