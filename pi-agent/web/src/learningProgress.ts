/** 只统计已经展开且由用户确认的知识点；不把阶段数量、评分、卡片自评变成掌握概率。 */
export function confirmedProgress(skills: readonly {id: string; status: string}[]): {total: number; confirmed: number} {
  const unique = [...new Map(skills.map(skill => [skill.id, skill])).values()];
  return {total: unique.length, confirmed: unique.filter(skill => skill.status === "MASTERED_BY_USER").length};
}

export function latestRecordedTime(values: readonly (string | null | undefined)[]): string | null {
  return values.filter((value): value is string => Boolean(value && Number.isFinite(Date.parse(value))))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}
