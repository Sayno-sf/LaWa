/** 用最终教师流程检查讲解深度；真实模型仅接触合成课堂，字数只记录、不作为教学合格标准。 */
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync} from "node:fs";
import {resolve,join} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright-core";
import {fauxAssistantMessage} from "@earendil-works/pi-ai";
import {createLearningAgentSession} from "../src/agentSession.js";
import {ProviderSettingsService} from "../src/web/providerSettings.js";
import {ConversationCatalog} from "../src/web/conversationCatalog.js";
import {teachingInstructionsPrompt} from "../src/teachingInstructions.js";
import {teachingPreferenceSnapshot} from "../src/teachingPreferences.js";
import {startGrowthPreview} from "./growthPreview.js";

assert.ok(process.argv.includes("--live"),"真实模型验收须显式传 --live");
const mode=process.argv.find(arg=>arg.startsWith("--case="))?.slice(7)??"intro-js";
assert.ok(["intro-js","intro-cause","brief","closing"].includes(mode));
const root=fileURLToPath(new URL("../../",import.meta.url)),out=join(root,"data/qa/teaching-depth");
mkdirSync(out,{recursive:true});mkdirSync(join(root,"data/qa/growth-atlas"),{recursive:true});
const settings=resolve(process.env.QUESTION_SETTINGS_DIR??join(root,"data"));
const protectedFiles=["provider-settings.json","provider-secrets.json","teaching-instructions.json"].map(name=>join(settings,name));
const hashes=()=>protectedFiles.map(path=>createHash("sha256").update(readFileSync(path)).digest("hex"));
const before=hashes();
const instructions=teachingInstructionsPrompt(JSON.parse(readFileSync(protectedFiles[2]!,"utf8")).text);
const binding=await new ProviderSettingsService({settingsPath:protectedFiles[0],secretsPath:protectedFiles[1]}).getActiveRuntime();
const cause=mode==="intro-cause",title=cause?"因果解释与先后关系":"加法与字符串拼接";
const directory=mkdtempSync(join(root,"data/qa/growth-atlas/preview-depth-"));
const seed=spawnSync(join(root,".venv/Scripts/python.exe"),["-X","utf8","-c",`
import sys
from pathlib import Path
from app.application import LearningService
from app.domain import GoalProfile, LearningTask, SkillGraph, SkillNode, SkillState, TaskStatus
from app.persistence import JsonLearningStateStore
title=sys.argv[2]
service=LearningService(SkillGraph([SkillNode("a",title,status=SkillState.LEARNING)]),
    current_goal=title,goal_profile=GoalProfile("goal",title,"初学","解释过程与适用条件"),
    current_goal_skill_ids=("a",),tasks=(LearningTask("ta",title,"解释过程与适用条件",("a",),(),status=TaskStatus.ACTIVE,goal_id="goal"),))
JsonLearningStateStore(Path(sys.argv[1])).save(service)
`,join(directory,"state.json"),title],{cwd:root,encoding:"utf8",windowsHide:true});
assert.equal(seed.status,0,seed.stderr);
const events:Array<{type:string;at:number;chars?:number}>=[];
const preview=await startGrowthPreview(0,true,directory,async(context,planning,onEvent,manager,branchProposed)=>
  createLearningAgentSession(context,planning,{apiBaseUrl:preview.apiBase,model:binding.model,modelRuntime:binding.runtime,
    thinkingLevel:binding.thinkingLevel,sessionManager:manager,surface:"WEB",retrieval:false,assistantSupport:false,
    teachingInstructions:()=>instructions,branchProposed,log:()=>{},onEvent:event=>{
      events.push({type:event.type,at:Date.now(),...(event.type==="assistant_delta"?{chars:event.delta.length}:{})});onEvent(event);
    }}));
