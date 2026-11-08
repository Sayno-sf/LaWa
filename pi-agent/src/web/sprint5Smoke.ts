import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type Context,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";

import type { LearningAgentSession, LearningAgentEvent } from "../agentSession.js";
import { createLearningAgentTools, LEARNING_AGENT_TOOL_NAMES } from "../learningAgentTools.js";
import type { LearningOverview } from "../learningOverviewTool.js";
import type { SubmitEvidenceInput } from "../learningWriteTools.js";
import { createGateway } from "./gateway.js";
import { WebSessionStore } from "./sessionStore.js";

const API_PORT = 8125;
const API_URL = `http://127.0.0.1:${API_PORT}`;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function toolResult(context: Context, name: string): ToolResultMessage {
  const result = [...context.messages]
    .reverse()
    .find(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolName === name,
    );
  assert.ok(result, `Missing ${name} result`);
  assert.equal(result.isError, false, `${name} failed`);
  return result;
}

function payload<T>(context: Context, name: string): T {
  const content = toolResult(context, name).content[0];
  assert.equal(content?.type, "text");
  return JSON.parse((content as { type: "text"; text: string }).text) as T;
}

async function waitForApi(api: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (api.exitCode !== null) throw new Error(`Learning API exited: ${api.exitCode}`);
    try {
      if ((await fetch(`${API_URL}/api/learning/overview`)).ok) return;
    } catch {
      // Uvicorn is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Timed out waiting for Sprint 5 Learning API");
}

function startApi(): ChildProcess {
  return spawn(
    process.env.PYTHON ?? "python",
    ["-m", "uvicorn", "app.api.main:app", "--host", "127.0.0.1", "--port", String(API_PORT)],
    {
      cwd: root,
      env: {
        ...process.env,
        LEARNING_BOOTSTRAP: "gradient-demo",
        LEARNING_STATE_PATH: ":memory:",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
}

async function main(): Promise<void> {
  const api = startApi();
  let gateway: ReturnType<typeof createGateway> | undefined;
  try {
    await waitForApi(api);
    // gradient-demo 是合成示例，默认没有 ACTIVE Task。Smoke 在独立端口显式
    // reopen + create + activate 自己的临时任务，不得把验收夹具混入用户学习历史。
    assert.equal(
      (
        await fetch(
          `${API_URL}/api/user/skills/learning-rate-and-optimization-pitfalls/reopen`,
          { method: "POST" },
        )
      ).status,
      200,
    );
    const createdTaskResponse = await fetch(`${API_URL}/api/learning/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Sprint 5 浏览器学习率验收",
        description: "在隔离验收环境比较两种学习率的损失曲线。",
        related_skill_ids: ["learning-rate-and-optimization-pitfalls"],
        expected_evidence_types: ["BUILD"],
      }),
    });
    assert.equal(createdTaskResponse.status, 201);
    const taskId = ((await createdTaskResponse.json()) as { id: string }).id;
    assert.equal(
      (
        await fetch(`${API_URL}/api/learning/tasks/${taskId}/activate`, {
          method: "POST",
        })
      ).status,
      200,
    );
    const faux = createFauxCore({ tokensPerSecond: 0 });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("get_learning_overview", {}, { id: "web-overview" }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const overview = payload<{ active_task: { id: string } }>(
          context,
          "get_learning_overview",
        );
        assert.equal(overview.active_task.id, taskId);
        return fauxAssistantMessage(
          "你当前在学习率实验。先比较 lr=0.1 与 lr=1.0 的损失曲线，再解释差异。",
        );
      },
      fauxAssistantMessage(
        fauxToolCall(
          "record_teaching_turn",
          {
            active_skill_id: "learning-rate-and-optimization-pitfalls",
            active_task_id: taskId,
            teaching_mode: "BUILD",
            outcome: "CORRECT",
            candidate_evidence: {
              evidence_type: "BUILD",
              description: "独立比较两种学习率的损失曲线并解释收敛与震荡差异。",
              supporting_interaction_summary: "用户在浏览器会话中完成学习率对比实验。",
            },
          },
          { id: "web-teaching" },
        ),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const candidate = payload<{ candidate_evidence: SubmitEvidenceInput }>(
          context,
          "record_teaching_turn",
        ).candidate_evidence;
        return fauxAssistantMessage(
          fauxToolCall("submit_evidence", candidate, { id: "web-evidence" }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        toolResult(context, "submit_evidence");
        return fauxAssistantMessage(
          fauxToolCall(
            "complete_learning_task",
            { task_id: taskId },
            { id: "web-task-complete" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        toolResult(context, "complete_learning_task");
        return fauxAssistantMessage(
          "实验结果已经进入学习记录，当前任务也已完成。接下来可以继续观察更小学习率为何收敛更慢。",
        );
      },
    ]);

    let agentCreationCount = 0;
    const store = new WebSessionStore({
      apiBaseUrl: API_URL,
      createAgent: async (teaching, onboarding, emit): Promise<LearningAgentSession> => {
        agentCreationCount += 1;
        const tools = createLearningAgentTools(
          teaching,
          { baseUrl: API_URL, log: () => undefined },
          onboarding,
        );
        const agent = new Agent({
          streamFn: faux.streamSimple,
          initialState: {
            systemPrompt: "Sprint 5 browser acceptance",
            model: faux.getModel(),
            tools: tools as unknown as AgentTool[],
          },
        });
        agent.beforeToolCall = async ({ toolCall, args }) => {
          if (toolCall.name === "submit_evidence") {
            return teaching.validateEvidenceSubmission(args as SubmitEvidenceInput);
          }
          return undefined;
        };
        agent.afterToolCall = async ({ toolCall, isError }) => {
          if (toolCall.name === "submit_evidence" && !isError) teaching.clearCandidateEvidence();
          return undefined;
        };
        agent.subscribe((event) => {
          let webEvent: LearningAgentEvent | undefined;
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "text_delta"
          ) {
            webEvent = { type: "assistant_delta", delta: event.assistantMessageEvent.delta };
          } else if (event.type === "tool_execution_start") {
            webEvent = { type: "tool_start", toolName: event.toolName };
          } else if (event.type === "tool_execution_end") {
            webEvent = {
              type: "tool_end",
              toolName: event.toolName,
              isError: event.isError,
            };
          }
          if (webEvent) emit(webEvent);
        });
        return {
          prompt: (text) => agent.prompt(text),
          abort: async () => agent.abort(),
          dispose: () => agent.reset(),
        };
      },
    });

    gateway = createGateway({ store });
    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");
    const address = gateway.address();
    assert.ok(address && typeof address === "object");
    const webUrl = `http://127.0.0.1:${address.port}`;

    const created = (await (
      await fetch(`${webUrl}/api/web/sessions`, { method: "POST" })
    ).json()) as { sessionId: string; state: { overview: LearningOverview } };
    assert.equal(created.state.overview.active_task !== null, true);

    const send = async (message: string) => {
      const response = await fetch(
        `${webUrl}/api/web/sessions/${created.sessionId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        },
      );
      assert.equal(response.status, 200);
      return response.text();
    };
    const first = await send("继续学习");
    assert.match(first, /assistant_delta/);
    assert.match(first, /get_learning_overview/);
    const second = await send("我完成了两种学习率的实验并解释了差异");
    assert.match(second, /submit_evidence/);
    assert.equal(agentCreationCount, 1, "browser turns must reuse one Pi Agent");

    const refreshed = (await (
      await fetch(`${webUrl}/api/web/sessions/${created.sessionId}/state`)
    ).json()) as { overview: LearningOverview };
    assert.ok(
      (refreshed.overview.recent_evidence as Array<{ description?: string }>).some((item) =>
        item.description?.includes("两种学习率"),
      ),
      "submitted Evidence must be visible in refreshed Web state",
    );
    assert.equal(
      refreshed.overview.active_task,
      null,
      "completed Task must be visible immediately in refreshed Web state",
    );

    const registry = [...LEARNING_AGENT_TOOL_NAMES];
    assert.ok(!registry.some((name) => /master|reopen|practice/i.test(name)));
    const mastered = await fetch(
      `${webUrl}/api/web/sessions/${created.sessionId}/skills/learning-rate-and-optimization-pitfalls/master`,
      { method: "POST" },
    );
    assert.equal(mastered.status, 200);
    const masteredState = (await mastered.json()) as { overview: LearningOverview };
    const masteredSkill = (masteredState.overview.skills as Array<{ id: string; status: string }>).find(
      (skill) => skill.id === "learning-rate-and-optimization-pitfalls",
    );
    assert.equal(masteredSkill?.status, "MASTERED_BY_USER");

    const reopened = await fetch(
      `${webUrl}/api/web/sessions/${created.sessionId}/skills/learning-rate-and-optimization-pitfalls/reopen`,
      { method: "POST" },
    );
    const reopenedState = (await reopened.json()) as { overview: LearningOverview };
    const reopenedSkill = (reopenedState.overview.skills as Array<{ id: string; status: string }>).find(
      (skill) => skill.id === "learning-rate-and-optimization-pitfalls",
    );
    assert.equal(reopenedSkill?.status, "PRACTICING");

    console.error("[Sprint 5] PASS Browser -> Pi -> Tool -> HTTP -> Kernel -> streamed state");
    console.error("[Sprint 5] PASS multi-turn session, Evidence refresh, Mastery and Reopen direct path");
  } finally {
    if (gateway) {
      gateway.close();
      if (gateway.listening) await once(gateway, "close");
    }
    api.kill();
    if (api.exitCode === null) await once(api, "exit");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
