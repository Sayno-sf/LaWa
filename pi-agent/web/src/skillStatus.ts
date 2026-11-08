export type SkillState = "NOT_STARTED" | "LEARNING" | "PRACTICING" | "MASTERED_BY_USER";

// “正在学习”是当前 Task 的展示焦点；LEARNING 本身只说明此 Skill 已开始、尚未毕业。
export function skillStatusLabel(status: SkillState, isCurrent: boolean): string {
  switch (status) {
    case "NOT_STARTED": return "待学习";
    case "LEARNING": return isCurrent ? "正在学习" : "待巩固";
    case "PRACTICING": return isCurrent ? "正在实践" : "练习中";
    case "MASTERED_BY_USER": return "已确认掌握";
  }
}

export function resolveCurrentTaskSkillId(
  relatedSkillIds: readonly string[],
  teachingSkillId: string | null,
  frontierFocusSkillId: string | null,
): string | null {
  if (teachingSkillId && relatedSkillIds.includes(teachingSkillId)) return teachingSkillId;
  if (frontierFocusSkillId && relatedSkillIds.includes(frontierFocusSkillId)) return frontierFocusSkillId;
  return relatedSkillIds[0] ?? null;
}
