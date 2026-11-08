import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
  createLearningAgentSession,
  type LearningAgentEvent,
} from "./agentSession.js";
import { runCli, type CliAgentSession } from "./cli.js";
import { TeachingSessionContext } from "./teachingSession.js";
import { GoalOnboardingContext } from "./planning/goalOnboarding.js";

function printAgentEvent(event: LearningAgentEvent): void {
  if (event.type === "assistant_delta") {
    process.stdout.write(event.delta);
  } else if (event.type === "tool_start") {
    console.error(`[trace] tool_start name=${event.toolName}`);
  } else if (event.type === "tool_end") {
    console.error(
      `[trace] tool_end name=${event.toolName} status=${event.isError ? "error" : "success"}`,
    );
  } else if (event.type === "output_limit") {
    console.error("[model:limit] 回答达到当前模型配置的最大输出 Tokens。");
  } else if (event.type === "model_error") {
    console.error(`[model:error] ${event.message}`);
  }
}

async function* terminalLines(): AsyncGenerator<string> {
  const terminal = readline.createInterface({ input, output });
  try {
    while (true) {
      try {
        yield await terminal.question("\n> ");
      } catch (error) {
        if ((error as { code?: string }).code === "ERR_USE_AFTER_CLOSE") return;
        throw error;
      }
    }
  } finally {
    terminal.close();
  }
}

async function main(): Promise<void> {
  const context = new TeachingSessionContext();
  const planningContext = new GoalOnboardingContext();
  const args = process.argv.slice(2);
  await runCli({
    args,
    lines: args.length === 0 ? terminalLines() : undefined,
    context,
    planningContext,
    showStartupContext: args.length === 0,
    createSession: async (): Promise<CliAgentSession> => {
      const session = await createLearningAgentSession(context, planningContext, {
        apiBaseUrl: process.env.LEARNING_API_BASE_URL,
        onEvent: printAgentEvent,
        log: (message) => console.error(message),
      });
      return {
        prompt: async (text) => {
          console.error(`[user] ${text}`);
          await session.prompt(text);
          process.stdout.write("\n");
        },
        dispose: () => session.dispose(),
      };
    },
    userApiOptions: { baseUrl: process.env.LEARNING_API_BASE_URL },
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[fatal] ${message}`);
  process.exitCode = 1;
});
