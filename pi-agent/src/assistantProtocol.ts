import type {AgentMessage} from "@earendil-works/pi-agent-core";

const ROOTS = ["<｜｜DSML｜｜", "</｜｜DSML｜｜", "<||DSML||", "</||DSML||"];
const COMMANDS = ["calls", "invoke", "parameter"];

/** 只隔离供应商的序列化工具协议，不从自然语言猜测动作，更不执行正文中的调用。 */
export class AssistantProtocolFilter {
  private pending = "";
  detected = false;

  push(delta: string): string {
    if (this.detected) return "";
    this.pending += delta;
    let output = "";
    while (this.pending) {
      const start = this.pending.indexOf("<");
      if (start < 0) {output += this.pending; this.pending = ""; break;}
      output += this.pending.slice(0, start);
      this.pending = this.pending.slice(start);
      // 仅缓冲可能组成协议标记的短前缀；其余正文立即沿原生流送出。
      if (ROOTS.some(root => root.startsWith(this.pending))) break;
      const root = ROOTS.find(root => this.pending.startsWith(root));
      if (root) {
        const suffix = this.pending.slice(root.length);
        if (/^\s*(calls|invoke|parameter)(?=[\s>])/.test(suffix)) {
          this.detected = true; this.pending = ""; break;
        }
        const command = suffix.trimStart();
        if (suffix.length < 64 && COMMANDS.some(name => name.startsWith(command))) break;
      }
      output += this.pending[0];
      this.pending = this.pending.slice(1);
    }
    return output;
  }

  finish(): string {
    // 流在半个协议标记结束时也不能把已识别的协议前缀补回界面。
    if (this.pending.includes("DSML") && (ROOTS.some(root => root.startsWith(this.pending)) ||
        ROOTS.some(root => this.pending.startsWith(root) && COMMANDS.some(command => command.startsWith(this.pending.slice(root.length).trimStart())))))
      this.detected = true;
    const output = this.detected ? "" : this.pending;
    this.pending = "";
    return output;
  }
}

export function publicAssistantText(text: string): string {
  const filter = new AssistantProtocolFilter();
  return filter.push(text) + filter.finish();
}

/** 只整理下一次模型输入副本；原Pi消息、原生toolCall和用户所引用的文本保留。 */
export function projectAssistantProtocol<T extends AgentMessage>(messages: readonly T[]): T[] {
  return messages.map(message => {
    if (message.role !== "assistant") return message;
    const raw: unknown = message.content;
    // 老版本的摘要可能保存字符串正文，保留原格式并隔离供应商协议。
    if (typeof raw === "string") {
      const visible = publicAssistantText(raw);
      return visible === raw ? message : {...message, content: visible};
    }
    if (!Array.isArray(raw)) return message;
    const filter = new AssistantProtocolFilter();
    let lastText = -1;
    const content = message.content.map((part, index) => {
      if (part.type !== "text") return part;
      lastText = index;
      return {...part, text: filter.push(part.text)};
    });
    const tail = filter.finish();
    const last = content[lastText];
    if (last?.type === "text") last.text += tail;
    return filter.detected ? {...message, content} : message;
  });
}
