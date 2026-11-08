import assert from "node:assert/strict";
import test from "node:test";
import {mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename,dirname,join,resolve} from "node:path";
import type {ToolDefinition} from "@earendil-works/pi-coding-agent";
import {LearningSkillRuntime,type LearningSkillAdapter} from "./learningSkills.js";

const NAME="process-notes";
const PROTOCOL="references/protocol.md";
const ENTRY_BODY="ENTRY_BODY_SENTINEL: 先观察对象怎样变化。";
type ToolOutput=Awaited<ReturnType<ToolDefinition["execute"]>>;
interface Fixture {
  directory:string;root:string;skill:string;
  write:(path:string,text:string)=>void;
  entry:(body?:string,extra?:string)=>void;
  runtime:(adapter?:LearningSkillAdapter)=>LearningSkillRuntime;
}

async function fixture(run:(f:Fixture)=>Promise<void>):Promise<void> {
  const directory=mkdtempSync(join(tmpdir(),"lawa-learning-skills-")),root=join(directory,"skills"),skill=join(root,NAME);
  mkdirSync(skill,{recursive:true});
  const write=(path:string,text:string)=>{const file=join(skill,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text,"utf8");};
  const entry=(body=ENTRY_BODY,extra="")=>write("SKILL.md",`---\nname: ${NAME}\ndescription: METADATA_SENTINEL 说明可见过程。\n${extra}---\n${body}\n`);
  entry();write(PROTOCOL,"REFERENCE_BODY_SENTINEL: 每一步只表达一个变化。");
  try {await run({directory,root,skill,write,entry,runtime:adapter=>new LearningSkillRuntime({roots:[root],surface:"WEB",role:"TEACHER",adapters:adapter?{[NAME]:adapter}:undefined})});}
  finally {
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("lawa-learning-skills-"));
    rmSync(directory,{recursive:true,force:true});
  }
}
async function execute(runtime:LearningSkillRuntime,name:string,args:Record<string,unknown>={},signal?:AbortSignal):Promise<ToolOutput> {
  const tool=runtime.tools().find(tool=>tool.name===name);assert.ok(tool,name);
  return tool.execute("test-call",args,signal,undefined,{} as never);
}
const load=(runtime:LearningSkillRuntime)=>execute(runtime,"load_learning_skill",{name:NAME});
const read=(runtime:LearningSkillRuntime,path:string)=>execute(runtime,"read_learning_skill_resource",{name:NAME,path});
function message(output:ToolOutput,toolName="load_learning_skill"):Record<string,unknown> {
  return {role:"toolResult",toolName,toolCallId:"test-call",isError:false,content:output.content,details:output.details};
}
function receipt(output:ToolOutput):Record<string,unknown> {
  const part=output.content[0];assert.ok(part?.type==="text");return JSON.parse(part.text) as Record<string,unknown>;
}
function modified(output:ToolOutput,changes:Record<string,unknown>):ToolOutput {
  return {...output,content:[{type:"text",text:JSON.stringify({...receipt(output),...changes})}]};
}

test("catalog is metadata only, direct-child bounded, and never eagerly evaluates resource adapters",async()=>fixture(async f=>{
  let reads=0;
  f.write("examples/sample.json",'{"original":true}');
  f.write("source-v1/nested/SKILL.md","---\nname: nested\ndescription: NESTED_ARCHIVE_SENTINEL\n---\nARCHIVE_BODY");
  const runtime=f.runtime({hostInstructions:"HOST_CONTRACT_SENTINEL",resources:{"examples/sample.json":()=>{reads++;return '{"corrected":true}';}}});
  const prompt=runtime.metadataPrompt(),listing=JSON.stringify((await execute(runtime,"list_learning_skills")).content);
  assert.match(prompt,/METADATA_SENTINEL/);assert.match(listing,/METADATA_SENTINEL/);
  assert.doesNotMatch(prompt+listing,/ENTRY_BODY_SENTINEL|REFERENCE_BODY_SENTINEL|HOST_CONTRACT_SENTINEL|ARCHIVE_BODY|NESTED_ARCHIVE_SENTINEL/);
  assert.ok(!prompt.includes(f.directory));assert.equal(reads,0);
  const loaded=receipt(await load(runtime));assert.match(String(loaded.body),/ENTRY_BODY_SENTINEL/);
  assert.equal(loaded.host_instructions,"HOST_CONTRACT_SENTINEL");assert.ok((loaded.resources as string[]).includes("examples/sample.json"));assert.equal(reads,0);
  const sample=receipt(await read(runtime,"examples/sample.json"));assert.equal(sample.body,'{"corrected":true}');assert.equal(reads,1);
  assert.equal(readFileSync(join(f.skill,"examples/sample.json"),"utf8"),'{"original":true}');
  await assert.rejects(execute(runtime,"load_learning_skill",{name:"nested"}));
}));

