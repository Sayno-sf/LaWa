import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createLearningAgentSession } from "../agentSession.js";
import { stopSmokeProcess } from "../smokeProcess.js";
import { createGateway } from "./gateway.js";
import { WebSessionStore } from "./sessionStore.js";
import type { ProviderSettingsCoordinator } from "./providerSettings.js";
import type { SpeechServiceLike } from "./speechService.js";
import type { SpeechSettings } from "./speechSettingsTypes.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const temporary = mkdtempSync(join(tmpdir(), "lawa-speech-smoke-"));
const { createServer } = await import("node:net");
const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
const address = probe.address(); assert.ok(address && typeof address === "object");
const apiPort = address.port; probe.close(); await once(probe, "close");
const apiUrl = `http://127.0.0.1:${apiPort}`;
const env: NodeJS.ProcessEnv = { ...process.env, LEARNING_STATE_PATH: ":memory:", LEARNING_MATERIALS_DIR: join(temporary, "materials") };
delete env.LEARNING_BOOTSTRAP;
const python = join(root, ".venv", "Scripts", "python.exe");
const kernel = spawn(process.env.PYTHON ?? (existsSync(python) ? python : "python"),
  ["-m", "uvicorn", "app.api.main:app", "--host", "127.0.0.1", "--port", String(apiPort)],
  { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let kernelErrors = ""; kernel.stderr?.on("data", chunk => { kernelErrors += chunk.toString(); });
kernel.on("error", error => { kernelErrors += error.message; });
let gateway: ReturnType<typeof createGateway> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let store: WebSessionStore | undefined;
// 全部云端语音在此用可计数 fixture 替代；浏览器、WAV采集、Pi Tool与Kernel使用真实链路。
function wave(): Buffer {
  const count = 48_000; const audio = Buffer.alloc(44 + count * 2);
  audio.write("RIFF"); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16_000, 24); audio.writeUInt32LE(32_000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write("data", 36); audio.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) audio.writeInt16LE(Math.round(Math.sin(i * Math.PI * 440 / 8000) * 5000), 44 + i * 2);
  return audio;
}
let settings: SpeechSettings = { enabled: true, profileId: "speech-fixture", region: "beijing", asrModel: "qwen3-asr-flash", ttsModel: "qwen3-tts-flash", voice: "Cherry" };
let transcriptions = 0; let syntheses = 0;
const speech: SpeechServiceLike = {
  getPublicSettings: async () => settings,
  saveSettings: async value => { settings = value as SpeechSettings; return settings; },
  transcribe: async source => { const audio = Buffer.from(source); assert.equal(audio.toString("ascii", 0, 4), "RIFF"); assert.equal(audio.readUInt32LE(24), 16000); assert.equal(audio.readUInt16LE(22), 1); transcriptions++; return { text: "Could you repeat that, please?" }; },
  synthesize: async () => { syntheses++; return { audio: wave(), contentType: "audio/wav" }; },
};
const provider = { getPublicSettings: async () => ({ activeProfileId: "speech-fixture", active: { provider: "aliyun-bailian", model: "faux", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", thinkingLevel: "off", maxOutputTokens: 8192, hasApiKey: true, apiKeyHint: null }, profiles: [{ id: "speech-fixture", name: "隔离百炼档案", provider: "aliyun-bailian", model: "faux", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", thinkingLevel: "off", maxOutputTokens: 8192, hasApiKey: true, apiKeyHint: null }] }) } as ProviderSettingsCoordinator;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (kernel.exitCode !== null) throw new Error(kernelErrors);
    try { if ((await fetch(`${apiUrl}/api/learning/overview`)).ok) { ready = true; break; } } catch { /* isolated server is starting */ }
    await new Promise(done => setTimeout(done, 100));
  }
  assert.ok(ready, kernelErrors); process.env.LEARNING_API_BASE_URL = apiUrl;
  const initialLedger = await (await fetch(`${apiUrl}/api/learning/overview`)).text();
  const faux = createFauxCore({ tokensPerSecond: 0 });
  const runtime = await ModelRuntime.create({ authPath: join(temporary, "auth.json"), modelsPath: null, modelsStorePath: join(temporary, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
  runtime.streamSimple = faux.streamSimple; runtime.hasConfiguredAuth = id => id === faux.getModel().provider;
  runtime.getAuth = async () => ({ auth: { apiKey: "faux-speech" }, env: {} } as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  store = new WebSessionStore({ apiBaseUrl: apiUrl, conversationDir: join(temporary, "sessions"), providerSettings: provider,
    createAgent: (context, planning, emit, manager) => createLearningAgentSession(context, planning, { apiBaseUrl: apiUrl, model: faux.getModel(), modelRuntime: runtime, sessionManager: manager, retrieval: false, surface: "WEB", onEvent: emit, log: () => undefined }) });
  gateway = createGateway({ store, speechService: speech }); gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
  const webAddress = gateway.address(); assert.ok(webAddress && typeof webAddress === "object");
  const url = `http://127.0.0.1:${webAddress.port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.RESPONSIVE_BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce", permissions: ["microphone"] });
  const page = await context.newPage(); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  let sends = 0; let lastSubmission: Record<string, unknown> | undefined;
  page.on("request", request => { if (request.method() === "POST" && /\/messages$/.test(new URL(request.url()).pathname)) { sends++; lastSubmission = request.postDataJSON() as Record<string, unknown>; } });
  await page.goto(url); await page.locator("#learning-intro").waitFor({ state: "detached" }); await page.locator('#connection-status[data-status="ready"]').waitFor();
  assert.equal(await page.locator("[data-speech-id]").count(), 0);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("present_speech", { text: "Could you repeat that, please?", language: "en", purpose: "repeat" }, { id: "speech-sample" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("先听示范，再试着说一次。"),
  ]);
  await page.locator("#message-input").fill("请读一句英语让我跟读"); await page.locator("#send-button").click();
  await page.locator("[data-speech-id]").waitFor(); await page.locator('#connection-status[data-status="ready"]').waitFor();
  assert.equal(syntheses, 0, "presentation alone must not call TTS");
  const play = page.locator('[data-speech-action="play"]').first(); await play.click();
  await page.waitForFunction(() => document.querySelector(".speech-example-status")?.textContent === "正在播放");
  assert.equal(syntheses, 1); await play.click();
  await page.locator('[data-speech-action="rate"]').first().click(); await play.click();
  assert.equal(syntheses, 1, "replay and slow rate reuse the audio"); await play.click();
  await page.reload(); await page.locator("#learning-intro").waitFor({ state: "detached" }); await page.locator("[data-speech-id]").waitFor();
  assert.equal(syntheses, 1, "reload restores descriptor without producing audio");
  await page.locator("#message-input").fill("前缀 "); const sendsBeforeVoice = sends;
  await page.locator("#voice-input-button").click();
  await page.locator("#voice-input-status").getByText(/正在录音/).waitFor();
  await page.waitForTimeout(1500); await page.locator("#voice-input-button").click();
  try { await page.waitForFunction(() => (document.querySelector("#message-input") as HTMLTextAreaElement).value.includes("Could you repeat"), undefined, { timeout: 5000 }); }
  catch (error) { process.stdout.write(JSON.stringify({ transcriptions, input: await page.locator("#message-input").inputValue(), error: await page.locator("#error-text").innerText(), status: await page.locator("#voice-input-status").innerText() }) + "\n"); throw error; }
  assert.equal(sends, sendsBeforeVoice, "recognition must never send a teacher turn"); assert.equal(transcriptions, 1);
  assert.match(await page.locator("#message-input").inputValue(), /前缀/);
  await page.locator("#message-input").fill("前缀 Could you repeat that again, please?");
  faux.setResponses([fauxAssistantMessage("可以用更自然的方式表达；本轮不判断发音。")]);
  await page.locator("#send-button").click(); await page.locator('#connection-status[data-status="ready"]').waitFor();
  assert.deepEqual(lastSubmission?.voice_input, { source: "voice", transcriptEdited: true });
  assert.equal(await (await fetch(`${apiUrl}/api/learning/overview`)).text(), initialLedger, "speech and transcription cannot write learning facts");
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
    await page.setViewportSize(viewport); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.locator("[data-speech-id]").first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(tmpdir(), `lawa-speech-${viewport.width}.png`), fullPage: true, animations: "disabled" });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#settings-button").click(); await page.locator("#speech-settings > summary").click();
  await page.locator('#speech-settings-form [name="profileId"]').selectOption("speech-fixture");
  await page.locator('#speech-settings-form button[type="submit"]').click();
  await page.locator("#speech-settings-message").getByText(/语音已启用/).waitFor();
  assert.equal(syntheses, 1, "saving settings must not generate speech");
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); await page.locator("#speech-settings").scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({ path: join(tmpdir(), `lawa-speech-settings-${viewport.width}.png`), fullPage: true, animations: "disabled" });
  }
  assert.deepEqual(errors, []);
  process.stdout.write("Speech smoke passed: actual Pi tool, persisted component, lazy playback/replay/slow speed, real browser WAV capture, draft-only ASR and edited provenance, desktop/mobile, unchanged isolated Kernel.\n");
} finally {
  await browser?.close(); store?.dispose();
  if (gateway?.listening) { gateway.close(); await once(gateway, "close"); }
  await stopSmokeProcess(kernel);
  // 临时目录以绝对路径核对后才删除；从不操作用户真实学习数据。
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir())); assert.ok(basename(temporary).startsWith("lawa-speech-smoke-")); rmSync(temporary, { recursive: true, force: true });
}
