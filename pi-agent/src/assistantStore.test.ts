import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantStore } from "./assistantStore.js";
import { assistantToolGuard, buildAssistantPrompt } from "./assistantAgent.js";
import type { AssistantAgentFactory, AssistantClassification, AssistantScope } from "./assistantTypes.js";

const scope:AssistantScope={goalId:"goal-one",taskId:"task-one",skillId:"skill-one",mainSessionId:"teacher-one",branchId:"branch-one",questionId:"question-one",attemptId:"attempt-one"};
const clarify:AssistantClassification={kind:"CLARIFICATION",reason:"仅说明提交格式。",replyQuote:"请交文字即可。"};
const answer:AssistantClassification={kind:"ANSWER",reason:"给出了当前题的完整答案。",replyQuote:"答案是42。"};
const factory=(reply:string,classification?:AssistantClassification):AssistantAgentFactory=>async options=>({
  prompt:async()=>{if(reply)options.onEvent({type:"assistant_delta",delta:reply});},
  classify:async()=>classification??null,abort:async()=>undefined,dispose:()=>undefined,
});
function temporary(t:{after:(callback:()=>void)=>void}) {
  const rootDir=mkdtempSync(join(tmpdir(),"lawa-assistant-"));t.after(()=>rmSync(rootDir,{recursive:true,force:true}));return rootDir;
}

