import {test} from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {LearnerQuestionView} from "./src/learnerQuestionView.js";
import type {LearnerQuestionRequest, LearnerQuestionReply} from "../src/learnerQuestionTypes.js";

const request: LearnerQuestionRequest = {id:"review-1", purpose:"CONFIRM_MASTERY", session_id:"session", goal_id:"goal",
  task_id:"task", skill_id:"skill", scope_signature:"a".repeat(64), title:"这一节，你觉得掌握了吗？",
  questions:[{id:"mastery-review", prompt:"关于「函数参数」，你觉得现在掌握得怎样？", selection:"single", options:[
    {id:"proceed", label:"确认掌握并继续"}, {id:"revise", label:"还有不清楚的地方"}, {id:"skip", label:"暂不确认，继续下一节"}]}]};

function harness() {
  const dom = new JSDOM("<!doctype html><body></body>");
  const previous = {document:globalThis.document, window:globalThis.window, CSS:globalThis.CSS};
  Object.assign(globalThis, {document:dom.window.document, window:dom.window, CSS:{escape:(text:string)=>text}});
  const sent: LearnerQuestionReply[] = [], errors: string[] = [];
  const view = new LearnerQuestionView(() => {
    try {const reply = view.collect(""); if (reply) sent.push(reply);} catch (error) {errors.push(String(error));}
  }, () => undefined);
  document.body.append(view.node);
  view.render(request, false);
  const click = (selector: string) => {
    const button = view.node.querySelector<HTMLButtonElement>(selector); assert.ok(button, selector); button.click();
  };
  const close = () => {Object.assign(globalThis, previous); dom.window.close();};
  return {dom, view, sent, errors, click, close};
}

test("mastery review has three explicit actions and no default confirmation or answer controls", () => {
  const h = harness();
  try {
    assert.equal(h.view.node.getAttribute("aria-label"), "本节学习回顾");
    assert.equal(h.view.node.querySelectorAll("[data-question-action]").length, 3);
    assert.equal(h.view.node.querySelector("input"), null);
    assert.equal(h.view.node.querySelector<HTMLElement>(".learner-mastery-feedback")!.hidden, true);
    assert.doesNotMatch(h.view.node.textContent!, /待作答|提交回答|参考答案/);
    assert.equal(h.sent.length, 0);
    h.click('[data-question-action="proceed"]');
    assert.deepEqual(h.sent[0]?.answers[0]?.selected_option_ids, ["proceed"]);
    assert.equal(h.view.displayReply(h.sent[0]!, ""), "确认掌握并继续");
  } finally {h.close();}
});

test("need-work opens a retained draft and submitting it is a decision, not a graded answer", () => {
  const h = harness();
  try {
    h.click('[data-question-action="revise"]');
    assert.equal(h.sent.length, 0, "展开欠缺说明不等于提交");
    const field = h.view.node.querySelector<HTMLTextAreaElement>("textarea")!;
    assert.equal(h.view.node.querySelector<HTMLElement>(".learner-mastery-feedback")!.hidden, false);
    assert.equal(h.view.node.ownerDocument.activeElement, field);
    field.value = "能读懂默认值，但 rest 参数还分不清。";
    field.dispatchEvent(new h.dom.window.Event("input", {bubbles:true}));
    h.view.render(request, false);
    assert.equal(h.view.node.querySelector("textarea"), field, "状态同步保留编辑节点和光标");
    h.click('[data-question-action="proceed"]');
    assert.equal(h.sent.length, 0, "带欠缺说明不能误确认掌握");
    assert.match(h.errors[0]!, /未发送的欠缺说明/);
    assert.equal(field.value, "能读懂默认值，但 rest 参数还分不清。");
    h.click("[data-question-submit]");
    assert.deepEqual(h.sent[0]?.answers[0]?.selected_option_ids, ["revise"]);
    assert.equal(h.sent[0]?.answers[0]?.other_text, field.value);
    assert.equal(h.view.displayReply(h.sent[0]!, ""), "还有不清楚的地方\n" + field.value);
  } finally {h.close();}
});

test("skip remains separate from confirmation, busy blocks actions, and unsuccessful sends can be retried", () => {
  const h = harness();
  try {
    h.view.render(request, true);
    h.click('[data-question-action="skip"]');
    assert.equal(h.sent.length, 0);
    h.view.render(request, false);
    h.click('[data-question-action="skip"]');
    h.click('[data-question-action="skip"]');
    assert.equal(h.sent.length, 2, "失败后仍需由用户明确再次点击，不保留隐形确认");
    assert.deepEqual(h.sent.map(reply=>reply.answers[0]!.selected_option_ids), [["skip"],["skip"]]);
    assert.equal(h.sent[0]?.request_id, request.id);
    h.view.render(null, false);
    assert.equal(h.view.node.hidden, true);
  } finally {h.close();}
});

test("a fresh view resumes the exact saved gap decision without guessing or reconfirming mastery", () => {
  const h = harness();
  try {
    const reply: LearnerQuestionReply = {request_id:request.id,answers:[{question_id:"mastery-review",selected_option_ids:["revise"],other_text:"还有 <边界情况> 不清楚。"}]};
    const restored = {...request,applied_reply:reply};
    h.view.render(restored, false);
    assert.match(h.view.node.textContent!, /你的选择已保存/);
    assert.match(h.view.node.textContent!, /还有 <边界情况> 不清楚。/);
    assert.equal(h.view.node.querySelectorAll("[data-question-action]").length,0);
    assert.equal(h.view.node.querySelector("textarea"),null);
    assert.equal(h.view.node.querySelectorAll("button").length,1);
    assert.equal(h.sent.length,0,"恢复已保存选择不会自动发送或重新确认");
    h.view.render(restored,true);h.click("[data-question-submit]");assert.equal(h.sent.length,0);
    h.view.render(restored,false);h.click("[data-question-submit]");
    assert.deepEqual(h.sent,[reply]);
    h.sent[0]!.answers[0]!.other_text="changed locally";
    assert.equal(reply.answers[0]!.other_text,"还有 <边界情况> 不清楚。","重送副本不得改变服务端投影的真实回执");
  } finally {h.close();}
});