test("only current complete successful tool text proves visibility; load execution and copied details do not",async()=>fixture(async f=>{
  const runtime=f.runtime({hostInstructions:"CURRENT_HOST",requiredResourcesByTool:{present_process:["SKILL.md"]}});
  const loaded=await load(runtime),real=message(loaded);
  assert.ok(runtime.guardTool("present_process"));
  const invalid=[
    {...real,role:"user"},
    {...real,isError:true},
    {...real,toolName:"list_learning_skills"},
    {...real,content:[]},
    {...real,content:[{type:"text",text:JSON.stringify(loaded.details)}]},
    message(modified(loaded,{body:"summary of entry"})),
    message(modified(loaded,{sha256:"forged"})),
    message(modified(loaded,{host_instructions:"old host"})),
    {...real,toolName:"read_learning_skill_resource"},
  ];
  for(const candidate of invalid){runtime.observeModelContext([candidate]);assert.ok(runtime.guardTool("present_process"));}
  runtime.observeModelContext([real]);assert.equal(runtime.guardTool("present_process"),undefined);
  runtime.observeModelContext([{role:"user",content:[{type:"text",text:"Compaction: the model already read process-notes"}]}]);
  assert.ok(runtime.guardTool("present_process"));
  assert.equal(runtime.guardTool("unrelated_tool"),undefined);
}));

test("dynamic requirements stay minimal for a preset and require selected references for new content",async()=>fixture(async f=>{
  const runtime=f.runtime({requiredResourcesByTool:{present_process:args=>typeof args?.preset==="string"?["SKILL.md"]:["SKILL.md",PROTOCOL]}});
  const entry=await load(runtime);runtime.observeModelContext([message(entry)]);
  assert.equal(runtime.guardTool("present_process",{preset:"already-validated"}),undefined);
  assert.ok(runtime.guardTool("present_process",{script:{}}));
  const protocol=await read(runtime,PROTOCOL);
  assert.ok(runtime.guardTool("present_process",{script:{}}),"execute does not prove that the next model has read the result");
  runtime.observeModelContext([message(entry),message(protocol,"read_learning_skill_resource")]);
  assert.equal(runtime.guardTool("present_process",{script:{}}),undefined);
  const fork=runtime.fork();assert.ok(fork.guardTool("present_process",{preset:"already-validated"}));
  fork.observeModelContext([message(entry),message(protocol,"read_learning_skill_resource")]);assert.equal(fork.guardTool("present_process",{script:{}}),undefined);
}));

test("source, host-contract, and virtual-resource changes invalidate stale complete receipts",async()=>fixture(async f=>{
  let corrected="current version";
  const adapter:LearningSkillAdapter={hostInstructions:"host v1",resources:{[PROTOCOL]:()=>corrected},requiredResourcesByTool:{present_process:[PROTOCOL]}};
  const runtime=f.runtime(adapter),entry=await load(runtime),protocol=await read(runtime,PROTOCOL);
  runtime.observeModelContext([message(entry),message(protocol,"read_learning_skill_resource")]);assert.equal(runtime.guardTool("present_process"),undefined);
  corrected="revised version";assert.ok(runtime.guardTool("present_process"));
  runtime.observeModelContext([message(entry),message(protocol,"read_learning_skill_resource")]);assert.ok(runtime.guardTool("present_process"));
  const revised=await read(runtime,PROTOCOL);runtime.observeModelContext([message(entry),message(revised,"read_learning_skill_resource")]);assert.equal(runtime.guardTool("present_process"),undefined);
  const newHost=f.runtime({...adapter,hostInstructions:"host v2"});newHost.observeModelContext([message(entry),message(revised,"read_learning_skill_resource")]);assert.ok(newHost.guardTool("present_process"));
  f.entry("ENTRY_CHANGED");assert.ok(runtime.guardTool("present_process"));
  runtime.observeModelContext([message(entry),message(revised,"read_learning_skill_resource")]);assert.ok(runtime.guardTool("present_process"));
}));

test("references are bounded package text; templates/scripts are inert and traversal/archives/hidden files remain blocked",async()=>fixture(async f=>{
  f.entry(`${ENTRY_BODY}\n[额外规则](notes/rules.yaml)\n[禁止脚本](scripts/exfiltrate.md)\n[环境](.env)`);
  f.write("notes/rules.yaml","key: selected");f.write("private.txt","UNLISTED_SECRET");
  f.write("scripts/exfiltrate.md","SCRIPT_SECRET");f.write("source-v1/history.md","ARCHIVE_SECRET");
  f.write("examples/player.html","HTML_SECRET");f.write("references/invalid.json","UNDECLARED_EXTENSION");
  const runtime=f.runtime(),loaded=receipt(await load(runtime));
  assert.ok((loaded.resources as string[]).includes("notes/rules.yaml"));
  assert.doesNotMatch(JSON.stringify(loaded.resources),/\.env|private\.txt|history/);
  assert.equal(receipt(await read(runtime,"notes/rules.yaml")).body,"key: selected");
  assert.equal(receipt(await read(runtime,"scripts/exfiltrate.md")).body,"SCRIPT_SECRET");
  assert.equal(receipt(await read(runtime,"examples/player.html")).body,"HTML_SECRET");
  assert.equal(receipt(await read(runtime,"references/invalid.json")).body,"UNDECLARED_EXTENSION");
  for(const path of ["../SKILL.md","references/../../private.txt","/etc/passwd","C:/outside.md","references/protocol.md:stream","references\\protocol.md","references//protocol.md","source-v1/history.md",".env","private.txt","SKILL.md"]){
    await assert.rejects(read(runtime,path),path);
  }
}));

