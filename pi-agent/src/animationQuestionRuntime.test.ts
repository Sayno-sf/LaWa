import assert from "node:assert/strict";
import test from "node:test";
import {createServer} from "node:http";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename,dirname,join,resolve} from "node:path";
import {ModelRuntime,SessionManager} from "@earendil-works/pi-coding-agent";
import {createFauxCore,fauxAssistantMessage,fauxToolCall,type Context} from "@earendil-works/pi-ai";
import {createLearningAgentSession} from "./agentSession.js";
import {TeachingSessionContext} from "./teachingSession.js";
import {GoalOnboardingContext} from "./planning/goalOnboarding.js";
import {getAnimationArtifact} from "./animationCatalog.js";
import {resolveAnimationContext} from "./animationContext.js";
import {ANIMATION_READ_TOOLS} from "./animationQuestionRequest.js";
import type {AnimationPresentation} from "./animationTypes.js";

const question="为什么factorial(1)得到1后，这个栈帧还在？";

for(const attack of [undefined,"record_answer_assessment","submit_evidence","complete_learning_task"] as const){
  test(`real Pi animation mode preserves old CHECK and rejects writes: ${attack??"normal explanation"}`,async()=>{
    const directory=mkdtempSync(join(tmpdir(),"lawa-animation-runtime-"));
    const overview={current_goal:"理解递归",goal_profile:{id:"goal"},active_task:{id:"task",goal_id:"goal",status:"ACTIVE",related_skill_ids:["skill"]},
      skills:[{id:"skill",name:"递归",status:"LEARNING"}],current_goal_skill_ids:["skill"],current_frontier:{focus_skill_id:"skill"},
      current_focus:null,curriculum_spine:[],recent_evidence:[],learning_history:[]};
    let posts=0;
    const api=createServer((request,response)=>{
      response.setHeader("Content-Type","application/json");
      if(request.method!=="GET"){posts++;response.statusCode=500;return response.end(JSON.stringify({detail:"isolated Kernel rejects all writes"}));}
      response.end(JSON.stringify(request.url==="/api/learning/teaching"?{strategies:[],proposals:[]}:overview));
    });
    await new Promise<void>(done=>api.listen(0,"127.0.0.1",done));const address=api.address();assert.ok(address&&typeof address!=="string");
    const manager=SessionManager.create(directory,join(directory,"sessions"));
    manager.appendMessage(fauxAssistantMessage("原先的课堂问题与教学上下文。"));
    const userId=manager.appendMessage({role:"user",content:[{type:"text",text:question}],timestamp:Date.now()});
    const context=new TeachingSessionContext();context.bindSession(manager.getSessionId());
    context.recordTurn({active_skill_id:"skill",active_task_id:"task",teaching_mode:"EXPLAIN",outcome:"CORRECT",current_question:"此前的原题",
      candidate_evidence:{evidence_type:"EXPLAIN",description:"保留此前的真实候选",supporting_interaction_summary:"此前已发生的回答",assistance_level:"WITH_HELP"}});
    const request={id:"prior-check",purpose:"CHECK" as const,session_id:manager.getSessionId(),goal_id:"goal",task_id:"task",skill_id:"skill",
      questions:[{id:"q",prompt:"此前的原题",selection:"freeform" as const,options:[]}]};
    context.learnerQuestions.restore({pending:{...request,id:"pending-check"},last_answer:{request,reply:null,text:"此前的真实回答",used_choices:false,choices_exposed:false}},manager.getSessionId());
    context.activeRecall.start({goal_id:"goal",session_id:manager.getSessionId(),task_id:"task",skill_id:"skill",primary_questions:["原问题一","原问题二","原问题三"]});
    const before=context.snapshot();
    const presentation:AnimationPresentation={id:"animation",sourceSessionId:manager.getSessionId(),goalId:"goal",taskId:"task",skillId:"skill",artifact:getAnimationArtifact("factorial-3-return")};
    const anchor={presentation_id:presentation.id,source_entry_id:"verified-by-store",artifact_sha256:presentation.artifact.contentSha256,scene_id:"base_case",scene_elapsed_ms:800,selected_object_id:null};
    const canonical=resolveAnimationContext(presentation,anchor);
    const faux=createFauxCore({tokensPerSecond:0,api:"openai-completions",provider:"animation-faux",models:[{id:"animation-test",contextWindow:128000,maxTokens:4096}]});
    const inputs:Context[]=[],errors:string[]=[];
    const inspect=(input:Context)=>{
      inputs.push(input);
      for(const tool of input.tools??[])assert.ok(ANIMATION_READ_TOOLS.includes(tool.name),tool.name);
      assert.match(input.systemPrompt??"",/base_case/);assert.match(input.systemPrompt??"",/previousState/);assert.match(input.systemPrompt??"",/只读/);
      const text=JSON.stringify(input.messages);assert.match(text,/为什么factorial/);
    };
    faux.setResponses(attack?[input=>{inspect(input);return fauxAssistantMessage(fauxToolCall(attack,{task_id:"task",skill_id:"skill"},{id:"forbidden-write"}),{stopReason:"toolUse"});},
      input=>{inspect(input);assert.ok(input.messages.some(message=>message.role==="toolResult"&&message.toolCallId==="forbidden-write"&&message.isError));return fauxAssistantMessage("1是这一层刚算出的结果，栈帧要等返回动作发生才移除。");}]
      :[input=>{inspect(input);return fauxAssistantMessage("这一帧刚得到1，返回尚未发生，所以格子仍保留。下一幕才交回上一层。");}]);
    const runtime=await ModelRuntime.create({authPath:join(directory,"auth.json"),modelsPath:null,modelsStorePath:join(directory,"models.json"),allowModelNetwork:false,refreshOnCreate:false});
    runtime.streamSimple=faux.streamSimple;runtime.hasConfiguredAuth=()=>true;
    runtime.getAuth=async()=>({auth:{apiKey:"isolated-animation-test"},env:{}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
    const agent=await createLearningAgentSession(context,new GoalOnboardingContext(),{apiBaseUrl:`http://127.0.0.1:${address.port}`,sessionManager:manager,
      modelRuntime:runtime,model:faux.getModel(),surface:"WEB",retrieval:false,assistantSupport:false,teachingInstructions:()=>"",log:()=>undefined,
      onEvent:event=>{if(event.type==="model_error")errors.push(event.message);}});
    try{
      assert.ok(agent.askAnimation);const result=await agent.askAnimation({sourceUserEntryId:userId,context:canonical,question,skillId:"skill"});
      assert.equal(result.status,"completed");assert.deepEqual(context.snapshot(),before);assert.equal(posts,0);assert.deepEqual(errors,[]);
      assert.equal(manager.getBranch().filter(row=>row.type==="message"&&row.message.role==="user").length,1);
      assert.equal(inputs.length,attack?2:1);
      const reopened=SessionManager.open(manager.getSessionFile()!);assert.equal(reopened.getBranch().filter(row=>row.type==="message"&&row.message.role==="user").length,1);
      assert.ok(reopened.getBranch().some(row=>row.type==="message"&&row.message.role==="assistant"&&row.message.content.some(part=>part.type==="text"&&part.text.includes("返回"))));
    }finally{
      agent.dispose();api.closeAllConnections();await new Promise<void>(done=>api.close(()=>done()));
      assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith("lawa-animation-runtime-"));rmSync(directory,{recursive:true,force:true});
    }
  });
}
