import {LessonArtwork} from "../lessonArtwork.js";
import {LearningSkillPreferences} from "../learningSkillPreferences.js";
import "../httpDispatcher.js";
import {MaterialReadingRuntime} from "../materialReadingRuntime.js";
import {GrowthClient, GrowthExecutor, GrowthRuntime} from "../growthRuntime.js";

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getRetrievalRuntime } from "../retrieval/defaultRuntime.js";
import type { RetrievalRuntime } from "../retrieval/runtime.js";
import type { RetrievalSettings } from "../retrieval/types.js";

import {
  WebSessionError,
  WebSessionStore,
  type WebSessionEvent,
} from "./sessionStore.js";
import {
  ProviderSettingsError,
  ProviderSettingsService,
  type ProviderSettingsInput,
} from "./providerSettings.js";
import { MAX_VOICE_AUDIO_BYTES, SpeechService, SpeechServiceError, type SpeechServiceLike } from "./speechService.js";
import { StudyTimeStore, StudyTimeError } from "./studyTimeStore.js";
import { studyScope, studyTimingPrompt, type StudyInterval } from "../studyTimeTypes.js";
import { TEACHING_INSTRUCTIONS_MAX_CHARS, teachingInstructions } from "../teachingInstructions.js";
import { AssistantStoreError } from "../assistantStore.js";
import {LearningSkillLibrary} from "../learningSkillLibrary.js";
import {learningSkillRoutes} from "./learningSkillRoutes.js";

const TRACE_LABELS: Record<string, string> = {
  list_learning_skills: "正在查看可用讲解方法…",
  load_learning_skill: "正在读取讲解方法…",
  read_learning_skill_resource: "正在查阅讲解参考…",
  get_learning_overview: "正在读取学习状态…",
  get_skill_learning_context: "正在读取这个技能的学习记录…",
  list_learning_materials: "正在列出学习资料…",
  read_learning_material: "正在阅读学习资料…",
  set_learning_material_purpose: "正在整理资料用途…",
  read_learning_document: "正在阅读原件…",
  list_learning_visuals: "正在定位原图…",
  read_learning_visual: "正在阅读原图…",
  start_material_reading: "正在安排资料阅读…",
  get_material_reading: "正在查看资料阅读状态…",
  stop_material_reading: "正在停止资料阅读…",
  search_learning_material: "正在检索学习资料…",
  search_learning_sources: "正在查找知识卡片、笔记和资料…",
  read_learning_source: "正在核对来源原文…",
  record_goal_understanding: "正在理解你的学习目标…",
  initialize_learning_goal: "正在建立学习路线…",
  apply_curriculum_plan: "正在调整当前学习前沿…",
  create_learning_task: "正在准备学习任务…",
  activate_learning_task: "正在开始当前任务…",
  record_teaching_turn: "正在整理教学上下文…",
  active_recall_checkpoint: "正在检查理解并准备下一题…",
  ask_learner_questions: "正在整理需要你回答的问题…",
  submit_evidence: "正在记录学习证据…",
  complete_learning_task: "正在完成当前任务…",
  create_knowledge_card: "正在生成知识卡片…",
};

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

export interface GatewayOptions {
  growth?: GrowthRuntime;
  learningSkillPreferences?: LearningSkillPreferences;
  learningSkillLibrary?: LearningSkillLibrary;
  studyTime?: StudyTimeStore;
  store?: WebSessionStore;
  staticDir?: string;
  retrieval?: RetrievalRuntime;
  speechService?: SpeechServiceLike;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function materialApi(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const base = (process.env.LEARNING_API_BASE_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(25_000) });
  const body = await response.json().catch(() => ({})) as { detail?: string };
  if (!response.ok) throw new WebSessionError(body.detail ?? `Learning API HTTP ${response.status}`, response.status);
  return { status: response.status, body };
}

function materialScopeParams(scope: string): Record<string, string> {
  return scope.startsWith("draft:") ? { draft_session_id: scope.slice(6) } : { expected_goal_id: scope };
}

async function* boundedUpload(request: IncomingMessage): AsyncGenerator<Buffer> {
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 100 * 1024 * 1024) {
      request.resume();
      throw new WebSessionError("文件超过 100 MiB。", 413);
    }
    yield bytes;
  }
}

async function readJson(request: IncomingMessage, maximum = 1_000_000): Promise<Record<string, unknown>> {
  // 入站网络块可以截断汉字/emoji；由Node跨块解码，不能逐块隐式Buffer.toString破坏用户原文。
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > maximum) throw new WebSessionError("Request is too large", 413);
  }
  if (!body) return {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new WebSessionError("Request body must be valid JSON", 400);
  }
}

