import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { SpeechProviderCredentials } from "./providerSettings.js";
import {ProviderSettingsError} from "./providerSettingsErrors.js";
import { DEFAULT_SPEECH_SETTINGS, speechRegionForHost, type PublicSpeechSettings, type SpeechSettings } from "./speechSettingsTypes.js";
import type { SpeechConfigurationStatus } from "../speechTypes.js";
import {readSpeechEvents,SpeechStreamError} from "./speechStream.js";

export const MAX_VOICE_AUDIO_BYTES = 4 * 1024 * 1024;
export const MAX_VOICE_SECONDS = 120;
const MAX_SYNTHESIS_BYTES = 8 * 1024 * 1024;
const CACHE_BYTES = 32 * 1024 * 1024;
const MAX_JSON_BYTES = 12 * 1024 * 1024;

export class SpeechServiceError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) { super(message); }
}

export interface SpeechAudio { audio: Buffer; contentType: "audio/wav" }
export interface SpeechText { text: string; language: "en" | "zh" | "auto" }
export interface SpeechServiceLike {
  getPublicSettings(): Promise<PublicSpeechSettings>;
  getTeachingStatus?(): Promise<SpeechConfigurationStatus>;
  saveSettings(input: unknown): Promise<SpeechSettings>;
  transcribe(audio: Uint8Array, options?: { signal?: AbortSignal }): Promise<{ text: string }>;
  synthesize(input: SpeechText, options?: { signal?: AbortSignal }): Promise<SpeechAudio>;
}
interface SpeechServiceOptions {
  settingsPath: string;
  credentials: { getSpeechCredentials(profileId: string): Promise<SpeechProviderCredentials> };
  fetch?: typeof fetch;
  timeoutMs?: number;
  // 硬件显式启用；复用完整 SSE 音频，避免末尾再下载同一份 OSS 文件。
  streamSynthesis?: boolean;
}

function normalizeSettings(value: unknown): SpeechSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SpeechServiceError("INVALID_SPEECH_SETTINGS", "语音设置格式无效。");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !Object.keys(DEFAULT_SPEECH_SETTINGS).includes(key))) throw new SpeechServiceError("INVALID_SPEECH_SETTINGS", "语音设置只能保存模型档案引用，不能包含凭据或额外参数。");
  if (typeof v.enabled !== "boolean" || (v.profileId !== null && (typeof v.profileId !== "string" || !v.profileId.trim())) || !["beijing", "singapore"].includes(String(v.region))) {
    throw new SpeechServiceError("INVALID_SPEECH_SETTINGS", "请选择是否启用、模型档案与正确地域。");
  }
  if (typeof v.asrModel !== "string" || !/^qwen3-asr-flash(?:-\d{4}-\d{2}-\d{2})?$/.test(v.asrModel)
    || typeof v.ttsModel !== "string" || !/^qwen3-tts(?:-instruct)?-flash(?:-\d{4}-\d{2}-\d{2})?$/.test(v.ttsModel)
    || typeof v.voice !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v.voice)) {
    throw new SpeechServiceError("INVALID_SPEECH_MODEL", "语音模型或音色无效，请使用支持的 Qwen3 非实时语音模型。");
  }
  if (v.enabled && !v.profileId) throw new SpeechServiceError("MISSING_SPEECH_PROFILE", "请为语音明确选择已保存的百炼模型档案。", 422);
  return { enabled: v.enabled, profileId: v.profileId as string | null, region: v.region as SpeechSettings["region"], asrModel: v.asrModel, ttsModel: v.ttsModel, voice: v.voice };
}

function endpoints(credentials: SpeechProviderCredentials, settings: SpeechSettings): { asr: string; tts: string } {
  let url: URL;
  try { url = new URL(credentials.baseUrl); } catch { throw new SpeechServiceError("INVALID_SPEECH_PROFILE", "这个档案的百炼地址无效。", 422); }
  const region = speechRegionForHost(url.hostname);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
    || !/^\/compatible-mode\/v1\/?$/.test(url.pathname) || !region) {
    throw new SpeechServiceError("INVALID_SPEECH_PROFILE", "语音只支持官方百炼 HTTPS 模型档案。", 422);
  }
  if (settings.region !== region) throw new SpeechServiceError("SPEECH_REGION_MISMATCH", "语音地域与这个模型档案的地域不一致。", 422);
  // 聊天档案可能使用专属 MaaS 域名；Qwen3-TTS 应走语音地域对应的 DashScope 接入域名。
  const ttsHost = settings.region === "beijing" ? "dashscope.aliyuncs.com" : "dashscope-intl.aliyuncs.com";
  return {
    asr: `${url.origin}/compatible-mode/v1/chat/completions`,
    tts: `https://${ttsHost}/api/v1/services/aigc/multimodal-generation/generation`,
  };
}

