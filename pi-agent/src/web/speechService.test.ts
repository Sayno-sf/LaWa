import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_SPEECH_SETTINGS } from "./speechSettingsTypes.js";
import { MAX_VOICE_AUDIO_BYTES, SpeechService, SpeechServiceError, validateVoiceWav } from "./speechService.js";
import type { SpeechProviderCredentials } from "./providerSettings.js";

function wav(seconds = 0.1, rate = 16000): Buffer {
  const samples = Math.round(seconds * rate);
  const result = Buffer.alloc(44 + samples * 2);
  result.write("RIFF", 0); result.writeUInt32LE(result.length - 8, 4); result.write("WAVEfmt ", 8); result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22); result.writeUInt32LE(rate, 24); result.writeUInt32LE(rate * 2, 28); result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write("data", 36); result.writeUInt32LE(samples * 2, 40);
  return result;
}
async function fixture(mock: typeof fetch, timeoutMs?: number, streamSynthesis=false) {
  const directory = await mkdtemp(join(tmpdir(), "lawa-speech-"));
  const credential: SpeechProviderCredentials = { profileId: "profile-one", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "fake-private-test-key", revision: "one" };
  const references: string[] = [];
  const credentials = { async getSpeechCredentials(id: string) { references.push(id); assert.equal(id, credential.profileId); return { ...credential }; } };
  const settingsPath = join(directory, "speech-settings.json");
  const service = new SpeechService({ settingsPath, credentials, fetch: mock, timeoutMs, streamSynthesis });
  await service.saveSettings({ ...DEFAULT_SPEECH_SETTINGS, enabled: true, profileId: credential.profileId });
  return { service, directory, settingsPath, credential, references, credentials };
}
const impossibleFetch = (async () => { throw new Error("network must not run"); }) as typeof fetch;
const rejectsCode = (code: string) => (error: unknown) => error instanceof SpeechServiceError && error.code === code;

test("fresh speech settings distinguish fallback values from a saved configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lawa-speech-first-save-"));
  const settingsPath = join(directory, "speech-settings.json");
  const options = { settingsPath, credentials: { async getSpeechCredentials(): Promise<never> { throw new Error("Unexpected credential lookup"); } }, fetch: impossibleFetch };
  try {
    const service = new SpeechService(options);
    assert.deepEqual(await service.getPublicSettings(), { ...DEFAULT_SPEECH_SETTINGS, saved: false });
    await assert.rejects(readFile(settingsPath), { code: "ENOENT" });
    await assert.rejects(service.saveSettings({ ...DEFAULT_SPEECH_SETTINGS, enabled: true }), rejectsCode("MISSING_SPEECH_PROFILE"));
    assert.equal((await service.getPublicSettings()).saved, false);
    const existing = { ...DEFAULT_SPEECH_SETTINGS, region: "singapore", voice: "Serena" };
    assert.deepEqual(await service.saveSettings(existing), existing);
    assert.deepEqual(await new SpeechService(options).getPublicSettings(), existing);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), existing);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("voice accepts 120-second mono PCM WAV and rejects format, duration and size before provider", () => {
  assert.equal(validateVoiceWav(wav(120)).length, 3_840_044);
  assert.throws(() => validateVoiceWav(wav(120.001)), rejectsCode("VOICE_AUDIO_TOO_LONG"));
  assert.throws(() => validateVoiceWav(wav(0.1, 24000)), rejectsCode("INVALID_VOICE_AUDIO"));
  assert.throws(() => validateVoiceWav(Buffer.from("not wav")), rejectsCode("INVALID_VOICE_AUDIO"));
  assert.throws(() => validateVoiceWav(Buffer.alloc(MAX_VOICE_AUDIO_BYTES + 1)), rejectsCode("VOICE_AUDIO_TOO_LARGE"));
  const compressed = wav(); compressed.writeUInt16LE(3, 20);
  assert.throws(() => validateVoiceWav(compressed), rejectsCode("INVALID_VOICE_AUDIO"));
  const truncated = wav().subarray(0, 45);
  assert.throws(() => validateVoiceWav(truncated), rejectsCode("INVALID_VOICE_AUDIO"));
});

