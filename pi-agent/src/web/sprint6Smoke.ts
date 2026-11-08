import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Message } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

import type { LearningAgentEvent, LearningAgentSession } from "../agentSession.js";
import { WebSessionStore, type WebSessionStoreOptions } from "./sessionStore.js";

const API_PORT = 8126;
const API_URL = `http://127.0.0.1:${API_PORT}`;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function startApi(): ChildProcess {
  return spawn(
    process.env.PYTHON ?? "python",
    ["-m", "uvicorn", "app.api.main:app", "--host", "127.0.0.1", "--port", String(API_PORT)],
    {
      cwd: root,
      env: {
        ...process.env,
        LEARNING_BOOTSTRAP: "gradient-demo",
        LEARNING_STATE_PATH: ":memory:",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
}

async function waitForApi(api: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (api.exitCode !== null) throw new Error(`Learning API exited: ${api.exitCode}`);
    try {
      if ((await fetch(`${API_URL}/api/learning/library`)).ok) return;
    } catch {
      // Uvicorn is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Timed out waiting for Sprint 6 Learning API");
}

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const createAgent = async (
  _context: unknown,
  _planning: unknown,
  emit: (event: LearningAgentEvent) => void,
  sessionManager: SessionManager,
): Promise<LearningAgentSession> => ({
  prompt: async (text) => {
    sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `验收回复：${text}` }],
      api: "openai-completions",
      provider: "sprint6-faux",
      model: "faux-model",
      usage: zeroUsage,
      stopReason: "stop",
      timestamp: Date.now(),
    } as Message);
    emit({ type: "assistant_delta", delta: `验收回复：${text}` });
  },
  abort: async () => undefined,
  dispose: () => undefined,
});

async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "lawa-sprint6-"));
  const sessions = join(directory, "sessions");
  const api = startApi();
  try {
    await waitForApi(api);
    const store = new WebSessionStore({
      apiBaseUrl: API_URL,
      conversationDir: sessions,
      createAgent: createAgent as NonNullable<WebSessionStoreOptions["createAgent"]>,
    });
    const first = await store.create("new");
    await store.sendMessage(first.sessionId, "第一段学习", () => undefined);
    await store.renameConversation(first.sessionId, "梯度复习");

    const second = await store.create("new");
    await store.sendMessage(second.sessionId, "第二段学习", () => undefined);
    const catalog = await store.listConversations();
    assert.equal(catalog.sessions.length, 2);
    assert.equal(catalog.activeSessionId, second.sessionId);

    const restored = await store.activateConversation(first.sessionId);
    assert.deepEqual(restored.messages.map((message) => message.content), [
      "第一段学习",
      "验收回复：第一段学习",
    ]);
    const library = await store.learningLibrary();
    assert.equal(library.projects[0]?.status, "CURRENT");
    assert.ok(library.projects[0]?.evidence.length);

    const replacement = await store.deleteConversation(first.sessionId);
    assert.equal(replacement.sessionId, second.sessionId);
    assert.equal(existsSync(join(sessions, ".trash")), true);
    assert.equal(readdirSync(join(sessions, ".trash")).length, 1);
    store.dispose();
    console.log("Sprint 6 smoke passed: isolated new sessions, catalog lifecycle, restart-safe messages, trash, and Kernel learning library.");
  } finally {
    api.kill();
    if (api.exitCode === null) await once(api, "exit");
    rmSync(directory, { recursive: true, force: true });
  }
}

await main();
