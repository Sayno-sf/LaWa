import { normalizeGoalProfile, type GoalProfileInput, type InitializeLearningGoalInput } from "./planningTypes.js";
import {planningHash, type PlanningReadingReference} from "./planningReading.js";

export type GoalUnderstandingStatus =
  | "IDLE"
  | "NEEDS_CLARIFICATION"
  | "READY_FOR_CONFIRMATION"
  | "CONFIRMED"
  | "INITIALIZED";

export interface GoalOnboardingSnapshot {
  continuing_goal_id?: string;
  status: GoalUnderstandingStatus;
  pending_profile: GoalProfileInput | null;
  missing_information: string[];
  replace_existing: boolean;
  reading_requirement?: PlanningReadingReference;
}

export type GoalUnderstandingInput =
  | {
      outcome: "NEEDS_CLARIFICATION";
      profile: GoalProfileInput;
      missing_information: string[];
    }
  | {
      outcome: "READY_FOR_CONFIRMATION";
      profile: GoalProfileInput;
      missing_information?: never;
    }
  | {
      outcome: "CONFIRMED";
      profile?: never;
      missing_information?: never;
    };

const explicitConfirmation = /^(?:对(?:[，,]?就是这样)?|是的?|正确|确认|没错|可以|就这样|同意|yes|correct)[。.!！]?$/i;

export class GoalOnboardingContext {
  private state: GoalOnboardingSnapshot = {
    status: "IDLE",
    pending_profile: null,
    missing_information: [],
    replace_existing: false,
  };
  private latestUserConfirmed = false;
  private latestUserRequestedReplacement = false;

  beginUserTurn(text: string): void {
    this.latestUserConfirmed = explicitConfirmation.test(text.trim());
    this.latestUserRequestedReplacement =
      /(?:不想再?学|不学).{0,12}(?:了|改|换|转)|(?:改学|改成|换成|转向|切换到|重新学)/i.test(
        text,
      ) ||
      // 现有 Goal 下的普通对话保持 IDLE；用户主动提出新的学习/研究方向时，
      // 这条自然语言请求也是显式的 replacement 入口，后续仍须独立确认理解。
      (this.state.status === "IDLE" && /我(?:现在)?想(?:要)?(?:系统(?:地)?)?(?:学习|研究)/.test(text));
  }

  start(options: { replaceExisting?: boolean } = {}): GoalOnboardingSnapshot {
    this.latestUserConfirmed = false;
    this.latestUserRequestedReplacement = false;
    this.state = {
      status: "NEEDS_CLARIFICATION",
      pending_profile: null,
      missing_information: ["goal and desired outcome"],
      replace_existing: options.replaceExisting ?? false,
    };
    return this.snapshot();
  }

  authorizeReplacement(): GoalOnboardingSnapshot {
    if (this.state.status !== "CONFIRMED" || !this.state.pending_profile) {
      throw new Error("只有已确认且尚未初始化的新路线可以补充替换授权");
    }
    // 此入口只能由用户的 New Goal 动作调用；保留已确认的理解，不让模型代签授权。
    this.state = { ...this.state, replace_existing: true };
    return this.snapshot();
  }

  /** 点击继续学习仅恢复资料；首次补路线仍由独立的确认卡取得用户同意。 */
  startImported(profile: GoalProfileInput): GoalOnboardingSnapshot {
    this.latestUserConfirmed = false;
    this.latestUserRequestedReplacement = false;
    this.state = {status: "READY_FOR_CONFIRMATION", pending_profile: normalizeGoalProfile(profile),
      missing_information: [], replace_existing: true, continuing_goal_id: profile.id};
    return this.snapshot();
  }

  restoreConfirmedForReplacement(profile: GoalProfileInput): GoalOnboardingSnapshot {
    if (this.state.status !== "IDLE") {
      throw new Error("只有空闲的目标引导状态可以恢复历史确认");
    }
    // 只由 Web 的显式 New Goal 动作、且在校验过同一 Pi 会话的成功确认记录后调用。
    this.state = {
      status: "CONFIRMED",
      pending_profile: structuredClone(normalizeGoalProfile(profile)),
      missing_information: [],
      replace_existing: true,
    };
    this.latestUserConfirmed = false;
    this.latestUserRequestedReplacement = false;
    return this.snapshot();
  }

  cancel(): void {
    this.latestUserConfirmed = false;
    this.latestUserRequestedReplacement = false;
    this.state = {
      status: "IDLE",
      pending_profile: null,
      missing_information: [],
      replace_existing: false,
    };
  }

  snapshot(): GoalOnboardingSnapshot {
    return structuredClone(this.state);
  }

