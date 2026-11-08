import {createTeachingFaux as createFauxCore} from "./testing/teachingFaux.js";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import test from "node:test";
import {ModelRuntime, SessionManager} from "@earendil-works/pi-coding-agent";
import {fauxAssistantMessage, fauxToolCall, fauxThinking, type Context, type ToolResultMessage} from "@earendil-works/pi-ai";
import {createLearningAgentSession} from "./agentSession.js";
import {TeachingSessionContext} from "./teachingSession.js";
import {GoalOnboardingContext} from "./planning/goalOnboarding.js";
import {streamSimple as openAiStream} from "@earendil-works/pi-ai/api/openai-completions";

const answer = "5\n23\n因为第二个是字符3，字符遇到加法运算则按叠加计算。";
const question = "function add(a, b) { return a + b; }\nconsole.log(add(2, 3));\nconsole.log(add(2, \"3\"));\n两行分别打印什么？";
const text = (message: {role?: string; content?: unknown}) => typeof message.content === "string" ? message.content
  : Array.isArray(message.content) ? message.content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
const isRuntimeState = (message: {role?: string; content?: unknown}) => message.role === "user" && text(message).startsWith("[LAWA_RUNTIME_STATE]\n");
const actualUser = (context: Context) => context.messages.findLast(message => message.role === "user" && !isRuntimeState(message));
const runtimeInput = (context: Context) => (context.systemPrompt ?? "") + "\n" + context.messages.filter(isRuntimeState).map(text).join("\n");

