import assert from "node:assert/strict";
import test from "node:test";
import {
  LearnerQuestionsContext,
  goalConfirmationSignature,
  learningStartSignature,
  planRevisionDecision,
} from "./learnerQuestions.js";
import type { LearnerQuestionRequest } from "./learnerQuestionTypes.js";
import { TeachingSessionContext } from "./teachingSession.js";
import { createLearnerQuestionTool } from "./learnerQuestionTool.js";
import { createActiveRecallTool } from "./activeRecallTool.js";
import { GoalOnboardingContext } from "./planning/goalOnboarding.js";
import { validatePlanningToolRoute } from "./planning/planningPolicy.js";
import {planningHash} from "./planning/planningReading.js";

const request = (purpose: "BACKGROUND" | "CHECK" = "CHECK"): LearnerQuestionRequest => ({
  id: "q-request", purpose, session_id: "session-a", goal_id: purpose === "CHECK" ? "goal-a" : null,
  skill_id: purpose === "CHECK" ? "skill-a" : null, task_id: purpose === "CHECK" ? "task-a" : null,
  questions: [{ id: "q", prompt: "Session 保存什么？请补充理由。", selection: "single", options: [{ id: "history", label: "完整对话" }, { id: "latest", label: "仅最新回复" }] }],
});
const reply = (ids = ["history"], other = "保存历史便于回看与构建上下文") => ({ request_id: "q-request", answers: [{ question_id: "q", selected_option_ids: ids, other_text: other }] });
const overview = () => ({ current_goal: "架构", goal_profile: { id: "goal-a" }, current_frontier: null, current_focus: null, curriculum_spine: [], skills: [{ id: "skill-a" }], recent_evidence: [], active_task: { id: "task-a", status: "ACTIVE", related_skill_ids: ["skill-a"], activity_revision: 1, teaching_activity: { method: "REASON", purpose: "理解 Session 的职责", learner_action: "解释保存历史的作用", observable_output: "对职责的解释", evaluation_focus: ["回答题目要求"], observation_limits: "解释不能证明实际操作能力" } }, current_goal_skill_ids: ["skill-a"], learning_history: [] });

const decisionProfile = { id: "goal-new", goal_description: "理解 Session", background_summary: "初学者", desired_outcome: "解释用途",
  learning_preferences: [], time_constraint: "", prior_knowledge_claims: [] };
function decision(purpose: "CONFIRM_GOAL" | "START_LEARNING"): LearnerQuestionRequest {
  return { ...request(), purpose, goal_id: purpose === "CONFIRM_GOAL" ? decisionProfile.id : "goal-a",
    scope_signature: purpose === "CONFIRM_GOAL" ? goalConfirmationSignature(decisionProfile) : learningStartSignature(overview()),
    questions: [{ id: "q", prompt: "准备好了吗？", selection: "single", options: [{ id: "proceed", label: purpose === "CONFIRM_GOAL" ? "确认" : "开始学习" }] }] };
}

test("a submitted goal button becomes a separate explicit confirmation without creating learning Evidence", () => {
  const planning = new GoalOnboardingContext(); planning.start(); planning.record({ outcome: "READY_FOR_CONFIRMATION", profile: decisionProfile });
  const context = new TeachingSessionContext(); context.learnerQuestions.ask(decision("CONFIRM_GOAL"));
  assert.throws(() => planning.record({ outcome: "CONFIRMED" }), /latest user message/);
  const text = context.learnerQuestions.answer("", reply(["proceed"], ""));
  assert.equal(text, "确认"); planning.beginUserTurn(text);
  assert.equal(planning.record({ outcome: "CONFIRMED" }).status, "CONFIRMED");
  assert.equal(context.learnerQuestions.snapshot().last_answer?.choices_exposed, false);
  assert.match(context.evidenceWriteGuard({ skill_id: "skill-a", evidence_type: "EXPLAIN", description: "确认", assistance_level: "INDEPENDENT", source: "self-report" })!.reason, /用户意图/);
});

