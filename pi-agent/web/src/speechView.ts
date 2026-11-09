import {FormSaveState} from "./formSaveState";
import { icon } from "./icons";
import { DEFAULT_SPEECH_SETTINGS, speechRegionForHost, type PublicSpeechSettings, type SpeechSettings } from "../../src/web/speechSettingsTypes";

export interface SpeechComponent {
  id: string;
  text: string;
  language: "en" | "zh" | "auto";
  purpose: "example" | "repeat" | "requested_reading";
  sourceSessionId: string;
  entryId: string;
}
export type { SpeechSettings } from "../../src/web/speechSettingsTypes";
interface SpeechProfile { id: string; name: string; provider: string; baseUrl: string; hasApiKey: boolean; }
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** 只接受服务端投影的语音组件；普通 Markdown 和聊天文字不能创建播放请求。 */
export function speechMarkup(component: SpeechComponent): string {
  const label = component.purpose === "requested_reading" ? "朗读" : component.purpose === "repeat" ? "跟读示范" : "语音示范";
  return `<section class="speech-example" data-speech-id="${escape(component.id)}" aria-label="${label}"><p class="speech-example-text"${component.language !== "auto" ? ` lang="${component.language}"` : ""}>${escape(component.text)}</p><div class="speech-example-actions"><button type="button" data-speech-action="play" aria-label="播放${label}" title="播放${label}">${icon("play")}<span>播放</span></button><button type="button" data-speech-action="rate" aria-label="播放速度，正常" title="切换正常或慢速">1.0×</button><span class="speech-example-status" role="status" aria-live="polite"></span></div></section>`;
}

