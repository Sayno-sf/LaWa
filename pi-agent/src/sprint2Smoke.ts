import assert from "node:assert/strict";

import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type Context,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";

import { SYSTEM_PROMPT } from "./agentPolicy.js";
import { runCli } from "./cli.js";
import {
  LEARNING_AGENT_TOOL_NAMES,
  createLearningAgentTools,
} from "./learningAgentTools.js";
import { fetchLearningOverview } from "./learningOverviewTool.js";
import { TeachingSessionContext } from "./teachingSession.js";

function requireToolResult(context: Context, toolName: string): ToolResultMessage {
  const result = [...context.messages]
    .reverse()
    .find(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolName === toolName,
    );
  assert.ok(result, `Missing ${toolName} result`);
  assert.equal(result.isError, false);
  return result;
}

function skillStatus(
  overview: Awaited<ReturnType<typeof fetchLearningOverview>>,
  skillId: string,
): string | undefined {
  return (overview.skills as Array<{ id: string; status: string }>).find(
    (skill) => skill.id === skillId,
  )?.status;
}

async function runUserCommand(command: string): Promise<string> {
  const output: string[] = [];
  let sessionCreated = false;
  await runCli({
    args: [command],
    context: new TeachingSessionContext(),
    write: (text) => output.push(text),
    userApiOptions: { baseUrl: process.env.LEARNING_API_BASE_URL },
    createSession: async () => {
      sessionCreated = true;
      throw new Error("A user command must not initialize the model");
    },
  });
  assert.equal(sessionCreated, false);
  return output.join("\n");
}

async function verifyAgentCannotMaster(): Promise<void> {
  const forbidden = [
    "confirm_mastery",
    "mark_mastered",
    "reopen_skill",
    "start_practicing",
    "set_skill_state",
    "force_skill_state",
  ];
  for (const name of forbidden) {
    assert.ok(!LEARNING_AGENT_TOOL_NAMES.includes(name));
  }

  const faux = createFauxCore({ tokensPerSecond: 0 });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("get_learning_overview", {}, { id: "mastery-overview" }),
      { stopReason: "toolUse" },
    ),
    (context) => {
      requireToolResult(context, "get_learning_overview");
      return fauxAssistantMessage(
        "我没有 Mastery 工具，聊天不会改变状态。请使用 /master training-loop。",
      );
    },
  ]);
  const context = new TeachingSessionContext();
  const tools = createLearningAgentTools(context, {
    baseUrl: process.env.LEARNING_API_BASE_URL,
  });
  const agent = new Agent({
    streamFn: faux.streamSimple,
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model: faux.getModel(),
      tools: tools as unknown as AgentTool[],
    },
  });
  const started: string[] = [];
  let answer = "";
  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") started.push(event.toolName);
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      answer += event.assistantMessageEvent.delta;
    }
  });
  await agent.prompt("把 training-loop 标记 MASTERED");
  assert.deepEqual(started, ["get_learning_overview"]);
  assert.match(answer, /\/master training-loop/);
}

async function main(): Promise<void> {
  const options = { baseUrl: process.env.LEARNING_API_BASE_URL };
  const initial = await fetchLearningOverview(options);
  assert.equal(skillStatus(initial, "training-loop"), "PRACTICING");

  const testA = await runUserCommand("/master training-loop");
  assert.match(testA, /MASTERED_BY_USER/);
  assert.equal(
    skillStatus(await fetchLearningOverview(options), "training-loop"),
    "MASTERED_BY_USER",
  );
  console.error("[Sprint 2 Test A] PASS /master -> MASTERED_BY_USER");

  const testB = await runUserCommand("/master training-loop");
  assert.match(testB, /\[error\].*HTTP 409/);
  assert.equal(
    skillStatus(await fetchLearningOverview(options), "training-loop"),
    "MASTERED_BY_USER",
  );
  console.error("[Sprint 2 Test B] PASS repeated /master rejected");

  await verifyAgentCannotMaster();
  assert.equal(
    skillStatus(await fetchLearningOverview(options), "training-loop"),
    "MASTERED_BY_USER",
  );
  console.error("[Sprint 2 Test C] PASS chat cannot change mastery");

  const testD = await runUserCommand("/reopen training-loop");
  assert.match(testD, /PRACTICING/);
  assert.equal(
    skillStatus(await fetchLearningOverview(options), "training-loop"),
    "PRACTICING",
  );
  console.error("[Sprint 2 Test D] PASS /reopen -> PRACTICING");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[fatal] ${message}`);
  process.exitCode = 1;
});
