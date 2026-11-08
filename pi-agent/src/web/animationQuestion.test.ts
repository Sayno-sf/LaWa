import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import {once} from "node:events";
import type {SessionManager} from "@earendil-works/pi-coding-agent";
import {fauxAssistantMessage, fauxToolCall} from "@earendil-works/pi-ai";
import type {LearningOverview} from "../learningOverviewTool.js";
import type {TeachingSessionContext} from "../teachingSession.js";
import type {AnimationAnchor, AnimationPresentation} from "../animationTypes.js";
import {getAnimationArtifact,animationArtifactHash} from "../animationCatalog.js";
import {ANIMATION_REQUEST_ENTRY, saveAnimationRequest, type AnimationQuestionInput} from "../animationQuestionRequest.js";
import {saveFeedbackRecovery} from "./feedbackRecovery.js";
import {WebSessionStore, type WebSessionStoreOptions} from "./sessionStore.js";
import {createGateway} from "./gateway.js";

const question="为什么得到1以后，这个栈帧还留在这里？";
type Outcome="completed"|"model_error"|"stopped";
async function fixture(run:(f:{store:()=>WebSessionStore;manager:()=>SessionManager;context:()=>TeachingSessionContext;id:string;anchor:AnimationAnchor;
  state:LearningOverview;calls:()=>number;setOutcome:(value:Outcome)=>void;hold:(value:Promise<void>)=>void;restart:()=>Promise<void>})=>Promise<void>,prepareAgent?:(manager:SessionManager)=>void){
  const directory=mkdtempSync(join(tmpdir(),"lawa-animation-store-"));
  const state:LearningOverview={current_goal:"理解递归",goal_profile:{id:"goal"},current_frontier:{focus_skill_id:"skill"},current_focus:null,
    active_task:{id:"task",goal_id:"goal",status:"ACTIVE",related_skill_ids:["skill"]},skills:[{id:"skill",name:"递归",status:"LEARNING"}],
    current_goal_skill_ids:["skill"],curriculum_spine:[],recent_evidence:[],learning_history:[]};
  let calls=0,outcome:Outcome="completed",wait:Promise<void>|undefined;
  const options:WebSessionStoreOptions={conversationDir:join(directory,"sessions"),conversationCwd:directory,
    fetchOverview:async()=>structuredClone(state),fetchLibrary:async()=>({projects:[]}),log:()=>undefined,
    createAgent:async(_context,_planning,emit,manager)=>{
      prepareAgent?.(manager);
      return {
      prompt:async()=>{throw new Error("Animation question entered the ordinary teaching prompt");},
      askAnimation:async(input:AnimationQuestionInput)=>{
        calls++;assert.equal(input.question,question);assert.equal(input.skillId,"skill");
        assert.equal(manager.getBranch().findLast(row=>row.type==="message"&&row.message.role==="user")?.id,input.sourceUserEntryId);
        await wait;
        const reply=fauxAssistantMessage(outcome==="completed"?"这一帧刚得到1，下一步才把结果交回上一层。":"解释未完成",{stopReason:outcome==="completed"?"stop":outcome==="stopped"?"aborted":"error"});
        manager.appendMessage(reply);emit({type:"assistant_delta",delta:"这一帧刚得到1，下一步才返回。"});
        return {status:outcome};
      },abort:async()=>undefined,dispose:()=>undefined,
    };}};
  let store=new WebSessionStore(options);
  const created=await store.create();const id=created.sessionId;
  const record=()=>((store as any).sessions.get(id) as {sessionManager:SessionManager;context:TeachingSessionContext});
  const manager=record().sessionManager;
  const presentation:AnimationPresentation={id:"animation-instance",sourceSessionId:id,goalId:"goal",taskId:"task",skillId:"skill",artifact:getAnimationArtifact("factorial-3-return")};
  manager.appendMessage(fauxAssistantMessage(fauxToolCall("present_teaching_animation",{artifact_id:"factorial-3-return",teaching_goal:"理解递归返回"},{id:"present-animation"}),{stopReason:"toolUse"}));
  const entryId=manager.appendMessage({role:"toolResult",toolName:"present_teaching_animation",toolCallId:"present-animation",content:[{type:"text",text:"演示已呈现"}],details:{animation:presentation},isError:false,timestamp:Date.now()});
  const anchor:AnimationAnchor={presentation_id:presentation.id,source_entry_id:entryId,artifact_sha256:presentation.artifact.contentSha256,
    scene_id:"base_case",scene_elapsed_ms:800,selected_object_id:null};
  try{await run({store:()=>store,manager:()=>record().sessionManager,context:()=>record().context,id,anchor,state,calls:()=>calls,
    setOutcome:value=>{outcome=value;},hold:value=>{wait=value;},restart:async()=>{store.dispose();store=new WebSessionStore(options);const restored=await store.create();assert.equal(restored.sessionId,id);}});}
  finally{store.dispose();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith("lawa-animation-store-"));rmSync(directory,{recursive:true,force:true});}
}
const currentVersion=async(f:Parameters<Parameters<typeof fixture>[0]>[0])=>(await f.store().state(f.id)).classroom_version!;
const submit=async(f:Parameters<Parameters<typeof fixture>[0]>[0],id="animation-request-001",anchor=f.anchor,retryOf?:string)=>
  f.store().sendAnimationQuestion(f.id,question,()=>undefined,anchor,id,await currentVersion(f),retryOf);
