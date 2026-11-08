import {test} from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {skillIntroductionMarkup} from "./src/skillIntroduction.js";
import {renderMarkdown} from "./src/markdown.js";

test("existing consecutive numbered introduction points become readable without changing their text", () => {
  const dom = new JSDOM(skillIntroductionMarkup("本节目标：①解释输入（含边界）；②检查输出；③独立举例。"));
  try {
    assert.equal(dom.window.document.querySelector("p")!.textContent, "本节目标：");
    assert.deepEqual([...dom.window.document.querySelectorAll("li")].map(node => node.textContent), ["解释输入（含边界）；", "检查输出；", "独立举例。"]);
  } finally {dom.window.close();}
});

test("quoted numbering, ambiguous sequences and existing Markdown stay in their original structure", () => {
  for (const text of ['引用“①甲②乙”只是示例。', '说明（①甲②乙）。', '①甲③乙', '①甲②', '完整段落，不凭标点猜测结构。', '①甲\n②乙', '`①甲②乙`']) {
    assert.equal(skillIntroductionMarkup(text), renderMarkdown(text));
  }
  const dom = new JSDOM(skillIntroductionMarkup('先看“①甲②乙”，再练习：①观察；②解释。'));
  try {assert.equal(dom.window.document.querySelectorAll("li").length, 2);} finally {dom.window.close();}
});

test("introduction markup uses the same safe Markdown rendering as the workspace", () => {
  const dom = new JSDOM(skillIntroductionMarkup('目标：①<img src=x onerror=alert(1)>；②**说明边界**。'));
  try {
    assert.equal(dom.window.document.querySelector("img"), null);
    assert.match(dom.window.document.body.textContent!, /<img src=x onerror=alert\(1\)>/);
    assert.equal(dom.window.document.querySelector("strong")!.textContent, "说明边界");
  } finally {dom.window.close();}
});
