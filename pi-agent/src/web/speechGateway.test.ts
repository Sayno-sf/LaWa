import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createGateway } from "./gateway.js";
import { DEFAULT_SPEECH_SETTINGS, type SpeechSettings } from "./speechSettingsTypes.js";
import { SpeechServiceError, type SpeechServiceLike } from "./speechService.js";
import { WebSessionError, type WebSessionStore } from "./sessionStore.js";

async function gatewayFixture() {
  let settings: SpeechSettings = { ...DEFAULT_SPEECH_SETTINGS };
  const assertions: string[] = []; const transcriptions: Buffer[] = []; const syntheses: unknown[] = []; const messages: unknown[][] = [];
  let currentScope = "fixed-context-token"; let resolved = 0;
  const presentation = { id: "presentation-1", text: "Trusted saved teacher sentence.", language: "en" as const };
  const store = {
    dispose() {},
    async voiceScope(_id: string) { return currentScope; },
    async assertVoiceScope(id: string, scope: string) {
      assertions.push(`${id}:${scope}`);
      if (scope !== currentScope) throw new WebSessionError("录音上下文已变化。", 409);
    },
    async resolveSpeech(ref: { sourceSessionId: string; entryId: string; presentationId: string }) {
      resolved++;
      if (ref.presentationId !== "presentation-1") throw new WebSessionError("朗读内容不存在。", 404);
      return presentation;
    },
    async sendMessage(...args: unknown[]) { messages.push(args); (args[2] as (event: unknown) => void)({ type: "done" }); },
  } as unknown as WebSessionStore;
  const speech: SpeechServiceLike = {
    async getPublicSettings() { return { ...settings }; },
    async saveSettings(value) { settings = value as SpeechSettings; return { ...settings }; },
    async transcribe(audio) { transcriptions.push(Buffer.from(audio)); return { text: "Hello" }; },
    async synthesize(value) { syntheses.push(value); return { audio: Buffer.from("test-binary-audio"), contentType: "audio/wav" }; },
  };
  const server = createGateway({ store, speechService: speech }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  return { base, speech, assertions, transcriptions, syntheses, messages, get resolved() { return resolved; }, setScope(scope: string) { currentScope = scope; }, async close() { server.close(); await once(server, "close"); } };
}

test("speech gateway persists public settings through injected service and blocks foreign origins", async () => {
  const f = await gatewayFixture();
  try {
    const initial = await fetch(`${f.base}/api/web/speech-settings`); assert.equal(initial.status, 200); assert.deepEqual(await initial.json(), DEFAULT_SPEECH_SETTINGS);
    const updated = { ...DEFAULT_SPEECH_SETTINGS, enabled: true, profileId: "p" };
    const saved = await fetch(`${f.base}/api/web/speech-settings`, { method: "PUT", headers: { "Content-Type": "application/json", Origin: f.base }, body: JSON.stringify(updated) });
    assert.equal(saved.status, 200); assert.deepEqual(await saved.json(), updated);
    for (const headers of [{ Origin: "https://foreign.example" }, { "Sec-Fetch-Site": "cross-site" }] as Array<Record<string, string>>) {
      const rejected = await fetch(`${f.base}/api/web/speech-settings`, { headers }); assert.equal(rejected.status, 403);
    }
  } finally { await f.close(); }
});

test("transcription route requires immutable scope before and after ASR, bounds raw bytes and checks MIME", async () => {
  const f = await gatewayFixture();
  try {
    assert.deepEqual(await (await fetch(`${f.base}/api/web/sessions/s/voice/scope`)).json(), { scope: "fixed-context-token" });
    const url = `${f.base}/api/web/sessions/s/voice/transcriptions`;
    const missing = await fetch(url, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: Buffer.from("wav") }); assert.equal(missing.status, 409);
    assert.ok(f.assertions.includes("s:")); assert.equal(f.transcriptions.length, 0);
    const mime = await fetch(url, { method: "POST", headers: { "Content-Type": "audio/webm", "X-Voice-Scope": "fixed-context-token" }, body: Buffer.from("wav") }); assert.equal(mime.status, 415);
    const large = await fetch(url, { method: "POST", headers: { "Content-Type": "audio/wav", "X-Voice-Scope": "fixed-context-token" }, body: Buffer.alloc(4 * 1024 * 1024 + 1) }); assert.equal(large.status, 413);
    const result = await fetch(url, { method: "POST", headers: { "Content-Type": "audio/wav", "X-Voice-Scope": "fixed-context-token" }, body: Buffer.from("wav") }); assert.equal(result.status, 200); assert.deepEqual(await result.json(), { text: "Hello" });
    assert.equal(f.transcriptions.length, 1);
    f.speech.transcribe = async () => { f.setScope("new-context"); return { text: "late" }; };
    const stale = await fetch(url, { method: "POST", headers: { "Content-Type": "audio/wav", "X-Voice-Scope": "fixed-context-token" }, body: Buffer.from("wav") }); assert.equal(stale.status, 409); assert.ok(!(await stale.text()).includes("late"));
  } finally { await f.close(); }
});