test("symbolic-link roots, plugin directories and files never expose data outside the approved package",async()=>fixture(async f=>{
  const outside=join(f.directory,"outside");mkdirSync(outside);writeFileSync(join(outside,"outside.md"),"OUTSIDE_SECRET","utf8");
  writeFileSync(join(outside,"SKILL.md"),"---\nname: linked\ndescription: OUTSIDE_CATALOG_SECRET\n---\nsecret","utf8");
  symlinkSync(outside,join(f.root,"linked"),process.platform==="win32"?"junction":"dir");
  symlinkSync(outside,join(f.skill,"references","linked"),process.platform==="win32"?"junction":"dir");
  f.entry(`${ENTRY_BODY}\n[不能跟随](references/linked/outside.md)`);
  const runtime=f.runtime();assert.doesNotMatch(runtime.metadataPrompt(),/OUTSIDE_CATALOG_SECRET/);
  await assert.rejects(execute(runtime,"load_learning_skill",{name:"linked"}));
  await assert.rejects(read(runtime,"references/linked/outside.md"));
  const linkedRoot=join(f.directory,"linked-root");symlinkSync(f.root,linkedRoot,process.platform==="win32"?"junction":"dir");
  const isolated=new LearningSkillRuntime({roots:[linkedRoot],surface:"WEB",role:"TEACHER"});
  assert.doesNotMatch(isolated.metadataPrompt(),/METADATA_SENTINEL/);
  await assert.rejects(load(isolated));
}));

test("file, serialized-receipt and catalog limits are enforced and cancellation does no resource work",async()=>fixture(async f=>{
  const runtime=f.runtime({requiredResourcesByTool:{present_process:["SKILL.md",PROTOCOL]}});
  const entry=await load(runtime);f.write(PROTOCOL,"\n".repeat(32000));
  const escaped=await read(runtime,PROTOCOL);assert.ok(JSON.stringify(escaped.content).length>42000);
  runtime.observeModelContext([message(entry),message(escaped,"read_learning_skill_resource")]);assert.equal(runtime.guardTool("present_process"),undefined);
  f.write(PROTOCOL,"x".repeat(32001));await assert.rejects(read(runtime,PROTOCOL));
  f.write(PROTOCOL,"\u0001".repeat(32000));await assert.rejects(read(runtime,PROTOCOL),/合计过大/);
  let reads=0;const abortable=f.runtime({resources:{"examples/virtual.json":()=>{reads++;return "{}";}}});
  const controller=new AbortController();controller.abort();await assert.rejects(execute(abortable,"read_learning_skill_resource",{name:NAME,path:"examples/virtual.json"},controller.signal));assert.equal(reads,0);
  f.entry("x".repeat(24001));await assert.rejects(load(f.runtime()));f.entry();
  for(let i=0;i<130;i++){
    const name="extra-"+String(i).padStart(2,"0"),directory=join(f.root,name);mkdirSync(directory);
    writeFileSync(join(directory,"SKILL.md"),`---\nname: ${name}\ndescription: Generic extra plugin.\n---\nbody`,"utf8");
  }
  const listing=(await execute(runtime,"list_learning_skills")).content[0];assert.ok(listing?.type==="text");
  const directory=JSON.parse(listing.text) as {skills:unknown[];truncated:boolean};assert.equal(directory.skills.length,128);assert.equal(directory.truncated,true);
}));

test("invalid host bindings fail closed without granting dynamic tool access",async()=>fixture(async f=>{
  assert.throws(()=>f.runtime({resources:{"../escape.md":()=>"secret"}}));
  assert.throws(()=>f.runtime({requiredResourcesByTool:{read_learning_skill_resource:["SKILL.md"]}}));
  assert.throws(()=>new LearningSkillRuntime({roots:[f.root,f.root,f.root,f.root,f.root],surface:"WEB",role:"TEACHER"}));
  const runtime=f.runtime({requiredResourcesByTool:{present_process:()=>["../escape.md"]}});
  runtime.observeModelContext([message(await load(runtime))]);assert.ok(runtime.guardTool("present_process"));
}));
