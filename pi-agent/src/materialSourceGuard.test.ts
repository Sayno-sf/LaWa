import assert from "node:assert/strict";
import test from "node:test";
import type {Context} from "@earendil-works/pi-ai";
import {MaterialSourceGuard} from "./materialSourceGuard.js";

const validId="mat-"+"a".repeat(32),deletedId="mat-"+"b".repeat(32),changedId="mat-"+"c".repeat(32);
const validHash="1".repeat(64),changedHash="2".repeat(64);

function toolResult(id:string,toolCallId:string,sourceHash=validHash) {
  return {role:"toolResult" as const,toolName:"read_learning_source",toolCallId,isError:false,timestamp:1,
    content:[{type:"text" as const,text:JSON.stringify({material_id:id,source_hash:sourceHash,content:"OLD_SOURCE_CANARY"})}]};
}

test("deleted and changed material tool results are replaced without rewriting history", async()=>{
  const guard=new MaterialSourceGuard({baseUrl:"http://kernel.test",fetcher:async url=>{
    const value=String(url);
    if(value.includes(validId)) return Response.json({id:validId,sha256:validHash,purpose_revision:0});
    if(value.includes(deletedId)) return Response.json({detail:"not found"},{status:404});
    if(value.includes(changedId)) return Response.json({id:changedId,sha256:changedHash,purpose_revision:0});
    return Response.json({detail:"unexpected"},{status:500});
  }});
  const user={role:"user" as const,content:`过去读过 ${deletedId}`,timestamp:0};
  const valid=toolResult(validId,"valid"),deleted=toolResult(deletedId,"deleted"),changed=toolResult(changedId,"changed");
  const original=[user,valid,deleted,changed] as Context["messages"];
  const projected=await guard.projectMessages(original);
  assert.equal(projected.length,4);
  assert.equal(projected[0],user,"user-authored history remains untouched");
  assert.equal(projected[1],valid,"current source result remains intact");
  assert.ok(!JSON.stringify(projected[2]).includes("OLD_SOURCE_CANARY"));
  assert.ok(!JSON.stringify(projected[3]).includes("OLD_SOURCE_CANARY"));
  assert.match(JSON.stringify(projected[2]),/material_source_unavailable/);
  assert.match(JSON.stringify(projected[3]),/material_source_unavailable/);
  assert.ok(JSON.stringify(original[2]).includes("OLD_SOURCE_CANARY"),"projection never rewrites the durable message");
});

test("confirmed deletion invalidates a material immediately and direct source validation fails closed", async()=>{
  let calls=0;
  const guard=new MaterialSourceGuard({baseUrl:"http://kernel.test",scope:()=>"goal-a",fetcher:async()=>{
    calls++;return Response.json({id:validId,sha256:validHash,purpose_revision:0});
  }});
  const source={material_id:validId,scope:"goal-a",source_hash:validHash,purpose_revision:0};
  assert.equal(await guard.validate(source),true);
  guard.markDeleted(validId);
  assert.equal(await guard.validate(source),false);
  assert.equal(calls,1,"an explicit deletion event does not need another Kernel lookup");
  await assert.rejects(guard.current(validId,"goal-a"),/删除/);
});

test("metadata outages hide source tool results for that request without branding them deleted", async()=>{
  let calls=0;
  const guard=new MaterialSourceGuard({baseUrl:"http://kernel.test",fetcher:async()=>{
    calls++;throw new Error("kernel offline");
  }});
  const result=toolResult(validId,"offline");
  const first=await guard.projectMessages([result] as Context["messages"]);
  assert.match(JSON.stringify(first),/material_source_unavailable/);
  assert.equal(guard.isDeleted(validId),false);
  const second=await guard.projectMessages([result] as Context["messages"]);
  assert.match(JSON.stringify(second),/material_source_unavailable/);
  assert.equal(calls,2,"each model request rechecks an unavailable source");
});

test("untrusted tool text cannot create unbounded material lookups",async()=>{
  let calls=0;
  const ids=Array.from({length:40},(_,index)=>"mat-"+index.toString(16).padStart(32,"0"));
  const guard=new MaterialSourceGuard({baseUrl:"http://kernel.test",fetcher:async url=>{
    calls++;
    const id=String(url).match(/mat-[0-9a-f]{32}/)?.[0]!;
    return Response.json({id,sha256:"a".repeat(64),purpose_revision:0});
  }});
  const result={role:"toolResult" as const,toolName:"untrusted_fixture",toolCallId:"bounded",isError:false,timestamp:1,
    content:[{type:"text" as const,text:JSON.stringify({text:ids.map(id=>`material:${id}:page:1`).join(" ") + " " + ids.join(" ")})}]};
  await guard.projectMessages([result] as Context["messages"]);
  assert.equal(calls,16,"only explicit source references are checked and the lookup set is bounded");
});
