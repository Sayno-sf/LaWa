import {createTeachingFaux as createFauxCore} from "../testing/teachingFaux.js";
import assert from "node:assert/strict";
import test from "node:test";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {createServer} from "node:net";
import {mkdtempSync, rmSync, existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {ModelRuntime, SessionManager} from "@earendil-works/pi-coding-agent";
import {fauxAssistantMessage, fauxToolCall, type Api, type Model} from "@earendil-works/pi-ai";
import {streamSimple} from "@earendil-works/pi-ai/api/openai-completions";
import {createLearningAgentSession} from "../agentSession.js";
import {MaterialReadingRuntime} from "../materialReadingRuntime.js";
import {latestPlanningWait, PLANNING_READY_MESSAGE, PLANNING_RESUME_CORRECTION,
  } from "../planning/planningReadingWait.js";
import type {InitializeLearningGoalInput} from "../planning/planningTypes.js";
import {stopSmokeProcess} from "../smokeProcess.js";
import {WebSessionStore} from "./sessionStore.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const python = join(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
const profile = {id: "goal-calibration", goal_description: "按教材学习校准", background_summary: "初学者", desired_outcome: "可读懂并执行校准",
  learning_preferences: [], time_constraint: "", prior_knowledge_claims: []};
const plan: InitializeLearningGoalInput = {goal_profile: profile, replace_existing: false,
  curriculum_spine: Array.from({length: 5}, (_, n) => ({id: `stage-${n}`, name: `阶段${n}`, description: "目标阶段", target_depth: "PRACTICAL", skill_ids: n === 0 ? ["calibration"] : []})),
  frontier_skills: [{id: "calibration", name: "校准", description: "读懂流程", prerequisites: [], target_depth: "PRACTICAL"}],
  frontier: {focus_skill_id: "calibration", supporting_skill_ids: [], reason: "当前用途", target_depth: "PRACTICAL", suggested_learning_mode: "EXPLAIN", next_action: "解释校准顺序"}};
const reader: Model<Api> = {id: "isolated-vision", provider: "fixture", name: "Isolated vision", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false, input: ["text", "image"], contextWindow: 256_000, maxTokens: 4096, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let n = 0; n < 250; n++) {if (await check()) return; await new Promise(done => setTimeout(done, 40));}
  assert.fail(label);
}

