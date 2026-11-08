import {ProviderSettingsError,type ProviderSettingsErrorCode} from "./providerSettingsErrors.js";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Api, Model } from "@earendil-works/pi-ai";
import { modelContextWindow } from "../modelContextBudget.js";
import {knownImageModel} from "../teachingImages.js";
import {configureOpenCodeGoRuntime,isOpenCodeGo} from "../openCodeGo.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const PROVIDER_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ProviderThinkingLevel = typeof PROVIDER_THINKING_LEVELS[number];

const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const DASHSCOPE_MAX_OUTPUT_TOKENS = 32_768;

export interface ProviderSettingsInput {
  profileId?: string;
  name?: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  thinkingLevel?: ProviderThinkingLevel;
  maxOutputTokens?: number;
}

export interface PublicProviderSettings {
  provider: string;
  model: string;
  baseUrl: string;
  thinkingLevel: ProviderThinkingLevel;
  maxOutputTokens: number;
  hasApiKey: boolean;
  apiKeyHint: string | null;
}

export interface PublicProviderProfile extends PublicProviderSettings {
  id: string;
  name: string;
}

export interface PublicProviderCatalog {
  activeProfileId: string | null;
  active: PublicProviderSettings;
  profiles: PublicProviderProfile[];
}

export interface ProviderConnectionResult {
  ok: true;
  provider: string;
  model: string;
  message: string;
}

/** 凭证只在 Node 服务间传递。公开设置和学习记录仅保存非敏感元数据。 */
export interface PrivateProviderCredentials {
  profileId: string;
  baseUrl: string;
  apiKey: string;
  revision: string;
}

export type SpeechProviderCredentials = PrivateProviderCredentials;

export {ProviderSettingsError,type ProviderSettingsErrorCode} from "./providerSettingsErrors.js";
interface StoredProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  thinkingLevel: ProviderThinkingLevel;
  maxOutputTokens: number;
  updatedAt: string;
}

interface StoredSettingsV2 {
  version: 2;
  activeProfileId: string | null;
  profiles: StoredProfile[];
}

interface StoredSettingsV1 {
  version: 1;
  provider: string;
  model: string;
  baseUrl: string;
  updatedAt: string;
}

interface StoredSecretsV2 {
  version: 2;
  apiKeys: Record<string, string>;
}

interface StoredSecretsV1 {
  version: 1;
  apiKeys: Record<string, string>;
}

interface RuntimeLike {
  registerProvider(providerId: string, config: {
    name: string;
    baseUrl: string;
    api: "openai-completions";
    models: Array<{
      id: string;
      name: string;
      reasoning: boolean;
      thinkingLevelMap?: Partial<Record<ProviderThinkingLevel, string | null>>;
      compat?: { supportsDeveloperRole?: boolean; thinkingFormat?: "deepseek"; requiresReasoningContentOnAssistantMessages?: boolean };
      input: Array<"text"|"image">;
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
      contextWindow: number;
      maxTokens: number;
    }>;
  }): void;
  getModel(providerId: string, modelId: string): Model<Api> | undefined;
  getAvailable(): Promise<readonly Model<Api>[]>;
  hasConfiguredAuth(providerId: string): boolean;
  getAuth(target: string | Model<Api>): Promise<{
    auth: { apiKey?: string };
  } | undefined>;
  setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>;
  completeSimple(
    model: Model<Api>,
    context: {
      systemPrompt?: string;
      messages: Array<{ role: "user"; content: string; timestamp: number }>;
    },
    options: {
      maxTokens: number;
      timeoutMs: number;
      maxRetries: number;
      reasoning?: Exclude<ProviderThinkingLevel, "off">;
    },
  ): Promise<{ stopReason: string; errorMessage?: string }>;
}

export interface ProviderSettingsServiceOptions {
  settingsPath: string;
  secretsPath: string;
  runtimeFactory?: () => Promise<RuntimeLike>;
  now?: () => Date;
}

export interface ProviderSettingsCoordinator {
  getPublicSettings(): Promise<PublicProviderCatalog>;
  getActiveRuntime(): Promise<{
    runtime: ModelRuntime;
    model: Model<Api>;
    thinkingLevel: ProviderThinkingLevel;
  }>;
  testConnection(input: ProviderSettingsInput): Promise<ProviderConnectionResult>;
  saveAndUse(input: ProviderSettingsInput): Promise<{
    settings: PublicProviderCatalog;
    model: Model<Api>;
    thinkingLevel: ProviderThinkingLevel;
  }>;
  activate(profileId: string): Promise<{
    settings: PublicProviderCatalog;
    model: Model<Api>;
    thinkingLevel: ProviderThinkingLevel;
  }>;
  delete(profileId: string): Promise<PublicProviderCatalog>;
}

