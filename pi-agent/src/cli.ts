import "./httpDispatcher.js";
import { fetchLearningOverview } from "./learningOverviewTool.js";
import { TeachingSessionContext } from "./teachingSession.js";
import { GoalOnboardingContext } from "./planning/goalOnboarding.js";
import {
  abandonTask,
  confirmMastery,
  reopenSkill,
  startPracticing,
  type UserApiOptions,
} from "./userApi.js";

export interface CliAgentSession {
  prompt(text: string): Promise<void>;
  dispose(): void;
}

export interface RunCliOptions {
  args: string[];
  lines?: AsyncIterable<string>;
  context: TeachingSessionContext;
  planningContext?: GoalOnboardingContext;
  createSession: () => Promise<CliAgentSession>;
  write?: (text: string) => void;
  userApiOptions?: UserApiOptions;
  showStartupContext?: boolean;
}

function commandParts(line: string): [string, string] {
  const [command = "", ...rest] = line.trim().split(/\s+/);
  return [command.toLowerCase(), rest.join(" ").trim()];
}

function formatState(
  overview: Awaited<ReturnType<typeof fetchLearningOverview>>,
  context: TeachingSessionContext,
): string {
  const active = overview.active_task as { id?: string; title?: string } | null;
  const skills = overview.skills as Array<{
    id?: string;
    status?: string;
    evidence_ids?: unknown[];
  }>;
  const teaching = context.snapshot();
  const candidate = teaching.candidate_evidence;
  const evidenceSummary = skills
    .map((skill) => `${skill.id ?? "unknown"}:${skill.evidence_ids?.length ?? 0}`)
    .join(", ");
  return [
    `Goal: ${overview.current_goal ?? "None (onboarding required)"}`,
    `Active Task: ${active ? `${active.id ?? "unknown"} ${active.title ?? ""}`.trim() : "None"}`,
    `Current Skill: ${teaching.active_skill_id ?? "None"}`,
    `Current Teaching Mode: ${teaching.teaching_mode ?? "None"}`,
    `Current Teaching Flow: ${teaching.teaching_flow ?? "None"}`,
    `Current Teaching Phase: ${teaching.teaching_phase ?? "None"}`,
    `Review Check Scope: ${teaching.check_scope.join(", ") || "None"}`,
    `Persisted Evidence Summary: ${evidenceSummary || "None"}`,
    `Candidate Evidence: ${
      candidate
        ? `${candidate.skill_id} ${candidate.evidence_type} ${candidate.assistance_level} (NOT PERSISTED)`
        : "None"
    }`,
  ].join("\n");
}

function formatPlan(
  overview: Awaited<ReturnType<typeof fetchLearningOverview>>,
): string {
  const milestones = overview.curriculum_spine as Array<{
    name?: string;
    target_depth?: string;
  }>;
  const frontier = overview.current_frontier as {
    focus_skill_id?: string;
    supporting_skill_ids?: string[];
    reason?: string;
    next_action?: string;
  } | null;
  const currentFocus = overview.current_focus as {
    id?: string;
    title?: string;
  } | null;
  return [
    `Goal: ${overview.current_goal ?? "None"}`,
    "Curriculum Spine:",
    ...(milestones.length
      ? milestones.map(
          (item, index) =>
            `${index + 1}. ${item.name ?? "unknown"} [${item.target_depth ?? "unknown"}]`,
        )
      : ["None"]),
    "Current Learning Frontier:",
    frontier
      ? `Focus=${frontier.focus_skill_id ?? "unknown"}; Supporting=${frontier.supporting_skill_ids?.join(", ") || "None"}; Reason=${frontier.reason ?? ""}`
      : "None",
    `Current Focus: ${
      currentFocus
        ? `${currentFocus.id ?? "unknown"} ${currentFocus.title ?? ""}`.trim()
        : "None"
    }`,
    `Next Action: ${frontier?.next_action ?? "Complete Goal onboarding first"}`,
  ].join("\n");
}