const users=(manager:SessionManager)=>manager.getBranch().filter(row=>row.type==="message"&&row.message.role==="user");

test("animation explanation keeps existing CHECK, checkpoint and Candidate while persisting one real question",async()=>fixture(async f=>{
  const ctx=f.context();ctx.recordTurn({active_skill_id:"skill",active_task_id:"task",teaching_mode:"EXPLAIN",outcome:"CORRECT",current_question:"原题",
    candidate_evidence:{evidence_type:"EXPLAIN",description:"原有解释候选",supporting_interaction_summary:"原真实回答",assistance_level:"WITH_HELP"}});
  const request={id:"pending-check",purpose:"CHECK" as const,session_id:f.id,goal_id:"goal",task_id:"task",skill_id:"skill",questions:[{id:"q",prompt:"原来的题目",selection:"freeform" as const,options:[]}]};
  ctx.learnerQuestions.restore({pending:request,last_answer:{request:{...request,id:"earlier-check"},reply:null,text:"此前的真实回答",used_choices:false,choices_exposed:false}},f.id);
  ctx.activeRecall.start({goal_id:"goal",session_id:f.id,skill_id:"skill",task_id:"task",primary_questions:["问题一","问题二","问题三"]});
  const before=ctx.snapshot();await submit(f);
  assert.deepEqual(ctx.snapshot(),before);assert.ok(before.candidate_evidence);assert.equal(f.calls(),1);
  assert.equal(users(f.manager()).length,1);assert.equal((await f.store().state(f.id)).animation_request?.status,"COMPLETED");
}));

test("duplicate request queries existing outcome and a changed anchor cannot reuse its ID",async()=>fixture(async f=>{
  await submit(f);await submit(f);
  assert.equal(f.calls(),1);assert.equal(users(f.manager()).length,1);
  await assert.rejects(submit(f,"animation-request-001",{...f.anchor,scene_elapsed_ms:900}),/标识|不同|内容|重复/);
  assert.equal(f.calls(),1);
}));

test("first Agent preparation may append only its SDK model and thinking metadata",async()=>fixture(async f=>{
  const before=await currentVersion(f);
  await f.store().sendAnimationQuestion(f.id,question,()=>undefined,f.anchor,"animation-sdk-metadata-001",before);
  assert.equal(f.calls(),1);assert.equal(users(f.manager()).length,1);
  assert.equal((await f.store().state(f.id)).animation_request?.status,"COMPLETED");
  assert.equal(f.manager().getBranch().filter(row=>row.type==="model_change").length,1);
  assert.equal(f.manager().getBranch().filter(row=>row.type==="thinking_level_change").length,1);
},manager=>{manager.appendModelChange("isolated-animation-provider","isolated-animation-model");manager.appendThinkingLevelChange("low");}));

