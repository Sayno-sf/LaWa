import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type Context,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";

import {
  buildSystemPrompt,
} from "./agentPolicy.js";
import { runCli, type CliAgentSession } from "./cli.js";
import { createLearningAgentTools } from "./learningAgentTools.js";
import { fetchLearningOverview } from "./learningOverviewTool.js";
import type { SubmitEvidenceInput } from "./learningWriteTools.js";
import { GoalOnboardingContext } from "./planning/goalOnboarding.js";
import { TeachingSessionContext } from "./teachingSession.js";

const PORT = 8124;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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

function messageText(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

function latestUserText(messages: Array<{ role?: string; content?: unknown }>): string {
  const latest = [...messages].reverse().find((message) => message.role === "user");
  return latest ? messageText(latest) : "";
}

async function waitForApi(process: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (process.exitCode !== null) {
      throw new Error(`Learning API exited early with code ${process.exitCode}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/api/learning/overview`);
      if (response.ok) return;
    } catch {
      // Uvicorn is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Timed out waiting for Sprint 4 Learning API");
}

function startApi(): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, LEARNING_STATE_PATH: ":memory:" };
  delete env.LEARNING_BOOTSTRAP;
  return spawn(
    process.env.PYTHON ?? "python",
    ["-m", "uvicorn", "app.api.main:app", "--host", "127.0.0.1", "--port", String(PORT)],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
}

async function* inputLines(values: string[]) {
  for (const value of values) yield value;
}

async function main(): Promise<void> {
  const api = startApi();
  try {
    await waitForApi(api);
    const initial = await fetchLearningOverview({ baseUrl: BASE_URL, log: () => undefined });
    assert.equal(initial.current_goal, null, "default product start must have no Goal");
    assert.deepEqual(initial.skills, [], "default product start must not seed CNN");

    const teaching = new TeachingSessionContext();
    const onboarding = new GoalOnboardingContext();
    // 与产品无 Goal 时的入口一致；旧 smoke 的 IDLE 草案如今会被确认守卫拒绝。
    onboarding.start();
    const faux = createFauxCore({ tokensPerSecond: 0 });
    let taskId = "";
    const callOrder: string[] = [];
    const goalProfile = {
      id: "goal-yolo-vision",
      goal_description: "系统学习目标检测并真正理解 YOLO",
      background_summary: "研究生，有数学基础，做过 AI 辅助的小目标检测项目",
      desired_outcome: "能够独立理解、修改并完成视觉检测项目",
      learning_preferences: ["项目实践为主", "核心视觉原理适当深入"],
      time_constraint: "每天一到两小时",
      prior_knowledge_claims: ["学过 CNN", "做过 YOLO 项目"],
    };
    const spine = [
      ["pytorch-vision", "PyTorch Vision Practice", "PRACTICAL"],
      ["cnn", "CNN", "PRACTICAL"],
      ["feature-hierarchy", "Feature Hierarchy", "PRACTICAL"],
      ["object-detection", "Object Detection Foundations", "DEEP"],
      ["detection-architecture", "Detection Architecture", "DEEP"],
      ["yolo", "YOLO", "DEEP"],
      ["detection-project", "Independent Detection Project", "PRACTICAL"],
    ].map(([id, name, target_depth]) => ({
      id: id!,
      name: name!,
      description: name!,
      target_depth: target_depth as "PRACTICAL" | "DEEP",
    }));

    faux.setResponses([
      // 当前无 Goal 已由入口确认；完整自然描述直接理解目标，不在规划时重复查旧状态。
      fauxAssistantMessage(
          fauxToolCall(
            "record_goal_understanding",
            { outcome: "READY_FOR_CONFIRMATION", profile: goalProfile },
            { id: "goal-ready" },
          ),
          { stopReason: "toolUse" },
        ),
      (context) => {
        toolResult(context, "record_goal_understanding");
        return fauxAssistantMessage(
          "我理解你的目标是独立完成视觉检测项目并真正理解 CNN、检测机制与 YOLO。你已有数学和项目背景，因此不从通用数学/Python 重学；采用项目实践为主、核心视觉原理深入的路线。这个 Goal Understanding 是否正确？",
        );
      },

      // A separate user confirmation unlocks structured initialization.
      fauxAssistantMessage(
        fauxToolCall("record_goal_understanding", { outcome: "CONFIRMED" }, { id: "goal-confirm" }),
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
                  id: "feature-map",
                  name: "Feature Map",
                  description: "理解卷积输出的空间响应",
                  prerequisites: [],
                  target_depth: "PRACTICAL",
                },
              ],
              frontier: {
                focus_skill_id: "feature-map",
                supporting_skill_ids: [],
                reason: "已有项目自述先用于提高 diagnostic 难度，不视为 Evidence",
                target_depth: "PRACTICAL",
                suggested_learning_mode: "EXPLAIN",
                next_action: "完成 Feature Map diagnostic 与最小实现",
              },
              replace_existing: false,
            },
            { id: "goal-initialize" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        toolResult(context, "initialize_learning_goal");
        return fauxAssistantMessage(
          fauxToolCall("get_learning_overview", { scope: "route" }, { id: "plan-overview" }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        const overview = payload<{ recent_evidence: unknown[]; curriculum_spine: unknown[] }>(
          context,
          "get_learning_overview",
        );
        assert.equal(overview.curriculum_spine.length, 7);
        assert.equal("recent_evidence" in overview, false);
        return fauxAssistantMessage(
          "已建立 7 个粗粒度里程碑，当前只展开 Feature Map。Next Action 建议：完成 Feature Map diagnostic 与最小实现。回复“开始”后我再创建并激活任务。",
        );
      },

      // Explicit start: TODO creation and activation remain user-controlled.
      fauxAssistantMessage(fauxToolCall("get_learning_overview", {}, { id: "start-overview" }), {
        stopReason: "toolUse",
      }),
      (context) => {
        toolResult(context, "get_learning_overview");
        return fauxAssistantMessage(
          fauxToolCall(
            "create_learning_task",
            {
              title: "理解并实现 Feature Map",
              description: "解释空间响应并完成最小 Conv2d feature map 实现",
              related_skill_ids: ["feature-map"],
              expected_evidence_types: ["BUILD"],
            },
            { id: "task-create" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        taskId = payload<{ id: string; status: string }>(context, "create_learning_task").id;
        return fauxAssistantMessage(
          fauxToolCall("activate_learning_task", { task_id: taskId }, { id: "task-activate" }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        toolResult(context, "activate_learning_task");
        return fauxAssistantMessage(
          fauxToolCall(
            "record_teaching_turn",
            {
              active_skill_id: "feature-map",
              active_task_id: taskId,
              teaching_mode: "BUILD",
              outcome: "START",
              current_question: "请写一个最小 Conv2d 模块并说明输出为什么是一组 feature maps？",
            },
            { id: "teaching-start" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        toolResult(context, "record_teaching_turn");
        return fauxAssistantMessage(
          "这一轮只建立一个连贯主题：卷积核扫描输入，每个输出通道对应一张 feature map；空间位置保留了局部响应的位置。你已有 YOLO 项目经历，所以不从神经网络基础重讲。请先写一个最小 Conv2d 模块并说明输出为什么是一组 feature maps？",
        );
      },

      // Meaningful BUILD -> Evidence -> completion -> overview -> automatic future-only replan.
      () =>
        fauxAssistantMessage(
          fauxToolCall(
            "record_teaching_turn",
            {
              active_skill_id: "feature-map",
              active_task_id: taskId,
              teaching_mode: "BUILD",
              outcome: "CORRECT",
              current_question: "请写一个最小 Conv2d 模块并说明输出为什么是一组 feature maps？",
              candidate_evidence: {
                evidence_type: "BUILD",
                description: "独立实现最小 Conv2d 模块并正确解释输出通道与 feature map 的对应关系。",
                supporting_interaction_summary: "用户无提示完成实现与解释。",
              },
            },
            { id: "teaching-complete" },
          ),
          { stopReason: "toolUse" },
        ),
      (context) => {
        toolResult(context, "record_teaching_turn");
        const candidate = payload<{ candidate_evidence: SubmitEvidenceInput }>(
          context,
          "record_teaching_turn",
        ).candidate_evidence;
        return fauxAssistantMessage(
          fauxToolCall("submit_evidence", candidate, { id: "evidence-submit" }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        toolResult(context, "submit_evidence");
        callOrder.push("evidence");
        return fauxAssistantMessage(
          fauxToolCall("complete_learning_task", { task_id: taskId }, { id: "task-complete" }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        toolResult(context, "complete_learning_task");
        callOrder.push("complete");
        return fauxAssistantMessage(
          fauxToolCall("get_learning_overview", {}, { id: "post-task-overview" }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        const overview = payload<{ skills: Array<{ id: string; evidence_count: number }> }>(
          context,
          "get_learning_overview",
        );
        callOrder.push("overview");
        assert.equal(overview.skills.find(skill => skill.id === "feature-map")?.evidence_count, 1);
        return fauxAssistantMessage(
          fauxToolCall(
            "apply_curriculum_plan",
            {
              frontier: {
                focus_skill_id: "receptive-field",
                supporting_skill_ids: ["feature-map"],
                reason: "Feature Map BUILD 已形成，可扩展一个更深的空间范围主题",
                target_depth: "DEEP",
                suggested_learning_mode: "BUILD",
                next_action: "通过堆叠卷积实验观察 receptive field",
              },
              added_skills: [
                {
                  id: "receptive-field",
                  name: "Receptive Field",
                  description: "理解多层卷积看到的输入范围",
                  prerequisites: ["feature-map"],
                  target_depth: "DEEP",
                },
              ],
              depth_changes: [],
              prerequisite_additions: [],
              remove_skill_ids: [],
            },
            { id: "frontier-replan" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        toolResult(context, "apply_curriculum_plan");
        callOrder.push("replan");
        return fauxAssistantMessage(
          fauxToolCall("get_learning_overview", {}, { id: "final-overview" }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        const overview = payload<{
          current_frontier: { focus_skill_id: string };
          active_task: null;
          skills: Array<{ id: string; evidence_count: number }>;
        }>(context, "get_learning_overview");
        callOrder.push("final-overview");
        assert.equal(overview.current_frontier.focus_skill_id, "receptive-field");
        assert.equal(overview.active_task, null);
        assert.equal(overview.skills.find(skill => skill.id === "feature-map")?.evidence_count, 1);
        return fauxAssistantMessage(
          "Feature Map Evidence 已保留，Frontier 已调整到 Receptive Field。Next Action 建议：堆叠卷积实验。尚未创建或激活下一任务，等待你确认。",
        );
      },
    ]);

    const outputs: string[] = [];
    const modelErrors: string[] = [];
    const createSession = async (): Promise<CliAgentSession> => {
      const tools = createLearningAgentTools(
        teaching,
        { baseUrl: BASE_URL, log: () => undefined },
        onboarding,
      );
      const agent = new Agent({
        streamFn: faux.streamSimple,
        initialState: {
          systemPrompt: buildSystemPrompt(teaching.snapshot(), onboarding.snapshot()),
          model: faux.getModel(),
          tools: tools as unknown as AgentTool[],
        },
      });
      agent.subscribe(event => {
        if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") {
          modelErrors.push(event.message.errorMessage?.slice(0, 1200) ?? "model error");
        }
      });
      agent.beforeToolCall = async ({ toolCall, args, context }) => {
        const userText = latestUserText(context.messages);
        if (toolCall.name === "submit_evidence") {
          const evidence = args as SubmitEvidenceInput;
          return evidence.source === "interactive-teaching-session"
            ? teaching.validateEvidenceSubmission(evidence)
            : teaching.evidenceWriteGuard(evidence);
        }
        return undefined;
      };
      agent.afterToolCall = async ({ toolCall, isError }) => {
        if (toolCall.name === "submit_evidence" && !isError) {
          teaching.clearCandidateEvidence();
        }
        return undefined;
      };
      return {
        prompt: (text) => agent.prompt(text),
        dispose: () => agent.reset(),
      };
    };

    await runCli({
      args: [],
      lines: inputLines([
        "我是研究生，有数学基础。以前用 YOLO 做过小目标检测，但代码大部分由 AI 完成。我想真正理解 YOLO，以后独立完成视觉检测项目，每天一到两小时。",
        "对",
        "开始",
        "我独立写完最小 Conv2d 模块，运行结果正确，也能解释每个输出通道是一张 feature map。",
        "/exit",
      ]),
      context: teaching,
      planningContext: onboarding,
      createSession,
      write: (text) => outputs.push(text),
      userApiOptions: { baseUrl: BASE_URL },
    });

    assert.deepEqual(modelErrors, []);
    assert.deepEqual(callOrder, [
      "evidence",
      "complete",
      "overview",
      "replan",
      "final-overview",
    ]);
    const final = await fetchLearningOverview({ baseUrl: BASE_URL, log: () => undefined });
    assert.equal(final.current_frontier && (final.current_frontier as { focus_skill_id: string }).focus_skill_id, "receptive-field");
    assert.equal(final.active_task, null);
    assert.equal((final.recent_evidence as unknown[]).length, 1);
    assert.equal(
      (final.skills as Array<{ id: string; evidence_ids: string[] }>).find(
        (skill) => skill.id === "feature-map",
      )?.evidence_ids.length,
      1,
    );
    assert.ok(
      !(final.skills as Array<{ id: string }>).some((skill) => skill.id === "training-loop"),
      "prior claims must not seed hidden curriculum or Evidence",
    );
    console.log("[verify:sprint4] PASS Goal -> Spine -> Frontier -> Task -> Teaching -> Evidence -> Replan");
  } finally {
    api.kill();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[verify:sprint4] FAIL ${message}`);
  process.exitCode = 1;
});
