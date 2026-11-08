import {LearningSkillPreferences} from "../learningSkillPreferences.js";
import {LearningSkillLibrary} from "../learningSkillLibrary.js";
import {skillEntry,skillZip} from "../testing/skillPackage.js";
import assert from "node:assert/strict";
import test from "node:test";
import {once} from "node:events";
import {mkdirSync,mkdtempSync,readdirSync,rmSync,writeFileSync} from "node:fs";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {basename,dirname,join,resolve} from "node:path";
import {LearningSkillRuntime} from "../learningSkills.js";
import {createBundledLearningSkills} from "../learningSkillBundles.js";
import type {RetrievalRuntime} from "../retrieval/runtime.js";
import {createGateway} from "./gateway.js";
import {WebSessionStore} from "./sessionStore.js";
import {StudyTimeStore} from "./studyTimeStore.js";

async function gatewayFixture(run:(base:string,counts:()=>{kernel:number;model:number;overview:number},directory:string,initialFiles:string[])=>Promise<void>){
  const directory=mkdtempSync(join(tmpdir(),"lawa-skill-catalog-"));
  let kernel=0,model=0,overview=0;
  const api=createServer((_request,response)=>{kernel++;response.writeHead(403);response.end("{}");});
  api.listen(0,"127.0.0.1");await once(api,"listening");const apiAddress=api.address();assert.ok(apiAddress&&typeof apiAddress!=="string");
  const store=new WebSessionStore({conversationDir:join(directory,"sessions"),conversationCwd:directory,apiBaseUrl:`http://127.0.0.1:${apiAddress.port}`,
    fetchOverview:async()=>{overview++;throw new Error("Catalog must not read the classroom.");},
    createAgent:async()=>{model++;throw new Error("Catalog must not create a model session.");},log:()=>undefined});
  const gateway=createGateway({learningSkillPreferences:new LearningSkillPreferences(join(directory,"preferences.json")),store,studyTime:new StudyTimeStore(join(directory,"time.json")),retrieval:{scopeChanged:()=>undefined} as unknown as RetrievalRuntime});
  gateway.listen(0,"127.0.0.1");await once(gateway,"listening");const address=gateway.address();assert.ok(address&&typeof address!=="string");
  const initialFiles=readdirSync(join(directory,"sessions"),{recursive:true}).map(String).sort();
  try{await run(`http://127.0.0.1:${address.port}`,()=>({kernel,model,overview}),directory,initialFiles);}
  finally{
    gateway.closeAllConnections();await new Promise<void>(done=>gateway.close(()=>done()));
    api.closeAllConnections();await new Promise<void>(done=>api.close(()=>done()));
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith("lawa-skill-catalog-"));rmSync(directory,{recursive:true,force:true});
  }
}

test("teaching arrangements GET returns only the current installed metadata without a classroom or model request",async()=>gatewayFixture(async(base,counts,directory,initialFiles)=>{
  const response=await fetch(`${base}/api/web/learning-skills`);assert.equal(response.status,200);
  const catalog=await response.json();assert.equal(catalog.skills.length,1);
  assert.deepEqual(catalog.skills.map((skill:{name:string})=>skill.name).sort(),["lawa-illustrated-lesson"]);
  assert.equal(catalog.truncated,false);
  for(const skill of catalog.skills){
    assert.deepEqual(Object.keys(skill).sort(),["description","displayName","enabled","explicitOnly","name","origin"]);
    assert.equal(typeof skill.description,"string");assert.equal(skill.explicitOnly,false);
  }
  assert.doesNotMatch(JSON.stringify(catalog),/host_instructions|SKILL\.md|script-spec\.md|sha256|filePath|directory|## 舞台元素|D:\\|C:\\/);
  assert.deepEqual(counts(),{kernel:0,model:0,overview:0});
  assert.deepEqual(readdirSync(join(directory,"sessions"),{recursive:true}).map(String).sort(),initialFiles,"viewing installed plugins must not create a Pi conversation");
}));

test("installed catalog rejects a different browser origin without touching learning state",async()=>gatewayFixture(async(base,counts)=>{
  const original=await (await fetch(`${base}/api/web/learning-skills`)).json();
  for(const method of ["POST","DELETE"]){
    const response=await fetch(`${base}/api/web/learning-skills`,{method,headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"lawa-illustrated-lesson",enabled:false})});
    assert.equal(response.status,404);
  }
  const foreign=await fetch(`${base}/api/web/learning-skills`,{headers:{origin:"https://other.invalid"}});assert.equal(foreign.status,403);
  const same=await fetch(`${base}/api/web/learning-skills`,{headers:{origin:base}});assert.equal(same.status,200);assert.deepEqual(await same.json(),original);
  const denied=await fetch(`${base}/api/web/learning-skills`,{method:"PUT",headers:{origin:"https://other.invalid","Content-Type":"application/json"},body:JSON.stringify({name:"lawa-illustrated-lesson",enabled:false})});assert.equal(denied.status,403);
  const saved=await fetch(`${base}/api/web/learning-skills`,{method:"PUT",headers:{origin:base,"Content-Type":"application/json"},body:JSON.stringify({name:"lawa-illustrated-lesson",enabled:false})});assert.equal(saved.status,200);
  assert.equal((await (await fetch(`${base}/api/web/learning-skills`)).json()).skills[0].enabled,false);
  assert.deepEqual(counts(),{kernel:0,model:0,overview:0});
}));

