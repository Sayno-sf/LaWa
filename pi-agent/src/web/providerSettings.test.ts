import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";

import {
  ProviderSettingsError,
  ProviderSettingsService,
} from "./providerSettings.js";

class FakeRuntime {
  key: string | undefined;
  provider = "";
  modelId = "";
  baseUrl = "";
  reasoning = false;
  maxTokens = 0;
  contextWindow = 0;
  input: Array<"text"|"image"> = ["text"];
  supportsDeveloperRole: boolean | undefined;
  lastCompletionHadSystemPrompt = false;
  lastCompletionReasoning: string | undefined;
  failure: unknown;

  registerProvider(provider: string, config: {
    baseUrl: string;
    models: Array<{
      id: string;
      reasoning: boolean;
      maxTokens: number;
      contextWindow: number;
      input?: Array<"text"|"image">;
      compat?: { supportsDeveloperRole?: boolean };
    }>;
  }): void {
    this.provider = provider;
    this.modelId = config.models[0]!.id;
    this.baseUrl = config.baseUrl;
    this.reasoning = config.models[0]!.reasoning;
    this.maxTokens = config.models[0]!.maxTokens;
    this.contextWindow = config.models[0]!.contextWindow;
    this.input = config.models[0]!.input ?? ["text"];
    this.supportsDeveloperRole = config.models[0]!.compat?.supportsDeveloperRole;
  }

  getModel(provider: string, model: string): Model<Api> | undefined {
    if (provider !== this.provider || model !== this.modelId) return undefined;
    return {
      id: model,
      name: model,
      api: "openai-completions",
      provider,
      baseUrl: this.baseUrl,
      reasoning: this.reasoning,
      compat: { supportsDeveloperRole: this.supportsDeveloperRole },
      input: this.input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: this.contextWindow,
      maxTokens: this.maxTokens,
    };
  }

  async getAvailable(): Promise<readonly Model<Api>[]> {
    return [];
  }

  hasConfiguredAuth(): boolean {
    return Boolean(this.key);
  }

  async getAuth(): Promise<{ auth: { apiKey?: string } } | undefined> {
    return this.key ? { auth: { apiKey: this.key } } : undefined;
  }

  async setRuntimeApiKey(_provider: string, key: string): Promise<void> {
    this.key = key;
  }

  async completeSimple(
    _model: Model<Api>,
    context: { systemPrompt?: string },
    options: { reasoning?: string },
  ): Promise<{ stopReason: string }> {
    this.lastCompletionReasoning = options.reasoning;
    this.lastCompletionHadSystemPrompt = Boolean(context.systemPrompt);
    if (this.failure) throw this.failure;
    return { stopReason: "stop" };
  }
}

test("compatible profile preserves SDK-declared vision without guessing unknown models", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-sdk-vision-"));
  const runtime = new FakeRuntime();
  runtime.provider = "catalog-provider"; runtime.modelId = "catalog-vision"; runtime.input = ["text", "image"];
  runtime.maxTokens = 8192; runtime.contextWindow = 256000; runtime.baseUrl = "https://provider.example/v1";
  try {
    const service = new ProviderSettingsService({settingsPath: join(directory, "settings.json"), secretsPath: join(directory, "secrets.json"), runtimeFactory: async () => runtime});
    const saved = await service.saveAndUse({provider: runtime.provider, model: runtime.modelId, baseUrl: runtime.baseUrl, apiKey: "fake-only-key"});
    assert.deepEqual(saved.model.input, ["text", "image"]);
    const unknown = await service.saveAndUse({provider: runtime.provider, model: "unknown-text-model", baseUrl: runtime.baseUrl, apiKey: "fake-only-key"});
    assert.deepEqual(unknown.model.input, ["text"]);
  } finally {rmSync(directory, {recursive: true, force: true});}
});

function fixture(initialKey?: string) {
  const directory = mkdtempSync(join(tmpdir(), "lawa-provider-settings-"));
  const runtimes: FakeRuntime[] = [];
  const runtimeFailure: { value: unknown } = { value: undefined };
  const createService = () => new ProviderSettingsService({
    settingsPath: join(directory, "provider-settings.json"),
    secretsPath: join(directory, "provider-secrets.json"),
    runtimeFactory: async () => {
      const runtime = new FakeRuntime();
      runtime.key = initialKey;
      runtime.failure = runtimeFailure.value;
      runtimes.push(runtime);
      return runtime;
    },
    now: () => new Date("2026-09-20T08:00:00.000Z"),
  });
  return { directory, runtimes, runtimeFailure, createService };
}

