import {createAssistantMessageEventStream, type Api, type AssistantMessage, type Model} from "@earendil-works/pi-ai";

/** 运行时等待消息：不调用模型、不生成工具请求，仍由SDK按正常assistant消息持久保存。 */
export function planningReadingWaitStream(model: Model<Api>, state: string) {
  const text = state === "BLOCKED" || state === "FAILED"
    ? "这份主要资料的全文阅读还有未解决的读取问题，学习路线尚未保存。我会先处理阅读问题；路线保存并由你确认开始后，再正式讲解、练习和记录学习表现。"
    : state === "UNAVAILABLE"
      ? "暂时无法确认主要资料的阅读进度，当前不开始正式教学。阅读状态恢复后，我会继续保存学习路线；你仍可补充学习目标或调整资料。"
      : "主要资料仍在完整阅读，学习路线尚未保存。这条消息不会取消正在进行的通读；完成后会接着生成路线，等你确认开始再正式教学、出题和记录表现。";
  const message: AssistantMessage = {role: "assistant", content: [{type: "text", text}], api: model.api,
    provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
  const stream = createAssistantMessageEventStream();
  stream.push({type: "start", partial: {...message, content: []}});
  stream.push({type: "text_start", contentIndex: 0, partial: {...message, content: [{type: "text", text: ""}]}});
  stream.push({type: "text_delta", contentIndex: 0, delta: text, partial: message});
  stream.push({type: "text_end", contentIndex: 0, content: text, partial: message});
  stream.push({type: "done", reason: "stop", message}); stream.end(message);
  return stream;
}
