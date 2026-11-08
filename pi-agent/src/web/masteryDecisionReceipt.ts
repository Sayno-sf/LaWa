import {createHash} from "node:crypto";
import type {SessionManager} from "@earendil-works/pi-coding-agent";
import type {LearnerQuestionReply, LearnerQuestionRequest} from "../learnerQuestionTypes.js";

export const MASTERY_DECISION_ENTRY = "lawa.mastery-decision";
export interface MasteryDecisionReceipt {
  version: 1;
  request: LearnerQuestionRequest;
  action: "confirm" | "needs_work" | "skip";
  feedback: string;
  reply: LearnerQuestionReply;
  replyHash: string;
  phase: "INTENT" | "APPLIED";
  expectedVersion?: string;
  review: boolean;
}
export const masteryReplyHash = (reply: LearnerQuestionReply): string => createHash("sha256")
  .update(JSON.stringify(reply)).digest("hex");

// 决定票据只由真实用户路由保存。模型可以建议提问，不能靠自己的工具结果制造确认。
export function masteryDecisionReceipt(manager: SessionManager, requestId: string): MasteryDecisionReceipt | undefined {
  const entry = manager.getBranch().findLast(row => row.type === "custom" && row.customType === MASTERY_DECISION_ENTRY
    && (row.data as Partial<MasteryDecisionReceipt> | null)?.request?.id === requestId);
  if (entry?.type !== "custom") return;
  const value = entry.data as MasteryDecisionReceipt;
  if (value.version !== 1 || value.request?.purpose !== "CONFIRM_MASTERY" || value.request.session_id !== manager.getSessionId()
      || !["confirm", "needs_work", "skip"].includes(value.action) || !["INTENT", "APPLIED"].includes(value.phase)
      || !value.reply || value.replyHash !== masteryReplyHash(value.reply)) return;
  return value;
}

export function saveMasteryDecisionReceipt(manager: SessionManager, receipt: MasteryDecisionReceipt): void {
  manager.appendCustomEntry(MASTERY_DECISION_ENTRY, structuredClone(receipt));
}