test("synthesis resolves saved teacher text, accepts references only and returns binary without provider URLs", async () => {
  const f = await gatewayFixture();
  try {
    const reference = { sourceSessionId: "s", entryId: "entry-1", presentationId: "presentation-1" };
    const response = await fetch(`${f.base}/api/web/speech/synthesize`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reference) });
    assert.equal(response.status, 200); assert.equal(response.headers.get("Content-Type"), "audio/wav"); assert.equal(await response.text(), "test-binary-audio");
    assert.equal(f.resolved, 2); assert.equal((f.syntheses[0] as { text: string }).text, "Trusted saved teacher sentence.");
    const spoof = await fetch(`${f.base}/api/web/speech/synthesize`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...reference, text: "user-selected prompt" }) }); assert.equal(spoof.status, 400); assert.equal(f.syntheses.length, 1);
    const missing = await fetch(`${f.base}/api/web/speech/synthesize`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...reference, presentationId: "missing" }) }); assert.equal(missing.status, 404);
  } finally { await f.close(); }
});

test("gateway forwards top-level and per-answer voice metadata through existing message channel", async () => {
  const f = await gatewayFixture();
  try {
    const voice_input = { kind: "speech_transcription", edited: true, scope: "fixed-context-token" };
    const learner_reply = { answers: [{ question_id: "q", voice_input }] };
    const response = await fetch(`${f.base}/api/web/sessions/s/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "Hello", voice_input, learner_reply }) });
    assert.equal(response.status, 200); await response.text();
    assert.deepEqual(f.messages[0]?.[4], voice_input); assert.deepEqual(f.messages[0]?.[3], learner_reply);
    const crossOrigin = await fetch(`${f.base}/api/web/sessions/s/messages`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://foreign.example" }, body: JSON.stringify({ message: "Hello", learner_reply }) }); assert.equal(crossOrigin.status, 403); assert.equal(f.messages.length, 1);
  } finally { await f.close(); }
});

test("closing browser request aborts in-flight synthesis", async () => {
  const f = await gatewayFixture(); let started!: () => void; let cancelled!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; }); const cancel = new Promise<void>(resolve => { cancelled = resolve; });
  f.speech.synthesize = async (_input, options) => {
    started();
    return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => { cancelled(); reject(new SpeechServiceError("SPEECH_CANCELLED", "语音请求已取消。", 499)); }, { once: true }));
  };
  try {
    const controller = new AbortController();
    const request = fetch(`${f.base}/api/web/speech/synthesize`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceSessionId: "s", entryId: "e", presentationId: "presentation-1" }), signal: controller.signal });
    await start; controller.abort(); await assert.rejects(request); await cancel;
  } finally { await f.close(); }
});
