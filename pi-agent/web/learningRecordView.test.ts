import {test} from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {learningRecordMarkup, recordSections, plainTextSummary} from "./src/learningRecordView.js";
import {LearnerQuestionView} from "./src/learnerQuestionView.js";
import {readFileSync} from "node:fs";
import {captureDisclosures, restoreDisclosures} from "./src/readingPosition.js";

test("late restored question drafts cannot overwrite an answer already being edited", () => {
  const dom = new JSDOM("<main></main>"), previous = globalThis.document;
  Object.assign(globalThis, {document: dom.window.document});
  try {
    const view = new LearnerQuestionView(() => undefined, () => undefined);
    const request = {id:"q",purpose:"CHECK" as const,session_id:"s",goal_id:"g",skill_id:"k",task_id:"t",
      questions:[{id:"a",prompt:"为什么？",selection:"freeform" as const,options:[]}]};
    view.render(request,false);
    const old = structuredClone(view.captureDraft());
    const input = view.node.querySelector("textarea")!;
    input.value = "数字先转换为字符串";input.dispatchEvent(new dom.window.Event("input",{bubbles:true}));
    view.restoreDraft(old);view.render(request,false);
    assert.equal(view.collect("")?.answers[0]?.other_text,"数字先转换为字符串");
  } finally {Object.assign(globalThis,{document:previous});dom.window.close();}
});

test("summaries retain code operators and identifiers while removing explicit prose formatting", () => {
  const code = 'a = a * 2; console.log("x" * 3); a*2*b; a**b**c; __init__; snake_case';
  assert.equal(plainTextSummary(code, 500), code);
  assert.equal(plainTextSummary('```js\n' + code + '\n```', 500), code);
  assert.equal(plainTextSummary('~~~ts\n' + code + '\n~~~', 500), code);
  assert.equal(plainTextSummary('**说明**：`a * b` 与 ``a ` b * c``。', 500), '说明：a * b 与 a ` b * c。');
  assert.equal(plainTextSummary('`**原样**` 和 *强调*'), '**原样** 和 强调');
  assert.equal(plainTextSummary('🧠理解', 1), '🧠…');
});

test("expanded records use the full row and keep nested Markdown lists out of record styling", () => {
  const styles = ["styles.css", "workspace.css", "interiorWorkspace.css"].map(file=>readFileSync(new URL(`./src/${file}`, import.meta.url),"utf8")).join("\n");
  const record = learningRecordMarkup({id:"record-1", description:"问题：解释以下步骤\n1. **保持原顺序**\n2. 检查结果\n帮助：无\n结论：可以独立解释。", evidence_type:"EXPLAIN", assistance_level:"INDEPENDENT"});
  const dom = new JSDOM(`<style>${styles}</style><section class="workspace-page"><ol><li class="evidence-chain-skill"><div><ol class="learning-record-list"><li>${record}</li></ol></div></li></ol></section>`);
  try {
    const document = dom.window.document;
    const style = (selector:string)=>dom.window.getComputedStyle(document.querySelector(selector)!);
    assert.equal(style(".learning-record-list > li").display,"block");
    assert.equal(style(".learning-record-list > li").gridTemplateColumns,"none");
    assert.equal(style(".learning-record dd ol li").display,"list-item");
    assert.notEqual(style(".learning-record dd ol").listStyleType,"none");
    assert.equal(style(".learning-record-collapse").display,"none");
    document.querySelector("details")!.open=true;
    assert.equal(style(".learning-record-expand").display,"none");
    assert.equal(style(".learning-record-collapse").display,"inline");
    assert.equal(parseFloat(style(".learning-record dd").minWidth),0);
    assert.match(document.querySelector("dd")!.textContent!, /保持原顺序/);
  } finally {dom.window.close();}
});

test("expanded learning records survive refreshed data and reordering by identity", () => {
  const record = (id:string)=>learningRecordMarkup({id,description:"问题：解释概念",evidence_type:"EXPLAIN",assistance_level:"INDEPENDENT"});
  const dom = new JSDOM(`<main>${record("a")}${record("b")}</main>`);
  try {
    const main=dom.window.document.querySelector("main")!;
    main.querySelector("details")!.open=true;
    const expanded=captureDisclosures(main);
    main.innerHTML=record("b")+record("new")+record("a");
    restoreDisclosures(main,expanded);
    assert.deepEqual([...main.querySelectorAll("details")].map(node=>node.open),[false,false,true]);
    main.querySelector<HTMLDetailsElement>('[data-disclosure-key="evidence:a"]')!.open=false;
    assert.equal(captureDisclosures(main).size,0);
  } finally {dom.window.close();}
});

test("record fields preserve code and render rich content safely", () => {
  const description = "问题：输出是什么？\n```js\nconst s = '帮助：无';\n```\n实际帮助：**提示**；区别在于：`join()` 不改变原数组。<img src=x onerror=alert(1)>";
  assert.deepEqual(recordSections(description).map(s => s.label), ["问题", "帮助", "结论"]);
  const document = new JSDOM(learningRecordMarkup({description, evidence_type:"BUILD", assistance_level:"WITH_HINT"})).window.document;
  assert.equal(document.querySelectorAll("dl > div").length, 3);
  assert.match(document.querySelector("pre")!.textContent!, /帮助：无/);
  assert.equal(document.querySelector("img"), null);
  assert.match(document.body.textContent!, /提示后完成/);
  assert.equal(plainTextSummary("# Pi Agent **源码** ## 我的背景"), "Pi Agent 源码 我的背景");
});

test("question code is readable, legacy criteria stay hidden and draft refresh preserves the answer", () => {
  const dom = new JSDOM("<body></body>");
  const previous = globalThis.document;
  Object.assign(globalThis, {document:dom.window.document});
  try {
    const view = new LearnerQuestionView(() => undefined, () => undefined);
    const request = {id:"q", purpose:"CHECK" as const, session_id:"s",goal_id:"g",skill_id:"k",task_id:"t",assessment_contract_id:"c",
      questions:[{id:"a", prompt:"判断输出\n```js\nconst x = 1;\nx + 1;\n```\n本题检查：答案为2（10分）", selection:"freeform" as const,options:[]}]};
    view.render(request, false);
    assert.match(view.node.querySelector("pre")!.textContent!, /const x = 1;\nx \+ 1;/);
    assert.doesNotMatch(view.node.textContent!, /答案为2/);
    const input = view.node.querySelector("textarea")!;
    input.value = "我还在写";
    view.render(request, true);
    assert.equal(view.node.querySelector("textarea"), input);
    assert.equal(input.value, "我还在写");
    assert.equal(view.node.querySelector("fieldset")!.disabled, true);
  } finally { Object.assign(globalThis, {document: previous}); dom.window.close(); }
});