async function scenario(mode: "normal" | "native-main" | "restart" | "inactive" | "stop" | "stop-running" | "changed" | "bind-failure" | "correction" | "clarification" | "start-fallback" | "delete-waiting") {
  const directory = mkdtempSync(join(tmpdir(), "lawa-planning-resume-"));
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as {port: number}).port; reservation.close(); await once(reservation, "close");
  const baseUrl = `http://127.0.0.1:${port}`;
  const args = mode === "bind-failure" ? ["-c", ["from app.materials import MaterialStore", "import uvicorn,sys", "original=MaterialStore.bind_draft", "failed=[False]",
    "def fault(self, session, goal):", "    if not failed[0] and goal=='goal-calibration':", "        failed[0]=True", "        print('isolated binding failure injected',file=sys.stderr,flush=True)", "        raise OSError('isolated binding failure')",
    "    return original(self,session,goal)", "MaterialStore.bind_draft=fault", `uvicorn.run('app.api.main:app',host='127.0.0.1',port=${port},log_level='error')`].join("\n")]
    : ["-m", "uvicorn", "app.api.main:app", "--host", "127.0.0.1", "--port", String(port)];
  const api = spawn(python, args, {
    cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: {...process.env, LEARNING_STATE_PATH: ":memory:",
      LEARNING_BOOTSTRAP: "empty", LEARNING_MATERIALS_DIR: join(directory, "materials")},
  });
  let errors = ""; api.stderr?.on("data", chunk => {errors = (errors + String(chunk)).slice(-4000);});
  let store: WebSessionStore | undefined, reading: MaterialReadingRuntime | undefined, managerFile = "", teacherCalls = 0;
  const resumeContexts: any[] = [], nativeRequests: any[] = [], notices: any[] = [];
  let release!: () => void; const gate = new Promise<void>(done => {release = done;});
  let releaseTeacher!: () => void; const teacherGate = new Promise<void>(done => {releaseTeacher = done;});
  let readerCalls = 0;
  const faux = createFauxCore({tokensPerSecond: 0});
  try {
    await until(async () => {
      if (api.exitCode !== null) throw new Error(errors);
      try {return (await fetch(baseUrl + "/api/learning/overview")).ok;} catch {return false;}
    }, "isolated Kernel startup");
    const runtime = await ModelRuntime.create({authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models.json"),
      allowModelNetwork: false, refreshOnCreate: false});
    runtime.hasConfiguredAuth = () => true;
    runtime.getAuth = async () => ({auth: {apiKey: "fixture-only"}, env: {}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
    runtime.streamSimple = (model, context, options) => {
      teacherCalls++; if (teacherCalls > 4) resumeContexts.push(context);
      if (mode !== "native-main") return faux.streamSimple(model, context, options);
      return streamSimple({...reader, id: "teacher-fixture"} as Model<"openai-completions">, context, {...options, apiKey: "fixture-only",
        fetch: async (url, init) => {
          nativeRequests.push(await new Request(url, init).json());
          const reply = await faux.streamSimple(model, context, options).result();
          const calls = reply.content.filter(p => p.type === "toolCall").map((p, i) => ({index: i, id: p.id, type: "function",
            function: {name: p.name, arguments: JSON.stringify(p.arguments)}}));
          const text = reply.content.filter(p => p.type === "text").map(p => p.text).join("");
          const event = (value: object) => "data: " + JSON.stringify(value) + "\n\n";
          return new Response(event({id: "teacher", choices: [{index: 0, delta: {role: "assistant", ...(text ? {content: text} : {}),
            ...(calls.length ? {tool_calls: calls} : {})}, finish_reason: null}]})
            + event({id: "teacher", choices: [{index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop"}],
              usage: {prompt_tokens: 200, completion_tokens: 100}}) + "data: [DONE]\n\n", {headers: {"Content-Type": "text/event-stream"}});
        }});
    };
    const makeStore = () => {
      reading = new MaterialReadingRuntime({baseUrl, selection: async () => ({model: reader, thinkingLevel: "off", runtime: {completeSimple: async (model, context, options) => {
        return streamSimple(model as Model<"openai-completions">, context, {...options, apiKey: "fixture-only", fetch: async (url, init) => {
          readerCalls++;
          const request = await new Request(url, init).json() as any;
          await new Promise<void>((done, reject) => {
            const aborted = () => reject(new DOMException("aborted", "AbortError"));
            init?.signal?.addEventListener("abort", aborted, {once: true});
            gate.then(done).finally(() => init?.signal?.removeEventListener("abort", aborted));
            if (init?.signal?.aborted) aborted();
          });
          assert.ok(JSON.stringify(request.messages).includes("SOURCE_CALIBRATION"));
          const integrate = Boolean(request.tools[0].function.parameters.properties.sufficient);
          const args = {note: {summary: "零参考→校准→样品比较；q=3v+4。", concepts: [], facts: ["q=3v+4"], dependencies: ["比较依赖校准"], uncertainties: []},
            ...(integrate ? {sufficient: true, reading_blockers: []} : {})};
          const event = (value: object) => "data: " + JSON.stringify(value) + "\n\n";
          return new Response(event({id: "reading", choices: [{index: 0, delta: {role: "assistant", tool_calls: [{index: 0, id: "note", type: "function",
            function: {name: "submit_material_reading_note", arguments: JSON.stringify(args)}}]}, finish_reason: null}]})
            + event({id: "reading", choices: [{index: 0, delta: {}, finish_reason: "tool_calls"}], usage: {prompt_tokens: 120, completion_tokens: 60}}) + "data: [DONE]\n\n",
          {headers: {"Content-Type": "text/event-stream"}});
        }}).result();
      }}})});
      const ownedReading = reading;
      const owned = new WebSessionStore({apiBaseUrl: baseUrl, conversationDir: join(directory, "sessions"), materialReading: ownedReading,
        log: () => {}, createAgent: async (context, planning, emit, manager) => {
          managerFile = manager.getSessionFile()!;
          return createLearningAgentSession(context, planning, {apiBaseUrl: baseUrl, model: faux.getModel(), modelRuntime: runtime,
            materialReading: ownedReading, sessionManager: manager, surface: "WEB", retrieval: false, assistantSupport: false,
            teachingInstructions: () => "", onEvent: emit, log: () => {}});
        }});
      owned.classroom.subscribe(notice => notices.push(notice));
      ownedReading.start(); return owned;
    };
    store = makeStore();
    const opened = await store.create("new-goal");
    const sessionId = opened.sessionId;
    const query = new URLSearchParams({filename: "校准教材.md", draft_session_id: sessionId, purpose: "conversation_attachment", conversation_id: sessionId});
    const upload = await fetch(baseUrl + "/api/user/materials?" + query, {method: "POST", body: "SOURCE_CALIBRATION\n先零参考，再校准，再比较。q=3v+4。"});
    assert.equal(upload.status, 201); const material = (await upload.json() as {id: string}).id;
    const packet = (tool: string, args: any) => fauxAssistantMessage(fauxToolCall(tool, args), {stopReason: "toolUse"});
    const clarificationQuestion = "这些请求应按哪个创建日期范围处理？";
    const clarificationAnswer = "这些请求都在 2026-10-05 创建。";
    const resumedResponses = mode === "correction"
      ? [
          () => fauxAssistantMessage("这是资料框架说明，但还没有保存学习路线。"),
          () => packet("initialize_learning_goal", plan),
        ]
      : mode === "clarification"
        ? [
            () => packet("ask_learner_questions", {purpose: "BACKGROUND", questions: [{
              id: "request-date", prompt: clarificationQuestion, selection: "freeform", options: [],
            }]}),
            () => fauxAssistantMessage("请补充适用日期。"),
          ]
        : mode === "start-fallback"
          ? [
              () => packet("initialize_learning_goal", plan),
              () => fauxAssistantMessage("路线已经保存。"),
            ]
        : [
            async () => {if (mode === "stop-running") await teacherGate; return packet("initialize_learning_goal", plan);},
          ];
    faux.setResponses([
      () => packet("record_goal_understanding", {outcome: "READY_FOR_CONFIRMATION", profile, material_basis: [material], primary_material_id: material}),
      () => packet("ask_learner_questions", {purpose: "CONFIRM_GOAL"}),
      () => fauxAssistantMessage("请确认目标与教材。"),
      () => packet("record_goal_understanding", {outcome: "CONFIRMED"}),
      // CONFIRMED后的等待由运行时直接呈现，不再请求模型尝试一个必定被拒的初始化。
      ...resumedResponses,
      ...(mode === "clarification" ? [() => packet("initialize_learning_goal", plan)] : []),
      () => packet("create_learning_task", {title: "不能由机器自动创建", description: "等待用户开始", related_skill_ids: ["calibration"], expected_evidence_types: ["EXPLAIN"],
        teaching_activity: {method: "APPLY", purpose: "理解校准", learner_action: "解释顺序", observable_output: "步骤说明", evaluation_focus: ["顺序正确"], observation_limits: "单题不证明掌握"}}),
      context => {assert.equal((context.messages.at(-1) as any).isError, true); return packet("ask_learner_questions", {purpose: "START_LEARNING"});},
      () => fauxAssistantMessage("资料已读完，路线已保存。准备好后开始。"),
    ]);
    await store.sendMessage(sessionId, "请按我上传的校准教材安排学习。", () => {});
    const confirmation = (await store.state(sessionId)).teaching.learner_questions!.pending!;
    await store.sendMessage(sessionId, "", () => {}, {request_id: confirmation.id,
      answers: [{question_id: confirmation.questions[0]!.id, selected_option_ids: ["proceed"], other_text: ""}]});
    const readManager = () => SessionManager.open(managerFile, join(directory, "sessions"), root);
    assert.equal(latestPlanningWait(readManager())?.data.state, "WAITING");
    const requirementId = latestPlanningWait(readManager())!.data.snapshot.reading_requirement!.id;
    assert.equal(teacherCalls, 4);
    if (mode === "delete-waiting") {
      await until(() => readerCalls > 0, "reader actually dispatched before deletion");
      const deleted = await fetch(`${baseUrl}/api/user/materials/${material}?draft_session_id=${sessionId}`, {method: "DELETE"});
      assert.equal(deleted.status, 204);
      assert.equal(store.materialDeleted(material), true, "a planning wait that owns the deleted material must be affected");
      reading!.materialDeleted(material);
      await until(() => latestPlanningWait(readManager())?.data.state === "CANCELED",
        "material deletion cancels the dependent planning wait");
      const stopped = await store.state(sessionId);
      assert.equal(stopped.onboarding.status, "CONFIRMED");
      assert.equal(stopped.overview.goal_profile, null);
      assert.equal(stopped.overview.curriculum_spine.length, 0);
      assert.equal(stopped.teaching.learner_questions?.pending, null);
      assert.equal(readManager().getBranch().filter(entry => entry.type === "message" && entry.message.role === "user").length, 2);
      const callsBeforeRestart = teacherCalls, readsBeforeRestart = readerCalls;
      store.dispose(); reading!.dispose();
      store = makeStore();
      const reopened = await store.create("resume-recent");
      assert.equal(reopened.sessionId, sessionId);
      assert.equal(reopened.state.overview.goal_profile, null);
      assert.notEqual(reopened.state.onboarding.status, "INITIALIZED");
      assert.equal(teacherCalls, callsBeforeRestart, "restart must not resume a deleted planning source");
      assert.equal(readerCalls, readsBeforeRestart, "deleted reading work cannot be rediscovered");
      return;
    }
    if (mode === "restart") {
      // 这个场景核验已实际派发的后台请求在关闭时释放；未拿到claim回包的恢复由独立故障注入覆盖。
      await until(() => readerCalls > 0, "reader actually dispatched before restart");
      store.dispose();
      await until(async () => {
        const response = await fetch(`${baseUrl}/api/learning/materials/${material}/reading?draft_session_id=${sessionId}`);
        return (await response.json() as {state: string}).state === "QUEUED";
      }, "disposed reader releases its lease");
      store = makeStore(); const resumed = await store.create("resume-recent");
      assert.equal(resumed.sessionId, sessionId); assert.equal(resumed.state.onboarding.status, "CONFIRMED");
      assert.equal(resumed.state.onboarding.reading_requirement?.id, requirementId);
    }
    if (mode === "inactive") await store.create("new");
    if (mode === "stop") await store.stop(sessionId);
    if (mode === "changed") {
      const other = {...plan, goal_profile: {...profile, id: "goal-another", goal_description: "另一个已提交目标"},
        curriculum_spine: plan.curriculum_spine.map((stage, index) => ({...stage, skill_ids: index === 0 ? ["another-skill"] : []})),
        frontier_skills: [{...plan.frontier_skills[0]!, id: "another-skill"}], frontier: {...plan.frontier, focus_skill_id: "another-skill"}};
      assert.equal((await fetch(baseUrl + "/api/learning/curriculum/initialize", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(other)})).status, 201);
    }
    release();
    if (mode === "stop-running") {
      await until(() => teacherCalls === 5 && latestPlanningWait(readManager())?.data.state === "RUNNING", "resumed SDK request is actually running");
      const run = (await store.sharedClassroom()).run!;
      const stopping = store.stop(sessionId, run.id); releaseTeacher(); await stopping;
      await until(async () => (await store!.sharedClassroom()).run?.status !== "running", "stopped machine run releases classroom");
      assert.equal((await (await fetch(baseUrl + "/api/learning/overview")).json() as any).goal_profile, null);
      assert.equal(teacherCalls, 5, "late initializer cannot continue after Stop");
    }
    if (mode === "inactive" || mode === "stop") {
      await until(async () => (await (await fetch(`${baseUrl}/api/learning/materials/${material}/reading?draft_session_id=${sessionId}`)).json() as {state: string}).state === "READY", "background reading finishes");
      assert.equal(teacherCalls, 4, "inactive or stopped waits must not trigger teacher calls");
      assert.equal((await (await fetch(baseUrl + "/api/learning/overview")).json() as any).goal_profile, null);
      if (mode === "inactive") await store.activateConversation(sessionId);
    }
    if (mode === "clarification") {
      await until(() => latestPlanningWait(readManager())?.data.state === "COMPLETED",
        "clarification ends the machine resume without marking failure");
      const clarified = await store.state(sessionId);
      assert.equal(clarified.onboarding.status, "CONFIRMED", JSON.stringify({
        teacherCalls,
        wait: latestPlanningWait(readManager())?.data,
        questions: clarified.teaching.learner_questions,
        toolCalls: readManager().getBranch().flatMap(entry => entry.type === "message" && entry.message.role === "assistant"
          ? entry.message.content.filter(part => part.type === "toolCall").map(part => part.name) : []),
      }));
      assert.equal(clarified.teaching.learner_questions?.pending?.purpose, "BACKGROUND");
      assert.equal(clarified.overview.goal_profile, null);
      await store.sendMessage(sessionId, clarificationAnswer, () => {});
    }
    if (mode === "changed") {
      await until(async () => (await (await fetch(`${baseUrl}/api/learning/materials/${material}/reading?draft_session_id=${sessionId}`)).json() as {state: string}).state === "READY", "source read after Kernel changed");
      assert.equal(teacherCalls, 4);
      assert.equal((await (await fetch(baseUrl + "/api/learning/overview")).json() as any).goal_profile.id, "goal-another");
      assert.equal(latestPlanningWait(readManager())?.data.state, "WAITING");
    } else if (mode !== "stop" && mode !== "stop-running") {
      try {await until(() => latestPlanningWait(readManager())?.data.state === "COMPLETED", "machine continuation completes");}
      catch {
        const resource = await (await fetch(`${baseUrl}/api/learning/materials/${material}/reading?draft_session_id=${sessionId}`)).json() as any;
        const wait = latestPlanningWait(readManager())?.data;
        assert.fail(JSON.stringify({failure: "machine continuation completes", mode, teacherCalls, readerCalls,
          wait: wait?.state, reason: wait?.reason, reading: resource.state, readingError: resource.error_code,
          classroom: (await store.sharedClassroom()).run?.status}));
      }
      assert.equal(teacherCalls, mode === "correction" ? 9 : mode === "clarification" ? 10 :
        mode === "start-fallback" ? 7 : 7);
      const state = await store.state(sessionId);
      assert.equal(state.onboarding.status, "INITIALIZED");
      assert.equal(state.teaching.learner_questions?.pending?.purpose, "START_LEARNING",
        JSON.stringify({mode, teacherCalls, questions: state.teaching.learner_questions,
          tools: readManager().getBranch().flatMap(entry => entry.type === "message" && entry.message.role === "assistant"
            ? entry.message.content.filter(part => part.type === "toolCall").map(part => ({name: part.name, args: part.arguments})) : []),
          notices}));
      assert.equal((state.overview.goal_profile as any).id, profile.id);
      assert.equal(state.overview.active_task, null); assert.equal(state.overview.recent_evidence.length, 0);
      assert.ok(notices.some(notice => notice.type === "event" && notice.event.type === "conversation_update"));
      assert.ok(resumeContexts.length >= (mode === "start-fallback" ? 2 : 3));
      for (const context of resumeContexts) {
        const supplied = JSON.stringify(context.messages);
        assert.ok(supplied.includes("[LaWa只读规划资料]"), "actual main-teacher input must carry reading content, not only READY");
        assert.ok(supplied.includes("SOURCE_CALIBRATION"), "a fitting original remains available across tool rounds and draft binding");
        assert.ok(supplied.includes("比较依赖校准"), "cross-step dependency reaches the planner");
        assert.ok(supplied.includes("q=3v+4"));
        const directUsers = context.messages.filter((message: any) => message.role === "user").length;
        assert.equal(directUsers, mode === "clarification" && supplied.includes(clarificationAnswer) ? 3 : 2);
        assert.ok(!JSON.stringify(context.messages.filter((message: any) => message.role === "user")).includes("MachinePlanningReady:"));
        if (!(mode === "clarification" && supplied.includes(clarificationAnswer)))
          assert.match(context.systemPrompt, /不是新user/);
      }
      if (mode === "native-main") {
        assert.equal(nativeRequests.length, 7);
        for (const request of nativeRequests.slice(4)) {
          assert.ok(JSON.stringify(request.messages).includes("SOURCE_CALIBRATION"), "main SDK transport, not just preconversion context, must contain original source");
          assert.ok(JSON.stringify(request.messages).includes("比较依赖校准"));
          assert.equal(request.messages.filter((m: any) => m.role === "user").length, 2);
          assert.ok(!JSON.stringify(request.messages).includes("MachinePlanningReady:"));
        }
      }
      assert.equal(readManager().getBranch().filter(entry => entry.type === "custom_message" &&
        entry.customType === PLANNING_READY_MESSAGE).length, mode === "clarification" ? 2 : 1);
      assert.equal(readManager().getBranch().filter(entry => entry.type === "custom_message"
        && entry.customType === PLANNING_RESUME_CORRECTION).length, mode === "correction" ? 1 : 0);
      assert.equal((await store.sharedClassroom()).run?.status, "completed");
      if (mode === "bind-failure") {
        assert.match(errors, /isolated binding failure/, "the real Kernel binding fault was injected");
        assert.equal(latestPlanningWait(readManager())?.data.state, "COMPLETED");
        store.dispose(); store = makeStore(); const reopened = await store.create("resume-recent");
        assert.equal(reopened.state.overview.current_goal, profile.goal_description);
        assert.ok(["IDLE", "INITIALIZED"].includes(reopened.state.onboarding.status), "a reconciled commit cannot reopen old Goal onboarding");
        assert.equal(teacherCalls, 7, "HTTP receipt recovery and restart must not call the teaching model again");
      }
    } else assert.equal(latestPlanningWait(readManager())?.data.state, "CANCELED");
    assert.equal(readManager().getBranch().filter(entry => entry.type === "message" && entry.message.role === "user").length,
      mode === "clarification" ? 3 : 2);
    assert.ok(readerCalls >= 2);
  } finally {
    release(); releaseTeacher(); store?.dispose(); reading?.dispose(); await stopSmokeProcess(api); rmSync(directory, {recursive: true, force: true});
  }
}

test("actual Web/Pi/SDK/Kernel completes a confirmed source plan through a machine event without grading or creating a task", () => scenario("normal"));
test("native main-teacher SDK transport receives the complete reading packet and fitting original without a synthetic learner", () => scenario("native-main"));
test("machine continuation retries once when the model gives only a framework instead of saving a route", () => scenario("correction"));
test("a source conflict uses the question component and resumes only after the real answer", () => scenario("clarification"));
test("the runtime supplies the fixed START_LEARNING component when a saved route ends without one", () => scenario("start-fallback"));
test("deleting a planning source cancels its wait and cannot revive across restart", () => scenario("delete-waiting"));
test("persisted waiting resumes after a new Web store and reader, without requesting Goal confirmation again", () => scenario("restart"));
test("completion in an inactive conversation waits for explicit navigation back to its original branch", () => scenario("inactive"));
test("Stop cancels automatic planning while authorized resource reading may still finish", () => scenario("stop"));
test("Stop during the actual resumed SDK run prevents its delayed initialization result from changing the Kernel", () => scenario("stop-running"));
test("a changed authoritative Kernel workspace defers the old plan instead of replacing a newer Goal", () => scenario("changed"));
test("Kernel-save/binding failure reconciles the original receipt without another model call or duplicate Goal after restart", () => scenario("bind-failure"));
