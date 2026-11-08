import assert from "node:assert/strict";
import test from "node:test";
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename,dirname,join,resolve} from "node:path";
import {LearningSkillLibrary,prepareSkill,SkillLibraryError} from "./learningSkillLibrary.js";
import {LearningSkillPreferences} from "./learningSkillPreferences.js";
import {createBundledLearningSkills} from "./learningSkillBundles.js";
import {skillZip,skillEntry} from "./testing/skillPackage.js";

async function fixture(run:(library:LearningSkillLibrary,preferences:LearningSkillPreferences,directory:string)=>Promise<void>){
  const directory=mkdtempSync(join(tmpdir(),"lawa-skill-library-"));
  try{await run(new LearningSkillLibrary(join(directory,"library")),new LearningSkillPreferences(join(directory,"preferences.json")),directory);}
  finally{assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith("lawa-skill-library-"));rmSync(directory,{recursive:true,force:true});}
}
const invoke=async(runtime:ReturnType<typeof createBundledLearningSkills>,name:string,args:Record<string,unknown>)=>runtime.tools().find(t=>t.name===name)!.execute("call",args,undefined,undefined,{} as never);
const resultMessage=(output:Awaited<ReturnType<typeof invoke>>)=>({role:"toolResult",isError:false,toolName:"load_learning_skill",toolCallId:"call",content:output.content});

test("ordinary SKILL.md installs into a live runtime and disable/remove revoke its old model input without changing history",async()=>fixture(async(library,prefs,dir)=>{
  const runtime=createBundledLearningSkills("WEB","TEACHER",library,prefs);
  assert.doesNotMatch(runtime.metadataPrompt(),/comparison-guide/);
  const prepared=await prepareSkill("SKILL.md",Buffer.from(skillEntry()));library.install(prepared);
  assert.match(runtime.metadataPrompt(),/comparison-guide/);assert.doesNotMatch(runtime.metadataPrompt(),/METHOD_BODY_A/);
  assert.equal(library.describe(prepared.name).displayName,"对照讲解");
  const output=await invoke(runtime,"load_learning_skill",{name:prepared.name}),history=[resultMessage(output)];
  assert.match(JSON.stringify(runtime.projectMessages(history)),/METHOD_BODY_A/);
  prefs.set(prepared.name,false);assert.doesNotMatch(runtime.metadataPrompt(),/comparison-guide/);assert.doesNotMatch(JSON.stringify(runtime.projectMessages(history)),/METHOD_BODY_A/);
  await assert.rejects(invoke(runtime,"load_learning_skill",{name:prepared.name}),/关闭/);
  prefs.set(prepared.name,true);assert.match(runtime.metadataPrompt(),/comparison-guide/);
  const restored=new LearningSkillLibrary(library.directory);assert.equal(restored.describe(prepared.name).origin,"imported");
  library.remove(prepared.name);assert.doesNotMatch(runtime.metadataPrompt(),/comparison-guide/);assert.doesNotMatch(JSON.stringify(runtime.projectMessages(history)),/METHOD_BODY_A/);
  assert.match(JSON.stringify(history),/METHOD_BODY_A/);assert.deepEqual(readdirSync(join(library.directory,"packages")),[]);
  const other=new LearningSkillLibrary(join(dir,"other"));assert.equal(other.additionalRoots().length,0);
}));

test("wrapped ZIP keeps nested references and templates readable while scripts remain inert",async()=>fixture(async(library,prefs)=>{
  const prepared=await prepareSkill("method.zip",skillZip([
    {name:"export/comparison-guide/SKILL.md",body:skillEntry()},
    {name:"export/comparison-guide/references/advanced/compare.md",body:"REFERENCE_BODY"},
    {name:"export/comparison-guide/assets/template.html",body:"<article>TEMPLATE_BODY</article>"},
    {name:"export/comparison-guide/scripts/demo.py",body:"raise Exception('DO_NOT_EXECUTE')"},
    {name:"export/comparison-guide/assets/photo.png",body:Buffer.from([137,80,78,71])},
    {name:"__MACOSX/._SKILL.md",body:"ignored"},
  ]));
  assert.equal(prepared.hasScripts,true);library.install(prepared);
  const runtime=createBundledLearningSkills("WEB","TEACHER",library,prefs),entry=await invoke(runtime,"load_learning_skill",{name:prepared.name});
  assert.match(JSON.stringify(entry),/references\/advanced\/compare.md/);assert.doesNotMatch(JSON.stringify(entry),/photo.png/);
  const script=await invoke(runtime,"read_learning_skill_resource",{name:prepared.name,path:"scripts/demo.py"});assert.match(JSON.stringify(script),/DO_NOT_EXECUTE/);
  assert.deepEqual(runtime.tools().map(t=>t.name),["list_learning_skills","load_learning_skill","read_learning_skill_resource"]);
}));

