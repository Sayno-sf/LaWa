import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { projectLearningContext } from "./modelLearningContext.js";

export interface LearningOverview {
  learning_paths?: import("./learningBranchTypes.js").LearningPaths;
  imported_goal_needs_route?: boolean;
  imported_topics?: {goal_id: string; groups: Array<{id: string; name: string; skill_ids: string[]}>} | null;
  imported_learning?: {goal_id: string; topics: string[]; self_reports: number; samples: number; reviewed: number; instruction: string} | null;
  practice_context?: {due_reviews?: unknown[]; topics?: unknown[]; topic_count?: number; assessment_count?: number};
  recycled_goal_ids?: string[];
  plan_revision?: number;
  current_goal: string | null;
  goal_profile: unknown | null;
  curriculum_spine: unknown[];
  current_frontier: unknown | null;
  current_focus: unknown | null;
  skills: unknown[];
  recent_evidence: unknown[];
  active_task: unknown | null;
  learning_history: unknown[];
  current_goal_skill_ids: string[];
  knowledge_cards?: unknown[];
}

export interface LearningOverviewToolOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  timeoutMs?: number;
  teachingPreferencesRevision?: () => string | undefined;
}

function isLearningOverview(value: unknown): value is LearningOverview {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    (typeof item.current_goal === "string" || item.current_goal === null) &&
    Array.isArray(item.curriculum_spine) &&
    "goal_profile" in item &&
    "current_frontier" in item &&
    Array.isArray(item.skills) &&
    Array.isArray(item.recent_evidence) &&
    "current_focus" in item &&
    "active_task" in item &&
    Array.isArray(item.learning_history) &&
    Array.isArray(item.current_goal_skill_ids) &&
    item.current_goal_skill_ids.every((skillId) => typeof skillId === "string")
  );
}

function invalidOverviewFields(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return ["overview object"];
  const item = value as Record<string, unknown>;
  const invalid: string[] = [];
  if (!("goal_profile" in item)) invalid.push("goal_profile");
  if (!Array.isArray(item.curriculum_spine)) invalid.push("curriculum_spine");
  if (!("current_frontier" in item)) invalid.push("current_frontier");
  if (!(typeof item.current_goal === "string" || item.current_goal === null)) {
    invalid.push("current_goal");
  }
  if ("plan_revision" in item && (!Number.isInteger(item.plan_revision) || Number(item.plan_revision) < 0)) {
    invalid.push("plan_revision");
  }
  if (!("current_focus" in item)) invalid.push("current_focus");
  if (!Array.isArray(item.skills)) invalid.push("skills");
  if (!Array.isArray(item.recent_evidence)) invalid.push("recent_evidence");
  if (!("active_task" in item)) invalid.push("active_task");
  if (!Array.isArray(item.learning_history)) invalid.push("learning_history");
  if (
    !Array.isArray(item.current_goal_skill_ids) ||
    !item.current_goal_skill_ids.every((skillId) => typeof skillId === "string")
  ) {
    invalid.push("current_goal_skill_ids");
  }
  return invalid;
}

export async function fetchLearningOverview(
  options: LearningOverviewToolOptions = {},
  signal?: AbortSignal,
): Promise<LearningOverview> {
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? ((message: string) => console.error(message));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const url = `${baseUrl}/api/learning/overview`;
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  log(`[tool:http] GET ${url}`);
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    signal: requestSignal,
  });
  if (!response.ok) {
    throw new Error(`Learning API returned HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!isLearningOverview(payload)) {
    const fields = invalidOverviewFields(payload).join(", ");
    throw new Error(
      `Learning API returned an invalid overview payload; missing or invalid fields: ${fields}. ` +
        "This usually means an older API process is still running; restart the Python Learning API.",
    );
  }
  log(
    `[tool:http] overview received: skills=${payload.skills.length}, evidence=${payload.recent_evidence.length}`,
  );
  return payload;
}

export function createGetLearningOverviewTool(
  options: LearningOverviewToolOptions = {},
) {
  return defineTool({
    name: "get_learning_overview",
    label: "Get Learning Overview",
    description:
      "Read bounded current-Goal state only. Default scope=current returns goal preferences, active task, frontier and relevant skill metadata, never archived goals, Evidence text or card bodies. The system already refreshes current state before each model call; do not call merely to recheck it. Use scope=route with offset/limit (default 10, max 20) only when the full current route is needed; follow page.next_offset until the required portion is read. Omitted/truncated fields are not complete facts. For concrete Evidence, assistance, cards and notes use get_skill_learning_context(skill_id,limit). A null current_goal means onboarding is required. Raw IDs/enums/counts are internal; ordinary replies describe concrete verified behavior and actual assistance, not overview checks or mastery inferred from counts. Technical details are appropriate when requested.",
    parameters: Type.Object({
      scope: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("route")])),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    execute: async (_toolCallId, params, signal) => {
      const overview = await fetchLearningOverview(options, signal);
      // HTTP/UI 保留完整 schema；只有发给模型的工具正文收紧，详细表现走独立 Skill 查询。
      return {
        content: [{ type: "text" as const, text: JSON.stringify(projectLearningContext(overview, params)) }],
        details: {
          currentGoal: overview.current_goal,
          skillCount: overview.skills.length,
          evidenceCount: overview.recent_evidence.length,
        },
      };
    },
  });
}