async function handleCommand(
  line: string,
  options: RunCliOptions,
): Promise<"handled" | "exit" | "not-command"> {
  if (!line.trim().startsWith("/")) return "not-command";
  const [command, argument] = commandParts(line);
  const write = options.write ?? ((text: string) => process.stdout.write(`${text}\n`));
  if (command === "/exit") return "exit";
  if (command === "/master" || command === "/reopen" || command === "/practice") {
    if (!argument) {
      write(`Usage: ${command} <skill_id>`);
      return "handled";
    }
    const skill =
      command === "/master"
        ? await confirmMastery(argument, options.userApiOptions)
        : command === "/reopen"
          ? await reopenSkill(argument, options.userApiOptions)
          : await startPracticing(argument, options.userApiOptions);
    if (command === "/reopen") options.context.invalidateCheckpoint();
    write(`${skill.id}: ${skill.status}`);
    return "handled";
  }
  if (command === "/abandon-task") {
    if (!argument) {
      write("Usage: /abandon-task <task_id>");
      return "handled";
    }
    // 放弃 Task 是用户拥有的显式状态变更，直接走 User API，绝不发送给 LLM。
    const task = await abandonTask(argument, options.userApiOptions);
    options.context.invalidateCheckpoint();
    write(`${task.id}: ${task.status}`);
    return "handled";
  }
  if (command === "/state") {
    const overview = await fetchLearningOverview({
      ...options.userApiOptions,
      log: () => undefined,
    });
    write(formatState(overview, options.context));
    return "handled";
  }
  if (command === "/plan") {
    const overview = await fetchLearningOverview({
      ...options.userApiOptions,
      log: () => undefined,
    });
    write(formatPlan(overview));
    return "handled";
  }
  if (command === "/new-goal") {
    const planning = options.planningContext ?? new GoalOnboardingContext();
    if (argument && argument !== "replace" && argument !== "cancel") {
      write("Usage: /new-goal [replace|cancel]");
      return "handled";
    }
    if (argument === "cancel") {
      planning.cancel();
      write("Goal onboarding cancelled. The current Goal was not changed.");
      return "handled";
    }
    const overview = await fetchLearningOverview({
      ...options.userApiOptions,
      log: () => undefined,
    });
    if (overview.current_goal && argument !== "replace") {
      write(
        `Current Goal exists: ${overview.current_goal}\nUse /new-goal replace to begin a replacement onboarding, or /new-goal cancel. Nothing was changed.`,
      );
      return "handled";
    }
    planning.start({
      replaceExisting: overview.current_goal !== null && argument === "replace",
    });
    options.context.invalidateCheckpoint();
    write(
      "Goal onboarding started. Describe what you ultimately want to be able to do, your relevant background, learning preference, and available time in one natural message.",
    );
    return "handled";
  }
  write(
    "Unknown command. Available: /new-goal [replace|cancel], /plan, /state, /abandon-task <task_id>, /practice <skill_id>, /master <skill_id>, /reopen <skill_id>, /exit",
  );
  return "handled";
}

export async function runCli(options: RunCliOptions): Promise<void> {
  const write = options.write ?? ((text: string) => process.stdout.write(`${text}\n`));
  let session: CliAgentSession | undefined;
  const getSession = async () => (session ??= await options.createSession());

  const dispatch = async (line: string): Promise<boolean> => {
    const text = line.trim();
    if (!text) return true;
    try {
      const command = await handleCommand(text, options);
      if (command === "exit") return false;
      if (command === "handled") return true;
      if (/^(跳过|先继续学|之后再问|稍后再检查|结束本次检查)[。！!\s]*$/.test(text)) options.context.skipCheckpoint();
      const answeringQuestion = Boolean(options.context.learnerQuestions.snapshot().pending);
      const promptText = options.context.learnerQuestions.answer(text);
      options.context.beginUserTurn(promptText, answeringQuestion);
      options.planningContext?.beginUserTurn(text);
      options.context.beginAgentTurn();
      try {
        await (await getSession()).prompt(promptText);
        options.context.endAgentTurn(true);
      } catch (error) {
        options.context.endAgentTurn(false);
        throw error;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      write(`[error] ${message}`);
    }
    return true;
  };

  try {
    if (options.args.length > 0) {
      await dispatch(options.args.join(" "));
      return;
    }
    if (!options.lines) throw new Error("Interactive CLI requires an input source");
    write(
      "Learn Anything With Agent\nCommands: /new-goal /plan /state /abandon-task <task_id> /practice <skill_id> /master <skill_id> /reopen <skill_id> /exit",
    );
    if (options.showStartupContext) {
      try {
        const overview = await fetchLearningOverview({
          ...options.userApiOptions,
          log: () => undefined,
        });
        if (overview.current_goal === null) {
          options.planningContext?.start();
          write(
            "你现在想学会什么，或者最终希望自己能做到什么？可以在一段话里补充相关经历、学习偏好和每天可投入的时间。",
          );
        } else {
          write(
            `Current Goal: ${overview.current_goal}\n输入 /plan 查看路线，或直接说明你想继续什么。`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        write(`[error] Unable to read startup learning state: ${message}`);
      }
    }
    for await (const line of options.lines) {
      if (!(await dispatch(line))) break;
    }
  } finally {
    session?.dispose();
  }
}
