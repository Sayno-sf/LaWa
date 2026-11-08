import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type Context,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";

import {
  createGetLearningOverviewTool,
  type LearningOverview,
} from "./learningOverviewTool.js";

const USER_PROMPT = "我现在应该学什么？";
const SYSTEM_PROMPT = `你是面向深度学习学习者的学习规划 Agent。
回答前必须调用 get_learning_overview，并根据真实状态给出一个明确、可执行的下一步。`;

function latestToolResult(context: Context): ToolResultMessage {
  const result = [...context.messages]
    .reverse()
    .find(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" &&
        message.toolName === "get_learning_overview",
    );
  if (!result) throw new Error("Pi did not return get_learning_overview output to the model");
  return result;
}

function parseOverview(result: ToolResultMessage): LearningOverview {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("Learning overview tool result has no text payload");
  return JSON.parse(text) as LearningOverview;
}

async function main(): Promise<void> {
  const faux = createFauxCore({ tokensPerSecond: 0 });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("get_learning_overview", {}, { id: "overview-1" }), {
      stopReason: "toolUse",
    }),
    (context) => {
      const overview = parseOverview(latestToolResult(context));
      const task = overview.active_task as
        | { title?: string; related_skill_ids?: string[] }
        | null;
      const action = task?.title ?? "继续推进当前 Active LearningTask";
      const focus = task?.related_skill_ids?.[0] ?? "当前主技能";
      return fauxAssistantMessage(
        `下一步：${action}。先围绕 ${focus} 完成一个最小可运行练习，并把结果记录为 Evidence。`,
      );
    },
  ]);

  const tool = createGetLearningOverviewTool({
    baseUrl: process.env.LEARNING_API_BASE_URL,
  });
  const agent = new Agent({
    streamFn: faux.streamSimple,
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model: faux.getModel(),
      // Pi Coding Agent tools carry one extra extension-context argument; Agent Core
      // invokes the same compatible execute contract without that unused argument.
      tools: [tool as unknown as AgentTool],
    },
  });

  let sawToolStart = false;
  let sawToolEnd = false;
  let finalAnswer = "";
  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      sawToolStart = true;
      console.error(`[trace] tool_start name=${event.toolName}`);
    } else if (event.type === "tool_execution_end") {
      sawToolEnd = !event.isError;
      console.error(
        `[trace] tool_end name=${event.toolName} status=${event.isError ? "error" : "success"}`,
      );
    } else if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      finalAnswer += event.assistantMessageEvent.delta;
    }
  });

  console.error(`[user] ${USER_PROMPT}`);
  await agent.prompt(USER_PROMPT);

  if (!sawToolStart || !sawToolEnd) {
    throw new Error("Expected Pi tool execution events were not observed");
  }
  if (!finalAnswer.trim()) throw new Error("Pi did not produce a final answer");
  if (faux.state.callCount !== 2) {
    throw new Error(`Expected two Pi model turns, received ${faux.state.callCount}`);
  }

  console.log(`[assistant] ${finalAnswer}`);
  console.error("[verify] Pi Agent loop completed: tool call -> HTTP API -> tool result -> final answer");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[fatal] ${message}`);
  process.exitCode = 1;
});
