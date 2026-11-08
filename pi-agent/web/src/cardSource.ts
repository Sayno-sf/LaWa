export interface CardReference { goalId: string; skillId: string; cardId: string }
interface Card { id: string; skill_id: string }
interface Skill { id: string; name: string }
interface Project<S extends Skill, C extends Card> {
  goal_profile: { id: string; goal_description: string };
  skills: S[];
  knowledge_cards: C[];
}

/** 浏览来源是 UI 意图，不是教学状态；所有关联使用 ID，不从当前任务或标题猜来源。 */
export function resolveCardSource<S extends Skill, C extends Card>(
  projects: Project<S, C>[], reference: CardReference,
): { project: Project<S, C>; skill: S; card: C } | null {
  const project = projects.find(item => item.goal_profile.id === reference.goalId);
  const skill = project?.skills.find(item => item.id === reference.skillId);
  const card = project?.knowledge_cards.find(item => item.id === reference.cardId && item.skill_id === reference.skillId);
  return project && skill && card ? {project, skill, card} : null;
}

export class CardSourceNavigation {
  reference: CardReference | null = null;
  phase: "loading" | "ready" | "unavailable" = "loading";
  error = "";
  private revision = 0;

  begin(reference: CardReference): number {
    this.reference = reference;
    this.phase = "loading";
    this.error = "";
    return ++this.revision;
  }
  finish(revision: number, available: boolean, error = ""): boolean {
    if (revision !== this.revision || !this.reference) return false;
    this.phase = available ? "ready" : "unavailable";
    this.error = error;
    return true;
  }
  clear(): void { this.revision++; this.reference = null; }
}
