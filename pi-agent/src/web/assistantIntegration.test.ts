import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantStore } from "../assistantStore.js";
import type { AssistantAgentFactory } from "../assistantTypes.js";
import type { LearningOverview } from "../learningOverviewTool.js";
import { WebSessionStore } from "./sessionStore.js";
import { createGateway } from "./gateway.js";
import type { RetrievalRuntime } from "../retrieval/runtime.js";
import { ConversationCatalog } from "./conversationCatalog.js";
import { GoalRecycle } from "./goalRecycle.js";
import { readFile } from "node:fs/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

function overview(): LearningOverview {
  return {current_goal:"理解异步",goal_profile:{id:"goal-a"},curriculum_spine:[],current_frontier:null,current_focus:null,
    skills:[{id:"async",name:"异步请求",status:"LEARNING"}],recent_evidence:[],learning_history:[],
    current_goal_skill_ids:["async"],knowledge_cards:[],
    active_task:{id:"task-a",goal_id:"goal-a",status:"ACTIVE",title:"解释等待",related_skill_ids:["async"]}};
}
function factory(reply="先区分等待与执行。"): AssistantAgentFactory {
  return async options => ({prompt:async()=>{options.onEvent({type:"assistant_delta",delta:reply});
    options.onClassification({kind:"HINT",reason:"提供当前题方向。",replyQuote:reply});},abort:async()=>{},dispose:()=>{}});
}
function fixture(createAssistantAgent: AssistantAgentFactory = factory(), current=overview(), conversationDir?: string) {
  const assistants=new AssistantStore({rootDir:conversationDir?join(conversationDir,"assistants"):undefined});
  let prompts=0;
  const store=new WebSessionStore({conversationDir,assistantStore:assistants,createAssistantAgent,fetchOverview:async()=>current,
    fetchLibrary:async()=>({projects:[]}),createAgent:async()=>({prompt:async()=>{prompts++;},abort:async()=>{},dispose:()=>{}})});
  return {store,assistants,current,prompts:()=>prompts};
}

test("duplicate validated submission uses one durable run; changed text conflicts and invalid input does not seal",async()=>{
  const f=fixture();const main=await f.store.create("new");await f.store.sendAssistant(main.sessionId,"怎么理解",()=>{});
  await assert.rejects(f.store.sendMessage(main.sessionId,"",()=>{},undefined,undefined,"invalid-1"),/empty/);
  assert.equal(f.assistants.handoffs.snapshot().episodes[0]!.status,"active");
  await f.store.sendMessage(main.sessionId,"我的回答",()=>{},undefined,undefined,"request-1");
  await f.store.sendMessage(main.sessionId,"我的回答",()=>{},undefined,undefined,"request-1");
  assert.equal(f.prompts(),1);assert.equal(f.assistants.handoffs.snapshot().runs.length,1);
  await assert.rejects(f.store.sendMessage(main.sessionId,"不同回答",()=>{},undefined,undefined,"request-1"),/不同内容/);f.store.dispose();
});

test("sealing help defers its model summary until the real teacher run has settled", async () => {
  const assistants = new AssistantStore(); let summaries = 0, started!: () => void, release!: () => void;
  const entered = new Promise<void>(done => {started = done;});
  const gate = new Promise<void>(done => {release = done;});
  const store = new WebSessionStore({assistantStore: assistants, createAssistantAgent: factory(), fetchOverview: async () => overview(),
    fetchLibrary: async () => ({projects: []}),
    summarizeHandoff: async () => {summaries++; return {status: "no_handoff_needed"};},
    createAgent: async (_context, _planning, _emit, manager) => ({
      prompt: async text => {
        manager.appendMessage({role: "user", content: text, timestamp: Date.now()});
        started(); await gate; manager.appendMessage(fauxAssistantMessage("按实际回答继续反馈。"));
      }, abort: async () => undefined, dispose: () => undefined,
    }),
  });
  let teaching: Promise<void> | undefined;
  try {
    const main = await store.create("new"); await store.sendAssistant(main.sessionId, "如何理解等待？", () => undefined);
    teaching = store.sendMessage(main.sessionId, "我的回答", () => undefined);
    await entered;
    assert.equal(summaries, 0, "封存帮助后必须先执行主教师，不能先发后台模型请求");
    release(); await teaching; await assistants.handoffs.settled();
    assert.equal(summaries, 1); assert.equal(store.classroom.snapshot()?.status, "completed");
    assert.equal(assistants.handoffs.snapshot().episodes.length, 1, "调度变化不删除原帮助事实");
  } finally {release(); if (teaching) await teaching; store.dispose();}
});

