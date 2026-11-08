import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "./cli.js";
import { TeachingSessionContext } from "./teachingSession.js";
import { GoalOnboardingContext } from "./planning/goalOnboarding.js";

async function* lines(values: string[]) {
  for (const value of values) yield value;
}

test("interactive CLI reuses one Agent Session for multiple teaching turns", async () => {
  const prompts: string[] = [];
  let created = 0;
  let disposed = 0;
  await runCli({
    args: [],
    lines: lines(["开始学习", "我的理解是卷积保留局部关系", "/exit"]),
    context: new TeachingSessionContext(),
    write: () => undefined,
    createSession: async () => {
      created += 1;
      return {
        prompt: async (text) => void prompts.push(text),
        dispose: () => void (disposed += 1),
      };
    },
  });

  assert.equal(created, 1);
  assert.deepEqual(prompts, ["开始学习", "我的理解是卷积保留局部关系"]);
  assert.equal(disposed, 1);
});

test("user commands are handled locally and never create an Agent Session", async () => {
  const output: string[] = [];
  const requests: string[] = [];
  let created = 0;
  await runCli({
    args: [],
    lines: lines([
      "/practice cnn",
      "/master training-loop",
      "/reopen training-loop",
      "/state",
      "/exit",
    ]),
    context: new TeachingSessionContext(),
    write: (text) => output.push(text),
    userApiOptions: {
      baseUrl: "http://learning.test",
      fetchImpl: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith("/overview")) {
          return Response.json({
            current_goal: "掌握 CNN",
            goal_profile: null,
            curriculum_spine: [],
            current_frontier: null,
            current_focus: null,
            active_task: null,
            skills: [{ id: "cnn", status: "LEARNING", evidence_ids: [] }],
            recent_evidence: [],
            learning_history: [],
            current_goal_skill_ids: [],
          });
        }
        const practicing = url.endsWith("/start-practicing");
        return Response.json({
          id: practicing ? "cnn" : "training-loop",
          name: practicing ? "CNN" : "Training Loop",
          description: "",
          prerequisites: ["pytorch"],
          status:
            practicing || url.endsWith("/reopen")
              ? "PRACTICING"
              : "MASTERED_BY_USER",
          evidence_ids: [],
        });
      },
    },
    createSession: async () => {
      created += 1;
      throw new Error("must not create session for local commands");
    },
  });

  assert.equal(created, 0);
  assert.equal(requests.length, 4);
  assert.match(output.join("\n"), /cnn: PRACTICING/);
  assert.match(output.join("\n"), /MASTERED_BY_USER/);
  assert.match(output.join("\n"), /Goal: 掌握 CNN/);
});

test("missing command arguments and unknown commands stay local", async () => {
  const output: string[] = [];
  let created = 0;
  await runCli({
    args: [],
    lines: lines([
      "/practice",
      "/master",
      "/reopen",
      "/abandon-task",
      "/unknown",
      "/exit",
    ]),
    context: new TeachingSessionContext(),
    write: (text) => output.push(text),
    createSession: async () => {
      created += 1;
      throw new Error("commands must not reach the model");
    },
  });

  assert.equal(created, 0);
  assert.match(output.join("\n"), /Usage: \/practice <skill_id>/);
  assert.match(output.join("\n"), /Usage: \/master <skill_id>/);
  assert.match(output.join("\n"), /Usage: \/reopen <skill_id>/);
  assert.match(output.join("\n"), /Usage: \/abandon-task <task_id>/);
  assert.match(output.join("\n"), /Unknown command/);
});

test("user can explicitly abandon the active task without sending the command to the model", async () => {
  const output: string[] = [];
  const requests: Array<{ url: string; method: string }> = [];
  let created = 0;
  await runCli({
    args: [],
    lines: lines(["/abandon-task task-old-yolo", "/exit"]),
    context: new TeachingSessionContext(),
    planningContext: new GoalOnboardingContext(),
    write: (text) => output.push(text),
    userApiOptions: {
      baseUrl: "http://learning.test",
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
        });
        return Response.json({
          id: "task-old-yolo",
          title: "旧 YOLO 任务",
          description: "",
          related_skill_ids: ["yolo"],
          expected_evidence_types: ["EXPLAIN"],
          status: "SKIPPED",
        });
      },
    },
    createSession: async () => {
      created += 1;
      throw new Error("user-owned task command must not reach the model");
    },
  });

  assert.equal(created, 0);
  assert.deepEqual(requests, [
    {
      url: "http://learning.test/api/user/tasks/task-old-yolo/abandon",
      method: "POST",
    },
  ]);
  assert.match(output.join("\n"), /task-old-yolo: SKIPPED/);
});

