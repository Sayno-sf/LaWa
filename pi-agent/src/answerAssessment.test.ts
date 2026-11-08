import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import {ModelRuntime, SessionManager} from "@earendil-works/pi-coding-agent";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer} from "node:http";
import {once} from "node:events";
import {createLearningAgentSession} from "./agentSession.js";
import {createFauxCore, fauxAssistantMessage, fauxToolCall} from "@earendil-works/pi-ai";
import {assessmentSource, assessmentQuestionSources, createRecordAnswerAssessmentTool} from "./answerAssessmentTool.js";
import {readAnswerAssessment} from "./answerAssessmentTypes.js";
import {TeachingSessionContext} from "./teachingSession.js";
import {GoalOnboardingContext} from "./planning/goalOnboarding.js";
import {createLearnerQuestionTool} from "./learnerQuestionTool.js";
import type {LearningOverview} from "./learningOverviewTool.js";
import {answerAssessmentMarkup} from "../web/src/answerAssessmentView.js";

const question = "add(2, 3) 和 add(2, '3') 分别打印什么？为什么？";
const input = {question, topic: "加号与字符串拼接", criteria: [
  {label: "结果判断", earned: 4, possible: 4, feedback: "两个输出均正确。"},
  {label: "类型解释", earned: 3, possible: 6, feedback: "还需要说明字符串参与加法时的转换。"}],
  summary: "能预测两个输出，对类型转换的解释还不完整。", strengths: ["输出为5和23"], gaps: ["解释字符串触发拼接的条件"]};
const overview: LearningOverview = {current_goal: "JS", goal_profile: {id: "goal"}, current_goal_skill_ids: ["skill"],
  active_task: {id: "task", status: "ACTIVE", related_skill_ids: ["skill"], activity_revision: 1, teaching_activity: {method: "REASON", purpose: "解释加法转换", learner_action: "说明两个输出的原因", observable_output: "输出与解释", evaluation_focus: ["回答题目要求"], observation_limits: "不代表独立编程能力"}}, current_focus: null,
  current_frontier: null, curriculum_spine: [], skills: [], recent_evidence: [], learning_history: []};

test("shared Pi preflight keeps task changes from racing a grade regardless of call order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lawa-score-guard-"));
  const writes: string[] = [];
  const api = createServer((req, res) => {
    if (req.method !== "GET") writes.push(req.url ?? "");
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(overview));
  });
  api.listen(0, "127.0.0.1"); await once(api, "listening");
  const address = api.address(); assert.ok(address && typeof address !== "string");
  const faux = createFauxCore({api: "openai-completions", provider: "score-guard", tokensPerSecond: 0,
    models: [{id: "isolated-model", contextWindow: 128000, maxTokens: 4096}]});
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("complete_learning_task", {task_id: "task"}, {id: "complete"}),
      fauxToolCall("record_answer_assessment", {...input, question: "并非上一道题"}, {id: "grade"}),
      fauxToolCall("activate_learning_task", {task_id: "next"}, {id: "activate"})], {stopReason: "toolUse"}),
    context => {
      for (const id of ["complete", "activate"]) {
        const result = context.messages.find(m => m.role === "toolResult" && m.toolCallId === id);
        assert.ok(result?.role === "toolResult" && result.isError);
        assert.match(JSON.stringify(result.content), /先成功保存/);
      }
      return fauxAssistantMessage("评分未保存，继续说明关键问题。");
    },
  ]);
  const runtime = await ModelRuntime.create({authPath: join(dir, "auth.json"), modelsPath: null,
    modelsStorePath: join(dir, "models.json"), allowModelNetwork: false, refreshOnCreate: false});
  runtime.streamSimple = faux.streamSimple; runtime.hasConfiguredAuth = () => true;
  runtime.getAuth = async () => ({auth: {apiKey: "faux-key"}, env: {}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  const manager = SessionManager.inMemory(); manager.appendMessage(fauxAssistantMessage(question));
  const agent = await createLearningAgentSession(new TeachingSessionContext(), new GoalOnboardingContext(), {
    model: faux.getModel(), modelRuntime: runtime, sessionManager: manager, retrieval: false, assistantSupport: false,
    apiBaseUrl: `http://127.0.0.1:${address.port}`, log: () => undefined,
  });
  try {
    await agent.prompt("数字5，字符串23。");
    assert.deepEqual(writes, [], "任务不能在失败的评分旁边抢先写入");
  } finally {agent.dispose(); api.close(); await once(api, "close"); rmSync(dir, {recursive: true, force: true});}
});