test("free changes and consent plus supplementation cannot confirm a goal", () => {
  for (const ids of [[], ["proceed"]]) {
    const planning = new GoalOnboardingContext(); planning.start(); planning.record({ outcome: "READY_FOR_CONFIRMATION", profile: decisionProfile });
    const questions = new LearnerQuestionsContext(); questions.ask(decision("CONFIRM_GOAL"));
    const text = questions.answer("", reply(ids, "先别确认，我想改成实践为主"));
    planning.beginUserTurn(text); assert.throws(() => planning.record({ outcome: "CONFIRMED" }), /latest user message/);
    assert.match(questions.snapshot().last_answer?.text ?? "", /实践为主/);
  }
});

test("a start button permits task progression while refusal and mixed instructions keep it blocked", () => {
  for (const [ids, other, allowed] of [[["proceed"], "", true], [[], "开始", true], [[], "先等等", false], [["proceed"], "先不要开始", false]] as const) {
    const questions = new LearnerQuestionsContext(); questions.ask(decision("START_LEARNING"));
    questions.answer("", reply([...ids], other));
    assert.equal(questions.writeGuard("activate_learning_task")?.block ?? false, !allowed);
    assert.equal(questions.writeGuard("read_learning_material"), undefined);
  }
});

test("decision tools generate fixed actions bound to the current draft and Kernel scope", async () => {
  const context = new TeachingSessionContext(); const planning = new GoalOnboardingContext(); planning.start();
  const tool = createLearnerQuestionTool(context, planning, { fetchImpl: async (url, init) => Response.json(String(url).includes("question-contracts") ? JSON.parse(String(init?.body)) : overview()), log: () => undefined });
  const execute = (purpose: "CONFIRM_GOAL" | "START_LEARNING", active_skill_id?: string) => tool.execute("decision", { purpose, active_skill_id }, new AbortController().signal, undefined, {} as Parameters<typeof tool.execute>[4]);
  await assert.rejects(() => execute("CONFIRM_GOAL"), /待独立确认/);
  planning.record({ outcome: "READY_FOR_CONFIRMATION", profile: decisionProfile });
  await execute("CONFIRM_GOAL");
  assert.equal(context.learnerQuestions.snapshot().pending?.scope_signature, goalConfirmationSignature(decisionProfile));
  assert.deepEqual(context.learnerQuestions.snapshot().pending?.questions[0]?.options, [{ id: "proceed", label: "确认" }]);
  context.learnerQuestions.invalidate(); planning.cancel();
  await assert.rejects(() => execute("START_LEARNING", "foreign-skill"), /当前 Goal/);
  await execute("START_LEARNING", "skill-a");
  assert.equal(context.learnerQuestions.snapshot().pending?.scope_signature, learningStartSignature(overview()));
});

test("answers preserve neutral options, exact selection and free supplementation without making Evidence", () => {
  const questions = new LearnerQuestionsContext(); questions.ask(request());
  const answer = questions.answer("还有别的经验", reply());
  assert.match(answer, /Session 保存什么/); assert.match(answer, /完整对话/); assert.match(answer, /保存历史/); assert.match(answer, /还有别的经验/);
  assert.equal(questions.snapshot().pending, null);
  assert.deepEqual(questions.snapshot().last_answer?.reply, reply());
  assert.equal(questions.snapshot().last_answer?.choices_exposed, true);
});

test("stale IDs, injected options, duplicate answers and single-choice over-selection are rejected atomically", () => {
  const questions = new LearnerQuestionsContext(); questions.ask(request());
  const original = questions.snapshot();
  for (const invalid of [{ ...reply(), request_id: "old" }, reply(["injected"]), reply(["history", "latest"]), reply([], ""), { request_id: "q-request", answers: [reply().answers[0], reply().answers[0]] }]) {
    assert.throws(() => questions.answer("", invalid)); assert.deepEqual(questions.snapshot(), original);
  }
  assert.throws(() => questions.ask(request()), /已有待回答/);
  assert.throws(() => questions.ask({ ...request(), questions: [{ ...request().questions[0]!, options: [{ id: "x", label: "甲" }, { id: "x", label: "乙" }] }] }), /唯一/);
});

