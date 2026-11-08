import assert from "node:assert/strict";
import test from "node:test";
import {modelContextWindow} from "./modelContextBudget.js";
import {SourceReadBudget} from "./retrieval/tools.js";
import {teachingEconomicCompaction} from "./teachingCompactionBudget.js";

test("verified models use 1M; unknown names retain declared or conservative capacity", () => {
  for (const id of ["qwen3.8-flash", "qwen3.8-max", "qwen3.8-max-0902", "qwen3.8-max-2026-09-02"]) {
    assert.equal(modelContextWindow(id), 1_000_000);
  }
  assert.equal(modelContextWindow("qwen3.8-flash-unverified"), 128_000);
  assert.equal(modelContextWindow("custom", 256_000), 256_000);
  assert.equal(modelContextWindow("custom", NaN), 128_000);
});

test("expanded read budget is shared, follows remaining space and does not reset consumption", async () => {
  const budget = new SourceReadBudget();
  budget.configure(1_000_000, 500_000);
  let count = 0;
  const read = (max: number) => {count++; return Promise.resolve({text: "文".repeat(max), estimated_tokens: max});};
  await Promise.all(Array.from({length: 3}, (_, i) => budget.read(String(i), 32_000, read)));
  assert.equal(count, 3);
  budget.configure(1_000_000, 2500);
  const last = await budget.read("tail", 32_000, read) as {text: string};
  assert.equal(last.text.length, 1476);
  await assert.rejects(budget.read("overflow", 4000, read), /预算/);
  budget.reset(); budget.configure(1_000_000, 500_000);
  await budget.read("next", 32_000, read);
});

test("economical history threshold is separate from expanded source capacity and output", () => {
  const model = {contextWindow: 1_000_000, maxTokens: 32_768};
  const settings = teachingEconomicCompaction(model, {enabled: true, reserveTokens: 16384, keepRecentTokens: 20000});
  assert.equal(model.contextWindow - settings.reserveTokens, 128000);
  assert.equal(settings.keepRecentTokens, 24000);
  assert.deepEqual(model, {contextWindow: 1_000_000, maxTokens: 32_768});
});