function fixture(answer = "5\n23\n因为第二个参数是字符串。") {
  const manager = SessionManager.inMemory();
  manager.appendMessage(fauxAssistantMessage(question));
  manager.appendMessage({role: "user", content: answer, timestamp: Date.now()});
  const context = new TeachingSessionContext(); context.bindSession(manager.getSessionId()); context.beginUserTurn(answer);
  let saved: Record<string, unknown> | undefined;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (!init?.body) return Response.json(overview);
    saved = JSON.parse(String(init.body));
    const a = saved as unknown as {criteria: typeof input.criteria; assistance_level: string; gaps: string[]};
    const score = a.criteria.reduce((n, c) => n + c.earned, 0);
    const follow_up = score >= 8 ? !a.gaps.length && ["INDEPENDENT", "TRANSFERRED"].includes(a.assistance_level) ? "SECURE" : "RECHECK" : "REINFORCE";
    return Response.json({...saved, topic_id: saved!.topic_id ?? "topic-actual", score, max_score: 10, follow_up,
      review_after: follow_up === "SECURE" ? null : follow_up === "RECHECK" ? 5 : 3, created_at: "2026-10-15T00:00:00Z"});
  }) as typeof fetch;
  return {manager, context, options: {fetchImpl, log: () => undefined}, saved: () => saved};
}

test("grading binds the actual latest Pi answer and ignores forged provenance parameters", async () => {
  const f = fixture();
  const actual = assessmentSource(f.manager)!;
  f.manager.appendMessage(fauxAssistantMessage("这是评分工具调用后的新文本，不能成为本轮题目。"));
  const tool = createRecordAnswerAssessmentTool(f.context, f.options, () => assessmentSource(f.manager));
  const forged = {...input, source_turn_id: "fake", answer_excerpt: "fake"};
  const result = await tool.execute("grade", forged, undefined, undefined, {} as never);
  assert.equal(f.saved()!.source_turn_id, actual.turnId);
  assert.equal(f.saved()!.answer_excerpt, actual.answer);
  assert.equal(f.saved()!.answer_sha256, createHash("sha256").update(actual.answer).digest("hex"));
  assert.equal(f.saved()!.assistance_level, "INDEPENDENT");
  assert.equal(result.details.assessment.score, 7);
  await assert.rejects(tool.execute("bad", {...input, question: "凭空的问题是什么？"}, undefined, undefined, {} as never), /逐字对应/);
});

test("returning from a prerequisite route can grade the original main-line prose question", async () => {
  const f = fixture(); f.manager.resetLeaf();
  f.manager.appendCustomEntry("lawa.goal-observation", {goalId: "goal"});
  f.manager.appendMessage({role: "toolResult", toolName: "activate_learning_task", toolCallId: "main-task", isError: false,
    content: [{type: "text", text: JSON.stringify(overview.active_task)}], timestamp: Date.now()});
  f.manager.appendMessage(fauxAssistantMessage(question));
  f.manager.appendMessage({role: "user", content: "我想先补一下字符串转换。", timestamp: Date.now()});
  f.manager.appendMessage(fauxAssistantMessage("可以，先把这部分补足，再回来做原题。"));
  f.manager.appendMessage({role:"toolResult",toolName:"propose_learning_branch",toolCallId:"proposal",isError:false,
    content:[{type:"text",text:JSON.stringify({branch:{id:"detour"}})}],timestamp:Date.now()});
  f.manager.appendMessage(fauxAssistantMessage("先想想字符串是什么？这是旁支内容。"));
  f.manager.appendCustomEntry("lawa.route-transition", {branchId: "detour", action: "enter", path: "goal:detour", taskId: "branch-task"});
  f.manager.appendMessage(fauxAssistantMessage("字符串转换和加法计算有什么不同？"));
  f.manager.appendMessage({role: "user", content: "前者得到文字。", timestamp: Date.now()});
  f.manager.appendMessage(fauxAssistantMessage("对。现在可以返回主线完成原题。"));
  f.manager.appendCustomEntry("lawa.route-transition", {branchId: "detour", action: "return", path: "goal:main", taskId: "task"});
  // 重进旁支查看记录，再返回，仍要找到最初的主线题目。
  f.manager.appendCustomEntry("lawa.route-transition", {branchId: "detour", action: "enter", path: "goal:detour", taskId: "branch-task"});
  f.manager.appendCustomEntry("lawa.route-transition", {branchId: "detour", action: "return", path: "goal:main", taskId: "task"});
  const answerId = f.manager.appendMessage({role: "user", content: "5和23，第二个因为字符串参与加法而拼接。", timestamp: Date.now()});
  assert.ok(!assessmentSource(f.manager)!.questions.some(q=>q.text.includes("旁支内容")||q.text.includes("前者得到文字")));
  const result = await createRecordAnswerAssessmentTool(f.context, f.options, () => assessmentSource(f.manager))
    .execute("main-grade", input, undefined, undefined, {} as never);
  assert.equal(result.details.assessment.source_turn_id, answerId);
  assert.equal(f.saved()!.question, question);
});