test("a question batch accepts only complete actual answers and keeps their original order", () => {
  const questions = new LearnerQuestionsContext(); const batch = request("BACKGROUND");
  batch.questions.push({ ...batch.questions[0]!, id: "preference", prompt: "更想怎样学习？" });
  questions.ask(batch);
  assert.throws(() => questions.answer("", reply()), /回答不完整/);
  assert.equal(questions.snapshot().pending?.questions.length, 2);
  const second = { question_id: "preference", selected_option_ids: [], other_text: "边做边学" };
  questions.answer("", { request_id: batch.id, answers: [second, reply().answers[0]] });
  assert.deepEqual(questions.snapshot().last_answer?.reply?.answers.map(a => a.question_id), ["q", "preference"]);
  assert.match(questions.snapshot().last_answer?.text ?? "", /边做边学/);
});

test("multiple choice and entirely free-text answers are both supported; failed turns undo only new questions", () => {
  const questions = new LearnerQuestionsContext(); const multi = request(); multi.questions[0]!.selection = "multiple";
  questions.ask(multi); questions.answer("", reply(["history", "latest"], "两个选项都需要进一步限定"));
  const accepted = questions.snapshot(); questions.beginTurn(); questions.ask({ ...request(), id: "next" }); questions.endTurn(false);
  assert.deepEqual(questions.snapshot(), accepted, "a failed model response cannot undo a human answer");
  questions.ask(request()); questions.answer("我想按自己的经历完整回答，不选选项。");
  assert.equal(questions.snapshot().last_answer?.used_choices, false); assert.equal(questions.snapshot().last_answer?.choices_exposed, true);
});

test("practice sets accept ten questions while plan revisions require a real fixed decision", () => {
  const questions = new LearnerQuestionsContext();
  const practice = {
    ...request(),
    purpose: "PRACTICE_SET" as const,
    title: "第二章练习",
    questions: Array.from({length: 10}, (_, index) => ({
      id: `q-${index}`,
      prompt: `第 ${index + 1} 题`,
      selection: "single" as const,
      options: [{id: "a", label: "A"}, {id: "b", label: "B"}],
    })),
  };
  questions.ask(practice);
  assert.equal(questions.snapshot().pending?.questions.length, 10);
  const tooMany = new LearnerQuestionsContext();
  assert.throws(() => tooMany.ask({...practice, questions: [
    ...practice.questions,
    {id: "q-11", prompt: "第十一题", selection: "single", options: [{id: "a", label: "A"}, {id: "b", label: "B"}]},
  ]}), /2～10/);
  questions.answer("", {
    request_id: practice.id,
    answers: practice.questions.map(question => ({
      question_id: question.id,
      selected_option_ids: ["a"],
      other_text: "",
    })),
  });
  assert.equal(questions.snapshot().last_answer?.request.purpose, "PRACTICE_SET");
  assert.equal(questions.writeGuard("record_teaching_turn")?.block, true);
  assert.equal(questions.writeGuard("record_answer_assessment")?.block, true);

  const revision = new LearnerQuestionsContext();
  revision.ask({
    ...request(),
    purpose: "CONFIRM_PLAN_REVISION",
    plan_revision_id: "plan-revision-test",
    plan_revision_base: 0,
    scope_signature: "b".repeat(64),
    questions: [{
      id: "confirm-plan-revision",
      prompt: "确认计划修订",
      selection: "single",
      options: [{id: "proceed", label: "确认修订"}, {id: "reject", label: "暂不修订"}],
    }],
  });
  revision.answer("", {request_id: "q-request", answers: [{
    question_id: "confirm-plan-revision",
    selected_option_ids: ["proceed"],
    other_text: "",
  }]});
  assert.equal(planRevisionDecision(revision.snapshot().last_answer)?.action, "CONFIRM");
  assert.equal(revision.writeGuard("apply_curriculum_plan")?.block, true);
  assert.equal(revision.writeGuard("decide_plan_revision"), undefined);
  revision.consumePlanRevisionDecision();
  assert.equal(revision.snapshot().last_answer, null);
});

