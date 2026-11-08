import {test} from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {confirmedProgress, latestRecordedTime} from "./src/learningProgress.js";
import {ProviderPresetPicker} from "./src/providerPresets.js";
import {questionMarkdown} from "./src/learnerQuestionView.js";
import {preferenceContent} from "./src/teachingProposalView.js";
import {renderMarkdown} from "./src/markdown.js";

test("progress counts only unique expanded skills confirmed by the user", () => {
  assert.deepEqual(confirmedProgress([{id:"a",status:"MASTERED_BY_USER"},{id:"b",status:"PRACTICING"},{id:"c",status:"LEARNING"},{id:"a",status:"MASTERED_BY_USER"}]), {confirmed:1,total:3});
  assert.deepEqual(confirmedProgress([]), {confirmed:0,total:0});
  assert.equal(latestRecordedTime([null,"invalid","2026-10-02T00:00:00Z","2026-10-01T00:00:00Z"]), "2026-10-02T00:00:00Z");
  assert.equal(latestRecordedTime([null]), null);
});

test("provider presets preserve saved regional addresses and fill only on user selection", () => {
  const dom = new JSDOM('<label><input id="provider" value="aliyun-bailian"></label><input id="url" value="https://my-region.example/v1">');
  const previous = globalThis.document;
  Object.assign(globalThis,{document:dom.window.document});
  try {
    const input = document.querySelector<HTMLInputElement>("#provider")!, address = document.querySelector<HTMLInputElement>("#url")!;
    const picker = new ProviderPresetPicker(input,address);
    const select = document.querySelector<HTMLSelectElement>("select")!;
    assert.equal(address.value, "https://my-region.example/v1");
    assert.equal(select.value, "aliyun-bailian");
    select.value = "deepseek"; select.dispatchEvent(new dom.window.Event("change"));
    assert.equal(input.value,"deepseek"); assert.equal(address.value,"https://api.deepseek.com");
    select.value = "custom"; select.dispatchEvent(new dom.window.Event("change"));
    assert.equal(input.hidden,false);
    input.value = "local-service"; address.value = "http://localhost:3000/v1"; picker.sync();
    assert.equal(select.value,"custom"); assert.equal(address.value,"http://localhost:3000/v1");
  } finally {Object.assign(globalThis,{document:previous});dom.window.close();}
});

test("question source is preserved without guessing code fences", () => {
  const source = 'function path() {\n  return "a";\n}\nconsole.log(path());\n输出什么？';
  assert.equal(questionMarkdown(source), source);
  assert.equal(questionMarkdown("说明 const 的作用。"), "说明 const 的作用。");
  assert.equal(questionMarkdown("```js\nconst a=1;\n```"), "```js\nconst a=1;\n```");
});

test("preference points preserve quoted examples, existing formatting and source wording", () => {
  const source = "先讲知识；整组提交后讲评。难题留给单题检查。不要用「讲一段；马上问。马上纠正」连续推进。";
  const document = new JSDOM(preferenceContent(source)).window.document;
  const points = Array.from(document.querySelectorAll("li"), item => item.textContent);
  assert.equal(points.length, 4);
  assert.equal(points.join(""), source);
  assert.equal(points[3], "不要用「讲一段；马上问。马上纠正」连续推进。");
  for (const value of ["先讲；保留「未结束的示例。", "**先讲；再练**。", "`const x = 1;`；再解释。", "- 先讲；再练。\n- 复习。", "## 教学；方法。"])
    assert.equal(preferenceContent(value), renderMarkdown(value));
  const unsafe = new JSDOM(preferenceContent("<img src=x onerror=alert(1)>；先练习。"));
  assert.equal(unsafe.window.document.querySelector("img"), null);
  assert.match(unsafe.window.document.body.textContent!, /<img src=x onerror=alert\(1\)>/);
  unsafe.window.close();
  document.defaultView?.close();
});