function normalizeInput(
  input: ProviderSettingsInput,
): ProviderSettingsInput & {
  name: string;
  thinkingLevel: ProviderThinkingLevel;
  maxOutputTokens: number;
} {
  const provider = input.provider.trim().toLowerCase();
  const model = input.model.trim();
  const thinkingLevel = input.thinkingLevel ?? "off";
  const rawBaseUrl = input.baseUrl.trim();
  const isDashScope =
    provider.includes("aliyun") ||
    /(?:dashscope|\.maas\.aliyuncs\.com)/i.test(rawBaseUrl);
  const maxOutputTokens = input.maxOutputTokens ?? (
    isDashScope ? DASHSCOPE_MAX_OUTPUT_TOKENS : DEFAULT_MAX_OUTPUT_TOKENS
  );
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider)) {
    throw new ProviderSettingsError(
      "INVALID_PROVIDER",
      "Provider 只能使用小写字母、数字、点、下划线或连字符。",
    );
  }
  if (!model || model.length > 200 || /[\r\n]/.test(model)) {
    throw new ProviderSettingsError("INVALID_MODEL", "请输入有效的模型 ID。");
  }
  if (!PROVIDER_THINKING_LEVELS.includes(thinkingLevel)) {
    throw new ProviderSettingsError(
      "INVALID_THINKING_LEVEL",
      "推理强度必须是模型默认、minimal、low、medium、high、xhigh 或 max。",
    );
  }
  if (
    !Number.isInteger(maxOutputTokens) ||
    maxOutputTokens < 256 ||
    maxOutputTokens > 131_072
  ) {
    throw new ProviderSettingsError(
      "INVALID_MAX_OUTPUT_TOKENS",
      "最大输出 Tokens 必须是 256～131072 之间的整数。",
    );
  }
  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new ProviderSettingsError("INVALID_BASE_URL", "Base URL 不是有效的网址。");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new ProviderSettingsError(
      "INVALID_BASE_URL",
      "Base URL 必须是无用户名和密码的 HTTP(S) 地址。",
    );
  }
  const name = input.name?.trim() || `${provider} / ${model}`;
  if (name.length > 80 || /[\r\n]/.test(name)) {
    throw new ProviderSettingsError(
      "INVALID_PROFILE_NAME",
      "配置名称不能超过 80 个字符或包含换行。",
    );
  }
  return {
    ...(input.profileId ? { profileId: input.profileId } : {}),
    name,
    provider,
    model,
    baseUrl: rawBaseUrl.replace(/\/+$/, ""),
    thinkingLevel,
    maxOutputTokens,
    apiKey: input.apiKey?.trim() || undefined,
  };
}

function keyHint(key: string | undefined): string | null {
  if (!key) return null;
  return `••••${key.slice(-4)}`;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error(`Provider settings file is invalid: ${path}`, { cause: error });
  }
}

async function writeJsonAtomic(path: string, value: unknown, secret = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: secret ? 0o600 : 0o644,
  });
  await rename(temporary, path);
  if (secret) await chmod(path, 0o600).catch(() => undefined);
}