test("catalog summaries discover added instruction plugins dynamically and never count as model-visible skill content",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"lawa-skill-catalog-")),root=join(directory,"skills"),name="custom-method";
  mkdirSync(join(root,name),{recursive:true});
  const write=(description:string)=>writeFileSync(join(root,name,"SKILL.md"),`---\nname: ${name}\ndescription: ${description}\ndisable-model-invocation: true\n---\nPRIVATE_ENTRY_SENTINEL\n`);
  try{
    write("当前安装的方法");
    const runtime=new LearningSkillRuntime({roots:[root],surface:"WEB",role:"TEACHER",adapters:{[name]:{hostInstructions:"PRIVATE_HOST_SENTINEL",requiredResourcesByTool:{present_custom:["SKILL.md"]}}}});
    assert.deepEqual(runtime.catalogSummary(),{skills:[{name,description:"当前安装的方法",explicitOnly:true}],truncated:false});
    assert.ok(runtime.guardTool("present_custom"),"displaying metadata is not model-loaded proof");
    write("更新后的方法");assert.equal(runtime.catalogSummary().skills[0]!.description,"更新后的方法");
    mkdirSync(join(root,"second-method"));writeFileSync(join(root,"second-method","SKILL.md"),"---\nname: second-method\ndescription: 另一个方法\n---\nSECOND_PRIVATE_BODY");
    assert.equal(runtime.catalogSummary().skills.length,2);assert.doesNotMatch(JSON.stringify(runtime.catalogSummary()),/PRIVATE|directory|host_instructions/);
    assert.ok(runtime.guardTool("present_custom"));
  }finally{assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith("lawa-skill-catalog-"));rmSync(directory,{recursive:true,force:true});}
});

test("same-origin user installs, replaces and removes a ZIP through the actual gateway without learning writes",async()=>gatewayFixture(async(base,counts,directory)=>{
  const bytes=skillZip([{name:"export/SKILL.md",body:skillEntry()},{name:"export/references/check.md",body:"check once"}]);
  const upload=(data:Buffer,revision?:string)=>fetch(base+"/api/web/learning-skills/install",{method:"POST",headers:{origin:base,"Content-Type":"application/octet-stream","X-Skill-Filename":"method.zip",...(revision?{"X-Skill-Revision":revision}:{})},body:new Uint8Array(data)});
  const forbidden=await fetch(base+"/api/web/learning-skills/install",{method:"POST",headers:{origin:"https://other.invalid","Content-Type":"application/octet-stream","X-Skill-Filename":"method.zip"},body:new Uint8Array(bytes)});assert.equal(forbidden.status,403);
  const installed=await upload(bytes);assert.equal(installed.status,200);const value=await installed.json();assert.equal(value.skills.length,2);assert.equal(value.skills.find((s:any)=>s.name==="comparison-guide").displayName,"对照讲解");
  const library=new LearningSkillLibrary(join(directory,"learning-skill-library")),prefs=new LearningSkillPreferences(join(directory,"preferences.json"));
  const runtime=createBundledLearningSkills("WEB","TEACHER",library,prefs);assert.match(runtime.metadataPrompt(),/comparison-guide/);
  const repeated=await upload(bytes);assert.equal((await repeated.json()).installed.changed,false);
  const revised=skillZip([{name:"SKILL.md",body:skillEntry("comparison-guide","REVISED_METHOD")}]);
  const conflict=await upload(revised);assert.equal(conflict.status,409);const pending=await conflict.json();
  assert.equal((await upload(revised,pending.conflict.revision)).status,200);
  const off=await fetch(base+"/api/web/learning-skills",{method:"PUT",headers:{origin:base,"Content-Type":"application/json"},body:JSON.stringify({name:"comparison-guide",enabled:false})});assert.equal(off.status,200);assert.doesNotMatch(runtime.metadataPrompt(),/comparison-guide/);
  assert.equal((await fetch(base+"/api/web/learning-skills/comparison-guide",{method:"DELETE",headers:{origin:base}})).status,200);
  const catalogue=await (await fetch(base+"/api/web/learning-skills")).json();assert.equal(catalogue.skills.length,1);
  assert.equal((await fetch(base+"/api/web/learning-skills/lawa-illustrated-lesson",{method:"DELETE",headers:{origin:base}})).status,200);
  assert.equal(runtime.toolEnabled("prepare_lesson_figures"),false);
  const restored=await fetch(base+"/api/web/learning-skills/restore",{method:"POST",headers:{origin:base,"Content-Type":"application/json"},body:JSON.stringify({name:"lawa-illustrated-lesson"})});assert.equal(restored.status,200);assert.equal(runtime.toolEnabled("prepare_lesson_figures"),true);
  assert.deepEqual(counts(),{kernel:0,model:0,overview:0});
}));
