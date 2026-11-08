import {createTeachingFaux as createFauxCore} from "./testing/teachingFaux.js";
import {attachmentReferences, projectConversationAttachments} from "./conversationAttachments.js";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {ModelRuntime, SessionManager} from "@earendil-works/pi-coding-agent";
import {fauxAssistantMessage, fauxToolCall, type ImageContent} from "@earendil-works/pi-ai";
import {createLearningAgentSession} from "./agentSession.js";
import {TeachingSessionContext} from "./teachingSession.js";
import {GoalOnboardingContext} from "./planning/goalOnboarding.js";
import {knownImageModel,loadTeachingImageBatch,loadTeachingImages,parseImageMaterialIds} from "./teachingImages.js";
import {WebSessionStore} from "./web/sessionStore.js";

test("image material IDs and verified model capability fail closed",()=>{
  assert.deepEqual(parseImageMaterialIds(undefined),[]);
  for(const input of [["https://private.example/image"],["../source"],Array(4).fill("mat-"+"a".repeat(32)),["mat-"+"a".repeat(32),"mat-"+"a".repeat(32)]]) assert.throws(()=>parseImageMaterialIds(input));
  assert.equal(knownImageModel("qwen3.8-flash"),true);assert.equal(knownImageModel("qwen3-vl-plus"),true);
  assert.equal(knownImageModel("deepseek-chat"),false);assert.equal(knownImageModel("unknown"),false);
});

test("original reads carry Goal or draft ownership, reject missing files, wait for parsing and respect cancellation",async()=>{
  const id="mat-"+"a".repeat(32),bytes=Buffer.from([255,216,255,217]),hash="a".repeat(64);
  const meta={id,sha256:hash,purpose_revision:0,format:"image"};let reads=0;
  for(const owner of ["goal-a","draft:session-a"]) {
    const fetcher=async(url:RequestInfo|URL)=>{
      const u=new URL(String(url));
      assert.equal(u.searchParams.get(owner.startsWith("draft:") ? "draft_session_id" : "expected_goal_id"),owner.replace("draft:",""));
      if(u.pathname.endsWith("/metadata")) return Response.json(meta);
      assert.equal(u.pathname,`/api/learning/materials/${id}/visual/image-1`);
      if(reads++===0) return new Response("{}",{status:425});
      return new Response(bytes,{headers:{"Content-Type":"image/jpeg"}});
    };
    const images=await loadTeachingImages([id],owner,"http://isolated.test",undefined,fetcher);
    assert.equal(images[0]?.data,bytes.toString("base64"));
  }
  await assert.rejects(loadTeachingImages([id],"goal-a","http://isolated.test",undefined,async()=>new Response("{}",{status:404})),/删除/);
  await assert.rejects(loadTeachingImages([id],"goal-a","http://isolated.test",undefined,async(url)=>String(url).includes("/metadata?")
    ? Response.json(meta) : new Response("not-image",{headers:{"Content-Type":"image/jpeg"}})),/无效/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(loadTeachingImages([id],"goal-a","http://127.0.0.1:1",controller.signal));
});

test("Web submission resolves image bytes before starting a teacher turn and retains only IDs in original text",async()=>{
  const state={current_goal:"图片目标",goal_profile:{id:"goal-a"},curriculum_spine:[],current_frontier:null,current_focus:null,
    skills:[],recent_evidence:[],active_task:null,learning_history:[],current_goal_skill_ids:[]};
  const id="mat-"+"a".repeat(32),hash="b".repeat(64);let received:unknown,original="",receivedSources:unknown;
  const server=createServer((req,res)=>{assert.match(req.url!,/expected_goal_id=goal-a/);
    if(req.url!.includes("/metadata?")){res.setHeader("Content-Type","application/json");res.end(JSON.stringify({id,sha256:hash,purpose_revision:0,format:"image"}));return;}
    res.setHeader("Content-Type","image/jpeg");res.end(Buffer.from([255,216,255,217]));});
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));const address=server.address();assert.ok(address && typeof address!=="string");
  const store=new WebSessionStore({apiBaseUrl:`http://127.0.0.1:${address.port}`,fetchOverview:async()=>state,
    createAgent:async()=>({supportsImages:()=>true,prompt:async(text,images,sources)=>{original=text;received=images;receivedSources=sources;},abort:async()=>undefined,dispose:()=>undefined})});
  try {const created=await store.create();await store.sendMessage(created.sessionId,"请看截图",()=>undefined,undefined,undefined,undefined,undefined,undefined,[id]);
    assert.match(original,new RegExp(id));assert.equal((received as ImageContent[]).length,1);
    assert.deepEqual(receivedSources,[{material_id:id,scope:"goal-a",source_hash:hash,purpose_revision:0}]);
    await assert.rejects(store.sendMessage(created.sessionId,"",()=>undefined,undefined,undefined,undefined,undefined,undefined,["../other-account"]));
  } finally {store.dispose();await new Promise<void>(done=>server.close(()=>done()));}
});

