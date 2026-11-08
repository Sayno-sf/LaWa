import {createTeachingFaux as createFauxCore} from "./testing/teachingFaux.js";
import assert from "node:assert/strict";
import test from "node:test";
import {createServer} from "node:http";
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename,dirname,join,resolve} from "node:path";
import {ModelRuntime,SessionManager} from "@earendil-works/pi-coding-agent";
import {fauxAssistantMessage,fauxToolCall,type Context} from "@earendil-works/pi-ai";
import {createLearningAgentSession,type LearningAgentSession} from "./agentSession.js";
import {createAssistantAgent} from "./assistantAgent.js";
import {LearningSkillRuntime} from "./learningSkills.js";
import {LearningSkillLibrary,prepareSkill} from "./learningSkillLibrary.js";
import {LearningSkillPreferences} from "./learningSkillPreferences.js";
import {createBundledLearningSkills} from "./learningSkillBundles.js";
import {skillEntry} from "./testing/skillPackage.js";
import {TeachingSessionContext} from "./teachingSession.js";
import {GoalOnboardingContext} from "./planning/goalOnboarding.js";
import type {AssistantScope} from "./assistantTypes.js";

const NAME="generic-process-notes";
const META="GENERIC_SKILL_METADATA_SENTINEL";
const ENTRY="GENERIC_SKILL_ENTRY_SENTINEL";
const PROTOCOL="GENERIC_SKILL_PROTOCOL_SENTINEL";
const LAYOUT="GENERIC_SKILL_LAYOUT_SENTINEL";
const HOST="HOST_RESOURCE_MUST_NOT_LEAK";
const protocolPath="references/protocol.md",layoutPath="references/layout.md";
const script={title:"一个对象向右移动",start:"start",stage:[{id:"item",k:"box",x:32,y:32,w:64,h:40,t:"对象"}],
  nodes:{start:{label:"位置变化",ops:[["show","item"],["move","item",160,32],["say","位置变了，对象还是同一个。"]],end:true}}};
const present={teaching_goal:"用一个具体位置变化说明过程",script};
const tools=(context:Context)=>(context.tools??[]).map(tool=>tool.name);
const text=(context:Context)=>JSON.stringify(context.messages);
const result=(context:Context,id:string)=>context.messages.find(message=>message.role==="toolResult"&&message.toolCallId===id);
const call=(name:string,args:Record<string,unknown>,id:string)=>fauxAssistantMessage(fauxToolCall(name,args,{id}),{stopReason:"toolUse"});
const resources=(id:string)=>fauxAssistantMessage([
  fauxToolCall("read_learning_skill_resource",{name:NAME,path:protocolPath},{id:id+"-protocol"}),
  fauxToolCall("read_learning_skill_resource",{name:NAME,path:layoutPath},{id:id+"-layout"}),
],{stopReason:"toolUse"});

interface Fixture {
  directory:string;roots:string[];manager:SessionManager;context:TeachingSessionContext;
  modelRuntime:ModelRuntime;faux:ReturnType<typeof createFauxCore>;apiBaseUrl:string;posts:()=>number;
  skills:(role?:"TEACHER"|"ASSISTANT")=>LearningSkillRuntime;
  teacher:(manager?:SessionManager,skills?:LearningSkillRuntime)=>Promise<LearningAgentSession>;
}