test("query-only recovery of a missing request cannot create a question or call a model",async()=>fixture(async f=>{
  const before=f.manager().getLeafId();
  await assert.rejects(f.store().sendAnimationQuestion(f.id,question,()=>undefined,f.anchor,"animation-missing-query-001",await currentVersion(f),undefined,true),/回执|未找到|重新发送/);
  assert.equal(f.calls(),0);assert.equal(users(f.manager()).length,0);assert.equal(f.manager().getLeafId(),before);
  assert.equal((await f.store().state(f.id)).animation_request,null);
}));

test("an unavailable old template is projected as readable history instead of an executable animation",async()=>fixture(async f=>{
  const artifact=getAnimationArtifact("factorial-3-return");artifact.templateVersion="call-stack-v0-unavailable";
  const {contentSha256:ignored,...snapshot}=artifact;artifact.contentSha256=animationArtifactHash(snapshot);
  const presentation:AnimationPresentation={id:"historical-animation",sourceSessionId:f.id,goalId:"goal",taskId:"task",skillId:"skill",artifact};
  f.manager().appendMessage(fauxAssistantMessage(fauxToolCall("present_teaching_animation",{artifact_id:artifact.id,teaching_goal:"历史演示"},{id:"old-animation-call"}),{stopReason:"toolUse"}));
  const entryId=f.manager().appendMessage({role:"toolResult",toolName:"present_teaching_animation",toolCallId:"old-animation-call",content:[{type:"text",text:"历史演示成功回执"}],details:{animation:presentation},isError:false,timestamp:Date.now()});
  const restored=await f.store().create();const projected=restored.messages.find(message=>message.entryId===entryId);
  assert.ok(projected);assert.equal(projected.animation,undefined);
  assert.match(projected.content,/无法播放|版本/);assert.match(projected.content,/保存的字幕/);
  assert.ok(projected.content.includes(artifact.lesson.scenes[0]!.caption));assert.equal(f.calls(),0);
}));

test("stale classroom versions and changed tasks fail before question persistence or model execution",async()=>fixture(async f=>{
  await assert.rejects(f.store().sendAnimationQuestion(f.id,question,()=>undefined,f.anchor,"animation-stale-001","stale"),/变化|过期|现场/);
  (f.state.active_task as {id:string}).id="another-task";
  await assert.rejects(submit(f),/变化|过期|任务|现场/);
  assert.equal(f.calls(),0);assert.equal(users(f.manager()).length,0);
}));

test("unknown scene, invalid time and forged material hash are rejected",async()=>fixture(async f=>{
  for(const bad of [{...f.anchor,scene_id:"not-in-this-lesson"},{...f.anchor,scene_elapsed_ms:-1},{...f.anchor,scene_elapsed_ms:Infinity},{...f.anchor,artifact_sha256:"0".repeat(64)}]){
    await assert.rejects(submit(f,"invalid-anchor-001",bad));
  }
  assert.equal(f.calls(),0);assert.equal(users(f.manager()).length,0);
}));

test("a presentation outside the current Pi branch cannot authorize a question",async()=>fixture(async f=>{
  const manager=f.manager();const entries=manager.getBranch();const toolAt=entries.findIndex(row=>row.id===f.anchor.source_entry_id);
  assert.ok(toolAt>0);manager.branch(entries[toolAt-1]!.id);
  await assert.rejects(submit(f),/演示|现场|分支|无效|失效/);assert.equal(f.calls(),0);
}));

test("same-classroom assistant work blocks animation without being stopped or sealed",async()=>fixture(async f=>{
  (f.store() as any).assistantBusy=true;(f.store() as any).assistantOwner=f.id;
  try{await assert.rejects(submit(f),/生成|助教|等待|忙/);assert.equal(f.calls(),0);assert.equal((f.store() as any).assistantBusy,true);}
  finally{(f.store() as any).assistantBusy=false;(f.store() as any).assistantOwner=null;}
}));