export function realtimeAsrUrl(credentials:SpeechProviderCredentials,settings:SpeechSettings):string {
  endpoints(credentials,settings); // 保留原档案和地域检查，不接受任意 WebSocket 地址。
  return `wss://${settings.region==='beijing'?'dashscope.aliyuncs.com':'dashscope-intl.aliyuncs.com'}/api-ws/v1/realtime?model=qwen3-asr-flash-realtime`;
}

/** 拒绝伪造扩展名和压缩容器；只接浏览器明确编码的 mono / 16 kHz / PCM16 WAV。 */
export function validateVoiceWav(source: Uint8Array): Buffer {
  const audio = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  if (audio.length > MAX_VOICE_AUDIO_BYTES) throw new SpeechServiceError("VOICE_AUDIO_TOO_LARGE", "录音超过 4 MiB，请缩短后重录。", 413);
  const invalid = () => { throw new SpeechServiceError("INVALID_VOICE_AUDIO", "请使用 16 kHz、单声道、PCM16 WAV 录音。"); };
  if (audio.length < 44 || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE" || audio.readUInt32LE(4) + 8 !== audio.length) invalid();
  let fmt = false; let dataBytes = 0; let offset = 12;
  for (; offset + 8 <= audio.length;) {
    const length = audio.readUInt32LE(offset + 4); const end = offset + 8 + length;
    if (end > audio.length) invalid();
    const name = audio.toString("ascii", offset, offset + 4);
    if (name === "fmt ") {
      if (fmt || length < 16 || audio.readUInt16LE(offset + 8) !== 1 || audio.readUInt16LE(offset + 10) !== 1 || audio.readUInt32LE(offset + 12) !== 16000 || audio.readUInt32LE(offset + 16) !== 32000 || audio.readUInt16LE(offset + 20) !== 2 || audio.readUInt16LE(offset + 22) !== 16) invalid();
      fmt = true;
    }
    if (name === "data") { if (dataBytes || !length || length % 2) invalid(); dataBytes = length; }
    offset = end + (length % 2);
    if (offset > audio.length) invalid();
  }
  if (!fmt || !dataBytes || offset !== audio.length) invalid();
  if (dataBytes / 32000 > MAX_VOICE_SECONDS) throw new SpeechServiceError("VOICE_AUDIO_TOO_LONG", "每次录音最多 120 秒，请分段练习。", 413);
  return audio;
}

async function readBounded(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new SpeechServiceError("SPEECH_RESPONSE_TOO_LARGE", "语音服务返回内容过大。", 502); }
  const reader = response.body?.getReader();
  if (!reader) throw new SpeechServiceError("EMPTY_SPEECH_RESPONSE", "语音服务没有返回内容。", 502);
  const chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read(); signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new SpeechServiceError("SPEECH_RESPONSE_TOO_LARGE", "语音服务返回内容过大。", 502); }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}

