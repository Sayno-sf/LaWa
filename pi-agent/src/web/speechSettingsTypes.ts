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

/** GET 在从未写入设置文件时附加标记，PUT 和磁盘仍只接受 SpeechSettings。 */
export interface PublicSpeechSettings extends SpeechSettings {
  saved?: false;
}

export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = {
  enabled: false,
  profileId: null,
  region: "beijing",
  asrModel: "qwen3-asr-flash",
  ttsModel: "qwen3-tts-flash",
  voice: "Cherry",
};

export function speechRegionForHost(host: string): SpeechRegion | null {
  if (host === "dashscope.aliyuncs.com" || /^[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/.test(host)) return "beijing";
  if (host === "dashscope-intl.aliyuncs.com" || /^[a-z0-9-]+\.ap-southeast-1\.maas\.aliyuncs\.com$/.test(host)) return "singapore";
  return null;
}