test("a formal CHECK source cannot be replaced by an unrelated assistant paragraph",async()=>{
  const f=fixture();
  f.context.learnerQuestions.ask({id:"contract-question",purpose:"CHECK",session_id:f.manager.getSessionId(),goal_id:"goal",task_id:"task",skill_id:"skill",
    assessment_contract_id:"contract",questions:[{id:"q",prompt:question,selection:"freeform",options:[]}]});
  f.context.learnerQuestions.answer("5和23");
  const source=assessmentSource(f.manager)!;
  source.questions.push({entryId:"contract-entry",text:question,contractId:"contract"});
  const sources=assessmentQuestionSources(source);
  const tool=createRecordAnswerAssessmentTool(f.context,f.options,()=>source);
  await assert.rejects(tool.execute("wrong",{...input,question_source_id:sources[0]!.sourceId},undefined,undefined,{} as never),/逐字对应/);
  await tool.execute("correct",{...input,question_source_id:sources.at(-1)!.sourceId},undefined,undefined,{} as never);
  assert.equal(f.saved()!.contract_id,"contract");
  assert.equal(f.saved()!.question_entry_id,"contract-entry");
});

test("a source ID quotes the original question without trusting a rewritten question or another turn", async () => {
  const f = fixture();
  const source = assessmentSource(f.manager)!;
  const anchor = assessmentQuestionSources(source)[0]!;
  const result = await createRecordAnswerAssessmentTool(f.context, f.options, () => source).execute("by-source",
    {...input, question: "模型抄错的题面不能进入成绩", question_source_id: anchor.sourceId}, undefined, undefined, {} as never);
  assert.equal(result.details.assessment.question, question);
  assert.equal(result.details.assessment.question_entry_id, anchor.entryId);
  await assert.rejects(createRecordAnswerAssessmentTool(f.context, f.options, () => source).execute("foreign",
    {...input, question_source_id: "other-entry:0:0"}, undefined, undefined, {} as never), /逐字对应/);
  await assert.rejects(createRecordAnswerAssessmentTool(f.context, f.options, () => ({...source, taskId:"old-task"})).execute("moved",
    input, undefined, undefined, {} as never), /原作答所属/);
});

test("a long explanation exposes individual original paragraphs instead of saving the whole lesson as a question", () => {
  const f = fixture(); const source = assessmentSource(f.manager)!;
  const options = assessmentQuestionSources({...source, questions:[{entryId:"real-entry",text:`先讲清楚两个操作数的类型。\n\n${question}\n\n来源：课堂例子。`}]});
  assert.ok(options.some(q=>q.text===question));
  assert.ok(options.every(q=>!q.text.includes("先讲清楚")||!q.text.includes(question)));
});

