import type {PlacedFigure} from "../../src/lessonFigureTypes";
export interface SharedRun {figures?:PlacedFigure[]; id: string; sessionId: string; status: "running" | "completed" | "interrupted"; text: string}
export interface SharedSnapshot {session: unknown; run: SharedRun | null; version: string | null; sequence: number}

// 只读订阅不触发恢复/激活API；页面断开只关闭自己的查看连接。
export class ClassroomClient {
  private events?: EventSource;
  private poll?: ReturnType<typeof setInterval>;
  private refreshing = false;
  private sequence = -1;
  private lastRefresh = 0;
  private refreshAgain = false;
  private snapshotPause = 0;
  private readRevision = 0;
  run: SharedRun | null = null;
  constructor(private readonly snapshot: (value: SharedSnapshot) => void,
              private readonly event: (value: {type: string; delta?: string; messages?: unknown; state?: unknown; request?: unknown; figures?:PlacedFigure[]}) => void) {}
  start() {
    this.connect();
    window.addEventListener("pagehide", () => {this.events?.close(); clearInterval(this.poll);});
    window.addEventListener("pageshow", event => {if (event.persisted) {this.connect(); void this.refresh();}});
  }
  private connect() {
    this.events?.close(); clearInterval(this.poll);
    this.events = new EventSource("/api/web/classroom/events");
    this.events.onmessage = message => {
      let value;
      try {value = JSON.parse(message.data);} catch {void this.refresh(); return;}
      if (value.type === "snapshot") {
        if (!Number.isSafeInteger(value.snapshot?.sequence) || value.snapshot.sequence < this.sequence) return;
        this.sequence = value.snapshot.sequence; this.run = value.snapshot.run;
        if (!this.snapshotPause) this.snapshot(value.snapshot);
        return;
      }
      if (!Number.isSafeInteger(value.sequence) || value.sequence <= this.sequence) return;
      if (value.sequence > this.sequence + 1) {void this.refresh(); return;}
      this.sequence = value.sequence;
      if (value.type === "changed") {void this.refresh(); return;}
      if (value.type === "run") {this.run = value.run; void this.refresh();}
      if (value.type === "event" && !this.snapshotPause && this.run?.id === value.runId) this.event(value.event);
    };
    this.poll = setInterval(() => {
      if (!document.hidden && (this.events?.readyState !== EventSource.OPEN || Date.now() - this.lastRefresh >= 30_000)) void this.refresh();
    }, 5000);
  }
  // 显式导航期间只暂停旧课堂投影。释放后重读权威现场，不缓存另一份学习状态。
  pauseSnapshots(): () => void {
    this.snapshotPause++; this.readRevision++;
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true; this.snapshotPause--; this.readRevision++;
      if (!this.snapshotPause) void this.refresh();
    };
  }
  async refresh() {
    if (this.snapshotPause) return;
    if (this.refreshing) {this.refreshAgain = true; return;}
    this.refreshing = true;
    this.lastRefresh = Date.now();
    const revision = this.readRevision;
    try {
      const response = await fetch("/api/web/classroom/snapshot");
      if (response.ok) {const value = await response.json() as SharedSnapshot; if (revision !== this.readRevision || this.snapshotPause || value.sequence < this.sequence) return; this.sequence = value.sequence; this.run = value.run; this.snapshot(value);}
    } catch { /* 断线不清空原课堂；连接恢复后重新取服务器状态。 */ }
    finally {this.refreshing = false; if (this.refreshAgain) {this.refreshAgain = false; void this.refresh();}}
  }
}