test("pending question and parallel ask response block authority writes; background claims never become Evidence", () => {
  const context = new TeachingSessionContext(); context.bindSession("session-a");
  context.learnerQuestions.ask(request("BACKGROUND"));
  assert.equal(context.learnerQuestions.writeGuard("initialize_learning_goal")?.block, true);
  assert.equal(context.learnerQuestions.writeGuard("read_learning_source"), undefined);
  context.learnerQuestions.answer("我只是看过一些教程");
  assert.match(context.evidenceWriteGuard({ skill_id: "skill-a", evidence_type: "EXPLAIN", description: "已经理解", assistance_level: "INDEPENDENT", source: "self-report" })!.reason, /自述/);
  context.learnerQuestions.beginUserTurn();
  assert.equal(context.learnerQuestions.writeGuard("submit_evidence", true)?.block, true);
});

test("choice-supported explanation becomes WITH_HINT Candidate with original question and answer", () => {
  const context = new TeachingSessionContext(); context.bindSession("session-a");
  context.learnerQuestions.ask(request()); context.learnerQuestions.answer("", reply()); context.beginUserTurn("实际回答", true);
  const result = context.recordTurn({ active_skill_id: "skill-a", active_task_id: "task-a", teaching_mode: "QUIZ", outcome: "CORRECT", candidate_evidence: { evidence_type: "EXPLAIN", description: "借助选项辨认 Session 并说明用途", supporting_interaction_summary: "真实理由" } });
  const candidate = result.candidate_evidence!;
  assert.equal(candidate.assistance_level, "WITH_HINT"); assert.match(candidate.description, /完整对话/); assert.match(candidate.description, /保存历史便于回看/);
  assert.equal(context.validateEvidenceSubmission(candidate), undefined);
  assert.equal(context.validateEvidenceSubmission({ ...candidate, assistance_level: "INDEPENDENT" })?.block, true);
  assert.equal(context.validateEvidenceSubmission({ ...candidate, description: "省略实际回答" })?.block, true);
});

test("background tool respects onboarding and teaching choice respects authoritative task", async () => {
  const context = new TeachingSessionContext(); context.bindSession("session-a"); const planning = new GoalOnboardingContext(); planning.start();
  assert.equal(validatePlanningToolRoute(planning.snapshot(), "ask_learner_questions"), undefined);
  const tool = createLearnerQuestionTool(context, planning, { fetchImpl: async (url, init) => Response.json(String(url).includes("question-contracts") ? JSON.parse(String(init?.body)) : overview()), log: () => undefined });
  const args = { purpose: "BACKGROUND" as const, questions: request().questions };
  await tool.execute("q", args, new AbortController().signal, undefined, {} as Parameters<typeof tool.execute>[4]);
  assert.equal(context.learnerQuestions.snapshot().pending?.goal_id, null);
  context.learnerQuestions.invalidate(); planning.cancel();
  await assert.rejects(() => tool.execute("q", { ...args, purpose: "CHECK", active_skill_id: "skill-a", active_task_id: "another-task" }, new AbortController().signal, undefined, {} as Parameters<typeof tool.execute>[4]), /ACTIVE Task/);
  await tool.execute("q", { ...args, purpose: "CHECK", active_skill_id: "skill-a", active_task_id: "task-a" }, new AbortController().signal, undefined, {} as Parameters<typeof tool.execute>[4]);
  assert.equal(context.learnerQuestions.snapshot().pending?.task_id, "task-a");
});

test("confirmed material basis can use the existing question component for one post-confirmation clarification", async () => {
  const context = new TeachingSessionContext(); context.bindSession("session-a");
  const planning = new GoalOnboardingContext(); planning.start();
  const reference = {
    id: "a".repeat(64), session_id: "session-a", user_entry_id: "user-a",
    profile_hash: planningHash(decisionProfile),
    materials: [{id: "mat-" + "b".repeat(32), name: "旧政策.md"}, {id: "mat-" + "c".repeat(32), name: "新政策.md"}],
  };
  planning.beginUserTurn("我想学习政策");
  planning.record({outcome: "READY_FOR_CONFIRMATION", profile: decisionProfile}, reference);
  planning.beginUserTurn("确认");
  planning.record({outcome: "CONFIRMED"});
  assert.equal(planning.snapshot().status, "CONFIRMED");
  assert.equal(validatePlanningToolRoute(planning.snapshot(), "ask_learner_questions", "BACKGROUND"), undefined);

  const tool = createLearnerQuestionTool(context, planning, {log: () => undefined});
  await tool.execute("source-conflict", {
    purpose: "BACKGROUND",
    questions: [{
      id: "request-date",
      prompt: "新请求应按哪个创建日期范围处理？",
      selection: "single",
      options: [
        {id: "before-boundary", label: "2026-10-01 之前"},
        {id: "on-or-after-boundary", label: "2026-10-01 及之后"},
      ],
    }],
  }, new AbortController().signal, undefined, {} as Parameters<typeof tool.execute>[4]);
  assert.equal(context.learnerQuestions.snapshot().pending?.purpose, "BACKGROUND");
  assert.match(context.learnerQuestions.snapshot().pending?.questions[0]?.prompt ?? "", /创建日期范围/);
  assert.equal(planning.snapshot().status, "CONFIRMED");
});

