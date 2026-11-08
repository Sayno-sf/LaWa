import {createTeachingFaux as createFauxCore} from "../testing/teachingFaux.js";
import assert from "node:assert/strict";
import test from "node:test";
import {createServer} from "node:http";
import {mkdtempSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {ModelRuntime, SessionManager} from "@earendil-works/pi-coding-agent";
import {fauxAssistantMessage, fauxToolCall} from "@earendil-works/pi-ai";
import {createLearningAgentSession} from "../agentSession.js";
import {MaterialReadingRuntime} from "../materialReadingRuntime.js";
import {TeachingSessionContext} from "../teachingSession.js";
import {goalConfirmationSignature} from "../learnerQuestions.js";
import {GoalOnboardingContext} from "./goalOnboarding.js";
import {createRecordGoalUnderstandingTool, createInitializeLearningGoalTool} from "./planningTools.js";
import {PlanningReadingCoordinator, planningHash} from "./planningReading.js";
import type {InitializeLearningGoalInput} from "./planningTypes.js";

const material = "mat-" + "a".repeat(32);
const profile = {id: "goal-lab", goal_description: "按教材学习校准", background_summary: "初学者", desired_outcome: "可读懂流程",
  learning_preferences: [], time_constraint: "", prior_knowledge_claims: []};
const plan: InitializeLearningGoalInput = {goal_profile: profile, replace_existing: false,
  curriculum_spine: Array.from({length: 5}, (_, n) => ({id: `stage-${n}`, name: `阶段${n}`, description: "目标阶段", target_depth: "PRACTICAL", skill_ids: n === 0 ? ["calibration"] : []})),
  frontier_skills: [{id: "calibration", name: "校准", description: "流程", prerequisites: [], target_depth: "PRACTICAL"}],
  frontier: {focus_skill_id: "calibration", supporting_skill_ids: [], reason: "目标", target_depth: "PRACTICAL", suggested_learning_mode: "EXPLAIN", next_action: "读懂流程"}};
const execute = (tool: any, params: any) => tool.execute("call", params, new AbortController().signal, undefined, {});

test("failed understanding preflight cannot register sources or start background work", async () => {
  let calls = 0;
  const runtime = new MaterialReadingRuntime({baseUrl: "http://preflight.invalid", selection: async () => {assert.fail();},
    fetcher: async () => {calls++; assert.fail("no HTTP before onboarding permission");}});
  try {
    const coordinator = new PlanningReadingCoordinator(runtime, () => ({sessionId: "session", userEntryId: "user-1"}));
    const tool = createRecordGoalUnderstandingTool(new GoalOnboardingContext(), coordinator);
    await assert.rejects(execute(tool, {outcome: "READY_FOR_CONFIRMATION", profile, material_basis: [material]}), /新目标/);
    assert.equal(calls, 0);
  } finally {runtime.dispose();}
});

test("a changed actual user during source preparation cannot replace the pending understanding", async () => {
  let userEntryId = "user-1";
  const runtime = new MaterialReadingRuntime({baseUrl: "http://origin.invalid", selection: async () => {assert.fail();}, fetcher: async url => {
    if (String(url).includes("/requirements")) {userEntryId = "user-2"; return Response.json({});}
    if (String(url).includes("/metadata")) return Response.json({name: "主教材.md"});
    return Response.json({source: {scope: "draft:session"}, role: "basis", state: "READY"});
  }});
  const context = new GoalOnboardingContext(); context.start(); const before = context.snapshot();
  try {
    const coordinator = new PlanningReadingCoordinator(runtime, () => ({sessionId: "session", userEntryId}));
    await assert.rejects(execute(createRecordGoalUnderstandingTool(context, coordinator), {outcome: "READY_FOR_CONFIRMATION", profile, material_basis: [material]}), /PLANNING_ORIGIN_CHANGED/);
    assert.deepEqual(context.snapshot(), before);
  } finally {runtime.dispose();}
});

test("source changes invalidate confirmation signatures and initialization cannot change the confirmed profile", async () => {
  assert.notEqual(goalConfirmationSignature(profile, "a".repeat(64)), goalConfirmationSignature(profile, "b".repeat(64)));
  const context = new GoalOnboardingContext(); context.start();
  context.record({outcome: "READY_FOR_CONFIRMATION", profile}, {id: "a".repeat(64), session_id: "cli-runtime",
    user_entry_id: "actual-user", profile_hash: planningHash(profile), materials: []});
  context.beginUserTurn("确认"); context.record({outcome: "CONFIRMED"});
  let writes = 0;
  let body: any;
  const tool = createInitializeLearningGoalTool(context, {log: () => {}, fetchImpl: async (_url, options) => {writes++; body = JSON.parse(String(options?.body)); return Response.json({});}});
  await assert.rejects(execute(tool, {...plan, goal_profile: {...profile, desired_outcome: "偷偷改变用途"}}), /full user-confirmed/);
  assert.equal(writes, 0);
  await assert.rejects(execute(createRecordGoalUnderstandingTool(context), {outcome: "CONFIRMED", material_basis: []}), /不得同时改换/);
  await execute(tool, plan);
  assert.equal(body.onboarding_session_id, "cli-runtime", "runtime proof retains its real scope even outside Web");
  assert.equal(body.reading_requirement_id, "a".repeat(64));
});

test("actual Pi entries bind source requirements, names, independent confirmation and the final request token", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-planning-origin-"));
  const manager = SessionManager.create(directory, directory);
  const sessionId = manager.getSessionId();
  const teacher = new TeachingSessionContext(); teacher.bindSession(sessionId);
  const planning = new GoalOnboardingContext(); planning.start();
  const requests: Array<{path: string; body: any}> = [];
  const overview = {current_goal: null, goal_profile: null, curriculum_spine: [], current_frontier: null,
    current_focus: null, skills: [], recent_evidence: [], active_task: null, learning_history: [], current_goal_skill_ids: []};
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({path: req.url!, body}); res.setHeader("Content-Type", "application/json");
    if (req.url?.includes("/context?")) res.end(JSON.stringify({version: 1, request_id: planning.snapshot().reading_requirement!.id,
      goal_profile_hash: planningHash(profile), sources: [{source: {material_id: material}, synthesis: {sufficient: true,
        summary: "校准前先建立零参考", facts: ["q=3v+4"]}, native_text: "SOURCE_PLANNING_CONTRACT"}]}));
    else if (req.url?.includes("/requirements")) res.end(JSON.stringify(req.method === "GET" ? {state: "READY"} : body));
    else if (req.url?.includes("/metadata")) res.end(JSON.stringify({id: material, name: "主教材.md",
      sha256: "a".repeat(64), purpose_revision: 0}));
    else if (req.url?.includes("/reading")) res.end(JSON.stringify({source: {scope: "draft:" + sessionId}, role: "basis", state: "READY"}));
    else if (req.url?.includes("/curriculum/initialize")) res.end(JSON.stringify({goal_profile: profile}));
    else res.end(JSON.stringify(overview));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as {port: number}).port, baseUrl = `http://127.0.0.1:${port}`;
  const reading = new MaterialReadingRuntime({baseUrl, selection: async () => {assert.fail("ready resources need no background call");}});
  const faux = createFauxCore({tokensPerSecond: 0});
  faux.setResponses([
    () => fauxAssistantMessage(fauxToolCall("record_goal_understanding", {outcome: "READY_FOR_CONFIRMATION", profile, material_basis: [material], primary_material_id: material}), {stopReason: "toolUse"}),
    () => fauxAssistantMessage(fauxToolCall("ask_learner_questions", {purpose: "CONFIRM_GOAL"}), {stopReason: "toolUse"}),
    () => fauxAssistantMessage("请确认目标与教材。"),
    () => fauxAssistantMessage(fauxToolCall("record_goal_understanding", {outcome: "CONFIRMED"}), {stopReason: "toolUse"}),
    ctx => {assert.ok(JSON.stringify(ctx.messages).includes("SOURCE_PLANNING_CONTRACT"));
      return fauxAssistantMessage(fauxToolCall("initialize_learning_goal", plan), {stopReason: "toolUse"});},
    () => fauxAssistantMessage("已保存路线，等待开始授权。"),
  ]);
  const runtime = await ModelRuntime.create({authPath: join(directory, "auth.json"), modelsPath: null,
    modelsStorePath: join(directory, "models.json"), allowModelNetwork: false, refreshOnCreate: false});
  runtime.streamSimple = faux.streamSimple; runtime.hasConfiguredAuth = () => true;
  runtime.getAuth = async () => ({auth: {apiKey: "isolated-only"}, env: {}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  let agent: Awaited<ReturnType<typeof createLearningAgentSession>> | undefined;
  try {
    agent = await createLearningAgentSession(teacher, planning, {apiBaseUrl: baseUrl, model: faux.getModel(), modelRuntime: runtime,
      materialReading: reading, sessionManager: manager, surface: "WEB", retrieval: false, assistantSupport: false, log: () => {}});
    const first = "请按我上传的主教材安排学习。";
    planning.beginUserTurn(first);
    assert.equal((await agent.prompt(first))?.status, "completed");
    const requirement = requests.find(request => request.path.includes("/requirements"))!;
    assert.ok(requirement, "actual Pi tool must reach source registration");
    const users = manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user");
    assert.equal(users.length, 1); assert.equal(requirement.body.user_entry_id, users[0]!.id);
    assert.equal(requirement.body.goal_profile_hash, planningHash(profile));
    const reference = planning.snapshot().reading_requirement!;
    assert.equal(reference.session_id, sessionId); assert.equal(reference.id, requirement.body.request_id);
    const pending = teacher.learnerQuestions.snapshot().pending!;
    assert.match(pending.questions[0]!.prompt, /主教材.md/);
    assert.equal(pending.scope_signature, goalConfirmationSignature(profile, reference.id));
    assert.ok(!requests.some(request => request.path.includes("/curriculum/initialize")), "basis/READY is not user confirmation");
    teacher.learnerQuestions.answer("确认"); planning.beginUserTurn("确认");
    assert.equal((await agent.prompt("确认"))?.status, "completed");
    assert.equal(planning.snapshot().status, "INITIALIZED");
    const initialized = requests.find(request => request.path.includes("/curriculum/initialize"))!;
    assert.equal(initialized.body.onboarding_session_id, sessionId); assert.equal(initialized.body.reading_requirement_id, reference.id);
    assert.equal(manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user").length, 2, "resource preparation adds no fake learner message");
    assert.ok(!requests.some(request => /\/evidence|\/assessments|\/tasks/.test(request.path)));
  } finally {
    agent?.dispose(); reading.dispose(); await new Promise<void>(done => server.close(() => done()));
    rmSync(directory, {recursive: true, force: true});
  }
});
