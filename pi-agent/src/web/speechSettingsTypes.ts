export type SpeechRegion = "beijing" | "singapore";

/** Browser 与持久化设置共用的非敏感结构；凭据只通过 profileId 在 Node 侧解析。 */
export interface SpeechSettings {
  enabled: boolean;
  profileId: string | null;
  region: SpeechRegion;
  asrModel: string;
  ttsModel: string;
  voice: string;
}

export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = {
  enabled: false,
  profileId: null,
  region: "beijing",
  asrModel: "qwen3-asr-flash",
  ttsModel: "qwen3-tts-flash",
  voice: "Cherry",
};