const browser=await chromium.launch({executablePath:process.env.RESPONSIVE_BROWSER_PATH??"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",headless:true});
try {
  const prefs=teachingPreferenceSnapshot(await(await fetch(preview.apiBase+"/api/learning/teaching")).json(),instructions);
  const response=await fetch(preview.apiBase+"/api/learning/tasks/ta/teaching-activity",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
    expected_goal_id:"goal",expected_revision:0,teaching_activity:{method:"REASON",purpose:"理解并说明机制",learner_action:"解释关键过程与适用条件",
      observable_output:"过程说明",evaluation_focus:["过程与条件"],observation_limits:"单次说明不代表长期掌握",teaching_preferences_revision:prefs.revision}})});
  assert.ok(response.ok,await response.text());
  const catalog=new ConversationCatalog(join(directory,"sessions"),root),manager=catalog.create();catalog.recordGoal(manager,"goal",title,true);
  if(mode==="closing")manager.appendMessage(fauxAssistantMessage("本节已经讲过数字相加、字符串拼接和从左到右计算。请解释 4 + 1 + '2' 与 '4' + 1 + 2 的结果和原因。"));
  const prompt=mode==="closing"?"前者是字符串52，先算4+1得到数字5，再与字符串2拼接。后者是字符串412，先把字符串4与数字1拼成41，再拼数字2。我这一节想先收尾，请反馈这次作答，然后让我选择是否确认掌握。":
    mode==="brief"?"这一轮只用两三句话说明：为什么 2 + '3' 得到字符串23，而不是数字5？不需要出题。":
    cause?"开始学习当前知识点。我以前只知道先发生、后发生的时间顺序，还不明白为什么这不能证明因果。":
    "开始学习当前知识点。我已知道数字与字符串的区别，也会计算数字相加，但不理解加号的类型转换和组合表达式为什么会改变结果。";
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:"reduce"}),errors:string[]=[];
  page.on("pageerror",error=>errors.push(error.message));
  await page.goto(preview.base+"/#learn");await page.locator("#learning-intro").waitFor({state:"detached"});
  await page.locator("#message-input:enabled").fill(prompt);const started=Date.now();await page.locator("#send-button").click();
  let snapshot;
  const deadline=Date.now()+180000;
  while(Date.now()<deadline){snapshot=await(await fetch(preview.base+"/api/web/classroom/snapshot")).json();
    if(snapshot.run?.id&&snapshot.run?.status!=="running")break;await new Promise(done=>setTimeout(done,250));}
  writeFileSync(join(out,mode+"-snapshot.json"),JSON.stringify(snapshot,null,2));
  const text=snapshot.session.messages.filter((m:{role:string;content:string})=>m.role==="assistant"&&m.content.trim()).at(-1)?.content??"";
  writeFileSync(join(out,mode+".md"),text);
  const deltas=events.filter(e=>e.type==="assistant_delta"),state=snapshot.session.state;
  const report={mode,model:binding.model.id,thinking:binding.thinkingLevel,status:snapshot.run.status,chars:text.length,streamChunks:deltas.length,
    firstDeltaMs:deltas[0]?deltas[0].at-started:null,totalMs:Date.now()-started,pending:state.teaching.learner_questions?.pending?.purpose??null,
    task:state.overview.active_task?.id,skill:state.overview.skills[0]?.status,browserErrors:errors,syntheticData:directory,events};
  writeFileSync(join(out,mode+"-report.json"),JSON.stringify(report,null,2));
  await page.screenshot({path:join(out,mode+".png"),fullPage:true});
  assert.equal(snapshot.run.status,"completed");assert.ok(deltas.length>1);assert.deepEqual(errors,[]);
  assert.equal(report.task,"ta");assert.notEqual(report.skill,"MASTERED_BY_USER");
  if(mode==="closing"){assert.equal(report.pending,"CONFIRM_MASTERY");assert.ok(snapshot.session.messages.some((m:{assessment?:unknown})=>m.assessment));}
  if(mode==="brief")assert.equal(report.pending,null);
  console.log(JSON.stringify({...report,events:undefined}));
}finally{await browser.close();await preview.stop();assert.deepEqual(hashes(),before,"验收不得改写原配置");}