/** 一个播放器负责全部示范，切换与录音都会取消未完成的合成和播放。 */
export class SpeechPlayer {
  private components = new Map<string, SpeechComponent>();
  private rates = new Map<string, number>();
  private cache = new Map<string, Blob>();
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private controller: AbortController | null = null;
  private currentId: string | null = null;
  private phase: "idle" | "loading" | "playing" = "idle";
  private errors = new Map<string, string>();
  private generation = 0;
  constructor(private readonly container: HTMLElement, private readonly canPlay: () => boolean, private readonly beforePlay: () => void) {
    container.addEventListener("click", event => {
      const button = (event.target as Element).closest<HTMLButtonElement>("[data-speech-action]");
      const id = button?.closest<HTMLElement>("[data-speech-id]")?.dataset.speechId;
      if (!button || !id || !this.components.has(id)) return;
      if (button.dataset.speechAction === "rate") {
        const rate = this.rates.get(id) === 0.8 ? 1 : 0.8;
        this.rates.set(id, rate);
        if (this.currentId === id && this.audio) this.audio.playbackRate = rate;
        this.sync();
      } else if (this.currentId === id) this.stop();
      else void this.play(id);
    });
    window.addEventListener("pagehide", () => this.stop());
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.stop(); });
  }
  mount(components: SpeechComponent[]): void {
    this.components = new Map(components.map(component => [component.id, component]));
    if (this.currentId && !this.components.has(this.currentId)) this.stop();
    this.sync();
  }
  sync(): void {
    this.container.querySelectorAll<HTMLElement>("[data-speech-id]").forEach(node => {
      const id = node.dataset.speechId!;
      const active = id === this.currentId;
      const play = node.querySelector<HTMLButtonElement>('[data-speech-action="play"]')!;
      play.disabled = !active && !this.canPlay();
      play.innerHTML = `${icon(active ? "stop" : "play")}<span>${active ? "停止" : "播放"}</span>`;
      play.setAttribute("aria-label", active ? "停止语音" : "播放语音示范");
      play.title = active ? "停止语音" : "播放；结束后可再次点击重放";
      play.setAttribute("aria-pressed", String(active));
      const rate = this.rates.get(id) ?? 1;
      const rateButton = node.querySelector<HTMLButtonElement>('[data-speech-action="rate"]')!;
      rateButton.textContent = `${rate.toFixed(1)}×`;
      rateButton.setAttribute("aria-label", `播放速度，${rate === 1 ? "正常" : "慢速"}`);
      rateButton.setAttribute("aria-pressed", String(rate !== 1));
      const status = node.querySelector<HTMLElement>(".speech-example-status")!;
      status.textContent = this.errors.get(id) ?? (active ? this.phase === "loading" ? "正在准备语音…" : "正在播放" : "");
      status.classList.toggle("speech-error", this.errors.has(id));
    });
  }
  stop(): void {
    ++this.generation;
    this.controller?.abort(); this.controller = null;
    if (this.audio) { this.audio.pause(); this.audio.removeAttribute("src"); this.audio.load(); }
    this.audio = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null; this.currentId = null; this.phase = "idle";
    this.sync();
  }
  invalidateCache(): void { this.stop(); this.cache.clear(); }
  private async play(id: string): Promise<void> {
    const component = this.components.get(id);
    if (!component || !this.canPlay()) return;
    this.beforePlay(); this.stop();
    const token = this.generation;
    this.currentId = id; this.phase = "loading"; this.errors.delete(id); this.sync();
    this.controller = new AbortController();
    try {
      let blob = this.cache.get(id);
      if (!blob) {
        // 首次点击才合成，历史回看或组件渲染本身不产生云调用。
        const response = await fetch("/api/web/speech/synthesize", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceSessionId: component.sourceSessionId, entryId: component.entryId, presentationId: component.id }), signal: this.controller.signal,
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as { detail?: string };
          throw new Error(typeof body.detail === "string" ? body.detail : "语音暂时无法播放，请稍后再点播放。");
        }
        blob = await response.blob();
        if (token !== this.generation) return;
        if (!blob.size) throw new Error("语音内容为空，请重新播放。");
        // 只保留本页最近少量音频；速度切换和重放不重复请求云服务。
        if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(id, blob);
      }
      if (token !== this.generation || !this.components.has(id)) return;
      this.objectUrl = URL.createObjectURL(blob);
      const audio = new Audio(this.objectUrl); this.audio = audio;
      audio.playbackRate = this.rates.get(id) ?? 1; audio.preservesPitch = true;
      audio.addEventListener("ended", () => { if (token === this.generation) this.stop(); });
      audio.addEventListener("error", () => { if (token === this.generation) { this.errors.set(id, "浏览器未能播放语音，请重新播放。"); this.stop(); } });
      await audio.play();
      if (token !== this.generation) return;
      this.phase = "playing"; this.sync();
    } catch (error) {
      if (token !== this.generation) return;
      this.errors.set(id, error instanceof DOMException && error.name === "NotAllowedError" ? "请再次点击播放，允许浏览器播放声音。" : error instanceof Error ? error.message : "语音播放失败，请重试。");
      this.stop();
    } finally { if (token === this.generation) this.controller = null; }
  }
}