test("shared stream removes closed reasoning, preserves current tool-chain reasoning and Pi history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-turn-runtime-"));
  const api = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({current_goal: "读懂 JS", goal_profile: {id: "goal"}, current_focus: null,
      current_frontier: {focus_skill_id: "syntax", supporting_skill_ids: []},
      active_task: {id: "task", status: "ACTIVE", related_skill_ids: ["syntax"]},
      skills: [{id: "syntax", name: "JS 语法", status: "LEARNING"}], current_goal_skill_ids: ["syntax"],
      curriculum_spine: [], recent_evidence: [], knowledge_cards: [], learning_history: []}));
  });
  await new Promise<void>(done => api.listen(0, "127.0.0.1", done));
  const address = api.address(); assert.ok(address && typeof address !== "string");
  const manager = SessionManager.inMemory();
  manager.appendMessage({role: "user", content: "undefined 5000\nlocalhost 8080", timestamp: 1});
  manager.appendMessage(fauxAssistantMessage(fauxToolCall("record_teaching_turn", {}, {id: "old-teaching"}), {stopReason: "toolUse"}));
  const oldSnapshot: ToolResultMessage = {role: "toolResult", toolName: "record_teaching_turn", toolCallId: "old-teaching",
    content: [{type: "text", text: JSON.stringify({current_question: "OLD_HOST_QUESTION", candidate_evidence: null})}], isError: false, timestamp: 2};
  manager.appendMessage(oldSnapshot);
  manager.appendMessage(fauxAssistantMessage([fauxThinking("STALE_PRIVATE"), {type: "text", text: question}]));
  const original = structuredClone(manager.getBranch());
  const faux = createFauxCore({api: "openai-completions", provider: "aliyun-bailian",
    models: [{id: "qwen3.8-flash", contextWindow: 128000, maxTokens: 32768}], tokensPerSecond: 0});
  const assertCurrentTurn = (context: Context) => {
    assert.doesNotMatch(JSON.stringify(context), /STALE_PRIVATE/);
    assert.match(runtimeInput(context), /本轮问答定位/);
    const latest = actualUser(context);
    assert.ok(latest && Array.isArray(latest.content));
    assert.equal((latest.content[0] as {text: string}).text, answer);
    assert.equal(latest.content.length, 2, "Bounded low-trust question reference follows the unchanged original answer");
    assert.ok(context.messages.some(message => message.role === "assistant" && text(message).endsWith(question)));
    const historical = context.messages.find(message => message.role === "toolResult" && message.toolCallId === "old-teaching");
    assert.ok(historical);
    assert.deepEqual(JSON.parse(text(historical)).historical_teaching_snapshot, JSON.parse(text(oldSnapshot)));
    assert.doesNotMatch(context.systemPrompt ?? "", /function add|字符3|OLD_HOST_QUESTION/,
      "Actual learner/teacher text must remain in low-trust messages");
  };
  faux.setResponses([
    context => {
      assertCurrentTurn(context);
      return fauxAssistantMessage([fauxThinking("CURRENT_CHAIN"), fauxToolCall("get_learning_overview", {}, {id: "current-overview"})], {stopReason: "toolUse"});
    },
    context => {assertCurrentTurn(context); assert.match(JSON.stringify(context), /CURRENT_CHAIN/);
      return fauxAssistantMessage("5 和 23，你对字符串拼接的解释也正确。");},
    context => {
      const latest = actualUser(context);
      assert.ok(latest && Array.isArray(latest.content));
      assert.equal((latest.content[0] as {text: string}).text, "请回看刚才的解构题，解释 host 为什么存在。");
      assert.doesNotMatch(JSON.stringify(context), /CURRENT_CHAIN|STALE_PRIVATE/);
      assert.ok(context.messages.some(message => message.role === "assistant" && /5 和 23/.test(text(message))));
      return fauxAssistantMessage("可以回看解构题。");
    },
  ]);
  const runtime = await ModelRuntime.create({authPath: join(directory, "auth.json"), modelsPath: null,
    modelsStorePath: join(directory, "models.json"), allowModelNetwork: false, refreshOnCreate: false});
  runtime.streamSimple = faux.streamSimple;
  runtime.hasConfiguredAuth = provider => provider === faux.getModel().provider;
  runtime.getAuth = async () => ({auth: {apiKey: "isolated-faux-key"}, env: {}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  const errors: string[] = [];
  let agent: Awaited<ReturnType<typeof createLearningAgentSession>> | undefined;
  try {
    agent = await createLearningAgentSession(new TeachingSessionContext(), new GoalOnboardingContext(), {
      model: faux.getModel(), modelRuntime: runtime, sessionManager: manager, retrieval: false, assistantSupport: false,
      apiBaseUrl: `http://127.0.0.1:${address.port}`, surface: "WEB", log: () => undefined,
      onEvent: event => {if (event.type === "model_error") errors.push(event.message);},
    });
    await agent.prompt(answer);
    assert.deepEqual(errors, []);
    assert.equal(faux.state.callCount, 3);
    assert.deepEqual(manager.getBranch().slice(0, original.length), original);
    const storedAnswer = manager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user" && text(entry.message) === answer);
    assert.ok(storedAnswer?.type === "message");
    assert.doesNotMatch(text(storedAnswer.message), /LAWA_CURRENT_TURN_REFERENCE/);
    await agent.prompt("请回看刚才的解构题，解释 host 为什么存在。");
    assert.deepEqual(errors, []);
    assert.equal(faux.state.callCount, 5);
  } finally {
    agent?.dispose();
    api.closeAllConnections();
    await new Promise<void>(done => api.close(() => done()));
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("lawa-turn-runtime-"));
    rmSync(directory, {recursive: true, force: true});
  }
});

