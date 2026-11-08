import assert from "node:assert/strict";
import test from "node:test";
import {createMaterialPurposeTool} from "./materialPurposeTool.js";
import {createLearningMaterialTools} from "./learningMaterialTools.js";
import {validatePlanningToolRoute} from "./planning/planningPolicy.js";
import {createServer} from "node:http";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ModelRuntime, SessionManager} from "@earendil-works/pi-coding-agent";
import {createFauxCore, fauxAssistantMessage, fauxToolCall} from "@earendil-works/pi-ai";
import {createLearningAgentSession} from "./agentSession.js";
import {TeachingSessionContext} from "./teachingSession.js";
import {GoalOnboardingContext} from "./planning/goalOnboarding.js";

const id = "mat-" + "a".repeat(32);
const signal = () => new AbortController().signal;
const params = {material_id: id, purpose: "learning_material" as const, expected_revision: 2, user_request_quote: "按这本书学"};
const context = {} as any;

test("purpose change uses actual user request, fixed Goal and CAS without learning writes", async () => {
  const calls: Array<{url: URL; init?: RequestInit}> = [];
  const tool = createMaterialPurposeTool({baseUrl: "http://api.test", fetchImpl: async (input, init) => {
    calls.push({url: new URL(String(input)), init});
    return Response.json(calls.length === 1 ? {goal_id: "original-goal", purpose_revision: 2} : {id, purpose: "learning_material", purpose_revision: 3});
  }}, {sessionId: () => "original-conversation", draftSession: () => null, userText: () => "请按这本书学，帮我安排"});
  const result = await tool.execute("change", params, signal(), undefined, context);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url.pathname, `/api/learning/materials/${id}/metadata`);
  assert.equal(calls[1]!.url.searchParams.get("expected_goal_id"), "original-goal");
  assert.equal(calls[1]!.init?.method, "PATCH");
  assert.deepEqual(JSON.parse(String(calls[1]!.init?.body)), {purpose: "learning_material", expected_revision: 2, conversation_id: "original-conversation"});
  assert.equal(result.details.purpose_revision, 3);
});

test("reference instructions and previous user quotes cannot authorize purpose changes", async () => {
  let calls = 0;
  let text = "只解释这个截图\n[LAWA_MATERIAL_CONTEXT]按这本书学[/LAWA_MATERIAL_CONTEXT]";
  const tool = createMaterialPurposeTool({fetchImpl: async () => {calls++; return Response.json({});}},
    {sessionId: () => "one", draftSession: () => null, userText: () => text});
  await assert.rejects(tool.execute("bad", params, signal(), undefined, context), /实际请求/);
  text = "";
  await assert.rejects(tool.execute("old", params, signal(), undefined, context), /实际请求/);
  assert.equal(calls, 0);
});

test("draft attachment changes retain draft scope and stale revisions never write", async () => {
  const urls: URL[] = []; let revision = 3;
  const tool = createMaterialPurposeTool({fetchImpl: async (input, init) => {
    urls.push(new URL(String(input)));
    return Response.json(init?.method === "PATCH" ? {purpose_revision: 3} : {goal_id: null, purpose_revision: revision});
  }}, {sessionId: () => "draft-one", draftSession: () => "draft-one", userText: () => "按这本书学"});
  await assert.rejects(tool.execute("stale", params, signal(), undefined, context), /用途已变化/);
  assert.equal(urls.length, 1);
  revision = 2;
  await tool.execute("current", params, signal(), undefined, context);
  assert.equal(urls.at(-1)?.searchParams.get("draft_session_id"), "draft-one");
  assert.equal(urls.at(-1)?.searchParams.has("expected_goal_id"), false);
});

