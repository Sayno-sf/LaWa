import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {TeachingActivitySchema, type TeachingActivity} from "./teachingActivity.js";

export type EvidenceType = "EXPLAIN" | "BUILD" | "DEBUG" | "TRANSFER";
export type AssistanceLevel =
  | "WITH_HELP"
  | "WITH_HINT"
  | "WITH_REFERENCE"
  | "INDEPENDENT"
  | "TRANSFERRED";

export interface LearningTaskPayload {
  id: string;
  title: string;
  description: string;
  related_skill_ids: string[];
  expected_evidence_types: EvidenceType[];
  teaching_activity?: TeachingActivity | null;
  activity_revision?: number;
  status: "TODO" | "ACTIVE" | "DONE" | "SKIPPED";
}

export interface CreateLearningTaskInput {
  title: string;
  description: string;
  related_skill_ids: string[];
  expected_evidence_types: EvidenceType[];
  teaching_activity?: TeachingActivity;
}

export interface SubmitEvidenceInput {
  skill_id: string;
  evidence_type: EvidenceType;
  description: string;
  assistance_level: AssistanceLevel;
  source: string;
}

export interface EvidencePayload extends SubmitEvidenceInput {
  id: string;
  created_at: string;
}

export interface CreateKnowledgeCardInput {
  skill_id: string;
  question: string;
  answer: string;
  source_conversation_id?: string;
}

export interface KnowledgeCardPayload {
  id: string;
  skill_id: string;
  question: string;
  answer: string;
  created_at: string;
  source_conversation_id: string | null;
  feedback: string | null;
  feedback_updated_at: string | null;
  feedback_revision?: number;
  learner_note: string | null;
  note_updated_at: string | null;
}

export interface LearningToolHttpOptions {
  teachingPreferencesRevision?: () => string | undefined;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  timeoutMs?: number;
}

const EvidenceTypeSchema = Type.Union([
  Type.Literal("EXPLAIN"),
  Type.Literal("BUILD"),
  Type.Literal("DEBUG"),
  Type.Literal("TRANSFER"),
]);

const AssistanceLevelSchema = Type.Union([
  Type.Literal("WITH_HELP"),
  Type.Literal("WITH_HINT"),
  Type.Literal("WITH_REFERENCE"),
  Type.Literal("INDEPENDENT"),
  Type.Literal("TRANSFERRED"),
]);

function requestSignal(options: LearningToolHttpOptions, signal?: AbortSignal) {
  // 学习写入（建卡/提交 Evidence）需等 Python 原子写完成；10s 在高负载下易超时导致"假失败"后 Agent 重试产生重复。
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Preserve non-JSON error bodies for an actionable tool failure.
  }
  if (!response.ok) {
    const detail =
      typeof body === "object" && body !== null && "detail" in body
        ? String((body as { detail: unknown }).detail)
        : text;
    throw new Error(`Learning API returned HTTP ${response.status}: ${detail}`);
  }
  return body;
}

function isTask(value: unknown): value is LearningTaskPayload {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.title === "string" &&
    Array.isArray(item.related_skill_ids) &&
    typeof item.status === "string"
  );
}

function isEvidence(value: unknown): value is EvidencePayload {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.skill_id === "string" &&
    typeof item.evidence_type === "string" &&
    typeof item.description === "string" &&
    typeof item.assistance_level === "string" &&
    typeof item.source === "string" &&
    typeof item.created_at === "string"
  );
}

function isKnowledgeCard(value: unknown): value is KnowledgeCardPayload {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.skill_id === "string" &&
    typeof item.question === "string" &&
    typeof item.answer === "string" &&
    typeof item.created_at === "string"
  );
}

export async function createLearningTask(
  input: CreateLearningTaskInput,
  options: LearningToolHttpOptions = {},
  signal?: AbortSignal,
): Promise<LearningTaskPayload> {
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  const url = `${baseUrl}/api/learning/tasks`;
  const log = options.log ?? ((message: string) => console.error(message));
  log(`[tool:http] POST ${url}`);
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({...input, ...(input.teaching_activity ? {teaching_activity: {...input.teaching_activity,
      teaching_preferences_revision: options.teachingPreferencesRevision?.() ?? null}} : {})}),
    signal: requestSignal(options, signal),
  });
  const payload = await responseJson(response);
  if (!isTask(payload)) throw new Error("Learning API returned an invalid task payload");
  log(`[tool:http] task created: id=${payload.id}, status=${payload.status}`);
  return payload;
}