function userFacingError(error: unknown): { status: number; message: string; code?: string } {
  if (error instanceof AssistantStoreError) return {status:error.statusCode,message:error.message};
  if (error instanceof StudyTimeError) return { status: error.statusCode, message: error.message };
  if (error instanceof SpeechServiceError) {
    return { status: error.statusCode, message: error.message, code: error.code };
  }
  if (error instanceof ProviderSettingsError) {
    return { status: error.statusCode, message: error.message, code: error.code };
  }
  if (error instanceof WebSessionError) {
    return { status: error.statusCode, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  const userApiFailure = message.match(/^User API returned HTTP (\d+):\s*(.+)$/s);
  if (userApiFailure) {
    return {
      status: Number(userApiFailure[1]),
      message: userApiFailure[2] ?? "当前状态不允许执行这个操作。",
    };
  }
  if (/fetch failed|ECONNREFUSED|Learning API/i.test(message)) {
    return {
      status: 503,
      message: "学习服务暂时不可用。请确认 Python Learning API 已启动后重试。",
    };
  }
  if (/API key|authenticated model|Unknown PI_MODEL|model/i.test(message)) {
    return {
      status: 502,
      message: "AI 模型暂时不可用。请检查 Provider 配置后重试，本次学习状态没有丢失。",
    };
  }
  return { status: 500, message: "请求没有完成，请稍后重试。" };
}

function assertLocalSpeechRequest(request: IncomingMessage): void {
  const host = request.headers.host;
  let local: URL;
  try { local = new URL(`http://${host}`); } catch { throw new WebSessionError("语音请求来源无效。", 403); }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(local.hostname) || request.headers["sec-fetch-site"] === "cross-site") {
    throw new WebSessionError("语音只接受本地同源请求。", 403);
  }
  const origin = request.headers.origin;
  if (origin && origin !== local.origin) throw new WebSessionError("语音只接受本地同源请求。", 403);
}

function speechRequestSignal(request: IncomingMessage, response: ServerResponse): { signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController();
  const aborted = () => controller.abort();
  const closed = () => { if (!response.writableEnded) controller.abort(); };
  request.once("aborted", aborted); response.once("close", closed);
  return { signal: controller.signal, cleanup: () => { request.removeListener("aborted", aborted); response.removeListener("close", closed); } };
}

async function readVoiceAudio(request: IncomingMessage): Promise<Buffer> {
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "audio/wav") throw new WebSessionError("录音必须以 audio/wav 上传。", 415);
  if (Number(request.headers["content-length"]) > MAX_VOICE_AUDIO_BYTES) throw new WebSessionError("录音超过 4 MiB。", 413);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length;
    if (size > MAX_VOICE_AUDIO_BYTES) { request.resume(); throw new WebSessionError("录音超过 4 MiB。", 413); }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function providerSettingsInput(body: Record<string, unknown>): ProviderSettingsInput {
  if (
    typeof body.provider !== "string" ||
    typeof body.model !== "string" ||
    typeof body.baseUrl !== "string" ||
    (body.profileId !== undefined && typeof body.profileId !== "string") ||
    (body.name !== undefined && typeof body.name !== "string") ||
    (body.apiKey !== undefined && typeof body.apiKey !== "string") ||
    (body.thinkingLevel !== undefined && typeof body.thinkingLevel !== "string") ||
    (body.maxOutputTokens !== undefined && typeof body.maxOutputTokens !== "number")
  ) {
    throw new WebSessionError("provider、model 与 baseUrl 为必填字符串。", 400);
  }
  return {
    profileId: body.profileId,
    name: body.name,
    provider: body.provider,
    model: body.model,
    baseUrl: body.baseUrl,
    apiKey: body.apiKey,
    thinkingLevel: body.thinkingLevel as ProviderSettingsInput["thinkingLevel"],
    maxOutputTokens: body.maxOutputTokens,
  };
}

function providerProfileId(body: Record<string, unknown>): string {
  if (typeof body.profileId !== "string" || !body.profileId.trim()) {
    throw new WebSessionError("profileId 为必填字符串。", 400);
  }
  return body.profileId;
}

function streamEvent(response: ServerResponse, event: WebSessionEvent): void {
  // Browser 只看到可解释的高层 Activity，不转发 Prompt、隐藏推理或原始 Tool JSON。
  // 这既保留可观察性，也避免把内部推理伪装成产品事实。
  if (event.type === "model_error") {
    response.write(
      `${JSON.stringify({
        type: "error",
        message: event.message.startsWith("本次评分尚未保存") ? "本次评分尚未保存，反馈没有完成。原作答记录会保留。"
          : "AI 模型本轮没有完成回复。已保存的学习记录会保留。",
      })}\n`,
    );
    return;
  }
  if (event.type === "output_limit") {
    response.write(
      `${JSON.stringify({
        type: "error",
        message: "本轮回答达到了最大输出 Tokens，已保留当前内容。请调高该模型配置的输出上限，或直接让老师从断点继续。",
      })}\n`,
    );
    return;
  }
  if (event.type === "tool_start") {
    response.write(
      `${JSON.stringify({
        type: "trace",
        status: "running",
        toolName: event.toolName,
        label: TRACE_LABELS[event.toolName] ?? "Agent 正在处理…",
      })}\n`,
    );
    return;
  }
  if (event.type === "tool_end") {
    response.write(
      `${JSON.stringify({
        type: "trace",
        status: event.isError ? "error" : "done",
        toolName: event.toolName,
        label: TRACE_LABELS[event.toolName] ?? "Agent 已完成一步处理",
      })}\n`,
    );
    return;
  }
  response.write(`${JSON.stringify(event)}\n`);
}

function parseDirectSkillCommand(message: string): {
  action: "master" | "reopen" | "practice";
  skillId: string;
} | null {
  const match = message.trim().match(/^\/(master|reopen|practice)\s+(\S+)\s*$/i);
  if (!match) return null;
  return {
    action: match[1]!.toLowerCase() as "master" | "reopen" | "practice",
    skillId: match[2]!,
  };
}

function serveStatic(response: ServerResponse, staticDir: string, urlPath: string): void {
  const requested = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
  const root = resolve(staticDir);
  let filePath = resolve(root, normalize(requested));
  const relativePath = relative(root, filePath);
  if (
    relativePath.startsWith("..") ||
    isAbsolute(relativePath) ||
    !existsSync(filePath) ||
    statSync(filePath).isDirectory()
  ) {
    filePath = join(root, "index.html");
  }
  if (!existsSync(filePath)) {
    json(response, 503, {
      detail: "Web assets are missing. Run npm run web:build before starting the gateway.",
    });
    return;
  }
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
    "Cache-Control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
  });
  createReadStream(filePath).pipe(response);
}

