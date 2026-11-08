import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import {fauxAssistantMessage,type Context} from "@earendil-works/pi-ai";
import {Type} from "typebox";
import {ProviderSettingsService} from "./web/providerSettings.js";
import {configureOpenCodeGoRuntime,isOpenCodeGo} from "./openCodeGo.js";

test("Go decoration is endpoint-scoped, idempotent and preserves caller hooks without leaking conversation IDs",async()=>{
  for(const url of ["https://opencode.ai.evil.example/inference/go/openai/v1","https://opencode.ai/inference/openai/v1","https://api.deepseek.com/v1"]) assert.equal(isOpenCodeGo(url),false);
  assert.equal(isOpenCodeGo("https://opencode.ai/zen/go/v1/"),true);
  const calls:any[]=[];
  const runtime={streamSimple:(...args:any[])=>{calls.push(args);return "unchanged stream";}};
  configureOpenCodeGoRuntime(runtime);const wrapper=runtime.streamSimple;configureOpenCodeGoRuntime(runtime);assert.equal(runtime.streamSimple,wrapper);
  const plain={baseUrl:"https://provider.example/v1"},context={},options={onPayload:()=>{},headers:{kept:"value"}};
  assert.equal(runtime.streamSimple(plain,context,options),"unchanged stream");assert.equal(calls[0][2],options);
  const model={provider:"opencode-go",baseUrl:"https://opencode.ai/inference/go/openai/v1"};
  const scopes=[];
  for(const id of ["private-one","private-one","private-two",undefined]){
    runtime.streamSimple(model,context,{...options,sessionId:id,transformHeaders:async(headers:any)=>({...headers,"x-caller-hook":"preserved"})});
    const prepared=calls.at(-1)[2];assert.equal(prepared.onPayload,options.onPayload);
    const headers=await prepared.transformHeaders({authorization:"fixture",session_id:"private-one","User-Agent":"untrusted"});
    assert.equal(headers.authorization,"fixture");assert.equal(headers["x-caller-hook"],"preserved");
    assert.equal(headers["User-Agent"],"LaWa-LearningAgent/0.1");assert.ok(!JSON.stringify(headers).includes("private-"));scopes.push(headers["x-opencode-session"]);
  }
  assert.equal(scopes[0],scopes[1]);assert.notEqual(scopes[0],scopes[2]);assert.notEqual(scopes[0],scopes[3]);
});

