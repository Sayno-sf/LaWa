import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {once} from "node:events";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import {createFauxCore, fauxAssistantMessage, fauxToolCall, type Context, type ToolResultMessage} from "@earendil-works/pi-ai";
import {chromium, type Browser, type Page} from "playwright-core";
import {createLearningAgentSession} from "../agentSession.js";
import {stopSmokeProcess} from "../smokeProcess.js";
import {getRetrievalRuntime} from "../retrieval/defaultRuntime.js";
import type {AnswerAssessment} from "../answerAssessmentTypes.js";
import {ConversationCatalog} from "./conversationCatalog.js";
import {createGateway} from "./gateway.js";
import {WebSessionStore} from "./sessionStore.js";
import {ProviderSettingsService} from "./providerSettings.js";

// 真Kernel、Gateway和Pi，所有学习/聊天/检索均在临时目录。真实模型模式只复用既有连接。
const root = fileURLToPath(new URL("../../../", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "lawa-assessment-"));
const output = resolve(root, "data/qa/answer-assessment"); mkdirSync(output, {recursive: true});
const screenshots = resolve(root, ".impeccable/review"); mkdirSync(screenshots, {recursive: true});
const live = process.env.ASSESSMENT_REAL_MODEL === "1" || process.argv.includes("--live");
function protectedHashes() {
  const paths = ["learning-state.json", "provider-settings.json", "provider-secrets.json"].map(p => resolve(root, "data", p)).filter(existsSync);
  function walk(dir: string) { if (!existsSync(dir)) return; for (const e of readdirSync(dir, {withFileTypes: true})) {
    const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(json|jsonl)$/.test(p)) paths.push(p);
  }}
  walk(resolve(root, "data/web-sessions"));
  return Object.fromEntries(paths.map(p => [p, createHash("sha256").update(readFileSync(p)).digest("hex")]));
}
const before = protectedHashes();
const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
const address = probe.address(); assert.ok(address && typeof address !== "string"); const apiPort = address.port;
probe.close(); await once(probe, "close"); const apiUrl = `http://127.0.0.1:${apiPort}`;
const seed = `from app.application import LearningService
from app.domain import GoalProfile, SkillGraph, SkillNode, SkillState, LearningTask, TaskStatus
from app.persistence import JsonLearningStateStore
import os, uvicorn
s=LearningService(SkillGraph([SkillNode('addition','加法与拼接',status=SkillState.LEARNING),SkillNode('functions','函数参数与返回值')]),current_goal='解释JavaScript短代码',goal_profile=GoalProfile('assessment-goal','解释JavaScript短代码','入门','能解释输出与类型'),current_goal_skill_ids=('addition','functions'),tasks=(LearningTask('assessment-task','区分数值加法与字符串拼接','解释实际代码',('addition',),(),status=TaskStatus.ACTIVE,goal_id='assessment-goal'),))
if not os.path.exists(os.environ['LEARNING_STATE_PATH']): JsonLearningStateStore(os.environ['LEARNING_STATE_PATH']).save(s)
uvicorn.run('app.api.main:app',host='127.0.0.1',port=${apiPort},log_level='warning')`;
const env = {...process.env, LEARNING_STATE_PATH: join(temp, "learning-state.json"), LEARNING_MATERIALS_DIR: join(temp, "materials"), PYTHONIOENCODING: "utf-8"};
const api = spawn(process.env.ASSESSMENT_PYTHON ?? resolve(root, ".venv/Scripts/python.exe"), ["-c", seed], {cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
let apiErrors = ""; api.stderr.on("data", chunk => {apiErrors += String(chunk);});
let gateway: ReturnType<typeof createGateway> | undefined, browser: Browser | undefined, store: WebSessionStore | undefined;
const question = 'function add(a, b) { return a + b; }\nadd(2, 3) 和 add(2, "3") 分别返回什么？为什么？';
const nextQuestion = '1 + 2 + "3" 得到什么？请解释计算顺序。';
const call = (name: string, args: Record<string, unknown>, id: string) => fauxAssistantMessage(id === "grade1" ? [
  fauxToolCall(name, args, {id}), fauxToolCall("ask_learner_questions", {purpose: "CHECK", active_skill_id: "addition", active_task_id: "assessment-task",
    questions: [{id: "q2", prompt: nextQuestion, selection: "freeform", options: []}]}, {id: "premature-q2"}),
] : fauxToolCall(name, args, {id}), {stopReason: "toolUse"});
function result(context: Context, name: string) {
  const message = context.messages.findLast((m): m is ToolResultMessage => m.role === "toolResult" && m.toolName === name);
  assert.ok(message); assert.equal(message.isError, false, JSON.stringify(message.content));
  const text = message.content.find(c => c.type === "text"); assert.ok(text?.type === "text"); return JSON.parse(text.text);
}
async function send(page: Page, text: string) {
  await page.locator('#connection-status[data-status="ready"]').waitFor();
  // Edge无头模式的fill偶尔丢失中文输入；DOM事件和请求原文断言防止空回答误验收。
  await page.locator("#message-input:enabled").evaluate((node, value) => {const input = node as HTMLTextAreaElement; input.value = value; input.dispatchEvent(new Event("input", {bubbles: true}));}, text);
  assert.equal(await page.locator("#message-input").inputValue(), text);
  await page.locator("#send-button").click();
  await page.locator('#connection-status[data-status="ready"]').waitFor();
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (api.exitCode !== null) throw new Error(`isolated API exited: ${apiErrors}`);
    try {if ((await fetch(`${apiUrl}/api/learning/overview`)).ok) {ready = true; break;}} catch { /* preparing */ }
    await new Promise(done => setTimeout(done, 100));
  }
  assert.ok(ready, apiErrors);
  process.env.LEARNING_API_BASE_URL = apiUrl;
  process.env.WEB_SESSION_DIR = join(temp, "sessions"); process.env.LEARNING_RETRIEVAL_DIR = join(temp, "retrieval");
  process.env.STUDY_TIME_PATH = join(temp, "study-time.json"); process.env.SPEECH_SETTINGS_PATH = join(temp, "speech-settings.json");
  process.env.PROVIDER_SETTINGS_PATH = join(temp, "providers.json"); process.env.PROVIDER_SECRETS_PATH = join(temp, "secrets.json");
  const faux = createFauxCore({tokensPerSecond: 0, provider: "assessment-faux", api: "openai-completions", models: [{id: "assessment-model", contextWindow: 128000, maxTokens: 4096}]});
  const runtime = await ModelRuntime.create({authPath: join(temp, "auth.json"), modelsPath: null, modelsStorePath: join(temp, "models.json"), allowModelNetwork: false, refreshOnCreate: false});
  runtime.streamSimple = faux.streamSimple; runtime.hasConfiguredAuth = p => p === faux.getModel().provider;
  runtime.getAuth = async () => ({auth: {apiKey: "isolated-faux-key"}, env: {}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  const settingsCopy = join(temp, "evaluation-provider.json"), secretsCopy = join(temp, "evaluation-secrets.json");
  if (live) {
    const settings = JSON.parse(readFileSync(resolve(root, "data/provider-settings.json"), "utf8"));
    if (process.env.ASSESSMENT_PROFILE_ID) {
      assert.ok(settings.profiles.some((p: {id: string}) => p.id === process.env.ASSESSMENT_PROFILE_ID), "只能使用已经配置的模型档案");
      settings.activeProfileId = process.env.ASSESSMENT_PROFILE_ID;
    }
    if (process.env.ASSESSMENT_THINKING_LEVEL) settings.profiles.find((p: {id: string}) => p.id === settings.activeProfileId).thinkingLevel = process.env.ASSESSMENT_THINKING_LEVEL;
    writeFileSync(settingsCopy, JSON.stringify(settings)); writeFileSync(secretsCopy, readFileSync(resolve(root, "data/provider-secrets.json")), {mode: 0o600});
  }
  const binding = live ? await new ProviderSettingsService({settingsPath: settingsCopy, secretsPath: secretsCopy}).getActiveRuntime() : null;
  if (live) assert.ok(binding, "需要既有教师模型配置");
  const errors: string[] = [];
  store = new WebSessionStore({apiBaseUrl: apiUrl, conversationDir: join(temp, "sessions"), createAgent: async (context, planning, emit, manager) => createLearningAgentSession(context, planning, {
    apiBaseUrl: apiUrl, sessionManager: manager, model: binding?.model ?? faux.getModel(), modelRuntime: binding?.runtime ?? runtime,
    thinkingLevel: binding?.thinkingLevel, assistantSupport: false, retrieval: false, surface: "WEB", log: () => undefined,
    onEvent: event => {if (event.type === "model_error") errors.push(event.message); emit(event);},
  })});
  if (live) {
    const catalog = new ConversationCatalog(join(temp, "sessions")), manager = catalog.create();
    catalog.recordGoal(manager, "assessment-goal", "解释JavaScript短代码"); manager.appendMessage(fauxAssistantMessage(question));
    const main = await store.create("resume-recent"); const start = Date.now();
    const timer = setTimeout(() => void store!.stop(main.sessionId), 120_000);
    try {await store.sendMessage(main.sessionId, '分别是数字5和字符串"23"。前者两个操作数都是数字，所以做数值加法；后者含字符串，另一个操作数转为字符串并拼接。', () => undefined);} finally {clearTimeout(timer);}
    const saved = await (await fetch(`${apiUrl}/api/learning/answer-assessments?goal_id=assessment-goal`)).json() as {assessments: AnswerAssessment[]};
    assert.equal(saved.assessments.length, 1, "真实教师必须实际调用评分工具"); assert.ok(saved.assessments[0]!.score >= 8);
    assert.equal((await store.create("resume-recent")).messages.filter(m => m.assessment).length, 1);
    assert.deepEqual(errors, []); assert.deepEqual(protectedHashes(), before);
    const report = {passed: true, realModel: binding!.model.id, thinking: binding!.thinkingLevel, score: saved.assessments[0]!.score, followUp: saved.assessments[0]!.follow_up, elapsedMs: Date.now() - start, protectedFilesUnchanged: Object.keys(before).length};
    writeFileSync(join(output, "live-report.json"), JSON.stringify(report, null, 2)); process.stdout.write(JSON.stringify(report) + "\n");
  } else {
    const ask = (prompt: string, id: string) => call("ask_learner_questions", {purpose: "CHECK", active_skill_id: "addition", active_task_id: "assessment-task",
      assessment_criteria: [{label: "结果判断", possible: 4}, {label: prompt === question ? "类型解释" : "计算过程", possible: 6}],
      questions: [{id, prompt, selection: "freeform", options: []}]}, id);
    faux.setResponses([
      ask(question, "q1"), context => {result(context, "ask_learner_questions"); return fauxAssistantMessage("请判断两次调用的结果，并说明理由。");},
      call("record_answer_assessment", {question, topic: "加号与字符串拼接", criteria: [{label: "结果判断", earned: 0, possible: 4, feedback: "数字相加返回5，字符串参与时应返回字符串23。"}, {label: "类型解释", earned: 2, possible: 6, feedback: "注意到了字符串类型，但混淆了拼接与数值转换。"}], summary: "已经注意到参数类型不同，但把加号的字符串拼接规则记反了。", strengths: ["能识别第二个参数是字符串"], gaps: ["加号遇到字符串时进行拼接，不先把它转成数字"]}, "grade1"),
      context => {assert.equal(result(context, "record_answer_assessment").assessment.score, 2);
        const premature = context.messages.findLast(m => m.role === "toolResult" && m.toolName === "ask_learner_questions");
        assert.ok(premature?.role === "toolResult"); assert.equal(premature.isError, true, "并发新题必须等评分保存后重发");
        return ask(nextQuestion, "q2");},
      context => {result(context, "ask_learner_questions"); return fauxAssistantMessage("字符串参与加法时会拼接。这个点先记下来，接着看一道返回值的小题。");},
      call("record_answer_assessment", {question: nextQuestion, topic: "加法表达式的计算顺序", criteria: [{label: "结果判断", earned: 4, possible: 4, feedback: "正确算出字符串33。"}, {label: "计算过程", earned: 6, possible: 6, feedback: "能按从左到右的顺序区分先相加、后拼接。"}], summary: "能按顺序计算表达式，也能解释数值加法与字符串拼接的切换。", strengths: ["结果是字符串33", "先计算1+2，再与字符串3拼接"], gaps: []}, "grade2"),
      context => {assert.equal(result(context, "record_answer_assessment").assessment.follow_up, "SECURE"); return fauxAssistantMessage("这次对计算顺序的解释很清楚，后面就不重复这部分基础讲解了。");},
    ]);
    gateway = createGateway({store, staticDir: resolve(root, "data/qa/answer-assessment-web")}); gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
    const address = gateway.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({executablePath: process.env.RESPONSIVE_BROWSER_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true});
    const context = await browser.newContext({viewport: {width: 1535, height: 950}, reducedMotion: "reduce"});
    await context.addInitScript(() => {localStorage.setItem("learn-anything:intro-watched:v1", "true"); localStorage.setItem("learn-anything:task-focus-collapsed", "true");});
    const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message)); await page.goto(base);
    await page.locator("#learning-intro").waitFor({state: "detached"}); await page.locator('#connection-status[data-status="ready"]').waitFor();
    await send(page, "开始这道练习"); await page.locator("#learner-questions textarea").waitFor();
    assert.equal(await page.locator("#learner-questions input").count(), 0);
    await send(page, "都是5，因为第二个虽然是字符串，但加号会先转数字。我参考了资料。");
    await page.locator(".answer-assessment").waitFor(); assert.equal(await page.locator(".answer-assessment").count(), 1);
    assert.equal(await page.locator(".answer-assessment .assessment-rubric tbody tr").count(), 2);
    assert.equal(await page.locator(".answer-assessment .assessment-prose").count(), 0);
    const feedback = page.locator(".answer-assessment + .assessment-prose");
    assert.match(await feedback.innerText(), /做到了：能识别第二个参数是字符串/);
    assert.match(await feedback.innerText(), /再补一点：加号遇到字符串时进行拼接/);
    assert.match(await page.locator("#learner-questions").innerText(), /计算顺序/);
    const firstGrade = await (await fetch(`${apiUrl}/api/learning/answer-assessments?goal_id=assessment-goal`)).json() as {assessments: AnswerAssessment[]};
    const proposalBody = {id: "teaching-fixture", goal_id: "assessment-goal", kind: "STRATEGY", text: "新概念先对照两个例子，再总结规则。", reason: "本次回答暴露了数值加法与拼接的区别，建议尝试具体对照；后续仍需观察。", scope: "SUBJECT", subject: "technical", assessment_ids: [firstGrade.assessments[0]!.id]};
    assert.equal((await fetch(`${apiUrl}/api/learning/teaching/proposals`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(proposalBody)})).status, 200);
    store.classroom.changed();
    await page.locator(".teaching-proposal").waitFor();
    const secondContext = await browser.newContext({viewport: {width: 1535, height: 950}, reducedMotion: "reduce"});
    await secondContext.addInitScript(() => localStorage.setItem("learn-anything:intro-watched:v1", "true"));
    const secondPage = await secondContext.newPage(); secondPage.on("pageerror", e => errors.push(e.message)); await secondPage.goto(base);
    await secondPage.locator(".teaching-proposal").waitFor();
    assert.match(await page.locator(".teaching-proposal .proposal-scope").innerText(), /程序阅读与修改/);
    const pendingBefore = await store.state((await store.create("resume-recent")).sessionId);
    const callsBeforeDecision = faux.state.callCount;
    await page.locator(".teaching-proposal").scrollIntoViewIfNeeded();
    await page.locator('.teaching-proposal [data-decision="CONFIRM"]').focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.locator('.teaching-proposal [data-decision="REJECT"]').evaluate(node => node.matches(":focus-visible")), true);
    await page.screenshot({path: join(screenshots, "teaching-strategy.png"), animations: "disabled"});
    await page.locator(".teaching-proposal summary").click();
    await page.locator(".teaching-proposal textarea").fill("熟悉内容直接讲结论。");
    await page.locator('.teaching-proposal [data-decision="SUPPLEMENT"]').click();
    await page.waitForFunction(async () => (await (await fetch(`/api/web/sessions/${(await (await fetch("/api/web/classroom/snapshot")).json()).session.sessionId}/teaching?all=1`)).json()).proposals.some((p: {status: string}) => p.status === "REVISION_REQUESTED"));
    assert.equal((await fetch(`${apiUrl}/api/learning/teaching/proposals`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({...proposalBody, text: "新概念先举例；熟悉内容直接讲结论。", revision: 3, expected_revision: 2})})).status, 200);
    store.classroom.changed();
    await page.locator(".teaching-proposal").waitFor();
    await page.getByText("新概念先举例；熟悉内容直接讲结论。", {exact: true}).waitFor();
    await secondPage.getByText("新概念先举例；熟悉内容直接讲结论。", {exact: true}).waitFor();
    await secondPage.locator('.teaching-proposal [data-decision="CONFIRM"]').click();
    await secondPage.locator(".teaching-proposal").waitFor({state: "detached"});
    await page.locator(".teaching-proposal").waitFor({state: "detached"});
    assert.equal(faux.state.callCount, callsBeforeDecision, "策略确认不调用模型");
    const pendingAfter = await store.state((await store.create("resume-recent")).sessionId);
    assert.equal(pendingAfter.teaching.learner_questions?.pending?.id, pendingBefore.teaching.learner_questions?.pending?.id, "策略意见不能消费练习");
    assert.equal((await (await fetch(`${apiUrl}/api/learning/answer-assessments?goal_id=assessment-goal`)).json()).assessments.length, 1);
    await page.locator("#teaching-arrangements-button").click();
    assert.equal(await page.locator("#provider-settings-page .teaching-arrangements").count(), 0);
    assert.equal(await page.locator("#teaching-arrangements-button").getAttribute("aria-current"), "page");
    assert.equal(await page.locator("#teaching-arrangements-page").isVisible(), true);
    assert.equal(faux.state.callCount, callsBeforeDecision, "打开教学安排不调用教师");
    const management = page.locator(".teaching-arrangements");
    await management.scrollIntoViewIfNeeded();
    assert.match(await management.innerText(), /适用范围：程序阅读与修改/);
    const decisionRoute = "**/teaching/teaching-fixture/decision";
    await page.route(decisionRoute, route => route.fulfill({status: 503, contentType: "application/json", body: JSON.stringify({detail: "保存失败测试：磁盘暂不可用，请重试。"})}));
    await management.locator('[data-decision="WITHDRAW"]').click();
    await management.getByText("保存失败测试：磁盘暂不可用，请重试。", {exact: true}).waitFor();
    await page.screenshot({path: join(screenshots, "teaching-management-error.png"), animations: "disabled"});
    await page.unroute(decisionRoute);
    await management.locator('[data-decision="WITHDRAW"]').click();
    await management.getByText(/已撤回/).waitFor();
    await management.locator('[data-decision="DELETE"]').click();
    await management.getByText("还没有已确认的教学安排。", {exact: true}).waitFor();
    assert.equal((await (await fetch(`${apiUrl}/api/user/teaching`)).json()).proposals.length, 0);
    assert.equal(faux.state.callCount, callsBeforeDecision, "管理策略不调用模型");
    await page.locator("#learning-home-link").click();
    await page.locator(".answer-assessment").scrollIntoViewIfNeeded(); await page.screenshot({path: join(screenshots, "low-score.png"), animations: "disabled"});
    await page.reload(); await page.locator('#connection-status[data-status="ready"]').waitFor(); await page.locator(".answer-assessment").waitFor(); assert.equal(await page.locator(".answer-assessment").count(), 1);
    await send(page, '得到字符串"33"。从左到右先算1+2得到数字3，再与字符串"3"拼接。');
    assert.equal(await page.locator(".answer-assessment").count(), 2);
    await secondPage.locator(".answer-assessment").nth(1).waitFor();
    assert.equal(await secondPage.locator(".answer-assessment").count(), 2, "另一端同步教师结果");
    await secondContext.close();
    const saved = await (await fetch(`${apiUrl}/api/learning/answer-assessments?goal_id=assessment-goal`)).json() as {assessments: AnswerAssessment[]};
    assert.deepEqual(saved.assessments.map(a => a.score), [10, 2]);
    assert.equal(saved.assessments[1]!.assistance_level, "WITH_REFERENCE");
    assert.equal(saved.assessments[0]!.assistance_level, "INDEPENDENT");
    const overview = await (await fetch(`${apiUrl}/api/learning/overview`)).json();
    assert.equal(overview.active_task.id, "assessment-task"); assert.equal(overview.recent_evidence.length, 0);
    assert.ok(overview.skills.every((s: {status: string}) => s.status !== "MASTERED_BY_USER"));
    for (const [width, height, name] of [[1535, 950, "desktop"], [1920, 1080, "desktop-wide"]] as const) {
      await page.setViewportSize({width, height}); await page.locator(".answer-assessment").last().scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: page overflow`);
      assert.ok(await page.locator(".answer-assessment").evaluateAll(nodes => nodes.every(n => n.scrollWidth <= n.clientWidth)), `${width}: score overflow`);
      await page.screenshot({path: join(screenshots, `${name}.png`), animations: "disabled"});
    }
    await page.setViewportSize({width: 1535, height: 950}); await page.locator("#learning-library-button").click();
    await page.locator(".learning-project-card > summary").click();
    assert.equal(await page.locator(".library-assessment-item").count(), 2);
    const firstSummary = page.locator(".library-assessment-item > summary").first();
    await firstSummary.focus(); await firstSummary.press("Enter");
    assert.equal(await page.locator(".library-assessment-item").first().getAttribute("open"), "");
    await firstSummary.press("Enter");
    await page.locator(".library-assessment-item > summary").last().click();
    assert.equal(await page.locator(".library-assessment-item[open] .assessment-status").isVisible(), true);
    assert.match(await page.locator(".library-assessment-item[open] .assessment-status").innerText(), /参考后完成/);
    await page.screenshot({path: join(screenshots, "library.png"), animations: "disabled"});
    const portable = {...proposalBody, id: "portable-fixture", text: "遇到新概念先给短例子，再解释规则。", scope: "USER", subject: "", source_independent: true};
    assert.equal((await fetch(`${apiUrl}/api/learning/teaching/proposals`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(portable)})).status, 200);
    store.classroom.changed(); await page.locator("#learning-home-link").click();
    await page.getByText("通用教学安排，删除学习目标后仍保留，可在「教学安排」中管理。", {exact: true}).waitFor();
    await page.locator('.teaching-proposal [data-decision="CONFIRM"]').focus(); await page.keyboard.press("Tab");
    await page.locator(".teaching-proposal").scrollIntoViewIfNeeded();
    await page.screenshot({path: join(screenshots, "teaching-independent-consent.png"), animations: "disabled"});
    await page.locator('.teaching-proposal [data-decision="CONFIRM"]').click();
    await page.locator(".teaching-proposal").waitFor({state: "detached"});
    const confirmed = (await (await fetch(`${apiUrl}/api/user/teaching`)).json()).proposals.find((p: {id: string}) => p.id === portable.id);
    assert.equal(confirmed.goal_id, null);
    assert.equal((await fetch(`${base}/api/web/goals/assessment-goal`, {method: "DELETE"})).status, 200);
    const recycled = (await (await fetch(`${base}/api/web/recycle`)).json()).items.find((item: {kind: string; targetId: string}) => item.kind === "goal" && item.targetId === "assessment-goal");
    assert.ok(recycled);
    assert.equal((await fetch(`${base}/api/web/recycle/${encodeURIComponent(recycled.id)}/purge`, {method: "POST"})).status, 200);
    await page.locator("#teaching-arrangements-button").click();
    await page.reload();
    await page.locator('#connection-status[data-status="ready"]').waitFor({state: "attached"});
    await page.locator("#learning-intro").waitFor({state: "detached"});
    assert.equal(await page.locator("#teaching-arrangements-page").isVisible(), true, "刷新保留独立管理页");
    await page.locator('.confirmed-strategy[data-id="portable-fixture"]').getByText(portable.text, {exact: true}).waitFor();
    await page.locator('.confirmed-strategy[data-id="portable-fixture"]').scrollIntoViewIfNeeded();
    await page.screenshot({path: join(screenshots, "teaching-independent-after-purge.png"), animations: "disabled"});
    await page.locator('.confirmed-strategy[data-id="portable-fixture"] [data-decision="WITHDRAW"]').click();
    await page.locator('.confirmed-strategy[data-id="portable-fixture"]').getByText(/已撤回/).waitFor();
    await page.locator('.confirmed-strategy[data-id="portable-fixture"] [data-decision="DELETE"]').click();
    await page.locator(".teaching-arrangements").getByText("还没有已确认的教学安排。", {exact: true}).waitFor();
    assert.equal(faux.state.callCount, callsBeforeDecision + 2, "delete/withdraw independent methods never calls a model");
    assert.deepEqual(errors, []); assert.deepEqual(protectedHashes(), before);
    const report = {passed: true, realKernelAndPi: true, freeform: true, lowScoreContinued: true, refreshRestored: true, libraryHistory: true,
      independentStrategyDecision: true, supplementalRevision: true, twoClientSync: true, managementFailureVisible: true, withdrawalAndDeletion: true, independentMethodSurvivesSourcePurge: true, scores: [2, 10], viewports: [1535, 1920], protectedFilesUnchanged: Object.keys(before).length};
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2)); process.stdout.write(JSON.stringify(report) + "\n");
  }
} finally {
  await browser?.close(); store?.dispose();
  if (gateway?.listening) {gateway.close(); await once(gateway, "close");}
  if (gateway) await (await getRetrievalRuntime(apiUrl)).stop();
  await stopSmokeProcess(api);
  assert.equal(dirname(resolve(temp)), resolve(tmpdir())); assert.ok(basename(temp).startsWith("lawa-assessment-"));
  rmSync(temp, {recursive: true, force: true});
}