test("pending original feedback recovery cannot be consumed by an animation question",async()=>fixture(async f=>{
  const user=f.manager().appendMessage({role:"user",content:[{type:"text",text:"原真实作答"}],timestamp:Date.now()});
  const recovery=saveFeedbackRecovery(f.manager(),f.state,user,"assessment_failed");assert.ok(recovery);
  await assert.rejects(submit(f),/反馈|恢复|评分/);assert.equal(f.calls(),0);
  assert.equal((await f.store().state(f.id)).feedback_recovery?.id,recovery.id);
}));

test("a failed PREPARED receipt does not send the model or append a new real question",async()=>fixture(async f=>{
  const manager=f.manager() as any,persist=manager._persist.bind(manager);
  manager._persist=(entry:any)=>{if(entry.type==="custom"&&entry.customType===ANIMATION_REQUEST_ENTRY)throw new Error("isolated disk failure");return persist(entry);};
  const events:Array<{type:string;message?:string}>=[];
  try{
    await f.store().sendAnimationQuestion(f.id,question,event=>events.push(event as any),f.anchor,"animation-disk-001",await currentVersion(f));
    assert.ok(events.some(event=>event.type==="error"&&/保存|disk|存储/.test(event.message??"")));
    assert.equal(f.calls(),0);assert.equal(users(f.manager()).length,0);
  }
  finally{manager._persist=persist;}
}));

test("an ATTACHED persistence failure can be explicitly retried without an orphan user anchor",async()=>fixture(async f=>{
  const manager=f.manager() as any,persist=manager._persist.bind(manager);
  manager._persist=(entry:any)=>{if(entry.type==="custom"&&entry.customType===ANIMATION_REQUEST_ENTRY&&entry.data?.status==="ATTACHED")throw new Error("isolated anchor save failure");return persist(entry);};
  try{await submit(f,"animation-attach-fail-001");assert.equal(f.calls(),0);assert.equal(users(f.manager()).length,0);}
  finally{manager._persist=persist;}
  await submit(f,"animation-attach-retry-001",f.anchor,"animation-attach-fail-001");
  assert.equal(f.calls(),1);assert.equal(users(f.manager()).length,1);assert.equal((await f.store().state(f.id)).animation_request?.status,"COMPLETED");
}));

test("a task change during asynchronous agent preparation is rechecked before persistence",async()=>fixture(async f=>{
  const version=await currentVersion(f);const store=f.store() as any,load=store.loadOverview;let reads=0;
  store.loadOverview=async()=>{reads++;if(reads===2)(f.state.active_task as {id:string}).id="changed-during-prepare";return load();};
  try{await assert.rejects(store.sendAnimationQuestion(f.id,question,()=>undefined,f.anchor,"animation-async-001",version),/现场|变化|课堂/);assert.equal(f.calls(),0);assert.equal(users(f.manager()).length,0);}
  finally{store.loadOverview=load;}
}));

test("an unfinished STARTED receipt becomes UNKNOWN after restart and never auto-runs",async()=>fixture(async f=>{
  const requestId="animation-restart-001";
  const user=f.manager().appendMessage({role:"user",content:[{type:"text",text:question}],timestamp:Date.now()});
  const {animationRequestHash}=await import("../animationQuestionRequest.js");
  saveAnimationRequest(f.manager(),{version:1,requestId,hash:animationRequestHash(question,f.anchor),sessionId:f.id,goalId:"goal",taskId:"task",skillId:"skill",
    anchor:f.anchor,question,title:"递归返回",status:"STARTED",sourceUserEntryId:user});
  await f.restart();assert.equal((await f.store().state(f.id)).animation_request?.status,"UNKNOWN");
  await submit(f,requestId);assert.equal(f.calls(),0);assert.equal(users(f.manager()).length,1);
}));

