import { Type } from "typebox";
import type { AssistanceLevel } from "./learningWriteTools.js";

export const AssistanceLevelSchema = Type.Union([
  Type.Literal("INDEPENDENT"), Type.Literal("TRANSFERRED"), Type.Literal("WITH_HINT"),
  Type.Literal("WITH_REFERENCE"), Type.Literal("WITH_HELP"),
], {description: "主教师判断本次实际作答获得的帮助；旧助教记录/自动分类只供参考，无关求助不影响本题。"});

// 主教师负责语义归因；当前题运行时已知的选项、提示和参考不能被较低标签覆盖。
export function combineAssistance(observed: AssistanceLevel, judged?: AssistanceLevel): AssistanceLevel {
  const rank: Record<AssistanceLevel, number> = {INDEPENDENT: 0, TRANSFERRED: 0, WITH_HINT: 1, WITH_REFERENCE: 2, WITH_HELP: 3};
  return judged && rank[judged] >= rank[observed] ? judged : observed;
}
