/** Browser-safe scene protocol. Teaching facts remain Kernel-owned. */
export type AnimationRecipe = "linear_balance" | "call_stack";
export interface LinearBalanceState { equation: [number, number, number, number]; operation: "start" | "subtract" | "divide" | "hold"; operand: number }
export interface CallStackState { frames: number[]; return_value: number | null; phase: "call" | "base" | "return" | "done" }
export type AnimationState = LinearBalanceState | CallStackState;
export interface AnimationScene { id: string; caption: string; why: string; duration_s: number; state: AnimationState }
export interface AnimationBranch { caption: string; why: string; replay_scene: string }
export interface AnimationLesson {
  schema_version: "lawa.lesson.v1"; decision: "animate"; recipe: AnimationRecipe;
  title: string; target: string; prerequisites: string[]; assumptions: string[];
  parameters: {variable: "x"; original: [number, number, number, number]} | {function: "factorial"; n: number};
  scenes: AnimationScene[];
  checkpoint: {after_scene: string; prompt: string; metric: "solution" | "final_return"; options: Array<{id: string; value: number}>; branches: {correct: AnimationBranch; incorrect: AnimationBranch}};
}
export interface AnimationValidation {canonicalQuestion: string; expected: number; correctOptionId: string}
export interface AnimationArtifact {
  id: string; version: string; contentSha256: string; skillVersion: string; templateVersion: string; validatorVersion: string;
  lesson: AnimationLesson; validation: AnimationValidation;
}
export interface AnimationPresentation {
  id: string; sourceSessionId: string; goalId: string; taskId: string; skillId: string; artifact: AnimationArtifact;
}
export interface AnimationComponent extends AnimationPresentation {entryId: string}
export interface AnimationAnchor {
  presentation_id: string; source_entry_id: string; artifact_sha256: string; scene_id: string; scene_elapsed_ms: number; selected_object_id: null;
  explainer_path?: string[];
}
export interface AnimationQuestionContext {
  presentationId: string; artifactSha256: string; title: string; target: string; recipe: AnimationRecipe; templateVersion: string;
  skillVersion: string; sceneId: string; sceneIndex: number; sceneElapsedMs: number; sceneDurationMs: number;
  caption: string; why: string; parameters: AnimationLesson["parameters"]; assumptions: string[];
  scope: {goalId: string; taskId: string; skillId: string};
  previousState: AnimationState | null; targetState: AnimationState; transition: boolean; transitionProgress: number;
  verifiedStep: Record<string,unknown>; nextVerifiedStep: Record<string,unknown> | null;
  observation: string;
}

export function animationTransitionProgress(sceneIndex: number, elapsedMs: number): number {
  if (sceneIndex === 0) return 1;
  const progress = Math.min(1, Math.max(0, elapsedMs / 2000));
  return progress * progress * (3 - 2 * progress);
}

export function parseAnimationAnchor(value: unknown): AnimationAnchor {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("动画位置格式无效。");
  const item = value as Record<string, unknown>;
  const keys = ["presentation_id", "source_entry_id", "artifact_sha256", "scene_id", "scene_elapsed_ms", "selected_object_id", "explainer_path"];
  if (Object.keys(item).some(key => !keys.includes(key))) throw new Error("动画位置不能携带自定义事实。");
  for (const key of ["presentation_id", "source_entry_id", "scene_id"] as const)
    if (typeof item[key] !== "string" || !item[key] || item[key].length > 200) throw new Error("动画位置缺少有效标识。");
  if (typeof item.artifact_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.artifact_sha256)) throw new Error("动画材料版本无效。");
  if (typeof item.scene_elapsed_ms !== "number" || !Number.isFinite(item.scene_elapsed_ms) || item.scene_elapsed_ms < 0)
    throw new Error("动画时间须为有限非负数。");
  if (item.selected_object_id !== null) throw new Error("当前演示不支持对象选择。");
  if(item.explainer_path!==undefined&&(!Array.isArray(item.explainer_path)||!item.explainer_path.length||item.explainer_path.length>14||
    item.explainer_path.some(node=>typeof node!=="string"||!node||node.length>80)))throw new Error("解释动画路径格式无效。");
  return {presentation_id: item.presentation_id as string, source_entry_id: item.source_entry_id as string,
    artifact_sha256: item.artifact_sha256, scene_id: item.scene_id as string, scene_elapsed_ms: item.scene_elapsed_ms, selected_object_id: null,
    ...(item.explainer_path!==undefined?{explainer_path:[...(item.explainer_path as string[])]}:{})};
}