test("replacement requires the current revision; a failed save retains old files and exact imports are idempotent",async()=>fixture(async(library,prefs)=>{
  const a=await prepareSkill("SKILL.md",Buffer.from(skillEntry())),b=await prepareSkill("SKILL.md",Buffer.from(skillEntry("comparison-guide","METHOD_BODY_B")));
  library.install(a);const revision=library.revision();assert.equal(library.install(a).changed,false);assert.equal(library.revision(),revision);
  assert.throws(()=>library.install(b),(e:unknown)=>e instanceof SkillLibraryError&&e.status===409&&e.conflict?.revision===revision);
  const runtime=createBundledLearningSkills("WEB","TEACHER",library,prefs),history=[resultMessage(await invoke(runtime,"load_learning_skill",{name:a.name}))];
  const before=readFileSync(library.indexPath),packages=readdirSync(join(library.directory,"packages"));
  const original=(library as any).save;(library as any).save=()=>{throw new Error("simulated disk failure");};
  try{assert.throws(()=>library.install(b,revision),/disk failure/);}finally{(library as any).save=original;}
  assert.deepEqual(readFileSync(library.indexPath),before);assert.deepEqual(readdirSync(join(library.directory,"packages")),packages);
  library.install(b,revision);assert.doesNotMatch(JSON.stringify(runtime.projectMessages(history)),/METHOD_BODY_A/);assert.match(JSON.stringify(await invoke(runtime,"load_learning_skill",{name:a.name})),/METHOD_BODY_B/);
  assert.throws(()=>library.remove(a.name,revision),/变化/);assert.equal(library.describe(a.name).origin,"imported");
}));

test("bundled plugins can be removed and restored as a group without deleting their renderer or history",async()=>fixture(async(library,prefs)=>{
  const runtime=createBundledLearningSkills("WEB","TEACHER",library,prefs),source=join(library.bundledRoot,"lawa-illustrated-lesson","SKILL.md"),before=readFileSync(source);
  assert.equal(runtime.toolEnabled("prepare_lesson_figures"),true);library.remove("lawa-illustrated-lesson");
  assert.equal(runtime.toolEnabled("prepare_lesson_figures"),false);assert.ok(library.available().some(s=>s.name==="lawa-illustrated-lesson"));
  assert.deepEqual(readFileSync(source),before);library.restore("lawa-illustrated-lesson");assert.equal(runtime.toolEnabled("prepare_lesson_figures"),true);
  assert.doesNotMatch(runtime.metadataPrompt(),/explainer-animation|lawa-teaching-animation/);
}));

test("bad packages cannot escape the library, allocate declared bombs, collide on Windows, or replace installed content",async()=>fixture(async(library)=>{
  const valid={name:"SKILL.md",body:skillEntry()};
  for(const name of ["../outside.txt","C:/outside.txt","folder/../x.md","folder\\x.md","CON.md","x:stream","x. /a"]){
    await assert.rejects(prepareSkill("bad.zip",skillZip([valid,{name,body:"bad"}])),SkillLibraryError);
  }
  await assert.rejects(prepareSkill("bad.zip",skillZip([valid,{name:"ref",body:"../../outside",mode:0o120777}])),/链接/);
  await assert.rejects(prepareSkill("bad.zip",skillZip([valid,{name:"references/A.md",body:"a"},{name:"references/a.md",body:"b"}])),/重名/);
  await assert.rejects(prepareSkill("bad.zip",skillZip([{name:"a/SKILL.md",body:skillEntry()},{name:"b/SKILL.md",body:skillEntry("another-guide")}])),/一个主/);
  await assert.rejects(prepareSkill("bad.zip",skillZip([valid,{name:"huge",body:"x",declaredSize:200_000_000}])),SkillLibraryError);
  const corrupt=skillZip([valid]),offset=30+Buffer.byteLength(valid.name)+5;corrupt[offset]=corrupt[offset]!^1;await assert.rejects(prepareSkill("bad.zip",corrupt),/校验/);
  await assert.rejects(prepareSkill("SKILL.md",Buffer.from("---\nname: bad\n---\nNo description")),/description/);
  await assert.rejects(prepareSkill("SKILL.md",Buffer.from([0xff,0xfe,0xff])),/UTF-8/);
  assert.equal(existsSync(library.indexPath),false);
}));

test("a corrupt installed index fails closed and is never replaced by an empty registry",async()=>fixture(async(library)=>{
  library.install(await prepareSkill("SKILL.md",Buffer.from(skillEntry())));writeFileSync(library.indexPath,"corrupt");
  assert.throws(()=>library.remove("comparison-guide"),/安装记录/);assert.equal(readFileSync(library.indexPath,"utf8"),"corrupt");
}));

test("valid names that match Object properties are ordinary isolated package identities",async()=>fixture(async(library,prefs)=>{
  const item=await prepareSkill("SKILL.md",Buffer.from(skillEntry("constructor")));library.install(item);
  assert.equal(library.describe("constructor").displayName,"对照讲解");
  assert.match(createBundledLearningSkills("WEB","TEACHER",library,prefs).metadataPrompt(),/constructor/);
  library.remove("constructor");assert.equal(library.additionalRoots().length,0);
}));