test("personal Go profile sends honest client/session headers and resumes old Qwen through DeepSeek tools",async()=>{
  const root=mkdtempSync(join(tmpdir(),"lawa-personal-go-"));
  const runtime=await ModelRuntime.create({authPath:join(root,"auth.json"),modelsPath:null,modelsStorePath:join(root,"models.json"),allowModelNetwork:false,refreshOnCreate:false});
  const requests:Array<{headers:Headers;body:any}>=[];
  const transport:typeof fetch=async(input,init)=>{
    assert.equal(String(input),"https://opencode.ai/inference/go/openai/v1/chat/completions");
    const headers=new Headers(init?.headers),body=JSON.parse(String(init?.body));requests.push({headers,body});
    const first=requests.length===1;
    const delta=first?{reasoning_content:"fixture reasoning",tool_calls:[{index:0,id:"sum",type:"function",function:{name:"verify_sum",arguments:'{"a":2,"b":3}'}}]}:{content:"结果是5。"};
    return new Response(`data: ${JSON.stringify({id:"fixture",object:"chat.completion.chunk",created:1,model:"deepseek-v4.1-flash",
      choices:[{index:0,delta,finish_reason:first?"tool_calls":"stop"}],usage:{prompt_tokens:200,completion_tokens:10}})}\n\ndata: [DONE]\n\n`,{headers:{"Content-Type":"text/event-stream"}});
  };
  try {
    const service=new ProviderSettingsService({settingsPath:join(root,"settings.json"),secretsPath:join(root,"secrets.json"),runtimeFactory:async()=>runtime});
    const {model}=await service.saveAndUse({provider:"opencode-go",model:"deepseek-v4.1-flash",baseUrl:"https://opencode.ai/inference/go/openai/v1",apiKey:"fixture-go-key",thinkingLevel:"high",maxOutputTokens:32768});
    const context:Context={systemPrompt:"Isolated compatibility fixture",tools:[{name:"verify_sum",description:"Read-only sum",parameters:Type.Object({a:Type.Number(),b:Type.Number()})}],
      messages:[{role:"user",content:"旧题",timestamp:1},{...fauxAssistantMessage("旧百炼回复"),provider:"aliyun-bailian",model:"qwen3.8-flash"},{role:"user",content:"校验2+3",timestamp:2}]};
    const options={fetch:transport,sessionId:"private-conversation",reasoning:"high" as const,maxRetries:0,headers:{"x-opencode-session":"caller-override"}};
    const first=await runtime.completeSimple(model,context,options);assert.equal(first.stopReason,"toolUse",first.errorMessage);
    const call=first.content.find(p=>p.type==="toolCall");assert.ok(call&&call.type==="toolCall");
    context.messages.push(first,{role:"toolResult",toolCallId:call.id,toolName:call.name,content:[{type:"text",text:'{"sum":5}'}],isError:false,timestamp:3});
    const second=await runtime.completeSimple(model,context,options);assert.equal(second.stopReason,"stop",second.errorMessage);
    for(const request of requests){
      assert.equal(request.headers.get("user-agent"),"LaWa-LearningAgent/0.1");
      assert.match(request.headers.get("x-opencode-session")??"",/^[a-f0-9]{64}$/);
      assert.equal(request.body.reasoning_effort,"high");assert.deepEqual(request.body.thinking,{type:"enabled"});
      assert.equal(request.headers.get("authorization"),"Bearer fixture-go-key");
      assert.equal(request.body.messages.find((m:any)=>m.content==="旧百炼回复").reasoning_content,"");
    }
    assert.equal(requests[0]!.headers.get("x-opencode-session"),requests[1]!.headers.get("x-opencode-session"));
    assert.equal(requests[1]!.body.messages.findLast((m:any)=>m.role==="assistant").reasoning_content,"fixture reasoning");
    assert.equal(model.contextWindow,1_000_000);assert.deepEqual(model.input,["text","image"]);
    assert.ok(!JSON.stringify(await service.getPublicSettings()).includes("fixture-go-key"));
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("Go DeepSeek maps supported effort levels while model-default sends no explicit thinking control",async()=>{
  const root=mkdtempSync(join(tmpdir(),"lawa-go-effort-"));
  const runtime=await ModelRuntime.create({authPath:join(root,"auth.json"),modelsPath:null,modelsStorePath:join(root,"models.json"),allowModelNetwork:false,refreshOnCreate:false});
  try {
    const service=new ProviderSettingsService({settingsPath:join(root,"settings.json"),secretsPath:join(root,"secrets.json"),runtimeFactory:async()=>runtime});
    for(const [level,effort] of [["off",undefined],["minimal","low"],["low","low"],["medium","high"],["high","high"],["xhigh","high"],["max","max"]] as const){
      const {model}=await service.saveAndUse({provider:"opencode-go",model:"deepseek-v4.1-flash",baseUrl:"https://opencode.ai/inference/go/openai/v1",apiKey:"fixture-key",thinkingLevel:level});
      const response=await runtime.completeSimple(model,{messages:[{role:"user",content:"fixture",timestamp:1}]},{maxRetries:0,...(level==="off"?{}:{reasoning:level}),fetch:async(_input,init)=>{
        const body=JSON.parse(String(init?.body));assert.equal(body.reasoning_effort,effort);
        assert.deepEqual(body.thinking,effort?{type:"enabled"}:undefined);
        return new Response('data: {"id":"ok","object":"chat.completion.chunk","created":1,"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{"Content-Type":"text/event-stream"}});
      }});
      assert.equal(response.stopReason,"stop",response.errorMessage);
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});
