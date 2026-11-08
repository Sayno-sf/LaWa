import type { StudyObservation } from "../../src/studyTimeTypes.js";

interface Landmark { x: number; y: number; z?: number }
export function classifyStudyFace(faces: Landmark[][], blink: number): StudyObservation {
  if (faces.length !== 1) return faces.length ? "UNKNOWN" : "NO_FACE";
  const face = faces[0]!, nose = face[1], left = face[33], right = face[263];
  if (!nose || !left || !right || ![nose.x, left.x, right.x].every(Number.isFinite) || Math.abs(right.x - left.x) < 0.035) return "UNKNOWN";
  const ratio = Math.abs(nose.x - left.x) / (Math.abs(right.x - nose.x) + 1e-6);
  return ratio < 0.5 || ratio > 2 || blink > 0.85 ? "AWAY" : "FOCUSED";
}

/** 恢复需持续稳定2秒；偏离/无人脸立即停计。普通瞬时眨眼由 worker 过滤。 */
export class StudyFocusGate {
  private since: number | null = null;
  update(value: StudyObservation, now: number): StudyObservation {
    if (value !== "FOCUSED") { this.since = null; return value; }
    this.since ??= now;
    return now - this.since >= 2000 ? "FOCUSED" : "UNKNOWN";
  }
}

/** 单调时间与新鲜观察共同决定可计窗口，休眠/卡顿/旧检测不能补算。 */
export class StudyClock {
  observation: StudyObservation = "UNKNOWN";
  private seen = -Infinity;
  private last: number;
  private gate = new StudyFocusGate();
  private counts = { observedMs: 0, focusedMs: 0, waitingMs: 0 };
  constructor(now: number) { this.last = now; }
  tick(now: number, waiting: boolean, visible: boolean): void {
    const elapsed = now - this.last; this.last = now;
    if (elapsed < 0 || elapsed > 1500 || now - this.seen > 1800 || !visible) return;
    this.counts.observedMs += elapsed;
    if (this.observation === "FOCUSED") {
      if (waiting) this.counts.waitingMs += elapsed;
      else this.counts.focusedMs += elapsed;
    }
  }
  sample(value: StudyObservation, now: number): void { if (now - this.seen > 1800) this.gate = new StudyFocusGate(); this.seen = now; this.observation = this.gate.update(value, now); }
  current(now: number, visible: boolean): StudyObservation { return !visible ? "HIDDEN" : now - this.seen > 1800 ? "UNKNOWN" : this.observation; }
  suspend(now: number): void { this.last = now; this.seen = -Infinity; this.observation = "UNKNOWN"; this.gate = new StudyFocusGate(); }
  take(): { observedMs: number; focusedMs: number; waitingMs: number } { const c = this.counts; this.counts = { observedMs: 0, focusedMs: 0, waitingMs: 0 }; return c; }
  pendingFocused(): number { return this.counts.focusedMs; }
}