export function createGateway(options: GatewayOptions = {}) {
  const studyTime = options.studyTime ?? new StudyTimeStore(process.env.STUDY_TIME_PATH?.trim()
    ? resolve(process.env.STUDY_TIME_PATH) : fileURLToPath(new URL("../../../data/study-time.json", import.meta.url)));
  const defaultConversationDir = fileURLToPath(
    new URL("../../../data/web-sessions/", import.meta.url),
  );
  const defaultProviderSettingsPath = fileURLToPath(
    new URL("../../../data/provider-settings.json", import.meta.url),
  );
  const defaultProviderSecretsPath = fileURLToPath(
    new URL("../../../data/provider-secrets.json", import.meta.url),
  );
  const providerSettings = new ProviderSettingsService({
    settingsPath: process.env.PROVIDER_SETTINGS_PATH?.trim()
      ? resolve(process.env.PROVIDER_SETTINGS_PATH)
      : defaultProviderSettingsPath,
    secretsPath: process.env.PROVIDER_SECRETS_PATH?.trim()
      ? resolve(process.env.PROVIDER_SECRETS_PATH)
      : defaultProviderSecretsPath,
  });
  const retrieval = options.retrieval ? Promise.resolve(options.retrieval) : getRetrievalRuntime();
  const speech = options.speechService ?? new SpeechService({
    settingsPath: process.env.SPEECH_SETTINGS_PATH?.trim()
      ? resolve(process.env.SPEECH_SETTINGS_PATH)
      : fileURLToPath(new URL("../../../data/speech-settings.json", import.meta.url)),
    credentials: providerSettings,
  });
  const materialReading = options.store ? undefined : new MaterialReadingRuntime({
    baseUrl: process.env.LEARNING_API_BASE_URL ?? "http://127.0.0.1:8000",
    selection: () => providerSettings.getActiveRuntime(),
    onError: code => console.error(`[material-reading] ${code}`),
  });
  const store = options.store ?? new WebSessionStore({
    lessonArt:new LessonArtwork(join(process.env.WEB_SESSION_DIR?.trim()||defaultConversationDir,"lesson-art"),providerSettings),
    materialReading,
    studyTiming: async overview => studyTimingPrompt(await studyTime.summary(studyScope(overview))),
    speechStatus: async () => {
      if (speech.getTeachingStatus) return speech.getTeachingStatus();
      // 自定义服务仅有公共设置时，不能把启用冒充凭据或地域已校验。
      return (await speech.getPublicSettings()).enabled ? "UNKNOWN" : "DISABLED";
    },
    scopePurged: goalId => studyTime.purgeGoal(goalId),
    apiBaseUrl: process.env.LEARNING_API_BASE_URL,
    conversationDir:
      process.env.WEB_SESSION_DIR?.trim() || defaultConversationDir,
    conversationCwd: process.env.WEB_SESSION_CWD?.trim()
      ? resolve(process.env.WEB_SESSION_CWD) : undefined,
    log: (message) => console.error(message),
    providerSettings,
    scopeChanged: (scope, deleted) => { materialReading?.wake(true); void retrieval.then(runtime => runtime.scopeChanged(scope, deleted)).catch(() => undefined); },
  });
  materialReading?.start();
  const growth = options.growth ?? (options.store ? undefined : new GrowthRuntime(new GrowthExecutor(
    new GrowthClient(), () => providerSettings.getActiveRuntime())));
  growth?.start();
  const defaultStaticDir = fileURLToPath(new URL("../../web-dist", import.meta.url));
  const staticDir = options.staticDir ?? defaultStaticDir;
  const skillPreferences=options.learningSkillPreferences??new LearningSkillPreferences();
  const skillsRoute=learningSkillRoutes(options.learningSkillLibrary??new LearningSkillLibrary(join(dirname(skillPreferences.path),"learning-skill-library")),skillPreferences);

  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const pathname = requestUrl.pathname;
    response.once("finish", () => {
      const classroomWrite = /^\/api\/web\/(sessions|goals|reviews|branches|recycle|cards|materials|teaching)(\/|$)/.test(pathname) && !pathname.includes("/voice/");
      if (classroomWrite && !["GET", "HEAD"].includes(method) && response.statusCode >= 200 && response.statusCode < 300) store.classroom?.changed();
    });
    try {
      if(pathname==="/api/web/excerpt-notes"||pathname.startsWith("/api/web/excerpt-notes/")){
        const origin=request.headers.origin;
        if(origin&&new URL(origin).host!==request.headers.host)throw new WebSessionError("请在当前学习网页中操作笔记。",403);
        try{
          if(pathname==="/api/web/excerpt-notes/resolve-bindings"&&method==="POST"){json(response,200,await store.repairNoteBindings());return;}
          if(pathname==="/api/web/excerpt-notes"&&method==="GET"){json(response,200,store.excerptNotes.list());return;}
          if(pathname==="/api/web/excerpt-notes"&&method==="POST"){
            const body=await readJson(request);const source=await store.resolveNoteSource(body.source as import("./excerptNotes.js").NoteSource);
            json(response,200,store.excerptNotes.save(source,body));return;
          }
          const match=pathname.match(/^\/api\/web\/excerpt-notes\/([^/]+)(\/source)?$/);
          if(match&&method==="GET"&&match[2]){const note=store.excerptNotes.get(decodeURIComponent(match[1]!));json(response,200,await store.noteSourceContext(note.source));return;}
          if(match&&method==="PUT"&&!match[2]){const body=await readJson(request);json(response,200,store.excerptNotes.update(decodeURIComponent(match[1]!),body.understanding));return;}
        }catch(error){const failure=error as Error&{statusCode?:number};json(response,failure.statusCode??500,{detail:failure.message});return;}
      }
      if(await skillsRoute(request,response,pathname))return;
      if (method === "GET" && pathname === "/api/web/classroom/snapshot") {
        json(response, 200, await store.sharedClassroom()); return;
      }
      if (method === "GET" && pathname === "/api/web/classroom/events") {
        const send = (value: unknown) => {
          if (response.destroyed || !response.write(`data: ${JSON.stringify(value)}\n\n`)) {
            response.end(); throw new Error("查看连接较慢，请重新读取课堂快照。");
          }
        };
        // 先订阅、再读快照；按序号丢弃已包含的事件，填上异步读取期间的窗口。
        let ready = false, bufferedBytes = 0;
        const buffered: Array<{sequence: number}> = [];
        let unsubscribe: () => void;
        try {
          unsubscribe = store.classroom.subscribe(value => {
            if (ready) {send(value); return;}
            bufferedBytes += JSON.stringify(value).length;
            if (bufferedBytes > 128_000 || buffered.length >= 128) {response.destroy(); throw new Error("课堂变化较快，请重新连接。");}
            buffered.push(value);
          });
        } catch (error) {json(response, 429, {detail: error instanceof Error ? error.message : "查看连接过多。"}); return;}
        const heartbeat = setInterval(() => {if (ready && !response.destroyed && !response.write(": keepalive\n\n")) response.end();}, 15_000);
        response.on("close", () => {clearInterval(heartbeat); unsubscribe();});
        try {
          const snapshot = await store.sharedClassroom();
          if (response.destroyed) return;
          response.writeHead(200, {"Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no", Connection: "keep-alive"});
          send({type: "snapshot", snapshot});
          for (const notice of buffered) if (notice.sequence > snapshot.sequence) send(notice);
          ready = true;
        } catch {response.end(); clearInterval(heartbeat); unsubscribe();}
        return;
      }
      if (pathname === "/api/web/study-time" && ["GET", "POST"].includes(method)) {
        // 云端网页也只接收摘要。写请求必须来自当前站点，未来上线时由租户认证层隔离实例。
        if (method === "POST") {
          const origin = request.headers.origin;
          if (!origin || new URL(origin).host !== request.headers.host) throw new StudyTimeError("请在当前学习网页中操作摄像头观察。", 403);
          const body = await readJson(request);
          if (Object.keys(body).some(key => !["op", "sessionId", "runId", "seq", "observedMs", "focusedMs", "waitingMs", "observation"].includes(key)) || typeof body.sessionId !== "string") throw new StudyTimeError("只接受学习状态与时间摘要。");
          const scope = await store.currentStudyScope(body.sessionId);
          if (body.op === "start") json(response, 200, await studyTime.start(scope));
          else if (typeof body.runId === "string" && body.op === "observe") json(response, 200, await studyTime.observe(body.runId, body as unknown as StudyInterval, scope));
          else if (typeof body.runId === "string" && body.op === "stop") json(response, 200, await studyTime.stop(body.runId, scope));
          else throw new StudyTimeError("学习观察操作无效。");
        } else {
          const sessionId = requestUrl.searchParams.get("sessionId");
          if (!sessionId) throw new StudyTimeError("请先恢复当前学习对话。");
          json(response, 200, await studyTime.summary(await store.currentStudyScope(sessionId)));
        }
        return;
      }
      if (pathname === "/api/web/speech-settings" && ["GET", "PUT"].includes(method)) {
        assertLocalSpeechRequest(request);
        json(response, 200, method === "GET" ? await speech.getPublicSettings() : await speech.saveSettings(await readJson(request)));
        return;
      }
      const voiceScopeMatch = pathname.match(/^\/api\/web\/sessions\/([^/]+)\/voice\/scope$/);
      if (method === "GET" && voiceScopeMatch) {
        assertLocalSpeechRequest(request);
        json(response, 200, { scope: await store.voiceScope(decodeURIComponent(voiceScopeMatch[1]!)) });
        return;
      }
      const transcriptionMatch = pathname.match(/^\/api\/web\/sessions\/([^/]+)\/voice\/transcriptions$/);
      if (method === "POST" && transcriptionMatch) {
        assertLocalSpeechRequest(request);
        const sessionId = decodeURIComponent(transcriptionMatch[1]!);
        const scope = typeof request.headers["x-voice-scope"] === "string" ? request.headers["x-voice-scope"] : "";
        await store.assertVoiceScope(sessionId, scope);
        const operation = speechRequestSignal(request, response);
        try {
          const audio = await readVoiceAudio(request);
          await store.assertVoiceScope(sessionId, scope);
          const result = await speech.transcribe(audio, { signal: operation.signal });
          await store.assertVoiceScope(sessionId, scope);
          json(response, 200, result);
        } finally { operation.cleanup(); }
        return;
      }
      if (method === "POST" && pathname === "/api/web/speech/synthesize") {
        assertLocalSpeechRequest(request);
        const body = await readJson(request);
        if (typeof body.sourceSessionId !== "string" || typeof body.entryId !== "string" || typeof body.presentationId !== "string" || Object.keys(body).some(key => !["sourceSessionId", "entryId", "presentationId"].includes(key))) throw new WebSessionError("请选择已保存的老师朗读内容。", 400);
        const reference = { sourceSessionId: body.sourceSessionId, entryId: body.entryId, presentationId: body.presentationId };
        const presentation = await store.resolveSpeech(reference);
        const operation = speechRequestSignal(request, response);
        try {
          const result = await speech.synthesize(presentation, { signal: operation.signal });
          await store.resolveSpeech(reference);
          response.writeHead(200, { "Content-Type": result.contentType, "Content-Length": result.audio.length, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
          response.end(result.audio);
        } finally { operation.cleanup(); }
        return;
      }
      if (method === "GET" && pathname === "/api/web/health") {
        json(response, 200, { status: "ok" });
        return;
      }
      if (method === "GET" && pathname === "/api/web/provider-settings") {
        json(response, 200, await store.getProviderSettings());
        return;
      }
      if (pathname === "/api/web/retrieval-settings" && method === "GET") {
        json(response, 200, await (await retrieval).settings.publicSettings());
        return;
      }
      if (pathname === "/api/web/retrieval-settings" && method === "PUT") {
        const runtime = await retrieval;
        try { await runtime.settings.save(await readJson(request) as unknown as RetrievalSettings); }
        catch (error) { throw new WebSessionError(error instanceof Error ? error.message : "检索配置无效。", 400); }
        void runtime.retry();
        json(response, 200, await runtime.settings.publicSettings());
        return;
      }
      if (pathname === "/api/web/retrieval-status" && method === "GET") {
        json(response, 200, await (await retrieval).status());
        return;
      }
      if (pathname === "/api/web/retrieval-traces" && method === "GET") {
        const runtime = await retrieval;
        const id = requestUrl.searchParams.get("id");
        if (id) {
          const trace = await runtime.trace(id);
          if (!trace) throw new WebSessionError("这条检索记录已过期。",404);
          json(response,200,trace);
        } else json(response,200,await runtime.traces());
        return;
      }
      if (method === "GET" && pathname === "/api/web/learning-library") {
        // 学习库只转发 Kernel 投影；Gateway 不读取会话文本来补造学习事实。
        json(response, 200, await store.learningLibrary());
        return;
      }

      // 只代理用户读取/操作；机器评审入口没有浏览器路由，也不是教师工具。
      const growthPath = pathname.slice("/api/web/growth".length);
      if (pathname === "/api/web/growth" || pathname.startsWith("/api/web/growth/")) {
        const readable = method === "GET" && /^(?:|\/sources\/[^/]+|\/goals\/[^/]+|\/import-schema|\/export-prompt|\/imports\/[^/]+\/group-preview)$/.test(growthPath);
        const writable = method === "POST" && /^(?:\/recommendations\/[^/]+\/adopt|\/supplements|\/imports\/(?:preview|commit)|\/imports\/[^/]+\/(?:withdraw|group)|\/retry)$/.test(growthPath)
          || ["PATCH", "DELETE"].includes(method) && /^\/supplements\/[^/]+$/.test(growthPath)
          || method === "PUT" && /^(?:\/classifications\/[^/]+|\/goals\/[^/]+\/topic-assignment)$/.test(growthPath);
        if (!readable && !writable) throw new WebSessionError("成长图谱接口不存在", 404);
        const result = await materialApi(`/api/${readable ? "learning" : "user"}/growth${growthPath}`, {
          method, ...(!readable && method !== "DELETE" ? {headers: {"Content-Type": "application/json"},
            body: JSON.stringify(await readJson(request, 1_100_000))} : {}),
        });
        if (writable) growth?.wake();
        json(response, result.status, result.body); return;
      }
      const attachmentMatch = pathname.match(/^\/api\/web\/conversation-attachments\/(mat-[0-9a-f]{32})(\/(?:metadata|visuals|visual\/[a-zA-Z0-9-]{1,100}))?$/);
      if (attachmentMatch && ["GET", "DELETE"].includes(method)) {
        // 公共边界只接受原消息引用；来源Goal由Pi分支解析，浏览器不能指定历史读取权限。
        const suffix = attachmentMatch[2] ?? "";
        if (method === "DELETE" && suffix) throw new WebSessionError("附件操作无效。", 400);
        const scope = await store.resolveConversationAttachment(requestUrl.searchParams.get("sessionId"), requestUrl.searchParams.get("entryId"), attachmentMatch[1]!);
        const params = new URLSearchParams(scope);
        for (const key of ["start", "max_chars", "offset", "limit"]) {
          const value = requestUrl.searchParams.get(key);
          if (value !== null) params.set(key, value);
        }
        const path = `/api/${method === "DELETE" ? "user" : "learning"}/conversation-attachments/${attachmentMatch[1]}${suffix}?${params}`;
        if (suffix.startsWith("/visual/")) {
          const base = (process.env.LEARNING_API_BASE_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
          const original = await fetch(base + path, {signal: AbortSignal.timeout(35_000)});
          if (!original.ok) throw new WebSessionError("附件原图已删除或暂时不可用。", original.status);
          response.writeHead(200, {"Content-Type": "image/jpeg", "Cache-Control": "private, no-store"});
          response.end(Buffer.from(await original.arrayBuffer()));
        } else if (method === "DELETE") {
          await materialApi(path, {method: "DELETE"});
          store.materialDeleted(attachmentMatch[1]!);
          materialReading?.materialDeleted(attachmentMatch[1]!);
          void retrieval.then(runtime => runtime.materialDeleted(attachmentMatch[1]!)).catch(() => undefined);
          response.writeHead(204); response.end();
        } else {
          const {body} = await materialApi(path); json(response, 200, body);
        }
        return;
      }
      if (pathname === "/api/web/materials" && method === "GET") {
        const goalId = await store.materialGoal(requestUrl.searchParams.get("sessionId"), requestUrl.searchParams.get("goalId"));
        const params = new URLSearchParams(materialScopeParams(goalId));
        for (const key of ["limit", "offset"]) {
          const value = requestUrl.searchParams.get(key);
          if (value !== null) params.set(key, value);
        }
        if (requestUrl.searchParams.get("include_attachments") === "true") {
          params.set("include_attachments", "true");
          params.set("conversation_id", requestUrl.searchParams.get("sessionId")!);
        }
        const { body } = await materialApi(`/api/learning/materials?${params}`);
        json(response, 200, body);
        return;
      }
      if (pathname === "/api/web/materials" && method === "POST") {
        const filename = requestUrl.searchParams.get("filename");
        if (!filename) throw new WebSessionError("请选择文件。", 400);
        const goalId = await store.materialGoal(requestUrl.searchParams.get("sessionId"), requestUrl.searchParams.get("goalId"));
        const declared = Number(request.headers["content-length"]);
        if (Number.isFinite(declared) && declared > 100 * 1024 * 1024) throw new WebSessionError("文件超过 100 MiB。", 413);
        // 上传默认只属于原对话；长期保留用途必须显式声明，不能由扩展名推断。
        const purpose = requestUrl.searchParams.get("purpose") ?? "conversation_attachment";
        if (!["conversation_attachment", "learning_material"].includes(purpose)) throw new WebSessionError("资料用途无效。", 400);
        const params = new URLSearchParams({ filename, ...materialScopeParams(goalId), purpose,
          conversation_id: requestUrl.searchParams.get("sessionId")! });
        const controller = new AbortController();
        request.once("aborted", () => controller.abort());
        let uploadError: unknown;
        async function* streamed() {
          try { yield* boundedUpload(request!); }
          catch (error) { uploadError = error; throw error; }
        }
        const base = (process.env.LEARNING_API_BASE_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
        let upstream: Response;
        try {
          // 直接转发上传流；不保留/复制整份 100 MiB 文件。Python 在原文件完整落盘后后台解析。
          upstream = await fetch(base + "/api/user/materials?" + params, {
            method: "POST", headers: { "Content-Type": "application/octet-stream" },
            body: streamed() as unknown as BodyInit, duplex: "half",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]),
          } as RequestInit & { duplex: "half" });
        } catch (error) { throw uploadError ?? error; }
        const body = await upstream.json().catch(() => ({})) as { detail?: string };
        if (!upstream.ok) throw new WebSessionError(body.detail ?? "资料上传失败。", upstream.status);
        json(response, 201, body);
        return;
      }
      const purposeMatch = pathname.match(/^\/api\/web\/materials\/(mat-[0-9a-f]{32})\/purpose$/);
      if (purposeMatch && method === "PATCH") {
        const goalId = await store.materialGoal(requestUrl.searchParams.get("sessionId"), requestUrl.searchParams.get("goalId"));
        const input = await readJson(request) as {purpose?: unknown; expected_revision?: unknown};
        if (typeof input.purpose !== "string" || !["conversation_attachment", "learning_material"].includes(input.purpose) || !Number.isSafeInteger(input.expected_revision)) {
          throw new WebSessionError("资料用途或版本无效。", 400);
        }
        const {body} = await materialApi(`/api/user/materials/${purposeMatch[1]}/purpose?${new URLSearchParams(materialScopeParams(goalId))}`, {
          method: "PATCH", body: JSON.stringify({purpose: input.purpose, expected_revision: input.expected_revision,
            conversation_id: requestUrl.searchParams.get("sessionId")!}), headers: {"Content-Type": "application/json"},
        });
        json(response, 200, body); return;
      }
      const retryMatch = pathname.match(/^\/api\/web\/materials\/(mat-[0-9a-f]{32})\/retry$/);
      if (retryMatch && method === "POST") {
        const goalId = await store.materialGoal(requestUrl.searchParams.get("sessionId"), requestUrl.searchParams.get("goalId"));
        const { body } = await materialApi("/api/user/materials/" + retryMatch[1] + "/retry?"
          + new URLSearchParams(materialScopeParams(goalId)), { method: "POST" });
        json(response, 200, body);
        return;
      }
      const materialMatch = pathname.match(/^\/api\/web\/materials\/(mat-[0-9a-f]{32})$/);
      const visualMatch = pathname.match(/^\/api\/web\/materials\/(mat-[0-9a-f]{32})\/visual\/([a-zA-Z0-9-]{1,100})$/);
      if (visualMatch && method === "GET") {
        const goalId = await store.materialGoal(requestUrl.searchParams.get("sessionId"), requestUrl.searchParams.get("goalId"));
        const base = (process.env.LEARNING_API_BASE_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
        const original = await fetch(`${base}/api/learning/materials/${visualMatch[1]}/visual/${visualMatch[2]}?` +
          new URLSearchParams(materialScopeParams(goalId)), {signal: AbortSignal.timeout(35_000)});
        if (!original.ok) throw new WebSessionError("原图不可用。", original.status);
        response.writeHead(200, {"Content-Type": "image/jpeg", "Cache-Control": "private, no-store"});
        response.end(Buffer.from(await original.arrayBuffer())); return;
      }
      if (materialMatch && method === "GET") {
        const goalId = await store.materialGoal(requestUrl.searchParams.get("sessionId"), requestUrl.searchParams.get("goalId"));
        const params = new URLSearchParams(requestUrl.search);
        params.delete("sessionId"); params.delete("goalId");
        params.delete("draft_session_id"); params.delete("expected_goal_id");
        for (const [key, value] of Object.entries(materialScopeParams(goalId))) params.set(key, value);
        const { body } = await materialApi(`/api/learning/materials/${materialMatch[1]}?${params}`);
        json(response, 200, body);
        return;
      }
      if (materialMatch && method === "DELETE") {
        const goalId = await store.materialGoal(requestUrl.searchParams.get("sessionId"), requestUrl.searchParams.get("goalId"));
        await materialApi(`/api/user/materials/${materialMatch[1]}?${new URLSearchParams(materialScopeParams(goalId))}`, { method: "DELETE" });
        // 只有权威删除成功才撤销本实例工作；重清理异步进行，不拖住用户的删除响应。
        store.materialDeleted(materialMatch[1]!);
        materialReading?.materialDeleted(materialMatch[1]!);
        void retrieval.then(runtime => runtime.materialDeleted(materialMatch[1]!)).catch(() => undefined);
        response.writeHead(204);
        response.end();
        return;
      }
      const goalActivateMatch = pathname.match(/^\/api\/web\/goals\/([^/]+)\/activate$/);
      if (method === "POST" && pathname === "/api/web/learning-branches/transition") {
        const body = await readJson(request);
        json(response, 200, await store.transitionRouteBranch(body as unknown as import("../learningBranchTypes.js").RouteBranchCommand));
        return;
      }
      if (method === "POST" && goalActivateMatch) {
        json(response, 200, await store.activateGoal(decodeURIComponent(goalActivateMatch[1]!)));
        return;
      }
      const skillLocateMatch = pathname.match(/^\/api\/web\/goals\/([^/]+)\/skills\/([^/]+)\/locate$/);
      if (method === "POST" && skillLocateMatch) {
        const body = await readJson(request);
        if (Object.keys(body).some(key => key !== "branchId") || (body.branchId !== undefined && (typeof body.branchId !== "string" || !body.branchId.trim())))
          throw new WebSessionError("学习记录定位参数无效。", 400);
        json(response, 200, await store.locateSkill(decodeURIComponent(skillLocateMatch[1]!), decodeURIComponent(skillLocateMatch[2]!), body.branchId as string | undefined));
        return;
      }
      const skillReviewMatch = pathname.match(/^\/api\/web\/goals\/([^/]+)\/skills\/([^/]+)\/review$/);
      if (method === "POST" && skillReviewMatch) {
        const body = await readJson(request);
        if (typeof body.operationId !== "string") throw new WebSessionError("operationId is required", 400);
        json(response, 200, await store.startSkillReview(decodeURIComponent(skillReviewMatch[1]!), decodeURIComponent(skillReviewMatch[2]!), body.operationId));
        return;
      }
      if (method === "POST" && pathname === "/api/web/reviews/finish") {
        json(response, 200, await store.finishSkillReview());
        return;
      }
      if (method === "POST" && pathname === "/api/web/branches/select") {
        const body = await readJson(request);
        if (typeof body.entryId !== "string") throw new WebSessionError("entryId is required", 400);
        json(response, 200, await store.selectBranch(body.entryId));
        return;
      }
      if (method === "POST" && pathname === "/api/web/provider-settings/test") {
        const body = await readJson(request);
        json(response, 200, await store.testProviderConnection(providerSettingsInput(body)));
        return;
      }
      if (method === "PUT" && pathname === "/api/web/provider-settings") {
        const body = await readJson(request);
        json(response, 200, await store.saveProviderSettings(providerSettingsInput(body)));
        void retrieval.then(runtime => runtime.retry()).catch(() => undefined);
        return;
      }
      if (method === "POST" && pathname === "/api/web/provider-settings/activate") {
        const body = await readJson(request);
        json(response, 200, await store.activateProviderProfile(providerProfileId(body)));
        return;
      }
      if (method === "DELETE" && pathname === "/api/web/provider-settings") {
        const body = await readJson(request);
        json(response, 200, await store.deleteProviderProfile(providerProfileId(body)));
        return;
      }
      if (method === "POST" && pathname === "/api/web/sessions") {
        const body = await readJson(request);
        const mode = body.mode ?? "resume-recent";
        if (mode !== "resume-recent" && mode !== "new" && mode !== "new-goal") {
          throw new WebSessionError("mode 必须是 resume-recent、new 或 new-goal。", 400);
        }
        json(response, 201, await store.create(mode));
        return;
      }
      if (method === "GET" && pathname === "/api/web/sessions") {
        // 会话目录与学习状态分离；这些 CRUD 路由绝不切换 Kernel Goal。
        json(response, 200, await store.listConversations());
        return;
      }

      if (pathname === "/api/web/recycle" && method === "GET") {
        json(response, 200, await store.listRecycle()); return;
      }
      const recycleMatch = pathname.match(/^\/api\/web\/recycle\/([^/]+)\/(restore|purge)$/);
      if (recycleMatch && method === "POST") {
        json(response, 200, await store.actOnRecycle(decodeURIComponent(recycleMatch[1]!), recycleMatch[2] as "restore" | "purge")); return;
      }
      const deleteGoalMatch = pathname.match(/^\/api\/web\/goals\/([^/]+)$/);
      if (deleteGoalMatch && method === "DELETE") {
        json(response, 200, await store.deleteGoal(decodeURIComponent(deleteGoalMatch[1]!))); return;
      }
      const clearMatch = pathname.match(/^\/api\/web\/sessions\/([^/]+)\/clear$/);
      if (clearMatch && method === "POST") {
        json(response, 200, await store.clearConversation(decodeURIComponent(clearMatch[1]!))); return;
      }

      const sessionMatch = pathname.match(/^\/api\/web\/sessions\/([^/]+)$/);
      if (sessionMatch && method === "PATCH") {
        const body = await readJson(request);
        if (typeof body.name !== "string") {
          throw new WebSessionError("name 为必填字符串。", 400);
        }
        const id = decodeURIComponent(sessionMatch[1]!);
        await store.renameConversation(id, body.name);
        json(response, 200, await store.listConversations());
        return;
      }
      if (sessionMatch && method === "DELETE") {
        json(
          response,
          200,
          await store.deleteConversation(decodeURIComponent(sessionMatch[1]!)),
        );
        return;
      }

      const activateMatch = pathname.match(/^\/api\/web\/sessions\/([^/]+)\/activate$/);
      if (method === "POST" && activateMatch) {
        json(
          response,
          200,
          await store.activateConversation(decodeURIComponent(activateMatch[1]!)),
        );
        return;
      }

      const personalTeachingMatch = pathname.match(/^\/api\/web\/teaching(?:\/([^/]+)\/decision)?$/);
      if (personalTeachingMatch && (method === "GET" && !personalTeachingMatch[1] || method === "POST" && personalTeachingMatch[1])) {
        const origin = request.headers.origin;
        if (origin && new URL(origin).host !== request.headers.host) throw new WebSessionError("请在当前学习网页中管理教学安排。", 403);
        json(response, 200, await store.personalTeaching(personalTeachingMatch[1] ? {id: decodeURIComponent(personalTeachingMatch[1]), body: await readJson(request)} : undefined));
        return;
      }


      // 学习者自定义教学提示词：Node 独占的偏好文件，保存后从下一条教学消息起注入老师。
      if (pathname === "/api/web/teaching-instructions" && (method === "GET" || method === "PUT")) {
        const origin = request.headers.origin;
        if (origin && new URL(origin).host !== request.headers.host) throw new WebSessionError("请在当前学习网页中修改自定义提示词。", 403);
        const instructions = teachingInstructions();
        if (method === "GET") { json(response, 200, await instructions.read()); return; }
        const body = await readJson(request);
        if (typeof body.text !== "string") throw new WebSessionError("自定义提示词格式不正确。", 400);
        if (Array.from(body.text.trim()).length > TEACHING_INSTRUCTIONS_MAX_CHARS) {
          throw new WebSessionError(`自定义提示词最多 ${TEACHING_INSTRUCTIONS_MAX_CHARS} 字。`, 400);
        }
        json(response, 200, await instructions.save(body.text));
        return;
      }
      const stateMatch = pathname.match(/^\/api\/web\/sessions\/([^/]+)\/state$/);
      const masteryDecisionMatch = pathname.match(/^\/api\/web\/sessions\/([^/]+)\/mastery-decision$/);
      if (method === "POST" && masteryDecisionMatch) {
        const origin = request.headers.origin;
        if (origin && new URL(origin).host !== request.headers.host)
          throw new WebSessionError("请从当前课堂提交掌握决定。", 403);
        const body = await readJson(request);
        if (Object.keys(body).some(key => !["learner_reply", "expected_version"].includes(key)))
          throw new WebSessionError("掌握决定只接受当前组件选择。", 400);
        json(response, 200, await store.masteryDecision(decodeURIComponent(masteryDecisionMatch[1]!), body.learner_reply, body.expected_version));
        return;
      }
      const teachingMatch = pathname.match(/^\/api\/web\/sessions\/([^/]+)\/teaching(?:\/([^/]+)\/decision)?$/);
      if (teachingMatch && (method === "GET" || method === "POST" && teachingMatch[2])) {
        const identity = decodeURIComponent(teachingMatch[1]!);
        if (method === "GET") {
          json(response, 200, await store.teaching(identity, undefined, requestUrl.searchParams.get("all") === "1")); return;
        }
        const origin = request.headers.origin;
        if (origin && new URL(origin).host !== request.headers.host) throw new WebSessionError("请从当前课堂提交教学意见。", 403);
        const body = await readJson(request);
        json(response, 200, await store.teaching(identity, {id: decodeURIComponent(teachingMatch[2]!), body})); return;
      }
      if (method === "GET" && stateMatch) {
        json(response, 200, await store.state(decodeURIComponent(stateMatch[1]!)));
        return;
      }

      const artworkMatch=/^\/api\/web\/sessions\/([^/]+)\/lesson-art\/([a-f0-9-]{36})\/([a-f0-9]{64})(\/image)?$/.exec(pathname);
      if (method==="GET" && artworkMatch) {
        const resource=await store.lessonArtResource(decodeURIComponent(artworkMatch[1]!),artworkMatch[2]!,artworkMatch[3]!,!!artworkMatch[4],requestUrl.searchParams.get("message"));
        if (Buffer.isBuffer(resource)) {
          response.writeHead(200,{"Content-Type":"image/png","Content-Length":resource.length,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"});
          response.end(resource);
        } else json(response,200,resource);
        return;
      }
      const assistantMatch = pathname.match(/^\/api\/web\/sessions\/([^/]+)\/assistant(?:\/(stop))?$/);
      if (assistantMatch && ["GET","POST"].includes(method)) {
        const sessionId = decodeURIComponent(assistantMatch[1]!);
        if (method === "GET" && !assistantMatch[2]) {
          json(response,200,await store.assistant(sessionId)); return;
        }
        if (method === "POST") {
          const origin = request.headers.origin;
          if (origin && new URL(origin).host !== request.headers.host) throw new WebSessionError("请从当前课堂向助教提问。",403);
          if (assistantMatch[2] === "stop") {
            await store.stopAssistant(sessionId); json(response,200,{status:"stopped"}); return;
          }
          const body = await readJson(request);
          if (typeof body.text !== "string" || Object.keys(body).some(key => !["text","animation_context","figure_context"].includes(key))) throw new WebSessionError("助教只接受当前课堂的问题与动画位置。",400);
          response.writeHead(200,{"Content-Type":"application/x-ndjson; charset=utf-8","Cache-Control":"no-cache","X-Content-Type-Options":"nosniff"});
          const disconnected = () => { if (!response.writableEnded) void store.stopAssistant(sessionId).catch(() => undefined); };
          response.on("close",disconnected);
          try { await store.sendAssistant(sessionId,body.text,event => {
            if (response.destroyed) throw new Error("答疑连接已断开。");
            response.write(JSON.stringify(event)+"\n");
          },body.animation_context,body.figure_context); } catch (error) {
            if (!response.destroyed) response.write(JSON.stringify({type:"error",message:userFacingError(error).message})+"\n");
          } finally { response.off("close",disconnected); response.end(); }
          return;
        }
      }

      const feedbackRetryMatch = pathname.match(/^\/api\/web\/sessions\/([^/]+)\/retry-feedback$/);
      if (method === "POST" && feedbackRetryMatch) {
        const origin = request.headers.origin;
        if (origin && new URL(origin).host !== request.headers.host) throw new WebSessionError("请从当前课堂恢复本次反馈。", 403);
        const body = await readJson(request);
        response.writeHead(200, {"Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Content-Type-Options": "nosniff"});
        try {
          await store.retryFeedback(decodeURIComponent(feedbackRetryMatch[1]!), body.recovery_id,
            event => streamEvent(response, event), body.expected_version);
        } catch (error) {streamEvent(response, {type: "error", message: userFacingError(error).message});}
        response.end(); return;
      }

      const messageMatch = pathname.match(/^\/api\/web\/sessions\/([^/]+)\/messages$/);
      if (method === "POST" && messageMatch) {
        const body = await readJson(request);
        if (typeof body.message !== "string") {
          throw new WebSessionError("message is required", 400);
        }
        if(body.animation_context!==undefined){
          if(Object.keys(body).some(key=>!["message","request_id","expected_version","animation_context","retry_of_request_id","query_animation_request"].includes(key))||parseDirectSkillCommand(body.message)||
            (body.query_animation_request!==undefined&&body.query_animation_request!==true)||body.query_animation_request===true&&body.retry_of_request_id!==undefined)
            throw new WebSessionError("动画提问不能混合答案、学习命令或其他提交。",400);
        }else if(body.retry_of_request_id!==undefined||body.query_animation_request!==undefined)throw new WebSessionError("动画重试或查询必须携带原演示引用。",400);
        if ((body.learner_reply !== undefined || (Array.isArray(body.image_material_ids) && body.image_material_ids.length)) && parseDirectSkillCommand(body.message)) {
          throw new WebSessionError("问题回答与技能状态命令请分开发送。", 400);
        }
        const learnerAnswers = (body.learner_reply as { answers?: unknown } | undefined)?.answers;
        const hasVoiceAnswers = Array.isArray(learnerAnswers) && learnerAnswers.some(answer => answer && typeof answer === "object" && "voice_input" in answer);
        if (body.voice_input !== undefined || hasVoiceAnswers) {
          assertLocalSpeechRequest(request);
          if (body.voice_input !== undefined && parseDirectSkillCommand(body.message)) throw new WebSessionError("语音回答与技能状态命令请分开发送。", 400);
        }
        response.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Content-Type-Options": "nosniff",
        });
        try {
          const sessionId = decodeURIComponent(messageMatch[1]!);
          const directCommand = parseDirectSkillCommand(body.message);
          if(body.animation_context!==undefined){
            await store.sendAnimationQuestion(sessionId,body.message,event=>streamEvent(response,event),body.animation_context,body.request_id,body.expected_version,body.retry_of_request_id,body.query_animation_request===true);
          }else if (directCommand) {
            // 用户在 Web 输入 /master 等命令时仍走 User API；文本绝不进入 Pi 消息历史。
            // 这是对按钮入口的等价快捷方式，不会把 Mastery Tool 暴露给 Agent。
            const state = await store.skillAction(
              sessionId,
              directCommand.action,
              directCommand.skillId,
            );
            const confirmation = directCommand.action === "master"
              ? `已通过用户入口确认：${directCommand.skillId} → MASTERED_BY_USER。`
              : directCommand.action === "reopen"
                ? `已重新打开 ${directCommand.skillId}，状态回到 PRACTICING。`
                : `${directCommand.skillId} 已进入 PRACTICING。`;
            streamEvent(response, { type: "assistant_delta", delta: confirmation });
            streamEvent(response, { type: "state", state });
            streamEvent(response, { type: "done" });
          } else {
            await store.sendMessage(
              sessionId,
              body.message,
              (event) => streamEvent(response, event),
              body.learner_reply,
              body.voice_input,
              body.request_id,
              body.expected_version,
              undefined,
              body.image_material_ids,
            );
          }
        } catch (error) {
          const failure = userFacingError(error);
          streamEvent(response, { type: "error", message: failure.message });
        }
        response.end();
        return;
      }

      const stopMatch = pathname.match(/^\/api\/web\/sessions\/([^/]+)\/stop$/);
      if (method === "POST" && stopMatch) {
        const body = await readJson(request);
        await store.stop(decodeURIComponent(stopMatch[1]!), body.run_id);
        json(response, 200, { status: "stopped" });
        return;
      }

      const recallSkipMatch = pathname.match(/^\/api\/web\/sessions\/([^/]+)\/active-recall\/skip$/);
      if (method === "POST" && recallSkipMatch) {
        json(response, 200, await store.skipActiveRecall(decodeURIComponent(recallSkipMatch[1]!)));
        return;
      }

      const skillMatch = pathname.match(
        /^\/api\/web\/sessions\/([^/]+)\/skills\/([^/]+)\/(master|reopen|practice)$/,
      );
      if (method === "POST" && skillMatch) {
        // ARCHITECTURE-CRITICAL：Mastery/Reopen 从 Browser 直达 User API。
        // 该请求不会进入消息历史，也不会让 Pi 获得毕业权。
        const state = await store.skillAction(
          decodeURIComponent(skillMatch[1]!),
          skillMatch[3] as "master" | "reopen" | "practice",
          decodeURIComponent(skillMatch[2]!),
        );
        json(response, 200, state);
        return;
      }

      // 知识卡片是跨 Conversation 的长期资产，不绑定 sessionId。
      // feedback/note 只从 Browser 用户入口直达 User API；Agent 只有建卡权。
      const cardFeedbackMatch = pathname.match(/^\/api\/web\/cards\/([^/]+)\/feedback$/);
      if (method === "POST" && cardFeedbackMatch) {
        const body = await readJson(request);
        if (typeof body.status !== "string") {
          throw new WebSessionError("status 为必填字符串。", 400);
        }
        json(
          response,
          200,
          await store.setCardFeedback(decodeURIComponent(cardFeedbackMatch[1]!), body.status),
        );
        return;
      }

      const cardNoteMatch = pathname.match(/^\/api\/web\/cards\/([^/]+)\/note$/);
      if (method === "PUT" && cardNoteMatch) {
        const body = await readJson(request);
        if (typeof body.note !== "string") {
          throw new WebSessionError("note 为必填字符串。", 400);
        }
        json(
          response,
          200,
          await store.setCardNote(decodeURIComponent(cardNoteMatch[1]!), body.note),
        );
        return;
      }
      if (method === "DELETE" && cardNoteMatch) {
        json(
          response,
          200,
          await store.clearCardNote(decodeURIComponent(cardNoteMatch[1]!)),
        );
        return;
      }

      // 用户删除/编辑卡片：Agent 不得删改，只能用户入口操作。
      const cardMatch = pathname.match(/^\/api\/web\/cards\/([^/]+)$/);
      if (method === "DELETE" && cardMatch) {
        await store.deleteCard(decodeURIComponent(cardMatch[1]!));
        response.writeHead(204);
        response.end();
        return;
      }
      if (method === "PUT" && cardMatch) {
        const body = await readJson(request);
        if (typeof body.question !== "string" || typeof body.answer !== "string") {
          throw new WebSessionError("question 与 answer 为必填字符串。", 400);
        }
        json(
          response,
          200,
          await store.updateCard(
            decodeURIComponent(cardMatch[1]!),
            body.question,
            body.answer,
          ),
        );
        return;
      }

      const goalMatch = pathname.match(/^\/api\/web\/sessions\/([^/]+)\/new-goal$/);
      if (method === "POST" && goalMatch) {
        const body = await readJson(request);
        json(
          response,
          200,
          await store.startGoalOnboarding(
            decodeURIComponent(goalMatch[1]!),
            body.replaceExisting === true,
          ),
        );
        return;
      }

      const abandonMatch = pathname.match(
        /^\/api\/web\/sessions\/([^/]+)\/tasks\/([^/]+)\/abandon$/,
      );
      if (method === "POST" && abandonMatch) {
        // 结束旧 Task 是独立的用户决定，不能由 New Goal 按钮或 Agent 隐式代办。
        json(
          response,
          200,
          await store.abandonTask(
            decodeURIComponent(abandonMatch[1]!),
            decodeURIComponent(abandonMatch[2]!),
          ),
        );
        return;
      }

      if (pathname.startsWith("/api/")) {
        json(response, 404, { detail: "API route not found" });
        return;
      }
      serveStatic(response, staticDir, pathname);
    } catch (error) {
      const failure = userFacingError(error);
      json(response, failure.status, { detail: failure.message, code: failure.code });
    }
  });

  server.on("close", () => {growth?.dispose();store.dispose();});
  return server;
}

async function main(): Promise<void> {
  const port = Number(process.env.WEB_PORT ?? 8787);
  const host = process.env.WEB_HOST ?? "127.0.0.1";
  const server = createGateway();
  server.listen(port, host, () => {
    console.error(`[web] Learn Anything Workspace: http://${host}:${port}`);
  });
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
