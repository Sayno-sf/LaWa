import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";

import type { LearningAgentSession } from "../agentSession.js";
import type { LearningOverview } from "../learningOverviewTool.js";
import { createGateway } from "./gateway.js";
import {
  ProviderSettingsError,
  type ProviderSettingsCoordinator,
} from "./providerSettings.js";
import { WebSessionStore } from "./sessionStore.js";

function overview(): LearningOverview {
  return {
    current_goal: "理解 CNN",
    goal_profile: null,
    curriculum_spine: [],
    current_frontier: null,
    current_focus: null,
    skills: [],
    recent_evidence: [],
    active_task: null,
    learning_history: [],
    current_goal_skill_ids: [],
  };
}

function testModel(id: string): Model<Api> {
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

test("gateway streams assistant deltas, high-level trace, and refreshed state", async () => {
  const store = new WebSessionStore({
    fetchOverview: async () => overview(),
    createAgent: async (_context, _planning, emit): Promise<LearningAgentSession> => ({
      prompt: async () => {
        emit({ type: "tool_start", toolName: "get_learning_overview" });
        emit({ type: "tool_end", toolName: "get_learning_overview", isError: false });
        emit({ type: "assistant_delta", delta: "我们继续学习。" });
      },
      abort: async () => undefined,
      dispose: () => undefined,
    }),
  });
  const server = createGateway({ store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const createdResponse = await fetch(`${baseUrl}/api/web/sessions`, { method: "POST" });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()) as { sessionId: string };

    const response = await fetch(
      `${baseUrl}/api/web/sessions/${created.sessionId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "继续" }),
      },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/x-ndjson/);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; label?: string; delta?: string });
    assert.ok(events.some((event) => event.type === "trace" && /读取学习状态/.test(event.label ?? "")));
    assert.ok(events.some((event) => event.type === "assistant_delta" && event.delta === "我们继续学习。"));
    assert.ok(events.some((event) => event.type === "state"));
    assert.equal(events.at(-1)?.type, "done");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("gateway creates an isolated session for mode new and rejects unknown modes", async () => {
  const store = new WebSessionStore({ fetchOverview: async () => overview() });
  const server = createGateway({ store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const first = await fetch(`${baseUrl}/api/web/sessions`, { method: "POST" });
    const firstPayload = (await first.json()) as { sessionId: string };
    const second = await fetch(`${baseUrl}/api/web/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "new" }),
    });
    const secondPayload = (await second.json()) as { sessionId: string; messages: unknown[] };

    assert.equal(second.status, 201);
    assert.notEqual(secondPayload.sessionId, firstPayload.sessionId);
    assert.deepEqual(secondPayload.messages, []);

    const invalid = await fetch(`${baseUrl}/api/web/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "shared" }),
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.text()), /resume-recent|new/);
  } finally {
    store.dispose();
    server.close();
    await once(server, "close");
  }
});

test("gateway exposes conversation catalog lifecycle", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const conversationDir = mkdtempSync(join(tmpdir(), "lawa-gateway-library-"));
  const store = new WebSessionStore({
    conversationDir,
    fetchOverview: async () => overview(),
  });
  const server = createGateway({ store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const first = await (await fetch(`${baseUrl}/api/web/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "new" }),
    })).json() as { sessionId: string };
    const second = await (await fetch(`${baseUrl}/api/web/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "new" }),
    })).json() as { sessionId: string };

    let catalog = await (await fetch(`${baseUrl}/api/web/sessions`)).json() as {
      activeSessionId: string;
      sessions: Array<{ id: string; name: string }>;
    };
    assert.equal(catalog.sessions.length, 2);
    assert.equal(catalog.activeSessionId, second.sessionId);

    const renamed = await fetch(`${baseUrl}/api/web/sessions/${first.sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "旧目标讨论" }),
    });
    assert.equal(renamed.status, 200);
    const activated = await fetch(`${baseUrl}/api/web/sessions/${first.sessionId}/activate`, {
      method: "POST",
    });
    assert.equal(activated.status, 200);
    assert.equal(((await activated.json()) as { sessionId: string }).sessionId, first.sessionId);
    const removed = await fetch(`${baseUrl}/api/web/sessions/${first.sessionId}/clear`, {
      method: "POST",
    });
    assert.equal(removed.status, 200);
    assert.notEqual(((await removed.json()) as { sessionId: string }).sessionId, first.sessionId);
    catalog = await (await fetch(`${baseUrl}/api/web/sessions`)).json() as typeof catalog;
    assert.equal(catalog.sessions.length, 2);
  } finally {
    server.close();
    await once(server, "close");
    rmSync(conversationDir, { recursive: true, force: true });
  }
});

