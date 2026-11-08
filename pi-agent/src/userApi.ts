export interface UserSkillPayload {
  id: string;
  name: string;
  description: string;
  prerequisites: string[];
  status: "NOT_STARTED" | "LEARNING" | "PRACTICING" | "MASTERED_BY_USER";
  evidence_ids: string[];
}

export interface UserTaskPayload {
  id: string;
  title: string;
  description: string;
  related_skill_ids: string[];
  expected_evidence_types: string[];
  status: "TODO" | "ACTIVE" | "DONE" | "SKIPPED";
}

export interface UserApiOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  masteryScope?: {goalId: string; taskId: string};
}

async function postSkillAction(
  skillId: string,
  action: "confirm-mastery" | "reopen" | "start-practicing",
  options: UserApiOptions = {},
): Promise<UserSkillPayload> {
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  const url = `${baseUrl}/api/user/skills/${encodeURIComponent(skillId)}/${action}`;
  // 教师只能邀请；用户实际确认时携带原Goal/Task锚点，Kernel在同一写入边界校验是否仍有效。
  const scope = action === "confirm-mastery" ? options.masteryScope : undefined;
  if (scope && (![scope.goalId, scope.taskId].every(value => typeof value === "string" && value.trim().length > 0 && value.length <= 256))) {
    throw new Error("Mastery confirmation requires an exact Goal and Task scope");
  }
  const requestBody = scope ? JSON.stringify({expected_goal_id: scope.goalId, expected_task_id: scope.taskId}) : undefined;
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { Accept: "application/json", ...(requestBody ? {"Content-Type": "application/json"} : {}) },
    ...(requestBody ? {body: requestBody} : {}),
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep an actionable non-JSON response.
  }
  if (!response.ok) {
    const detail =
      typeof body === "object" && body !== null && "detail" in body
        ? String((body as { detail: unknown }).detail)
        : text;
    throw new Error(`User API returned HTTP ${response.status}: ${detail}`);
  }
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { id?: unknown }).id !== "string" ||
    typeof (body as { status?: unknown }).status !== "string"
  ) {
    throw new Error("User API returned an invalid Skill payload");
  }
  return body as UserSkillPayload;
}

export function confirmMastery(
  skillId: string,
  options: UserApiOptions = {},
): Promise<UserSkillPayload> {
  return postSkillAction(skillId, "confirm-mastery", options);
}

export function reopenSkill(
  skillId: string,
  options: UserApiOptions = {},
): Promise<UserSkillPayload> {
  return postSkillAction(skillId, "reopen", options);
}

export function startPracticing(
  skillId: string,
  options: UserApiOptions = {},
): Promise<UserSkillPayload> {
  return postSkillAction(skillId, "start-practicing", options);
}

export async function abandonTask(
  taskId: string,
  options: UserApiOptions = {},
): Promise<UserTaskPayload> {
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  const url = `${baseUrl}/api/user/tasks/${encodeURIComponent(taskId)}/abandon`;
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep an actionable non-JSON response.
  }
  if (!response.ok) {
    const detail =
      typeof body === "object" && body !== null && "detail" in body
        ? String((body as { detail: unknown }).detail)
        : text;
    throw new Error(`User API returned HTTP ${response.status}: ${detail}`);
  }
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { id?: unknown }).id !== "string" ||
    typeof (body as { status?: unknown }).status !== "string"
  ) {
    throw new Error("User API returned an invalid Task payload");
  }
  return body as UserTaskPayload;
}

async function sendCardAction(
  cardId: string,
  method: "POST" | "PUT" | "DELETE",
  suffix: string,
  body: Record<string, unknown> | undefined,
  options: UserApiOptions = {},
): Promise<unknown> {
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  const url = `${baseUrl}/api/user/cards/${encodeURIComponent(cardId)}${suffix}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  const response = await (options.fetchImpl ?? fetch)(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Keep an actionable non-JSON response.
  }
  if (!response.ok) {
    const detail =
      typeof parsed === "object" && parsed !== null && "detail" in parsed
        ? String((parsed as { detail: unknown }).detail)
        : text;
    throw new Error(`User API returned HTTP ${response.status}: ${detail}`);
  }
  return parsed;
}

export function setCardFeedback(
  cardId: string,
  body: { status: string; expected_content?: {skill_id:string;question:string;answer:string} },
  options: UserApiOptions = {},
): Promise<unknown> {
  return sendCardAction(cardId, "POST", "/feedback", body, options);
}

export function setCardNote(
  cardId: string,
  body: { note: string },
  options: UserApiOptions = {},
): Promise<unknown> {
  return sendCardAction(cardId, "PUT", "/note", body, options);
}

export function clearCardNote(
  cardId: string,
  options: UserApiOptions = {},
): Promise<unknown> {
  return sendCardAction(cardId, "DELETE", "/note", undefined, options);
}

export function deleteCard(
  cardId: string,
  options: UserApiOptions = {},
): Promise<unknown> {
  return sendCardAction(cardId, "DELETE", "", undefined, options);
}

export function updateCard(
  cardId: string,
  body: { question: string; answer: string },
  options: UserApiOptions = {},
): Promise<unknown> {
  return sendCardAction(cardId, "PUT", "", body, options);
}
