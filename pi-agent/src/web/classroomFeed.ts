import {randomUUID} from "node:crypto";
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync} from "node:fs";
import {dirname, join} from "node:path";
import {mergeFigures,type PlacedFigure} from "../lessonFigureTypes.js";

export interface ClassroomRun {id: string; sessionId: string; status: "running" | "completed" | "interrupted"; text: string; textOmitted?: boolean;figures?:PlacedFigure[]}
export type ClassroomNotice = ({type: "run"; run: ClassroomRun} | {type: "event"; runId: string; sessionId: string; event: unknown} | {type: "changed"}) & {sequence: number};

// 公开展示流与提交连接分离；断开任一订阅不会取消教师或取得写入所有权。
export class ClassroomFeed {
  private listeners = new Set<(notice: ClassroomNotice) => void>();
  private current: ClassroomRun | null = null;
  private file?: string;
  sequence = 0;
  constructor(directory?: string) {
    if (!directory) return;
    this.file = join(directory, "classroom-run.json");
    if (!existsSync(this.file)) return;
    const saved = JSON.parse(readFileSync(this.file, "utf8"));
    if (!saved || typeof saved.id !== "string" || typeof saved.sessionId !== "string" || !["running", "completed", "interrupted"].includes(saved.status)) throw new Error("课堂运行记录不可读；请保留原文件后恢复。");
    this.sequence = Number.isSafeInteger(saved.sequence) && saved.sequence >= 0 ? saved.sequence + 1 : 1;
    const {sequence: _sequence, ...run} = saved;
    this.current = {...run, text: "", status: saved.status === "running" ? "interrupted" : saved.status};
    this.persist();
  }
  snapshot(): ClassroomRun | null {return this.current ? structuredClone(this.current) : null;}
  changed() {this.notify({type: "changed", sequence: ++this.sequence});}
  subscribe(listener: (notice: ClassroomNotice) => void): () => void {
    if (this.listeners.size >= 16) throw new Error("课堂查看连接过多，请关闭重复页面后重试。");
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  private notify(notice: ClassroomNotice) {
    for (const listener of this.listeners) {try {listener(notice);} catch {this.listeners.delete(listener);}}
  }
  private persist() {
    if (!this.file || !this.current) return;
    mkdirSync(dirname(this.file), {recursive: true});
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({...this.current, text: "", figures:undefined,sequence: this.sequence}) + "\n", {encoding: "utf8", mode: 0o600});
      renameSync(temporary, this.file);
    } finally {rmSync(temporary, {force: true});}
  }
  begin(sessionId: string): string {
    if (this.current?.status === "running") throw new Error("当前课堂正在生成，请等待本轮结束。");
    const previous = this.current;
    this.current = {id: randomUUID(), sessionId, status: "running", text: ""};
    this.sequence++;
    try {this.persist();} catch (error) {this.current = previous; this.sequence--; throw error;}
    this.notify({type: "run", run: this.snapshot()!, sequence: this.sequence}); return this.current.id;
  }
  event(sessionId: string, event: {type: string; delta?: string; routeChanged?: boolean;figures?:PlacedFigure[]}) {
    if (this.current?.status !== "running" || this.current.sessionId !== sessionId) return;
    // 自动进入补足分支后，先前流式文字已在消息投影中落盘；重连不能再次附到新分支。
    if (event.type === "conversation_update" && event.routeChanged) {
      this.current.text = ""; delete this.current.textOmitted; delete this.current.figures;
    }
    if (event.type === "assistant_delta" && event.delta) {
      const available = Math.max(0, 64_000 - this.current.text.length);
      this.current.text += event.delta.slice(0, available);
      if (event.delta.length > available) this.current.textOmitted = true;
    }
    if (event.type==="figures_ready" && event.figures) this.current.figures=mergeFigures(this.current.figures??[],event.figures);
    // 已由Gateway挑选的可见事件；隐藏思考从未进入此Interface。
    this.notify({type: "event", sessionId, runId: this.current.id, event, sequence: ++this.sequence});
  }
  finish(sessionId: string, completed: boolean) {
    if (this.current?.sessionId !== sessionId || this.current.status !== "running") return;
    this.current = {...this.current, status: completed ? "completed" : "interrupted"};
    this.sequence++;
    try {this.persist();} finally {this.notify({type: "run", run: this.snapshot()!, sequence: this.sequence});}
  }
}
