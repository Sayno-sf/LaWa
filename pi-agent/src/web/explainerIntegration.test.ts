import assert from "node:assert/strict";
import test from "node:test";
import {once} from "node:events";
import {mkdtempSync,rmSync} from "node:fs";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {basename,dirname,join,resolve} from "node:path";
import {ModelRuntime,SessionManager} from "@earendil-works/pi-coding-agent";
import {createFauxCore,fauxAssistantMessage,fauxToolCall,type Context} from "@earendil-works/pi-ai";
import {createLearningAgentSession} from "../agentSession.js";
import {ANIMATION_READ_TOOLS,animationRequestHash} from "../animationQuestionRequest.js";
import {createPresentExplainerTool} from "../explainerPresentationTool.js";
import type {ExplainerAnchor,ExplainerContext,ExplainerPresentation,ExplainerScript} from "../explainerTypes.js";
import type {LearningOverview} from "../learningOverviewTool.js";
import type {GoalOnboardingContext} from "../planning/goalOnboarding.js";
import type {TeachingSessionContext} from "../teachingSession.js";
import {createGateway} from "./gateway.js";
import {WebSessionStore,type WebSessionStoreOptions} from "./sessionStore.js";

const question="为什么这个位置的小球和另一条路径不同？";

/** Deliberately independent of both installed examples: convergence retains branch mutations. */
function independentScript():ExplainerScript {
  return {title:"小球沿不同方向移动",start:"predict",stage:[
    {id:"ball",k:"box",x:32,y:32,w:64,h:40,t:"小球"},
    {id:"trace",k:"cells",x:32,y:176,t:[]},
  ],nodes:{
    predict:{label:"先预测",ops:[["show","ball"],["show","trace"],["say","选择一个方向，再观察位置变化。"]],
      ask:{q:"向哪个方向移动？",opts:[{t:"向右",go:"right"},{t:"向下",go:"down"}]}},
    right:{label:"向右",ops:[["move","ball",240,32],["set","ball","右侧"],["push","trace","右"]],next:"finish"},
    down:{label:"向下",ops:[["move","ball",32,112],["set","ball","下方"],["push","trace","下"]],next:"finish"},
    finish:{label:"比较结果",ops:[["say","路径不同，位置和记录也不同。"],["flash","ball"]],end:true},
  }};
}

interface Fixture {
  store:()=>WebSessionStore;manager:()=>SessionManager;context:()=>TeachingSessionContext;
  id:string;presentation:ExplainerPresentation;anchor:ExplainerAnchor;
  faux:ReturnType<typeof createFauxCore>;inputs:Context[];posts:()=>number;
  restart:()=>Promise<void>;version:()=>Promise<string>;
  submit:(requestId?:string,anchor?:ExplainerAnchor,retryOf?:string,queryOnly?:boolean)=>Promise<void>;
}

