import {test} from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {QuestionNavigation} from "./src/questionNavigation.js";

test("current-question return preserves drafts and does not pull readers back on repeated state updates", () => {
  const dom = new JSDOM('<div id="messages"><section id="question"><textarea>未提交的答案</textarea></section></div><div id="composer-wrap"><input id="message-input" value="提问草稿"></div>');
  const frames: FrameRequestCallback[] = [];
  const old = {window:globalThis.window, document:globalThis.document};
  Object.assign(globalThis, {window:dom.window, document:dom.window.document});
  dom.window.requestAnimationFrame = callback => {frames.push(callback); return frames.length;};
  const flush = () => { for (const callback of frames.splice(0)) callback(0); };
  try {
    const messages = document.querySelector<HTMLElement>("#messages")!, question = document.querySelector<HTMLElement>("#question")!;
    messages.getBoundingClientRect = () => ({top:100,bottom:600,height:500}) as DOMRect;
    question.getBoundingClientRect = () => ({top:900-messages.scrollTop,bottom:1300-messages.scrollTop,height:400}) as DOMRect;
    const navigation = new QuestionNavigation(messages, question, document.querySelector("#composer-wrap")!);
    navigation.update("q1", true); flush();
    assert.equal(messages.scrollTop, 776);
    const back = document.querySelector<HTMLButtonElement>("#return-current-question")!;
    assert.equal(back.hidden, true);
    messages.scrollTop = 0; messages.dispatchEvent(new dom.window.Event("scroll")); flush();
    assert.equal(back.hidden, false);
    navigation.update("q1", true); flush();
    assert.equal(messages.scrollTop, 0);
    back.click();
    assert.equal(messages.scrollTop, 776);
    assert.equal(question.querySelector("textarea")!.value, "未提交的答案");
    // 题尾仍可见，但题首被滚出视口时也需要返回入口。
    messages.scrollTop = 830; messages.dispatchEvent(new dom.window.Event("scroll")); flush();
    assert.equal(back.hidden, false);
    navigation.update("q1", true); flush();
    assert.equal(messages.scrollTop, 830);
    back.click();
    assert.equal(messages.scrollTop, 776);
    assert.equal(back.hidden, true);
    assert.equal(document.querySelector<HTMLInputElement>("#message-input")!.value, "提问草稿");
    navigation.update("", false); flush();
    assert.equal(document.querySelector<HTMLElement>(".question-support-heading")!.hidden, true);
    messages.scrollTop = 250;
    navigation.update("q1", true, true); flush();
    assert.equal(messages.scrollTop,250,"returning to an earlier route question preserves its reading anchor");
    navigation.update("q2", true); flush();
    assert.equal(messages.scrollTop,776,"a genuinely new question still aligns normally");
  } finally { Object.assign(globalThis,old); dom.window.close(); }
});
