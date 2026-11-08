import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Api, Message, Model } from "@earendil-works/pi-ai";

import type { LearningAgentSession } from "../agentSession.js";
import type { LearningOverview } from "../learningOverviewTool.js";
import type { ProviderSettingsCoordinator } from "./providerSettings.js";
import { WebSessionStore } from "./sessionStore.js";
import { ConversationCatalog } from "./conversationCatalog.js";

function providerModel(id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "example",
    baseUrl: "https://provider.example/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function providerCoordinator(
  onSave: (model: Model<Api>) => void = () => undefined,
): ProviderSettingsCoordinator {
  const profile = {
    id: "profile-a",
    name: "Example",
    provider: "example",
    model: "model-a",
    baseUrl: "https://provider.example/v1",
    thinkingLevel: "medium" as const,
    maxOutputTokens: 8_192,
    hasApiKey: true,
    apiKeyHint: "••••1234",
  };
  return {
    getPublicSettings: async () => ({
      activeProfileId: profile.id,
      active: profile,
      profiles: [profile],
    }),
    getActiveRuntime: async () => {
      throw new Error("injected Agent does not request a runtime");
    },
    testConnection: async (input) => ({
      ok: true,
      provider: input.provider,
      model: input.model,
      message: "ok",
    }),
    saveAndUse: async (input) => {
      const model = providerModel(input.model);
      onSave(model);
      return {
        model,
        thinkingLevel: input.thinkingLevel ?? "off",
        settings: {
          activeProfileId: profile.id,
          active: { provider: input.provider, model: input.model, baseUrl: input.baseUrl, thinkingLevel: input.thinkingLevel ?? "off", maxOutputTokens: input.maxOutputTokens ?? 8_192, hasApiKey: true, apiKeyHint: "••••1234" },
          profiles: [{ ...profile, provider: input.provider, model: input.model, baseUrl: input.baseUrl, thinkingLevel: input.thinkingLevel ?? "off", maxOutputTokens: input.maxOutputTokens ?? 8_192 }],
        },
      };
    },
    activate: async () => ({
      model: providerModel(profile.model),
      thinkingLevel: profile.thinkingLevel,
      settings: { activeProfileId: profile.id, active: profile, profiles: [profile] },
    }),
    delete: async () => ({ activeProfileId: profile.id, active: profile, profiles: [profile] }),
  };
}

function overview(goal: string | null = "学习 CNN"): LearningOverview {
  return {
    current_goal: goal,
    goal_profile: null,
    curriculum_spine: [],
    current_frontier: {
      focus_skill_id: "cnn",
      supporting_skill_ids: [],
      reason: "当前学习前沿",
      target_depth: "PRACTICAL",
      suggested_learning_mode: "BUILD",
      next_action: "实现最小 CNN",
    },
    current_focus: null,
    skills: [
      {
        id: "cnn",
        name: "CNN",
        description: "卷积神经网络",
        status: "PRACTICING",
        target_depth: "PRACTICAL",
        evidence_ids: [],
      },
    ],
    recent_evidence: [],
    active_task: null,
    learning_history: [],
    current_goal_skill_ids: ["cnn"],
  };
}

test("a mastered Frontier is exposed as stale instead of an actionable old recommendation", async () => {
  const current = overview();
  current.skills[0] = { ...current.skills[0]!, status: "MASTERED_BY_USER" };
  const store = new WebSessionStore({ fetchOverview: async () => current });

  const created = await store.create();
  const recommendation = (created.state as unknown as {
    recommended_action: { status: string; text: string } | null;
  }).recommended_action;

  assert.equal(recommendation?.status, "STALE");
  assert.doesNotMatch(recommendation?.text ?? "", /实现最小 CNN/);
  assert.match(recommendation?.text ?? "", /重新规划|最新状态/);
});

