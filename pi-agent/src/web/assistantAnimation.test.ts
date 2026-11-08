import assert from "node:assert/strict";
import test from "node:test";
import {once} from "node:events";
import {createServer} from "node:http";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename,dirname,join,resolve} from "node:path";
import {ModelRuntime,type SessionManager} from "@earendil-works/pi-coding-agent";
import {createFauxCore,fauxAssistantMessage,fauxToolCall,type Context} from "@earendil-works/pi-ai";
import {buildAssistantPrompt,createAssistantAgent} from "../assistantAgent.js";
import {AssistantStore} from "../assistantStore.js";
import type {AssistantAgentOptions,AssistantScope} from "../assistantTypes.js";
import {createExplainerArtifact} from "../explainerCatalog.js";
import {getAnimationArtifact} from "../animationCatalog.js";
import type {AnimationAnchor,AnimationPresentation} from "../animationTypes.js";
import type {ExplainerPresentation,ExplainerScript} from "../explainerTypes.js";
import type {LearningOverview} from "../learningOverviewTool.js";
import type {TeachingSessionContext} from "../teachingSession.js";
import type {RetrievalRuntime} from "../retrieval/runtime.js";
import {WebSessionStore} from "./sessionStore.js";
import {createGateway} from "./gateway.js";

const script:ExplainerScript={title:"移动后的两种位置",start:"intro",stage:[{id:"ball",k:"box",x:32,y:32,w:48,h:40,t:"物体"}],nodes:{
  intro:{label:"预测",ops:[["show","ball"],["say","看这个物体会去哪里。"]],ask:{q:"向哪边移动？",opts:[{t:"向右",go:"right"},{t:"向下",go:"down"},{t:"不确定",go:"down"}]}},
  right:{label:"右移",ops:[["move","ball",240,32]],next:"finish"},down:{label:"下移",ops:[["move","ball",32,128]],next:"finish"},
  finish:{label:"合流",ops:[["say","路径不同，留下的位置也不同。"]],end:true}}};

