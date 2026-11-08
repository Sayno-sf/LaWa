import {spawn, spawnSync} from "node:child_process";
import {once} from "node:events";
import {mkdirSync, readFileSync, writeFileSync, mkdtempSync, symlinkSync, existsSync} from "node:fs";
import {createServer} from "node:net";
import {resolve, join, dirname, basename} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {createGateway} from "../src/web/gateway.js";
import {WebSessionStore, type WebSessionStoreOptions} from "../src/web/sessionStore.js";
import {stopSmokeProcess} from "../src/smokeProcess.js";

export async function startGrowthPreview(port = 0, serveUi = true, resumeDirectory?: string,
  syntheticAgent?: WebSessionStoreOptions["createAgent"],
  services:Pick<WebSessionStoreOptions,"providerSettings"|"createAssistantAgent"|"lessonArt"> = {}) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const qa = resolve(root, "data/qa/growth-atlas"); mkdirSync(qa, {recursive: true});
  const directory = resumeDirectory ? resolve(resumeDirectory) : mkdtempSync(join(qa, "preview-")), state = join(directory, "state.json");
  // 仅恢复本工作树已生成的合成预览；不能借预览入口加载个人账本。
  if (resumeDirectory && (dirname(directory) !== qa || !basename(directory).startsWith("preview-") || !existsSync(state)))
    throw new Error("Only an existing synthetic preview directory can be resumed");
  const python = resolve(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  if (!resumeDirectory) {
    const seed = spawnSync(python, ["-X", "utf8", "scripts/growth_preview_seed.py", state], {cwd: root, windowsHide: true, encoding: "utf8"});
    if (seed.error) throw seed.error;
    if (seed.status !== 0) throw new Error(seed.stderr || "Preview seed failed");
  }
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const apiPort = (reservation.address() as {port: number}).port; reservation.close(); await once(reservation, "close");
  const apiBase = `http://127.0.0.1:${apiPort}`;
  const child = spawn(python, ["-X", "utf8", "-m", "uvicorn", "app.api.main:app", "--host", "127.0.0.1", "--port", String(apiPort)], {
    cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: {...process.env,
      LEARNING_STATE_PATH: state, LEARNING_BOOTSTRAP: "empty", LEARNING_MATERIALS_DIR: join(directory, "materials")},
  });
  let error = ""; child.stderr.on("data", chunk => {error = (error + String(chunk)).slice(-5000);});
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(error);
      try {if ((await fetch(apiBase + "/api/learning/growth", {signal: AbortSignal.timeout(1500)})).ok) {ready = true; break;}} catch {}
      await new Promise(done => setTimeout(done, 100));
    }
    if (!ready) throw new Error("Preview Kernel did not start");
    const staticDir = mkdtempSync(join(directory, "web-"));
    const built = process.env.GROWTH_STATIC_DIR ?? resolve(root, "pi-agent/web-dist");
    if (serveUi) symlinkSync(resolve(built, "assets"), join(staticDir, "assets"), "junction");
    const html = serveUi ? readFileSync(resolve(built, "index.html"), "utf8")
      .replace("看见知识的方向，也看见自己的成长。", "示例预览 · 所有记录和分数均为合成数据，与日常课堂隔离。")
      : "<p>API test fixture</p>";
    writeFileSync(join(staticDir, "index.html"), html);
    process.env.LEARNING_API_BASE_URL = apiBase;
    process.env.WEB_SESSION_DIR = join(directory, "sessions");
    process.env.STUDY_TIME_PATH = join(directory, "study-time.json");
    process.env.PROVIDER_SETTINGS_PATH = join(directory, "provider-settings.json");
    process.env.PROVIDER_SECRETS_PATH = join(directory, "provider-secrets.json");
    const store = new WebSessionStore({...services,apiBaseUrl: apiBase, conversationDir: join(directory, "sessions"), conversationCwd: root,
      // 默认图谱预览不调用模型。显式的课堂验收可以注入隔离的教师与只读模型配置。
      createAgent: syntheticAgent ?? (async () => {throw new Error("示例预览不调用教学模型。正式功能使用你的课堂模型配置。");})});
    const gateway = createGateway({store, staticDir}); gateway.listen(port, "127.0.0.1"); await once(gateway, "listening");
    const base = `http://127.0.0.1:${(gateway.address() as {port: number}).port}`;
    return {base, apiBase, directory, stop: async () => {gateway.closeAllConnections(); await new Promise<void>(done => gateway.close(() => done())); await stopSmokeProcess(child);}};
  } catch (cause) {await stopSmokeProcess(child); throw cause;}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const preview = await startGrowthPreview(Number(process.env.GROWTH_PREVIEW_PORT ?? "8791"));
  console.log(JSON.stringify({preview: preview.base, kernel: preview.apiBase, data: preview.directory, synthetic: true}));
  const stop = () => {void preview.stop().then(() => process.exit());}; process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
