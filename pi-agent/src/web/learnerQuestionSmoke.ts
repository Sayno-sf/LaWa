import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type Context, type ToolResultMessage } from "@earendil-works/pi-ai";
import { chromium, type Page } from "playwright-core";
import { createLearningAgentSession } from "../agentSession.js";
import type { LearningOverview } from "../learningOverviewTool.js";
import type { LearnerQuestion } from "../learnerQuestionTypes.js";
import type { GoalProfileInput } from "../planning/planningTypes.js";
import type { CandidateEvidence } from "../teachingSession.js";
import { stopSmokeProcess } from "../smokeProcess.js";
import { createGateway } from "./gateway.js";
import { WebSessionStore } from "./sessionStore.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const temp = mkdtempSync(join(tmpdir(), "lawa-questions-smoke-"));
const portProbe = createServer(); portProbe.listen(0, "127.0.0.1"); await once(portProbe, "listening");
const apiAddress = portProbe.address(); assert.ok(apiAddress && typeof apiAddress === "object");
const apiPort = apiAddress.port; portProbe.close(); await once(portProbe, "close");
const apiUrl = `http://127.0.0.1:${apiPort}`;
const env: NodeJS.ProcessEnv = { ...process.env, LEARNING_STATE_PATH: ":memory:", LEARNING_MATERIALS_DIR: join(temp, "materials") };
delete env.LEARNING_BOOTSTRAP;
const python = join(root, ".venv", "Scripts", "python.exe");
const api = spawn(process.env.PYTHON ?? (existsSync(python) ? python : "python"),
  ["-m", "uvicorn", "app.api.main:app", "--host", "127.0.0.1", "--port", String(apiPort)],
  { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let apiErrors = ""; api.stderr?.on("data", (chunk: Buffer) => { apiErrors += chunk.toString(); });
api.on("error", error => { apiErrors += error.message; });

const background: LearnerQuestion[] = [
  { id: "experience", prompt: "你现在接触 Agent 到哪一步？", selection: "single", options: [
    { id: "new", label: "刚开始接触" }, { id: "built", label: "尝试过小项目", description: "还希望理清 Session 与 Context 的边界" }] },
  { id: "preference", prompt: "你更想怎样学习？", selection: "multiple", options: [
    { id: "explain", label: "先理解概念" }, { id: "practice", label: "边做边学" }, { id: "examples", label: "结合具体例子" }] },
];
const check: LearnerQuestion[] = [{ id: "session", prompt: "Session 主要保存什么？请补充用途。", selection: "single", options: [
  { id: "history", label: "完整对话历史" }, { id: "last", label: "仅最后一条模型回复" }] }];
const practiceQuestions: LearnerQuestion[] = Array.from({length: 10}, (_, index) => ({
  id: `practice-${index + 1}`,
  prompt: `第 ${index + 1} 道日常练习`,
  selection: "single",
  options: [{id: "a", label: "选项 A"}, {id: "b", label: "选项 B"}],
}));
const profile: GoalProfileInput = { id: "goal-agent-questions", goal_description: "理解 Agent 的 Session 与 Context",
  background_summary: "待补充", desired_outcome: "能解释两者边界", learning_preferences: [], time_constraint: "未说明", prior_knowledge_claims: [] };
const skillId = "session-context"; let taskId = "";
const spine = ["Session 与 Context", "工具与权限", "状态保存", "上下文整理", "实践与验证"].map((name, i) => ({ id: i ? `agent-step-${i}` : skillId, name, description: name, target_depth: "PRACTICAL" as const }));
function result<T>(context: Context, name: string): T {
  const message = [...context.messages].reverse().find((m): m is ToolResultMessage => m.role === "toolResult" && m.toolName === name);
  assert.ok(message, `${name} must run through Pi`);
  assert.equal(message.isError, false, `${name}: ${JSON.stringify(message.content)}`);
  const text = message.content.find(c => c.type === "text"); assert.ok(text?.type === "text");
  return JSON.parse(text.text) as T;
}
const call = (name: string, args: Record<string, unknown>, id = name) => fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
async function ready(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator("#learning-intro").waitFor({ state: "detached" });
  await page.locator('#connection-status[data-status="ready"]').waitFor();
}
async function send(page: Page, text: string) {
  await page.locator("#message-input").fill(text); await page.locator("#send-button").click();
  await page.locator('#connection-status[data-status="ready"]').waitFor();
}
let gateway: ReturnType<typeof createGateway> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let store: WebSessionStore | undefined;
const modelErrors: string[] = [];
let heldPrompt: { entered: () => void; released: Promise<void> } | undefined;
// 暂停真实 Pi 的下一次 prompt，使断言发生在答案接收后、老师回复前。
async function verifyAcceptedWhileGenerating(page: Page, submit: () => Promise<unknown>, name: string): Promise<void> {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(done => { entered = done; });
  const released = new Promise<void>(done => { release = done; });
  heldPrompt = { entered, released };
  try {
    await submit();
    await Promise.race([started, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("held prompt did not start")), 5000))]);
    const session = (await store!.listConversations()).activeSessionId!;
    assert.equal((await store!.state(session)).teaching.learner_questions?.pending, null);
    assert.ok((await store!.state(session)).teaching.learner_questions?.last_answer);
    await page.locator("#learner-questions").waitFor({ state: "detached", timeout: 1500 });
    assert.equal(await page.locator("#stop-button").isVisible(), true);
    assert.equal(await page.locator("#message-input").isDisabled(), true);
    assert.ok(await page.locator("#messages .message.user").count());
    await page.screenshot({ path: join(tmpdir(), `lawa-question-accepted-${name}.png`), fullPage: true, animations: "disabled" });
  } finally { heldPrompt = undefined; release(); }
}
try {
  let started = false;
  for (let i = 0; i < 100; i++) {
    if (api.exitCode !== null) throw new Error(`isolated API exited: ${apiErrors}`);
    try { if ((await fetch(`${apiUrl}/api/learning/overview`)).ok) { started = true; break; } } catch { /* starting */ }
    await new Promise(done => setTimeout(done, 100));
  }
  assert.ok(started, apiErrors);
  process.env.LEARNING_API_BASE_URL = apiUrl;
  const faux = createFauxCore({ tokensPerSecond: 0 });
  // 使用真实共享 Pi Session/hook、Gateway 和 Python Kernel。仅模型输出使用 Faux，未读取或调用用户凭据。
  const runtime = await ModelRuntime.create({ authPath: join(temp, "auth.json"), modelsPath: null, modelsStorePath: join(temp, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
  runtime.streamSimple = faux.streamSimple;
  runtime.hasConfiguredAuth = provider => provider === faux.getModel().provider;
  runtime.getAuth = async () => ({ auth: { apiKey: "isolated-faux-key" }, env: {} } as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  store = new WebSessionStore({ apiBaseUrl: apiUrl, conversationDir: join(temp, "sessions"),
    createAgent: async (teaching, planning, emit, manager) => {
      const session = await createLearningAgentSession(teaching, planning, {
        apiBaseUrl: apiUrl, model: faux.getModel(), modelRuntime: runtime, sessionManager: manager, retrieval: false,
        surface: "WEB", log: () => undefined, onEvent: event => { if (event.type === "model_error") modelErrors.push(event.message); emit(event); },
      });
      const prompt = session.prompt.bind(session);
      session.prompt = async text => {
        const hold = heldPrompt;
        if (hold) { heldPrompt = undefined; hold.entered(); await hold.released; }
        await prompt(text);
      };
      return session;
    },
  });
  gateway = createGateway({ store }); gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
  const address = gateway.address(); assert.ok(address && typeof address === "object"); const webUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: process.env.RESPONSIVE_BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  let messageRequests = 0;
  page.on("request", request => { if (request.method() === "POST" && /\/messages$/.test(new URL(request.url()).pathname)) messageRequests++; });
  await ready(page, webUrl);
  faux.setResponses([
    call("record_goal_understanding", { outcome: "NEEDS_CLARIFICATION", profile, missing_information: ["基础", "学习偏好"] }),
    context => { result(context, "record_goal_understanding"); return call("ask_learner_questions", { purpose: "BACKGROUND", questions: background }); },
    context => { result(context, "ask_learner_questions"); return fauxAssistantMessage("我先了解你的基础与学习偏好，再确定路线。"); },
  ]);
  await send(page, "我想理解 Agent 的 Session 与 Context");
  await page.locator("#learner-questions fieldset").waitFor();
  assert.equal(await page.locator("#learner-questions fieldset").count(), 1);
  assert.equal(await page.locator("#send-button").innerText(), "下一题");
  assert.doesNotMatch(await page.locator("#learner-questions").innerText(), /你更想怎样学习/);
  assert.equal(await page.locator("#learner-questions input:checked").count(), 0, "no preselection");
  await page.locator('#learner-questions input[value="built"]').check();
  await page.locator('#learner-questions textarea[data-question="experience"]').fill("做过一个聊天项目，但不确定上下文压缩");
  await page.locator("#learner-questions").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(tmpdir(), "lawa-learner-questions-desktop.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.locator("#learner-questions").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(tmpdir(), "lawa-learner-questions-mobile.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 320, height: 700 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.equal(await page.locator("#send-button").isVisible(), true);
  await page.setViewportSize({ width: 1280, height: 900 });
  // 切换知识卡片再回来不丢掉页面草稿；刷新则恢复实际待答题，且不会默认替用户选答案。
  await page.locator('#learning-view-tabs [role="tab"]').nth(1).click();
  await page.locator('#learning-view-tabs [role="tab"]').first().click();
  assert.equal(await page.locator("#learner-questions input:checked").count(), 1);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#learning-intro").waitFor({ state: "detached" });
  await page.locator('#connection-status[data-status="ready"]').waitFor();
  await page.locator("#learner-questions").waitFor();
  assert.equal(await page.locator("#learner-questions input:checked").count(), 0);
  assert.equal(faux.state.callCount, 3);
  // 中途下一题/回改不请求 Gateway 或模型；最终一次提交整批真实回答。
  await page.locator('#learner-questions input[value="new"]').focus(); await page.keyboard.press("ArrowDown");
  assert.equal(await page.locator('#learner-questions input[value="built"]').isChecked(), true, JSON.stringify(await page.evaluate(() => ({
    focus: document.activeElement?.id, radios: [...document.querySelectorAll<HTMLInputElement>('#learner-questions input[type="radio"]')].map(node => ({ value: node.value, disabled: node.disabled, checked: node.checked })),
  }))));
  await page.locator('#learner-questions textarea[data-question="experience"]').fill("做过一个聊天项目，但不确定上下文压缩");
  await page.locator('#learner-questions textarea[data-question="experience"]').press("Enter");
  await page.locator('#learner-questions textarea[data-question="preference"]').waitFor();
  assert.equal(await page.locator("#learner-questions fieldset").count(), 1);
  assert.doesNotMatch(await page.locator("#learner-questions").innerText(), /接触 Agent 到哪一步/);
  assert.equal(await page.locator("#send-button").innerText(), "发送");
  assert.equal(messageRequests, 1); assert.equal(faux.state.callCount, 3);
  await page.locator('[data-question-back]').click();
  assert.equal(await page.locator('#learner-questions input[value="built"]').isChecked(), true);
  assert.match(await page.locator('#learner-questions textarea[data-question="experience"]').inputValue(), /做过一个聊天项目/);
  await page.locator("#send-button").click();
  await page.locator('#learner-questions textarea[data-question="preference"]').waitFor();
  assert.equal(messageRequests, 1); assert.equal(faux.state.callCount, 3);
  await page.locator('#learner-questions input[value="practice"]').check();
  await page.locator('#learner-questions input[value="examples"]').check();
  assert.equal(await page.locator("#learner-questions input:checked").count(), 2);
  // 不选选项也可用自己的回答提交，不凭文本猜选项 ID。
  await page.locator('#learner-questions input[value="practice"]').uncheck();
  await page.locator('#learner-questions input[value="examples"]').uncheck();
  await page.locator('#learner-questions textarea[data-question="preference"]').fill("先用项目验证，再看具体例子");
  faux.setResponses([
    context => {
      assert.match(context.systemPrompt ?? "", /做过一个聊天项目/);
      assert.match(context.systemPrompt ?? "", /先用项目验证/);
      assert.match(context.systemPrompt ?? "", /choices_exposed/);
      profile.background_summary = "尝试过小项目；做过一个聊天项目，但不确定上下文压缩";
      profile.prior_knowledge_claims = ["做过一个聊天项目，但不确定上下文压缩"];
      profile.learning_preferences = ["先用项目验证，再看具体例子"];
      return call("record_goal_understanding", { outcome: "READY_FOR_CONFIRMATION", profile });
    },
    context => { result(context, "record_goal_understanding"); return call("ask_learner_questions", { purpose: "CONFIRM_GOAL" }); },
    context => { result(context, "ask_learner_questions"); return fauxAssistantMessage("我会结合项目与例子学习 Session 和 Context。确认这个目标后建立路线。"); },
  ]);
  await verifyAcceptedWhileGenerating(page,
    () => page.locator('#learner-questions textarea[data-question="preference"]').press("Enter"), "background-desktop");
  await page.locator("#messages").getByText(/确认这个目标后/).waitFor();
  await page.locator('#learner-questions [data-question-action="proceed"]').waitFor();
  assert.equal(messageRequests, 2, "all background answers must be sent in one request");
  let actual = await (await fetch(`${apiUrl}/api/learning/overview`)).json() as LearningOverview;
  assert.equal(actual.current_goal, null); assert.deepEqual(actual.recent_evidence, []);
  assert.equal(await page.locator('#learner-questions [data-question-action]').innerText(), "确认");
  assert.equal(await page.locator('#learner-questions input').count(), 0, "decision has no default selection");
  await page.screenshot({ path: join(tmpdir(), "lawa-inline-confirm-desktop.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.locator('#learner-questions').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(tmpdir(), "lawa-inline-confirm-mobile.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 320, height: 700 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.setViewportSize({ width: 1280, height: 900 });
  // 修改说明单独走原发送入口，不得因显示确认按钮就建立目标。
  faux.setResponses([
    call("record_goal_understanding", { outcome: "CONFIRMED" }),
    context => {
      const blocked = [...context.messages].reverse().find((m): m is ToolResultMessage => m.role === "toolResult" && m.toolName === "record_goal_understanding");
      assert.ok(blocked?.isError);
      profile.desired_outcome = "能用聊天项目解释两者边界";
      return call("record_goal_understanding", { outcome: "READY_FOR_CONFIRMATION", profile });
    },
    context => { result(context, "record_goal_understanding"); return call("ask_learner_questions", { purpose: "CONFIRM_GOAL" }); },
    context => { result(context, "ask_learner_questions"); return fauxAssistantMessage("已调整为用聊天项目解释两者边界，请确认目标。"); },
  ]);
  await page.locator('#learner-questions textarea').fill("想调整目标，先用聊天项目解释两者边界");
  await page.locator('#learner-questions textarea').press("Enter");
  await page.locator('#connection-status[data-status="ready"]').waitFor();
  await page.locator("#messages").getByText(/已调整为/).waitFor();
  actual = await (await fetch(`${apiUrl}/api/learning/overview`)).json() as LearningOverview;
  assert.equal(actual.current_goal, null);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('#connection-status[data-status="ready"]').waitFor();
  await page.locator('#learner-questions [data-question-action]').waitFor();
  assert.equal(await page.locator('#learner-questions textarea').inputValue(), "");
  faux.setResponses([
    call("record_goal_understanding", { outcome: "CONFIRMED" }),
    context => { result(context, "record_goal_understanding"); return call("initialize_learning_goal", {
      goal_profile: profile, curriculum_spine: spine,
      frontier_skills: [{ id: skillId, name: "Session 与 Context", description: "解释二者边界", prerequisites: [], target_depth: "PRACTICAL" }],
      frontier: { focus_skill_id: skillId, supporting_skill_ids: [], reason: "已有小项目经验", target_depth: "PRACTICAL", suggested_learning_mode: "EXPLAIN", next_action: "区分 Session 与 Context" }, replace_existing: false,
    }); },
    context => { result(context, "initialize_learning_goal"); return call("ask_learner_questions", { purpose: "START_LEARNING" }); },
    context => { result(context, "ask_learner_questions"); return fauxAssistantMessage("学习路线已建立，接下来辨认 Session 的职责。"); },
  ]);
  // 未到服务端的失败仍可重试；按钮操作只发一次请求，保持实际选择记录。
  const callsBeforeDecisionFailure = faux.state.callCount;
  await page.route("**/api/web/sessions/*/messages", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "隔离测试：确认请求未到达服务端" }) }), { times: 1 });
  await page.locator('#learner-questions [data-question-action]').click();
  await page.locator("#error-text").getByText(/确认请求未到达/).waitFor();
  assert.equal(faux.state.callCount, callsBeforeDecisionFailure);
  assert.equal(await page.locator('#learner-questions [data-question-action]').isEnabled(), true);
  const requestsBeforeConfirm = messageRequests;
  await page.locator('#retry-button').click();
  await page.locator("#messages").getByText(/学习路线已建立/).waitFor();
  await page.locator('#connection-status[data-status="ready"]').waitFor();
  assert.equal(messageRequests, requestsBeforeConfirm + 1);
  actual = await (await fetch(`${apiUrl}/api/learning/overview`)).json() as LearningOverview;
  assert.deepEqual((actual.goal_profile as GoalProfileInput).prior_knowledge_claims, profile.prior_knowledge_claims);
  assert.deepEqual(actual.recent_evidence, []);
  assert.equal(actual.active_task, null, "confirmation does not start learning");
  assert.equal(await page.locator('#learner-questions [data-question-action]').innerText(), "开始学习");
  await page.screenshot({ path: join(tmpdir(), "lawa-inline-start-desktop.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.locator('#learner-questions').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(tmpdir(), "lawa-inline-start-mobile.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 900 });
  // 暂缓说明必须阻止提前创建教学任务，老师处理后再呈现开始按钮。
  faux.setResponses([
    call("create_learning_task", { title: "提前开始", description: "不应创建", related_skill_ids: [skillId], expected_evidence_types: ["EXPLAIN"] }),
    context => {
      const blocked = [...context.messages].reverse().find((m): m is ToolResultMessage => m.role === "toolResult" && m.toolName === "create_learning_task");
      assert.ok(blocked?.isError); assert.match(JSON.stringify(blocked.content), /尚未同意开始/);
      return call("ask_learner_questions", { purpose: "START_LEARNING" });
    },
    context => { result(context, "ask_learner_questions"); return fauxAssistantMessage("这一段先辨认历史保存的职责，准备好时开始。"); },
  ]);
  await page.locator('#learner-questions textarea').fill("先等等，想先看一下这节会做什么");
  await page.locator('#send-button').click();
  await page.locator("#messages").getByText(/准备好时开始/).waitFor();
  await page.locator('#connection-status[data-status="ready"]').waitFor();
  actual = await (await fetch(`${apiUrl}/api/learning/overview`)).json() as LearningOverview;
  assert.equal(actual.active_task, null); assert.deepEqual(actual.recent_evidence, []);
  faux.setResponses([
    call("create_learning_task", { title: "区分 Session 与 Context", description: "辨认职责并补充用途", related_skill_ids: [skillId], expected_evidence_types: ["EXPLAIN"] }),
    context => { taskId = result<{ id: string }>(context, "create_learning_task").id; return call("activate_learning_task", { task_id: taskId }); },
    context => { result(context, "activate_learning_task"); return call("record_teaching_turn", { active_skill_id: skillId, active_task_id: taskId, teaching_mode: "QUIZ", outcome: "START", current_question: check[0]!.prompt }); },
    context => {
      result(context, "record_teaching_turn");
      // 故意让推进动作排在询问之前，证明共享 SDK hook 能阻止同一回复中的并发推进。
      return fauxAssistantMessage([
        fauxToolCall("complete_learning_task", { task_id: taskId }, { id: "premature-complete" }),
        fauxToolCall("ask_learner_questions", { purpose: "CHECK", active_skill_id: skillId, active_task_id: taskId, questions: check }, { id: "teaching-choice" }),
      ], { stopReason: "toolUse" });
    },
    context => {
      result(context, "ask_learner_questions");
      const blocked = context.messages.find((m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === "premature-complete");
      assert.ok(blocked?.isError); assert.match(JSON.stringify(blocked.content), /等待|尚未收到/);
      return fauxAssistantMessage("选出你的判断，再补充你会怎样使用历史。");
    },
  ]);
  const requestsBeforeStart = messageRequests;
  await page.locator('#learner-questions [data-question-action]').focus();
  await page.keyboard.press("Enter");
  await page.locator('#learner-questions input[value="history"]').waitFor();
  assert.equal(messageRequests, requestsBeforeStart + 1, "keyboard action submits once");
  actual = await (await fetch(`${apiUrl}/api/learning/overview`)).json() as LearningOverview;
  assert.equal((actual.active_task as { id: string }).id, taskId); assert.deepEqual(actual.recent_evidence, []);
  const sessions = await store.listConversations(); assert.ok(sessions.activeSessionId);
  const q = (await store.state(sessions.activeSessionId)).teaching.learner_questions!.pending!;
  const command = await fetch(`${webUrl}/api/web/sessions/${sessions.activeSessionId}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: `/master ${skillId}`, learner_reply: { request_id: q.id, answers: [] } }) });
  assert.equal(command.status, 400);
  await page.locator('#learner-questions input[value="history"]').check();
  await page.locator('#learner-questions textarea[data-question="session"]').fill("完整历史支持回看；发送模型前可以按预算筛选 Context，原始历史仍保留。");
  const callsBeforePreview = faux.state.callCount;
  await page.locator(`.route-card [data-select-skill="${skillId}"]`).click();
  await page.locator("#learner-questions").waitFor({ state: "detached" });
  assert.equal(await page.locator("#send-button").innerText(), "返回学习");
  await page.locator("#send-button").click();
  await page.locator('#learner-questions input[value="history"]').waitFor();
  assert.equal(await page.locator('#learner-questions input[value="history"]').isChecked(), true);
  assert.match(await page.locator('#learner-questions textarea[data-question="session"]').inputValue(), /原始历史仍保留/);
  assert.equal(faux.state.callCount, callsBeforePreview, "read-only preview and return must not call the teacher");
  await page.screenshot({ path: join(tmpdir(), "lawa-teaching-choice-desktop.png"), fullPage: true, animations: "disabled" });
  faux.setResponses([
    context => { assert.match(context.systemPrompt ?? "", /原始历史仍保留/); return call("record_teaching_turn", {
      active_skill_id: skillId, active_task_id: taskId, teaching_mode: "QUIZ", outcome: "CORRECT", current_question: check[0]!.prompt,
      candidate_evidence: { evidence_type: "EXPLAIN", description: "借助选项辨认历史保存职责，并解释与 Context 筛选的关系", supporting_interaction_summary: "实际选择和用途解释" },
    }); },
    context => {
      const candidate = result<{ candidate_evidence: CandidateEvidence }>(context, "record_teaching_turn").candidate_evidence;
      assert.equal(candidate.assistance_level, "WITH_HINT"); assert.match(candidate.description, /原始历史仍保留/);
      return call("submit_evidence", { skill_id: candidate.skill_id, evidence_type: candidate.evidence_type, description: candidate.description, assistance_level: candidate.assistance_level, source: candidate.source });
    },
    context => { result(context, "submit_evidence"); return fauxAssistantMessage("你辨认了历史职责，并解释了与模型上下文的关系；这次记录为有提示的解释。"); },
  ]);
  const callsBeforeNetworkFailure = faux.state.callCount;
  await page.route("**/api/web/sessions/*/messages", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "隔离测试：请求尚未到达服务端" }) }), { times: 1 });
  await page.locator("#send-button").click();
  await page.locator("#error-text").getByText(/请求尚未到达服务端/).waitFor();
  assert.equal(faux.state.callCount, callsBeforeNetworkFailure);
  assert.equal(await page.locator('#learner-questions input[value="history"]').isChecked(), true, "failed delivery retains choices");
  assert.match(await page.locator('#learner-questions textarea[data-question="session"]').inputValue(), /原始历史仍保留/);
  await page.setViewportSize({ width: 390, height: 844 });
  await verifyAcceptedWhileGenerating(page, () => page.locator("#retry-button").click(), "check-mobile");
  await page.locator("#messages").getByText(/这次记录为有提示/).waitFor();
  await page.locator("#learner-questions").waitFor({ state: "detached" });
  actual = await (await fetch(`${apiUrl}/api/learning/overview`)).json() as LearningOverview;
  assert.equal(actual.recent_evidence.length, 1);
  assert.deepEqual((await store.state(sessions.activeSessionId)).teaching.learner_questions?.last_answer?.reply?.answers[0]?.selected_option_ids, ["history"], "network retry must retain actual choice IDs");
  const evidence = actual.recent_evidence[0] as { description: string; assistance_level: string };
  assert.equal(evidence.assistance_level, "WITH_HINT"); assert.match(evidence.description, /完整对话历史/); assert.match(evidence.description, /原始历史仍保留/);
  assert.notEqual((actual.skills[0] as { status: string }).status, "MASTERED_BY_USER");
  // 十题日常练习使用同一组件逐题完成、一次提交，不伪造单题10分或自动Evidence。
  const evidenceCountBeforePractice = actual.recent_evidence.length;
  faux.setResponses([
    context => {
      assert.match(context.systemPrompt ?? "", /present_practice_set/);
      return call("present_practice_set", {
        active_skill_id: skillId, active_task_id: taskId, title: "十题日常练习",
        questions: practiceQuestions,
      });
    },
    context => {
      result(context, "present_practice_set");
      return fauxAssistantMessage("十题练习组已显示，全部答完后统一提交。");
    },
  ]);
  await send(page, "给我一组十题日常练习");
  faux.setResponses([
    context => {
      assert.match(JSON.stringify(context.messages), /第 10 道日常练习/);
      return fauxAssistantMessage("已收到十题练习组，不生成正式评分或 Evidence。");
    },
  ]);
  for (let index = 0; index < practiceQuestions.length; index++) {
    await page.locator(`#learner-questions [data-question-group="practice-${index + 1}"]`).waitFor();
    await page.locator(`#learner-questions input[name="learner-${index}"][value="a"]`).check();
    await page.locator("#send-button").click();
  }
  await page.locator("#messages").getByText(/已收到十题练习组/).waitFor();
  await page.locator('#connection-status[data-status="ready"]').waitFor();
  actual = await (await fetch(`${apiUrl}/api/learning/overview`)).json() as LearningOverview;
  assert.equal(actual.recent_evidence.length, evidenceCountBeforePractice, "practice set must not create Evidence");
  assert.equal(
    (await store.state(sessions.activeSessionId)).teaching.learner_questions?.last_answer?.request.questions.length,
    10,
  );

  // 完整目标修订先落PENDING，经真实组件确认后才原子替换所有计划层。
  const revisedProfile = {...profile, desired_outcome: "只按新版范围解释 Session 与 Context"};
  const revisedSpine = spine.map((item, index) => ({...item, name: `新版阶段${index + 1}: ${item.name}`}));
  const currentFrontier = {
    focus_skill_id: skillId, supporting_skill_ids: [], reason: "继续当前任务",
    target_depth: "PRACTICAL" as const, suggested_learning_mode: "EXPLAIN" as const,
    next_action: "按新版范围解释职责",
  };
  let revisionId = "";
  faux.setResponses([
    context => {
      assert.match(context.systemPrompt ?? "", /propose_plan_revision/);
      return call("propose_plan_revision", {
        goal_profile: revisedProfile,
        curriculum_spine: revisedSpine,
        added_skills: [],
        updated_skills: [],
        remove_skill_ids: [],
        frontier: currentFrontier,
        reason: "用户明确把学习范围收窄为新版",
      }, "plan-proposal");
    },
    context => {
      const prepared = result<{revision: {id: string}}>(context, "propose_plan_revision");
      revisionId = prepared.revision.id;
      return call("ask_learner_questions", {
        purpose: "CONFIRM_PLAN_REVISION", plan_revision_id: revisionId,
      }, "plan-confirm");
    },
    context => {
      result(context, "ask_learner_questions");
      return fauxAssistantMessage("学习计划修订候选已准备好，请确认摘要与范围。");
    },
  ]);
  await send(page, "学习目标收窄为只按新版范围");
  assert.equal(await page.locator('#learner-questions [data-question-action="proceed"]').innerText(), "确认修订");
  assert.equal(await page.locator('#learner-questions [data-question-action="reject"]').innerText(), "暂不修订");
  assert.match(await page.locator("#learner-questions").innerText(), /阶段里程碑/);
  faux.setResponses([
    context => {
      assert.match(context.systemPrompt ?? "", /plan_revision/);
      return call("decide_plan_revision", {}, "plan-decision");
    },
    context => {
      result(context, "decide_plan_revision");
      return fauxAssistantMessage("计划修订已确认，后续只按新版范围教学。");
    },
  ]);
  await page.locator('#learner-questions [data-question-action="proceed"]').click();
  await page.locator("#messages").getByText(/后续只按新版范围教学/).waitFor();
  await page.locator('#connection-status[data-status="ready"]').waitFor();
  actual = await (await fetch(`${apiUrl}/api/learning/overview`)).json() as LearningOverview;
  assert.equal((actual.goal_profile as GoalProfileInput).desired_outcome, revisedProfile.desired_outcome);
  assert.equal((actual.curriculum_spine[0] as {name: string}).name, revisedSpine[0]!.name);
  assert.equal(actual.plan_revision, 1);
  assert.deepEqual(modelErrors, []);
  process.stdout.write("Learner questions smoke passed: real Pi hooks + Web + Python, background/profile, one-click confirm/start, changes/pause cannot consent, decision network retry, keyboard/free text/multiple choice, refresh, narrow screens, concurrent-write guard, actual WITH_HINT Evidence without Mastery, a ten-question PRACTICE_SET without Evidence, and confirmed atomic plan revision.\n");
} finally {
  await browser?.close(); store?.dispose();
  if (gateway?.listening) { gateway.close(); await once(gateway, "close"); }
  await stopSmokeProcess(api);
  assert.equal(dirname(resolve(temp)), resolve(tmpdir())); assert.ok(basename(temp).startsWith("lawa-questions-smoke-"));
  rmSync(temp, { recursive: true, force: true });
}