export function createCreateLearningTaskTool(
  options: LearningToolHttpOptions = {},
) {
  return defineTool({
    name: "create_learning_task",
    label: "Create Learning Task",
    description:
      "Create one TODO LearningTask for exactly one current Skill. A lesson spanning several Skills becomes sequential tasks, not one multi-Skill task. Same-Frontier next steps may continue naturally; cross-Frontier/major-stage changes need user confirmation. Creation does not activate it. Never duplicate a current task. The Skill must come from the current overview.",
    parameters: Type.Object({
      title: Type.String({ minLength: 1 }),
      description: Type.String({ minLength: 1 }),
      related_skill_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 1 }),
      expected_evidence_types: Type.Array(EvidenceTypeSchema),
      teaching_activity: TeachingActivitySchema,
    }),
    execute: async (_toolCallId, params, signal) => {
      const task = await createLearningTask(params, options, signal);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(task) }],
        details: { taskId: task.id, status: task.status },
      };
    },
  });
}

export async function activateLearningTask(
  taskId: string,
  options: LearningToolHttpOptions = {},
  signal?: AbortSignal,
): Promise<LearningTaskPayload> {
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  const url = `${baseUrl}/api/learning/tasks/${encodeURIComponent(taskId)}/activate`;
  const log = options.log ?? ((message: string) => console.error(message));
  log(`[tool:http] POST ${url}`);
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { Accept: "application/json" },
    signal: requestSignal(options, signal),
  });
  const payload = await responseJson(response);
  if (!isTask(payload)) throw new Error("Learning API returned an invalid task payload");
  log(`[tool:http] task activated: id=${payload.id}, status=${payload.status}`);
  return payload;
}

export function createActivateLearningTaskTool(
  options: LearningToolHttpOptions = {},
) {
  return defineTool({
    name: "activate_learning_task",
    label: "Activate Learning Task",
    description:
      "Activate one TODO LearningTask. Same-Frontier teaching may continue naturally; cross-Frontier or major-stage changes require user control. The Kernel remains authoritative about whether activation is legal.",
    parameters: Type.Object({
      task_id: Type.String({ minLength: 1 }),
    }),
    execute: async (_toolCallId, params, signal) => {
      const task = await activateLearningTask(params.task_id, options, signal);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(task) }],
        details: { taskId: task.id, status: task.status },
      };
    },
  });
}

export async function completeLearningTask(
  taskId: string,
  options: LearningToolHttpOptions = {},
  signal?: AbortSignal,
): Promise<LearningTaskPayload> {
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  const url = `${baseUrl}/api/learning/tasks/${encodeURIComponent(taskId)}/complete`;
  const log = options.log ?? ((message: string) => console.error(message));
  log(`[tool:http] POST ${url}`);
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { Accept: "application/json" },
    signal: requestSignal(options, signal),
  });
  const payload = await responseJson(response);
  if (!isTask(payload)) throw new Error("Learning API returned an invalid task payload");
  log(`[tool:http] task completed: id=${payload.id}, status=${payload.status}`);
  return payload;
}

export function createCompleteLearningTaskTool(
  options: LearningToolHttpOptions = {},
) {
  return defineTool({
    name: "complete_learning_task",
    label: "Complete Learning Task",
    description:
      "Complete the current ACTIVE LearningTask after its Skill Evidence has been submitted successfully. In Web, first ask_learner_questions(CONFIRM_MASTERY) and wait for the learner to confirm or skip mastery confirmation; handle learning gaps before completion. This does not grant Mastery. Do not issue completion in parallel with dependent submit_evidence calls. Never complete a TODO, DONE, SKIPPED, or unknown task.",
    parameters: Type.Object({
      task_id: Type.String({ minLength: 1 }),
    }),
    execute: async (_toolCallId, params, signal) => {
      const task = await completeLearningTask(params.task_id, options, signal);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(task) }],
        details: { taskId: task.id, status: task.status },
      };
    },
  });
}