test("browser session keeps one multi-turn Agent runtime", async () => {
  let createCount = 0;
  const prompts: string[] = [];
  const events: string[] = [];
  const store = new WebSessionStore({
    fetchOverview: async () => overview(),
    createAgent: async (_context, _planning, emit): Promise<LearningAgentSession> => {
      createCount += 1;
      return {
        prompt: async (text) => {
          prompts.push(text);
          emit({ type: "assistant_delta", delta: `reply:${text}` });
        },
        abort: async () => undefined,
        dispose: () => undefined,
      };
    },
  });

  const created = await store.create();
  await store.sendMessage(created.sessionId, "第一轮", (event) => events.push(event.type));
  await store.sendMessage(created.sessionId, "第二轮", (event) => events.push(event.type));

  assert.equal(createCount, 1);
  assert.deepEqual(prompts, ["第一轮", "第二轮"]);
  assert.deepEqual(events, [
    "assistant_delta",
    "state",
    "done",
    "assistant_delta",
    "state",
    "done",
  ]);
});

test("idle model switching keeps the Agent session and the next turn uses the new model", async () => {
  let currentModel = "model-a";
  const observedTurns: string[] = [];
  const modelChanges: string[] = [];
  const thinkingChanges: string[] = [];
  const store = new WebSessionStore({
    fetchOverview: async () => overview(),
    providerSettings: providerCoordinator(),
    createAgent: async (): Promise<LearningAgentSession> => ({
      prompt: async (text) => {
        observedTurns.push(`${currentModel}:${text}`);
      },
      abort: async () => undefined,
      setModel: async (model) => {
        currentModel = model.id;
        modelChanges.push(model.id);
      },
      setThinkingLevel: (level) => {
        thinkingChanges.push(level);
      },
      dispose: () => undefined,
    }),
  });

  const created = await store.create();
  await store.sendMessage(created.sessionId, "第一轮", () => undefined);
  await store.saveProviderSettings({
    provider: "example",
    model: "model-b",
    baseUrl: "https://provider.example/v1",
    thinkingLevel: "high",
  });
  await store.sendMessage(created.sessionId, "第二轮", () => undefined);

  assert.deepEqual(modelChanges, ["model-b"]);
  assert.deepEqual(thinkingChanges, ["high"]);
  assert.deepEqual(observedTurns, ["model-a:第一轮", "model-b:第二轮"]);
});

test("activating a saved profile switches the existing Agent without rebuilding it", async () => {
  let createCount = 0;
  const modelChanges: string[] = [];
  const thinkingChanges: string[] = [];
  const store = new WebSessionStore({
    fetchOverview: async () => overview(),
    providerSettings: providerCoordinator(),
    createAgent: async (): Promise<LearningAgentSession> => {
      createCount += 1;
      return {
        prompt: async () => undefined,
        abort: async () => undefined,
        setModel: async (model) => {
          modelChanges.push(model.id);
        },
        setThinkingLevel: (level) => {
          thinkingChanges.push(level);
        },
        dispose: () => undefined,
      };
    },
  });

  const created = await store.create();
  await store.sendMessage(created.sessionId, "先创建 Agent", () => undefined);
  const catalog = await store.activateProviderProfile("profile-a");

  assert.equal(catalog.activeProfileId, "profile-a");
  assert.equal(createCount, 1);
  assert.deepEqual(modelChanges, ["model-a"]);
  assert.deepEqual(thinkingChanges, ["medium"]);
});