function jsonBody(bytes: Buffer): Record<string, unknown> {
  try { const result: unknown = JSON.parse(bytes.toString("utf8")); if (result && typeof result === "object" && !Array.isArray(result)) return result as Record<string, unknown>; } catch { /* 不把上游响应原文或 Key 送进用户错误信息。 */ }
  throw new SpeechServiceError("INVALID_SPEECH_RESPONSE", "语音服务返回格式无效。", 502);
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

function allowedAudioUrl(value: unknown, region: SpeechSettings["region"]): URL {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new SpeechServiceError("INVALID_SPEECH_AUDIO_URL", "语音服务没有返回有效音频地址。", 502); }
  // 官方返回示例可能使用 HTTP scheme；先核对精确白名单，再强制 HTTPS。
  // 服务端始终只请求 HTTPS，不接受任意 OSS bucket、凭据、显式端口或重定向。
  const pattern = region === "beijing" ? /^dashscope-result-(?:bj|wlcb)\.oss-cn-(?:beijing|wulanchabu)\.aliyuncs\.com$/ : /^dashscope-result-[a-z0-9-]+\.oss-ap-southeast-1\.aliyuncs\.com$/;
  const authority = String(value).match(/^https?:\/\/([^/?#]+)/i)?.[1] ?? "";
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port || authority.includes(":") || !pattern.test(url.hostname)) throw new SpeechServiceError("INVALID_SPEECH_AUDIO_URL", "语音服务返回了不受支持的音频地址。", 502);
  url.protocol = "https:";
  return url;
}

export class SpeechService implements SpeechServiceLike {
  private settings: SpeechSettings = { ...DEFAULT_SPEECH_SETTINGS };
  private hasSavedSettings = false;
  private loaded?: Promise<void>;
  private readonly cache = new Map<string, SpeechAudio>();
  private cacheBytes = 0;
  private cacheRevision = "";
  constructor(private readonly options: SpeechServiceOptions) {}

  async getPublicSettings(): Promise<PublicSpeechSettings> {
    await this.load();
    return this.hasSavedSettings ? { ...this.settings } : { ...this.settings, saved: false };
  }

  /** 只读本地配置，复用播放前的凭据/地域校验；不发起 ASR/TTS 或连接探测。
   * 失败仅返回状态，不将异常、档案身份、地址或 Key 送入模型上下文。
   */
  async getTeachingStatus(): Promise<SpeechConfigurationStatus> {
    try {
      const settings = await this.getPublicSettings();
      if (!settings.enabled) return "DISABLED";
      if (!settings.profileId) return "NOT_CONFIGURED";
      endpoints(await this.options.credentials.getSpeechCredentials(settings.profileId), settings);
      return "CONFIGURED";
    } catch (error) {
      return error instanceof ProviderSettingsError || error instanceof SpeechServiceError
        ? "NOT_CONFIGURED" : "UNKNOWN";
    }
  }
  async saveSettings(input: unknown): Promise<SpeechSettings> {
    await this.load(); const next = normalizeSettings(input);
    if (next.enabled && next.profileId) endpoints(await this.options.credentials.getSpeechCredentials(next.profileId), next);
    await mkdir(dirname(this.options.settingsPath), { recursive: true });
    const temporary = `${this.options.settingsPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.options.settingsPath);
    this.settings = next;
    this.hasSavedSettings = true;
    this.clearCache();
    return { ...next };
  }

  async transcribe(source: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<{ text: string }> {
    const audio = validateVoiceWav(source);
    return this.run(options.signal, async signal => {
      const { credentials, settings, urls } = await this.context();
      const response = await this.request(urls.asr, credentials.apiKey, {
        model: settings.asrModel,
        messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: `data:audio/wav;base64,${audio.toString("base64")}` } }] }],
        stream: false, asr_options: { enable_itn: false },
      }, signal);
      const result = jsonBody(await readBounded(response, MAX_JSON_BYTES, signal));
      const choices = result.choices;
      const text = Array.isArray(choices) ? object(object(choices[0]).message).content : undefined;
      if (typeof text !== "string" || text.length > 12000) throw new SpeechServiceError("INVALID_SPEECH_RESPONSE", "没有收到有效的识别文字，请重录。", 502);
      if (!text.trim()) throw new SpeechServiceError("NO_SPEECH_DETECTED", "没有识别到说话内容，请靠近麦克风重录。", 422);
      return { text: text.trim() };
    });
  }

  async synthesize(input: SpeechText, options: { signal?: AbortSignal; onAudio?:(pcm:Buffer)=>void } = {}): Promise<SpeechAudio> {
    if (!input.text.trim() || Array.from(input.text).length > 600 || !["en", "zh", "auto"].includes(input.language)) throw new SpeechServiceError("INVALID_SPEECH_TEXT", "每段朗读需要 1～600 字符及有效语言。");
    return this.run(options.signal, async signal => {
      const { credentials, settings, urls } = await this.context();
      const revision = createHash("sha256").update(JSON.stringify([credentials.revision, settings])).digest("hex");
      if (revision !== this.cacheRevision) { this.clearCache(); this.cacheRevision = revision; }
      const key = createHash("sha256").update(JSON.stringify([revision, input.text, input.language])).digest("hex");
      const cached = options.onAudio ? undefined : this.cache.get(key);
      if (cached) { this.cache.delete(key); this.cache.set(key, cached); return { audio: Buffer.from(cached.audio), contentType: cached.contentType }; }
      const response = await this.request(urls.tts, credentials.apiKey, {
        model: settings.ttsModel,
        input: { text: input.text, voice: settings.voice, language_type: { en: "English", zh: "Chinese", auto: "Auto" }[input.language] },
      }, signal, this.options.streamSynthesis === true);
      const incremental=options.onAudio?await readSpeechEvents(response,signal,options.onAudio):null;
      const bytes = incremental?Buffer.alloc(0):await readBounded(response, MAX_JSON_BYTES, signal);
      const payloads = incremental ?? (response.headers.get("content-type")?.includes("text/event-stream")
        ? bytes.toString("utf8").split(/\r?\n\r?\n/).flatMap(event => { const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n"); return !data || data === "[DONE]" ? [] : [jsonBody(Buffer.from(data))]; })
        : [jsonBody(bytes)]);
      const pieces: Buffer[] = []; let rawSize = 0; let audioUrl: unknown;
      for (const payload of payloads) {
        if (typeof payload.status_code === "number" && payload.status_code !== 200) throw new SpeechServiceError("SPEECH_PROVIDER_ERROR", "语音合成暂时不可用。", 502);
        const audio = object(object(payload.output).audio);
        if (audio.url) audioUrl = audio.url;
        if (typeof audio.data === "string" && audio.data) {
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(audio.data)) throw new SpeechServiceError("INVALID_SPEECH_RESPONSE", "语音服务返回音频格式无效。", 502);
          const piece = Buffer.from(audio.data, "base64"); rawSize += piece.length;
          if (rawSize > MAX_SYNTHESIS_BYTES) throw new SpeechServiceError("SPEECH_RESPONSE_TOO_LARGE", "合成语音过大。", 502);
          pieces.push(piece);
        }
      }
      let audio: Buffer;
      if (this.options.streamSynthesis && response.headers.get("content-type")?.includes("text/event-stream")) {
        const complete = incremental!==null || /(?:^|\n)data:\s*\[DONE\](?:\r?\n|$)/.test(bytes.toString("utf8"))
          || payloads.some(payload => object(payload.output).finish_reason === "stop");
        if (!complete) throw new SpeechServiceError("INCOMPLETE_SPEECH_RESPONSE", "合成语音没有完整结束。", 502);
      }
      if (this.options.streamSynthesis && pieces.length) {
        const pcm = Buffer.concat(pieces);
        audio = pcm.toString("ascii", 0, 4) === "RIFF" ? pcm : wavFromPcm(pcm);
      } else if (audioUrl) {
        const url = allowedAudioUrl(audioUrl, settings.region);
        const downloaded = await this.fetch(url, { signal, redirect: "error" });
        if (!downloaded.ok) throw new SpeechServiceError("SPEECH_DOWNLOAD_FAILED", "合成语音下载失败，请重试。", 502);
        audio = await readBounded(downloaded, MAX_SYNTHESIS_BYTES, signal);
      } else if (pieces.length) {
        const pcm = Buffer.concat(pieces);
        audio = pcm.toString("ascii", 0, 4) === "RIFF" ? pcm : wavFromPcm(pcm);
      } else throw new SpeechServiceError("EMPTY_SPEECH_RESPONSE", "语音服务没有返回音频。", 502);
      audio = normalizeSynthesisWav(audio);
      signal.throwIfAborted();
      const result: SpeechAudio = { audio, contentType: "audio/wav" };
      while (this.cacheBytes + audio.length > CACHE_BYTES && this.cache.size) { const first = this.cache.keys().next().value!; this.cacheBytes -= this.cache.get(first)!.audio.length; this.cache.delete(first); }
      this.cache.set(key, result); this.cacheBytes += audio.length;
      return { audio: Buffer.from(audio), contentType: result.contentType };
    });
  }

  private get fetch(): typeof fetch { return this.options.fetch ?? fetch; }
  private async load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        this.settings = normalizeSettings(JSON.parse(await readFile(this.options.settingsPath, "utf8")));
        this.hasSavedSettings = true;
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new SpeechServiceError("INVALID_SPEECH_SETTINGS", "语音设置文件无效，请检查后重试。", 422); }
    })();
    return this.loaded;
  }
  private async context() {
    await this.load(); const settings = { ...this.settings };
    if (!settings.enabled || !settings.profileId) throw new SpeechServiceError("SPEECH_DISABLED", "请先在设置中启用语音并选择百炼档案。", 422);
    const credentials = await this.options.credentials.getSpeechCredentials(settings.profileId);
    return { credentials, settings, urls: endpoints(credentials, settings) };
  }
  private async request(url: string, apiKey: string, body: unknown, signal: AbortSignal, stream=false): Promise<Response> {
    const response = await this.fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...(stream ? {"X-DashScope-SSE":"enable"} : {}) }, body: JSON.stringify(body), signal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      const status = response.status;
      throw new SpeechServiceError(status === 401 || status === 403 ? "SPEECH_AUTH_FAILED" : "SPEECH_PROVIDER_ERROR", status === 401 || status === 403 ? "语音认证失败，请检查所选百炼档案的 Key 与地域。" : "语音服务没有完成请求，请稍后重试。", status === 429 ? 429 : 502);
    }
    return response;
  }
  private async run<T>(external: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
    const signal = external ? AbortSignal.any([external, timeout]) : timeout;
    try { signal.throwIfAborted(); const result = await work(signal); signal.throwIfAborted(); return result; }
    catch (error) {
      if (external?.aborted) throw new SpeechServiceError("SPEECH_CANCELLED", "语音请求已取消。", 499);
      if (timeout.aborted) throw new SpeechServiceError("SPEECH_TIMEOUT", "语音服务超时，请稍后重试。", 504);
      if (error instanceof SpeechServiceError || error instanceof ProviderSettingsError) throw error;
      if (error instanceof SpeechStreamError) throw new SpeechServiceError(error.message.toUpperCase(), "流式语音格式或结束标记无效。", 502);
      throw new SpeechServiceError("SPEECH_NETWORK_ERROR", "无法连接语音服务，请检查网络后重试。", 502);
    }
  }
  private clearCache(): void { this.cache.clear(); this.cacheBytes = 0; this.cacheRevision = ""; }
}

function wavFromPcm(pcm: Buffer): Buffer {
  if (!pcm.length || pcm.length % 2) throw new SpeechServiceError("INVALID_SPEECH_RESPONSE", "语音服务返回音频格式无效。", 502);
  const header = Buffer.alloc(44); header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** 云端流式 WAV 会留下接近 INT32_MAX 的长度占位；完整下载后只修复该已知形状。 */
function normalizeSynthesisWav(source: Buffer): Buffer {
  const invalid = () => { throw new SpeechServiceError("INVALID_SPEECH_RESPONSE", "语音服务返回的音频无法播放。", 502); };
  if (source.length > MAX_SYNTHESIS_BYTES) throw new SpeechServiceError("SPEECH_RESPONSE_TOO_LARGE", "合成语音过大。", 502);
  if (source.length < 44 || source.toString("ascii", 0, 4) !== "RIFF" || source.toString("ascii", 8, 12) !== "WAVE") invalid();
  const audio = Buffer.from(source);
  let offset = 12; let blockAlign = 0; let dataLength = 0; let repaired = false;
  while (offset + 8 <= audio.length) {
    const name = audio.toString("ascii", offset, offset + 4);
    let length = audio.readUInt32LE(offset + 4);
    const remaining = audio.length - offset - 8;
    if (name === "data" && length > remaining && length >= 0x7fff0000) {
      if (!blockAlign) invalid();
      // 只有终端 PCM data 的流式占位可以按实际体积闭合；普通截断不能伪装成功。
      length = remaining; audio.writeUInt32LE(length, offset + 4); repaired = true;
    }
    if (length > remaining) invalid();
    if (name === "fmt ") {
      if (blockAlign || length < 16 || audio.readUInt16LE(offset + 8) !== 1 || audio.readUInt16LE(offset + 10) !== 1 || audio.readUInt16LE(offset + 22) !== 16) invalid();
      const rate = audio.readUInt32LE(offset + 12); blockAlign = audio.readUInt16LE(offset + 20);
      if (rate < 8000 || rate > 48000 || blockAlign !== 2 || audio.readUInt32LE(offset + 16) !== rate * blockAlign) invalid();
    }
    if (name === "data") {
      if (!blockAlign || dataLength || !length || length % blockAlign) invalid();
      dataLength = length;
    }
    offset += 8 + length + (length % 2);
  }
  if (!blockAlign || !dataLength || offset !== audio.length) invalid();
  if (repaired) audio.writeUInt32LE(audio.length - 8, 4);
  else if (audio.readUInt32LE(4) + 8 !== audio.length) invalid();
  return audio;
}
