import assert from "node:assert/strict";
import test from "node:test";
import {GrowthClient, GrowthExecutor, growthModelIdentity, type GrowthJob} from "./growthRuntime.js";
import {GROWTH_PROMPTS} from "./growthPrompts.js";
import type {ReadingSelection} from "./materialReading.js";
import {ReadingModelActivity} from "./readingModelActivity.js";
import {GoalOnboardingContext} from "./planning/goalOnboarding.js";
import {planningRuntimeDirective, validatePlanningToolRoute} from "./planning/planningPolicy.js";

class Client extends GrowthClient {
  calls: Array<{action: string; body: any}> = [];
  constructor(readonly job: GrowthJob | null) {super("http://isolated-growth.invalid");}
  override async post<T>(action: string, body: unknown): Promise<T> {
    this.calls.push({action, body});
    return (action === "claim" ? {job: structuredClone(this.job)} : {saved: true}) as T;
  }
}
function job(records = [{id: "r1", origin: "observed", response: "读取CSV"}]): GrowthJob {
  return {key: "score:integrated", lease: "lease", input_hash: "hash", model_id: "model", summaries: [], input: {basis: "integrated", records}};
}
function selection(run: (context: any, options: any) => Promise<unknown>, window = 64_000): ReadingSelection {
  return {thinkingLevel: "off", model: {id: "growth-fixture", name: "Fixture", provider: "fixture", api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1", reasoning: true, input: ["text"], contextWindow: window, maxTokens: 4096,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}},
    runtime: {completeSimple: async (_model, context, options) => ({role: "assistant", content: [{type: "text", text: JSON.stringify(await run(context, options))}], stopReason: "stop"} as never)}};
}

test("worker uses current configured model and low reasoning without mutating classroom selection", async () => {
  const client = new Client(job());
  const selected = selection(async (context, options) => {
    assert.equal(options.reasoning, "low"); assert.equal(options.timeoutMs, 60_000); assert.equal(options.maxRetries, 0);
    assert.equal(context.systemPrompt, GROWTH_PROMPTS.score);
    return {fixture: "six dimensions checked by Kernel"};
  });
  assert.equal(await new GrowthExecutor(client, async () => selected, new ReadingModelActivity()).step(), true);
  assert.equal(selected.thinkingLevel, "off");
  assert.equal(client.calls.at(-1)!.action, "complete");
  assert.equal(client.calls[0]!.body.model_id, growthModelIdentity(selected));
  assert.notEqual(growthModelIdentity(selected), growthModelIdentity({...selected, model: {...selected.model, baseUrl: "https://different.invalid/v1"}}));
});

test("foreground prevents claiming and preempts in-flight scoring without using a failure retry", async () => {
  const client = new Client(job()), activity = new ReadingModelActivity(50);
  let started!: () => void;
  const running = new Promise<void>(done => {started = done;});
  const executor = new GrowthExecutor(client, async () => selection(async (_context, options) => {
    started();
    await new Promise<void>((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), {once: true}));
  }), activity);
  await activity.runForeground(async () => {assert.equal(await executor.step(), false);});
  assert.equal(client.calls.length, 0);
  const background = executor.step(); await running;
  let teacherRan = false;
  await activity.runForeground(async () => {teacherRan = true;});
  await background;
  assert.equal(teacherRan, true);
  assert.equal(client.calls.at(-1)!.action, "release");
  assert.equal(client.calls.at(-1)!.body.failed, false);
  assert.ok(!client.calls.some(c => c.action === "complete"));
});

test("request timeout is bounded even when provider ignores abort", async () => {
  const client = new Client(job());
  const executor = new GrowthExecutor(client, async () => selection(async () => new Promise(() => undefined)), new ReadingModelActivity(), 15);
  const start = Date.now(); await executor.step();
  assert.ok(Date.now() - start < 1000);
  assert.equal(client.calls.at(-1)!.body.failed, true);
  assert.equal(client.calls.at(-1)!.body.error_code, "GROWTH_MODEL_TIMEOUT");
});

test("invalid JSON releases a failed lease instead of submitting zeros", async () => {
  const client = new Client(job()), selected = selection(async () => ({}));
  selected.runtime.completeSimple = async () => ({content: [{type: "text", text: "```json\n{\"score\":5}\n```"}], stopReason: "stop"} as never);
  await new GrowthExecutor(client, async () => selected, new ReadingModelActivity()).step();
  assert.equal(client.calls.at(-1)!.action, "release"); assert.equal(client.calls.at(-1)!.body.error_code, "GROWTH_MODEL_FORMAT");
});

test("large input checkpoints referenced summaries and resumes without resummarizing completed sources", async () => {
  const records = Array.from({length: 12}, (_, n) => ({id: `r${n}`, origin: "observed", response: "实际回答，辅助情况未知。".repeat(180)}));
  const input = job(records), client = new Client(input);
  const requests: any[] = [];
  const selected = selection(async (context) => {
    const value = JSON.parse(context.messages[0].content); requests.push({prompt: context.systemPrompt, value});
    return context.systemPrompt === GROWTH_PROMPTS.summary ? {summary: "只体现有限范围，保留帮助未知，原记录仍可查。"} : {fixture: true};
  }, 24_000);
  await new GrowthExecutor(client, async () => selected, new ReadingModelActivity()).step();
  const checkpoints = client.calls.filter(c => c.action === "checkpoint").map(c => c.body.summary);
  assert.deepEqual([...new Set(checkpoints.flatMap(s => s.source_refs))].sort(), records.map(r => r.id).sort());
  assert.equal(client.calls.at(-1)!.action, "complete");
  assert.equal(requests.at(-1).value.summarized, true);
  const resumed = new Client({...input, summaries: checkpoints}); requests.length = 0;
  await new GrowthExecutor(resumed, async () => selected, new ReadingModelActivity()).step();
  assert.equal(requests.length, 1); assert.equal(requests[0].prompt, GROWTH_PROMPTS.score);
});

test("no pending job does not call the model", async () => {
  let calls = 0;
  assert.equal(await new GrowthExecutor(new Client(null), async () => selection(async () => {calls++;}), new ReadingModelActivity()).step(), false);
  assert.equal(calls, 0);
});

test("imported onboarding keeps identity and requires a distinct confirmation before initialization", () => {
  const profile = {id: "import-goal-1", goal_description: "CSV", background_summary: "学过基础", desired_outcome: "读取表格",
    learning_preferences: [], time_constraint: "", prior_knowledge_claims: []};
  const context = new GoalOnboardingContext(); context.startImported(profile);
  assert.throws(() => context.record({outcome: "CONFIRMED"}), /latest user/);
  assert.throws(() => context.record({outcome: "READY_FOR_CONFIRMATION", profile: {...profile, id: "duplicate"}}), /保留原目标/);
  assert.ok(planningRuntimeDirective(context.snapshot()).includes("保留目标ID import-goal-1"));
  assert.equal(validatePlanningToolRoute(context.snapshot(), "get_imported_learning_context"), undefined);
  assert.equal(validatePlanningToolRoute(context.snapshot(), "create_learning_task")?.block, true);
  context.beginUserTurn("确认"); context.record({outcome: "CONFIRMED"});
  assert.equal(context.snapshot().continuing_goal_id, profile.id);
  assert.equal(context.snapshot().replace_existing, true);
});