test("background summary timeout does not occupy teacher or assistant generation ownership",async()=>{
  const assistants=new AssistantStore();let teacherPrompts=0;
  const store=new WebSessionStore({assistantStore:assistants,createAssistantAgent:factory(),fetchOverview:async()=>overview(),
    summarizeHandoff:async()=>new Promise(()=>{}),handoffTimeoutMs:30,createAgent:async()=>({prompt:async()=>{teacherPrompts++;},abort:async()=>{},dispose:()=>{}})});
  const main=await store.create("new");await store.sendAssistant(main.sessionId,"第一问",()=>{});
  await store.sendMessage(main.sessionId,"我的回答",()=>{});assert.equal(teacherPrompts,1);
  await store.sendAssistant(main.sessionId,"第二问",()=>{});assert.equal(assistants.handoffs.snapshot().episodes.length,2);
  await assistants.handoffs.settled();assert.equal(assistants.handoffs.snapshot().episodes[0]!.status,"summary_failed");store.dispose();
});

test("opening and replying in TA preserves teacher state and does not start teacher",async()=>{
  const f=fixture(); const main=await f.store.create("new");
  const before=await f.store.state(main.sessionId); const displayed=await f.store.assistant(main.sessionId);
  assert.equal(displayed.available,true); assert.deepEqual((await f.store.state(main.sessionId)).teaching,before.teaching);
  const events:Record<string,unknown>[]=[];
  await f.store.sendAssistant(main.sessionId,"等待是什么意思？",e=>events.push(e));
  const after=await f.store.assistant(main.sessionId);
  assert.equal(after.messages.length,2); assert.equal(f.prompts(),0);
  assert.deepEqual((await f.store.create("resume-recent")).messages, main.messages);
  assert.ok(events.some(e=>e.type==="text_delta"));
  f.store.dispose();
});

test("assistant input does not inherit private task grading answers", async () => {
  const current = overview();
  (current.active_task as any).teaching_activity = {evaluation_focus:["private-answer-42"]};
  current.current_focus = structuredClone(current.active_task);
  let input = "";
  const f = fixture(async options => {input = JSON.stringify(options.context.overview);return {prompt:async()=>{},abort:async()=>{},dispose:()=>{}};}, current);
  try {
    const main = await f.store.create("new");
    await f.store.sendAssistant(main.sessionId,"请给提示",()=>{});
    assert.ok(input); assert.doesNotMatch(input,/private-answer-42/);
    assert.match(JSON.stringify(current),/private-answer-42/);
  } finally {f.store.dispose();}
});

test("TA initialization blocks configuration changes, valid teacher submission seals and interrupts without waiting",async()=>{
  let release!:()=>void; const waiting=new Promise<void>(r=>release=r);
  let initialized!:()=>void;const ready=new Promise<void>(r=>initialized=r);
  const f=fixture(async options=>{initialized();await waiting;return {prompt:async()=>options.onEvent({type:"assistant_delta",delta:"已停止不得输出"}),abort:async()=>{},dispose:()=>{}};});
  const main=await f.store.create("new");const run=f.store.sendAssistant(main.sessionId,"求助",()=>{});
  await ready;
  await assert.rejects(f.store.activateProviderProfile("other-profile"),/课堂正在生成回复/);
  await assert.rejects(f.store.deleteProviderProfile("other-profile"),/课堂正在生成回复/);
  await f.store.sendMessage(main.sessionId,"我的答案",()=>{});
  release();await run;
  assert.equal((await f.store.assistant(main.sessionId)).messages.length,1);
  assert.equal(f.prompts(),1);assert.equal(f.assistants.handoffs.snapshot().episodes[0]!.highWater?.length,0);f.store.dispose();
});