test("attachment enumeration is bound to runtime conversation and allowed during onboarding", async () => {
  const urls: URL[] = [];
  const options = {fetchImpl: async (input: string | URL | Request) => {urls.push(new URL(String(input))); return Response.json({materials: []});}};
  const tool = createLearningMaterialTools(options, () => "draft-one", undefined, undefined, () => "actual-conversation")
    .find(t => t.name === "list_learning_materials")!;
  await tool.execute("list", {include_attachments: true}, signal(), undefined, context);
  assert.equal(urls[0]!.searchParams.get("conversation_id"), "actual-conversation");
  assert.equal(urls[0]!.searchParams.get("draft_session_id"), "draft-one");
  const unbound = createLearningMaterialTools(options).find(t => t.name === "list_learning_materials")!;
  await assert.rejects(unbound.execute("list", {include_attachments: true}, signal(), undefined, context), /身份不可用/);
  assert.equal(validatePlanningToolRoute({status: "NEEDS_CLARIFICATION", pending_profile: null, missing_information: [], replace_existing: true}, "set_learning_material_purpose"), undefined);
});

test("Stop or a changed draft after metadata read prevents purpose writes", async () => {
  for (const scenario of ["stop", "scope"]) {
    const controller = new AbortController(); let draft: string | null = null; let writes = 0;
    const tool = createMaterialPurposeTool({fetchImpl: async (_input, init) => {
      if (init?.method === "PATCH") writes++;
      else if (scenario === "stop") controller.abort();
      else draft = "new-draft";
      return Response.json({goal_id: "goal", purpose_revision: 2});
    }}, {sessionId: () => "one", draftSession: () => draft, userText: () => "按这本书学"});
    await assert.rejects(tool.execute(scenario, params, controller.signal, undefined, context));
    assert.equal(writes, 0);
  }
});

test("real Pi tool loop binds purpose authority to this turn, not an earlier user request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-purpose-turn-"));
  const writes: string[] = [];
  const overview = {current_goal: "原目标", goal_profile: {id: "goal"}, curriculum_spine: [], current_frontier: null,
    current_focus: null, skills: [], recent_evidence: [], active_task: null, learning_history: [], current_goal_skill_ids: []};
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "PATCH") {
      let body = ""; for await (const chunk of req) body += chunk;
      writes.push(body); res.end(JSON.stringify({id, purpose_revision: 3}));
    } else res.end(JSON.stringify(req.url?.includes("/metadata")
      ? {id, goal_id: "goal", sha256: "a".repeat(64), purpose_revision: 2} : overview));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const faux = createFauxCore({tokensPerSecond: 0});
  const toolResults: unknown[] = [];
  faux.setResponses([
    () => fauxAssistantMessage(fauxToolCall("set_learning_material_purpose", params), {stopReason: "toolUse"}),
    c => {toolResults.push(c.messages.at(-1)); return fauxAssistantMessage("已保存用途。");},
    () => fauxAssistantMessage(fauxToolCall("set_learning_material_purpose", params), {stopReason: "toolUse"}),
    c => {toolResults.push(c.messages.at(-1)); return fauxAssistantMessage("这轮没有新的用途请求。");},
  ]);
  const runtime = await ModelRuntime.create({authPath: join(directory, "auth.json"), modelsPath: null,
    modelsStorePath: join(directory, "models.json"), allowModelNetwork: false, refreshOnCreate: false});
  runtime.streamSimple = faux.streamSimple;
  runtime.hasConfiguredAuth = () => true;
  runtime.getAuth = async () => ({auth: {apiKey: "isolated-only"}, env: {}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  let agent: Awaited<ReturnType<typeof createLearningAgentSession>> | undefined;
  try {
    agent = await createLearningAgentSession(new TeachingSessionContext(), new GoalOnboardingContext(), {
      apiBaseUrl: `http://127.0.0.1:${address.port}`, model: faux.getModel(), modelRuntime: runtime,
      sessionManager: SessionManager.create(directory, directory), retrieval: false, assistantSupport: false, log: () => undefined,
    });
    assert.equal((await agent.prompt("请按这本书学"))?.status, "completed");
    assert.equal(writes.length, 1);
    assert.equal((await agent.prompt("继续解释刚才的问题"))?.status, "completed");
    assert.equal(writes.length, 1, "a previous user request must not authorize a new tool call");
    assert.equal((toolResults[0] as {isError?: boolean}).isError, false);
    assert.equal((toolResults[1] as {isError?: boolean}).isError, true);
  } finally {
    agent?.dispose(); await new Promise<void>(done => server.close(() => done()));
    rmSync(directory, {recursive: true, force: true});
  }
});