  /** 从同一Pi分支成功工具回执恢复草案；旧确认只恢复内容，必须等待新的人类确认。 */
  restoreUnconfirmedDraft(snapshot: GoalOnboardingSnapshot): void {
    if (snapshot.reading_requirement || !snapshot.pending_profile ||
        !["READY_FOR_CONFIRMATION", "CONFIRMED", "NEEDS_CLARIFICATION"].includes(snapshot.status))
      throw new Error("GOAL_DRAFT_RESTORE_INVALID");
    this.state = {...structuredClone(snapshot),
      pending_profile: normalizeGoalProfile(snapshot.pending_profile),
      status: snapshot.status === "CONFIRMED" ? "READY_FOR_CONFIRMATION" : snapshot.status};
    this.latestUserConfirmed = false;
    this.latestUserRequestedReplacement = false;
  }

  /** 仅供外层核验真实Pi确认/分支及Kernel现场后的持久等待恢复；不把机器事件当用户确认。 */
  restoreReadingWait(snapshot: GoalOnboardingSnapshot, completed = false): void {
    if (!["IDLE", "NEEDS_CLARIFICATION"].includes(this.state.status) || this.state.pending_profile
        || snapshot.status !== "CONFIRMED" || !snapshot.pending_profile || !snapshot.reading_requirement
        || planningHash(snapshot.pending_profile) !== snapshot.reading_requirement.profile_hash)
      throw new Error("PLANNING_WAIT_RESTORE_INVALID");
    this.state = structuredClone(snapshot);
    if (completed) this.state.status = "INITIALIZED";
    this.latestUserConfirmed = false; this.latestUserRequestedReplacement = false;
  }

  record(input: GoalUnderstandingInput, reading?: PlanningReadingReference): GoalOnboardingSnapshot {
    this.validateRecord(input);
    if (input.outcome === "CONFIRMED") {
      this.state = { ...this.state, status: "CONFIRMED" };
      return this.snapshot();
    }

    const missing = input.missing_information ?? [];
    // 用户自述只保存在 GoalProfile，绝不在这里转换为 Evidence 或 Mastery。
    // 内部保留缺失信息清单；组件逐题展示同批必要问题，全部回答后再提交模型。
    this.state = {
      ...this.state,
      status: input.outcome,
      pending_profile: structuredClone(normalizeGoalProfile(input.profile)),
      missing_information: [...missing],
      replace_existing:
        this.state.replace_existing || this.latestUserRequestedReplacement,
      ...(reading ? {reading_requirement: structuredClone(reading)} : {}),
    };
    // READY 必须等待下一条独立用户消息，不能把描述 Goal 的同一轮当成确认。
    this.latestUserConfirmed = false;
    this.latestUserRequestedReplacement = false;
    return this.snapshot();
  }

  /** 先做权限与形状预检，再允许锁外准备阅读，失败的Goal工具不能先启动资料加工。 */
  validateRecord(input: GoalUnderstandingInput): void {
    if (input.outcome === "CONFIRMED") {
      if (this.state.status !== "READY_FOR_CONFIRMATION") throw new Error("Goal Understanding is not ready for confirmation");
      if (!this.latestUserConfirmed) throw new Error("Goal confirmation must come from the latest user message");
      return;
    }
    if (this.state.status === "IDLE" && !this.latestUserRequestedReplacement)
      throw new Error("请先使用「新目标」入口，或明确提出新的学习/研究目标，再规划替换路线");
    normalizeGoalProfile(input.profile);
    if (this.state.continuing_goal_id && input.profile.id !== this.state.continuing_goal_id)
      throw new Error("补充导入目标的路线必须保留原目标身份");
    if (input.outcome === "NEEDS_CLARIFICATION" && !input.missing_information?.length)
      throw new Error("Clarification must name all route-changing missing information");
  }

  validateInitialization(input: InitializeLearningGoalInput): void {
    if (this.state.status !== "CONFIRMED" || !this.state.pending_profile) {
      throw new Error("Initialize only after the user confirms Goal Understanding");
    }
    if (input.goal_profile.id !== this.state.pending_profile.id) {
      throw new Error("Initialized Goal must match the user-confirmed Goal Profile");
    }
    if (planningHash(input.goal_profile) !== planningHash(this.state.pending_profile)) {
      throw new Error("Initialized Goal must preserve the full user-confirmed Goal Profile");
    }
    if (input.replace_existing !== this.state.replace_existing) {
      throw new Error("Goal replacement requires the explicit /new-goal replace path");
    }
  }

  markInitialized(): void {
    if (this.state.status !== "CONFIRMED") {
      throw new Error("Cannot mark an unconfirmed Goal as initialized");
    }
    this.state = { ...this.state, status: "INITIALIZED" };
  }
}
