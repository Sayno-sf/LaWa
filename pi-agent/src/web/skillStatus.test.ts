import assert from "node:assert/strict";
import test from "node:test";

import { resolveCurrentTaskSkillId, skillStatusLabel } from "../../web/src/skillStatus.js";

test("only the active task's current skill is labeled 正在学习", () => {
  assert.equal(skillStatusLabel("LEARNING", true), "正在学习");
  // 校验学习语义，不把“已开始”等展示前缀锁定成业务规则。
  assert.match(skillStatusLabel("LEARNING", false), /待巩固/);
  assert.doesNotMatch(skillStatusLabel("LEARNING", false), /正在学习/);
  assert.equal(skillStatusLabel("NOT_STARTED", false), "待学习");
  assert.equal(skillStatusLabel("MASTERED_BY_USER", false), "已确认掌握");
});

test("legacy multi-skill task resolves exactly one focus without treating preview as focus", () => {
  const related = ["first", "second", "third"];
  assert.equal(resolveCurrentTaskSkillId(related, "third", "first"), "third");
  assert.equal(resolveCurrentTaskSkillId(related, null, "first"), "first");
  assert.equal(resolveCurrentTaskSkillId(related, null, "outside"), "first");
  assert.equal(resolveCurrentTaskSkillId([], "third", "first"), null);
});
