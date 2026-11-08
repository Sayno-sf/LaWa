import "./studyTime.css";
import { StudyClock } from "./studyObservation";
import type { StudyInterval, StudyTimeSummary } from "../../src/studyTimeTypes.js";

const labels = { FOCUSED: "专注中", AWAY: "朝向偏离 · 暂停计时", NO_FACE: "未检测到人脸 · 暂停计时", UNKNOWN: "确认状态中 · 暂停计时", HIDDEN: "页面在后台 · 暂停计时" };
function duration(ms: number): string { const seconds = Math.floor(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }

/** 页面仅显示状态。视频在脱离DOM的元素中解码，图像只传入本机Worker，不进入网络请求。 */
export class StudyTimeView {
  private sid = "";
  private contextKey = "";
  private summary: StudyTimeSummary | null = null;
  private runId: string | null = null;
  private seq = 1;
  private packet: StudyInterval | null = null;
  private clock: StudyClock | null = null;
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private video: HTMLVideoElement | null = null;
  private captureTimer: number | null = null;
  private heartbeat: number | null = null;
  private busyFrame = false;
  private frameAt = 0;
  private loading = false;
  private stopping = false;
  private syncBroken = false;
  private error = "";
  private epoch = 0;
  private tail: Promise<void> = Promise.resolve();
  private readonly status: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  constructor(private readonly root: HTMLElement, private readonly waiting: () => boolean, private readonly eligible: () => boolean = () => true) {
    this.status = root.querySelector<HTMLElement>("[data-study-status]")!;
    this.toggle = root.querySelector<HTMLButtonElement>("[data-study-toggle]")!;
    const details = root.querySelector<HTMLDetailsElement>("details")!;
    const panel = root.querySelector<HTMLElement>(".study-time-panel")!;
    const trigger = details.querySelector<HTMLElement>("summary")!;
    const mobileShell = window.matchMedia("(max-width: 820px)");
    const composer = root.closest(".learning-stage")?.querySelector<HTMLElement>(".composer-wrap") ?? null;
    // 详情进入浏览器顶层，避免课堂滚动容器裁切；只展开显示，不改变观察或计时生命周期。
    const positionPanel = () => {
      if (!details.open) return;
      const anchor = trigger.getBoundingClientRect();
      panel.style.width = `${Math.min(320, window.innerWidth - 24)}px`;
      // 手机端输入栏常驻屏底：面板底部不压住它，空间不足时面板自己内部滚动。
      const composerTop = mobileShell.matches && composer && composer.offsetParent !== null ? composer.getBoundingClientRect().top : window.innerHeight;
      const bottomLimit = Math.min(window.innerHeight - 12, composerTop - 8);
      panel.style.maxHeight = mobileShell.matches ? `${Math.max(160, Math.min(window.innerHeight - 24, bottomLimit - 12))}px` : "";
      const box = panel.getBoundingClientRect();
      panel.style.left = `${Math.max(12, Math.min(anchor.right - box.width, window.innerWidth - box.width - 12))}px`;
      panel.style.top = `${Math.max(12, Math.min(anchor.bottom + 8, bottomLimit - box.height))}px`;
    };
    details.addEventListener("toggle", () => {
      if (typeof panel.showPopover === "function") {
        if (details.open) panel.showPopover(); else panel.hidePopover();
      }
      positionPanel();
    });
    document.addEventListener("pointerdown", event => { if (!root.contains(event.target as Node)) details.open = false; });
    document.addEventListener("keydown", event => { if (event.key === "Escape" && details.open) { details.open = false; trigger.focus(); } });
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, { capture: true, passive: true });
    window.addEventListener("hashchange", () => { details.open = false; });
    // 面板高度变化时，仍把它保持在窗口内。
    new ResizeObserver(positionPanel).observe(panel);
    this.toggle.addEventListener("click", () => { if (this.runId || this.loading) void this.stop(); else if (!this.summary?.scope && this.error) void this.refresh(); else void this.start(); });
    window.setInterval(() => { this.tick(); this.render(); }, 500);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) details.open = false;
      this.tick(); this.clock?.suspend(performance.now());
      void this.flush(); this.render();
    });
    window.addEventListener("pagehide", () => {
      this.tick(); this.releaseCamera();
      if (this.runId) navigator.sendBeacon("/api/web/study-time", new Blob([JSON.stringify({ op: "stop", runId: this.runId, sessionId: this.sid })], { type: "application/json" }));
      this.runId = null; this.clock = null; this.packet = null; this.render();
    });
    window.addEventListener("pageshow", event => { if (event.persisted) void this.refresh(); });
    this.render();
  }
  setContext(sessionId: string | null, key: string): void {
    if (!sessionId || (this.sid === sessionId && this.contextKey === key)) return;
    const changed = this.contextKey !== key;
    this.tick(); this.sid = sessionId; this.contextKey = key;
    if (changed) { this.summary = null; this.clock?.suspend(performance.now()); }
    // 对话ID只是查询入口。同Task换对话保持同一run；由服务器核对新Task并分段。
    if (this.runId) void this.flush(); else void this.refresh();
    this.render();
  }
  private async api<T>(body?: object, sid = this.sid): Promise<T> {
    const response = await fetch(body ? "/api/web/study-time" : `/api/web/study-time?sessionId=${encodeURIComponent(sid)}`, {
      ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, sessionId: sid }) } : {}), signal: AbortSignal.timeout(4000),
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.detail ?? "学习计时同步失败。"), { status: response.status });
    return result as T;
  }
  private async refresh(): Promise<void> {
    const sid = this.sid;
    try { const next = await this.api<StudyTimeSummary>(undefined, sid); if (sid === this.sid) { this.summary = next; this.error = ""; this.root.classList.remove("hidden"); } }
    catch (error) {
      if (sid === this.sid) {
        // 静态构建先于Gateway更新时保留原课堂，旧服务没有观察接口就暂不显示组件。
        if ((error as { status?: number }).status === 404) { this.root.classList.add("hidden"); this.error = ""; }
        else this.error = "学习计时暂时无法读取，稍后重试。";
      }
    }
    this.render();
  }
  private tick(): void { this.clock?.tick(performance.now(), this.waiting(), !document.hidden && !this.syncBroken && !!this.summary?.scope && this.eligible()); }
  flush(): Promise<void> {
    this.tail = this.tail.catch(() => undefined).then(async () => {
      if (!this.runId || !this.clock) return;
      this.tick();
      this.packet ??= { seq: this.seq, ...this.clock.take(), observation: this.clock.current(performance.now(), !document.hidden) };
      const sid = this.sid;
      try {
        const next = await this.api<StudyTimeSummary>({ op: "observe", runId: this.runId, ...this.packet }, sid);
        this.packet = null; this.seq++; this.syncBroken = false; this.error = "";
        if (sid === this.sid) this.summary = next;
        else void this.refresh();
      } catch (error) {
        this.syncBroken = true; this.clock.suspend(performance.now()); this.clock.take();
        this.error = (error as Error).message;
        if ((error as { status?: number }).status === 409) { this.runId = null; this.packet = null; this.releaseCamera(); }
      }
      this.render();
    });
    return this.tail;
  }
  private async start(): Promise<void> {
    if (this.loading || this.stopping || !this.summary?.scope) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { this.error = "摄像头需要 HTTPS 网页或 localhost，请通过安全地址打开。"; this.render(); return; }
    this.loading = true; this.error = ""; this.render(); const epoch = ++this.epoch;
    try {
      const marker = await fetch("/assets/study-camera/ready.txt", { cache: "no-cache", signal: AbortSignal.timeout(4000) });
      // 网关会为不存在的静态地址返回应用首页，须核对标记正文。
      const installed = marker.ok && (await marker.text()).trim() === "lawa-study-camera-v1";
      if (epoch !== this.epoch) return;
      if (!installed)
        throw new Error("摄像头模型尚未安装。请按照 README 安装可选摄像头资源并重新构建。");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" } });
      if (epoch !== this.epoch) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream;
      const video = document.createElement("video"); video.muted = true; video.playsInline = true; video.srcObject = stream; this.video = video; await video.play();
      if (epoch !== this.epoch) return;
      const worker = new Worker(new URL("./studyCamera.worker.ts", import.meta.url)); this.worker = worker;
      await new Promise<void>((resolve, reject) => {
        const deadline = window.setTimeout(() => reject(new Error("检测模型加载超时，请刷新后重试。")), 45000);
        worker.onerror = () => { clearTimeout(deadline); reject(new Error("摄像头检测无法启动，请刷新后重试。")); };
        worker.onmessage = event => {
          if (event.data.type === "ready") { clearTimeout(deadline); resolve(); }
          if (event.data.type === "error") { clearTimeout(deadline); reject(new Error(event.data.message)); }
        };
        worker.postMessage({ type: "init", wasmPath: new URL("/assets/study-camera/wasm", location.origin).href, modelPath: new URL("/assets/study-camera/face_landmarker.task", location.origin).href });
      });
      if (epoch !== this.epoch) return;
      const response = await this.api<StudyTimeSummary & { runId: string }>({ op: "start" });
      // 关闭/迟到授权时释放刚创建的服务器run，不能留下一条隐形活跃租约。
      if (epoch !== this.epoch) { await this.api({ op: "stop", runId: response.runId }); return; }
      this.summary = response; this.runId = response.runId; this.seq = 1; this.packet = null; this.syncBroken = false; this.clock = new StudyClock(performance.now());
      worker.onmessage = event => {
        if (event.data.type !== "observation") return;
        this.busyFrame = false; this.tick(); const now = performance.now();
        this.clock?.sample(now - this.frameAt <= 1500 ? event.data.observation : "UNKNOWN", now); this.render();
      };
      worker.onerror = () => { this.error = "摄像头检测中断，请重新开启。"; void this.stop(true); };
      stream.getVideoTracks().forEach(track => track.addEventListener("ended", () => { this.error = "摄像头已关闭，请重新开启。"; void this.stop(true); }));
      this.captureTimer = window.setInterval(() => void this.capture(), 500);
      this.heartbeat = window.setInterval(() => { if (!document.hidden) void this.flush(); }, 5000);
    } catch (error) {
      if (epoch === this.epoch) { this.error = (error as Error).name === "NotAllowedError" ? "摄像头权限未开启，请在浏览器站点权限中允许后重试。" : (error as Error).message; this.releaseCamera(); }
    } finally { if (epoch === this.epoch) this.loading = false; this.render(); }
  }
  private async capture(): Promise<void> {
    const video = this.video, worker = this.worker;
    if (document.hidden || !video || !worker || this.busyFrame || video.readyState < 2) return;
    this.busyFrame = true;
    try {
      const frame = await createImageBitmap(video, { resizeWidth: 480, resizeHeight: Math.round(480 * video.videoHeight / video.videoWidth) });
      if (worker !== this.worker) { frame.close(); return; }
      this.frameAt = performance.now(); worker.postMessage({ type: "frame", frame }, [frame]);
    } catch { this.busyFrame = false; this.clock?.sample("UNKNOWN", performance.now()); }
  }
  private releaseCamera(): void {
    if (this.captureTimer !== null) clearInterval(this.captureTimer); if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.captureTimer = this.heartbeat = null; this.worker?.terminate(); this.worker = null;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    if (this.video) this.video.srcObject = null; this.video = null; this.busyFrame = false;
  }
  private async stop(keepError = false): Promise<void> {
    if (this.stopping) return;
    ++this.epoch; this.loading = false; this.stopping = true; this.tick(); this.clock?.suspend(performance.now()); this.releaseCamera();
    const remembered = this.error;
    await this.flush();
    if (this.runId) {
      try { this.summary = await this.api<StudyTimeSummary>({ op: "stop", runId: this.runId }); }
      catch (error) { this.error = (error as Error).message; }
    }
    this.runId = null; this.clock = null; this.packet = null; this.stopping = false;
    if (keepError) this.error = remembered; this.render();
  }
  private render(): void {
    const observation = this.clock?.current(performance.now(), !document.hidden) ?? "UNKNOWN";
    const label = this.error ? this.runId ? "同步中断 · 暂停计时" : "观察未开启" : this.loading ? "正在开启摄像头观察…" : this.runId ? !this.summary?.scope ? "等待当前任务 · 暂停计时" : !this.eligible() ? "当前页面未计时" : this.waiting() && observation === "FOCUSED" ? "等待老师 · 单独记录" : labels[observation] : !this.summary?.scope ? "开始当前教学后，可开启摄像头观察。" : "摄像头观察未开启";
    if (this.status.textContent !== label) this.status.textContent = label;
    const compact = this.error ? "观察中断" : this.loading ? "正在开启…" : !this.runId ? "未开启"
      : !this.summary?.scope ? "等待任务" : !this.eligible() ? "回看 · 暂停"
      : this.waiting() && observation === "FOCUSED" ? "等待老师"
      : ({ FOCUSED: "专注中", AWAY: "偏离暂停", NO_FACE: "无人脸暂停", UNKNOWN: "确认中", HIDDEN: "后台暂停" } as const)[observation];
    const compactStatus = this.root.querySelector<HTMLElement>("[data-study-compact-status]")!;
    if (compactStatus.textContent !== compact) compactStatus.textContent = compact;
    this.root.querySelector("summary")!.setAttribute("aria-label", `学习观察，${compact}。查看状态与设置`);
    this.root.dataset.observation = this.runId && !this.error ? observation.toLowerCase() : "off";
    // 紧凑入口只表达当前显示状态；页面暂停/等待时不能沿用最近人脸线索显示「专注」。
    this.root.dataset.studyState = this.error ? "paused" : this.loading ? "loading" : !this.runId ? "off"
      : !this.summary?.scope || !this.eligible() || observation !== "FOCUSED" ? "paused"
      : this.waiting() ? "waiting" : "focused";
    this.toggle.textContent = this.stopping ? "停止中…" : this.runId || this.loading ? "停止观察" : !this.summary?.scope && this.error ? "重试读取" : "开启摄像头观察";
    this.toggle.disabled = this.stopping || (!this.runId && !this.loading && (!this.sid || (!this.summary?.scope && !this.error)));
    const pending = !this.syncBroken ? (this.clock?.pendingFocused() ?? 0) + (this.packet?.focusedMs ?? 0) : 0;
    this.root.querySelector("[data-study-task-time]")!.textContent = duration((this.summary?.taskFocusedMs ?? 0) + pending);
    this.root.querySelector("[data-study-run-time]")!.textContent = duration((this.summary?.runFocusedMs ?? 0) + pending);
    const headerTime = this.root.querySelector<HTMLElement>("[data-study-header-time]")!;
    headerTime.textContent = duration((this.summary?.runFocusedMs ?? 0) + pending); headerTime.hidden = !this.runId;
    headerTime.title = `本次专注 ${headerTime.textContent}`;
    this.root.querySelector("[data-study-goal-time]")!.textContent = duration(this.summary?.goalFocusedMs ?? 0);
    this.root.querySelector("[data-study-wait-time]")!.textContent = duration(this.summary?.taskWaitingMs ?? 0);
    const error = this.root.querySelector<HTMLElement>("[data-study-error]")!;
    if (this.error && error.textContent !== this.error) this.root.querySelector<HTMLDetailsElement>("details")!.open = true;
    error.textContent = this.error; error.hidden = !this.error;
  }
}
