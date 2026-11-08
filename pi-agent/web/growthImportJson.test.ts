import assert from "node:assert/strict";
import test from "node:test";
import {parseGrowthImportJson} from "./src/growthImportJson.js";

test("AI JSON wrapper and BOM preserve code content exactly", () => {
  const original = {question: null, learner_answer: "def f():\n    return ',}'\n", text: "```json\n{}\n```"};
  const raw = JSON.stringify(original);
  assert.deepEqual(parseGrowthImportJson("\uFEFF```json\n" + raw + "\n```"), original);
  assert.deepEqual(parseGrowthImportJson(raw), original);
  assert.throws(() => parseGrowthImportJson("说明\n" + raw), /JSON 格式/);
  assert.throws(() => parseGrowthImportJson('{"value":1,}'), /JSON 格式/);
  assert.throws(() => parseGrowthImportJson("中".repeat(400000)), /1 MiB/);
});