test("TA default and on-demand teacher excerpts exclude another Goal in a shared Pi branch",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"lawa-ta-goal-scope-"));
  try {
    const catalog=new ConversationCatalog(directory),manager=catalog.create();
    catalog.recordGoal(manager,"goal-other","其他目标");
    manager.appendMessage({role:"user",content:"其他目标的私有讲解",timestamp:Date.now()});
    catalog.recordGoal(manager,"goal-a","理解异步");
    manager.appendMessage({role:"user",content:"当前目标相关讲解",timestamp:Date.now()});
    let seen:string[]=[];
    const f=fixture(async options=>{
      const extra=await options.context.readMainMessages!({limit:10});
      seen=[...(options.context.mainMessages??[]),...extra.messages].map(message=>message.content);
      return {prompt:async()=>{},abort:async()=>{},dispose:()=>{}};
    },overview(),directory);
    const main=await f.store.create("resume-recent");
    await f.store.sendAssistant(main.sessionId,"回看讲解",()=>{});
    assert.ok(seen.includes("当前目标相关讲解"));
    assert.ok(!seen.includes("其他目标的私有讲解"));f.store.dispose();
  } finally {await rm(directory,{recursive:true,force:true});}
});

test("Task changes isolate visible TA history while persisted assistance survives restart",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"lawa-ta-integration-"));
  try {
    const f=fixture(factory(),overview(),directory);const main=await f.store.create("new");
    await f.store.sendAssistant(main.sessionId,"怎么想？",()=>{});
    const first=await f.store.assistant(main.sessionId);assert.ok(first.scope);
    f.current.active_task={id:"task-b",goal_id:"goal-a",status:"ACTIVE",related_skill_ids:["async"]};
    assert.equal((await f.store.assistant(main.sessionId)).messages.length,0);
    const loaded=new AssistantStore({rootDir:join(directory,"assistants"),readonly:true});
    assert.equal(loaded.getAssistance(first.scope!).records.length,1);f.store.dispose();
  } finally {await rm(directory,{recursive:true,force:true});}
});

test("the first lecture remains readable through its explicit Goal/Skill anchor before a late Goal marker",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"lawa-ta-first-lecture-"));
  try {
    const catalog=new ConversationCatalog(directory),manager=catalog.create();
    catalog.recordGoal(manager,"goal-other","其他目标");
    manager.appendMessage({role:"user",content:"其他目标原文",timestamp:Date.now()});
    const lectureId=manager.appendMessage(fauxAssistantMessage("当前目标第一课"));
    manager.appendCustomEntry("lawa.skill-anchor",{goalId:"goal-a",skillId:"async",entryId:lectureId});
    catalog.recordGoal(manager,"goal-a","理解异步");
    let texts:string[]=[];
    const f=fixture(async options=>{texts=(options.context.mainMessages??[]).map(message=>message.content);
      return {prompt:async()=>{},abort:async()=>{},dispose:()=>{}};
    },overview(),directory);
    const main=await f.store.create("resume-recent");await f.store.sendAssistant(main.sessionId,"解释第一课",()=>{});
    assert.ok(texts.includes("当前目标第一课"));assert.ok(!texts.includes("其他目标原文"));f.store.dispose();
  } finally {await rm(directory,{recursive:true,force:true});}
});