test("recovery never borrows another submission receipt or blindly writes while Kernel lookup is unavailable", async () => {
  const f = fixture();
  const first = await createRecordAnswerAssessmentTool(f.context, f.options, () => assessmentSource(f.manager))
    .execute("first", input, undefined, undefined, {} as never);
  let posts = 0;
  for (const status of [200, 503]) {
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") posts++;
      if (String(_url).endsWith("/overview")) return Response.json(overview);
      return Response.json(status === 200 ? {...first.details.assessment, source_turn_id: "some-other-submission"} : {detail: "unavailable"}, {status});
    }) as typeof fetch;
    const tool = createRecordAnswerAssessmentTool(f.context, {fetchImpl}, () => ({...assessmentSource(f.manager)!, feedbackRetry: true}));
    await assert.rejects(tool.execute("retry", input, undefined, undefined, {} as never), /核验来源不一致|暂不能核验/);
  }
  assert.equal(posts, 0);
});

test("teacher chooses actual assistance for this answer, including uncertainty", async () => {
  for (const level of ["INDEPENDENT","WITH_HINT","WITH_REFERENCE","WITH_HELP","UNKNOWN"] as const) {
    const f = fixture();
    await createRecordAnswerAssessmentTool(f.context,f.options,()=>assessmentSource(f.manager)).execute("grade",{...input,assistance_level:level},undefined,undefined,{} as never);
    assert.equal(f.saved()!.assistance_level,level);
  }
});

test("a lower teacher label cannot erase actual current-question choice exposure", async () => {
  const f=fixture();
  f.context.learnerQuestions.ask({id:"choice",purpose:"CHECK",session_id:f.manager.getSessionId(),goal_id:"goal",task_id:"task",skill_id:"skill",
    questions:[{id:"q",prompt:question,selection:"single",options:[{id:"a",label:"5和23"},{id:"b",label:"都是5"}]}]});
  f.context.learnerQuestions.answer("",{request_id:"choice",answers:[{question_id:"q",selected_option_ids:["a"],other_text:"字符串触发拼接"}]});
  await createRecordAnswerAssessmentTool(f.context,f.options,()=>assessmentSource(f.manager)).execute("grade",{...input,assistance_level:"INDEPENDENT"},undefined,undefined,{} as never);
  assert.equal(f.saved()!.assistance_level,"WITH_HINT");
});

test("skip and pending questions are not scored, and failed storage never returns a saved card", async () => {
  const skip = fixture("跳过");
  await assert.rejects(createRecordAnswerAssessmentTool(skip.context, skip.options, () => assessmentSource(skip.manager)).execute("skip", input, undefined, undefined, {} as never), /跳过/);
  const f = fixture();
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => !init?.body ? Response.json(overview) : Response.json({detail: "storage unavailable"}, {status: 503})) as typeof fetch;
  await assert.rejects(createRecordAnswerAssessmentTool(f.context, {fetchImpl}, () => assessmentSource(f.manager)).execute("grade", input, undefined, undefined, {} as never), /未能保存/);
});

test("large Unicode answers preserve complete source hash and bounded readable excerpts", async () => {
  const f = fixture("解释😀".repeat(4000));
  const source = assessmentSource(f.manager)!;
  await createRecordAnswerAssessmentTool(f.context, f.options, () => source).execute("grade", input, undefined, undefined, {} as never);
  assert.equal(f.saved()!.answer_truncated, true);
  assert.equal(Array.from(f.saved()!.answer_excerpt as string).length, 8000);
  assert.equal(f.saved()!.answer_sha256, createHash("sha256").update(source.answer).digest("hex"));
});

test("previous-question hints and merely mentioning documents do not contaminate a new answer", async () => {
  const f = fixture("文档说明这种转换规则。");
  f.context.recordTurn({active_skill_id: "skill", active_task_id: "task", teaching_mode: "QUIZ", outcome: "START", current_question: "之前完全不同的题目", hint_level: 4});
  await createRecordAnswerAssessmentTool(f.context, f.options, () => assessmentSource(f.manager)).execute("grade", input, undefined, undefined, {} as never);
  assert.equal(f.saved()!.assistance_level, "INDEPENDENT");
  const referenced = fixture("我参考了文档再作答。");
  await createRecordAnswerAssessmentTool(referenced.context, referenced.options, () => assessmentSource(referenced.manager)).execute("grade", input, undefined, undefined, {} as never);
  assert.equal(referenced.saved()!.assistance_level, "WITH_REFERENCE");
});