test("active generation rejects model switching before provider settings are changed", async () => {
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  let saves = 0;
  const store = new WebSessionStore({
    fetchOverview: async () => overview(),
    providerSettings: providerCoordinator(() => {
      saves += 1;
    }),
    createAgent: async (): Promise<LearningAgentSession> => ({
      prompt: async () => {
        started?.();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      abort: async () => release?.(),
      setModel: async () => undefined,
      dispose: () => undefined,
    }),
  });
  const created = await store.create();
  const turn = store.sendMessage(created.sessionId, "生成中", () => undefined);
  await active;

  await assert.rejects(
    store.saveProviderSettings({
      provider: "example",
      model: "model-b",
      baseUrl: "https://provider.example/v1",
    }),
    /正在生成回复/,
  );
  assert.equal(saves, 0);
  release?.();
  await turn;
});

test("persistent browser session restores visible messages and model context", async () => {
  const conversationDir = mkdtempSync(join(tmpdir(), "lawa-web-session-"));
  const zeroUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  try {
    const createStore = () => new WebSessionStore({
      conversationDir,
      fetchOverview: async () => overview(),
      createAgent: async (_context, _planning, emit, sessionManager) => ({
        prompt: async (text) => {
          sessionManager.appendMessage({
            role: "user",
            content: text,
            timestamp: Date.now(),
          });
          sessionManager.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: `回答：${text}` }],
            api: "openai-completions",
            provider: "test",
            model: "test-model",
            usage: zeroUsage,
            stopReason: "stop",
            timestamp: Date.now(),
          } as Message);
          emit({ type: "assistant_delta", delta: `回答：${text}` });
        },
        abort: async () => undefined,
        dispose: () => undefined,
      }),
    });

    const firstStore = createStore();
    const first = await firstStore.create();
    await firstStore.sendMessage(first.sessionId, "保留这一轮", () => undefined);
    firstStore.dispose();

    const restartedStore = createStore();
    const restored = await restartedStore.create();
    assert.equal(restored.sessionId, first.sessionId);
    assert.deepEqual(restored.messages.map(({ role, content }) => ({ role, content })), [
      { role: "user", content: "保留这一轮" },
      { role: "assistant", content: "回答：保留这一轮" },
    ]);
    assert.ok(restored.messages.every((item) => item.entryId));
    restartedStore.dispose();
  } finally {
    rmSync(conversationDir, { recursive: true, force: true });
  }
});

test("a new code worktree restores the original conversation namespace without rewriting history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-worktree-resume-"));
  const legacyCwd = join(directory, "old-worktree", "pi-agent");
  const legacy = new ConversationCatalog(directory, legacyCwd).create();
  legacy.appendMessage({role: "user", content: "existing learning message", timestamp: Date.now()});
  const original = readFileSync(legacy.getSessionFile()!, "utf8");
  const unrelated = new ConversationCatalog(directory, join(directory, "another-worktree")).create();
  const store = new WebSessionStore({
    conversationDir: directory,
    conversationCwd: legacyCwd,
    fetchOverview: async () => overview(),
  });
  try {
    assert.notEqual(process.cwd(), legacyCwd);
    const catalog = await store.listConversations();
    assert.deepEqual(catalog.sessions.map(item => item.id), [legacy.getSessionId()]);
    const restored = await store.create("resume-recent");
    assert.equal(restored.sessionId, legacy.getSessionId());
    assert.ok(restored.messages.some(item => item.content === "existing learning message"));
    assert.ok(readFileSync(legacy.getSessionFile()!, "utf8").startsWith(original));
    await assert.rejects(() => store.activateConversation(unrelated.getSessionId()));
  } finally {
    store.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});

test("explicit new browser session never reuses the active Pi message context", async () => {
  const conversationDir = mkdtempSync(join(tmpdir(), "lawa-new-web-session-"));
  try {
    const store = new WebSessionStore({
      conversationDir,
      fetchOverview: async () => overview(),
    });

    const first = await store.create();
    const second = await store.create("new");

    assert.notEqual(second.sessionId, first.sessionId);
    assert.deepEqual(second.messages, []);
    store.dispose();
  } finally {
    rmSync(conversationDir, { recursive: true, force: true });
  }
});