test("actual SDK HTTP payload clears old reasoning and replays current Qwen tool continuation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-wire-runtime-"));
  const requests: Array<{messages: Array<{role: string; content: unknown; reasoning_content?: string; tool_call_id?: string}>}> = [];
  const server = createServer(async (request, response) => {
    if (request.url !== "/v1/chat/completions") {response.setHeader("Content-Type", "application/json"); response.end("{}"); return;}
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.setHeader("Content-Type", "text/event-stream");
    const first = requests.length === 1;
    const delta = first ? {reasoning_content: "CURRENT_WIRE_CHAIN", tool_calls: [{index: 0, id: "wire-call", type: "function", function: {name: "get_learning_overview", arguments: "{}"}}]}
      : {content: "5和23正确，因为字符串拼接。"};
    response.write(`data: ${JSON.stringify({id: "wire-response", choices: [{index: 0, delta, finish_reason: null}]})}\n\n`);
    response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop"}], usage: {prompt_tokens: 1000, completion_tokens: 30, total_tokens: 1030}})}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const model = {...createFauxCore({api: "openai-completions", provider: "aliyun-bailian", models: [{id: "qwen3.8-flash", reasoning: true, contextWindow: 128000, maxTokens: 32768}]}).getModel(),
    baseUrl: `http://127.0.0.1:${address.port}/v1`, compat: {supportsDeveloperRole: false}};
  const manager = SessionManager.inMemory();
  manager.appendMessage({role: "user", content: "旧题", timestamp: 1});
  manager.appendMessage({...fauxAssistantMessage([fauxThinking("STALE_WIRE_PRIVATE"), {type: "text", text: question}]), api: model.api, provider: model.provider, model: model.id});
  const original = structuredClone(manager.getBranch());
  const runtime = await ModelRuntime.create({authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models.json"), allowModelNetwork: false, refreshOnCreate: false});
  runtime.streamSimple = (selected, context, options) => openAiStream(selected as Parameters<typeof openAiStream>[0], context, {...options, apiKey: "local-wire-only"});
  runtime.hasConfiguredAuth = () => true;
  runtime.getAuth = async () => ({auth: {apiKey: "local-wire-only"}, env: {}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  const errors: string[] = [];
  let agent: Awaited<ReturnType<typeof createLearningAgentSession>> | undefined;
  try {
    agent = await createLearningAgentSession(new TeachingSessionContext(), new GoalOnboardingContext(), {model, modelRuntime: runtime, sessionManager: manager,
      apiBaseUrl: `http://127.0.0.1:${address.port}`, assistantSupport: false, retrieval: false, log: () => undefined,
      onEvent: event => {if (event.type === "model_error") errors.push(event.message);}});
    await agent.prompt(answer);
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 2);
    assert.doesNotMatch(JSON.stringify(requests), /STALE_WIRE_PRIVATE/);
    assert.equal(requests[1]!.messages.find(message => message.reasoning_content)?.reasoning_content, "CURRENT_WIRE_CHAIN");
    assert.ok(requests[1]!.messages.some(message => message.tool_call_id === "wire-call"));
    const actualAnswer = requests[0]!.messages.findLast(message => message.role === "user" && !text(message).startsWith("[LAWA_RUNTIME_STATE]"));
    assert.deepEqual((actualAnswer?.content as unknown[])[0], {type: "text", text: answer});
    await agent.prompt("回看旧题");
    assert.equal(requests.length, 3);
    assert.doesNotMatch(JSON.stringify(requests[2]), /CURRENT_WIRE_CHAIN|STALE_WIRE_PRIVATE/);
    assert.deepEqual(manager.getBranch().slice(0, original.length), original);
  } finally {
    agent?.dispose(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith("lawa-wire-runtime-"));
    rmSync(directory, {recursive: true, force: true});
  }
});

test("Go HTTP payload keeps a reusable history prefix while refreshed runtime state stays at the tail", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-go-cache-runtime-"));
  type WireMessage = {role: string; content: unknown; reasoning_content?: string; tool_call_id?: string};
  const requests: Array<{messages: WireMessage[]; tools: unknown; max_tokens?: number}> = [];
  const capacities: number[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/api/learning/overview") {
      response.setHeader("Content-Type", "application/json");
      const task = requests.length ? "AFTER_TASK" : "BEFORE_TASK";
      response.end(JSON.stringify({current_goal: "读懂 JS", goal_profile: {id: "goal"}, current_focus: null,
        active_task: {id: task, status: "ACTIVE", related_skill_ids: ["syntax"]},
        current_frontier: {focus_skill_id: "syntax", supporting_skill_ids: []},
        skills: [{id: "syntax", name: "JS 语法", status: "LEARNING"}], current_goal_skill_ids: ["syntax"],
        curriculum_spine: [], recent_evidence: [], knowledge_cards: [], learning_history: []}));
      return;
    }
    if (request.url !== "/v1/chat/completions") {response.setHeader("Content-Type", "application/json"); response.end("{}"); return;}
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.setHeader("Content-Type", "text/event-stream");
    const first = requests.length === 1;
    const preparing = !first && (requests.at(-1)!.tools as Array<{function:{name:string}}> | undefined)?.some(t => t.function.name === "begin_teacher_reply");
    const delta = first ? {reasoning_content: "CURRENT_GO_CHAIN", tool_calls: [{index: 0, id: "go-wire-call", type: "function", function: {name: "get_learning_overview", arguments: "{}"}}]}
      : preparing ? {tool_calls: [{index:0,id:"begin",type:"function",function:{name:"begin_teacher_reply",arguments:"{}"}}]} : {content: "5和23正确，因为字符串拼接。"};
    response.write(`data: ${JSON.stringify({id: "go-response", choices: [{index: 0, delta, finish_reason: null}]})}\n\n`);
    response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {}, finish_reason: first || preparing ? "tool_calls" : "stop"}], usage: {prompt_tokens: 1000, completion_tokens: 30, total_tokens: 1030}})}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const local = `http://127.0.0.1:${address.port}`;
  const model = {...createFauxCore({api: "openai-completions", provider: "opencode-go",
    models: [{id: "deepseek-v4.1-flash", reasoning: true, contextWindow: 1_000_000, maxTokens: 32768}]}).getModel(),
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
    compat: {supportsDeveloperRole: false, requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" as const}};
  const manager = SessionManager.inMemory();
  manager.appendMessage({role: "user", content: "上一题的真实回答", timestamp: 1});
  manager.appendMessage({...fauxAssistantMessage([fauxThinking("OLD_QWEN_THINKING_MUST_NOT_BECOME_TEXT"), {type: "text", text: question}]),
    api: "openai-completions", provider: "aliyun-bailian", model: "qwen3.8-flash"});
  const original = structuredClone(manager.getBranch());
  const runtime = await ModelRuntime.create({authPath: join(directory, "auth.json"), modelsPath: null,
    modelsStorePath: join(directory, "models.json"), allowModelNetwork: false, refreshOnCreate: false});
  runtime.streamSimple = (selected, context, options) => {
    capacities.push(selected.contextWindow);
    // 使用真实SDK序列化，但fetch固定转到隔离本地端点；不会向Go发送请求或读取真实密钥。
    return openAiStream(selected as Parameters<typeof openAiStream>[0], context,
      {...options, apiKey: "local-go-wire-only", fetch: async (_url, init) => fetch(`${local}/v1/chat/completions`, init)});
  };
  runtime.hasConfiguredAuth = () => true;
  runtime.getAuth = async () => ({auth: {apiKey: "local-go-wire-only"}, env: {}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  const errors: string[] = [];
  let agent: Awaited<ReturnType<typeof createLearningAgentSession>> | undefined;
  try {
    agent = await createLearningAgentSession(new TeachingSessionContext(), new GoalOnboardingContext(), {
      model, modelRuntime: runtime, sessionManager: manager, apiBaseUrl: local,
      surface: "WEB", assistantSupport: false, retrieval: false, log: () => undefined,
      onEvent: event => {if (event.type === "model_error") errors.push(event.message);},
    });
    await agent.prompt(answer);
    assert.deepEqual(errors, []); assert.equal(requests.length, 3);
    assert.doesNotMatch(JSON.stringify(requests), /OLD_QWEN_THINKING_MUST_NOT_BECOME_TEXT/);
    const first = requests[0]!, second = requests[1]!;
    assert.match(text(first.messages.at(-1)!), /^\[LAWA_RUNTIME_STATE\]\n/);
    assert.match(text(first.messages.at(-1)!), /BEFORE_TASK/);
    assert.match(text(second.messages.at(-1)!), /AFTER_TASK/);
    assert.doesNotMatch(text(second.messages.at(-1)!), /BEFORE_TASK/);
    assert.deepEqual(second.messages.slice(0, first.messages.length - 1), first.messages.slice(0, -1),
      "工具后刷新状态不能重写系统策略和已发送的历史前缀");
    assert.deepEqual(second.tools, first.tools);
    assert.ok(second.messages.some(message => message.reasoning_content === "CURRENT_GO_CHAIN"));
    assert.ok(second.messages.some(message => message.tool_call_id === "go-wire-call"));
    assert.deepEqual(capacities, [1_000_000, 1_000_000, 1_000_000]);
    assert.deepEqual(manager.getBranch().slice(0, original.length), original);
    assert.doesNotMatch(JSON.stringify(manager.getBranch()), /LAWA_RUNTIME_STATE|LAWA_CURRENT_TURN_REFERENCE/,
      "临时模型输入不能作为用户原文写回Pi历史");
    await agent.prompt("回看上一题");
    assert.equal(requests.length, 5);
    assert.doesNotMatch(JSON.stringify(requests[3]), /CURRENT_GO_CHAIN|OLD_QWEN_THINKING_MUST_NOT_BECOME_TEXT/);
    assert.equal(requests[2]!.messages.filter(message => text(message).startsWith("[LAWA_RUNTIME_STATE]")).length, 1,
      "下一轮只携带当前状态，不能累计旧状态副本");
  } finally {
    agent?.dispose(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith("lawa-go-cache-runtime-"));
    rmSync(directory, {recursive: true, force: true});
  }
});

test("actual SDK HTTP payload explicitly forbids tool selection during public teacher speech", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-teacher-tool-choice-"));
  type Request = {tools?: Array<{function: {name: string}}>; tool_choice?: unknown};
  const requests: Request[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url !== "/v1/chat/completions") {
      response.end(JSON.stringify({current_goal: "读懂检索", goal_profile: {id: "goal"}, current_focus: null,
        active_task: {id: "task", status: "ACTIVE", related_skill_ids: ["retrieval"]},
        current_frontier: {focus_skill_id: "retrieval", supporting_skill_ids: []},
        skills: [{id: "retrieval", name: "向量检索", status: "LEARNING"}], current_goal_skill_ids: ["retrieval"],
        curriculum_spine: [], recent_evidence: [], knowledge_cards: [], learning_history: []}));
      return;
    }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.setHeader("Content-Type", "text/event-stream");
    const preparing = requests.length === 1;
    const deltas = preparing ? [{tool_calls: [{index: 0, id: "begin", type: "function",
      function: {name: "begin_teacher_reply", arguments: "{}"}}]}] : [{content: "检索器取得相关片段。"}, {content: "随后将片段放进模型上下文。"}];
    for (const delta of deltas) response.write(`data: ${JSON.stringify({id: "tool-choice-wire", choices: [{index: 0, delta, finish_reason: null}]})}\n\n`);
    response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {}, finish_reason: preparing ? "tool_calls" : "stop"}],
      usage: {prompt_tokens: 500, completion_tokens: 30, total_tokens: 530}})}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const model = {...createFauxCore({api: "openai-completions", provider: "opencode-go",
    models: [{id: "deepseek-v4.1-flash", reasoning: true, contextWindow: 1_000_000, maxTokens: 32768}]}).getModel(),
    baseUrl: `${baseUrl}/v1`, compat: {supportsDeveloperRole: false, requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek" as const}};
  const runtime = await ModelRuntime.create({authPath: join(directory, "auth.json"), modelsPath: null,
    modelsStorePath: join(directory, "models.json"), allowModelNetwork: false, refreshOnCreate: false});
  runtime.streamSimple = (selected, context, options) => openAiStream(selected as Parameters<typeof openAiStream>[0], context,
    {...options, apiKey: "isolated-local-wire-only"});
  runtime.hasConfiguredAuth = () => true;
  runtime.getAuth = async () => ({auth: {apiKey: "isolated-local-wire-only"}, env: {}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  const errors: string[] = [], deltas: string[] = [];
  let agent: Awaited<ReturnType<typeof createLearningAgentSession>> | undefined;
  try {
    agent = await createLearningAgentSession(new TeachingSessionContext(), new GoalOnboardingContext(), {model, modelRuntime: runtime,
      sessionManager: SessionManager.inMemory(), surface: "WEB", apiBaseUrl: baseUrl, assistantSupport: false, retrieval: false,
      teachingInstructions: () => "", log: () => undefined, onEvent: event => {
        if (event.type === "model_error") errors.push(event.message);
        if (event.type === "assistant_delta") deltas.push(event.delta);
      }});
    const result = await agent.prompt("讲一下 Retriever 如何把检索结果接入上下文。");
    assert.ok(result); assert.equal(result.status, "completed"); assert.deepEqual(errors, []); assert.equal(requests.length, 2);
    assert.ok(requests[0]!.tools?.some(tool => tool.function.name === "begin_teacher_reply"));
    assert.notEqual(requests[0]!.tool_choice, "none", "normal action-phase tool selection must remain available");
    assert.deepEqual(requests[1]!.tools ?? [], []);
    assert.equal(requests[1]!.tool_choice, "none", "empty definitions alone do not disable provider-native tool generation");
    assert.ok(deltas.length > 1, "explicit tool suppression must preserve native incremental speech");
    assert.equal(deltas.join(""), "检索器取得相关片段。随后将片段放进模型上下文。");
  } finally {
    agent?.dispose(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith("lawa-teacher-tool-choice-"));
    rmSync(directory, {recursive: true, force: true});
  }
});

test("SDK compacts the 1M model at the working budget, bounds summary cost and reuses it on the next turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lawa-compaction-runtime-"));
  const server = createServer((_request, response) => {response.setHeader("Content-Type", "application/json"); response.end("{}");});
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const faux = createFauxCore({api: "openai-completions", provider: "opencode-go", models: [{id: "deepseek-v4.1-flash", contextWindow: 1_000_000, maxTokens: 32768}], tokensPerSecond: 0});
  const model = {...faux.getModel(), baseUrl: "https://opencode.ai/inference/go/openai/v1"};
  const manager = SessionManager.inMemory();
  for (let i = 0; i < 30; i++) {
    manager.appendMessage({role: "user", content: `实际答案${i}: ${"visible-history ".repeat(400)}`, timestamp: 100 + i * 2});
    const assistant = {...fauxAssistantMessage([fauxThinking("STALE_SUMMARY_PRIVATE".repeat(20)), {type: "text", text: `实际已交付提示 VISIBLE_WITH_HINT QUESTION_${i} ` + "teacher-feedback ".repeat(400)
      + (i===0 || i===29 ? '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="ask_learner_questions">' : "")}], {timestamp: 101 + i * 2}), api: model.api, provider: model.provider, model: model.id};
    assistant.usage.input = 160000; assistant.usage.totalTokens = 160000;
    manager.appendMessage(assistant);
  }
  const original = structuredClone(manager.getBranch());
  let summarized = false;
  faux.setResponses([
    context => {
      assert.doesNotMatch(context.systemPrompt ?? "", /Learning Planner/);
      assert.match(runtimeInput(context), /当前教学偏好快照/);
      assert.match(context.systemPrompt ?? "", /不能把历史长期偏好/);
      assert.doesNotMatch(JSON.stringify(context), /STALE_SUMMARY_PRIVATE|Assistant thinking/);
      assert.match(JSON.stringify(context), /VISIBLE_WITH_HINT/);
      assert.doesNotMatch(JSON.stringify(context), /QUESTION_29/,
        "当前题面保留在近期完整消息中，不应依赖有损摘要");
      summarized = true;
      return fauxAssistantMessage("历史反馈与帮助事实：VISIBLE_WITH_HINT。当前等待新的用户回答。");
    },
    context => {assert.ok(summarized); assert.match(context.systemPrompt ?? "", /Learning Planner/);
      assert.match(runtimeInput(context), /当前教学偏好快照/);
      assert.doesNotMatch(JSON.stringify(context), /STALE_SUMMARY_PRIVATE/);
      assert.match(JSON.stringify(context.messages), /QUESTION_29/);
      assert.match(JSON.stringify(context.messages), /实际答案29/);
      return fauxAssistantMessage("当前回答是5和23。");},
    context => {
      assert.match(JSON.stringify(context.messages), /历史反馈与帮助事实：VISIBLE_WITH_HINT/);
      assert.match(JSON.stringify(context.messages), /当前回答是5和23/);
      assert.doesNotMatch(JSON.stringify(context), /STALE_SUMMARY_PRIVATE/);
      return fauxAssistantMessage("继续刚才的问题。");
    },
  ]);
  const runtime = await ModelRuntime.create({authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models.json"), allowModelNetwork: false, refreshOnCreate: false});
  const summaries: Array<{maxTokens: number | undefined; reasoning: unknown}> = [];
  runtime.streamSimple = (selected, context, options) => {
    assert.equal(selected.contextWindow, 1_000_000, "经济预算不能谎报模型原件阅读容量");
    assert.doesNotMatch(JSON.stringify(context), /DSML/, "summary and normal teacher inputs must both isolate old serialized calls");
    assert.equal(selected.maxTokens, 32768, "摘要限额不能降低正常教学输出上限");
    if (!context.systemPrompt?.startsWith("你是面向学习者的 Learning Planner")) {
      summaries.push({maxTokens: options?.maxTokens, reasoning: options?.reasoning});
    }
    return faux.streamSimple(selected, context, options);
  };
  runtime.hasConfiguredAuth = () => true;
  runtime.getAuth = async () => ({auth: {apiKey: "local-summary-only"}, env: {}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  const errors: string[] = [];
  let agent: Awaited<ReturnType<typeof createLearningAgentSession>> | undefined;
  try {
    agent = await createLearningAgentSession(new TeachingSessionContext(), new GoalOnboardingContext(), {model, modelRuntime: runtime, sessionManager: manager,
      apiBaseUrl: `http://127.0.0.1:${address.port}`, assistantSupport: false, retrieval: false, log: () => undefined,
      onEvent: event => {if (event.type === "model_error") errors.push(event.message);}});
    await agent.prompt(answer);
    assert.deepEqual(errors, []); assert.equal(faux.state.callCount, 2);
    assert.ok(manager.getBranch().some(entry => entry.type === "compaction"));
    assert.deepEqual(manager.getBranch().filter(entry => entry.type === "message").slice(0, original.length), original);
    assert.equal(summaries.length, 1);
    assert.ok(summaries[0]!.maxTokens && summaries[0]!.maxTokens < 4096);
    assert.equal(summaries[0]!.reasoning, undefined);
    await agent.prompt("继续下一步。");
    assert.deepEqual(errors, []); assert.equal(faux.state.callCount, 3);
    assert.equal(summaries.length, 1, "已压缩的历史应复用摘要，不能在下一条短消息重复付费总结");
    assert.equal(manager.getBranch().filter(entry => entry.type === "compaction").length, 1);
  } finally {
    agent?.dispose(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith("lawa-compaction-runtime-"));
    rmSync(directory, {recursive: true, force: true});
  }
});