test("actual Pi teacher receives this turn's original image through tool continuation, without persisting or replaying bytes", async () => {
  const directory=mkdtempSync(join(tmpdir(),"lawa-direct-image-"));
  const overview={current_goal:"识图",goal_profile:{id:"goal"},curriculum_spine:[],current_frontier:null,
    current_focus:null,skills:[],recent_evidence:[],active_task:null,learning_history:[],current_goal_skill_ids:[]};
  const server=createServer((_req,res)=>{res.setHeader("Content-Type","application/json");res.end(JSON.stringify(overview));});
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
  const address=server.address(); assert.ok(address && typeof address!=="string");
  const manager=SessionManager.create(directory,directory);
  const faux=createFauxCore({tokensPerSecond:0});
  const inputs: unknown[]=[];
  faux.setResponses([
    context=>{inputs.push(JSON.parse(JSON.stringify(context)));return fauxAssistantMessage(fauxToolCall("get_learning_overview",{}),{stopReason:"toolUse"});},
    context=>{inputs.push(JSON.parse(JSON.stringify(context)));return fauxAssistantMessage("看到了截图。");},
    context=>{inputs.push(JSON.parse(JSON.stringify(context)));return fauxAssistantMessage("继续。");},
  ]);
  const runtime=await ModelRuntime.create({authPath:join(directory,"auth.json"),modelsPath:null,
    modelsStorePath:join(directory,"models.json"),allowModelNetwork:false,refreshOnCreate:false});
  runtime.streamSimple=faux.streamSimple;
  runtime.hasConfiguredAuth=()=>true;
  runtime.getAuth=async()=>({auth:{apiKey:"isolated-only"},env:{}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  let agent: Awaited<ReturnType<typeof createLearningAgentSession>>|undefined;
  const errors:string[]=[];
  const image:ImageContent={type:"image",data:Buffer.from("ORIGINAL_IMAGE_CANARY").toString("base64"),mimeType:"image/jpeg"};
  try {
    agent=await createLearningAgentSession(new TeachingSessionContext(),new GoalOnboardingContext(),{
      apiBaseUrl:`http://127.0.0.1:${address.port}`,model:{...faux.getModel(),input:["text","image"]},
      modelRuntime:runtime,sessionManager:manager,surface:"WEB",retrieval:false,assistantSupport:false,log:()=>undefined,
      onEvent:event=>{if(event.type==="model_error") errors.push(event.message);}});
    // Regression seam: production prompt + real Pi loop. Before the fix this argument is ignored.
    await (agent.prompt as (text:string,images:ImageContent[])=>Promise<void>)("解释本轮截图\n[LAWA_MATERIAL_CONTEXT]"+attachmentReferences([{id:"mat-"+"a".repeat(32),name:"截图.png",isImage:true}])+"[/LAWA_MATERIAL_CONTEXT]",[image]);
    assert.deepEqual(errors,[]);assert.equal(inputs.length,2);
    for(const input of inputs) assert.ok(JSON.stringify(input).includes(image.data),"teacher request lost the original image");
    assert.ok(!JSON.stringify(manager.getBranch()).includes(image.data),"image bytes must not enter durable Pi history");
    assert.ok(!readFileSync(manager.getSessionFile()!,"utf8").includes(image.data));
    const savedUser=readFileSync(manager.getSessionFile()!,"utf8").split(/\r?\n/).filter(Boolean)
      .map(line=>JSON.parse(line)).find(entry=>entry.type==="message" && entry.message.role==="user");
    const savedText=typeof savedUser.message.content==="string" ? savedUser.message.content
      : savedUser.message.content.filter((p:{type:string})=>p.type==="text").map((p:{text:string})=>p.text).join("\n");
    assert.deepEqual(projectConversationAttachments(savedText),[{id:"mat-"+"a".repeat(32),name:"截图.png",isImage:true}],
      "page reload must recover attachment identities from original Pi history");
    await agent.prompt("下一轮没有图片");
    assert.ok(!JSON.stringify(inputs[2]).includes(image.data),"old image was replayed into an unrelated turn");
  } finally {
    agent?.dispose();await new Promise<void>(done=>server.close(()=>done()));
    rmSync(directory,{recursive:true,force:true});
  }
});

test("direct-image source replacement between metadata and bytes is rejected",async()=>{
  const id="mat-"+"9".repeat(32),hashes=["9".repeat(64),"8".repeat(64)];let metadataReads=0;
  await assert.rejects(loadTeachingImageBatch([id],"goal-a","http://isolated.test",undefined,async(url)=>{
    if(String(url).includes("/metadata?")) return Response.json({id,sha256:hashes[Math.min(metadataReads++,1)],purpose_revision:0});
    return new Response(Buffer.from([255,216,255,217]),{headers:{"Content-Type":"image/jpeg"}});
  }),/发生变化/);
});

test("Stop cancels an in-flight original-image read before any teacher call",async()=>{
  const state={current_goal:"图片目标",goal_profile:{id:"goal-a"},curriculum_spine:[],current_frontier:null,current_focus:null,
    skills:[],recent_evidence:[],active_task:null,learning_history:[],current_goal_skill_ids:[]};
  const id="mat-"+"a".repeat(32);let opened!:()=>void;const reading=new Promise<void>(done=>opened=done);let calls=0;
  const server=createServer((req,res)=>{
    if(req.url!.includes("/metadata?")){res.setHeader("Content-Type","application/json");res.end(JSON.stringify({id,sha256:"c".repeat(64),purpose_revision:0}));return;}
    res.writeHead(200,{"Content-Type":"image/jpeg"});res.flushHeaders();opened();
  });
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));const address=server.address();assert.ok(address && typeof address!=="string");
  const store=new WebSessionStore({apiBaseUrl:`http://127.0.0.1:${address.port}`,fetchOverview:async()=>state,
    createAgent:async()=>({supportsImages:()=>true,prompt:async()=>{calls++;},abort:async()=>undefined,dispose:()=>undefined})});
  try {const created=await store.create();const pending=store.sendMessage(created.sessionId,"看图",()=>undefined,undefined,undefined,undefined,undefined,undefined,[id]);
    await reading;await store.stop(created.sessionId);await pending;assert.equal(calls,0);
  } finally {store.dispose();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
});

test("confirmed deletion cancels an in-flight direct-image read before any teacher call",async()=>{
  const state={current_goal:"图片目标",goal_profile:{id:"goal-a"},curriculum_spine:[],current_frontier:null,current_focus:null,
    skills:[],recent_evidence:[],active_task:null,learning_history:[],current_goal_skill_ids:[]};
  const id="mat-"+"d".repeat(32);let opened!:()=>void,calls=0;
  const reading=new Promise<void>(done=>opened=done);
  const server=createServer((req,res)=>{
    if(req.url!.includes("/metadata?")){res.setHeader("Content-Type","application/json");res.end(JSON.stringify({id,sha256:"d".repeat(64),purpose_revision:0}));return;}
    res.writeHead(200,{"Content-Type":"image/jpeg"});res.flushHeaders();opened();
  });
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
  const address=server.address();assert.ok(address&&typeof address!=="string");
  const store=new WebSessionStore({apiBaseUrl:`http://127.0.0.1:${address.port}`,fetchOverview:async()=>state,
    createAgent:async()=>({supportsImages:()=>true,prompt:async()=>{calls++;},abort:async()=>undefined,dispose:()=>undefined})});
  try {
    const created=await store.create();
    const pending=store.sendMessage(created.sessionId,"看图",()=>undefined,undefined,undefined,undefined,undefined,undefined,[id]);
    await reading;
    assert.equal(store.materialDeleted(id),true);
    await pending;
    assert.equal(calls,0);
  } finally {store.dispose();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
});

test("deleting a direct image after provider dispatch cannot complete the stale teacher turn",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"lawa-direct-image-delete-"));
  const id="mat-"+"e".repeat(32),hash="e".repeat(64);
  const overview={current_goal:"识图",goal_profile:{id:"goal"},curriculum_spine:[],current_frontier:null,current_focus:null,
    skills:[],recent_evidence:[],active_task:null,learning_history:[],current_goal_skill_ids:[]};
  let deleted=false;
  const server=createServer((req,res)=>{
    if(req.url!.includes(`/materials/${id}/metadata`)){
      res.setHeader("Content-Type","application/json");
      res.statusCode=deleted?404:200;res.end(JSON.stringify(deleted?{detail:"deleted"}:{id,sha256:hash,purpose_revision:0}));return;
    }
    if(req.url!.includes(`/materials/${id}/visual/image-1`)){
      res.setHeader("Content-Type","image/jpeg");res.end(Buffer.from([255,216,255,217]));return;
    }
    res.setHeader("Content-Type","application/json");res.end(JSON.stringify(overview));
  });
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
  const address=server.address();assert.ok(address&&typeof address!=="string");
  const manager=SessionManager.create(directory,directory);
  const faux=createFauxCore({tokensPerSecond:0});
  const inputs:unknown[]=[];let agent:Awaited<ReturnType<typeof createLearningAgentSession>>|undefined;
  faux.setResponses([context=>{
    inputs.push(JSON.parse(JSON.stringify(context)));
    deleted=true;
    assert.equal(agent?.materialDeleted?.(id),true);
    void agent?.abort();
    return fauxAssistantMessage("STALE_IMAGE_ANSWER");
  }]);
  const runtime=await ModelRuntime.create({authPath:join(directory,"auth.json"),modelsPath:null,
    modelsStorePath:join(directory,"models.json"),allowModelNetwork:false,refreshOnCreate:false});
  runtime.streamSimple=faux.streamSimple;runtime.hasConfiguredAuth=()=>true;
  runtime.getAuth=async()=>({auth:{apiKey:"isolated-only"},env:{}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  try {
    const baseUrl=`http://127.0.0.1:${address.port}`;
    const batch=await loadTeachingImageBatch([id],"goal",baseUrl);
    agent=await createLearningAgentSession(new TeachingSessionContext(),new GoalOnboardingContext(),{
      apiBaseUrl:baseUrl,model:{...faux.getModel(),input:["text","image"]},modelRuntime:runtime,sessionManager:manager,
      surface:"WEB",retrieval:false,assistantSupport:false,log:()=>undefined});
    const result=await agent.prompt("解释这张图",batch.images,batch.sources);
    assert.notEqual(result?.status,"completed");
    assert.equal(inputs.length,1);
    assert.ok(JSON.stringify(inputs[0]).includes(batch.images[0]!.data),"the provider did receive the original before deletion");
    assert.ok(!JSON.stringify(manager.getBranch()).includes("STALE_IMAGE_ANSWER"),"late stale reply is not published as a completed turn");
  } finally {
    agent?.dispose();await new Promise<void>(done=>server.close(()=>done()));
    rmSync(directory,{recursive:true,force:true});
  }
});