export class SpeechSettingsView {
  settings: SpeechSettings = { ...DEFAULT_SPEECH_SETTINGS };
  private hasSavedSettings = false;
  private profiles: SpeechProfile[] = [];
  private loaded = false;
  private loading: Promise<void> | null = null;
  private readonly details = document.querySelector<HTMLDetailsElement>("#speech-settings")!;
  private readonly form = document.querySelector<HTMLFormElement>("#speech-settings-form")!;
  private readonly message = document.querySelector<HTMLElement>("#speech-settings-message")!;
  private readonly saveState = new FormSaveState(this.form, this.message);
  constructor(private readonly onChange: () => void, private readonly beforeSave: () => void) {
    this.details.addEventListener("toggle", () => { if (this.details.open && !this.loaded) void this.load(); });
    this.form.addEventListener("submit", event => { event.preventDefault(); void this.save(); });
  }
  get configured(): boolean { return this.settings.enabled && Boolean(this.settings.profileId); }
  open(): void { this.details.open = true; this.details.scrollIntoView({ block: "start", behavior: "smooth" }); }
  setProfiles(profiles: SpeechProfile[]): void { this.profiles = profiles; this.renderProfiles(); }
  private renderProfiles(): void {
    const select = this.form.elements.namedItem("profileId") as HTMLSelectElement;
    const selected = select.value || this.settings.profileId || "";
    const profiles = this.profiles.filter(profile => /aliyun|bailian|dashscope/i.test(profile.provider) || /^https:\/\/dashscope(?:-intl)?\.aliyuncs\.com(?:\/|$)/i.test(profile.baseUrl));
    select.replaceChildren(new Option(profiles.length ? "请选择百炼配置" : "请先在上方保存百炼模型配置", ""));
    for (const profile of profiles) select.add(new Option(profile.name, profile.id));
    if (selected && !profiles.some(profile => profile.id === selected)) select.add(new Option("已保存的语音配置（请核对）", selected));
    select.value = selected;
  }
  private renderSettings(): void {
    (this.form.elements.namedItem("enabled") as HTMLInputElement).checked = this.settings.enabled;
    for (const name of ["region", "asrModel", "ttsModel", "voice"] as const) {
      (this.form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value = this.hasSavedSettings ? this.settings[name] : "";
    }
    this.renderProfiles();
  }
  private defaultRegion(profileId: string | null): SpeechSettings["region"] {
    const profile = this.profiles.find(item => item.id === profileId);
    if (!profile) return DEFAULT_SPEECH_SETTINGS.region;
    try {
      return speechRegionForHost(new URL(profile.baseUrl).hostname) ?? DEFAULT_SPEECH_SETTINGS.region;
    } catch {
      return DEFAULT_SPEECH_SETTINGS.region;
    }
  }
  async load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const response = await fetch("/api/web/speech-settings");
        if (!response.ok) throw new Error("暂时无法读取语音设置，文字学习仍可继续。");
        const { saved, ...settings } = await response.json() as PublicSpeechSettings;
        this.settings = settings;
        this.hasSavedSettings = saved !== false;
        this.loaded = true;
        this.renderSettings();
        if (this.hasSavedSettings) this.saveState.markClean();
        else this.saveState.markClean("尚未保存语音设置", "initial");
        this.onChange();
      } catch (error) { this.saveState.error(error instanceof Error ? error.message : "语音设置读取失败，请稍后再打开。"); }
    })().finally(() => { this.loading = null; });
    return this.loading;
  }
  private async save(): Promise<void> {
    if (this.saveState.busy || !this.loaded) return;
    const data = new FormData(this.form);
    const profileId = String(data.get("profileId") ?? "") || null;
    const region = data.get("region");
    const modelField = (name: "asrModel" | "ttsModel" | "voice") =>
      String(data.get(name) ?? "").trim() || DEFAULT_SPEECH_SETTINGS[name];
    const settings: SpeechSettings = {
      enabled: data.get("enabled") === "on", profileId,
      region: region === "beijing" || region === "singapore" ? region : this.defaultRegion(profileId),
      asrModel: modelField("asrModel"), ttsModel: modelField("ttsModel"), voice: modelField("voice"),
    };
    if (settings.enabled && !settings.profileId) { this.saveState.error("请选择已保存的百炼配置，再启用语音。"); return; }
    this.beforeSave();
    if (!this.saveState.begin()) return;
    try {
      const response = await fetch("/api/web/speech-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
      if (!response.ok) { const body = await response.json().catch(() => ({})) as { detail?: string }; throw new Error(typeof body.detail === "string" ? body.detail : "语音设置未能保存，请重试。"); }
      this.settings = await response.json() as SpeechSettings;
      this.hasSavedSettings = true;
      this.renderSettings();
      this.onChange();
      this.saveState.success(this.settings.enabled ? "已保存 · 语音已启用" : "已保存 · 语音已关闭");
    } catch (error) { this.saveState.error(error instanceof Error ? error.message : "语音设置未能保存，请重试。"); }

  }
}