test("conversation library can switch, rename, and clear chat while keeping its learning goal", async () => {
  const conversationDir = mkdtempSync(join(tmpdir(), "lawa-session-library-"));
  try {
    const store = new WebSessionStore({
      conversationDir,
      fetchOverview: async () => overview(),
    });
    const first = await store.create("new");
    const second = await store.create("new");
    let catalog = await store.listConversations();
    assert.equal(catalog.sessions.length, 2);
    assert.equal(catalog.activeSessionId, second.sessionId);

    await store.renameConversation(first.sessionId, "第一段学习");
    const restored = await store.activateConversation(first.sessionId);
    assert.equal(restored.sessionId, first.sessionId);
    catalog = await store.listConversations();
    assert.equal(catalog.sessions.find((item) => item.id === first.sessionId)?.name, "第一段学习");

    const replacement = await store.clearConversation(first.sessionId);
    assert.notEqual(replacement.sessionId, first.sessionId);
    assert.notEqual(replacement.sessionId, second.sessionId);
    assert.deepEqual(replacement.messages, []);
    assert.equal((await store.listConversations()).sessions.length, 2);
    store.dispose();
  } finally {
    rmSync(conversationDir, { recursive: true, force: true });
  }
});

test("busy conversation rejects switching and deletion until the turn ends", async () => {
  const conversationDir = mkdtempSync(join(tmpdir(), "lawa-session-busy-library-"));
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const turnStarted = new Promise<void>((resolve) => { started = resolve; });
  try {
    const store = new WebSessionStore({
      conversationDir,
      fetchOverview: async () => overview(),
      createAgent: async (): Promise<LearningAgentSession> => ({
        prompt: async () => {
          started?.();
          await new Promise<void>((resolve) => { release = resolve; });
        },
        abort: async () => release?.(),
        dispose: () => undefined,
      }),
    });
    const first = await store.create("new");
    const second = await store.create("new");
    const turn = store.sendMessage(second.sessionId, "生成中", () => undefined);
    await turnStarted;
    await assert.rejects(store.activateConversation(first.sessionId), /正在生成回复/);
    await assert.rejects(store.deleteConversation(second.sessionId), /正在生成回复/);
    release?.();
    await turn;
    assert.equal((await store.activateConversation(first.sessionId)).sessionId, first.sessionId);
    store.dispose();
  } finally {
    rmSync(conversationDir, { recursive: true, force: true });
  }
});

test("mastery is a direct user action and never initializes the Agent", async () => {
  let createCount = 0;
  const actions: string[] = [];
  const store = new WebSessionStore({
    fetchOverview: async () => overview(),
    createAgent: async () => {
      createCount += 1;
      throw new Error("Agent must not be created for mastery");
    },
    skillAction: async (action, skillId) => {
      actions.push(`${action}:${skillId}`);
      return {
        id: skillId,
        name: "CNN",
        description: "",
        prerequisites: [],
        status: "MASTERED_BY_USER",
        evidence_ids: [],
      };
    },
  });
  const created = await store.create();
  await store.skillAction(created.sessionId, "master", "cnn");
  assert.equal(createCount, 0);
  assert.deepEqual(actions, ["master:cnn"]);
});

test("abandoning a replacement-blocking Task is also a direct user action", async () => {
  let createCount = 0;
  const abandoned: string[] = [];
  const store = new WebSessionStore({
    fetchOverview: async () => overview(),
    createAgent: async () => {
      createCount += 1;
      throw new Error("Agent must not be created for task abandonment");
    },
    taskAction: async (taskId) => {
      abandoned.push(taskId);
      return {
        id: taskId,
        title: "old task",
        description: "",
        related_skill_ids: ["cnn"],
        expected_evidence_types: [],
        status: "SKIPPED",
      };
    },
  });
  const created = await store.create();
  await store.abandonTask(created.sessionId, "task-old");
  assert.equal(createCount, 0);
  assert.deepEqual(abandoned, ["task-old"]);
});

test("no Goal starts onboarding and replacement remains explicit", async () => {
  let current = overview(null);
  const store = new WebSessionStore({ fetchOverview: async () => current });
  const created = await store.create();
  assert.equal(created.state.onboarding.status, "NEEDS_CLARIFICATION");

  current = overview("已有目标");
  await assert.rejects(
    store.startGoalOnboarding(created.sessionId, false),
    /Explicit replacement confirmation/,
  );
  const state = await store.startGoalOnboarding(created.sessionId, true);
  assert.equal(state.onboarding.replace_existing, true);
});