function registerOpenAiCompatible(
  runtime: RuntimeLike,
  settings: Required<Pick<
    ProviderSettingsInput,
    "provider" | "model" | "baseUrl" | "thinkingLevel" | "maxOutputTokens"
  >>,
): Model<Api> {
  const deepseekGo=isOpenCodeGo(settings.baseUrl) && settings.model.toLowerCase()==="deepseek-v4.1-flash";
  runtime.registerProvider(settings.provider, {
    name: settings.provider,
    baseUrl: settings.baseUrl,
    api: "openai-completions",
    models: [
      {
        id: settings.model,
        name: settings.model,
        // “off” 在产品中表示沿用模型默认：不向普通 Chat 模型发送推理参数。
        // 选择其他强度后，Pi 才会按 OpenAI-compatible Provider 格式发送 effort。
        reasoning: settings.thinkingLevel !== "off",
        ...(settings.thinkingLevel !== "off"
          ? { thinkingLevelMap: deepseekGo
            ? {minimal:"low",low:"low",medium:"high",high:"high",xhigh:"high",max:"max"}
            : { xhigh: "xhigh", max: "max" } }
          : {}),
        // OpenAI-compatible 并不等于完整 OpenAI 语义。百炼等接口拒绝
        // `developer` role，因此自定义 Provider 使用兼容性更广的 `system` role。
        compat: { supportsDeveloperRole: false,
          ...(deepseekGo ? {thinkingFormat:"deepseek",requiresReasoningContentOnAssistantMessages:true} : {}),
        },
        input: knownImageModel(settings.model) || runtime.getModel(settings.provider, settings.model)?.input.includes("image") ? ["text","image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: modelContextWindow(settings.model, runtime.getModel(settings.provider, settings.model)?.contextWindow),
        maxTokens: settings.maxOutputTokens,
      },
    ],
  });
  const model = runtime.getModel(settings.provider, settings.model);
  if (!model) {
    throw new ProviderSettingsError(
      "MODEL_NOT_FOUND",
      "Provider 未提供这个模型，请检查模型 ID。",
      422,
    );
  }
  return model;
}

function classifyProviderFailure(error: unknown): ProviderSettingsError {
  if (error instanceof ProviderSettingsError) return error;
  const source = error instanceof Error ? error.message : String(error);
  const message = source.toLowerCase();
  const status = Number(
    (error as { status?: unknown; statusCode?: unknown }).status ??
      (error as { statusCode?: unknown }).statusCode,
  );
  if (status === 401 || status === 403 || /unauthori|authentication|invalid api.?key/.test(message)) {
    return new ProviderSettingsError(
      "AUTHENTICATION_FAILED",
      "认证失败，请检查 API Key 是否正确且有权访问该模型。",
      401,
    );
  }
  if (status === 404 || /model.*(not found|unavailable|does not exist)|unknown model/.test(message)) {
    return new ProviderSettingsError(
      "MODEL_NOT_FOUND",
      "Provider 未提供这个模型，请检查模型 ID。",
      422,
    );
  }
  if (
    status === 400 &&
    /reasoning.?effort|enable.?thinking|thinking.?level|unsupported.*(?:reasoning|thinking)/.test(message)
  ) {
    return new ProviderSettingsError(
      "UNSUPPORTED_THINKING_LEVEL",
      "当前模型或接口不支持这个推理强度。请改用“模型默认”或较低档位后重试。",
      422,
    );
  }
  if (
    (error as { name?: unknown }).name === "AbortError" ||
    /timeout|timed out|etimedout/.test(message)
  ) {
    return new ProviderSettingsError(
      "PROVIDER_TIMEOUT",
      "连接 Provider 超时，请稍后重试或检查 Base URL。",
      504,
    );
  }
  if (/fetch failed|econn|enotfound|network|socket|dns/.test(message)) {
    return new ProviderSettingsError(
      "NETWORK_ERROR",
      "无法连接 Provider，请检查网络与 Base URL。",
      502,
    );
  }
  return new ProviderSettingsError(
    "PROVIDER_ERROR",
    "Provider 没有完成连接测试，请检查配置后重试。",
    502,
  );
}

export class ProviderSettingsService implements ProviderSettingsCoordinator {
  private runtime?: RuntimeLike;
  private settings: StoredSettingsV2 = { version: 2, activeProfileId: null, profiles: [] };
  private secrets: StoredSecretsV2 = { version: 2, apiKeys: {} };
  private readonly inheritedApiKeys = new Map<string, string | undefined>();
  private initialized?: Promise<void>;

  constructor(private readonly options: ProviderSettingsServiceOptions) {}

  async getPublicSettings(): Promise<PublicProviderCatalog> {
    await this.initialize();
    return this.toCatalog();
  }

  getSpeechCredentials(profileId:string):Promise<SpeechProviderCredentials> {return this.getProfileCredentials(profileId);}

  async getProfileCredentials(profileId: string): Promise<PrivateProviderCredentials> {
    await this.initialize();
    const profile = this.requireProfile(profileId);
    // 生成服务引用所选档案自身的 Key，课堂切换模型时也保持正确的供应商与地域。
    const apiKey = this.secrets.apiKeys[profile.id];
    if (!apiKey) {
      throw new ProviderSettingsError("MISSING_API_KEY", "这组配置没有独立保存的 API Key，请先编辑并保存 Key。", 422);
    }
    return {
      profileId: profile.id,
      baseUrl: profile.baseUrl,
      apiKey,
      revision: createHash("sha256").update(JSON.stringify([profile, apiKey])).digest("hex"),
    };
  }

  async getActiveRuntime(): Promise<{
    runtime: ModelRuntime;
    model: Model<Api>;
    thinkingLevel: ProviderThinkingLevel;
  }> {
    await this.initialize();
    const active = this.activeProfile();
    const model = active
      ? this.runtime!.getModel(active.provider, active.model)
      : await this.fallbackModel();
    if (!model) {
      throw new ProviderSettingsError(
        "MODEL_NOT_FOUND",
        "尚未配置可用模型，请先打开设置完成 Provider 配置。",
        422,
      );
    }
    return {
      runtime: this.runtime as ModelRuntime,
      model,
      thinkingLevel: active?.thinkingLevel ?? (model.reasoning ? "medium" : "off"),
    };
  }

  async testConnection(input: ProviderSettingsInput): Promise<ProviderConnectionResult> {
    await this.initialize();
    const normalized = normalizeInput(input);
    // 连接测试使用独立 ModelRuntime：错误配置不能改变当前 Agent、凭据或学习状态。
    const runtime = await this.createRuntime();
    try {
      const existing = normalized.profileId
        ? this.settings.profiles.find((profile) => profile.id === normalized.profileId)
        : undefined;
      const inheritedKey = (await runtime.getAuth(normalized.provider))?.auth.apiKey;
      const key =
        normalized.apiKey ??
        (existing?.provider === normalized.provider
          ? this.secrets.apiKeys[existing.id]
          : undefined) ??
        inheritedKey;
      const model = registerOpenAiCompatible(runtime, normalized);
      if (!key) {
        throw new ProviderSettingsError(
          "MISSING_API_KEY",
          "缺少 API Key。新配置请输入 Key；已有配置可留空继续使用已保存的 Key。",
          422,
        );
      }
      await runtime.setRuntimeApiKey(normalized.provider, key);
      const response = await runtime.completeSimple(
        model,
        {
          // 必须覆盖真实 Agent 的 system prompt 形态；否则只测 user message 会漏掉
          // Provider 对 developer/system role 的兼容差异。
          systemPrompt: "You are a concise learning assistant.",
          messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }],
        },
        {
          // 这里只验证鉴权、模型、system role 与 reasoning 参数；保持小预算，
          // 避免一次连接测试在高推理档位产生大额输出费用。
          maxTokens: Math.min(normalized.maxOutputTokens, 256),
          timeoutMs: 15_000,
          maxRetries: 0,
          ...(normalized.thinkingLevel === "off"
            ? {}
            : { reasoning: normalized.thinkingLevel }),
        },
      );
      if (response.stopReason === "error") throw new Error(response.errorMessage ?? "provider error");
      return {
        ok: true,
        provider: normalized.provider,
        model: normalized.model,
        message: "连接成功，Provider 与模型可用。",
      };
    } catch (error) {
      throw classifyProviderFailure(error);
    }
  }

  async saveAndUse(input: ProviderSettingsInput): Promise<{
    settings: PublicProviderCatalog;
    model: Model<Api>;
    thinkingLevel: ProviderThinkingLevel;
  }> {
    await this.initialize();
    const normalized = normalizeInput(input);
    const existing = normalized.profileId
      ? this.requireProfile(normalized.profileId)
      : undefined;
    await this.captureInheritedKey(normalized.provider);
    const key =
      normalized.apiKey ??
      (existing?.provider === normalized.provider
        ? this.secrets.apiKeys[existing.id]
        : undefined) ??
      this.inheritedApiKeys.get(normalized.provider);
    if (!key) {
      throw new ProviderSettingsError(
        "MISSING_API_KEY",
        "缺少 API Key。新配置请输入 Key；已有配置可留空继续使用已保存的 Key。",
        422,
      );
    }
    const model = registerOpenAiCompatible(this.runtime!, normalized);
    await this.runtime!.setRuntimeApiKey(normalized.provider, key);

    const profile: StoredProfile = {
      id: existing?.id ?? randomUUID(),
      name: normalized.name,
      provider: normalized.provider,
      model: normalized.model,
      baseUrl: normalized.baseUrl,
      thinkingLevel: normalized.thinkingLevel,
      maxOutputTokens: normalized.maxOutputTokens,
      updatedAt: this.now(),
    };
    const profiles = existing
      ? this.settings.profiles.map((item) => item.id === existing.id ? profile : item)
      : [...this.settings.profiles, profile];
    const nextSettings: StoredSettingsV2 = {
      version: 2,
      activeProfileId: profile.id,
      profiles,
    };
    const retainedApiKeys = { ...this.secrets.apiKeys };
    if (existing && existing.provider !== normalized.provider && !normalized.apiKey) {
      delete retainedApiKeys[existing.id];
    }
    const nextSecrets: StoredSecretsV2 = {
      version: 2,
      apiKeys: {
        ...retainedApiKeys,
        ...(normalized.apiKey ? { [profile.id]: normalized.apiKey } : {}),
      },
    };
    // ARCHITECTURE-CRITICAL：每个档案按 profile id 关联独立 Secret；Browser 只看脱敏目录。
    await this.persist(nextSettings, nextSecrets);
    return {
      settings: await this.toCatalog(),
      model,
      thinkingLevel: normalized.thinkingLevel,
    };
  }

  async activate(profileId: string): Promise<{
    settings: PublicProviderCatalog;
    model: Model<Api>;
    thinkingLevel: ProviderThinkingLevel;
  }> {
    await this.initialize();
    const profile = this.requireProfile(profileId);
    await this.captureInheritedKey(profile.provider);
    const key = this.secrets.apiKeys[profile.id] ?? this.inheritedApiKeys.get(profile.provider);
    if (!key) {
      throw new ProviderSettingsError(
        "MISSING_API_KEY",
        "这个配置没有可用的 API Key，请先编辑并保存 Key。",
        422,
      );
    }
    const model = registerOpenAiCompatible(this.runtime!, profile);
    await this.runtime!.setRuntimeApiKey(profile.provider, key);
    const nextSettings = { ...this.settings, activeProfileId: profile.id };
    await writeJsonAtomic(this.options.settingsPath, nextSettings);
    this.settings = nextSettings;
    return {
      settings: await this.toCatalog(),
      model,
      thinkingLevel: profile.thinkingLevel ?? "off",
    };
  }

  async delete(profileId: string): Promise<PublicProviderCatalog> {
    await this.initialize();
    this.requireProfile(profileId);
    if (this.settings.activeProfileId === profileId) {
      throw new ProviderSettingsError(
        "ACTIVE_PROFILE_DELETE_FORBIDDEN",
        "当前正在使用这组配置。请先切换到另一组，再删除它。",
        409,
      );
    }
    const { [profileId]: _removed, ...apiKeys } = this.secrets.apiKeys;
    const nextSettings: StoredSettingsV2 = {
      ...this.settings,
      profiles: this.settings.profiles.filter((profile) => profile.id !== profileId),
    };
    await this.persist(nextSettings, { version: 2, apiKeys });
    return this.toCatalog();
  }

  private async initialize(): Promise<void> {
    this.initialized ??= this.load();
    return this.initialized;
  }

  private async load(): Promise<void> {
    this.runtime = await this.createRuntime();
    const storedSettings = await readJson<StoredSettingsV1 | StoredSettingsV2 | undefined>(
      this.options.settingsPath,
      undefined,
    );
    const storedSecrets = await readJson<StoredSecretsV1 | StoredSecretsV2>(
      this.options.secretsPath,
      { version: 2, apiKeys: {} },
    );

    if (storedSettings?.version === 1) {
      const normalized = normalizeInput(storedSettings);
      const id = randomUUID();
      this.settings = {
        version: 2,
        activeProfileId: id,
        profiles: [{
          id,
          name: `${normalized.provider} / ${normalized.model}`,
          provider: normalized.provider,
          model: normalized.model,
          baseUrl: normalized.baseUrl,
          thinkingLevel: normalized.thinkingLevel,
          maxOutputTokens: normalized.maxOutputTokens,
          updatedAt: storedSettings.updatedAt,
        }],
      };
      this.secrets = {
        version: 2,
        apiKeys: storedSecrets.apiKeys[normalized.provider]
          ? { [id]: storedSecrets.apiKeys[normalized.provider]! }
          : {},
      };
      await this.persist(this.settings, this.secrets);
    } else if (storedSettings?.version === 2) {
      const profiles = storedSettings.profiles.map((profile) => {
        const normalized = normalizeInput(profile);
        return { ...profile, ...normalized, id: profile.id, updatedAt: profile.updatedAt };
      });
      this.settings = {
        version: 2,
        activeProfileId: profiles.some((profile) => profile.id === storedSettings.activeProfileId)
          ? storedSettings.activeProfileId
          : profiles[0]?.id ?? null,
        profiles,
      };
      this.secrets = storedSecrets.version === 2
        ? storedSecrets
        : { version: 2, apiKeys: {} };
    }

    for (const provider of new Set(this.settings.profiles.map((profile) => profile.provider))) {
      await this.captureInheritedKey(provider);
    }
    const active = this.activeProfile();
    if (active) {
      const key = this.secrets.apiKeys[active.id] ?? this.inheritedApiKeys.get(active.provider);
      registerOpenAiCompatible(this.runtime, active);
      if (key) await this.runtime.setRuntimeApiKey(active.provider, key);
    }
  }

  private async createRuntime(): Promise<RuntimeLike> {
    const runtime=await (this.options.runtimeFactory?.() ?? ModelRuntime.create({
      allowModelNetwork: false,
      refreshOnCreate: false,
    }));
    configureOpenCodeGoRuntime(runtime);
    return runtime;
  }

  private async captureInheritedKey(provider: string): Promise<void> {
    if (this.inheritedApiKeys.has(provider)) return;
    this.inheritedApiKeys.set(provider, (await this.runtime!.getAuth(provider))?.auth.apiKey);
  }

  private activeProfile(): StoredProfile | undefined {
    return this.settings.profiles.find((profile) => profile.id === this.settings.activeProfileId);
  }

  private requireProfile(profileId: string): StoredProfile {
    const profile = this.settings.profiles.find((item) => item.id === profileId);
    if (!profile) {
      throw new ProviderSettingsError("PROFILE_NOT_FOUND", "找不到这组模型配置。", 404);
    }
    return profile;
  }

  private async fallbackModel(): Promise<Model<Api> | undefined> {
    const requested = process.env.PI_MODEL?.trim();
    if (requested) {
      const separator = requested.indexOf("/");
      if (separator > 0 && separator < requested.length - 1) {
        const model = this.runtime!.getModel(
          requested.slice(0, separator),
          requested.slice(separator + 1),
        );
        if (model) return model;
      }
    }
    return (await this.runtime!.getAvailable())[0];
  }

  private async toCatalog(): Promise<PublicProviderCatalog> {
    const profiles = this.settings.profiles.map((profile) => this.toPublicProfile(profile));
    const activeProfile = profiles.find((profile) => profile.id === this.settings.activeProfileId);
    let active: PublicProviderSettings;
    if (activeProfile) {
      active = {
        provider: activeProfile.provider,
        model: activeProfile.model,
        baseUrl: activeProfile.baseUrl,
        thinkingLevel: activeProfile.thinkingLevel,
        maxOutputTokens: activeProfile.maxOutputTokens,
        hasApiKey: activeProfile.hasApiKey,
        apiKeyHint: activeProfile.apiKeyHint,
      };
    } else {
      const fallback = await this.fallbackModel();
      active = {
        provider: fallback?.provider ?? "",
        model: fallback?.id ?? "",
        baseUrl: fallback?.baseUrl ?? "",
        thinkingLevel: fallback?.reasoning ? "medium" : "off",
        maxOutputTokens: fallback?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        hasApiKey: fallback ? this.runtime!.hasConfiguredAuth(fallback.provider) : false,
        apiKeyHint: null,
      };
    }
    return {
      activeProfileId: activeProfile?.id ?? null,
      active,
      profiles,
    };
  }

  private toPublicProfile(profile: StoredProfile): PublicProviderProfile {
    const key = this.secrets.apiKeys[profile.id];
    return {
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      model: profile.model,
      baseUrl: profile.baseUrl,
      thinkingLevel: profile.thinkingLevel ?? "off",
      maxOutputTokens: profile.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      hasApiKey: Boolean(key) || Boolean(this.inheritedApiKeys.get(profile.provider)),
      apiKeyHint: keyHint(key),
    };
  }

  private async persist(settings: StoredSettingsV2, secrets: StoredSecretsV2): Promise<void> {
    await writeJsonAtomic(this.options.secretsPath, secrets, true);
    await writeJsonAtomic(this.options.settingsPath, settings);
    this.settings = settings;
    this.secrets = secrets;
  }

  private now(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }
}
