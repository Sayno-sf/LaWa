import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdir, mkdtemp, readFile, readdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {ModelRuntime, SessionManager} from "@earendil-works/pi-coding-agent";
import {createFauxCore, fauxAssistantMessage, fauxToolCall, type Context} from "@earendil-works/pi-ai";
import {createLearningAgentSession} from "./agentSession.js";
import {TeachingSessionContext} from "./teachingSession.js";
import {GoalOnboardingContext} from "./planning/goalOnboarding.js";
import {RUNTIME_STATE_MARKER} from "./teachingPromptLayout.js";
import {
  TEACHING_INSTRUCTIONS_MAX_CHARS,
  TeachingInstructionsError,
  TeachingInstructionsStore,
  teachingInstructionsPrompt,
} from "./teachingInstructions.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "lawa-teaching-instructions-"));
}

test("没有文件时返回空状态，教师收到明确空偏好", async () => {
  const dir = await workspace();
  const store = new TeachingInstructionsStore({ path: join(dir, "instructions.json") });
  assert.deepEqual(await store.read(), { text: "", updatedAt: null, maxChars: TEACHING_INSTRUCTIONS_MAX_CHARS });
  assert.match(await store.prompt(), /当前没有自定义教学提示词/);
});

test("保存会去掉首尾空白、写入原子文件，并可按原文读回", async () => {
  const dir = await workspace();
  const path = join(dir, "nested", "instructions.json");
  const store = new TeachingInstructionsStore({ path });
  const saved = await store.save("  先用真实代码例子，再讲规则。\n每次只出一道题。  ");
  assert.equal(saved.text, "先用真实代码例子，再讲规则。\n每次只出一道题。");
  assert.match(saved.updatedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  const stored = JSON.parse(await readFile(path, "utf8")) as { version: number; text: string };
  assert.equal(stored.version, 1);
  assert.equal(stored.text, saved.text);
  // 原子写入不留下临时文件。
  assert.deepEqual((await readdir(join(dir, "nested"))).filter(name => name.endsWith(".tmp")), []);
  assert.deepEqual(await store.read(), saved);
});

test("空字符串保存等于删除，注入明确失效状态", async () => {
  const dir = await workspace();
  const store = new TeachingInstructionsStore({ path: join(dir, "instructions.json") });
  await store.save("每周日只做复习。");
  assert.notEqual(await store.prompt(), "");
  const cleared = await store.save("   ");
  assert.equal(cleared.text, "");
  assert.match(await store.prompt(), /当前没有自定义教学提示词/);
});

test("超长、非字符串和损坏文件都不会静默破坏原文", async () => {
  const dir = await workspace();
  const path = join(dir, "instructions.json");
  const store = new TeachingInstructionsStore({ path });
  await assert.rejects(() => store.save("字".repeat(TEACHING_INSTRUCTIONS_MAX_CHARS + 1)), (error: unknown) =>
    error instanceof TeachingInstructionsError && error.statusCode === 400 && /4000/.test(error.message));
  await assert.rejects(() => store.save(42), TeachingInstructionsError);
  assert.equal((await store.read()).text, "", "被拒绝的保存不能留下内容");

  await writeFile(path, "{ 这不是 JSON", "utf8");
  const logs: string[] = [];
  const damaged = new TeachingInstructionsStore({ path, log: message => logs.push(message) });
  assert.equal((await damaged.read()).text, "");
  assert.match(logs.join("\n"), /另存/);
  const backups = (await readdir(dir)).filter(name => name.includes(".corrupt-") && name.endsWith(".bak"));
  assert.equal(backups.length, 1, "损坏文件必须先留备份");
  assert.equal(await readFile(join(dir, backups[0]!), "utf8"), "{ 这不是 JSON");
});

test("注入块写明偏好边界，且不把文本当权限", () => {
  const block = teachingInstructionsPrompt("  遇到报错先让我自己判断，再给提示。 ");
  assert.match(block, /遇到报错先让我自己判断，再给提示。/);
  assert.match(block, /不是权限、学习事实或评分依据/);
  assert.match(block, /评分\/Evidence\/Mastery 规则/);
  assert.match(block, /本轮明确要求或系统规则冲突时/);
  assert.match(teachingInstructionsPrompt("   "), /当前没有自定义教学提示词/);
});

test("教师实际模型请求带上自定义提示词，同一 run 内冻结、下一条消息重新读取", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lawa-instructions-prompt-"));
  const store = new TeachingInstructionsStore({ path: join(directory, "instructions.json") });
  await store.save("先用真实代码例子，再讲规则。");
  const api = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({current_goal: "读懂 JS", goal_profile: {id: "goal"}, current_focus: null,
      current_frontier: {focus_skill_id: "syntax", supporting_skill_ids: [], next_action: "按已确认的个人安排给 8～10 题整组练习"},
      active_task: {id: "task", status: "ACTIVE", related_skill_ids: ["syntax"]},
      skills: [{id: "syntax", name: "JS 语法", status: "LEARNING"}], current_goal_skill_ids: ["syntax"],
      curriculum_spine: [], recent_evidence: [], knowledge_cards: [], learning_history: []}));
  });
  await new Promise<void>(done => api.listen(0, "127.0.0.1", done));
  const address = api.address();
  assert.ok(address && typeof address !== "string");
  const seen: Context[] = [];
  const currentState = (context: Context): string => {
    const capsules = context.messages.filter(message => message.role === "user" &&
      typeof message.content === "string" && message.content.startsWith(RUNTIME_STATE_MARKER + "\n"));
    assert.equal(capsules.length, 1, "当前教学偏好只能有一份运行时快照");
    assert.equal(context.messages.at(-1), capsules[0], "动态偏好在稳定历史之后，不改写系统策略前缀");
    return (context.systemPrompt ?? "") + "\n" + capsules[0]!.content;
  };
  let instructionReads = 0;
  const faux = createFauxCore({api: "openai-completions", provider: "aliyun-bailian",
    models: [{id: "qwen3.8-flash", contextWindow: 128000, maxTokens: 32768}], tokensPerSecond: 0});
  faux.setResponses([
    async context => {
      seen.push(context);
      // 模拟用户在本轮生成期间保存偏好：工具续轮仍应冻结，下一条真实消息再刷新。
      await store.save("改成每次只出一道题。");
      return fauxAssistantMessage([fauxToolCall("get_learning_overview", {}, {id: "overview"})], {stopReason: "toolUse"});
    },
    context => { seen.push(context); return fauxAssistantMessage("好，先看一个例子。"); },
    context => { seen.push(context); return fauxAssistantMessage("按新规则继续。"); },
  ]);
  const runtime = await ModelRuntime.create({authPath: join(directory, "auth.json"), modelsPath: null,
    modelsStorePath: join(directory, "models.json"), allowModelNetwork: false, refreshOnCreate: false});
  runtime.streamSimple = faux.streamSimple;
  runtime.hasConfiguredAuth = provider => provider === faux.getModel().provider;
  runtime.getAuth = async () => ({auth: {apiKey: "isolated-faux-key"}, env: {}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  try {
    const agent = await createLearningAgentSession(new TeachingSessionContext(), new GoalOnboardingContext(), {
      model: faux.getModel(), modelRuntime: runtime, sessionManager: SessionManager.inMemory(), retrieval: false,
      assistantSupport: false, apiBaseUrl: `http://127.0.0.1:${address.port}`, surface: "WEB", log: () => undefined,
      teachingInstructions: () => {instructionReads++; return store.prompt();},
    });
    await agent.prompt("继续");
    assert.equal(seen.length, 2, "首轮和工具续轮各一次模型请求");
    assert.match(currentState(seen[0]!), /先用真实代码例子，再讲规则。/);
    assert.match(currentState(seen[0]!), /不是权限、学习事实或评分依据/);
    assert.match(currentState(seen[1]!), /先用真实代码例子，再讲规则。/);
    assert.doesNotMatch(currentState(seen[1]!), /改成每次只出一道题/, "同一run不能中途改用新保存的偏好");
    assert.equal(instructionReads, 1, "同一run只读取一次自定义提示词");
    assert.equal(seen[1]!.systemPrompt, seen[0]!.systemPrompt, "同一 run 的工具续轮复用稳定系统策略");
    await agent.prompt("下一题");
    assert.equal(seen.length, 3);
    assert.equal(instructionReads, 2);
    assert.equal(seen[2]!.systemPrompt, seen[0]!.systemPrompt, "新偏好无需改写稳定系统策略前缀");
    assert.match(currentState(seen[2]!), /改成每次只出一道题。/);
    assert.doesNotMatch(currentState(seen[2]!), /先用真实代码例子/, "保存后下一条消息使用新提示词");
    assert.doesNotMatch(currentState(seen[2]!), /按已确认的个人安排给 8～10/, "旧版派生计划不得作为当前指令继续使用");
  } finally {
    await new Promise<void>(done => api.close(() => done()));
    await mkdir(directory, {recursive: true});
  }
});
