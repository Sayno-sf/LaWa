import assert from "node:assert/strict";
import test from "node:test";
import {createTeachingEvolutionTools, teachingSubject} from "./teachingEvolution.js";
import {createLearnerQuestionTool} from "./learnerQuestionTool.js";
import {TeachingSessionContext} from "./teachingSession.js";
import {GoalOnboardingContext} from "./planning/goalOnboarding.js";

test("strategy domain comes only from the confirmed profile and stays stable across task purposes", () => {
  assert.equal(teachingSubject({learning_domain: "英语", desired_outcome: "旅行英语交流"}), "domain:英语");
  assert.equal(teachingSubject({learning_domain: "英语", desired_outcome: "英语考试阅读"}), "domain:英语");
  assert.equal(teachingSubject({learning_domain: "历史", background_summary: "学过Python和英语"}), "domain:历史");
  assert.equal(teachingSubject({learning_domain: "  Ｅｎｇｌｉｓｈ  "}), "domain:english");
  assert.notEqual(teachingSubject({learning_domain: "编程"}), teachingSubject({learning_domain: "绘画"}));
  for (const desired_outcome of ["英语", "历史", "Python", "绘画"])
    assert.equal(teachingSubject({desired_outcome}), "", "an old Goal does not acquire an inferred reusable domain");
  assert.equal(teachingSubject(null), "");
  assert.throws(() => teachingSubject({learning_domain: "general"}), /具体学习领域/);
  assert.throws(() => teachingSubject({learning_domain: "通用"}), /具体学习领域/);
});

test("subject proposals bind the confirmed domain and unknown domains narrow to the source Goal", async () => {
  for (const domain of [undefined, "英语"]) {
    const requests: Array<{url: string; body?: Record<string, unknown>}> = [];
    const tools = createTeachingEvolutionTools({fetchImpl: async (url, init) => {
      requests.push({url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined});
      if (String(url).includes("overview")) return Response.json({current_goal: "学习目标", current_focus: null,
        goal_profile: {id: "goal", ...(domain ? {learning_domain: domain} : {})}, skills: [], recent_evidence: [],
        curriculum_spine: [], current_frontier: null, active_task: null, learning_history: [], current_goal_skill_ids: []});
      return Response.json({saved: true});
    }});
    const propose = tools.find(v => v.name === "propose_teaching_strategy")!;
    await propose.execute("proposal-call", {text: "表达练习先给短例子", reason: "实际表现", scope: "SUBJECT", assessment_ids: ["assessment"]} as never,
      new AbortController().signal, undefined, {} as Parameters<typeof propose.execute>[4]);
    assert.equal(requests.at(-1)?.body?.scope, domain ? "SUBJECT" : "GOAL");
    assert.equal(requests.at(-1)?.body?.subject, domain ? "domain:英语" : "");
    const read = tools.find(v => v.name === "read_teaching_context")!;
    await read.execute("read", {} as never, new AbortController().signal, undefined, {} as Parameters<typeof read.execute>[4]);
    assert.match(requests.at(-1)!.url, /\/learning\/teaching$/);
  }
});

test("teacher registry can only propose, read and correct, never make user decisions", () => {
  const names = createTeachingEvolutionTools().map(tool => tool.name);
  assert.deepEqual(names, ["read_teaching_context", "propose_teaching_strategy", "suggest_goal_completion", "correct_answer_assessment"]);
  assert.ok(names.every(name => !/confirm|decide|master/.test(name)));
});

test("user-wide proposals request explicit independent consent and topic lookup stays read-only", async () => {
  const requests: Array<{url: string; method?: string; body?: Record<string, unknown>}> = [];
  const tools = createTeachingEvolutionTools({fetchImpl: async (url, init) => {
    requests.push({url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined});
    if (String(url).includes("overview")) return Response.json({current_goal: "学习目标", current_focus: null, goal_profile: {id: "goal"}, skills: [], recent_evidence: [], curriculum_spine: [], current_frontier: null, active_task: null, learning_history: [], current_goal_skill_ids: []});
    return Response.json({saved: true});
  }});
  const propose = tools.find(v => v.name === "propose_teaching_strategy")!;
  await propose.execute("proposal-call", {text: "先给短例子", reason: "实际尝试后的偏好", scope: "USER", assessment_ids: ["assessment"]} as never,
    new AbortController().signal, undefined, {} as Parameters<typeof propose.execute>[4]);
  assert.equal(requests.at(-1)?.body?.source_independent, true);
  assert.equal(requests.at(-1)?.body?.goal_id, "goal", "candidate still requires a live source, never model confirmation");
  const read = tools.find(v => v.name === "read_teaching_context")!;
  await read.execute("find", {topic_query: "字符串连接"} as never, new AbortController().signal, undefined, {} as Parameters<typeof read.execute>[4]);
  assert.match(requests.at(-1)!.url, /teaching\/topics\?query=/);
  assert.equal(requests.at(-1)?.method, "GET");
});

test("a new question freezes private grading separately from the learner prompt; failure cannot leave a pending answer", async () => {
  const context = new TeachingSessionContext(); context.bindSession("session");
  const planning = new GoalOnboardingContext();
  const writes: unknown[] = [];
  let fail = true;
  const tool = createLearnerQuestionTool(context, planning, {fetchImpl: async (url, init) => {
    if (String(url).includes("question-contracts")) {
      const body = JSON.parse(String(init?.body)); writes.push(body);
      return fail ? Response.json({detail: "disk unavailable"}, {status: 503}) : Response.json(body);
    }
    return Response.json({current_goal: "旅行", goal_profile: {id: "goal"}, curriculum_spine: [], current_frontier: null, current_focus: null,
      recent_evidence: [], learning_history: [], current_goal_skill_ids: ["skill"], skills: [], active_task: {id: "task", status: "ACTIVE", related_skill_ids: ["skill"], activity_revision: 2,
        teaching_activity: {method: "DIALOGUE", purpose: "旅行问路", learner_action: "用文字表达目的地与请求", observable_output: "问路文字", evaluation_focus: ["表达请求"], observation_limits: "文字不证明发音或实时流利度"}}});
  }});
  const args = {purpose: "CHECK" as const, active_skill_id: "skill", active_task_id: "task", assessment_criteria: [{label: "表达请求", possible: 10}],
    questions: [{id: "q", prompt: "请问路。", selection: "freeform" as const, options: []}]};
  const run = () => tool.execute("ask", args, new AbortController().signal, undefined, {} as Parameters<typeof tool.execute>[4]);
  await assert.rejects(run, /disk unavailable/); assert.equal(context.learnerQuestions.snapshot().pending, null);
  fail = false; await run();
  assert.equal(context.learnerQuestions.snapshot().pending!.questions[0]!.prompt, "请问路。");
  assert.equal((writes[1] as any).question, "请问路。");
  assert.deepEqual((writes[1] as any).criteria, [["表达请求", 10]]);
  assert.ok(context.learnerQuestions.snapshot().pending!.assessment_contract_id);
  assert.equal(writes.length, 2);
  assert.equal((writes[1] as {activity_revision: number}).activity_revision, 2);
});