test("restart locates only the public Checkpoint question using the matching Task tool call",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"lawa-ta-question-recovery-"));
  try {
    const catalog=new ConversationCatalog(directory),manager=catalog.create();catalog.recordGoal(manager,"goal-a","理解异步");
    manager.appendMessage({role:"toolResult",toolCallId:"old-teaching",toolName:"record_teaching_turn",content:[{type:"text",text:JSON.stringify({active_task_id:"task-a",current_question:"旧普通题"})}],isError:false,timestamp:Date.now()});
    manager.appendMessage(fauxAssistantMessage(fauxToolCall("active_recall_checkpoint",{action:"ANSWER",active_task_id:"task-a",active_skill_id:"async"},{id:"checkpoint-q2"})));
    manager.appendMessage({role:"toolResult",toolCallId:"checkpoint-q2",toolName:"active_recall_checkpoint",content:[{type:"text",text:JSON.stringify({status:"ACTIVE",current_question:"当前第二题"})}],isError:false,timestamp:Date.now()});
    let question:string|undefined;
    const agent:AssistantAgentFactory=async options=>{question=options.context.currentQuestion;return {prompt:async()=>{},abort:async()=>{},dispose:()=>{}};};
    const f=fixture(agent,overview(),directory),main=await f.store.create("resume-recent");
    assert.equal((await f.store.state(main.sessionId)).teaching.active_recall,null);
    await f.store.sendAssistant(main.sessionId,"这道题怎么理解？",()=>{});assert.equal(question,"当前第二题");f.store.dispose();
    const reopened=await catalog.open(main.sessionId);
    reopened.appendMessage(fauxAssistantMessage(fauxToolCall("active_recall_checkpoint",{action:"ANSWER",active_task_id:"task-a",active_skill_id:"async"},{id:"checkpoint-finish"})));
    reopened.appendMessage({role:"toolResult",toolCallId:"checkpoint-finish",toolName:"active_recall_checkpoint",content:[{type:"text",text:JSON.stringify({status:"FINISHED",current_question:null})}],isError:false,timestamp:Date.now()});
    const again=fixture(agent,overview(),directory),restored=await again.store.create("resume-recent");
    await again.store.sendAssistant(restored.sessionId,"补充疑问",()=>{});assert.equal(question,undefined);again.store.dispose();
  } finally {await rm(directory,{recursive:true,force:true});}
});

test("assistant HTTP refuses forged scope and cross origin, streams only dedicated messages",async()=>{
  const f=fixture();const main=await f.store.create("new");
  const server=createGateway({store:f.store,retrieval:{scopeChanged:()=>{}} as unknown as RetrievalRuntime});
  server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();assert.ok(address&&typeof address==="object");
  const base=`http://127.0.0.1:${address.port}/api/web/sessions/${main.sessionId}/assistant`;
  try {
    const forged=await fetch(base,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text:"求助",goalId:"other"})});assert.equal(forged.status,400);
    const cross=await fetch(base,{method:"POST",headers:{"Content-Type":"application/json",Origin:"https://other.example"},body:JSON.stringify({text:"求助"})});assert.equal(cross.status,403);
    const actual=await fetch(base,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text:"求助"})});
    assert.match(await actual.text(),/"type":"text_delta"/);assert.equal(f.prompts(),0);
  } finally {f.store.dispose();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test("related assistance lifecycle failure remains replayable before recycle phase commits",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"lawa-ta-recycle-"));
  try {
    const catalog=new ConversationCatalog(directory);const manager=catalog.create();catalog.recordGoal(manager,"goal-a","隔离目标");
    let failOnce=true;const phases:string[]=[];
    const recycle=new GoalRecycle(catalog,async path=>path==="/api/user/recycle"?{goals:[],drafts:[]}:{},()=>{},async()=>{},async item=>{
      phases.push(item.phase);if(failOnce){failOnce=false;throw new Error("模拟助教存储中断");}
    });
    await assert.rejects(recycle.recycle("goal","goal-a","隔离目标"),/存储中断/);
    const initial=JSON.parse(await readFile(join(directory,".trash","recycle.json"),"utf8"));assert.equal(initial[0].phase,"deleting");
    await recycle.recover();const deleted=await recycle.list();assert.equal(deleted[0]?.phase,"deleted");
    await recycle.act(deleted[0]!.id,"restore");assert.deepEqual(phases,["deleting","deleting","restoring"]);
    assert.equal((await recycle.list()).length,0);
  }finally{await rm(directory,{recursive:true,force:true});}
});