test("state distinguishes Candidate Evidence from persisted Evidence", async () => {
  const output: string[] = [];
  const context = new TeachingSessionContext();
  context.beginUserTurn("我独立完成了第一个检查");
  context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "QUIZ",
    outcome: "CORRECT",
    current_question: "padding=1 为什么能保持空间尺寸？",
  });
  context.beginUserTurn("我也独立完成了 shape 推导");
  context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "QUIZ",
    outcome: "CORRECT",
    current_question: "输出 shape 是什么？",
    candidate_evidence: {
      evidence_type: "EXPLAIN",
      description: "独立推导卷积输出 shape。",
      supporting_interaction_summary: "无提示完成。",
    },
  });

  await runCli({
    args: ["/state"],
    context,
    write: (text) => output.push(text),
    userApiOptions: {
      baseUrl: "http://learning.test",
      fetchImpl: async () =>
        Response.json({
          current_goal: "掌握 CNN",
          goal_profile: null,
          curriculum_spine: [],
          current_frontier: null,
          current_focus: {
            id: "task-cnn",
            title: "CNN shape",
            related_skill_ids: ["cnn"],
          },
          active_task: {
            id: "task-cnn",
            title: "CNN shape",
            related_skill_ids: ["cnn"],
          },
          learning_history: [],
          current_goal_skill_ids: [],
          skills: [{ id: "cnn", status: "LEARNING", evidence_ids: [] }],
          recent_evidence: [],
        }),
    },
    createSession: async () => {
      throw new Error("/state must stay local");
    },
  });

  assert.match(output.join("\n"), /Persisted Evidence Summary: cnn:0/);
  assert.match(
    output.join("\n"),
    /Candidate Evidence: cnn EXPLAIN INDEPENDENT \(NOT PERSISTED\)/,
  );
});

test("new-goal and plan commands stay local and never silently replace a goal", async () => {
  const output: string[] = [];
  const planningContext = new GoalOnboardingContext();
  let created = 0;
  const overview = {
    current_goal: "理解 CNN",
    goal_profile: null,
    curriculum_spine: [
      { id: "cnn", name: "CNN", target_depth: "PRACTICAL" },
      { id: "vision", name: "Vision", target_depth: "PRACTICAL" },
      { id: "detection", name: "Detection", target_depth: "DEEP" },
      { id: "yolo", name: "YOLO", target_depth: "DEEP" },
      { id: "project", name: "Project", target_depth: "PRACTICAL" },
    ],
    current_frontier: {
      focus_skill_id: "cnn",
      supporting_skill_ids: ["feature-map"],
      reason: "current boundary",
      next_action: "CNN diagnostic",
    },
    current_focus: null,
    active_task: null,
    skills: [],
    recent_evidence: [],
    learning_history: [],
    current_goal_skill_ids: [],
  };
  await runCli({
    args: [],
    lines: lines(["/new-goal", "/plan", "/new-goal replace", "/exit"]),
    context: new TeachingSessionContext(),
    planningContext,
    write: (text) => output.push(text),
    userApiOptions: {
      fetchImpl: async () => Response.json(overview),
    },
    createSession: async () => {
      created += 1;
      throw new Error("local planning commands must not create a model session");
    },
  });
  assert.equal(created, 0);
  assert.match(output.join("\n"), /Current Goal exists/);
  assert.match(output.join("\n"), /Curriculum Spine/);
  assert.match(output.join("\n"), /Current Focus: None/);
  assert.equal(planningContext.snapshot().replace_existing, true);
});

test("new-goal starts onboarding directly when the product has no goal", async () => {
  const output: string[] = [];
  const planningContext = new GoalOnboardingContext();
  await runCli({
    args: ["/new-goal"],
    context: new TeachingSessionContext(),
    planningContext,
    write: (text) => output.push(text),
    userApiOptions: {
      fetchImpl: async () =>
        Response.json({
          current_goal: null,
          goal_profile: null,
          curriculum_spine: [],
          current_frontier: null,
          current_focus: null,
          active_task: null,
          skills: [],
          recent_evidence: [],
          learning_history: [],
          current_goal_skill_ids: [],
        }),
    },
    createSession: async () => {
      throw new Error("/new-goal stays local");
    },
  });
  assert.match(output.join("\n"), /Goal onboarding started/);
  assert.equal(planningContext.snapshot().status, "NEEDS_CLARIFICATION");
});

test("interactive startup with no Goal enters onboarding before the first model turn", async () => {
  const output: string[] = [];
  const planningContext = new GoalOnboardingContext();
  let created = 0;
  await runCli({
    args: [],
    lines: lines(["/exit"]),
    context: new TeachingSessionContext(),
    planningContext,
    showStartupContext: true,
    write: (text) => output.push(text),
    userApiOptions: {
      fetchImpl: async () =>
        Response.json({
          current_goal: null,
          goal_profile: null,
          curriculum_spine: [],
          current_frontier: null,
          current_focus: null,
          active_task: null,
          skills: [],
          recent_evidence: [],
          learning_history: [],
          current_goal_skill_ids: [],
        }),
    },
    createSession: async () => {
      created += 1;
      throw new Error("startup onboarding must not initialize the model");
    },
  });
  assert.equal(created, 0);
  assert.match(output.join("\n"), /你现在想学会什么/);
  assert.equal(planningContext.snapshot().status, "NEEDS_CLARIFICATION");
});
