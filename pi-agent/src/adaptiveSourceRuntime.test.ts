import {createTeachingFaux as createFauxCore} from "./testing/teachingFaux.js";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {ModelRuntime, SessionManager} from "@earendil-works/pi-coding-agent";
import {fauxAssistantMessage, fauxToolCall} from "@earendil-works/pi-ai";
import {createLearningAgentSession} from "./agentSession.js";
import {TeachingSessionContext} from "./teachingSession.js";
import {GoalOnboardingContext} from "./planning/goalOnboarding.js";
import {KernelSourceBackend} from "./retrieval/backend.js";
import {RetrievalRuntime} from "./retrieval/runtime.js";
import {RetrievalSettingsStore} from "./retrieval/settings.js";

test("real Pi hook and HTTP tool read 160K before index readiness, reuse once, invalidate edits without rewriting history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lawa-full-runtime-"));
  let version = "v1", fullCalls = 0, forbiddenCalls = 0;
  const body = () => (version === "v1" ? "ORIGINAL_FULL_MARKER" : "UPDATED_FULL_MARKER") + "完整资料".repeat(40_000);
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    const path = new URL(request.url!, "http://localhost").pathname;
    if (path === "/api/learning/teaching") {response.end(JSON.stringify({strategies: [], proposals: [], observations: []})); return;}
    if (path === "/api/learning/overview") {
      response.end(JSON.stringify({current_goal: "学习课程", goal_profile: {id: "goal"}, active_task: null,
        current_frontier: null, skills: [], current_goal_skill_ids: [], curriculum_spine: [],
        recent_evidence: [], knowledge_cards: [], learning_history: []}));
      return;
    }
    let input = "";
    for await (const chunk of request) input += chunk;
    const data = JSON.parse(input || "{}");
    if (path === "/api/learning/retrieval/full-context/validate") {
      response.end(JSON.stringify({valid_sources: data.sources.filter((r: {version: string}) => r.version === version)}));
    } else if (path === "/api/learning/retrieval/full-context") {
      fullCalls++;
      const already = data.known_sources.some((r: {version: string}) => r.version === version);
      response.end(JSON.stringify({mode: "full_context", complete: true, scope: "current", current_scope: "goal",
        new_tokens: already ? 0 : 161000, estimated_tokens: 161000, sources: [{
          source: {source_id: "material:one", version, kind: "material", name: "教材.txt", goal_id: "goal",
            goal_name: "学习课程", draft_session_id: null, skill_id: "", parse_status: "ready", warnings: []},
          ...(already ? {already_in_context: true} : {text: body()}),
          scope: "current", current_scope: "goal", citation: "教材.txt，第1-2行",
          citation_ref: "material:one:line:1-2", estimated_tokens: 161000, truncated: false}]}));
    } else {
      forbiddenCalls++; response.statusCode = 404; response.end("{}");
    }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const api = `http://127.0.0.1:${address.port}`;
  const sourceRuntime = new RetrievalRuntime(directory, new KernelSourceBackend(api),
    new RetrievalSettingsStore(join(directory, "settings.json"), join(directory, "profiles.json"), join(directory, "secrets.json")),
    () => {throw new Error("full route must not use retrieval models");});
  const faux = createFauxCore({tokensPerSecond: 0});
  const manager = SessionManager.inMemory();
  const search = (id: string) => fauxAssistantMessage(fauxToolCall("search_learning_sources", {query: "结合教材讲解"}, {id}), {stopReason: "toolUse"});
  faux.setResponses([
    () => search("first"),
    context => {
      assert.equal(JSON.stringify(context.messages).split("ORIGINAL_FULL_MARKER").length - 1, 1);
      assert.ok(JSON.stringify(context.messages).length > 128_000, "large original was truncated");
      assert.ok(context.systemPrompt!.includes("material:one:line:1-2"), "full read citation missing");
      return search("repeat");
    },
    context => {
      assert.equal(JSON.stringify(context.messages).split("ORIGINAL_FULL_MARKER").length - 1, 1);
      assert.ok(JSON.stringify(context.messages).includes("already_in_context"), "second query did not reuse live full body");
      return fauxAssistantMessage("依据教材完整内容讲解。来源：教材.txt，第1-2行。");
    },
    context => {
      assert.ok(!JSON.stringify(context).includes("ORIGINAL_FULL_MARKER"), "stale body remained in model input");
      assert.ok(JSON.stringify(context.messages).includes("full_context_expired"), "missing stale read marker");
      return search("updated");
    },
    context => {
      assert.ok(!JSON.stringify(context).includes("ORIGINAL_FULL_MARKER"), "stale body remained after update");
      assert.equal(JSON.stringify(context.messages).split("UPDATED_FULL_MARKER").length - 1, 1);
      return fauxAssistantMessage("已依据更新后的教材讲解。");
    },
  ]);
  const runtime = await ModelRuntime.create({authPath: join(directory, "auth.json"), modelsPath: null,
    modelsStorePath: join(directory, "models.json"), allowModelNetwork: false, refreshOnCreate: false});
  runtime.streamSimple = faux.streamSimple;
  runtime.hasConfiguredAuth = provider => provider === faux.getModel().provider;
  runtime.getAuth = async () => ({auth: {apiKey: "isolated-key"}, env: {}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  let session: Awaited<ReturnType<typeof createLearningAgentSession>> | undefined;
  const errors: string[] = [];
  try {
    session = await createLearningAgentSession(new TeachingSessionContext(), new GoalOnboardingContext(), {
      apiBaseUrl: api, model: {...faux.getModel(), contextWindow: 1_000_000, maxTokens: 8192}, modelRuntime: runtime,
      sessionManager: manager, retrieval: sourceRuntime, surface: "WEB",
      onEvent: event => {if (event.type === "model_error") errors.push(event.message);},
    });
    await session.prompt("请完整读取这份小教材");
    version = "v2";
    await session.prompt("教材已更新，请继续");
    assert.deepEqual(errors, []);
    assert.equal(faux.state.callCount, 7);
    assert.equal(fullCalls, 3);
    assert.equal(forbiddenCalls, 0);
    assert.match(JSON.stringify(manager.getBranch()), /ORIGINAL_FULL_MARKER/);
  } finally {
    session?.dispose();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    await rm(directory, {recursive: true, force: true});
  }
});