test("clarification preserves actual transcript without automatically treating a question as help",async()=>{
  const store=new AssistantStore();
  await store.send(scope,"交文字还是代码？",{},()=>undefined,factory("请交文字即可。",clarify));
  const result=store.getAssistance(scope);
  assert.equal(result.kind,"CLARIFICATION");assert.equal(result.hasHelp,false);assert.equal(result.unknown,false);
  assert.equal(result.records[0]?.question,"交文字还是代码？");assert.equal(store.get(scope).messages.length,2);
});
test("complete answer is persisted before first delta and restores with original provenance",async t=>{
  const rootDir=temporary(t),store=new AssistantStore({rootDir});
  await store.send(scope,"告诉我答案",{},event=>{
    if(event.type==="assistant_delta") {
      const disk=JSON.parse(readFileSync(join(rootDir,"consultations-v1.json"),"utf8"));
      assert.equal(disk.records[0].reply,"答案是42。");assert.equal(disk.records[0].delivery,"POSSIBLY_DELIVERED");
    }
  },factory("答案是42。",answer));
  const restored=new AssistantStore({rootDir});assert.equal(restored.getAssistance(scope).kind,"ANSWER");
  assert.deepEqual(restored.get(scope).messages,store.get(scope).messages);
});
test("missing or fabricated classifier cannot turn exposed help into independent permission",async()=>{
  for(const classification of [undefined,{kind:"NONE" as const,reason:"没帮助",replyQuote:"伪造引文"}]) {
    const store=new AssistantStore();await store.send(scope,"怎么解？",{},()=>undefined,factory("使用二分法并返回中点。",classification));
    assert.equal(store.getAssistance(scope).kind,"UNKNOWN");assert.equal(store.getAssistance(scope).hasHelp,true);
  }
});
test("no exposed output on failure is NONE; partial output on interruption remains UNKNOWN",async()=>{
  const store=new AssistantStore();
  const fail:AssistantAgentFactory=async()=>({prompt:async()=>{throw new Error("providersecret must not leak");},abort:async()=>undefined,dispose:()=>undefined});
  const events:string[]=[];await store.send(scope,"问题",{},e=>events.push(JSON.stringify(e)),fail);
  assert.equal(store.getAssistance(scope).kind,"NONE");assert(!events.join("").includes("providersecret"));
  let resume:()=>void=()=>undefined;
  const waiting=new Promise<void>(resolve=>{resume=resolve;});
  const partial:AssistantAgentFactory=async options=>({prompt:async()=>{options.onEvent({type:"assistant_delta",delta:"关键一步是设x为未知数。"});await waiting;},abort:async()=>resume(),dispose:()=>undefined});
  const pending=store.send(scope,"问题",{},()=>undefined,partial);
  await new Promise(resolve=>setImmediate(resolve));await store.stop(scope);await pending;
  assert.equal(store.getAssistance(scope).kind,"UNKNOWN");assert(store.get(scope).messages.some(m=>m.content.includes("关键一步")));
});
test("material deletion aborts the active assistant only when its current input owns that source",async()=>{
  const store=new AssistantStore();let resume!:()=>void;const waiting=new Promise<void>(resolve=>{resume=resolve;});
  const pending=store.send(scope,"解释附件",{},()=>undefined,async()=>({
    prompt:async()=>{await waiting;},abort:async()=>resume(),dispose:()=>undefined,
    materialDeleted:(id:string)=>id==="mat-"+"a".repeat(32),
  }));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(store.materialDeleted("mat-"+"b".repeat(32)),false);
  assert.equal(store.materialDeleted("mat-"+"a".repeat(32)),true);
  await pending;
  assert.equal(store.getAssistance(scope).records[0]?.status,"INTERRUPTED");
});
test("same Task other session and attempt carry prior help; other Goals remain isolated",async()=>{
  const store=new AssistantStore();await store.send(scope,"答案？",{},()=>undefined,factory("答案是42。",answer));
  const next={...scope,mainSessionId:"teacher-two",branchId:"branch-two",questionId:"question-two",attemptId:"attempt-two"};
  const result=store.getAssistance(next);assert.equal(result.records.length,0);assert.equal(result.priorRecords.length,1);
  assert.equal(result.priorRecords[0]?.classification.kind,"ANSWER");assert.equal(store.get(next).messages.length,0);
  assert.equal(store.getAssistance({...next,goalId:"goal-two"}).priorRecords.length,0);
});
test("clearing chat deletes full text while retaining an uncertainty tombstone; purge Goal removes it",async t=>{
  const rootDir=temporary(t),store=new AssistantStore({rootDir});await store.send(scope,"secret question",{},()=>undefined,factory("答案是42。",answer));
  store.clearSession(scope.mainSessionId);
  assert.equal(store.get(scope).messages.length,0);assert.equal(store.getAssistance(scope).kind,"UNKNOWN");
  const disk=readFileSync(join(rootDir,"consultations-v1.json"),"utf8");assert(!disk.includes("secret question"));assert(!disk.includes("答案是42"));
  const restored=new AssistantStore({rootDir});assert.equal(restored.getAssistance(scope).kind,"UNKNOWN");
  restored.purgeGoal(scope.goalId);assert.equal(restored.getAssistance(scope).records.length,0);
});
test("recycle and restore hide then recover Q&A; chat purge retains only provenance",async()=>{
  const store=new AssistantStore();await store.send(scope,"答案？",{},()=>undefined,factory("答案是42。",answer));
  const item={kind:"chat" as const,targetId:scope.mainSessionId,sessionIds:[scope.mainSessionId],id:"recycle-one"};
  await store.recycle(item);await store.recycle(item);assert.equal(store.get(scope).messages.length,0);
  await store.restore(item);assert.equal(store.get(scope).messages.length,2);
  await store.purge(item);assert.equal(store.get(scope).messages.length,0);assert.equal(store.getAssistance(scope).kind,"UNKNOWN");
});
test("readonly concurrent teacher reader never marks active help interrupted or changes storage",async t=>{
  const rootDir=temporary(t),writer=new AssistantStore({rootDir});
  let resume:()=>void=()=>undefined;const waiting=new Promise<void>(resolve=>{resume=resolve;});
  const pending=writer.send(scope,"问题",{},()=>undefined,async options=>({prompt:async()=>{options.onEvent({type:"assistant_delta",delta:"先确定循环边界。"});await waiting;},abort:async()=>resume(),dispose:()=>undefined}));
  await new Promise(resolve=>setImmediate(resolve));const before=readFileSync(join(rootDir,"consultations-v1.json"),"utf8");
  const reader=new AssistantStore({rootDir,readonly:true});assert.equal(reader.getAssistance(scope).kind,"UNKNOWN");
  assert.equal(reader.getAssistance(scope).records[0]?.status,"RUNNING");assert.equal(readFileSync(join(rootDir,"consultations-v1.json"),"utf8"),before);
  await writer.stop();await pending;assert.equal(reader.getAssistance(scope).records[0]?.status,"INTERRUPTED");
});
test("corrupt and missing previously initialized assistance storage fail closed",async t=>{
  const rootDir=temporary(t),store=new AssistantStore({rootDir});await store.send(scope,"答案？",{},()=>undefined,factory("答案是42。",answer));
  const file=join(rootDir,"consultations-v1.json");writeFileSync(file,"broken-json");
  const corrupt=new AssistantStore({rootDir,readonly:true});assert.equal(corrupt.getAssistance(scope).kind,"UNKNOWN");assert.equal(readFileSync(file,"utf8"),"broken-json");
  rmSync(file);assert.equal(new AssistantStore({rootDir,readonly:true}).getAssistance(scope).kind,"UNKNOWN");
});
test("corrupt writer rejects send and lifecycle mutations without replacing original bytes",async t=>{
  const rootDir=temporary(t),file=join(rootDir,"consultations-v1.json"),original="{broken original bytes\nprivate preserved text}";
  writeFileSync(file,original);
  const store=new AssistantStore({rootDir});let started=false;
  const agent:AssistantAgentFactory=async options=>{started=true;return factory("答案是42。",answer)(options);};
  await assert.rejects(store.send(scope,"问题",{},()=>undefined,agent),/原文件已保留/);
  assert.throws(()=>store.clearSession(scope.mainSessionId),/原文件已保留/);
  assert.throws(()=>store.purgeGoal(scope.goalId),/原文件已保留/);
  await assert.rejects(store.recycle({kind:"chat",targetId:scope.mainSessionId,sessionIds:[scope.mainSessionId],id:"bad-recycle"}),/原文件已保留/);
  assert.equal(started,false);assert.equal(readFileSync(file,"utf8"),original);
  assert.equal(store.getAssistance(scope).kind,"UNKNOWN");
});
test("validated load does not rewrite clean records; recovery write failure propagates outside parse catch",async t=>{
  const rootDir=temporary(t),writer=new AssistantStore({rootDir});await writer.send(scope,"答案？",{},()=>undefined,factory("答案是42。",answer));
  const file=join(rootDir,"consultations-v1.json"),clean=readFileSync(file,"utf8");
  const prototype=AssistantStore.prototype as unknown as {persist():void};
  t.mock.method(prototype,"persist",()=>{throw new Error("synthetic recovery write failure");});
  const reader=new AssistantStore({rootDir});assert.equal(reader.getAssistance(scope).kind,"ANSWER");assert.equal(readFileSync(file,"utf8"),clean);
  const disk=JSON.parse(clean);disk.records[0].status="RUNNING";const running=JSON.stringify(disk);writeFileSync(file,running);
  assert.throws(()=>new AssistantStore({rootDir}),/synthetic recovery write failure/);
  assert.equal(readFileSync(file,"utf8"),running);
  assert.equal(new AssistantStore({rootDir,readonly:true}).getAssistance(scope).records[0]?.status,"RUNNING");
});
test("fresh scope is mandatory and global assistant send is mutually exclusive",async()=>{
  const store=new AssistantStore();
  await assert.rejects(store.send(scope,"问题",{isCurrentScope:()=>false},()=>undefined,factory("答案是42。",answer)),/学习现场/);
  assert.equal(store.get(scope).messages.length,0);
  let resume:()=>void=()=>undefined;const waiting=new Promise<void>(resolve=>{resume=resolve;});
  const pending=store.send(scope,"问题",{},()=>undefined,async()=>({prompt:async()=>waiting,abort:async()=>resume(),dispose:()=>undefined}));
  await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(store.send(scope,"第二个问题",{},()=>undefined,factory("",undefined)),/正在回复/);
  await store.stop();await pending;
});
test("clear during streaming cannot restore erased text or overwrite UNKNOWN tombstone",async()=>{
  const store=new AssistantStore();let resume:()=>void=()=>undefined;const waiting=new Promise<void>(resolve=>{resume=resolve;});
  const pending=store.send(scope,"secret question",{},()=>undefined,async options=>({prompt:async()=>{options.onEvent({type:"assistant_delta",delta:"答案是42。"});await waiting;options.onEvent({type:"assistant_delta",delta:"迟到内容"});},abort:async()=>resume(),dispose:()=>undefined}));
  await new Promise(resolve=>setImmediate(resolve));store.clearSession(scope.mainSessionId);await pending;
  assert.equal(store.get(scope).messages.length,0);assert.equal(store.getAssistance(scope).kind,"UNKNOWN");assert.equal(store.getAssistance(scope).records[0]?.reply,"");
});
test("external Kernel scope change during stream stops later deltas in the original scope",async()=>{
  let current=true;const store=new AssistantStore();const emitted:string[]=[];
  const stream:AssistantAgentFactory=async options=>({prompt:async()=>{
    await options.onEvent({type:"assistant_delta",delta:"第一条提示。"});
    current=false;await options.onEvent({type:"assistant_delta",delta:"已经过期的完整答案。"});
  },abort:async()=>undefined,dispose:()=>undefined});
  await store.send(scope,"问题",{isCurrentScope:()=>current},event=>{if(event.type==="assistant_delta")emitted.push(event.delta);},stream);
  assert.deepEqual(emitted,["第一条提示。"]);assert.equal(store.getAssistance(scope).kind,"UNKNOWN");
  assert.equal(store.getAssistance(scope).records[0]?.reply,"第一条提示。");
});
test("stop during asynchronous scope verification cannot deliver a queued answer",async()=>{
  const store=new AssistantStore();let release!:()=>void,checking!:()=>void,calls=0;
  const waiting=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{checking=resolve;});
  const emitted:string[]=[];
  const pending=store.send(scope,"问题",{isCurrentScope:async()=>{calls++;if(calls===3){checking();await waiting;}return true;}},
    event=>{if(event.type==="assistant_delta")emitted.push(event.delta);},async options=>({
      prompt:async()=>{await options.onEvent({type:"assistant_delta",delta:"取消后不得交付的答案。"});},abort:async()=>undefined,dispose:()=>undefined}));
  await ready;await store.stop();release();await pending;
  assert.deepEqual(emitted,[]);assert.equal(store.getAssistance(scope).kind,"NONE");assert.equal(store.getAssistance(scope).records[0]?.reply,"");
});
test("crash recovery keeps partial actual text but never restores a completed classification",async t=>{
  const rootDir=temporary(t),store=new AssistantStore({rootDir});await store.send(scope,"答案？",{},()=>undefined,factory("答案是42。",answer));
  const file=join(rootDir,"consultations-v1.json"),disk=JSON.parse(readFileSync(file,"utf8"));disk.records[0].status="RUNNING";writeFileSync(file,JSON.stringify(disk));
  const restarted=new AssistantStore({rootDir});const result=restarted.getAssistance(scope);
  assert.equal(result.kind,"UNKNOWN");assert.equal(result.records[0]?.status,"INTERRUPTED");assert.equal(result.records[0]?.reply,"答案是42。");
});
test("queued callback classification follows captured deltas for injectable agent factories",async()=>{
  const store=new AssistantStore();await store.send(scope,"交什么",{},()=>undefined,async options=>({prompt:async()=>{
    options.onEvent({type:"assistant_delta",delta:"请交文字即可。"});options.onClassification(clarify);
  },abort:async()=>undefined,dispose:()=>undefined}));
  assert.equal(store.getAssistance(scope).kind,"CLARIFICATION");
});
test("assistant tools positively reject all writes, broader scopes and arbitrary identities",()=>{
  for(const name of ["submit_evidence","record_teaching_turn","bash","read","create_learning_task","anysearch","web_search","create_knowledge_card"]) assert(assistantToolGuard(name,{},scope.skillId));
  assert(assistantToolGuard("search_learning_sources",{scope:"library"},scope.skillId));
  assert(assistantToolGuard("read_learning_material",{goal_id:"other"},scope.skillId));
  assert(assistantToolGuard("get_skill_learning_context",{skill_id:"other"},scope.skillId));
  assert.equal(assistantToolGuard("get_skill_learning_context",{skill_id:scope.skillId},scope.skillId),null);
  assert.equal(assistantToolGuard("search_learning_sources",{scope:"current"},scope.skillId),null);
});
test("prompt omits unrelated full history and reports bounded omission; original question retained",()=>{
  const prompt=buildAssistantPrompt({scope,context:{currentQuestion:"证明当前定理",mainMessages:[{role:"assistant",content:"a".repeat(12000)}]},
    history:[{id:"old",role:"user",content:"b".repeat(60000),createdAt:"now",consultationId:"old"}],onEvent:()=>undefined,onClassification:()=>undefined,isCurrentScope:async()=>true},
    {contextWindow:32000,maxTokens:8192});
  assert(prompt.includes("证明当前定理"));assert(prompt.includes('"truncated":true'));assert(!prompt.includes("a".repeat(12000)));assert(!prompt.includes("b".repeat(60000)));
});
