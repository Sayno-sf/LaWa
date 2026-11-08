import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { VoiceInput, pcmWav } from "./src/voiceInput.js";
import { LearnerQuestionView } from "./src/learnerQuestionView.js";

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error("UI condition did not settle");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const dom = new JSDOM('<textarea id="input"></textarea><button id="mic"></button><p id="status"></p>', { url: "http://localhost" });
  const { window } = dom;
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
  Object.defineProperty(window, "isSecureContext", { value: true });
  for (const [name, value] of Object.entries({ window, document: window.document, navigator: window.navigator, Event: window.Event })) Object.defineProperty(globalThis, name, { value, configurable: true });
  let stopped = 0, closed = 0;
  const track = { stop: () => { stopped++; }, addEventListener: () => undefined };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  let onAudio: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null = null;
  class FakeContext {
    sampleRate = 48_000;
    resume = async () => undefined;
    close = async () => { closed++; };
    createMediaStreamSource = () => ({ connect: () => undefined, disconnect: () => undefined });
    createGain = () => ({ gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined });
    createScriptProcessor = () => ({ set onaudioprocess(value: typeof onAudio) { onAudio = value; }, connect: () => undefined, disconnect: () => undefined });
  }
  Object.defineProperty(window, "AudioContext", { value: FakeContext });
  Object.defineProperty(window.navigator, "mediaDevices", { value: { getUserMedia: async () => stream }, configurable: true });
  const input = window.document.querySelector<HTMLTextAreaElement>("#input")!;
  const button = window.document.querySelector<HTMLButtonElement>("#mic")!;
  const status = window.document.querySelector<HTMLElement>("#status")!;
  let sessionId = "session-original";
  const errors: string[] = [];
  const voice = new VoiceInput({ input, button, status, canStart: () => true, isConfigured: () => true, onConfigure: () => undefined, sessionId: () => sessionId, questionKey: () => "task-original", beforeStart: () => undefined, onState: () => undefined, onError: message => { errors.push(message); } });
  return {
    dom, input, button, voice, errors, stream, setSession: (value: string) => { sessionId = value; },
    stopped: () => stopped, closed: () => closed,
    samples: () => { for (let i = 0; i < 3; i++) onAudio?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.1) } }); },
  };
}

test("PCM output is 16 kHz mono 16-bit WAV with a 120-second bound", async () => {
  const blob = pcmWav(new Float32Array([1, 1, 1, -1, -1, -1]), 48_000);
  const view = new DataView(await blob.arrayBuffer());
  assert.equal(blob.type, "audio/wav"); assert.equal(blob.size, 48);
  assert.equal(view.getUint16(22, true), 1); assert.equal(view.getUint32(24, true), 16_000); assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getInt16(44, true), 32767); assert.equal(view.getInt16(46, true), -32768);
  assert.equal(pcmWav(new Float32Array(16_000 * 121), 16_000).size, 44 + 16_000 * 120 * 2);
});

test("cancel during microphone permission releases a late stream and creates no recorder", async () => {
  const setup = fixture(); const permission = deferred<MediaStream>();
  Object.defineProperty(setup.dom.window.navigator, "mediaDevices", { value: { getUserMedia: () => permission.promise }, configurable: true });
  globalThis.fetch = async () => Response.json({ scope: "scope-at-start" });
  try {
    setup.button.click(); await new Promise(resolve => setTimeout(resolve, 10));
    setup.voice.cancel(); permission.resolve(setup.stream);
    await waitFor(() => setup.stopped() === 1);
    assert.equal(setup.voice.busy, false); assert.equal(setup.closed(), 1); assert.deepEqual(setup.errors, []);
  } finally { setup.voice.cancel(); setup.dom.window.close(); }
});

test("transcription uses the start token and preserves selected insertion plus voice edit attribution", async () => {
  const setup = fixture(); let scopes = 0, header: string | null = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/scope")) { scopes++; return Response.json({ scope: "scope-at-start" }); }
    header = new Headers(init?.headers).get("X-Voice-Scope");
    assert.equal((init?.body as Blob).type, "audio/wav");
    return Response.json({ text: "spoken answer" });
  };
  try {
    setup.input.value = "prefix old suffix"; setup.input.setSelectionRange(7, 10);
    setup.button.click(); await waitFor(() => setup.voice.recording); setup.samples(); setup.button.click();
    await waitFor(() => !setup.voice.busy);
    assert.equal(scopes, 1); assert.equal(header, "scope-at-start"); assert.equal(setup.input.value, "prefix spoken answer suffix");
    assert.deepEqual(setup.voice.metadata(), { source: "voice", transcriptEdited: false });
    setup.input.value = "prefix edited answer suffix";
    assert.deepEqual(setup.voice.metadata(), { source: "voice", transcriptEdited: true });
    assert.equal(setup.stopped(), 1);
  } finally { setup.voice.cancel(); setup.dom.window.close(); }
});

test("a late transcription after navigation cannot write into a new session draft", async () => {
  const setup = fixture(); const transcription = deferred<Response>(); let posted = false;
  globalThis.fetch = async url => String(url).endsWith("/scope") ? Response.json({ scope: "scope-at-start" }) : (posted = true, transcription.promise);
  try {
    setup.input.value = "original draft"; setup.button.click(); await waitFor(() => setup.voice.recording); setup.samples(); setup.button.click();
    await waitFor(() => posted);
    setup.voice.cancel(); setup.setSession("session-new"); setup.input.value = "new draft";
    transcription.resolve(Response.json({ text: "late voice" })); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(setup.input.value, "new draft"); assert.equal(setup.voice.metadata(), undefined); assert.deepEqual(setup.errors, []);
  } finally { setup.voice.cancel(); setup.dom.window.close(); }
});

test("each question retains voice metadata until the final batched reply", () => {
  const setup = fixture();
  try {
    const view = new LearnerQuestionView(() => undefined, () => undefined);
    view.render({ id: "request", purpose: "BACKGROUND", session_id: "session", goal_id: null, task_id: null, skill_id: null, questions: ["first", "second"].map(id => ({ id, prompt: id, selection: "single", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] })) }, false);
    assert.equal(view.collect("spoken first", { source: "voice", transcriptEdited: false }), undefined);
    const reply = view.collect("typed second")!;
    assert.deepEqual(reply.answers[0]!.voice_input, { source: "voice", transcriptEdited: false });
    assert.equal(reply.answers[1]!.voice_input, undefined);
  } finally { setup.voice.cancel(); setup.dom.window.close(); }
});