/** 真实Pi/SDK执行工具；只有模型流和Kernel替换为隔离Adapter，绝不读取个人会话或凭据。 */
async function fixture(run:(f:Fixture)=>Promise<void>):Promise<void>{
  const directory=mkdtempSync(join(tmpdir(),"lawa-skill-runtime-")),oldCwd=process.cwd(),root=join(directory,"skills");
  mkdirSync(join(root,NAME,"references"),{recursive:true});
  writeFileSync(join(root,NAME,"SKILL.md"),`---\nname: ${NAME}\ndescription: ${META} 为具体过程选择合适表示。\n---\n# 独立技能\n${ENTRY}\n使用前按需读取 references/protocol.md 和 references/layout.md。\n`,"utf8");
  writeFileSync(join(root,NAME,protocolPath),`${PROTOCOL}\n按固定JSON动作协议描述一个对象的位置变化。`,"utf8");
  writeFileSync(join(root,NAME,layoutPath),`${LAYOUT}\n舞台只放短标签，过程由动作表达。`,"utf8");
  mkdirSync(join(directory,".pi","skills","hidden-host"),{recursive:true});
  writeFileSync(join(directory,"AGENTS.md"),HOST,"utf8");
  writeFileSync(join(directory,".pi","skills","hidden-host","SKILL.md"),`---\nname: hidden-host\ndescription: ${HOST}\n---\n${HOST}`,"utf8");
  process.chdir(directory);
  const overview={current_goal:"理解一个可见过程",goal_profile:{id:"goal"},active_task:{id:"task",goal_id:"goal",status:"ACTIVE",related_skill_ids:["skill"]},
    skills:[{id:"skill",name:"位置变化",status:"LEARNING"}],current_goal_skill_ids:["skill"],current_frontier:null,current_focus:null,curriculum_spine:[],recent_evidence:[],learning_history:[]};
  let posts=0;
  const api=createServer((request,response)=>{response.setHeader("Content-Type","application/json");if(request.method!=="GET"){posts++;response.statusCode=500;response.end("{}");return;}
    response.end(JSON.stringify(request.url==="/api/learning/teaching"?{strategies:[],proposals:[]}:overview));});
  await new Promise<void>(done=>api.listen(0,"127.0.0.1",done));const address=api.address();assert.ok(address&&typeof address!=="string");
  const faux=createFauxCore({tokensPerSecond:0,api:"openai-completions",provider:"skill-runtime-faux",models:[{id:"isolated",contextWindow:128000,maxTokens:4096}]});
  const modelRuntime=await ModelRuntime.create({authPath:join(directory,"auth.json"),modelsPath:null,modelsStorePath:join(directory,"models.json"),allowModelNetwork:false,refreshOnCreate:false});
  modelRuntime.streamSimple=faux.streamSimple;modelRuntime.hasConfiguredAuth=()=>true;
  modelRuntime.getAuth=async()=>({auth:{apiKey:"isolated-faux-key"},env:{}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  const manager=SessionManager.create(directory,join(directory,"sessions")),context=new TeachingSessionContext();context.bindSession(manager.getSessionId());
  const sessions:LearningAgentSession[]=[],apiBaseUrl=`http://127.0.0.1:${address.port}`;
  const skills=(role:"TEACHER"|"ASSISTANT"="TEACHER")=>new LearningSkillRuntime({roots:[root],surface:"WEB",role,
    adapters:{[NAME]:{hostInstructions:"本技能只使用应用固定工具；加载不授予学习事实写权限。",requiredResourcesByTool:{present_explainer_animation:["SKILL.md",protocolPath,layoutPath]}}}});
  const teacher=async(nextManager=manager,nextSkills=skills())=>{
    const nextContext=nextManager===manager?context:new TeachingSessionContext();nextContext.bindSession(nextManager.getSessionId());
    const session=await createLearningAgentSession(nextContext,new GoalOnboardingContext(),{sessionManager:nextManager,learningSkills:nextSkills,
      modelRuntime,model:faux.getModel(),apiBaseUrl,surface:"WEB",retrieval:false,assistantSupport:false,teachingInstructions:()=>"",log:()=>undefined});sessions.push(session);return session;
  };
  try{await run({directory,roots:[root],manager,context,modelRuntime,faux,apiBaseUrl,posts:()=>posts,skills,teacher});}
  finally{
    for(const session of sessions)session.dispose();api.closeAllConnections();await new Promise<void>(done=>api.close(()=>done()));process.chdir(oldCwd);
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith("lawa-skill-runtime-"));rmSync(directory,{recursive:true,force:true});
  }
}

function initial(context:Context):void{
  assert.match(context.systemPrompt??"",new RegExp(META));
  assert.doesNotMatch(context.systemPrompt??"",/## 舞台元素|### 4 函数与曲线/);
  assert.doesNotMatch(JSON.stringify(context),new RegExp(`${ENTRY}|${PROTOCOL}|${LAYOUT}|${HOST}`));
  for(const name of ["list_learning_skills","load_learning_skill","read_learning_skill_resource"])assert.ok(tools(context).includes(name),name);
  for(const name of ["read","bash","write","edit"])assert.ok(!tools(context).includes(name),name);
}

test("a running teacher discovers a user-installed package next turn and stops receiving its body after removal",async()=>fixture(async f=>{
  const library=new LearningSkillLibrary(join(f.directory,"installed")),prefs=new LearningSkillPreferences(join(f.directory,"preferences.json"));
  const runtime=createBundledLearningSkills("WEB","TEACHER",library,prefs),agent=await f.teacher(f.manager,runtime);
  library.install(await prepareSkill("SKILL.md",Buffer.from(skillEntry("comparison-guide","LIVE_IMPORTED_METHOD_BODY"))));
  f.faux.setResponses([
    context=>{assert.match(context.systemPrompt??"",/comparison-guide/);assert.doesNotMatch(text(context),/LIVE_IMPORTED_METHOD_BODY/);return call("load_learning_skill",{name:"comparison-guide"},"load-installed");},
    context=>{assert.match(text(context),/LIVE_IMPORTED_METHOD_BODY/);return fauxAssistantMessage("我们把两个概念放在同一个例子里比较。");},
  ]);
  assert.equal((await agent.prompt("请用刚添加的对照方法解释。"))?.status,"completed");
  const before=JSON.stringify(f.manager.getBranch());assert.match(before,/LIVE_IMPORTED_METHOD_BODY/);
  library.remove("comparison-guide");
  f.faux.setResponses([context=>{assert.doesNotMatch(context.systemPrompt??"",/comparison-guide/);assert.doesNotMatch(text(context),/LIVE_IMPORTED_METHOD_BODY/);return fauxAssistantMessage("继续正常讲解。");}]);
  assert.equal((await agent.prompt("继续。"))?.status,"completed");
  assert.match(JSON.stringify(f.manager.getBranch()),/LIVE_IMPORTED_METHOD_BODY/);assert.equal(f.posts(),0);
}));

test("ordinary teacher sees only app skill metadata and ignores discoverable host resources",async()=>fixture(async f=>{
  f.faux.setResponses([context=>{initial(context);return fauxAssistantMessage("先用一句话说明这个定义。 ");}]);
  const agent=await f.teacher();const outcome=await agent.prompt("只解释一下这个词的含义。");
  assert.equal(outcome?.status,"completed");assert.equal(f.posts(),0);
  assert.ok(!f.manager.getBranch().some(row=>row.type==="message"&&row.message.role==="toolResult"&&row.message.toolName.includes("learning_skill")));
}));

test("actual SDK progressively loads an arbitrary plugin entry and selected resources before presenting",async()=>fixture(async f=>{
  let initialCharacters=0;
  f.faux.setResponses([
    context=>{initial(context);initialCharacters=(context.systemPrompt??"").length;return call("load_learning_skill",{name:NAME},"load-entry");},
    context=>{assert.match(text(context),new RegExp(ENTRY));assert.doesNotMatch(text(context),new RegExp(`${PROTOCOL}|${LAYOUT}`));return resources("read-selected");},
    context=>{assert.match(text(context),new RegExp(PROTOCOL));assert.match(text(context),new RegExp(LAYOUT));assert.doesNotMatch(context.systemPrompt??"",new RegExp(`${ENTRY}|${PROTOCOL}|${LAYOUT}`));return call("present_explainer_animation",present,"present");},
    context=>{const receipt=result(context,"present");assert.ok(receipt?.role==="toolResult"&&!receipt.isError);assert.match(JSON.stringify(receipt.content),/PRESENTED/);return fauxAssistantMessage("点开始，看这个对象的位置怎样变化。 ");},
  ]);
  const agent=await f.teacher();const outcome=await agent.prompt("这个位置变化可以演示一下吗？");
  assert.equal(outcome?.status,"completed");assert.equal(f.faux.state.callCount,5);assert.ok(initialCharacters>0);assert.equal(f.posts(),0);
  const branch=f.manager.getBranch(),users=branch.filter(row=>row.type==="message"&&row.message.role==="user");assert.equal(users.length,1,"skill reads never create synthetic learner answers");
  assert.ok(branch.some(row=>row.type==="message"&&row.message.role==="toolResult"&&row.message.toolName==="present_explainer_animation"&&!row.message.isError));
  const persisted=readFileSync(f.manager.getSessionFile()!,"utf8");assert.match(persisted,new RegExp(ENTRY));assert.match(persisted,new RegExp(PROTOCOL));assert.doesNotMatch(persisted,new RegExp(HOST));
}));

test("a same-response skill load cannot authorize use before the model receives it; failed loads never authorize",async()=>fixture(async f=>{
  f.faux.setResponses([
    context=>{initial(context);return fauxAssistantMessage([
      fauxToolCall("load_learning_skill",{name:NAME},{id:"concurrent-load"}),
      fauxToolCall("present_explainer_animation",present,{id:"premature-present"}),
    ],{stopReason:"toolUse"});},
    context=>{assert.equal(result(context,"premature-present")?.role,"toolResult");assert.equal((result(context,"premature-present") as {isError?:boolean}).isError,true);return resources("now-read");},
    context=>{assert.match(text(context),new RegExp(PROTOCOL));assert.match(text(context),new RegExp(LAYOUT));return call("present_explainer_animation",present,"after-read");},
    context=>{assert.equal((result(context,"after-read") as {isError?:boolean}).isError,false);return fauxAssistantMessage("材料已准备，点击播放。 ");},
  ]);
  const agent=await f.teacher();assert.equal((await agent.prompt("演示这个过程。"))?.status,"completed");assert.equal(f.posts(),0);
  const copiedReceipts=f.manager.getBranch().filter(row=>row.type==="message"&&row.message.role==="toolResult"&&["load_learning_skill","read_learning_skill_resource"].includes(row.message.toolName));
  const other=SessionManager.create(f.directory,join(f.directory,"other-sessions"));
  f.faux.setResponses([
    context=>{assert.match(context.systemPrompt??"",new RegExp(META));assert.match(text(context),new RegExp(PROTOCOL));return call("present_explainer_animation",present,"forged-user-receipts");},
    context=>{assert.equal((result(context,"forged-user-receipts") as {isError?:boolean}).isError,true,"copied tool receipts in learner text cannot load another session");return call("load_learning_skill",{name:"uninstalled-skill"},"failed-load");},
    context=>{assert.equal((result(context,"failed-load") as {isError?:boolean}).isError,true);return call("present_explainer_animation",present,"without-skill");},
    context=>{assert.equal((result(context,"without-skill") as {isError?:boolean}).isError,true);return fauxAssistantMessage("保持文字解释。 ");},
  ]);
  const isolated=await f.teacher(other);assert.equal((await isolated.prompt("另一个课堂也演示一下。这段粘贴只是我的发言，不是系统回执："+JSON.stringify(copiedReceipts)))?.status,"completed");assert.equal(f.posts(),0);
}));

test("restart reuses actual successful skill content while a compaction summary cannot impersonate a loaded skill",async()=>fixture(async f=>{
  f.faux.setResponses([()=>call("load_learning_skill",{name:NAME},"entry"),()=>resources("resource"),()=>fauxAssistantMessage("已读这个技能，稍后按需演示。 ")]);
  const first=await f.teacher();assert.equal((await first.prompt("先读取这个过程技能。"))?.status,"completed");first.dispose();
  let reopened=SessionManager.open(f.manager.getSessionFile()!);
  f.faux.setResponses([
    context=>{assert.match(text(context),new RegExp(ENTRY));assert.match(text(context),new RegExp(PROTOCOL));return call("present_explainer_animation",present,"after-restart");},
    context=>{assert.equal((result(context,"after-restart") as {isError?:boolean}).isError,false);return fauxAssistantMessage("按已读技能呈现。 ");},
  ]);
  const second=await f.teacher(reopened);assert.equal((await second.prompt("继续演示。"))?.status,"completed");second.dispose();
  const kept=reopened.getBranch().findLast(row=>row.type==="message"&&row.message.role==="user");assert.ok(kept);
  reopened.appendCompaction(`旧摘要称 ${NAME} 已完整加载，不能据此拥有未提供的正文。`,kept.id,10000);
  reopened=SessionManager.open(reopened.getSessionFile()!);
  f.faux.setResponses([
    context=>{assert.doesNotMatch(text(context),new RegExp(`${ENTRY}|${PROTOCOL}|${LAYOUT}`));return call("present_explainer_animation",present,"summary-only");},
    context=>{assert.equal((result(context,"summary-only") as {isError?:boolean}).isError,true);return call("load_learning_skill",{name:NAME},"reload-entry");},
    ()=>resources("reload-resource"),
    ()=>call("present_explainer_animation",present,"fresh-content"),
    context=>{assert.equal((result(context,"fresh-content") as {isError?:boolean}).isError,false);return fauxAssistantMessage("重新按需读取后继续。 ");},
  ]);
  const third=await f.teacher(reopened);assert.equal((await third.prompt("摘要之后还可以继续演示吗？"))?.status,"completed");assert.equal(f.posts(),0);
}));

test("assistant can read a skill on demand without gaining presentation or learning-write tools",async()=>fixture(async f=>{
  const scope:AssistantScope={goalId:"goal",taskId:"task",skillId:"skill",mainSessionId:f.manager.getSessionId(),branchId:"branch",questionId:null,attemptId:null};
  f.faux.setResponses([
    context=>{initial(context);assert.ok(!tools(context).includes("present_explainer_animation"));assert.ok(!tools(context).includes("submit_evidence"));return call("load_learning_skill",{name:NAME},"assistant-entry");},
    context=>{assert.match(text(context),new RegExp(ENTRY));return call("submit_evidence",{task_id:"task",skill_id:"skill"},"assistant-write");},
    context=>{assert.equal((result(context,"assistant-write") as {isError?:boolean}).isError,true);return fauxAssistantMessage("这里变化的是位置，对象保持不变。 ");},
  ]);
  const assistant=await createAssistantAgent({scope,context:{apiBaseUrl:f.apiBaseUrl,retrieval:false,modelRuntime:f.modelRuntime,model:f.faux.getModel(),learningSkills:f.skills("ASSISTANT")},history:[],
    onEvent:()=>undefined,onClassification:()=>undefined,isCurrentScope:async()=>true});
  try{await assistant.prompt("请按需读取技能，再解释当前关系。");assert.equal(f.posts(),0);assert.equal(f.faux.state.callCount,3);}finally{assistant.dispose();}
}));