async function fixture(run:(f:{store:()=>WebSessionStore;assistants:()=>AssistantStore;id:string;anchor:AnimationAnchor;oldAnchor:AnimationAnchor;
  manager:()=>SessionManager;context:()=>TeachingSessionContext;options:AssistantAgentOptions[];inputs:Context[];posts:()=>number;
  overview:LearningOverview;restart:()=>Promise<void>;apiBaseUrl:string})=>Promise<void>,realSdk=false){
  const directory=mkdtempSync(join(tmpdir(),"lawa-assistant-animation-")),savedEnv=new Map<string,string|undefined>();
  for(const key of ["PROVIDER_SETTINGS_PATH","PROVIDER_SECRETS_PATH","SPEECH_SETTINGS_PATH","STUDY_TIME_PATH"]){savedEnv.set(key,process.env[key]);process.env[key]=join(directory,key+".json");}
  const overview:LearningOverview={current_goal:"理解位置变化",goal_profile:{id:"goal"},current_frontier:null,current_focus:null,
    active_task:{id:"task",goal_id:"goal",status:"ACTIVE",related_skill_ids:["skill"]},skills:[{id:"skill",name:"位置变化",status:"LEARNING"}],
    current_goal_skill_ids:["skill"],curriculum_spine:[],recent_evidence:[],learning_history:[]};
  let posts=0;const api=createServer((req,res)=>{res.setHeader("Content-Type","application/json");if(req.method!=="GET"){posts++;res.statusCode=403;res.end("{}");return;}res.end(JSON.stringify(overview));});
  await new Promise<void>(done=>api.listen(0,"127.0.0.1",done));const address=api.address();assert.ok(address&&typeof address!=="string");const apiBaseUrl=`http://127.0.0.1:${address.port}`;
  const faux=createFauxCore({tokensPerSecond:0,api:"openai-completions",provider:"assistant-animation-faux",models:[{id:"isolated",contextWindow:128000,maxTokens:4096}]}),inputs:Context[]=[],options:AssistantAgentOptions[]=[];
  faux.setResponses([input=>{inputs.push(input);return fauxAssistantMessage(fauxToolCall("submit_evidence",{description:"不能写学习事实"}),{stopReason:"toolUse"});},
    input=>{inputs.push(input);return fauxAssistantMessage("这一步沿向下分支移动，尚在原位置到下方位置的过渡中。");},
    input=>{inputs.push(input);return fauxAssistantMessage(fauxToolCall("record_assistant_help",{kind:"HINT",reason:"解释了当前动画的过渡。",replyQuote:"这一步沿向下分支移动"}),{stopReason:"toolUse"});}]);
  const runtime=await ModelRuntime.create({authPath:join(directory,"auth.json"),modelsPath:null,modelsStorePath:join(directory,"models.json"),allowModelNetwork:false,refreshOnCreate:false});
  runtime.streamSimple=faux.streamSimple;runtime.hasConfiguredAuth=()=>true;runtime.getAuth=async()=>({auth:{apiKey:"isolated"},env:{}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  let assistants:AssistantStore,store:WebSessionStore;
  const make=()=>{assistants=new AssistantStore({rootDir:join(directory,"assistants")});store=new WebSessionStore({apiBaseUrl,conversationDir:join(directory,"sessions"),conversationCwd:directory,assistantStore:assistants,
    createAssistantAgent:async value=>{options.push(value);return realSdk?createAssistantAgent({...value,context:{...value.context,apiBaseUrl,retrieval:false,modelRuntime:runtime,model:faux.getModel()}}):
      {prompt:async()=>{await value.onEvent({type:"assistant_delta",delta:"向下分支正在改变物体的位置。"});value.onClassification({kind:"HINT",reason:"解释动画。",replyQuote:"向下分支"});},abort:async()=>undefined,dispose:()=>undefined};},
    fetchOverview:async()=>structuredClone(overview),fetchLibrary:async()=>({projects:[]}),log:()=>undefined,
    createAgent:async()=>({prompt:async()=>{throw new Error("动画助教问题不得进入主教师回合");},abort:async()=>undefined,dispose:()=>undefined})});};
  make();
  try{
    const main=await store!.create(),id=main.sessionId;
    const record=()=>((store! as unknown as {sessions:Map<string,{sessionManager:SessionManager;context:TeachingSessionContext}>}).sessions.get(id)!);
    const manager=record().sessionManager;
    const presentation:ExplainerPresentation={id:"new-animation",sourceSessionId:id,goalId:"goal",taskId:"task",skillId:"skill",artifact:createExplainerArtifact(script)};
    manager.appendMessage(fauxAssistantMessage(fauxToolCall("present_explainer_animation",{script,teaching_goal:"区分两种路径"},{id:"new-tool"}),{stopReason:"toolUse"}));
    const entryId=manager.appendMessage({role:"toolResult",toolName:"present_explainer_animation",toolCallId:"new-tool",content:[{type:"text",text:"动画已呈现"}],details:{explainer:presentation},isError:false,timestamp:Date.now()});
    const anchor:AnimationAnchor={presentation_id:presentation.id,source_entry_id:entryId,artifact_sha256:presentation.artifact.contentSha256,scene_id:"down:0",scene_elapsed_ms:350,selected_object_id:null,explainer_path:["intro","down"]};
    const old:AnimationPresentation={id:"old-animation",sourceSessionId:id,goalId:"goal",taskId:"task",skillId:"skill",artifact:getAnimationArtifact("linear-2x-plus3")};
    manager.appendMessage(fauxAssistantMessage(fauxToolCall("present_teaching_animation",{artifact_id:old.artifact.id,teaching_goal:"理解等式"},{id:"old-tool"}),{stopReason:"toolUse"}));
    const oldEntry=manager.appendMessage({role:"toolResult",toolName:"present_teaching_animation",toolCallId:"old-tool",content:[{type:"text",text:"旧动画已呈现"}],details:{animation:old},isError:false,timestamp:Date.now()});
    const oldAnchor:AnimationAnchor={presentation_id:old.id,source_entry_id:oldEntry,artifact_sha256:old.artifact.contentSha256,scene_id:"subtract",scene_elapsed_ms:4000,selected_object_id:null};
    await run({store:()=>store!,assistants:()=>assistants!,id,anchor,oldAnchor,manager:()=>record().sessionManager,context:()=>record().context,overview,options,inputs,posts:()=>posts,apiBaseUrl,
      restart:async()=>{store!.dispose();make();assert.equal((await store!.create()).sessionId,id);}});
  }finally{store!.dispose();api.closeAllConnections();await new Promise<void>(done=>api.close(()=>done()));for(const[key,v]of savedEnv)if(v===undefined)delete process.env[key];else process.env[key]=v;
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith("lawa-assistant-animation-"));rmSync(directory,{recursive:true,force:true});}
}

test("assistant receives server-replayed exact branch position and leaves main teaching state intact",async()=>fixture(async f=>{
  f.context().recordTurn({active_skill_id:"skill",active_task_id:"task",teaching_mode:"EXPLAIN",outcome:"CORRECT",current_question:"正式问题"});
  f.context().learnerQuestions.restore({pending:{id:"pending-check",purpose:"CHECK",session_id:f.id,goal_id:"goal",task_id:"task",skill_id:"skill",questions:[{id:"q",prompt:"正式问题",selection:"freeform",options:[]}]},last_answer:null},f.id);
  const before=f.context().snapshot();await f.store().sendAssistant(f.id,"这里为什么往下？",()=>undefined,f.anchor);
  const actual=f.options[0]!.context.animationQuestion!;assert.deepEqual(actual.anchor,f.anchor);assert.equal(actual.context.recipe,"explainer");
  assert.equal(actual.context.transitionProgress,.5);if(actual.context.recipe!=="explainer")throw new Error("expected explainer context");
  assert.equal(actual.context.previousState.elements.ball!.y,32);assert.equal(actual.context.targetState.elements.ball!.y,128);
  assert.deepEqual(f.context().snapshot(),before);assert.equal(f.posts(),0);
  await f.store().sendAssistant(f.id,"等式为什么还相等？",()=>undefined,f.oldAnchor);assert.equal(f.options[1]!.context.animationQuestion!.context.recipe,"linear_balance");
}));

test("forged or stale animation anchors cannot append an assistant question or main branch marker",async()=>fixture(async f=>{
  const original=f.manager().getLeafId();
  for(const changed of [{artifact_sha256:"0".repeat(64)},{scene_elapsed_ms:701},{explainer_path:["intro","right","down"]},{source_entry_id:"other-entry"},{facts:"pretend"}])
    await assert.rejects(f.store().sendAssistant(f.id,"为什么？",()=>undefined,{...f.anchor,...changed}));
  assert.equal(f.manager().getLeafId(),original);assert.equal(f.options.length,0);assert.equal((await f.store().assistant(f.id)).messages.length,0);
  (f.overview.active_task as {id:string}).id="different-task";await assert.rejects(f.store().sendAssistant(f.id,"为什么？",()=>undefined,f.anchor));assert.equal(f.options.length,0);
}));

test("normal assistant knows recent scoped animation material, and saved questions retain their canonical position",async()=>fixture(async f=>{
  await f.store().sendAssistant(f.id,"这里为什么？",()=>undefined,f.anchor);
  const scope=(await f.store().assistant(f.id)).scope as AssistantScope,record=f.assistants().get(scope).consultations[0]!;
  assert.deepEqual(record.animationQuestion?.anchor,f.anchor);await f.restart();
  assert.deepEqual(f.assistants().get(scope).consultations[0]?.animationQuestion,record.animationQuestion);
  const other:ExplainerPresentation={id:"hidden-animation",sourceSessionId:f.id,goalId:"other-goal",taskId:"other-task",skillId:"other-skill",artifact:createExplainerArtifact({...script,title:"其他目标私有动画"})};
  f.manager().appendMessage({role:"toolResult",toolName:"present_explainer_animation",toolCallId:"hidden-tool",content:[{type:"text",text:"不属于当前任务"}],details:{explainer:other},isError:false,timestamp:Date.now()});
  await f.store().sendAssistant(f.id,"再解释一下这个移动",()=>undefined);
  const input=f.options[1]!;assert.equal(input.context.animationQuestion,undefined);
  assert.deepEqual(input.context.animations?.map(a=>a.title),[script.title,"为什么先减3再除以2"]);
  assert.ok(input.context.animations?.every(a=>a.playback==="UNKNOWN"));assert.deepEqual(input.history.find(m=>m.role==="user")?.animationQuestion,record.animationQuestion);
  assert.doesNotMatch(buildAssistantPrompt(input,{contextWindow:128000,maxTokens:4096}),/本次只解释当前动画例子/);
  f.assistants().clearSession(f.id);assert.equal(f.assistants().getAssistance(scope).records[0]?.animationQuestion,undefined);
}));

test("animation state and history metadata count toward the assistant prompt budget",async()=>fixture(async f=>{
  await f.store().sendAssistant(f.id,"这一步？",()=>undefined,f.anchor);const options=f.options[0]!,position=options.context.animationQuestion!;
  const large={...position,context:{...position.context,caption:"不应静默截断的当前状态".repeat(3000)}};
  assert.throws(()=>buildAssistantPrompt({...options,context:{...options.context,animationQuestion:large}},{contextWindow:32000,maxTokens:8192}),/动画状态超过/);
  const bounded=buildAssistantPrompt({...options,history:[{id:"old",role:"user",content:"旧问题",createdAt:"now",consultationId:"old",animationQuestion:large}]},{contextWindow:32000,maxTokens:8192});
  assert.doesNotMatch(bounded,/不应静默截断的当前状态/);assert.match(bounded,/"omitted":1/);assert.match(bounded,/本次动画提问位置/);
}));

test("real Gateway and assistant SDK receive animation context without granting learning writes",async()=>fixture(async f=>{
  const retrieval={status:async()=>({enabled:false}),settings:{publicSettings:async()=>({enabled:false})},dispose:()=>undefined} as unknown as RetrievalRuntime;
  const gateway=createGateway({store:f.store(),retrieval});gateway.listen(0,"127.0.0.1");await once(gateway,"listening");const address=gateway.address();assert.ok(address&&typeof address!=="string");
  try{
    const response=await fetch(`http://127.0.0.1:${address.port}/api/web/sessions/${f.id}/assistant`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text:"为什么是这个位置？",animation_context:f.anchor})});
    assert.equal(response.status,200);const body=await response.text();assert.match(body,/正在|过渡/);assert.ok(f.inputs.length>=2);
    const prompt=f.inputs[0]!.systemPrompt??"";assert.match(prompt,/本次动画提问位置/);assert.match(prompt,/"transitionProgress":0.5/);assert.match(prompt,/"explainer_path":\["intro","down"\]/);
    assert.match(prompt,/"semanticVerified":false/);assert.ok(f.inputs[0]!.tools?.every(t=>!["submit_evidence","record_answer_assessment","complete_learning_task"].includes(t.name)));
    assert.match(prompt,/本次只解释当前动画例子/);assert.match(prompt,/不能仅由一个示例推出/);
    assert.equal(f.posts(),0);assert.equal((await f.store().assistant(f.id)).messages.length,2);
    const blocked=await fetch(`http://127.0.0.1:${address.port}/api/web/sessions/${f.id}/assistant`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text:"问题",scope:{taskId:"fake"}})});assert.equal(blocked.status,400);
  }finally{gateway.closeAllConnections();await new Promise<void>(done=>gateway.close(()=>done()));}
},true));
