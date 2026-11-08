import type { LearningOverview } from "../learningOverviewTool.js";

export interface LearningLibraryProject {
  status: "CURRENT" | "ARCHIVED";
  goal_profile: NonNullable<LearningOverview["goal_profile"]>;
  curriculum_spine: LearningOverview["curriculum_spine"];
  skills: LearningOverview["skills"];
  evidence: LearningOverview["recent_evidence"];
  knowledge_cards?: unknown[];
  /** Workspace snapshot time, not first archive or learning time; null for CURRENT. */
  archived_at: string | null;
}

export interface LearningLibrary {
  /** Kernel order: current first, then reverse history insertion; not date order. */
  projects: LearningLibraryProject[];
}

export async function fetchLearningLibrary(options: {
  baseUrl?: string;
} = {}): Promise<LearningLibrary> {
  const baseUrl = options.baseUrl ?? process.env.LEARNING_API_BASE_URL ?? "http://127.0.0.1:8000";
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/learning/library`);
  if (!response.ok) {
    throw new Error(`Learning API returned HTTP ${response.status}`);
  }
  const body = await response.json() as Partial<LearningLibrary>;
  if (!Array.isArray(body.projects)) {
    throw new Error("Learning API returned an invalid learning library");
  }
  return { projects: body.projects as LearningLibraryProject[] };
}