test("an explicit new attempt retries the same original user and keeps failed evidence",async()=>fixture(async f=>{
  f.setOutcome("model_error");await submit(f,"animation-first-001");
  const first=(await f.store().state(f.id)).animation_request!;assert.equal(first.status,"FAILED");
  await submit(f,"animation-first-001");assert.equal(f.calls(),1);
  f.setOutcome("completed");await submit(f,"animation-retry-001",f.anchor,"animation-first-001");
  assert.equal(f.calls(),2);assert.equal(users(f.manager()).length,1);
  const second=(await f.store().state(f.id)).animation_request!;assert.equal(second.status,"COMPLETED");assert.equal(second.source_user_entry_id,first.source_user_entry_id);
}));

test("two concurrent submits run one explanation and preserve the winning question",async()=>fixture(async f=>{
  let release!:()=>void;f.hold(new Promise<void>(done=>{release=done;}));
  const first=submit(f,"animation-concurrent-001");
  for(let i=0;i<30&&f.calls()===0;i++)await new Promise(done=>setTimeout(done,5));
  assert.equal(f.calls(),1);
  await assert.rejects(submit(f,"animation-concurrent-002"),/生成|等待|忙|回复/);
  release();await first;assert.equal(f.calls(),1);assert.equal(users(f.manager()).length,1);
}));

test("a disconnected submission sink does not fail or stop the accepted explanation",async()=>fixture(async f=>{
  await f.store().sendAnimationQuestion(f.id,question,()=>{throw new Error("isolated browser connection closed");},f.anchor,"animation-disconnected-001",await currentVersion(f));
  assert.equal(f.calls(),1);assert.equal(users(f.manager()).length,1);
  assert.equal((await f.store().state(f.id)).animation_request?.status,"COMPLETED");
  assert.equal(f.store().classroom.snapshot()?.status,"completed");
}));

test("the classroom remains locked while final state is loading and finishes only its own run",async()=>fixture(async f=>{
  const version=await currentVersion(f),store=f.store() as any,load=store.loadOverview;
  let reads=0,release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(done=>{release=done;}),atGate=new Promise<void>(done=>{entered=done;});
  store.loadOverview=async()=>{reads++;if(reads===3){entered();await gate;}return load();};
  const first=store.sendAnimationQuestion(f.id,question,()=>undefined,f.anchor,"animation-finishing-001",version);
  try{
    await atGate;
    assert.equal(store.sessions.get(f.id).busy,true,"final snapshot I/O still belongs to the first run");
    assert.equal(store.sessions.get(f.id).animationRequestId,"animation-finishing-001");
    assert.equal(store.classroom.snapshot()?.status,"running");
    await assert.rejects(store.sendAnimationQuestion(f.id,question,()=>undefined,f.anchor,"animation-finishing-002",version),/生成|等待|忙|回复/);
  }finally{release();await first;store.loadOverview=load;}
  assert.equal(store.classroom.snapshot()?.status,"completed");
  await submit(f,"animation-after-finish-001");assert.equal(f.calls(),2);
  assert.equal(store.classroom.snapshot()?.status,"completed");
}));

test("gateway animation metadata cannot dispatch direct mastery commands or learner answers",async()=>fixture(async f=>{
  let actions=0;(f.store() as any).skillAction=async()=>{actions++;throw new Error("must not reach user skill action");};
  const gateway=createGateway({store:f.store(),retrieval:{scopeChanged:()=>undefined} as any});gateway.listen(0,"127.0.0.1");await once(gateway,"listening");
  const address=gateway.address();assert.ok(address&&typeof address!=="string");
  try{
    const url=`http://127.0.0.1:${address.port}/api/web/sessions/${f.id}/messages`;
    for(const extra of [{message:"/master skill"},{message:question,learner_reply:{request_id:"q",answers:[]}}]){
      const response=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({animation_context:f.anchor,request_id:"animation-command-001",expected_version:await currentVersion(f),...extra})});
      const body=await response.text();assert.ok(response.status>=400||/error/i.test(body),body);
    }
    assert.equal(actions,0);assert.equal(f.calls(),0);assert.equal(users(f.manager()).length,0);
  }finally{gateway.closeAllConnections();await new Promise<void>(done=>gateway.close(()=>done()));}
}));