test("freeform CHECK collects actual answers without manufacturing choice assistance", async () => {
  const f = fixture();
  const request = {purpose: "CHECK" as const, active_skill_id: "skill", active_task_id: "task",
    questions: [{id: "q", prompt: question, selection: "freeform" as const, options: []}]};
  await createLearnerQuestionTool(f.context, new GoalOnboardingContext(), f.options).execute("ask", request, undefined, undefined, {} as never);
  const pending = f.context.learnerQuestions.snapshot().pending!;
  f.context.learnerQuestions.answer("", {request_id: pending.id, answers: [{question_id: "q", selected_option_ids: [], other_text: "5和23，字符串拼接"}]});
  assert.equal(f.context.learnerQuestions.snapshot().last_answer!.choices_exposed, false);
  assert.equal(f.context.learnerQuestions.writeGuard("record_answer_assessment"), undefined);
});

test("returning from a route branch keeps actual help on the original answer, including UNKNOWN model judgment", async () => {
  const f = fixture();
  f.context.learnerQuestions.ask({id:"original-route-question",purpose:"CHECK",session_id:f.manager.getSessionId(),goal_id:"goal",skill_id:"skill",task_id:"task",
    questions:[{id:"q",prompt:question,selection:"freeform",options:[]}]});
  f.context.restoreLearningPath(f.context.snapshot(), true);
  f.context.learnerQuestions.answer("",{request_id:"original-route-question",answers:[{question_id:"q",selected_option_ids:[],other_text:"5和23，因为字符串参与加法。"}]});
  assert.equal(f.context.branchHelpForCurrentAnswer(),true);
  await createRecordAnswerAssessmentTool(f.context,f.options,()=>assessmentSource(f.manager)).execute("grade",{...input,assistance_level:"UNKNOWN"},undefined,undefined,{} as never);
  assert.equal(f.saved()!.assistance_level,"WITH_HELP");
  f.context.learnerQuestions.ask({id:"new-question",purpose:"CHECK",session_id:f.manager.getSessionId(),goal_id:"goal",skill_id:"skill",task_id:"task",
    questions:[{id:"q2",prompt:"另一道题",selection:"freeform",options:[]}]});
  f.context.learnerQuestions.answer("新题答案");
  assert.equal(f.context.branchHelpForCurrentAnswer(),false,"help is bound to the original question rather than all future answers");
});

test("interleaved review cannot silently grade a different topic or create current-Skill Evidence", async () => {
  const f = fixture();
  f.context.learnerQuestions.ask({id: "review-q", purpose: "CHECK", session_id: f.manager.getSessionId(), goal_id: "goal", task_id: "task", skill_id: "skill",
    review_topic_id: "old-topic", review_skill_id: "old-skill", questions: [{id: "q", prompt: question, selection: "freeform", options: []}]});
  f.context.learnerQuestions.answer("5和23");
  const tool = createRecordAnswerAssessmentTool(f.context, f.options, () => assessmentSource(f.manager));
  await assert.rejects(tool.execute("grade", input, undefined, undefined, {} as never), /原topic_id/);
  const guard = f.context.evidenceWriteGuard({skill_id: "skill", evidence_type: "EXPLAIN", description: "错归当前Skill", assistance_level: "INDEPENDENT", source: "test"});
  assert.equal(guard?.block, true);
});

test("score cards require a valid ten-point rubric and escape teacher-provided text", async () => {
  const f = fixture();
  const result = await createRecordAnswerAssessmentTool(f.context, f.options, () => assessmentSource(f.manager)).execute("grade", {...input, summary: "<img src=x onerror=alert(1)>"}, undefined, undefined, {} as never);
  const a = result.details.assessment;
  assert.equal(readAnswerAssessment({...a, score: 10}), null);
  const markup = answerAssessmentMarkup(a);
  assert.match(markup, /&lt;img/); assert.doesNotMatch(markup, /<img/);
  assert.match(markup, /评分依据/); assert.match(markup, /继续往下学/);
});