test("switching conversations restores their Goal, saved Task, route and cards through the user API", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const conversationDir = mkdtempSync(join(tmpdir(), "lawa-conversation-goal-view-"));
  const acoSkill = { id: "aco-basics", name: "ACO 基础", state: "MASTERED_BY_USER" };
  const rlSkill = { id: "rl-basics", name: "RL 基础", state: "LEARNING" };
  const acoCard = { id: "aco-card", skill_id: acoSkill.id, question: "ACO?", answer: "蚁群算法" };
  const rlCard = { id: "rl-card", skill_id: rlSkill.id, question: "RL?", answer: "强化学习" };
  let agentCalls = 0;
  let skillActions = 0;
  let current: LearningOverview = {
    ...overview(),
    current_goal: "学习 ACO",
    goal_profile: { id: "aco", goal_description: "学习 ACO" },
    curriculum_spine: [{ id: "aco-route", name: "ACO 路线" }],
    current_goal_skill_ids: [acoSkill.id],
    skills: [acoSkill],
    knowledge_cards: [acoCard],
    active_task: { id: "aco-task", title: "ACO task" },
  };
  const acoOverview = current;
  let rlOverview: LearningOverview;
  const kernel = createServer((request, response) => {
    if (request.url?.includes("/goals/aco/activate")) current = acoOverview;
    if (request.url?.includes("/goals/rl/activate")) current = rlOverview;
    response.writeHead(200, { "Content-Type": "application/json" }); response.end("{}");
  }).listen(0, "127.0.0.1");
  await once(kernel, "listening");
  const kernelAddress = kernel.address(); assert.ok(kernelAddress && typeof kernelAddress === "object");
  const apiBaseUrl = `http://127.0.0.1:${kernelAddress.port}`;
  const archivedProject = {
    status: "ARCHIVED" as const,
    goal_profile: { id: "aco", goal_description: "学习 ACO" },
    curriculum_spine: [{ id: "aco-route", name: "ACO 路线" }],
    skills: [acoSkill],
    evidence: [],
    knowledge_cards: [acoCard],
    archived_at: "2026-09-25T00:00:00Z",
  };
  const store = new WebSessionStore({
    conversationDir,
    apiBaseUrl,
    fetchOverview: async () => current,
    createAgent: async (_teaching, _planning, emit) => {
      agentCalls += 1;
      return { prompt: async () => { emit({ type: "assistant_delta", delta: "继续原任务" }); }, abort: async () => undefined, dispose: () => undefined };
    },
    skillAction: async () => {
      skillActions += 1;
      throw new Error("historical conversation must not mutate a Skill");
    },
    fetchLibrary: async () => ({ projects: [archivedProject, { ...archivedProject, goal_profile: { id: "rl", goal_description: "研究深度强化学习" } }] }),
  });
  const server = createGateway({ store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const first = await (await fetch(`${baseUrl}/api/web/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "new" }),
    })).json() as { sessionId: string };
    current = {
      ...current,
      current_goal: "研究深度强化学习",
      goal_profile: { id: "rl", goal_description: "研究深度强化学习" },
      curriculum_spine: [{ id: "rl-route", name: "RL 路线" }],
      current_goal_skill_ids: [rlSkill.id],
      skills: [acoSkill, rlSkill],
      knowledge_cards: [acoCard, rlCard],
      active_task: { id: "rl-task", title: "RL task" },
    };
    rlOverview = current;
    const second = await (await fetch(`${baseUrl}/api/web/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "new" }),
    })).json() as { sessionId: string };
    const response = await fetch(`${baseUrl}/api/web/sessions/${first.sessionId}/activate`, {
      method: "POST",
    });
    assert.equal(response.status, 200);
    const switched = await response.json() as {
      state: { overview: LearningOverview; view_mode?: string; active_goal_id?: string };
    };
    assert.equal(switched.state.view_mode, "CURRENT");
    assert.equal(switched.state.overview.current_goal, "学习 ACO");
    assert.deepEqual(switched.state.overview.curriculum_spine, [{ id: "aco-route", name: "ACO 路线" }]);
    assert.deepEqual(switched.state.overview.current_goal_skill_ids, [acoSkill.id]);
    assert.deepEqual(switched.state.overview.skills, [acoSkill]);
    assert.deepEqual(switched.state.overview.knowledge_cards, [acoCard]);
    assert.equal((switched.state.overview.active_task as { id: string }).id, "aco-task");
    assert.equal(switched.state.active_goal_id, "aco");
    assert.equal(current.current_goal, "学习 ACO", "selecting the conversation restores its Goal");
    assert.equal(agentCalls, 0, "navigation must not call the model");
    const continued = await fetch(`${baseUrl}/api/web/sessions/${first.sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "继续学 ACO" }),
    });
    assert.match(await continued.text(), /继续原任务/);
    assert.equal(agentCalls, 1);
    assert.equal(skillActions, 0);
    const currentResponse = await fetch(`${baseUrl}/api/web/sessions/${second.sessionId}/activate`, {
      method: "POST",
    });
    const returned = await currentResponse.json() as { state: { view_mode: string; overview: LearningOverview } };
    assert.equal(returned.state.view_mode, "CURRENT");
    assert.equal(returned.state.overview.current_goal, "研究深度强化学习");
    await store.renameConversation(first.sessionId, "ACO 历史对话");
    const restarted = new WebSessionStore({
      conversationDir,
      apiBaseUrl,
      fetchOverview: async () => current,
      fetchLibrary: async () => ({ projects: [archivedProject] }),
    });
    try {
      const resumed = await restarted.create("resume-recent");
      assert.equal(resumed.sessionId, first.sessionId);
      assert.equal(resumed.state.view_mode, "CURRENT", "restart restores the selected conversation's Goal");
      assert.equal(resumed.state.overview.current_goal, "学习 ACO");
    } finally {
      restarted.dispose();
    }
    current = rlOverview;
    const missingLibrary = new WebSessionStore({
      conversationDir,
      fetchOverview: async () => current,
      fetchLibrary: async () => { throw new Error("library temporarily unavailable"); },
    });
    try {
      const unavailable = await missingLibrary.create("resume-recent");
      assert.equal(unavailable.state.view_mode, "UNAVAILABLE");
      assert.equal(unavailable.state.overview.current_goal, "学习 ACO");
      assert.deepEqual(unavailable.state.overview.skills, [], "must not show RL skills under an ACO chat");
    } finally {
      missingLibrary.dispose();
    }
  } finally {
    store.dispose();
    server.close();
    kernel.close();
    await Promise.all([once(server, "close"), once(kernel, "close")]);
    rmSync(conversationDir, { recursive: true, force: true });
  }
});

test("gateway exposes the read-only Kernel learning library", async () => {
  const store = new WebSessionStore({
    fetchOverview: async () => overview(),
    fetchLibrary: async () => ({ projects: [] }),
  });
  const server = createGateway({ store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/web/learning-library`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { projects: [] });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("new-goal action in a fresh conversation explicitly arms replacement of an existing goal", async () => {
  const store = new WebSessionStore({ fetchOverview: async () => overview() });
  const server = createGateway({ store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const created = await fetch(`${baseUrl}/api/web/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "new" }),
    });
    const session = (await created.json()) as { sessionId: string };
    const response = await fetch(`${baseUrl}/api/web/sessions/${session.sessionId}/new-goal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replaceExisting: true }),
    });
    assert.equal(response.status, 200);
    const state = (await response.json()) as { onboarding: { status: string; replace_existing: boolean } };
    assert.equal(state.onboarding.status, "NEEDS_CLARIFICATION");
    assert.equal(state.onboarding.replace_existing, true);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("new-goal action preserves a confirmed legacy route in the same conversation", async () => {
  const profile = {
    id: "deep-rl-for-research",
    goal_description: "研究深度强化学习",
    background_summary: "学过 PyTorch",
    desired_outcome: "能够研究 RL 算法",
    learning_preferences: ["理论与实践结合"],
    time_constraint: "每周学习",
    prior_knowledge_claims: ["学过概率论"],
  };
  const store = new WebSessionStore({
    fetchOverview: async () => overview(),
    createAgent: async (_teaching, planning): Promise<LearningAgentSession> => ({
      prompt: async (text) => {
        if (text === "准备路线") {
          planning.start({ replaceExisting: false });
          planning.record({ outcome: "READY_FOR_CONFIRMATION", profile });
        } else if (text === "确认") {
          planning.record({ outcome: "CONFIRMED" });
        }
      },
      abort: async () => undefined,
      dispose: () => undefined,
    }),
  });
  const created = await store.create("new");
  await store.sendMessage(created.sessionId, "准备路线", () => undefined);
  await store.sendMessage(created.sessionId, "确认", () => undefined);
  const before = await store.state(created.sessionId);
  assert.equal(before.onboarding.status, "CONFIRMED");
  assert.equal(before.onboarding.replace_existing, false);
  const after = await store.startGoalOnboarding(created.sessionId, true);
  assert.equal(after.onboarding.status, "CONFIRMED");
  assert.equal(after.onboarding.replace_existing, true);
  assert.deepEqual(after.onboarding.pending_profile, profile);
});

test("explicit new-goal action recovers a previously confirmed route from the same saved conversation", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ConversationCatalog } = await import("./conversationCatalog.js");
  const directory = mkdtempSync(join(tmpdir(), "lawa-goal-recovery-"));
  const profile = {
    id: "deep-rl-for-research",
    goal_description: "研究深度强化学习",
    background_summary: "学过 PyTorch",
    desired_outcome: "能够研究 RL 算法",
    learning_preferences: ["理论与实践结合"],
    time_constraint: "每周学习",
    prior_knowledge_claims: ["学过概率论"],
  };
  try {
    const manager = new ConversationCatalog(directory).create();
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "confirmed-goal",
      toolName: "record_goal_understanding",
      content: [{ type: "text", text: JSON.stringify({
        status: "CONFIRMED",
        pending_profile: profile,
        missing_information: [],
        replace_existing: false,
      }) }],
      isError: false,
      timestamp: Date.now(),
    });
    const store = new WebSessionStore({
      conversationDir: directory,
      fetchOverview: async () => overview(),
    });
    const resumed = await store.create("resume-recent");
    assert.equal(resumed.state.onboarding.status, "IDLE", "history must not authorize replacement on its own");
    assert.equal(resumed.state.recoverable_confirmed_goal, true);
    const authorized = await store.startGoalOnboarding(resumed.sessionId, true);
    assert.equal(authorized.onboarding.status, "CONFIRMED");
    assert.equal(authorized.onboarding.replace_existing, true);
    assert.deepEqual(authorized.onboarding.pending_profile, profile);
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "initialized-goal",
      toolName: "initialize_learning_goal",
      content: [{ type: "text", text: "{}" }],
      isError: false,
      timestamp: Date.now(),
    });
    const completedStore = new WebSessionStore({
      conversationDir: directory,
      fetchOverview: async () => overview(),
    });
    const completed = await completedStore.create("resume-recent");
    assert.equal(completed.state.recoverable_confirmed_goal, false, "completed routes must not be offered for recovery");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provider settings routes return only redacted credential state", async () => {
  const receivedKeys: string[] = [];
  const profile = {
    id: "profile-a",
    name: "Example A",
    provider: "example",
    model: "model-a",
    baseUrl: "https://provider.example/v1",
    thinkingLevel: "medium" as const,
    maxOutputTokens: 8_192,
    hasApiKey: true,
    apiKeyHint: "••••1234",
  };
  const coordinator: ProviderSettingsCoordinator = {
    getPublicSettings: async () => ({
      activeProfileId: profile.id,
      active: profile,
      profiles: [profile],
    }),
    getActiveRuntime: async () => {
      throw new Error("not used");
    },
    testConnection: async (input) => {
      receivedKeys.push(input.apiKey ?? "");
      return { ok: true, provider: input.provider, model: input.model, message: "连接成功" };
    },
    saveAndUse: async (input) => {
      receivedKeys.push(input.apiKey ?? "");
      return {
        model: testModel(input.model),
        thinkingLevel: input.thinkingLevel ?? "off",
        settings: {
          activeProfileId: "profile-b",
          active: { provider: input.provider, model: input.model, baseUrl: input.baseUrl, thinkingLevel: input.thinkingLevel ?? "off", maxOutputTokens: input.maxOutputTokens ?? 8_192, hasApiKey: true, apiKeyHint: "••••5678" },
          profiles: [profile, { id: "profile-b", name: input.name ?? "Example B", provider: input.provider, model: input.model, baseUrl: input.baseUrl, thinkingLevel: input.thinkingLevel ?? "off", maxOutputTokens: input.maxOutputTokens ?? 8_192, hasApiKey: true, apiKeyHint: "••••5678" }],
        },
      };
    },
    activate: async () => ({
      model: testModel(profile.model),
      thinkingLevel: profile.thinkingLevel,
      settings: { activeProfileId: profile.id, active: profile, profiles: [profile] },
    }),
    delete: async () => ({ activeProfileId: profile.id, active: profile, profiles: [profile] }),
  };
  const store = new WebSessionStore({
    fetchOverview: async () => overview(),
    providerSettings: coordinator,
  });
  const server = createGateway({ store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const input = {
      provider: "example",
      model: "model-b",
      baseUrl: "https://provider.example/v1",
      apiKey: "sk-never-return-5678",
      thinkingLevel: "high",
      maxOutputTokens: 32_768,
    };
    const loaded = await (await fetch(`${baseUrl}/api/web/provider-settings`)).text();
    const tested = await (await fetch(`${baseUrl}/api/web/provider-settings/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })).text();
    const saved = await (await fetch(`${baseUrl}/api/web/provider-settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })).text();
    const activated = await (await fetch(`${baseUrl}/api/web/provider-settings/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "profile-a" }),
    })).text();
    const deleted = await (await fetch(`${baseUrl}/api/web/provider-settings`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "profile-b" }),
    })).text();

    assert.deepEqual(receivedKeys, [input.apiKey, input.apiKey]);
    assert.doesNotMatch(`${loaded}${tested}${saved}${activated}${deleted}`, /sk-never-return/);
    assert.match(saved, /••••5678/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("provider connection errors expose a stable code without raw provider details", async () => {
  const coordinator: ProviderSettingsCoordinator = {
    getPublicSettings: async () => ({ activeProfileId: null, active: { provider: "", model: "", baseUrl: "", thinkingLevel: "off", maxOutputTokens: 8_192, hasApiKey: false, apiKeyHint: null }, profiles: [] }),
    getActiveRuntime: async () => { throw new Error("not used"); },
    testConnection: async () => {
      throw new ProviderSettingsError("AUTHENTICATION_FAILED", "认证失败，请检查 API Key。", 401);
    },
    saveAndUse: async () => { throw new Error("not used"); },
    activate: async () => { throw new Error("not used"); },
    delete: async () => { throw new Error("not used"); },
  };
  const server = createGateway({
    store: new WebSessionStore({
      fetchOverview: async () => overview(),
      providerSettings: coordinator,
    }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/web/provider-settings/test`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "example",
          model: "model-a",
          baseUrl: "https://provider.example/v1",
          apiKey: "bad-secret",
        }),
      },
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      detail: "认证失败，请检查 API Key。",
      code: "AUTHENTICATION_FAILED",
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("typed /master is intercepted as a user action and never reaches the model", async () => {
  let current = overview();
  current.skills = [
    {
      id: "cnn",
      name: "CNN",
      description: "卷积神经网络",
      status: "LEARNING",
      target_depth: "PRACTICAL",
      evidence_ids: [],
    },
  ];
  let agentCreated = false;
  const actions: string[] = [];
  const store = new WebSessionStore({
    fetchOverview: async () => current,
    createAgent: async () => {
      agentCreated = true;
      throw new Error("typed user command must not reach the model");
    },
    skillAction: async (action, skillId) => {
      actions.push(`${action}:${skillId}`);
      current = {
        ...current,
        skills: [
          {
            id: skillId,
            name: "CNN",
            description: "卷积神经网络",
            status: "MASTERED_BY_USER",
            target_depth: "PRACTICAL",
            evidence_ids: [],
          },
        ],
      };
      return {
        id: skillId,
        name: "CNN",
        description: "卷积神经网络",
        prerequisites: [],
        status: "MASTERED_BY_USER",
        evidence_ids: [],
      };
    },
  });
  const server = createGateway({ store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const created = (await (
      await fetch(`${baseUrl}/api/web/sessions`, { method: "POST" })
    ).json()) as { sessionId: string };
    const response = await fetch(
      `${baseUrl}/api/web/sessions/${created.sessionId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "/master cnn" }),
      },
    );
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(agentCreated, false);
    assert.deepEqual(actions, ["master:cnn"]);
    assert.match(body, /MASTERED_BY_USER|已确认掌握/);
    assert.match(body, /"type":"state"/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("gateway returns a recoverable backend error without a stack trace", async () => {
  const store = new WebSessionStore({
    fetchOverview: async () => {
      throw new Error("fetch failed: ECONNREFUSED secret stack");
    },
  });
  const server = createGateway({ store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/web/sessions`, {
      method: "POST",
    });
    assert.equal(response.status, 503);
    const body = (await response.json()) as { detail: string };
    assert.match(body.detail, /Python Learning API/);
    assert.doesNotMatch(body.detail, /secret stack/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("model errors become recoverable stream errors and the same session can retry", async () => {
  let attempts = 0;
  const store = new WebSessionStore({
    fetchOverview: async () => overview(),
    createAgent: async (_context, _planning, emit): Promise<LearningAgentSession> => ({
      prompt: async () => {
        attempts += 1;
        if (attempts === 1) {
          emit({ type: "model_error", message: "provider secret stack" });
          return;
        }
        emit({ type: "assistant_delta", delta: "重试成功" });
      },
      abort: async () => undefined,
      dispose: () => undefined,
    }),
  });
  const server = createGateway({ store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const created = (await (
      await fetch(`${baseUrl}/api/web/sessions`, { method: "POST" })
    ).json()) as { sessionId: string };
    const send = (message: string) =>
      fetch(`${baseUrl}/api/web/sessions/${created.sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      }).then((response) => response.text());

    const failed = await send("第一次");
    assert.match(failed, /AI 模型本轮没有完成回复/);
    assert.doesNotMatch(failed, /provider secret stack/);
    const retried = await send("重试");
    assert.match(retried, /重试成功/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("output token limits explain why a partial answer stopped", async () => {
  const store = new WebSessionStore({
    fetchOverview: async () => overview(),
    createAgent: async (_context, _planning, emit): Promise<LearningAgentSession> => ({
      prompt: async () => {
        emit({ type: "assistant_delta", delta: "尚未写完的回答" });
        emit({ type: "output_limit" });
      },
      abort: async () => undefined,
      dispose: () => undefined,
    }),
  });
  const server = createGateway({ store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const created = (await (
      await fetch(`${baseUrl}/api/web/sessions`, { method: "POST" })
    ).json()) as { sessionId: string };
    const streamed = await (
      await fetch(`${baseUrl}/api/web/sessions/${created.sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "详细讲完" }),
      })
    ).text();
    assert.match(streamed, /尚未写完的回答/);
    assert.match(streamed, /最大输出 Tokens/);
    assert.match(streamed, /断点继续/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("stop generation aborts the active turn and keeps the browser session reusable", async () => {
  let releaseFirstTurn: (() => void) | undefined;
  let promptStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    promptStarted = resolve;
  });
  let attempts = 0;
  let aborts = 0;
  const store = new WebSessionStore({
    fetchOverview: async () => overview(),
    createAgent: async (_context, _planning, emit): Promise<LearningAgentSession> => ({
      prompt: async () => {
        attempts += 1;
        if (attempts === 1) {
          promptStarted?.();
          await new Promise<void>((resolve) => {
            releaseFirstTurn = resolve;
          });
          return;
        }
        emit({ type: "assistant_delta", delta: "停止后仍可继续" });
      },
      abort: async () => {
        aborts += 1;
        releaseFirstTurn?.();
      },
      dispose: () => undefined,
    }),
  });
  const server = createGateway({ store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const created = (await (
      await fetch(`${baseUrl}/api/web/sessions`, { method: "POST" })
    ).json()) as { sessionId: string };
    const send = (message: string) =>
      fetch(`${baseUrl}/api/web/sessions/${created.sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });

    const activeTurn = send("生成一个较长回答");
    await started;
    const stopped = await fetch(
      `${baseUrl}/api/web/sessions/${created.sessionId}/stop`,
      { method: "POST" },
    );
    assert.equal(stopped.status, 200);
    assert.deepEqual(await stopped.json(), { status: "stopped" });
    assert.equal(aborts, 1);
    assert.doesNotMatch(await (await activeTurn).text(), /"type":"error"/);

    const resumed = await send("继续");
    assert.match(await resumed.text(), /停止后仍可继续/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("gateway card feedback and note routes delegate to the store card action", async () => {
  const calls: Array<{ kind: string; cardId: string; body?: unknown }> = [];
  const store = new WebSessionStore({
    fetchOverview: async () => overview(),
    cardAction: async (kind, cardId, body) => {
      calls.push(body === undefined ? { kind, cardId } : { kind, cardId, body });
      if (kind === "feedback") return { id: cardId, feedback: (body as { status: string }).status };
      if (kind === "note-set") return { id: cardId, learner_note: (body as { note: string }).note };
      if (kind === "delete") return undefined;
      if (kind === "update") return { id: cardId, question: (body as { question: string }).question, answer: (body as { answer: string }).answer };
      return { id: cardId, learner_note: null };
    },
  });
  const server = createGateway({ store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const feedback = await fetch(`${baseUrl}/api/web/cards/card-1/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "GOOD" }),
    });
    assert.equal(feedback.status, 200);
    assert.deepEqual(await feedback.json(), { id: "card-1", feedback: "GOOD" });

    const note = await fetch(`${baseUrl}/api/web/cards/card-1/note`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "重点复习" }),
    });
    assert.equal(note.status, 200);
    assert.deepEqual(await note.json(), { id: "card-1", learner_note: "重点复习" });

    const cleared = await fetch(`${baseUrl}/api/web/cards/card-1/note`, {
      method: "DELETE",
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), { id: "card-1", learner_note: null });

    assert.deepEqual(calls, [
      { kind: "feedback", cardId: "card-1", body: { status: "GOOD" } },
      { kind: "note-set", cardId: "card-1", body: { note: "重点复习" } },
      { kind: "note-clear", cardId: "card-1" },
    ]);

    const deleted = await fetch(`${baseUrl}/api/web/cards/card-1`, { method: "DELETE" });
    assert.equal(deleted.status, 204);

    const updated = await fetch(`${baseUrl}/api/web/cards/card-1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "q2", answer: "a2" }),
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(await updated.json(), { id: "card-1", question: "q2", answer: "a2" });

    assert.deepEqual(calls.slice(3), [
      { kind: "delete", cardId: "card-1" },
      { kind: "update", cardId: "card-1", body: { question: "q2", answer: "a2" } },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("gateway card update route validates required question and answer", async () => {
  const store = new WebSessionStore({
    fetchOverview: async () => overview(),
    cardAction: async () => ({ id: "card-1" }),
  });
  const server = createGateway({ store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const missingQuestion = await fetch(`${baseUrl}/api/web/cards/card-1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "a" }),
    });
    assert.equal(missingQuestion.status, 400);

    const missingAnswer = await fetch(`${baseUrl}/api/web/cards/card-1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "q" }),
    });
    assert.equal(missingAnswer.status, 400);
  } finally {
    server.close();
  }
});

test("gateway card routes validate required body fields and propagate User API errors", async () => {
  const store = new WebSessionStore({
    fetchOverview: async () => overview(),
    cardAction: async () => {
      throw new Error("User API returned HTTP 409: Card already reviewed");
    },
  });
  const server = createGateway({ store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const missingStatus = await fetch(`${baseUrl}/api/web/cards/card-1/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(missingStatus.status, 400);
    assert.match(
      ((await missingStatus.json()) as { detail: string }).detail,
      /status/,
    );

    const missingNote = await fetch(`${baseUrl}/api/web/cards/card-1/note`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(missingNote.status, 400);
    assert.match(
      ((await missingNote.json()) as { detail: string }).detail,
      /note/,
    );

    const upstreamError = await fetch(`${baseUrl}/api/web/cards/card-1/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "GOOD" }),
    });
    assert.equal(upstreamError.status, 409);
    assert.deepEqual(await upstreamError.json(), {
      detail: "Card already reviewed",
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("teaching instructions API reads, trims, clears and rejects oversized input", async () => {
  const previous = process.env.TEACHING_INSTRUCTIONS_PATH;
  process.env.TEACHING_INSTRUCTIONS_PATH = join(await mkdtemp(join(tmpdir(), "lawa-gateway-instructions-")), "instructions.json");
  const server = createGateway({ store: new WebSessionStore({ fetchOverview: async () => overview() }) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const empty = await fetch(`${baseUrl}/api/web/teaching-instructions`);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { text: "", updatedAt: null, maxChars: 4000 });

    const saved = await fetch(`${baseUrl}/api/web/teaching-instructions`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "  先用真实例子，再讲规则。  " }),
    });
    assert.equal(saved.status, 200);
    const savedBody = (await saved.json()) as { text: string; maxChars: number };
    assert.equal(savedBody.text, "先用真实例子，再讲规则。");
    assert.equal(savedBody.maxChars, 4000);

    const reread = await fetch(`${baseUrl}/api/web/teaching-instructions`);
    assert.equal(((await reread.json()) as { text: string }).text, savedBody.text);

    const invalid = await fetch(`${baseUrl}/api/web/teaching-instructions`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: 42 }),
    });
    assert.equal(invalid.status, 400);
    const tooLong = await fetch(`${baseUrl}/api/web/teaching-instructions`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "字".repeat(4001) }),
    });
    assert.equal(tooLong.status, 400);
    assert.match(((await tooLong.json()) as { detail: string }).detail, /4000/);

    const cleared = await fetch(`${baseUrl}/api/web/teaching-instructions`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "" }),
    });
    assert.equal(((await cleared.json()) as { text: string }).text, "");
  } finally {
    server.close();
    if (previous === undefined) delete process.env.TEACHING_INSTRUCTIONS_PATH;
    else process.env.TEACHING_INSTRUCTIONS_PATH = previous;
  }
});
