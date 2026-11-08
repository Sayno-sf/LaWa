import assert from "node:assert/strict";

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
import { TeachingSessionContext } from "./teachingSession.js";

const Q1 = "为什么卷积比全连接层更适合保留图像的空间结构？";
const Q1B = "如果目标从图像左侧移到右侧，参数共享为什么仍能检测同一种局部模式？";
const Q2 = "输入 [B,3,32,32] 经过 Conv2d(3,16,3,padding=1) 后 shape 是什么？";
const Q3 = "写一个最小 nn.Module：一层 Conv2d 后返回 feature map。";
const EXPLAIN_DESCRIPTION =
  "能够在方向提示后解释局部连接与参数共享，并说明卷积保留空间结构的原因。";
const BUILD_DESCRIPTION = "在获得完整 shape 参考答案后实现最小 Conv2d 模块并验证输出。";

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
  assert.ok(content, `${name} returned no text content`);
  assert.equal(content.type, "text");
  return JSON.parse((content as { type: "text"; text: string }).text) as T;
}

async function* inputLines(values: string[]) {
  for (const value of values) yield value;
}

function skillStatus(
  overview: Awaited<ReturnType<typeof fetchLearningOverview>>,
  id: string,
): string | undefined {
  return (overview.skills as Array<{ id: string; status: string }>).find(
    (skill) => skill.id === id,
  )?.status;
}