test("plan revision confirmation uses the persisted candidate summary and a real two-action decision", async () => {
  const context = new TeachingSessionContext(); context.bindSession("session-a");
  const planning = new GoalOnboardingContext();
  const revision = {
    id: "plan-revision-test", goal_id: "goal-a", base_revision: 0, revision: 1,
    base_signature: "c".repeat(64), goal_profile: {...decisionProfile, created_at: "2026-10-20T00:00:00Z"},
    curriculum_spine: [], added_skills: [], updated_skills: [], remove_skill_ids: [],
    frontier: {
      focus_skill_id: "skill-a",
      supporting_skill_ids: [],
      reason: "继续新版节点",
      target_depth: "PRACTICAL",
      suggested_learning_mode: "EXPLAIN",
      next_action: "讲新版",
    },
    summary: "更新学习目标理解；更新阶段里程碑", reason: "考试范围只含新版",
    status: "PENDING", feedback: "", decision_request_id: "",
    created_at: "2026-10-20T00:00:00Z", decided_at: null,
  };
  const tool = createLearnerQuestionTool(context, planning, {
    log: () => undefined,
    fetchImpl: async request => String(request).includes("/plan-revisions/")
      ? Response.json(revision)
      : Response.json({...overview(), plan_revision: 0}),
  });
  await tool.execute(
    "confirm-plan",
    {purpose: "CONFIRM_PLAN_REVISION", plan_revision_id: revision.id},
    new AbortController().signal,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  );
  const pending = context.learnerQuestions.snapshot().pending!;
  assert.equal(pending.plan_revision_id, revision.id);
  assert.equal(pending.plan_revision_base, 0);
  assert.deepEqual(pending.questions[0]?.options, [
    {id: "proceed", label: "确认修订"},
    {id: "reject", label: "暂不修订"},
  ]);
  assert.match(pending.questions[0]?.prompt ?? "", /更新学习目标理解/);
});

test("Active Recall keeps choice assistance and actual answer when finishing through its existing candidate flow", async () => {
  const context = new TeachingSessionContext(); context.bindSession("session-a"); context.beginUserTurn("开始");
  const scope = { goal_id: "goal-a", session_id: "session-a", skill_id: "skill-a", task_id: "task-a" };
  context.activeRecall.start({ ...scope, primary_questions: [request().questions[0]!.prompt, "区别？", "迁移？"] });
  context.activeRecall.noteChoiceAssistance(); context.learnerQuestions.ask(request()); context.learnerQuestions.answer("", reply()); context.beginUserTurn("回答", true);
  const tool = createActiveRecallTool(context, { fetchImpl: async () => Response.json(overview()), log: () => undefined });
  await tool.execute("answer", { action: "ANSWER", active_skill_id: "skill-a", active_task_id: "task-a", outcome: "CORRECT", observation: "实际选择并解释用途", next: "FINISH", evidence_claims: [{ evidence_type: "EXPLAIN", description: "辨认并解释", supporting_interaction_summary: "实际表现", observation_indices: [0] }] }, new AbortController().signal, undefined, {} as Parameters<typeof tool.execute>[4]);
  const candidate = context.snapshot().candidate_evidence!; assert.equal(candidate.assistance_level, "WITH_HINT"); assert.match(candidate.description, /完整对话/); assert.equal(context.validateEvidenceSubmission(candidate), undefined);
});
