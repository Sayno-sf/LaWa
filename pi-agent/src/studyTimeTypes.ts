export type StudyObservation = "FOCUSED" | "AWAY" | "NO_FACE" | "UNKNOWN" | "HIDDEN";
export interface StudyScope { goalId: string; taskId: string; goalName: string; taskName: string }
export interface StudyTimeSummary {
  source?: "browser" | null;
  scope: StudyScope | null;
  taskFocusedMs: number; goalFocusedMs: number; runFocusedMs: number;
  taskObservedMs: number; taskWaitingMs: number;
  observation: StudyObservation; recording: boolean;
}
export interface StudyInterval { seq: number; observedMs: number; focusedMs: number; waitingMs: number; observation: StudyObservation }

// 计时归属取 Kernel 当前 ACTIVE Task；浏览器不能凭聊天文本提交 Goal/Task 身份。
export function studyScope(overview: { goal_profile: unknown; active_task: unknown; current_goal: string | null }): StudyScope | null {
  const goal = overview.goal_profile as { id?: unknown } | null;
  const task = overview.active_task as { id?: unknown; goal_id?: unknown; title?: unknown; status?: unknown } | null;
  if (typeof goal?.id !== "string" || typeof task?.id !== "string" || task.status !== "ACTIVE" || task.goal_id !== goal.id) return null;
  return { goalId: goal.id, taskId: task.id, goalName: overview.current_goal ?? "", taskName: typeof task.title === "string" ? task.title : "当前任务" };
}
export function sameStudyScope(a: StudyScope | null, b: StudyScope | null): boolean {
  return a?.goalId === b?.goalId && a?.taskId === b?.taskId;
}

export function studyTimingPrompt(summary: StudyTimeSummary): string {
  return `浏览器摄像头观察推算的学习计时（只读；当前 Goal/Task；当前请求前最新已入账摘要；时间不是理解、Evidence 或掌握证明）：
${JSON.stringify({ goal_id: summary.scope?.goalId ?? null, task_id: summary.scope?.taskId ?? null,
    task_focused_seconds: Math.floor(summary.taskFocusedMs / 1000), goal_focused_seconds: Math.floor(summary.goalFocusedMs / 1000),
    current_run_focused_seconds: Math.floor(summary.runFocusedMs / 1000), task_observed_seconds: Math.floor(summary.taskObservedMs / 1000),
    task_generation_wait_seconds: Math.floor(summary.taskWaitingMs / 1000), observation: summary.observation, recording: summary.recording })}
摘要只覆盖当前请求前成功上报的区间，不是完整或实时的学习时长。优先用task_focused_seconds；goal_focused_seconds是目标累计，current_run_focused_seconds可能跨Goal/Task，不能当本任务耗时。task_observed_seconds表示覆盖，task_generation_wait_seconds是生成等待，不算有效学习。未开启、未记录或覆盖不足不等于未学习；人脸/朝向线索不证明心理专注、理解或疲劳。
时间只辅助调节任务大小和讲练节奏，不每轮报时或催促。结合实际回答与剩余缺口，重复卡住时换讲法、最小实践或建议休息；不能为赶时间跳过关键内容、降低验证要求或提前完成Task/Mastery，不按固定分钟数触发测验或毕业。`;
}