async function main(): Promise<void> {
  const httpOptions = { baseUrl: process.env.LEARNING_API_BASE_URL };
  const initial = await fetchLearningOverview(httpOptions);
  assert.equal(initial.active_task, null);
  assert.equal(skillStatus(initial, "cnn"), "NOT_STARTED");
  assert.ok(
    (initial.recent_evidence as Array<{ skill_id: string; assistance_level: string }>).some(
      (item) =>
        item.skill_id === "training-loop" && item.assistance_level === "INDEPENDENT",
    ),
  );

  const faux = createFauxCore({ tokensPerSecond: 0 });
  let createdTaskId = "";
  let nextTaskId = "";
  let sawEarlierTurn = false;
  const recordTurn = (id: string, args: Record<string, unknown>) =>
    (_context: Context) =>
      fauxAssistantMessage(
        fauxToolCall(
          "record_teaching_turn",
          { ...args, active_task_id: createdTaskId },
          { id },
        ),
        { stopReason: "toolUse" },
      );
  faux.setResponses([
    // Turn 1: generic start with no prior proposal must only suggest one task.
    fauxAssistantMessage(
      fauxToolCall("get_learning_overview", {}, { id: "proposal-overview" }),
      { stopReason: "toolUse" },
    ),
    (context) => {
      toolResult(context, "get_learning_overview");
      return fauxAssistantMessage(
        "当前没有 ACTIVE Task。Next Action 建议：CNN Feature Map 输出形状练习。回复“开始”后我再创建并激活任务；这一轮不直接教学。",
      );
    },

    // Turn 2: confirmation creates/activates, then Learning Mode diagnoses one point.
    fauxAssistantMessage(fauxToolCall("get_learning_overview", {}, { id: "t1-overview" }), {
      stopReason: "toolUse",
    }),
    (context) => {
      toolResult(context, "get_learning_overview");
      return fauxAssistantMessage(
        fauxToolCall(
          "create_learning_task",
          {
            title: "理解 CNN Feature Map",
            description: "解释局部连接与参数共享，推导卷积输出 shape，并完成最小 Conv2d BUILD。",
            related_skill_ids: ["cnn"],
            expected_evidence_types: ["EXPLAIN", "BUILD"],
          },
          { id: "t1-create" },
        ),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      createdTaskId = payload<{ id: string }>(context, "create_learning_task").id;
      return fauxAssistantMessage(
        fauxToolCall(
          "activate_learning_task",
          { task_id: createdTaskId },
          { id: "t1-activate" },
        ),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      toolResult(context, "activate_learning_task");
      return fauxAssistantMessage(
        fauxToolCall(
          "record_teaching_turn",
          {
            active_skill_id: "cnn",
            active_task_id: createdTaskId,
            teaching_mode: "EXPLAIN",
            outcome: "START",
            current_question: Q1,
          },
          { id: "t1-teaching" },
        ),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      toolResult(context, "record_teaching_turn");
      return fauxAssistantMessage(
        `你已经能独立写 training/validation loop，这里不重复训练循环。我们先用一个点判断你对 CNN 的起点：普通全连接层会把二维像素拉平，而卷积核在局部窗口上滑动。\n\n${Q1}`,
      );
    },

    // Partial answer: Teacher chooses a useful light hint instead of following a fixed ladder.
    (context) => {
      sawEarlierTurn = context.messages.some(
        (message) => message.role === "user" && JSON.stringify(message).includes("开始"),
      );
      return fauxAssistantMessage(
        fauxToolCall(
          "record_teaching_turn",
          {
            active_skill_id: "cnn",
            active_task_id: createdTaskId,
            teaching_mode: "QUIZ",
            outcome: "PARTIAL",
            current_question: Q1,
            key_gap: "参数共享",
            hint_level: 1,
          },
          { id: "t2-partial" },
        ),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      assert.equal(payload<{ hint_level: number }>(context, "record_teaching_turn").hint_level, 1);
      return fauxAssistantMessage(
        "你说对了局部连接会保留邻近关系。还缺一个关键点：参数共享。只补这一点后重试。",
      );
    },

    // Turn 3: keep the batch open; Evidence is formed only after the follow-up answer.
    recordTurn("t3-correct", {
          active_skill_id: "cnn",
          teaching_mode: "QUIZ",
          outcome: "CORRECT",
          current_question: Q1,
    }),
    (context) => {
      const recorded = payload<{
        candidate_evidence: SubmitEvidenceInput | null;
      }>(context, "record_teaching_turn");
      assert.equal(recorded.candidate_evidence, null);
      return fauxAssistantMessage(
        fauxToolCall(
          "record_teaching_turn",
          {
            active_skill_id: "cnn",
            active_task_id: createdTaskId,
            teaching_mode: "QUIZ",
            outcome: "START",
            current_question: Q1B,
          },
          { id: "t3-boundary" },
        ),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      toolResult(context, "record_teaching_turn");
      return fauxAssistantMessage(
        `第一点已补全，但还只是一个知识检查，尚不记录 Evidence。补充一个重要联系：参数共享不仅减少参数量，也让同一个局部检测器可以跨位置复用；这正是卷积具有平移等变性的直观来源。\n\n再做一个边界检查：${Q1B}`,
      );
    },

    // Turn 4: a second distinct check makes the segment meaningful; help remains WITH_HINT.
    recordTurn("t4-boundary-correct", {
          active_skill_id: "cnn",
          teaching_mode: "QUIZ",
          outcome: "CORRECT",
          current_question: Q1B,
          candidate_evidence: {
            evidence_type: "EXPLAIN",
            description: EXPLAIN_DESCRIPTION,
            supporting_interaction_summary: "首次回答遗漏参数共享，经提示补全后又完成一个位移边界检查。",
          },
    }),
    (context) => {
      const recorded = payload<{
        candidate_evidence: SubmitEvidenceInput;
      }>(context, "record_teaching_turn");
      assert.equal(recorded.candidate_evidence.assistance_level, "WITH_HINT");
      return fauxAssistantMessage(
        fauxToolCall("submit_evidence", recorded.candidate_evidence, { id: "t4-evidence" }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      toolResult(context, "submit_evidence");
      return fauxAssistantMessage(
        fauxToolCall(
          "record_teaching_turn",
          {
            active_skill_id: "cnn",
            active_task_id: createdTaskId,
            teaching_mode: "QUIZ",
            outcome: "START",
            current_question: Q2,
          },
          { id: "t4-next" },
        ),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      toolResult(context, "record_teaching_turn");
      return fauxAssistantMessage(
        `已记录这段学习证据。接下来把概念落到 shape：单个空间维度的输出大小是 floor((输入 + 2×padding - kernel) / stride) + 1。例如输入 5、kernel 3、padding 1、stride 1 时，输出仍是 5；输出通道数则由卷积核组数决定。\n\n现在用同一规则推导：${Q2}`,
      );
    },

    // Repeated failures retain context, while Teacher can vary help depth based on each answer.
    ...[3, 1, 2, 4, 2].map((chosenHint, index) => [
      recordTurn(`hint-${index}`, {
            active_skill_id: "cnn",
            teaching_mode: "QUIZ",
            outcome: "INCORRECT",
            current_question: Q2,
            key_gap: "padding 保持空间尺寸",
            hint_level: chosenHint,
      }),
      (context: Context) => {
        const result = payload<{ hint_level: number }>(
          context,
          "record_teaching_turn",
        );
        assert.equal(result.hint_level, chosenHint);
        return fauxAssistantMessage(
          `这次回答暴露的问题不同，所以我选择帮助强度 ${result.hint_level}，补充 padding 与空间尺寸的关系。`,
        );
      },
    ]).flat(),

    // Turn 10: explicit direct-answer request remains level 4.
    recordTurn("direct-answer", {
          active_skill_id: "cnn",
          teaching_mode: "QUIZ",
          outcome: "DIRECT_ANSWER_REQUEST",
          current_question: Q2,
          key_gap: "padding 保持空间尺寸",
    }),
    (context) => {
      assert.equal(payload<{ hint_level: number }>(context, "record_teaching_turn").hint_level, 4);
      return fauxAssistantMessage(
        "答案是 [B,16,32,32]。padding=1 抵消 kernel_size=3 带来的边缘收缩。",
      );
    },

    // Turn 11: BUILD gives only a target, not a full implementation.
    recordTurn("build-start", {
          active_skill_id: "cnn",
          teaching_mode: "BUILD",
          outcome: "START",
          current_question: Q3,
    }),
    (context) => {
      toolResult(context, "record_teaching_turn");
      return fauxAssistantMessage(
        `你已经看过局部连接、参数共享和 shape 规则，现在把它们落到一个最小模块。BUILD 目标：${Q3} 输入为 [B,3,32,32]，输出应为 [B,16,32,32]；完成标准是能前向运行并打印实际 shape。请先贴你的实现。`,
      );
    },

    // Turn 12: meaningful BUILD evidence -> complete -> overview -> suggestion -> stop.
    recordTurn("build-correct", {
          active_skill_id: "cnn",
          teaching_mode: "BUILD",
          outcome: "CORRECT",
          current_question: Q3,
          candidate_evidence: {
            evidence_type: "BUILD",
            description: BUILD_DESCRIPTION,
            supporting_interaction_summary: "Agent 先提供了完整 shape 答案，用户随后提交最小模块并报告验证通过。",
          },
    }),
    (context) => {
      const recorded = payload<{ candidate_evidence: SubmitEvidenceInput }>(
        context,
        "record_teaching_turn",
      );
      assert.equal(recorded.candidate_evidence.assistance_level, "WITH_HELP");
      return fauxAssistantMessage(
        fauxToolCall("submit_evidence", recorded.candidate_evidence, { id: "build-evidence" }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      toolResult(context, "submit_evidence");
      return fauxAssistantMessage(
        fauxToolCall(
          "complete_learning_task",
          { task_id: createdTaskId },
          { id: "build-complete" },
        ),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      toolResult(context, "complete_learning_task");
      return fauxAssistantMessage(
        fauxToolCall("get_learning_overview", {}, { id: "build-overview" }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      toolResult(context, "get_learning_overview");
      return fauxAssistantMessage(
        fauxToolCall(
          "create_learning_task",
          {
            title: "练习多通道 Feature Map",
            description: "在同一 CNN Frontier 中比较不同输出通道的局部响应。",
            related_skill_ids: ["cnn"],
            expected_evidence_types: ["BUILD"],
          },
          { id: "same-frontier-create" },
        ),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      nextTaskId = payload<{ id: string }>(context, "create_learning_task").id;
      return fauxAssistantMessage(
        fauxToolCall(
          "activate_learning_task",
          { task_id: nextTaskId },
          { id: "same-frontier-activate" },
        ),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      toolResult(context, "activate_learning_task");
      return fauxAssistantMessage(
        "上一任务与 Evidence 已在自然阶段点汇总。仍在同一 CNN Frontier，因此已自然衔接到多通道 Feature Map BUILD；你可以随时暂停或换方向。",
      );
    },
  ]);

  const teaching = new TeachingSessionContext();
  const tools = createLearningAgentTools(teaching, httpOptions);
  let currentUserText = "";
  let previousAssistant = "";
  const agent = new Agent({
    streamFn: faux.streamSimple,
    initialState: {
      systemPrompt: buildSystemPrompt(teaching.snapshot()),
      model: faux.getModel(),
      tools: tools as unknown as AgentTool[],
    },
    beforeToolCall: async ({ toolCall, args }) => {
      if (toolCall.name === "submit_evidence") {
        const evidence = args as SubmitEvidenceInput;
        return evidence.source === "interactive-teaching-session"
          ? teaching.validateEvidenceSubmission(evidence)
          : teaching.evidenceWriteGuard(evidence);
      }
      return undefined;
    },
    afterToolCall: async ({ toolCall, isError }) => {
      if (toolCall.name === "submit_evidence" && !isError) {
        teaching.clearCandidateEvidence();
      }
      return undefined;
    },
  });

  const startedTools: string[] = [];
  let currentAnswer = "";
  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") startedTools.push(event.toolName);
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      currentAnswer += event.assistantMessageEvent.delta;
    }
  });

  let createdSessions = 0;
  let disposedSessions = 0;
  const answers: string[] = [];
  const snapshots: ReturnType<TeachingSessionContext["snapshot"]>[] = [];
  const output: string[] = [];
  const session: CliAgentSession = {
    prompt: async (text) => {
      currentUserText = text;
      previousAssistant = answers.at(-1) ?? "";
      currentAnswer = "";
      await agent.prompt(text);
      answers.push(currentAnswer);
      snapshots.push(teaching.snapshot());
    },
    dispose: () => void (disposedSessions += 1),
  };

  await runCli({
    args: [],
    lines: inputLines([
      "开始学习",
      "开始",
      "因为卷积看局部区域，所以能保留空间关系。",
      "同一个卷积核会在不同位置复用，因此参数更少并检测相同局部模式。",
      "同一组核权重会在所有位置滑动，所以目标换位置后仍使用同一个检测器。",
      "我猜是 [B,16,30,30]",
      "还是 [B,16,30,30]",
      "我没有考虑 padding，但不知道怎么算",
      "我仍然算不出来",
      "还是不会",
      "直接告诉我答案",
      "给我一个 BUILD 任务",
      "我独立完成并验证输出是 [B,16,32,32]",
      "/state",
      "/master cnn",
      "/master cnn",
      "/reopen cnn",
      "/state",
      "/exit",
    ]),
    context: teaching,
    userApiOptions: httpOptions,
    write: (text) => output.push(text),
    createSession: async () => {
      createdSessions += 1;
      return session;
    },
  });

  assert.equal(createdSessions, 1);
  assert.equal(disposedSessions, 1);
  assert.equal(sawEarlierTurn, true);
  assert.equal(snapshots[0]?.active_task_id, null);
  assert.equal(snapshots[0]?.teaching_mode, null);
  assert.match(answers[0]!, /这一轮不直接教学/);
  assert.doesNotMatch(answers[1]!, /optimizer|backward|zero_grad/);
  assert.match(answers[1]!, /不重复训练循环/);
  assert.doesNotMatch(answers[1]!, /完整知识地图|统一知识检查/);
  assert.match(answers[2]!, /参数共享/);
  assert.match(answers[2]!, /重试/);
  assert.match(answers[3]!, /尚不记录 Evidence/);
  assert.match(answers[10]!, /\[B,16,32,32\]/);
  assert.match(answers[11]!, /请先贴你的实现/);
  assert.doesNotMatch(answers[11]!, /class\s+\w+|def forward/);
  assert.match(answers[12]!, /同一 CNN Frontier/);
  assert.match(answers[12]!, /自然衔接/);

  const final = await fetchLearningOverview(httpOptions);
  assert.equal((final.active_task as { id: string }).id, nextTaskId);
  assert.equal(skillStatus(final, "cnn"), "PRACTICING");
  const evidence = final.recent_evidence as Array<{
    skill_id: string;
    assistance_level: string;
    source: string;
  }>;
  assert.ok(
    evidence.some(
      (item) =>
        item.skill_id === "cnn" &&
        item.assistance_level === "WITH_HINT" &&
        item.source === "interactive-teaching-session",
    ),
  );
  assert.ok(
    evidence.some(
      (item) =>
        item.skill_id === "cnn" &&
        item.assistance_level === "WITH_HELP" &&
        item.source === "interactive-teaching-session",
    ),
  );
  assert.match(output.join("\n"), /Goal:/);
  assert.match(output.join("\n"), /Current Teaching Mode: BUILD/);
  assert.match(output.join("\n"), /\[error\].*HTTP 409/);
  assert.match(output.join("\n"), /cnn: PRACTICING/);

  const completionTail = startedTools.slice(-6);
  assert.deepEqual(completionTail, [
    "record_teaching_turn",
    "submit_evidence",
    "complete_learning_task",
    "get_learning_overview",
    "create_learning_task",
    "activate_learning_task",
  ]);

  console.error(
    "[verify] Sprint 3 automated acceptance passed through CLI -> Faux Pi Session -> tools -> live HTTP API -> LearningService",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[fatal] ${message}`);
  process.exitCode = 1;
});
