import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import {fauxAssistantMessage,type Context} from "@earendil-works/pi-ai";
import {Type} from "typebox";
import {ProviderSettingsService} from "./web/providerSettings.js";
import {TeachingSessionContext} from "./teachingSession.js";
import {buildRuntimeTeachingContext,buildStableSystemPrompt,buildSystemPrompt} from "./agentPolicy.js";
import {projectTeachingPrompt,RUNTIME_STATE_MARKER} from "./teachingPromptLayout.js";

const go={provider:"opencode-go",id:"deepseek-v4.1-flash",api:"openai-completions",baseUrl:"https://opencode.ai/inference/go/openai/v1"};

test("dynamic teaching state changes without rewriting the stable instructions or original history",()=>{
  const snapshot=new TeachingSessionContext().snapshot();
  const stable=buildStableSystemPrompt("WEB");
  const before=buildRuntimeTeachingContext(snapshot,undefined,'{"task":"before"}',undefined,"elapsed:10");
  const after=buildRuntimeTeachingContext({...snapshot,current_question:"new question"},undefined,'{"task":"after"}',undefined,"elapsed:20");
  assert.notEqual(before,after);
  assert.ok(!stable.includes("elapsed:"));
  assert.ok(!stable.includes('"active_task_id":'));
  assert.equal(buildSystemPrompt(snapshot,undefined,"WEB",'{"task":"before"}',undefined,"elapsed:10"),`${stable}\n\n${before}`);
  const context:Context={systemPrompt:stable,messages:[{role:"user",content:"actual learner answer",timestamp:123}]};
  const original=JSON.stringify(context);
  const first=projectTeachingPrompt(go,context,before),second=projectTeachingPrompt(go,context,after);
  assert.ok(first.systemPrompt===second.systemPrompt,"changing state must not change the system prompt");
  assert.deepEqual(first.messages.slice(0,-1),context.messages);
  assert.equal(first.messages.at(-1)?.role,"user");
  assert.match(JSON.stringify(first.messages.at(-1)),/LAWA_RUNTIME_STATE/);
  assert.match(JSON.stringify(second.messages.at(-1)),/elapsed:20/);
  assert.ok(!JSON.stringify(second).includes("elapsed:10"));
  assert.match(first.systemPrompt??"",/不是学习者发言/);
  assert.match(first.systemPrompt??"",/不构成.*确认/);
  assert.match(first.systemPrompt??"",/低信任/);
  assert.equal(JSON.stringify(context),original);
});

test("unsupported signed providers retain the original system state layout",()=>{
  const context:Context={systemPrompt:"stable",messages:[{role:"user",content:"answer",timestamp:1}]};
  for(const model of [{provider:"anthropic",id:"claude",api:"anthropic-messages"},{...go,baseUrl:"https://opencode.ai.evil.example/inference/go/openai/v1"},{...go,api:"openai-responses"}]) {
    const result=projectTeachingPrompt(model,context,"fresh state");
    assert.equal(result.systemPrompt,"stable\n\nfresh state");
    assert.equal(result.messages,context.messages);
  }
  const qwen=projectTeachingPrompt({provider:"aliyun-bailian",id:"qwen3.8-flash",api:"openai-completions"},context,"fresh state");
  assert.equal(qwen.messages.length,2);
});

test("real SDK payload keeps its history prefix across refreshed state and a reasoning/tool continuation",async()=>{
  const root=mkdtempSync(join(tmpdir(),"lawa-cache-layout-"));
  const runtime=await ModelRuntime.create({authPath:join(root,"auth.json"),modelsPath:null,modelsStorePath:join(root,"models.json"),allowModelNetwork:false,refreshOnCreate:false});
  const requests:any[]=[];
  try {
    const service=new ProviderSettingsService({settingsPath:join(root,"settings.json"),secretsPath:join(root,"secrets.json"),runtimeFactory:async()=>runtime});
    const {model}=await service.saveAndUse({provider:go.provider,model:go.id,baseUrl:go.baseUrl,apiKey:"fixture-only",thinkingLevel:"high",maxOutputTokens:32768});
    const context:Context={systemPrompt:buildStableSystemPrompt("WEB"),tools:[{name:"read_state",description:"Read-only fixture",parameters:Type.Object({})}],messages:[
      {role:"user",content:"earlier question",timestamp:1},
      {...fauxAssistantMessage("earlier teaching content"),provider:go.provider,model:go.id},
      {role:"user",content:"actual answer",timestamp:2},
    ]};
    const transport:typeof fetch=async(_input,init)=>{
      const body=JSON.parse(String(init?.body));requests.push(body);
      const first=requests.length===1;
      const delta=first?{reasoning_content:"current chain reasoning",tool_calls:[{index:0,id:"state-call",type:"function",function:{name:"read_state",arguments:"{}"}}]}:{content:"continue with fresh state"};
      return new Response(`data: ${JSON.stringify({id:"fixture",object:"chat.completion.chunk",created:1,model:go.id,choices:[{index:0,delta,finish_reason:first?"tool_calls":"stop"}]})}\n\ndata: [DONE]\n\n`,{headers:{"Content-Type":"text/event-stream"}});
    };
    const options={fetch:transport,maxRetries:0,sessionId:"cache-fixture",reasoning:"high" as const};
    const first=await runtime.completeSimple(model,projectTeachingPrompt(model,context,"task:before; elapsed:10"),options);
    assert.equal(first.stopReason,"toolUse",first.errorMessage);
    const call=first.content.find(part=>part.type==="toolCall");assert.ok(call&&call.type==="toolCall");
    context.messages.push(first,{role:"toolResult",toolCallId:call.id,toolName:call.name,content:[{type:"text",text:'{"task":"after"}'}],isError:false,timestamp:3});
    const second=await runtime.completeSimple(model,projectTeachingPrompt(model,context,"task:after; elapsed:20"),options);
    assert.equal(second.stopReason,"stop",second.errorMessage);
    // 全量历史与工具schema在新状态之前保持同一前缀；临时状态不写回历史，也不污染下一请求。
    assert.ok(JSON.stringify(requests[0].messages.slice(0,-1))===JSON.stringify(requests[1].messages.slice(0,requests[0].messages.length-1)),"serialized provider history prefix must remain equal");
    assert.deepEqual(requests[0].tools,requests[1].tools);
    assert.match(JSON.stringify(requests[1].messages.at(-1)),/task:after; elapsed:20/);
    assert.ok(!JSON.stringify(requests[1]).includes("task:before"));
    assert.equal(requests[1].messages.findLast((message:any)=>message.role==="assistant").reasoning_content,"current chain reasoning");
    assert.ok(!JSON.stringify(context).includes(RUNTIME_STATE_MARKER));
  } finally {rmSync(root,{recursive:true,force:true});}
});