test("speech settings persist only explicit profile reference and reject secrets, nonofficial host and wrong region", async () => {
  const f = await fixture(impossibleFetch);
  try {
    const publicSettings = await f.service.getPublicSettings();
    assert.deepEqual(publicSettings, { ...DEFAULT_SPEECH_SETTINGS, enabled: true, profileId: "profile-one" });
    assert.ok(!(await readFile(f.settingsPath, "utf8")).includes(f.credential.apiKey));
    assert.ok(!JSON.stringify(publicSettings).includes(f.credential.apiKey));
    await assert.rejects(f.service.saveSettings({ ...publicSettings, apiKey: "not-allowed" }), rejectsCode("INVALID_SPEECH_SETTINGS"));
    await assert.rejects(f.service.saveSettings({ ...publicSettings, region: "singapore" }), rejectsCode("SPEECH_REGION_MISMATCH"));
    for (const url of ["https://evil.example/compatible-mode/v1", "https://dashscope.aliyuncs.com.evil.example/compatible-mode/v1", "http://dashscope.aliyuncs.com/compatible-mode/v1", "https://dashscope.aliyuncs.com/compatible-mode/v1?secret=x"]) {
      f.credential.baseUrl = url;
      await assert.rejects(f.service.saveSettings(publicSettings), rejectsCode("INVALID_SPEECH_PROFILE"));
    }
    await f.service.saveSettings({ ...publicSettings, enabled: false, profileId: "deleted-profile" });
    const restarted = new SpeechService({ settingsPath: f.settingsPath, credentials: f.credentials, fetch: impossibleFetch });
    assert.equal((await restarted.getPublicSettings()).enabled, false);
    await assert.rejects(restarted.transcribe(wav()), rejectsCode("SPEECH_DISABLED"));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("ASR uses Base64 WAV chat completions, sanitizes failures and does not impose one language", async () => {
  let last: { url?: string; body?: Record<string, unknown>; headers?: Headers; redirect?: string } = {};
  let mode = "ok";
  const f = await fixture((async (url, init) => {
    last = { url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers), redirect: init?.redirect };
    if (mode === "auth") return new Response("fake-private-test-key upstream details", { status: 401 });
    if (mode === "bad") return Response.json({ output: { text: "wrong interface" } });
    if (mode === "empty") return Response.json({ choices: [{ message: { content: " " } }] });
    return Response.json({ choices: [{ message: { content: " Hello, 我想练习 English. " } }] });
  }) as typeof fetch);
  try {
    assert.deepEqual(await f.service.transcribe(wav()), { text: "Hello, 我想练习 English." });
    assert.equal(last.url, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    assert.equal(last.headers?.get("authorization"), "Bearer fake-private-test-key");
    assert.equal(last.redirect, "error");
    assert.equal(last.body?.model, "qwen3-asr-flash");
    assert.deepEqual(last.body?.asr_options, { enable_itn: false });
    const messages = last.body?.messages as Array<{ content: Array<{ input_audio: { data: string } }> }>;
    assert.ok(messages[0]!.content[0]!.input_audio.data.startsWith("data:audio/wav;base64,"));
    mode = "auth";
    await assert.rejects(f.service.transcribe(wav()), error => rejectsCode("SPEECH_AUTH_FAILED")(error) && !String(error).includes("fake-private"));
    mode = "bad"; await assert.rejects(f.service.transcribe(wav()), rejectsCode("INVALID_SPEECH_RESPONSE"));
    mode = "empty"; await assert.rejects(f.service.transcribe(wav()), rejectsCode("NO_SPEECH_DETECTED"));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("TTS uses native API, checks official download URL, returns WAV and replays cache until credential revision changes", async () => {
  const audio = wav(0.1, 24000); let syntheses = 0; let downloads = 0; let payload: unknown;
  const f = await fixture((async (url, init) => {
    if (String(url).includes("/services/aigc/multimodal-generation/generation")) {
      syntheses++; payload = JSON.parse(String(init?.body));
      return Response.json({ output: { audio: { url: "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/fake.wav" } } });
    }
    downloads++; assert.equal(init?.redirect, "error"); assert.equal(new Headers(init?.headers).get("authorization"), null);
    return new Response(new Uint8Array(audio), { headers: { "Content-Type": "audio/wav" } });
  }) as typeof fetch);
  try {
    const text = { text: "Hello world.", language: "en" as const };
    const first = await f.service.synthesize(text); assert.deepEqual(first.audio, audio);
    assert.equal(first.contentType, "audio/wav");
    assert.deepEqual(payload, { model: "qwen3-tts-flash", input: { text: "Hello world.", voice: "Cherry", language_type: "English" } });
    first.audio.fill(0); // 调用者不能通过修改 Buffer 破坏缓存。
    assert.deepEqual((await f.service.synthesize(text)).audio, audio);
    assert.equal(syntheses, 1); assert.equal(downloads, 1);
    await f.service.synthesize({ ...text, language: "auto" }); assert.equal(syntheses, 2);
    f.credential.revision = "key-rotated"; await f.service.synthesize(text); assert.equal(syntheses, 3);
    await f.service.saveSettings({ ...(await f.service.getPublicSettings()), voice: "Serena" });
    await f.service.synthesize(text); assert.equal(syntheses, 4);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("TTS rejects arbitrary URLs, oversized upstream bodies, unsafe model and untrusted audio", async () => {
  let mode = "url"; let calls = 0;
  const f = await fixture((async () => {
    calls++;
    if (mode === "large") return new Response("", { headers: { "content-length": String(20 * 1024 * 1024) } });
    if (mode === "audio") return Response.json({ output: { audio: { data: Buffer.from("x").toString("base64") } } });
    return Response.json({ output: { audio: { url: "https://evil.example/secret.wav" } } });
  }) as typeof fetch);
  try {
    const input = { text: "hello", language: "en" as const };
    await assert.rejects(f.service.synthesize(input), rejectsCode("INVALID_SPEECH_AUDIO_URL")); assert.equal(calls, 1);
    mode = "large"; await assert.rejects(f.service.synthesize(input), rejectsCode("SPEECH_RESPONSE_TOO_LARGE"));
    mode = "audio"; await assert.rejects(f.service.synthesize(input), rejectsCode("INVALID_SPEECH_RESPONSE"));
    await assert.rejects(f.service.saveSettings({ ...(await f.service.getPublicSettings()), asrModel: "qwen3-asr-flash-realtime" }), rejectsCode("INVALID_SPEECH_MODEL"));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("official HTTP audio URLs are fetched over HTTPS only, with credentials and explicit ports rejected", async () => {
  let returnedUrl = "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/fake.wav?Expires=123&Signature=fake";
  const downloads: string[] = [];
  const f = await fixture((async (url, init) => {
    if (String(url).includes("/services/")) return Response.json({ output: { audio: { url: returnedUrl } } });
    downloads.push(String(url)); assert.equal(init?.redirect, "error");
    return new Response(new Uint8Array(wav(0.1, 24000)));
  }) as typeof fetch);
  try {
    const result = await f.service.synthesize({ text: "Official return URL", language: "en" });
    assert.equal(result.contentType, "audio/wav");
    assert.deepEqual(downloads, ["https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/fake.wav?Expires=123&Signature=fake"]);
    for (const url of ["http://evil.example/fake.wav", "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com:80/fake.wav", "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com:443/fake.wav", "http://user:pass@dashscope-result-bj.oss-cn-beijing.aliyuncs.com/fake.wav"]) {
      returnedUrl = url;
      await assert.rejects(f.service.synthesize({ text: url, language: "en" }), rejectsCode("INVALID_SPEECH_AUDIO_URL"));
    }
    assert.equal(downloads.length, 1);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("TTS closes official streaming WAV length placeholders and rejects actual truncation or invalid PCM frames", async () => {
  let returned = wav(0.1, 24000);
  const original = Buffer.from(returned);
  returned.writeUInt32LE(0x7fffffff - 100, 40); returned.writeUInt32LE(0x7fffffff - 64, 4);
  const f = await fixture((async url => {
    if (String(url).includes("/services/")) return Response.json({ output: { audio: { url: "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/fake.wav" } } });
    return new Response(new Uint8Array(returned));
  }) as typeof fetch);
  try {
    const result = await f.service.synthesize({ text: "Streaming header sample", language: "en" });
    assert.deepEqual(result.audio, original);
    returned = Buffer.from(original); returned.writeUInt32LE(original.length, 40);
    await assert.rejects(f.service.synthesize({ text: "Truncated small length", language: "en" }), rejectsCode("INVALID_SPEECH_RESPONSE"));
    returned = Buffer.from(original.subarray(0, original.length - 1)); returned.writeUInt32LE(0x7fffffff - 100, 40);
    await assert.rejects(f.service.synthesize({ text: "Incomplete PCM frame", language: "en" }), rejectsCode("INVALID_SPEECH_RESPONSE"));
    returned = Buffer.from(original); returned.writeUInt16LE(3, 20);
    await assert.rejects(f.service.synthesize({ text: "Wrong WAV encoding", language: "en" }), rejectsCode("INVALID_SPEECH_RESPONSE"));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("TTS accepts SSE PCM chunks without audio URL and wraps the 24 kHz stream as WAV", async () => {
  const pcm = Buffer.from([1, 0, 2, 0]);
  const f = await fixture((async () => new Response(`data: ${JSON.stringify({ output: { audio: { data: pcm.toString("base64") } } })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } })) as typeof fetch);
  try {
    const result = await f.service.synthesize({ text: "Hi", language: "en" });
    assert.equal(result.audio.readUInt32LE(24), 24000); assert.deepEqual(result.audio.subarray(44), pcm);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("TTS SSE uses complete PCM instead of redownloading final URL and rejects incomplete streams",async()=>{
  let complete=true;let calls=0;
  const f=await fixture((async (_url,init)=>{
    calls++;assert.equal(new Headers(init?.headers).get('X-DashScope-SSE'),'enable');
    const chunks=[{output:{audio:{data:Buffer.from([1,0,2,0]).toString('base64')}}}];
    const tail=complete?'data: '+JSON.stringify({output:{finish_reason:'stop',audio:{url:'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/fake.wav'}}})+'\n\n':'';
    return new Response(chunks.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+tail,{headers:{'Content-Type':'text/event-stream'}});
  }) as typeof fetch,undefined,true);
  try {
    assert.deepEqual((await f.service.synthesize({text:'one',language:'en'})).audio.subarray(44),Buffer.from([1,0,2,0]));
    assert.equal(calls,1);
    complete=false;
    await assert.rejects(f.service.synthesize({text:'two',language:'en'}),rejectsCode('INCOMPLETE_SPEECH_RESPONSE'));
  }finally {await rm(f.directory,{recursive:true,force:true});}
});

test("TTS LRU evicts old audio when the 32 MiB limit is reached", async () => {
  const audio = wav(150, 24000); let calls = 0;
  const f = await fixture((async url => {
    if (String(url).includes("/services/")) {
      calls++; return Response.json({ output: { audio: { url: "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/fake.wav" } } });
    }
    return new Response(new Uint8Array(audio));
  }) as typeof fetch);
  try {
    for (const text of ["one", "two", "three", "four", "five"]) await f.service.synthesize({ text, language: "en" });
    assert.equal(calls, 5);
    await f.service.synthesize({ text: "five", language: "en" }); assert.equal(calls, 5);
    await f.service.synthesize({ text: "one", language: "en" }); assert.equal(calls, 6);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("upstream timeout and user cancellation abort ASR and TTS without returning provider details", async () => {
  const pendingFetch = (async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  })) as typeof fetch;
  const f = await fixture(pendingFetch, 10);
  try {
    await assert.rejects(f.service.transcribe(wav()), rejectsCode("SPEECH_TIMEOUT"));
    const controller = new AbortController();
    const pending = f.service.synthesize({ text: "Hi", language: "en" }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 2);
    await assert.rejects(pending, rejectsCode("SPEECH_CANCELLED"));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
