export type SpeechLanguage = "en" | "zh" | "auto";
export type SpeechPurpose = "example" | "repeat" | "requested_reading";

/** 仅表示本地配置；不包含档案、凭据、麦克风授权或供应商健康状态。 */
export type SpeechConfigurationStatus = "CONFIGURED" | "DISABLED" | "NOT_CONFIGURED" | "UNKNOWN";

/** 每次实际教学请求生成白名单摘要，未知状态不沿用旧对话的可用承诺。 */
export function speechTeachingPrompt(surface: "WEB" | "CLI", status: SpeechConfigurationStatus = "UNKNOWN"): string {
  if (surface === "CLI") return "当前语音能力：CLI 没有播放器或麦克风，不调用 present_speech，使用文字示范与书面回答。";
  const configuration = ["CONFIGURED", "DISABLED", "NOT_CONFIGURED", "UNKNOWN"].includes(status) ? status : "UNKNOWN";
  return `当前语音能力（本次请求的只读本地配置，优先于旧聊天描述）：
${JSON.stringify({ surface: "WEB", status: configuration, playback: "USER_CLICK", microphone: "USER_START", service_health: "NOT_CHECKED" })}
仅本请求配置状态，不含凭据；不是服务健康、麦克风授权或播放证明。按共享语音政策选择教学示范，播放/开麦由用户发起。`;
}

/** 可恢复的朗读描述；音频、凭据和播放状态不进入 Pi 对话。 */
export interface SpeechPresentation {
  id: string;
  text: string;
  language: SpeechLanguage;
  purpose: SpeechPurpose;
  sourceSessionId: string;
  goalId?: string;
  taskId?: string;
  skillId?: string;
}

export interface SpeechReference {
  sourceSessionId: string;
  entryId: string;
  presentationId: string;
}

export interface SpeechComponent extends SpeechPresentation {
  entryId: string;
}

export interface VoiceInputMetadata {
  source: "voice";
  transcriptEdited: boolean;
}

export function parseVoiceInputMetadata(value: unknown): VoiceInputMetadata | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) throw new Error("语音输入来源格式无效。");
  const item = value as Partial<VoiceInputMetadata>;
  if (item.source !== "voice" || typeof item.transcriptEdited !== "boolean") throw new Error("语音输入来源格式无效。");
  return { source: "voice", transcriptEdited: item.transcriptEdited };
}

/** 只投影受信工具的白名单字段；历史中的原始 JSON 不作为可执行组件。 */
export function readSpeechPresentation(value: unknown): SpeechPresentation | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Partial<SpeechPresentation>;
  if (typeof item.id !== "string" || !item.id || item.id.length > 100 ||
      typeof item.sourceSessionId !== "string" || !item.sourceSessionId || item.sourceSessionId.length > 200 ||
      typeof item.text !== "string" || !item.text.trim() || item.text.length > 600 ||
      !["en", "zh", "auto"].includes(item.language ?? "") ||
      !["example", "repeat", "requested_reading"].includes(item.purpose ?? "")) return null;
  for (const key of ["goalId", "taskId", "skillId"] as const) {
    if (item[key] !== undefined && (typeof item[key] !== "string" || !item[key] || item[key].length > 200)) return null;
  }
  return { id: item.id, text: item.text, language: item.language!, purpose: item.purpose!, sourceSessionId: item.sourceSessionId,
    ...(item.goalId ? { goalId: item.goalId } : {}), ...(item.taskId ? { taskId: item.taskId } : {}), ...(item.skillId ? { skillId: item.skillId } : {}) };
}