async function fixture(run:(f:Fixture)=>Promise<void>):Promise<void> {
  const directory=mkdtempSync(join(tmpdir(),"lawa-explainer-integration-"));
  const overview:LearningOverview={current_goal:"理解位置变化",goal_profile:{id:"goal"},current_frontier:{focus_skill_id:"skill"},current_focus:null,
    active_task:{id:"task",goal_id:"goal",status:"ACTIVE",related_skill_ids:["skill"]},skills:[{id:"skill",name:"位置变化",status:"LEARNING"}],
    current_goal_skill_ids:["skill"],curriculum_spine:[],recent_evidence:[],learning_history:[]};
  let posts=0;
  const api=createServer((request,response)=>{
    response.setHeader("Content-Type","application/json");
    if(request.method!=="GET"){posts++;response.statusCode=500;response.end(JSON.stringify({detail:"isolated Kernel rejects writes"}));return;}
    response.end(JSON.stringify(request.url==="/api/learning/teaching"?{strategies:[],proposals:[]}:overview));
  });
  await new Promise<void>(done=>api.listen(0,"127.0.0.1",done));
  const address=api.address();assert.ok(address&&typeof address!=="string");
  const apiBaseUrl=`http://127.0.0.1:${address.port}`;
  const faux=createFauxCore({tokensPerSecond:0,api:"openai-completions",provider:"explainer-integration-faux",models:[{id:"isolated-explainer",contextWindow:128000,maxTokens:4096}]});
  const runtime=await ModelRuntime.create({authPath:join(directory,"auth.json"),modelsPath:null,modelsStorePath:join(directory,"models.json"),allowModelNetwork:false,refreshOnCreate:false});
  runtime.streamSimple=faux.streamSimple;runtime.hasConfiguredAuth=()=>true;
  runtime.getAuth=async()=>({auth:{apiKey:"isolated-explainer-test"},env:{}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  const inputs:Context[]=[];
  faux.setResponses([input=>{inputs.push(input);return fauxAssistantMessage("你选择了向右的路径，所以合流后保留的是右侧位置和右字记录。");}]);
  const options:WebSessionStoreOptions={apiBaseUrl,conversationDir:join(directory,"sessions"),conversationCwd:directory,
    fetchOverview:async()=>structuredClone(overview),fetchLibrary:async()=>({projects:[]}),log:()=>undefined,
    createAgent:async(context,planning,onEvent,sessionManager)=>createLearningAgentSession(context,planning,{apiBaseUrl,sessionManager,
      modelRuntime:runtime,model:faux.getModel(),surface:"WEB",retrieval:false,assistantSupport:false,teachingInstructions:()=>"",log:()=>undefined,onEvent}),
  };
  let store=new WebSessionStore(options);
  try {
    const created=await store.create(),id=created.sessionId;
    const record=()=>((store as unknown as {sessions:Map<string,{sessionManager:SessionManager;context:TeachingSessionContext;planningContext:GoalOnboardingContext}>}).sessions.get(id)!);
    const manager=record().sessionManager;
    const tool=createPresentExplainerTool(record().context,record().planningContext,{fetchImpl:async()=>Response.json(overview),log:()=>undefined});
    const args={teaching_goal:"观察同一舞台在不同分支留下的状态",script:independentScript()};
    const result=await tool.execute("present-third-script",args,new AbortController().signal,undefined,{} as Parameters<typeof tool.execute>[4]);
    const presentation=result.details.explainer;
    manager.appendMessage(fauxAssistantMessage(fauxToolCall("present_explainer_animation",args,{id:"present-third-script"}),{stopReason:"toolUse"}));
    const entryId=manager.appendMessage({role:"toolResult",toolName:"present_explainer_animation",toolCallId:"present-third-script",content:result.content,details:result.details,isError:false,timestamp:Date.now()});
    const anchor:ExplainerAnchor={presentation_id:presentation.id,source_entry_id:entryId,artifact_sha256:presentation.artifact.contentSha256,
      scene_id:"finish:0",scene_elapsed_ms:700,selected_object_id:null,explainer_path:["predict","right","finish"]};
    const version=async()=>(await store.state(id)).classroom_version!;
    await run({store:()=>store,manager:()=>record().sessionManager,context:()=>record().context,id,presentation,anchor,faux,inputs,posts:()=>posts,version,
      restart:async()=>{store.dispose();store=new WebSessionStore(options);assert.equal((await store.create()).sessionId,id);},
      submit:async(requestId="explainer-question-001",position=anchor,retryOf,queryOnly=false)=>store.sendAnimationQuestion(id,question,()=>undefined,position,requestId,await version(),retryOf,queryOnly),
    });
  } finally {
    store.dispose();api.closeAllConnections();await new Promise<void>(done=>api.close(()=>done()));
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith("lawa-explainer-integration-"));
    rmSync(directory,{recursive:true,force:true});
  }
}

const users=(manager:SessionManager)=>manager.getBranch().filter(row=>row.type==="message"&&row.message.role==="user");
function canonicalFrom(input:Context):ExplainerContext {
  const prompt=input.systemPrompt??"",offset=prompt.indexOf('{"recipe":"explainer"');
  assert.ok(offset>=0,"real Pi receives the server-replayed explainer context");
  return JSON.parse(prompt.slice(offset)) as ExplainerContext;
}

test("successful explainer tool details project an arbitrary third script and survive Pi history reopening",async()=>fixture(async f=>{
  const projected=(await f.store().create()).messages.find(message=>message.entryId===f.anchor.source_entry_id);
  assert.ok(projected?.explainer);assert.equal(projected.animation,undefined);
  assert.deepEqual(projected.explainer.artifact.script,{...independentScript(),canvas:{w:640,h:296}});
  assert.equal(projected.explainer.entryId,f.anchor.source_entry_id);
  assert.equal(projected.explainer.sourceSessionId,f.id);assert.equal(users(f.manager()).length,0);assert.equal(f.posts(),0);
  await f.restart();
  const restored=(await f.store().create()).messages.find(message=>message.entryId===f.anchor.source_entry_id);
  assert.deepEqual(restored?.explainer,projected.explainer);
  await f.submit();
  const canonical=canonicalFrom(f.inputs[0]!);
  assert.deepEqual(canonical.parameters.path,["predict","right","finish"]);
  assert.equal(canonical.previousState.elements.ball!.x,240);
  assert.equal(canonical.previousState.elements.ball!.text,"右侧");
  assert.deepEqual(canonical.previousState.elements.trace!.cells,["右"]);
  assert.equal(canonical.verifiedStep.semanticVerified,false);
  assert.equal((await f.store().state(f.id)).animation_request?.status,"COMPLETED");
  assert.equal(users(f.manager()).length,1);assert.equal(f.posts(),0);
  f.faux.setResponses([input=>{f.inputs.push(input);return fauxAssistantMessage("小球仍在从左向右移动，目标位置还未到达。");}]);
  await f.submit("explainer-mid-move-001",{...f.anchor,scene_id:"right:0",scene_elapsed_ms:350,explainer_path:["predict","right"]});
  const moving=canonicalFrom(f.inputs[1]!);
  assert.equal(moving.previousState.elements.ball!.x,32);assert.equal(moving.targetState.elements.ball!.x,240);
  assert.equal(moving.transition,true);assert.equal(moving.transitionProgress,.5);assert.equal(moving.sceneDurationMs,700);
  assert.equal(users(f.manager()).length,2);assert.equal(f.posts(),0);
}));

test("new explainer pause queries reject crossed paths, forged snapshots and elapsed overflow before persistence",async()=>fixture(async f=>{
  const leaf=f.manager().getLeafId();
  for(const change of [
    {explainer_path:["predict","right","down","finish"]},
    {explainer_path:["right","finish"]},
    {explainer_path:undefined},
    {artifact_sha256:"0".repeat(64)},
    {scene_id:"right:0",explainer_path:["predict","down"]},
    {scene_id:"right:0",explainer_path:["predict","right"],scene_elapsed_ms:701},
  ])await assert.rejects(f.submit("invalid-explainer-001",{...f.anchor,...change}));
  assert.equal(f.inputs.length,0);assert.equal(users(f.manager()).length,0);assert.equal(f.manager().getLeafId(),leaf);
  assert.equal((await f.store().state(f.id)).animation_request,null);assert.equal(f.posts(),0);
}));

test("query and explicit retry bind the full chosen path and reuse only the original real question",async()=>fixture(async f=>{
  const otherPath={...f.anchor,explainer_path:["predict","down","finish"]};
  assert.notEqual(animationRequestHash(question,f.anchor),animationRequestHash(question,otherPath));
  f.faux.setResponses([input=>{f.inputs.push(input);return fauxAssistantMessage("isolated incomplete response",{stopReason:"error"});}]);
  await f.submit("explainer-first-001");
  const first=(await f.store().state(f.id)).animation_request!;assert.equal(first.status,"FAILED");
  await f.submit("explainer-first-001",f.anchor,undefined,true);
  assert.equal(f.inputs.length,1);assert.equal(users(f.manager()).length,1);
  await assert.rejects(f.submit("explainer-first-001",otherPath,undefined,true),/不同|位置|标识/);
  await assert.rejects(f.submit("explainer-retry-001",otherPath,"explainer-first-001"),/重试|不一致/);
  await assert.rejects(f.submit("explainer-missing-001",f.anchor,undefined,true),/回执|未找到|重新发送/);
  assert.equal(f.inputs.length,1);assert.equal(users(f.manager()).length,1);
  f.faux.setResponses([input=>{f.inputs.push(input);return fauxAssistantMessage("合流保留了你实际选择的向右路径。");}]);
  await f.submit("explainer-retry-002",f.anchor,"explainer-first-001");
  const retried=(await f.store().state(f.id)).animation_request!;
  assert.equal(retried.status,"COMPLETED");assert.equal(retried.source_user_entry_id,first.source_user_entry_id);
  assert.equal(f.inputs.length,2);assert.equal(users(f.manager()).length,1);
  assert.deepEqual(canonicalFrom(f.inputs[1]!).parameters.path,f.anchor.explainer_path);
  assert.equal(f.posts(),0);
}));

test("Gateway to real Pi explainer mode preserves CHECK, Candidate and recall while all learning writes are unavailable",async()=>fixture(async f=>{
  const context=f.context();
  context.recordTurn({active_skill_id:"skill",active_task_id:"task",teaching_mode:"EXPLAIN",outcome:"CORRECT",current_question:"此前的真实原题",
    candidate_evidence:{evidence_type:"EXPLAIN",description:"原有解释候选",supporting_interaction_summary:"此前真实回答",assistance_level:"WITH_HELP"}});
  const request={id:"prior-check",purpose:"CHECK" as const,session_id:f.id,goal_id:"goal",task_id:"task",skill_id:"skill",
    questions:[{id:"old-q",prompt:"原来的题目",selection:"freeform" as const,options:[]}]};
  context.learnerQuestions.restore({pending:request,last_answer:{request:{...request,id:"older-check"},reply:null,text:"已有真实回答",used_choices:false,choices_exposed:false}},f.id);
  context.activeRecall.start({goal_id:"goal",session_id:f.id,skill_id:"skill",task_id:"task",primary_questions:["问题一","问题二","问题三"]});
  const before=context.snapshot(),attacks=["record_answer_assessment","submit_evidence","complete_learning_task"];
  f.faux.setResponses([...attacks.map((name,index)=>(input:Context)=>{
    f.inputs.push(input);for(const tool of input.tools??[])assert.ok(ANIMATION_READ_TOOLS.includes(tool.name),tool.name);
    if(index)assert.ok(input.messages.some(message=>message.role==="toolResult"&&message.toolCallId===`forbidden-${index-1}`&&message.isError));
    return fauxAssistantMessage(fauxToolCall(name,{task_id:"task",skill_id:"skill"},{id:`forbidden-${index}`}),{stopReason:"toolUse"});
  }),input=>{f.inputs.push(input);assert.ok(input.messages.some(message=>message.role==="toolResult"&&message.toolCallId==="forbidden-2"&&message.isError));return fauxAssistantMessage("选择向右之后，小球的位置和记录都沿该路径保留。");}]);
  const gateway=createGateway({store:f.store(),retrieval:{scopeChanged:()=>undefined} as never});
  gateway.listen(0,"127.0.0.1");await once(gateway,"listening");
  const address=gateway.address();assert.ok(address&&typeof address!=="string");
  const url=`http://127.0.0.1:${address.port}/api/web/sessions/${f.id}/messages`;
  try {
    const payload={message:question,animation_context:f.anchor,request_id:"gateway-explainer-001",expected_version:await f.version()};
    const forbidden=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...payload,learner_reply:{request_id:"prior-check",answers:[]}})});
    assert.equal(forbidden.status,400);assert.equal(f.inputs.length,0);assert.equal(users(f.manager()).length,0);
    const response=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}),stream=await response.text();
    assert.equal(response.status,200,stream);assert.match(stream,/done/);
    assert.equal((await f.store().state(f.id)).animation_request?.status,"COMPLETED");
    assert.equal(f.inputs.length,4);assert.equal(f.posts(),0);assert.deepEqual(context.snapshot(),before);
    assert.equal(users(f.manager()).length,1);assert.deepEqual(canonicalFrom(f.inputs[0]!).parameters.path,f.anchor.explainer_path);
    const reopened=SessionManager.open(f.manager().getSessionFile()!);
    assert.equal(users(reopened).length,1);assert.ok(reopened.getBranch().some(row=>row.type==="message"&&row.message.role==="toolResult"&&row.message.toolName==="present_explainer_animation"));
  } finally {gateway.closeAllConnections();await new Promise<void>(done=>gateway.close(()=>done()));}
}));