export async function submitEvidence(
  input: SubmitEvidenceInput,
  options: LearningToolHttpOptions = {},
  signal?: AbortSignal,
): Promise<EvidencePayload> {
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  const url = `${baseUrl}/api/learning/evidence`;
  const log = options.log ?? ((message: string) => console.error(message));
  log(`[tool:http] POST ${url}`);
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: requestSignal(options, signal),
  });
  const payload = await responseJson(response);
  if (!isEvidence(payload)) {
    throw new Error("Learning API returned an invalid evidence payload");
  }
  log(
    `[tool:http] evidence submitted: id=${payload.id}, skill=${payload.skill_id}, assistance=${payload.assistance_level}`,
  );
  return payload;
}

export function createSubmitEvidenceTool(
  options: LearningToolHttpOptions = {},
) {
  return defineTool({
    name: "submit_evidence",
    label: "Submit Evidence",
    description:
      "Persist a concrete learning fact only for the Skill of the current ACTIVE LearningTask. A supporting Skill needs its own activated Task before Evidence submission. Submit before completing that Task, never in parallel with completion. Record in the background when type, description and real assistance are clear; ask only when material ambiguity remains. Never contradict an explicit reference/help claim. Evidence never confirms mastery.",
    parameters: Type.Object({
      skill_id: Type.String({ minLength: 1 }),
      evidence_type: EvidenceTypeSchema,
      description: Type.String({ minLength: 1 }),
      assistance_level: AssistanceLevelSchema,
      source: Type.String({ minLength: 1 }),
    }),
    execute: async (_toolCallId, params, signal) => {
      const evidence = await submitEvidence(params, options, signal);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(evidence) }],
        details: {
          evidenceId: evidence.id,
          skillId: evidence.skill_id,
          assistanceLevel: evidence.assistance_level,
        },
      };
    },
  });
}

export async function createKnowledgeCard(
  input: CreateKnowledgeCardInput,
  options: LearningToolHttpOptions = {},
  signal?: AbortSignal,
): Promise<KnowledgeCardPayload> {
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  const url = `${baseUrl}/api/learning/cards`;
  const log = options.log ?? ((message: string) => console.error(message));
  log(`[tool:http] POST ${url}`);
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: requestSignal(options, signal),
  });
  const payload = await responseJson(response);
  if (!isKnowledgeCard(payload)) {
    throw new Error("Learning API returned an invalid knowledge card payload");
  }
  log(`[tool:http] knowledge card created: id=${payload.id}, skill=${payload.skill_id}`);
  return payload;
}

export function createCreateKnowledgeCardTool(
  options: LearningToolHttpOptions = {},
) {
  return defineTool({
    name: "create_knowledge_card",
    label: "Create Knowledge Card",
    description:
      "Create 1-3 high-value cards for the current Skill when a coherent learning unit is clear and stable, preferably after related practice or the learner confirms understanding. Defer while exploring, correcting, or resolving an uncertain conclusion; practice is not a mandatory gate. Compare with knowledge_cards already read for the current Skill and avoid duplicate or merely reworded cards. Automatic state and default overview do not include card bodies; use get_skill_learning_context only when actual duplication risk requires missing card details. If details remain insufficient, defer instead of fetching overview on every message. The front is a question and the back a reference answer. Do not create cards on every message. Cards are study material, not Evidence or Mastery. Feedback, learner notes, editing and deletion are user-only actions. When creating multiple cards, issue the calls in parallel within the same response; the Kernel serializes writes safely.",
    parameters: Type.Object({
      skill_id: Type.String({ minLength: 1 }),
      question: Type.String({ minLength: 1 }),
      answer: Type.String({ minLength: 1 }),
      source_conversation_id: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params, signal) => {
      const card = await createKnowledgeCard(params, options, signal);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(card) }],
        details: { cardId: card.id, skillId: card.skill_id },
      };
    },
  });
}
