export interface LearnerQuestion {
  id: string;
  prompt: string;
  selection: "single" | "multiple" | "freeform";
  options: Array<{ id: string; label: string; description?: string }>;
}

export interface LearnerQuestionRequest {
  id: string;
  purpose: "BACKGROUND" | "CHECK" | "PRACTICE_SET" | "CONFIRM_GOAL" | "START_LEARNING" | "CONFIRM_PLAN_REVISION" | "CONFIRM_MASTERY";
  session_id: string;
  goal_id: string | null;
  skill_id: string | null;
  task_id: string | null;
  scope_signature?: string;
  plan_revision_id?: string;
  plan_revision_base?: number;
  review_topic_id?: string;
  review_skill_id?: string;
  assessment_contract_id?: string;
  title?: string;
  instructions?: string;
  // 仅服务端展示投影：此请求的真实决定已保存但教师接续尚未送达，供用户显式重试，不是默认代选。
  applied_reply?: LearnerQuestionReply;
  questions: LearnerQuestion[];
}

export interface LearnerQuestionReply {
  request_id: string;
  answers: Array<{ question_id: string; selected_option_ids: string[]; other_text: string; voice_input?: VoiceInputMetadata }>;
}

export interface LearnerAnswerRecord {
  request: LearnerQuestionRequest;
  reply: LearnerQuestionReply | null;
  text: string;
  used_choices: boolean;
  choices_exposed: boolean;
}

export interface LearnerQuestionChat {
  request_id: string;
  text: string;
}

export interface LearnerQuestionsSnapshot {
  // 真实收尾决定只绑定原任务；不代表作答/Evidence，也不从普通聊天推导。
  transition_decision?: {request: LearnerQuestionRequest; action: "confirm" | "needs_work" | "skip"; feedback: string};
  // 普通聊天仅关联当前题目，不是答案或确认；旧持久记录可以没有此字段。
  chat_interruption?: LearnerQuestionChat;
  pending: LearnerQuestionRequest | null;
  last_answer: LearnerAnswerRecord | null;
}
import type { VoiceInputMetadata } from "./speechTypes.js";
