import {createHash} from "node:crypto";
import type {MaterialReadingRuntime} from "../materialReadingRuntime.js";
import {normalizeLearningDomain, type GoalProfileInput} from "./planningTypes.js";

export function planningHash(value: unknown): string {
  const sorted = (item: any): any => Array.isArray(item) ? item.map(sorted) : item && typeof item === "object"
    ? Object.fromEntries(Object.keys(item).sort()
      .filter(key => key !== "learning_domain" || normalizeLearningDomain(item[key]) !== "")
      .map(key => [key, key === "learning_domain" ? normalizeLearningDomain(item[key]) : sorted(item[key])])) : item;
  return createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex");
}
export interface PlanningReadingReference {id: string; session_id: string; user_entry_id: string; profile_hash: string;
  materials: Array<{id: string; name: string}>; primary_material_id?: string}
export interface PlanningReadingOrigin {sessionId: string; userEntryId: string}

/** 原请求来自当前真实Pi用户entry，模型只声明资料用途，不能填写会话/分支/授权token。 */
export class PlanningReadingCoordinator {
  constructor(private readonly reading: MaterialReadingRuntime, private readonly origin: () => PlanningReadingOrigin) {}
  async prepare(profile: GoalProfileInput, ids: string[], primary?: string, signal?: AbortSignal): Promise<PlanningReadingReference> {
    const origin = this.origin(), scope = "draft:" + origin.sessionId;
    const profileHash = planningHash(profile);
    const id = planningHash({origin, profileHash, ids, primary: primary ?? null});
    await this.reading.client.request(`material-planning/${encodeURIComponent(origin.sessionId)}/requirements`, scope,
      {request_id: id, user_entry_id: origin.userEntryId, goal_id: profile.id, goal_profile_hash: profileHash,
        material_ids: ids, primary_material_id: primary ?? null}, signal);
    const materials: PlanningReadingReference["materials"] = [];
    for (const sourceId of ids) {
      const meta = await this.reading.client.metadata(sourceId, scope, signal);
      materials.push({id: sourceId, name: typeof meta.name === "string" ? meta.name : sourceId});
      await this.reading.enqueue(sourceId, scope, "basis", signal);
    }
    signal?.throwIfAborted();
    if (planningHash(this.origin()) !== planningHash(origin)) throw new Error("PLANNING_ORIGIN_CHANGED");
    return {id, session_id: origin.sessionId, user_entry_id: origin.userEntryId, profile_hash: profileHash,
      materials, ...(primary ? {primary_material_id: primary} : {})};
  }
}
