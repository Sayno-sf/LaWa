import assert from "node:assert/strict";
import test from "node:test";
import {createBundledLearningSkills} from "./learningSkillBundles.js";
import type {LearningSkillRuntime} from "./learningSkills.js";

interface Receipt {skill:string;resource:string;body:string;version:string;sha256:string;host_instructions?:string;resources?:string[]}
async function read(runtime:LearningSkillRuntime,name:string,params:Record<string,unknown>){
  const tool=runtime.tools().find(tool=>tool.name===name);assert.ok(tool);
  const result=await tool.execute("skill-read",params,undefined,undefined,{} as never);
  const content=result.content[0]!;assert.equal(content.type,"text");if(content.type!=="text")throw new Error("Expected text skill result");
  return {receipt:JSON.parse(content.text) as Receipt,message:{role:"toolResult",toolName:name,isError:false,content:result.content}};
}

test("the default visual skill is discoverable without injecting its protocol",()=>{
  const runtime=createBundledLearningSkills("WEB","TEACHER");
  const prompt=runtime.metadataPrompt();
  assert.match(prompt,/lawa-illustrated-lesson/);
  assert.doesNotMatch(prompt,/explainer-animation|lawa-teaching-animation|钢笔线描|SVG形状/);
  assert.equal(runtime.hasToolAdapter("present_explainer_animation"),false);
  assert.equal(runtime.hasToolAdapter("present_teaching_animation"),false);
});

test("the illustrated lesson exposes references on demand and gates publication on the tool receipt",async()=>{
  const runtime=createBundledLearningSkills("WEB","TEACHER");
  assert.ok(runtime.guardTool("prepare_lesson_figures")?.block);
  const entry=await read(runtime,"load_learning_skill",{name:"lawa-illustrated-lesson"});
  assert.equal(entry.receipt.resource,"SKILL.md");
  assert.match(entry.receipt.body,/图解讲页/);
  assert.ok(entry.receipt.resources?.includes("references/motion.md"));
  assert.ok(entry.receipt.resources?.includes("references/prediction.md"));
  assert.ok(runtime.guardTool("prepare_lesson_figures")?.block,"execution alone is not a receipt in model context");
  runtime.observeModelContext([entry.message]);
  assert.equal(runtime.guardTool("prepare_lesson_figures"),undefined);
  assert.ok(runtime.fork().guardTool("prepare_lesson_figures")?.block);
});

test("assistant and CLI skill instructions explain existing figures",async()=>{
  for(const [surface,role] of [["WEB","ASSISTANT"],["CLI","TEACHER"]] as const){
    const runtime=createBundledLearningSkills(surface,role);
    const {receipt}=await read(runtime,"load_learning_skill",{name:"lawa-illustrated-lesson"});
    assert.match(receipt.host_instructions!,/解释已呈现的图/);
  }
});
