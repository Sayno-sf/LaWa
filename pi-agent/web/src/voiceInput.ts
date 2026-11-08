import { icon } from "./icons";

export interface VoiceInputMetadata { source: "voice"; transcriptEdited: boolean; }
type VoiceState = "idle" | "requesting" | "recording" | "transcribing";
interface VoiceInputOptions {
  input: HTMLTextAreaElement;
  button: HTMLButtonElement;
  status: HTMLElement;
  canStart: () => boolean;
  isConfigured: () => boolean;
  onConfigure: () => void;
  sessionId: () => string | null;
  questionKey: () => string;
  beforeStart: () => void;
  onState: () => void;
  onError: (message: string) => void;
}
interface CaptureScope { sessionId: string; questionKey: string; value: string; start: number; end: number; scope?: string; }

/** 录音只产生可修改的输入草稿；所有异步完成均先检查最初的会话和题目。 */
export class VoiceInput {
  private state: VoiceState = "idle";
  private generation = 0;
  private controller: AbortController | null = null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private mute: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private sampleCount = 0;
  private startedAt = 0;
  private timer: number | undefined;
  private target: CaptureScope | null = null;
  private draftMetadata = new Map<string, { expected: string; edited: boolean }>();

  constructor(private readonly options: VoiceInputOptions) {
    options.button.addEventListener("click", () => {
      if (this.state === "recording") void this.finish();
      else if (this.state === "idle" && !options.isConfigured()) options.onConfigure();
      else if (this.state === "idle") void this.start();
    });
    window.addEventListener("pagehide", () => this.cancel());
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.cancel(); });
    document.addEventListener("keydown", event => { if (event.key === "Escape" && this.busy) this.cancel(); });
  }
  get busy(): boolean { return this.state !== "idle"; }
  get recording(): boolean { return this.state === "recording"; }
  private key(): string { return `${this.options.sessionId() ?? ""}:${this.options.questionKey()}`; }
  metadata(): VoiceInputMetadata | undefined {
    const value = this.draftMetadata.get(this.key());
    return value ? { source: "voice", transcriptEdited: value.edited || value.expected !== this.options.input.value } : undefined;
  }
  clearMetadata(questionKey = this.options.questionKey()): void { this.draftMetadata.delete(`${this.options.sessionId() ?? ""}:${questionKey}`); }

  sync(): void {
    const recording = this.state === "recording";
    this.options.button.disabled = this.state === "requesting" || this.state === "transcribing" || (!recording && !this.options.canStart());
    this.options.button.setAttribute("aria-label", recording ? "结束录音" : "语音输入");
    this.options.button.title = recording ? "结束录音，转写后可修改再发送" : !this.options.isConfigured() ? "先在设置中启用语音" : this.options.canStart() ? "语音输入，点击开始录音" : "切回当前学习后使用语音输入";
    this.options.button.setAttribute("aria-pressed", String(recording));
    this.options.button.dataset.state = this.state;
    this.options.button.innerHTML = icon(recording ? "stop" : "microphone");
  }
  private update(state: VoiceState, text = ""): void {
    this.state = state;
    this.options.status.textContent = text;
    this.options.status.hidden = !text;
    this.sync();
    this.options.onState();
  }
  private current(token: number, target: CaptureScope): boolean {
    return token === this.generation && this.options.sessionId() === target.sessionId && this.options.questionKey() === target.questionKey;
  }
  private release(): void {
    window.clearInterval(this.timer); this.timer = undefined;
    if (this.processor) { this.processor.onaudioprocess = null; this.processor.disconnect(); }
    this.source?.disconnect(); this.mute?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    if (this.context) void this.context.close().catch(() => undefined);
    this.stream = null; this.source = null; this.processor = null; this.mute = null; this.context = null;
  }
  cancel(): void {
    ++this.generation;
    this.controller?.abort(); this.controller = null;
    this.release(); this.chunks = []; this.sampleCount = 0; this.target = null;
    if (this.state !== "idle") this.update("idle");
  }
  private async start(): Promise<void> {
    const sessionId = this.options.sessionId();
    if (!sessionId || !this.options.canStart() || !this.options.isConfigured()) return;
    const input = this.options.input;
    const target: CaptureScope = { sessionId, questionKey: this.options.questionKey(), value: input.value, start: input.selectionStart, end: input.selectionEnd };
    const token = ++this.generation;
    this.target = target;
    this.options.beforeStart();
    this.update("requesting", "正在开启麦克风…");
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器不能录音。请通过本机 localhost 或 HTTPS 打开，并允许麦克风权限。");
      // 在用户点击内创建并恢复音频上下文，兼容手机浏览器的手势要求。
      const AudioContextClass = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) throw new Error("当前浏览器不支持录音，请换用新版浏览器。");
      const context = new AudioContextClass(); this.context = context;
      await context.resume();
      if (!this.current(token, target)) return;
      this.controller = new AbortController();
      // 录音开始就固定服务端任务锚点，不能在结束后领取新任务的权限。
      const scopeResponse = await fetch(`/api/web/sessions/${encodeURIComponent(target.sessionId)}/voice/scope`, { signal: this.controller.signal });
      if (!scopeResponse.ok) throw new Error(await responseError(scopeResponse, "当前录音位置不可用，请返回学习后重试。"));
      const { scope } = await scopeResponse.json() as { scope: string };
      target.scope = scope;
      if (!this.current(token, target)) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!this.current(token, target)) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      this.chunks = []; this.sampleCount = 0;
      const source = context.createMediaStreamSource(stream); this.source = source;
      // ScriptProcessor 输出浏览器解码后的 PCM；无需依赖 Safari 的 MP4 或 WebM 编码支持。
      const processor = context.createScriptProcessor(4096, 1, 1); this.processor = processor;
      const mute = context.createGain(); mute.gain.value = 0; this.mute = mute;
      processor.onaudioprocess = event => {
        if (this.state !== "recording" || !this.current(token, target)) return;
        const remaining = Math.floor(context.sampleRate * 120) - this.sampleCount;
        if (remaining <= 0) { void this.finish(); return; }
        const inputData = event.inputBuffer.getChannelData(0);
        const chunk = inputData.slice(0, remaining);
        this.chunks.push(chunk); this.sampleCount += chunk.length;
        if (this.sampleCount >= Math.floor(context.sampleRate * 120)) void this.finish();
      };
      source.connect(processor); processor.connect(mute); mute.connect(context.destination);
      stream.getAudioTracks().forEach(track => track.addEventListener("ended", () => {
        if (this.current(token, target) && this.state === "recording") { this.cancel(); this.options.onError("麦克风已中断，文字草稿已保留，请重新录音。"); }
      }));
      this.startedAt = Date.now();
      const label = () => `正在录音 ${Math.min(120, Math.floor((Date.now() - this.startedAt) / 1000))} 秒 · 再点麦克风结束`;
      this.update("recording", label());
      this.timer = window.setInterval(() => {
        if (this.state !== "recording") return;
        this.options.status.textContent = label();
        if (Date.now() - this.startedAt >= 120_000) void this.finish();
      }, 500);
    } catch (error) {
      if (!this.current(token, target)) return;
      this.cancel();
      const name = error instanceof DOMException ? error.name : "";
      this.options.onError(name === "NotAllowedError" ? "未获得麦克风权限。请在浏览器中允许麦克风，再重新录音。" : name === "NotFoundError" ? "没有可用的麦克风。请连接麦克风后重试。" : error instanceof Error ? error.message : "录音未能开始，请重试。");
    }
  }
  private async finish(): Promise<void> {
    const target = this.target;
    if (this.state !== "recording" || !target || !this.context) return;
    const token = this.generation;
    const sampleRate = this.context.sampleRate;
    const samples = new Float32Array(this.sampleCount);
    let offset = 0;
    for (const chunk of this.chunks) { samples.set(chunk, offset); offset += chunk.length; }
    this.release(); this.chunks = []; this.sampleCount = 0;
    this.update("transcribing", "正在转写，完成后可修改再发送…");
    this.controller = new AbortController();
    const signal = this.controller.signal;
    try {
      if (samples.length < sampleRate * 0.2 || !samples.some(sample => Math.abs(sample) > 0.003)) throw new Error("没有录到清晰的声音，请靠近麦克风再试一次。");
      if (!this.current(token, target)) return;
      const response = await fetch(`/api/web/sessions/${encodeURIComponent(target.sessionId)}/voice/transcriptions`, {
        method: "POST", headers: { "Content-Type": "audio/wav", "X-Voice-Scope": target.scope! }, body: pcmWav(samples, sampleRate), signal,
      });
      if (!response.ok) throw new Error(await responseError(response, "转写失败，文字草稿已保留，请重试录音。"));
      const result = await response.json() as { text: string };
      if (!this.current(token, target)) return;
      if (!result.text?.trim()) throw new Error("没有识别到内容，请重新录音。");
      const input = this.options.input;
      // 用户在等待期间修改过草稿时追加转写，绝不以旧选区覆盖新文字。
      const sameDraft = input.value === target.value;
      const start = sameDraft ? target.start : input.value.length;
      const end = sameDraft ? target.end : input.value.length;
      const transcript = `${!sameDraft && input.value ? "\n" : ""}${result.text.trim()}`;
      const previous = this.draftMetadata.get(this.key());
      const edited = Boolean(previous && (previous.edited || previous.expected !== input.value));
      input.setRangeText(transcript, start, end, "end");
      this.draftMetadata.set(this.key(), { expected: input.value, edited });
      input.dispatchEvent(new Event("input", { bubbles: true }));
      this.update("idle");
      input.focus({ preventScroll: true });
    } catch (error) {
      if (!this.current(token, target)) return;
      this.update("idle");
      if (!(error instanceof DOMException && error.name === "AbortError")) this.options.onError(error instanceof Error ? error.message : "转写失败，请重试。");
    } finally {
      if (token === this.generation) { this.controller = null; this.target = null; }
    }
  }
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({})) as { detail?: string };
  return typeof body.detail === "string" ? body.detail : fallback;
}

/** 将任意浏览器采样率的单声道 PCM 转为 16 kHz、16 bit WAV，最长 120 秒。 */
export function pcmWav(samples: Float32Array, sourceRate: number): Blob {
  const rate = 16_000;
  const length = Math.min(rate * 120, Math.floor(samples.length * rate / sourceRate));
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  write(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, "data"); view.setUint32(40, length * 2, true);
  // 区间平均降采样抑制高频混叠；输入低于 16 kHz 时改用线性插值。
  const ratio = sourceRate / rate;
  for (let i = 0; i < length; i++) {
    let value = 0;
    if (ratio >= 1) {
      const start = i * ratio, end = Math.min(samples.length, (i + 1) * ratio);
      for (let j = Math.floor(start); j < Math.ceil(end); j++) value += samples[j]! * (Math.min(j + 1, end) - Math.max(j, start));
      value /= end - start;
    } else {
      const position = i * ratio, left = Math.floor(position), mix = position - left;
      value = samples[left]! * (1 - mix) + (samples[Math.min(left + 1, samples.length - 1)] ?? 0) * mix;
    }
    value = Math.max(-1, Math.min(1, value));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}