test("speech credential lookup keeps saved profiles independent and never inherits the active runtime key", async () => {
  const f = fixture("fake-inherited-runtime-key");
  try {
    const service = f.createService();
    const saved = await service.saveAndUse({ provider: "dashscope", model: "first-chat", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "fake-first-profile-key" });
    const firstId = saved.settings.activeProfileId!;
    const firstCredential = await service.getSpeechCredentials(firstId);
    assert.equal(firstCredential.apiKey, "fake-first-profile-key");
    const inherited = await service.saveAndUse({ provider: "dashscope", model: "second-chat", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" });
    const before = await service.getPublicSettings();
    await assert.rejects(service.getSpeechCredentials(inherited.settings.activeProfileId!), error => error instanceof ProviderSettingsError && error.code === "MISSING_API_KEY");
    assert.equal((await service.getSpeechCredentials(firstId)).apiKey, "fake-first-profile-key");
    assert.deepEqual(await service.getPublicSettings(), before);
    assert.equal(f.runtimes[0]!.key, "fake-inherited-runtime-key");
    await service.saveAndUse({ profileId: firstId, provider: "dashscope", model: "first-chat", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "fake-rotated-profile-key" });
    const nextCredential = await service.getSpeechCredentials(firstId);
    assert.notEqual(nextCredential.revision, firstCredential.revision);
    assert.ok(!nextCredential.revision.includes("fake-rotated"));
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("multiple provider profiles keep independent keys, switch, and survive restart", async () => {
  const current = fixture();
  try {
    const first = current.createService();
    const firstSaved = await first.saveAndUse({
      name: "Example A",
      provider: "example",
      model: "model-a",
      baseUrl: "https://provider.example/v1/",
      apiKey: "sk-first-1111",
      thinkingLevel: "low",
    });
    const firstId = firstSaved.settings.activeProfileId!;
    const secondSaved = await first.saveAndUse({
      name: "Example B",
      provider: "example",
      model: "model-b",
      baseUrl: "https://provider.example/v1",
      apiKey: "sk-second-2222",
      thinkingLevel: "high",
    });
    const secondId = secondSaved.settings.activeProfileId!;

    assert.equal(secondSaved.settings.profiles.length, 2);
    assert.equal(secondSaved.settings.active.model, "model-b");
    assert.equal(secondSaved.settings.active.thinkingLevel, "high");
    assert.equal(secondSaved.settings.active.maxOutputTokens, 8_192);
    assert.equal(secondSaved.model.reasoning, true);
    assert.equal(
      (secondSaved.model.compat as { supportsDeveloperRole?: boolean } | undefined)
        ?.supportsDeveloperRole,
      false,
    );
    assert.deepEqual(
      secondSaved.settings.profiles.map((profile) => profile.apiKeyHint),
      ["••••1111", "••••2222"],
    );

    const activated = await first.activate(firstId);
    assert.equal(activated.settings.activeProfileId, firstId);
    assert.equal(activated.settings.active.model, "model-a");
    assert.equal(current.runtimes[0]?.key, "sk-first-1111");

    const edited = await first.saveAndUse({
      profileId: firstId,
      name: "Example A edited",
      provider: "example",
      model: "model-a-2",
      baseUrl: "https://provider.example/v1",
      thinkingLevel: "medium",
    });
    assert.equal(edited.settings.profiles.length, 2);
    assert.equal(edited.settings.active.apiKeyHint, "••••1111");
    assert.equal(edited.settings.active.thinkingLevel, "medium");

    const settingsText = readFileSync(join(current.directory, "provider-settings.json"), "utf8");
    const secretsText = readFileSync(join(current.directory, "provider-secrets.json"), "utf8");
    assert.doesNotMatch(settingsText, /sk-first|sk-second/);
    assert.match(secretsText, /sk-first-1111/);
    assert.match(secretsText, /sk-second-2222/);

    const restarted = current.createService();
    const restored = await restarted.getPublicSettings();
    assert.equal(restored.profiles.length, 2);
    assert.equal(restored.activeProfileId, firstId);
    assert.equal(restored.active.model, "model-a-2");
    assert.equal(restored.active.thinkingLevel, "medium");
    assert.equal(restored.active.maxOutputTokens, 8_192);
    assert.equal(current.runtimes.at(-1)?.key, "sk-first-1111");

    await restarted.delete(secondId);
    assert.equal((await restarted.getPublicSettings()).profiles.length, 1);
    assert.doesNotMatch(
      readFileSync(join(current.directory, "provider-secrets.json"), "utf8"),
      /sk-second-2222/,
    );
    await assert.rejects(
      restarted.delete(firstId),
      (error: unknown) =>
        error instanceof ProviderSettingsError &&
        error.code === "ACTIVE_PROFILE_DELETE_FORBIDDEN",
    );
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test("Pi-managed provider credentials are inherited in memory without being copied to app secrets", async () => {
  const current = fixture("environment-key-9999");
  try {
    const service = current.createService();
    const tested = await service.testConnection({
      provider: "deepseek",
      model: "model-a",
      baseUrl: "https://provider.example/v1",
    });
    assert.equal(tested.ok, true);
    const saved = await service.saveAndUse({
      provider: "deepseek",
      model: "model-a",
      baseUrl: "https://provider.example/v1",
    });
    assert.equal(saved.settings.active.hasApiKey, true);
    assert.equal(saved.settings.active.apiKeyHint, null);
    assert.doesNotMatch(
      readFileSync(join(current.directory, "provider-secrets.json"), "utf8"),
      /environment-key/,
    );

    const restarted = current.createService();
    assert.equal((await restarted.getPublicSettings()).active.hasApiKey, true);
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test("version 1 single settings migrate to one version 2 profile without losing its key", async () => {
  const current = fixture();
  try {
    writeFileSync(
      join(current.directory, "provider-settings.json"),
      JSON.stringify({
        version: 1,
        provider: "deepseek",
        model: "deepseek-chat",
        baseUrl: "https://api.deepseek.com",
        updatedAt: "2026-09-20T08:00:00.000Z",
      }),
    );
    writeFileSync(
      join(current.directory, "provider-secrets.json"),
      JSON.stringify({ version: 1, apiKeys: { deepseek: "legacy-key-4321" } }),
    );

    const service = current.createService();
    const catalog = await service.getPublicSettings();
    assert.equal(catalog.profiles.length, 1);
    assert.equal(catalog.active.model, "deepseek-chat");
    assert.equal(catalog.active.thinkingLevel, "off");
    assert.equal(catalog.active.maxOutputTokens, 8_192);
    assert.equal(catalog.active.apiKeyHint, "••••4321");
    assert.equal(
      JSON.parse(readFileSync(join(current.directory, "provider-settings.json"), "utf8")).version,
      2,
    );
    assert.equal(
      JSON.parse(readFileSync(join(current.directory, "provider-secrets.json"), "utf8")).version,
      2,
    );
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test("existing version 2 DashScope profiles without an output budget load safely", async () => {
  const current = fixture();
  try {
    writeFileSync(
      join(current.directory, "provider-settings.json"),
      JSON.stringify({
        version: 2,
        activeProfileId: "aliyun-profile",
        profiles: [{
          id: "aliyun-profile",
          name: "百炼",
          provider: "aliyun-bailian",
          model: "qwen3.8-max-0902",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          thinkingLevel: "high",
          updatedAt: "2026-09-22T08:00:00.000Z",
        }],
      }),
    );
    writeFileSync(
      join(current.directory, "provider-secrets.json"),
      JSON.stringify({ version: 2, apiKeys: { "aliyun-profile": "legacy-key" } }),
    );

    const service = current.createService();
    const catalog = await service.getPublicSettings();
    assert.equal(catalog.active.maxOutputTokens, 32_768);
    assert.equal((await service.getActiveRuntime()).model.maxTokens, 32_768);
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test("connection test uses an isolated runtime and never returns the API key", async () => {
  const current = fixture();
  try {
    const service = current.createService();
    const result = await service.testConnection({
      provider: "example",
      model: "model-a",
      baseUrl: "https://provider.example/v1",
      apiKey: "sk-isolated-5678",
      thinkingLevel: "high",
    });
    assert.equal(result.ok, true);
    assert.doesNotMatch(JSON.stringify(result), /sk-isolated/);
    assert.equal(current.runtimes.length, 2);
    assert.equal(current.runtimes[0]?.key, undefined);
    assert.equal(current.runtimes[1]?.key, "sk-isolated-5678");
    assert.equal(current.runtimes[1]?.reasoning, true);
    assert.equal(current.runtimes[1]?.supportsDeveloperRole, false);
    assert.equal(current.runtimes[1]?.maxTokens, 8_192);
    assert.equal(current.runtimes[1]?.lastCompletionHadSystemPrompt, true);
    assert.equal(current.runtimes[1]?.lastCompletionReasoning, "high");
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test("connection test distinguishes missing key, authentication, model, network, and timeout failures", async (context) => {
  const cases: Array<{
    name: string;
    failure?: unknown;
    inputKey?: string;
    code: string;
  }> = [
    { name: "missing key", code: "MISSING_API_KEY" },
    { name: "authentication", inputKey: "bad", failure: Object.assign(new Error("unauthorized"), { status: 401 }), code: "AUTHENTICATION_FAILED" },
    { name: "model", inputKey: "key", failure: Object.assign(new Error("model not found"), { status: 404 }), code: "MODEL_NOT_FOUND" },
    { name: "thinking level", inputKey: "key", failure: Object.assign(new Error("unsupported parameter: reasoning_effort"), { status: 400 }), code: "UNSUPPORTED_THINKING_LEVEL" },
    { name: "network", inputKey: "key", failure: new Error("fetch failed: ECONNREFUSED"), code: "NETWORK_ERROR" },
    { name: "timeout", inputKey: "key", failure: Object.assign(new Error("timed out"), { name: "AbortError" }), code: "PROVIDER_TIMEOUT" },
  ];

  for (const item of cases) {
    await context.test(item.name, async () => {
      const current = fixture();
      try {
        const service = current.createService();
        current.runtimeFailure.value = item.failure;
        await assert.rejects(
          service.testConnection({
          provider: "example",
          model: "model-a",
          baseUrl: "https://provider.example/v1",
          apiKey: item.inputKey,
          }),
          (error: unknown) =>
            error instanceof ProviderSettingsError && error.code === item.code,
        );
      } finally {
        rmSync(current.directory, { recursive: true, force: true });
      }
    });
  }
});

test("invalid and credential-bearing Base URLs are rejected before any provider call", async () => {
  const current = fixture();
  try {
    const service = current.createService();
    await assert.rejects(
      service.testConnection({
        provider: "example",
        model: "model-a",
        baseUrl: "https://user:password@provider.example/v1",
        apiKey: "key",
      }),
      (error: unknown) =>
        error instanceof ProviderSettingsError && error.code === "INVALID_BASE_URL",
    );
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test("invalid thinking levels are rejected before any provider call", async () => {
  const current = fixture();
  try {
    const service = current.createService();
    await assert.rejects(
      service.testConnection({
        provider: "example",
        model: "model-a",
        baseUrl: "https://provider.example/v1",
        apiKey: "key",
        thinkingLevel: "unlimited" as "high",
      }),
      (error: unknown) =>
        error instanceof ProviderSettingsError && error.code === "INVALID_THINKING_LEVEL",
    );
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test("DashScope profiles default to a larger shared reasoning and answer budget", async () => {
  const current = fixture();
  try {
    const service = current.createService();
    const saved = await service.saveAndUse({
      provider: "aliyun-bailian",
      model: "qwen3.8-max-0902",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "key",
      thinkingLevel: "high",
    });
    assert.equal(saved.settings.active.maxOutputTokens, 32_768);
    assert.equal(saved.model.maxTokens, 32_768);
    assert.equal(saved.model.contextWindow, 1_000_000);
    assert.deepEqual(saved.model.input, ["text", "image"]);
    assert.equal((await current.createService().getActiveRuntime()).model.contextWindow, 1_000_000);
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test("invalid maximum output token budgets are rejected", async () => {
  const current = fixture();
  try {
    const service = current.createService();
    await assert.rejects(
      service.saveAndUse({
        provider: "example",
        model: "model-a",
        baseUrl: "https://provider.example/v1",
        apiKey: "key",
        maxOutputTokens: 12.5,
      }),
      (error: unknown) =>
        error instanceof ProviderSettingsError && error.code === "INVALID_MAX_OUTPUT_TOKENS",
    );
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});
