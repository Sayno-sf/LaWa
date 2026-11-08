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

import type { LearningAgentEvent, LearningAgentSession } from "../agentSession.js";
import { createLearningAgentTools } from "../learningAgentTools.js";
import type { LearningOverview } from "../learningOverviewTool.js";
import { validatePlanningToolRoute } from "../planning/planningPolicy.js";
import { createGateway } from "./gateway.js";
import { WebSessionStore } from "./sessionStore.js";

const API_PORT = 8126;
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
  throw new Error("Timed out waiting for Sprint 5 onboarding API");
}

function startApi(): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, LEARNING_STATE_PATH: ":memory:" };
  delete env.LEARNING_BOOTSTRAP;
  return spawn(
    process.env.PYTHON ?? "python",
    ["-m", "uvicorn", "app.api.main:app", "--host", "127.0.0.1", "--port", String(API_PORT)],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
}

async function main(): Promise<void> {
  const api = startApi();
  let gateway: ReturnType<typeof createGateway> | undefined;
  try {
    await waitForApi(api);
    // Faux 只固定模型的工具选择；Browser API、Tool、HTTP 与 Python Kernel 全部真实运行。
    // 因此这里验证的是新用户产品闭环，而不是绕过架构的 Mock 对话。
    const faux = createFauxCore({ tokensPerSecond: 0 });
    const goalProfile = {
      id: "goal-git-workflow",
      goal_description: "独立完成 GitHub 提交并理解分支、冲突、fork 与 clone",
      background_summary: "用过 git init 与 git commit，但远程流程主要依赖 AI",
      desired_outcome: "独立管理个人仓库并能参与 fork/PR 协作",
      learning_preferences: ["概念与真实仓库实践交错"],
      time_constraint: "每天一到两小时",
      prior_knowledge_claims: ["用过 git init", "用过 git commit"],
    };
    const spine = [
      ["git-mental-model", "Git 心智模型", "PRACTICAL"],
      ["local-history", "本地提交与历史", "PRACTICAL"],
      ["github-remote", "GitHub 远程同步", "PRACTICAL"],
      ["branch-and-merge", "分支与合并", "DEEP"],
      ["fork-and-pr", "Fork 与 Pull Request", "PRACTICAL"],
      ["conflict-and-recovery", "冲突与恢复", "DEEP"],
    ].map(([id, name, target_depth]) => ({
      id: id!,
      name: name!,
      description: name!,
      target_depth: target_depth as "PRACTICAL" | "DEEP",
    }));
    let taskId = "";
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "record_goal_understanding",
          { outcome: "READY_FOR_CONFIRMATION", profile: goalProfile },
          { id: "web-goal-ready" },
        ),
        { stopReason: "toolUse" },
      ),
      (context) => {
        toolResult(context, "record_goal_understanding");
        return fauxAssistantMessage(
          "我理解你希望独立完成 GitHub 工作流，并补齐分支、冲突、fork 与 clone。确认后我会建立路线。",
        );
      },
      fauxAssistantMessage(
        fauxToolCall("record_goal_understanding", { outcome: "CONFIRMED" }, { id: "web-goal-confirm" }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        toolResult(context, "record_goal_understanding");
        return fauxAssistantMessage(
          fauxToolCall(
            "initialize_learning_goal",
            {
              goal_profile: goalProfile,
              curriculum_spine: spine,
              frontier_skills: [
                {
                  id: "git-mental-model",
                  name: "Git 心智模型",
                  description: "理解工作区、暂存区、提交与 HEAD",
                  prerequisites: [],
                  target_depth: "PRACTICAL",
                },
              ],
              frontier: {
                focus_skill_id: "git-mental-model",
                supporting_skill_ids: [],
                reason: "远程与恢复操作都依赖对提交和指针的准确理解",
                target_depth: "PRACTICAL",
                suggested_learning_mode: "BUILD",
                next_action: "在真实小仓库中观察 add 与 commit 前后的状态",
              },
              replace_existing: false,
            },
            { id: "web-goal-initialize" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        toolResult(context, "initialize_learning_goal");
        return fauxAssistantMessage(
          "路线已建立。当前 Frontier 是 Git 心智模型；点击开始后进入真实仓库练习。",
        );
      },
      fauxAssistantMessage(fauxToolCall("get_learning_overview", {}, { id: "web-start-overview" }), {
        stopReason: "toolUse",
      }),
      (context) => {
        toolResult(context, "get_learning_overview");
        return fauxAssistantMessage(
          fauxToolCall(
            "create_learning_task",
            {
              title: "观察 Git 三区与一次提交",
              description: "在真实小仓库中比较 status 与 diff，并解释 add/commit 的作用",
              related_skill_ids: ["git-mental-model"],
              expected_evidence_types: ["BUILD"],
            },
            { id: "web-task-create" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        taskId = payload<{ id: string }>(context, "create_learning_task").id;
        return fauxAssistantMessage(
          fauxToolCall("activate_learning_task", { task_id: taskId }, { id: "web-task-activate" }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        toolResult(context, "activate_learning_task");
        return fauxAssistantMessage(
          fauxToolCall(
            "record_teaching_turn",
            {
              active_skill_id: "git-mental-model",
              active_task_id: taskId,
              teaching_mode: "BUILD",
              outcome: "START",
              current_question: "先修改一个文件，然后分别运行 git status 与 git diff，告诉我变化在哪里。",
            },
            { id: "web-teaching-start" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        toolResult(context, "record_teaching_turn");
        return fauxAssistantMessage(
          "先修改一个文件，然后分别运行 git status 与 git diff；把结果和你的解释发给我。",
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
            systemPrompt: "Sprint 5 browser onboarding acceptance",
            model: faux.getModel(),
            tools: tools as unknown as AgentTool[],
          },
        });
        // Goal 确认是 Human-in-the-loop 权限边界：即使 Faux 选错 Tool，
        // preflight 也会阻止它跳过确认或在 onboarding 中回到教学路线。
        agent.beforeToolCall = async ({ toolCall }) =>
          validatePlanningToolRoute(onboarding.snapshot(), toolCall.name);
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
    ).json()) as {
      sessionId: string;
      state: { overview: LearningOverview; onboarding: { status: string } };
    };
    assert.equal(created.state.overview.current_goal, null);
    assert.equal(created.state.onboarding.status, "NEEDS_CLARIFICATION");

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

    const described = await send(
      "我想独立完成 GitHub 提交，理解 fork、clone、分支和冲突，每天学习一到两小时。",
    );
    assert.match(described, /record_goal_understanding/);
    assert.match(described, /确认/);
    const initialized = await send("确认");
    assert.match(initialized, /initialize_learning_goal/);

    const planned = (await (
      await fetch(`${webUrl}/api/web/sessions/${created.sessionId}/state`)
    ).json()) as { overview: LearningOverview; onboarding: { status: string } };
    assert.match(planned.overview.current_goal ?? "", /GitHub/);
    assert.equal(planned.overview.curriculum_spine.length, 6);
    assert.equal(
      (planned.overview.current_frontier as { focus_skill_id?: string } | null)
        ?.focus_skill_id,
      "git-mental-model",
    );
    assert.equal(planned.overview.active_task, null);
    assert.equal(planned.onboarding.status, "INITIALIZED");

    const started = await send("开始");
    assert.match(started, /create_learning_task/);
    assert.match(started, /activate_learning_task/);
    assert.match(started, /record_teaching_turn/);
    const learning = (await (
      await fetch(`${webUrl}/api/web/sessions/${created.sessionId}/state`)
    ).json()) as { overview: LearningOverview };
    assert.equal(
      (learning.overview.active_task as { id?: string } | null)?.id,
      taskId,
    );
    const focus = (learning.overview.skills as Array<{ id: string; status: string }>).find(
      (skill) => skill.id === "git-mental-model",
    );
    assert.equal(focus?.status, "LEARNING");
    assert.equal(agentCreationCount, 1, "onboarding and teaching must reuse one Pi Session");

    console.error("[Sprint 5] PASS Web new user -> Goal -> Spine -> Frontier -> Task -> Teaching");
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
