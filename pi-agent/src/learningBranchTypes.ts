/** A curriculum detour in the same Pi session. It is not a conversation fork. */
export interface LearningBranch {
  id: string; goal_id: string; anchor_kind: "skill" | "milestone"; anchor_id: string;
  purpose: "prerequisite" | "extension"; title: string; reason: string; scope: string; return_condition: string;
  source_ids: string[]; source_goal_ids: string[]; skill_ids: string[]; exclusive_skill_ids: string[]; task_ids: string[];
  status: "PROPOSED" | "READY" | "ACTIVE" | "PAUSED" | "COMPLETED"; revision: number;
  return_task_id: string | null; handoff: string; assistance_provided: boolean;
  last_operation_id?: string | null; last_action?: string | null;
}
export interface LearningPaths {
  active_branch_id: string | null; branches: LearningBranch[]; main_skill_ids: string[];
  main_frontier?: Record<string, unknown> | null;
}
export interface RouteBranchCommand {
  sessionId: string; branchId: string; action: "accept" | "enter" | "return" | "complete";
  operationId: string; expectedRevision: number; goalId: string; taskId: string | null; taskRevision: number;
}
