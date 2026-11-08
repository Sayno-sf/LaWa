import {createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type FauxResponseFactory} from "@earendil-works/pi-ai";
import {BEGIN_REPLY} from "../teacherTurn.js";

/** 旧业务夹具补上Web的无内容阶段切换；协议测试使用原始Faux，不使用此适配器。 */
export function createTeachingFaux(options: Parameters<typeof createFauxCore>[0]): ReturnType<typeof createFauxCore> {
  const core = createFauxCore(options), set = core.setResponses.bind(core);
  let queue: FauxResponseStep[] = [];
  const prepared = new WeakSet<object>();
  const next: FauxResponseFactory = async (...args) => {
    const step = queue.shift();
    if (!step) throw new Error("No scripted teaching response remains");
    const value = typeof step === "function" ? await step(...args) : step;
    set([next]);
    if (!prepared.has(value) && value.stopReason === "stop" && !value.content.some(p => p.type === "toolCall") && args[0].tools?.some(t => t.name === BEGIN_REPLY)) {
      prepared.add(value);
      queue.unshift(value);
      return fauxAssistantMessage(fauxToolCall(BEGIN_REPLY, {}), {stopReason: "toolUse"});
    }
    return value;
  };
  core.setResponses = responses => {queue = [...responses]; set([next]);};
  core.appendResponses = responses => {queue.push(...responses);};
  core.getPendingResponseCount = () => queue.length;
  return core;
}
