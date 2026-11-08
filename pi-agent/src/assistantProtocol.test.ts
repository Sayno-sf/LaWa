import assert from "node:assert/strict";
import test from "node:test";
import {AssistantProtocolFilter, publicAssistantText,projectAssistantProtocol} from "./assistantProtocol.js";
import {fauxAssistantMessage,fauxToolCall,type Message} from "@earendil-works/pi-ai";

test("serialized DeepSeek calls are withheld at every possible stream boundary", () => {
  for (const marker of ["<｜｜DSML｜｜ calls>", "<||DSML|| calls>", '<｜｜DSML｜｜ invoke name="ask_learner_questions">']) {
    const text = "先看这个例子。\n" + marker + '<｜｜DSML｜｜ parameter name="purpose">CONFIRM_MASTERY</｜｜DSML｜｜ parameter>尾文';
    for (let split = 0; split <= text.length; split++) {
      const filter = new AssistantProtocolFilter();
      const output = filter.push(text.slice(0, split)) + filter.push(text.slice(split)) + filter.finish();
      assert.equal(output, "先看这个例子。\n", String(split));
      assert.equal(filter.detected, true);
    }
    const filter = new AssistantProtocolFilter();
    assert.equal([...text].map(char => filter.push(char)).join("") + filter.finish(), "先看这个例子。\n");
  }
});

test("normal explanations, code, HTML and mathematical comparisons stream unchanged", () => {
  const text = 'a < b；泛型 Record<K, V>；<div title="example">内容</div>；DSML 是一个名字。<||';
  const filter = new AssistantProtocolFilter();
  assert.equal(filter.push("现在就能读到的讲解。"), "现在就能读到的讲解。");
  assert.equal([...text].map(char => filter.push(char)).join("") + filter.finish(), text);
  assert.equal(filter.detected, false);
});

test("truncated protocol is hidden, raw documents remain untouched, and buffers stay bounded", () => {
  for (const tail of ["<｜｜DSML", "<｜｜DSML｜｜ cal", "<||DSML|| invoke"]) {
    const filter = new AssistantProtocolFilter();
    assert.equal(filter.push("解释。" + tail) + filter.finish(), "解释。");
    assert.equal(filter.detected, true);
  }
  const raw = "旧讲解。<｜｜DSML｜｜ calls>内部参数";
  assert.equal(publicAssistantText(raw), "旧讲解。");
  assert.ok(raw.includes("内部参数"));
  const long = "<｜｜DSML｜｜" + " ".repeat(1000) + "普通文字";
  assert.equal(publicAssistantText(long), long);
});

test("input projection preserves actual tool calls and user quotations without mutating saved messages", () => {
  const marker="<｜｜DSML｜｜ calls>";
  const user:Message={role:"user",content:marker,timestamp:0};
  const call=fauxToolCall("get_learning_overview",{});
  const assistant=fauxAssistantMessage([{type:"text",text:"讲解。<｜｜DS"},{type:"text",text:'ML｜｜ calls>内部参数'},call]);
  const before=JSON.stringify(assistant);
  const projected=projectAssistantProtocol([user,assistant]);
  assert.equal(projected[0],user);
  assert.notEqual(projected[1],assistant);
  assert.equal(JSON.stringify(assistant),before);
  const output=projected[1]!;
  assert.ok(output.role==="assistant");
  assert.equal(output.content.find(p=>p.type==="toolCall"),call);
  assert.equal(output.content.filter(p=>p.type==="text").map(p=>p.text).join(""),"讲解。");
});
