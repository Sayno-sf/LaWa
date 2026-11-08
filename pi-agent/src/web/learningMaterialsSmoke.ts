import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type Context, type ToolResultMessage } from "@earendil-works/pi-ai";

import type { LearningAgentEvent, LearningAgentSession } from "../agentSession.js";
import { createLearningAgentTools } from "../learningAgentTools.js";
import { createLearningMaterialTools } from "../learningMaterialTools.js";
import { createGateway } from "./gateway.js";
import { WebSessionStore } from "./sessionStore.js";
import { validatePlanningToolRoute } from "../planning/planningPolicy.js";
import { RetrievalRuntime } from "../retrieval/runtime.js";
import { RetrievalSettingsStore } from "../retrieval/settings.js";
import { KernelSourceBackend } from "../retrieval/backend.js";
import { stopSmokeProcess } from "../smokeProcess.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const temp = mkdtempSync(join(tmpdir(), "lawa-materials-"));
const apiUrl = "http://127.0.0.1:8127";
const localPython = join(root, ".venv", "Scripts", "python.exe");
const api = spawn(process.env.PYTHON ?? (existsSync(localPython) ? localPython : "python"), ["-m", "uvicorn", "app.api.main:app", "--host", "127.0.0.1", "--port", "8127"], {
  cwd: root,
  env: { ...process.env, LEARNING_STATE_PATH: ":memory:", LEARNING_BOOTSTRAP: "gradient-demo", LEARNING_MATERIALS_DIR: join(temp, "materials") },
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
let apiErrors = "";
api.stderr?.on("data", (chunk: Buffer) => { apiErrors += chunk.toString(); });
api.on("error", (error) => { apiErrors += error.message; });

async function waitApi(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (api.exitCode !== null) throw new Error(`API exited: ${apiErrors}`);
    try { if ((await fetch(`${apiUrl}/api/learning/overview`)).ok) return; } catch { /* startup */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`API startup timed out: ${apiErrors}`);
}

let gateway: ReturnType<typeof createGateway> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let store: WebSessionStore | undefined;
let retrieval: RetrievalRuntime | undefined;

// 合成原生 ClipboardEvent，走实际输入框处理和 Gateway；不改动用户系统剪贴板。
async function pasteFiles(page: Page, files: Array<{name: string; type: string; base64: string}>, text = "", itemsOnly = false) {
  return page.evaluate(({files, text, itemsOnly}) => {
    const data = new DataTransfer();
    for (const file of files) data.items.add(new File([Uint8Array.from(atob(file.base64), c => c.charCodeAt(0))], file.name, {type: file.type}));
    if (text) data.setData("text/plain", text);
    if (itemsOnly) Object.defineProperty(data, "files", {value: []});
    const event = new ClipboardEvent("paste", {clipboardData: data, bubbles: true, cancelable: true});
    document.querySelector<HTMLInputElement>("#message-input")!.dispatchEvent(event);
    return event.defaultPrevented;
  }, {files, text, itemsOnly});
}
try {
  await waitApi();
  process.env.LEARNING_API_BASE_URL = apiUrl;
  const materialTools = createLearningMaterialTools({ baseUrl: apiUrl });
  const faux = createFauxCore({ tokensPerSecond: 0 });
  const readTool = materialTools.find((tool) => tool.name === "read_learning_material");
  assert.ok(readTool);
  store = new WebSessionStore({
    apiBaseUrl: apiUrl,
    conversationDir: join(temp, "sessions"),
    createAgent: async (teaching, onboarding, emit, manager): Promise<LearningAgentSession> => {
      const tools = createLearningAgentTools(teaching, { baseUrl: apiUrl, log: () => undefined }, onboarding);
      const agent = new Agent({ streamFn: faux.streamSimple, initialState: {
        systemPrompt: "Read the referenced material and cite its actual source.",
        model: faux.getModel(), tools: tools as unknown as AgentTool[],
      } });
      agent.beforeToolCall = async ({ toolCall }) => validatePlanningToolRoute(onboarding.snapshot(), toolCall.name);
      agent.subscribe((event) => {
        if (event.type === "message_end") manager.appendMessage(event.message as Parameters<typeof manager.appendMessage>[0]);
        let webEvent: LearningAgentEvent | undefined;
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          webEvent = { type: "assistant_delta", delta: event.assistantMessageEvent.delta };
        } else if (event.type === "tool_execution_start") {
          webEvent = { type: "tool_start", toolName: event.toolName };
        } else if (event.type === "tool_execution_end") {
          webEvent = { type: "tool_end", toolName: event.toolName, isError: event.isError };
        }
        if (webEvent) emit(webEvent);
      });
      return { prompt: (message) => agent.prompt(message), abort: async () => agent.abort(), dispose: () => agent.reset() };
    },
  });
  const retrievalSettings=new RetrievalSettingsStore(join(temp,"retrieval","settings.json"),join(temp,"empty-providers.json"),join(temp,"empty-secrets.json"));
  retrieval=new RetrievalRuntime(join(temp,"retrieval"),new KernelSourceBackend(apiUrl),retrievalSettings);
  await retrieval.start();
  gateway = createGateway({ store, retrieval });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const address = gateway.address();
  assert.ok(address && typeof address === "object");
  const webUrl = `http://127.0.0.1:${address.port}`;
  const initial = await store.create("new");
  const tooLarge = await fetch(`${webUrl}/api/web/materials?filename=large.txt&sessionId=${initial.sessionId}&goalId=${initial.state.active_goal_id}`, {
    method: "POST", body: new Uint8Array(100 * 1024 * 1024 + 1),
  });
  assert.equal(tooLarge.status, 413);

  browser = await chromium.launch({ executablePath: process.env.RESPONSIVE_BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(webUrl, { waitUntil: "domcontentloaded" });
  if (!await page.locator("#materials-button").isVisible()) await page.locator("#conversation-toggle").click();
  const sample = join(temp, "learning-rate-and-step-size-guide-学习率以及步长更新的完整学习资料.md");
  writeFileSync(sample, "学习率决定每次更新的步长。\n过大的学习率可能震荡。", "utf8");
  await page.locator("#material-file").setInputFiles(sample);
  const materialEntry = page.locator(".route-card #route-materials [data-materials-open]");
  await materialEntry.waitFor();
  assert.equal(await page.locator(".conversation-panel #route-materials, #attachment-bar, #material-summary-count").count(), 0);
  assert.equal(await page.locator("#route-materials [data-chip-remove]").count(), 0);
  assert.equal(await materialEntry.evaluate(element => element.nextElementSibling === null && element.parentElement?.nextElementSibling?.matches(".curriculum-details")), true);
  // 2026-10-19 用户要求资料入口更显眼：路线卡底部是独立卡片（可见边框/底色 + 箭头），不再是裸文本行。
  assert.notEqual(await materialEntry.evaluate(element => getComputedStyle(element).borderTopWidth), "0px");
  assert.notEqual(await materialEntry.evaluate(element => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)");
  assert.equal(await materialEntry.locator(".route-material-chevron .ui-icon").count(), 1);
  assert.equal(await materialEntry.locator(".route-material-icon .ui-icon").count(), 1);
  assert.equal(await page.locator("#route-materials .route-material-name").evaluate(element => element.scrollWidth > element.clientWidth), true, "long filenames must be truncated inside the route");
  await page.screenshot({ path: join(tmpdir(), "lawa-route-materials-preview.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator("#route-materials").evaluate(element => element.scrollWidth <= element.clientWidth), true, "mobile material row must not overflow");
  await page.setViewportSize({ width: 1280, height: 800 });
  await materialEntry.click();
  await page.locator("#materials-list .material-item").waitFor();
  const item = page.locator("#materials-list .material-item");
  const id = await item.getAttribute("data-material");
  assert.ok(id);
  const list = materialTools.find((tool) => tool.name === "list_learning_materials");
  assert.ok(list);
  const listed = await list.execute("list", {}, new AbortController().signal, undefined, {} as Parameters<typeof list.execute>[4]);
  assert.match(listed.content[0]?.type === "text" ? listed.content[0].text : "", new RegExp(id));
  const overview = await (await fetch(`${apiUrl}/api/learning/overview`)).json() as { skills: Array<{ id: string }> };
  const contextTool = materialTools.find((tool) => tool.name === "get_skill_learning_context");
  assert.ok(contextTool);
  const context = await contextTool.execute("context", { skill_id: overview.skills[0]!.id }, new AbortController().signal, undefined, {} as Parameters<typeof contextTool.execute>[4]);
  assert.match(context.content[0]?.type === "text" ? context.content[0].text : "", /"evidence_count"/);
  await item.locator("button[data-material-action=read]").click();
  await page.locator("#material-preview").getByText(/学习率决定/).waitFor();
  await item.locator("button[data-material-action=attach]").click();
  assert.match(await page.locator("#message-input").inputValue(), new RegExp(id));
  const made = spawnSync(localPython, [join(root, "scripts", "multimodal_rag_fixture.py"), temp], {windowsHide: true});
  assert.equal(made.status, 0);
  const secondSample = join(temp, "solar-image.png");
  assert.equal(await pasteFiles(page, [{name: "", type: "image/png", base64: readFileSync(secondSample).toString("base64")}]), true);
  await page.locator("#route-materials .route-material-count").getByText("2 份", { exact: true }).waitFor();
  assert.equal(await page.locator("#route-materials [data-materials-open]").count(), 1, "multiple materials must retain a single route entry");
  await materialEntry.click();
  const secondItem = page.locator("#materials-list .material-item").filter({ hasText: /粘贴图片-\d+-1\.png/ });
  await secondItem.waitFor();
  const visualId = await secondItem.getAttribute("data-material"); assert.ok(visualId);
  let visualPlan: any;
  for (let i = 0; i < 100; i++) {
    const response = await fetch(`${apiUrl}/api/learning/retrieval/visual-plan?material_id=${visualId}&fingerprint=browser-test`);
    if (response.ok) {visualPlan = await response.json(); break;} await new Promise(done => setTimeout(done, 100));
  }
  assert.ok(visualPlan);
  const published = await fetch(`${apiUrl}/api/learning/retrieval/visual-result`, {method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({material_id: visualId, source_hash: visualPlan.source_hash, parser_version: visualPlan.parser_version,
      fingerprint: "browser-test", asset_id: "image-1", analysis: {blocks: [{kind: "formula", content: "E=mc^2"},
        {kind: "table", content: "| 参数 | 值 |\n|---|---|\n| 速度 | 400 |"}], warnings: []}})});
  assert.equal(published.status, 200);
  await secondItem.locator("button[data-material-action=read]").click();
  await page.locator("#material-preview-text").getByText(/机器视觉转录/).first().waitFor();
  assert.match(await page.locator("#material-preview-text").textContent() ?? "", /E=mc\^2/);
  assert.equal(await page.locator("#material-preview-text .katex").count(), 1);
  assert.equal(await page.locator("#material-preview-text table").count(), 1);
  const originalImage = page.locator("#material-preview-assets img");
  await originalImage.waitFor(); await page.waitForFunction(() => (document.querySelector("#material-preview-assets img") as HTMLImageElement)?.naturalWidth > 0);
  assert.equal(await originalImage.getAttribute("alt"), "原始图片");
  await page.screenshot({path: join(tmpdir(), "lawa-multimodal-preview.png"), fullPage: true});
  page.once("dialog", (dialog) => void dialog.accept());
  await secondItem.locator("button[data-material-action=delete]").click();
  await secondItem.waitFor({ state: "detached" });
  await page.locator(".brand").click();
  const input = page.locator("#message-input");
  await input.fill("前选中后");
  await input.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(1, 3));
  assert.equal(await pasteFiles(page, [
    {name: "clipboard-one.txt", type: "text/plain", base64: Buffer.from("剪贴板第一份资料").toString("base64")},
    {name: "clipboard-two.md", type: "text/markdown", base64: Buffer.from("# 第二份\n多文件粘贴资料").toString("base64")},
  ], "说明", true), true, "items-only clipboard must upload all files and preserve mixed text at the selection");
  await page.locator("#route-materials .route-material-count").getByText("3 份", {exact: true}).waitFor();
  assert.ok((await input.inputValue()).startsWith("前说明后\n"));
  assert.match(await input.inputValue(), /clipboard-one\.txt/);
  assert.match(await input.inputValue(), /clipboard-two\.md/);
  assert.equal(await pasteFiles(page, [], "普通文字"), false, "text-only paste must retain browser default behavior");
  const afterTextOnly = await input.inputValue();
  assert.equal(await pasteFiles(page, [
    {name: "unsupported.exe", type: "application/octet-stream", base64: Buffer.from("unsupported").toString("base64")},
    {name: "clipboard-after-error.txt", type: "text/plain", base64: Buffer.from("失败后的有效资料仍能上传").toString("base64")},
  ]), true);
  await page.locator("#error-text").getByText(/unsupported\.exe/).waitFor();
  await page.locator("#route-materials .route-material-count").getByText("4 份", {exact: true}).waitFor();
  assert.ok((await input.inputValue()).startsWith(afterTextOnly));
  assert.match(await input.inputValue(), /clipboard-after-error\.txt/);
  await materialEntry.click();
  for (const name of ["clipboard-one.txt", "clipboard-two.md", "clipboard-after-error.txt"]) {
    const pastedItem = page.locator("#materials-list .material-item").filter({hasText: name});
    await pastedItem.waitFor();
    page.once("dialog", dialog => void dialog.accept());
    await pastedItem.locator("button[data-material-action=delete]").click();
    await pastedItem.waitFor({state: "detached"});
  }
  assert.deepEqual(await (await fetch(`${apiUrl}/api/learning/overview`)).json(), overview, "pasting must not send teaching or alter the learning ledger");
  await page.locator(".brand").click();
  const search = materialTools.find((tool) => tool.name === "search_learning_material");
  assert.ok(search);
  const found = await search.execute("search", { material_id: id, query: "学习率" }, new AbortController().signal, undefined, {} as Parameters<typeof search.execute>[4]);
  assert.match(found.content[0]?.type === "text" ? found.content[0].text : "", /"position":1/);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read_learning_material", { material_id: id, start: 1 }, { id: "material-read" }), { stopReason: "toolUse" }),
    (context: Context) => {
      const toolResult = [...context.messages].reverse().find((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "read_learning_material");
      assert.ok(toolResult && !toolResult.isError);
      const content = toolResult.content.find((item) => item.type === "text");
      assert.ok(content && content.type === "text");
      const result = JSON.parse(content.text) as { text: string; citation: string };
      return fauxAssistantMessage(`${result.citation}：${result.text}`);
    },
  ]);
  await page.locator("#send-button").click();
  await page.locator("#messages").getByText(/学习率决定/).waitFor();
  assert.match(await page.locator("#activity-list").textContent() ?? "", /阅读学习资料/);
  await materialEntry.click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator("#materials-list button[data-material-action=delete]").click();
  await page.locator("#materials-list").getByText("还没有上传资料", { exact: true }).waitFor();
  const removed = await fetch(`${apiUrl}/api/learning/materials/${id}`);
  assert.equal(removed.status, 404);
  await page.locator(".brand").click();

  // 自然导航：旧 Goal -> 新目标草稿 -> 先上传 -> 选择原对话 -> 重开草稿 -> 规划 -> 确认绑定。
  await page.locator("#new-conversation-button").click();
  await page.locator('#new-goal-dialog button[value="confirm"]').click();
  await page.locator("#workspace-title").getByText("建立新的学习目标", { exact: true }).waitFor();
  assert.equal(await page.locator("#cancel-new-goal-button, #onboarding-banner").count(), 0);
  assert.equal(await page.locator("#materials-button").isEnabled(), true);
  assert.equal(await pasteFiles(page, [{name: "draft-clipboard.md", type: "text/markdown", base64: readFileSync(sample).toString("base64")}]), true);
  const draftEntry = page.locator("#route-materials [data-materials-open]");
  await draftEntry.waitFor();
  const materialRow = await draftEntry.boundingBox();
  assert.ok(materialRow && materialRow.height < 40, "route material entry must remain a single line");
  const draftInput = await page.locator("#message-input").inputValue();
  assert.equal(await page.locator("#activity-panel").isVisible(), false, "zero Activity must not occupy learning space");
  await page.screenshot({ path: join(tmpdir(), "lawa-compact-draft-preview.png"), fullPage: true });
  const draftId = await draftEntry.getAttribute("data-material-id");
  assert.ok(draftId);
  const draftSession = (await store.listConversations()).activeSessionId!;
  assert.equal((await fetch(`${apiUrl}/api/learning/materials/${draftId}`)).status, 404, "draft must not leak into old Goal");
  assert.equal((await (await fetch(`${apiUrl}/api/learning/materials`)).json() as { total: number }).total, 0);
  let releaseLate!: () => void;
  let lateReady!: () => void;
  const lateHeld = new Promise<void>(resolve => {releaseLate = resolve;});
  const lateCreated = new Promise<void>(resolve => {lateReady = resolve;});
  let lateId = "";
  const lateMatcher = (url: URL) => url.pathname === "/api/web/materials" && url.searchParams.get("filename") === "clipboard-late-one.txt";
  await page.route(lateMatcher, async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    lateId = (await response.json()).id as string;
    lateReady();
    await lateHeld;
    await route.fulfill({response});
  });
  assert.equal(await pasteFiles(page, [
    {name: "clipboard-late-one.txt", type: "text/plain", base64: Buffer.from("迟到的草稿上传").toString("base64")},
    {name: "clipboard-late-two.txt", type: "text/plain", base64: Buffer.from("仍须使用原草稿作用域").toString("base64")},
  ]), true);
  await Promise.race([lateCreated, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Late upload fixture timed out")), 10_000))]);
  await page.locator(`#conversation-list [data-conversation-action="activate"][data-session-id="${initial.sessionId}"]`).click();
  await page.locator("#workspace-title").getByText("和你的老师一起学习", { exact: true }).waitFor();
  assert.equal((await store.listConversations()).activeSessionId, initial.sessionId);
  assert.doesNotMatch(await page.locator("#message-input").inputValue(), new RegExp(draftId));
  const lateSecond = page.waitForResponse(response => new URL(response.url()).searchParams.get("filename") === "clipboard-late-two.txt");
  releaseLate();
  const lateRejected = await lateSecond;
  assert.ok([404, 409].includes(lateRejected.status()), "remaining files must retain the inactive draft scope and be refused, never bind to the new foreground");
  assert.equal(new URL(lateRejected.url()).searchParams.get("sessionId"), draftSession);
  assert.doesNotMatch(await input.inputValue(), /clipboard-late/);
  assert.equal((await (await fetch(`${apiUrl}/api/learning/materials`)).json() as {total: number}).total, 0);
  await page.unroute(lateMatcher);
  await page.locator(`#conversation-list [data-conversation-action="activate"][data-session-id="${draftSession}"]`).click();
  await page.locator("#workspace-title").getByText("建立新的学习目标", { exact: true }).waitFor();
  assert.ok((await input.inputValue()).startsWith(draftInput));
  assert.match(await input.inputValue(), new RegExp(lateId), "late success reference must restore only in its original conversation");
  assert.doesNotMatch(await input.inputValue(), /clipboard-late-two/);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#route-materials .route-material-count").getByText("2 份", {exact: true}).waitFor();
  const restoredDraftMaterials = await (await fetch(`${webUrl}/api/web/materials?sessionId=${draftSession}`)).json() as {materials: Array<{id: string}>};
  assert.deepEqual(new Set(restoredDraftMaterials.materials.map(material => material.id)), new Set([draftId, lateId]));
  // 开场期间 app 为 inert；先等其释放，避免测试输入落在开场焦点上而成为空消息。
  await page.locator("#learning-intro").waitFor({ state: "hidden" });
  const profile = { id: "material-recitation-goal", goal_description: "依据资料学习学习率", background_summary: "新学习者", desired_outcome: "解释步长和震荡", learning_preferences: ["依据原文"], time_constraint: "灵活", prior_knowledge_claims: [] };
  const assertTool = (context: Context, name: string) => {
    const tool = [...context.messages].reverse().find((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === name);
    assert.ok(tool && !tool.isError, `${name} must succeed`);
    const content = tool.content.find((part) => part.type === "text");
    assert.ok(content?.type === "text");
    return JSON.parse(content.text) as { text?: string };
  };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read_learning_material", { material_id: draftId, start: 1 }, { id: "draft-read" }), { stopReason: "toolUse" }),
    (context: Context) => {
      assert.match(assertTool(context, "read_learning_material").text ?? "", /学习率决定/);
      return fauxAssistantMessage(fauxToolCall("record_goal_understanding", { outcome: "READY_FOR_CONFIRMATION", profile }, { id: "draft-plan" }), { stopReason: "toolUse" });
    },
    (context: Context) => { assertTool(context, "record_goal_understanding"); return fauxAssistantMessage("已依据资料理解你的目标，请确认。"); },
  ]);
  await page.locator("#message-input").fill(`请先读取资料 material_id: ${draftId}，然后规划学习。`);
  assert.match(await page.locator("#message-input").inputValue(), new RegExp(draftId));
  await page.locator("#send-button").click();
  await page.locator("#messages").getByText("已依据资料理解你的目标，请确认。", { exact: true }).waitFor();
  await page.locator("#message-input").waitFor({ state: "visible" });
  const plan = {
    goal_profile: profile,
    curriculum_spine: Array.from({ length: 5 }, (_, i) => ({ id: `material-stage-${i}`, name: `阶段 ${i + 1}`, description: "依据材料学习和练习", target_depth: "PRACTICAL" })),
    frontier_skills: [{ id: "material-step-size", name: "学习率与步长", description: "理解更新步长", prerequisites: [], target_depth: "PRACTICAL" }],
    frontier: { focus_skill_id: "material-step-size", supporting_skill_ids: [], reason: "材料首节", target_depth: "PRACTICAL", suggested_learning_mode: "EXPLAIN", next_action: "读第一节" },
    replace_existing: true,
  };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("record_goal_understanding", { outcome: "CONFIRMED" }, { id: "draft-confirm" }), { stopReason: "toolUse" }),
    (context: Context) => { assertTool(context, "record_goal_understanding"); return fauxAssistantMessage(fauxToolCall("initialize_learning_goal", plan, { id: "draft-initialize" }), { stopReason: "toolUse" }); },
    (context: Context) => { assertTool(context, "initialize_learning_goal"); return fauxAssistantMessage("资料已归属新目标，路线已建立。"); },
  ]);
  await page.locator("#message-input").fill("确认");
  await page.locator("#send-button").click();
  await page.locator("#messages").getByText("资料已归属新目标，路线已建立。", { exact: true }).waitFor();
  const bound = await (await fetch(`${apiUrl}/api/learning/materials/${draftId}`)).json() as { material: { goal_id: string }; text: string };
  assert.equal(bound.material.goal_id, profile.id);
  assert.match(bound.text, /学习率决定/);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#route-materials .route-material-count").getByText("2 份", {exact: true}).waitFor();
  assert.equal((await store.state(draftSession)).onboarding.status, "INITIALIZED");
  await page.locator(`#conversation-list [data-conversation-action="activate"][data-session-id="${initial.sessionId}"]`).click();
  await page.locator(`#conversation-list .conversation-list-item.active [data-session-id="${initial.sessionId}"]`).first().waitFor();
  await page.locator("#workspace-title").getByText("和你的老师一起学习", { exact: true }).waitFor();
  assert.equal((await store.state(initial.sessionId)).active_goal_id, initial.state.active_goal_id);
  assert.equal((await store.state(initial.sessionId)).overview.active_task && JSON.stringify((await store.state(initial.sessionId)).overview.active_task), initial.state.overview.active_task && JSON.stringify(initial.state.overview.active_task));
  console.log("Learning materials smoke passed: clipboard image/multi-file/mixed text, text-only native paste, per-file failure, late upload scope isolation; route preview/delete, draft navigation and upload-first planning retain the same IDs.");
} finally {
  await browser?.close();
  store?.dispose();
  if (gateway) {
    gateway.close();
    await once(gateway, "close");
  }
  await retrieval?.stop();
  await stopSmokeProcess(api);
  rmSync(temp, { recursive: true, force: true });
}
