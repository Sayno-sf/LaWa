/** 同一实例的阅读让位给现有前台模型工作；不串行化或重写原课堂的并发规则。 */
export class ReadingModelActivity {
  private foreground = 0;
  private background?: {controller: AbortController; done: Promise<void>};
  private idle = new Set<() => void>();
  constructor(private readonly yieldTimeoutMs = 1500) {}
  onIdle(callback: () => void): () => void {this.idle.add(callback); return () => {this.idle.delete(callback);};}
  get busy(): boolean {return this.foreground > 0 || Boolean(this.background);}
  async runForeground<T>(work: () => Promise<T>): Promise<T> {
    this.foreground++;
    try {
      const previous = this.background;
      if (previous) {
        previous.controller.abort(new Error("READING_FOREGROUND_PREEMPTED"));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {await Promise.race([previous.done, new Promise<void>(done => {timer = setTimeout(done, this.yieldTimeoutMs);})]);}
        finally {if (timer) clearTimeout(timer);}
      }
      // 即使第三方SDK没有及时响应取消，也不能让后台工作无限期阻挡学生请求。
      return await work();
    } finally {
      this.foreground--;
      if (!this.foreground) for (const callback of this.idle) {try {callback();} catch {}}
    }
  }
  async tryBackground<T>(work: (signal: AbortSignal) => Promise<T>): Promise<{ran: false} | {ran: true; value: T}> {
    if (this.busy) return {ran: false};
    const controller = new AbortController();
    let finish!: () => void;
    const current = {controller, done: new Promise<void>(done => {finish = done;})};
    this.background = current;
    try {return {ran: true, value: await work(controller.signal)};}
    finally {
      if (this.background === current) this.background = undefined;
      finish();
      if (!this.foreground) for (const callback of this.idle) {try {callback();} catch {}}
    }
  }
}

const activities = new Map<string, ReadingModelActivity>();
export function readingModelActivity(baseUrl = process.env.LEARNING_API_BASE_URL ?? "http://127.0.0.1:8000"): ReadingModelActivity {
  const key = baseUrl.replace(/\/$/, "");
  if (!activities.has(key)) activities.set(key, new ReadingModelActivity());
  return activities.get(key)!;
}
