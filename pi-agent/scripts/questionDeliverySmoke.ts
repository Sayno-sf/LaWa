/** 真 Pi/Kernel/浏览器；只有 --live 会用当前配置模型，所有学习写入均在合成目录。 */
import assert from "node:assert/strict";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve,join} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright-core";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import {createFauxCore,fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai";
import {createLearningAgentSession} from "../src/agentSession.js";
import {ProviderSettingsService} from "../src/web/providerSettings.js";
import {ConversationCatalog} from "../src/web/conversationCatalog.js";
import {teachingPreferenceSnapshot} from "../src/teachingPreferences.js";
import {saveFeedbackRecovery} from "../src/web/feedbackRecovery.js";
import {startGrowthPreview} from "./growthPreview.js";

const root=fileURLToPath(new URL("../../",import.meta.url)),live=process.argv.includes("--live");
const retryHistory=process.argv.includes("--retry-history");
const newQuestion=process.argv.includes("--new-question");
const explainOnly=process.argv.includes("--explain-only");
if(retryHistory) assert.ok(live,"历史失败验证使用显式 --live");
const output=resolve(root,"data/qa/teacher-stream-redo");mkdirSync(output,{recursive:true});
const settingsDir=resolve(process.env.QUESTION_SETTINGS_DIR??join(root,"data"));
const binding=live?await new ProviderSettingsService({settingsPath:join(settingsDir,"provider-settings.json"),secretsPath:join(settingsDir,"provider-secrets.json")}).getActiveRuntime():null;
if(live) assert.ok(binding,"需要已配置的课堂模型");
const faux=createFauxCore({api:"openai-completions",provider:"aliyun-bailian",models:[{id:"qwen3.8-flash",contextWindow:1_000_000,maxTokens:32768}],tokensPerSecond:40,tokenSize:{min:2,max:2}});
let runtime:ModelRuntime;
const requests:unknown[]=[];
const events:Array<{type:string;at:number;chars?:number}>=[];
const preview=await startGrowthPreview(0,true,undefined,async(context,planning,onEvent,manager,branchProposed)=>
  createLearningAgentSession(context,planning,{apiBaseUrl:preview.apiBase,model:binding?.model??faux.getModel(),modelRuntime:binding?.runtime??runtime,
    thinkingLevel:"low",surface:"WEB",retrieval:false,assistantSupport:false,teachingInstructions:()=>"",sessionManager:manager,branchProposed,onEvent:event=>{events.push({type:event.type,at:Date.now(),...(event.type==="assistant_delta"?{chars:event.delta.length}:{})});onEvent(event);},log:()=>{}}));
const browser=await chromium.launch({executablePath:process.env.RESPONSIVE_BROWSER_PATH??"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",headless:true});
const api=async(path:string,body?:unknown)=>{
  const response=await fetch(preview.apiBase+path,body===undefined?undefined:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;
};
scenario: try {
  runtime=await ModelRuntime.create({authPath:join(preview.directory,"auth.json"),modelsPath:null,modelsStorePath:join(preview.directory,"models.json"),allowModelNetwork:false,refreshOnCreate:false});
  runtime.streamSimple=(model,context,options)=>{requests.push(JSON.parse(JSON.stringify(context)));return faux.streamSimple(model,context,options);};
  runtime.hasConfiguredAuth=()=>true;runtime.getAuth=async()=>({auth:{apiKey:"synthetic-only"},env:{}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  const preferences=teachingPreferenceSnapshot(await api("/api/learning/teaching"),"");
  await api("/api/learning/tasks/ta/teaching-activity",{expected_goal_id:"goal",expected_revision:0,teaching_activity:{method:"REASON",purpose:"解释加法转换",
    learner_action:"预测结果并说明原因",observable_output:"输出与原因",evaluation_focus:["输出判断","说明转换条件"],observation_limits:"不代表独立编程能力",teaching_preferences_revision:preferences.revision}});
  const question="2 + 3 与 2 + '3' 分别得到什么？说明它们为什么不同。";
  let presentedQuestion=question;
  const criteria=[{label:"输出判断",earned:5,possible:5,feedback:"两个结果正确"},{label:"说明转换条件",earned:5,possible:5,feedback:"说明了字符串拼接的条件"}];
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("ask_learner_questions",{purpose:"CHECK",active_skill_id:"a",active_task_id:"ta",assessment_criteria:criteria.map(({label,possible})=>({label,possible})),
      questions:[{id:"q",prompt:question,selection:"freeform",options:[]}]},{id:"present"}),{stopReason:"toolUse"}),
    fauxAssistantMessage("加号遇到字符串会进行拼接。请先独立判断，再说明理由。"),
    fauxAssistantMessage(fauxToolCall("record_answer_assessment",{question,topic:"字符串拼接",assistance_level:"INDEPENDENT",criteria,summary:"结果与解释均正确",strengths:["区分两种运算"],gaps:[]},{id:"grade"}),{stopReason:"toolUse"}),
    fauxAssistantMessage(fauxToolCall("begin_teacher_reply",{}),{stopReason:"toolUse"}),
    fauxAssistantMessage("回答正确，你区分了两种运算。"),
  ]);
  const catalog=new ConversationCatalog(join(preview.directory,"sessions"),root), manager=catalog.create();
  catalog.recordGoal(manager,"goal","TypeScript 基础",true);
  if(binding) {manager.appendModelChange(binding.model.provider,binding.model.id);manager.appendThinkingLevelChange("low");}
  const answer="前者是数字5，后者是字符串23。两个数字做加法；后者有字符串，数字转成字符串后拼接。";
  if(live && !newQuestion && !explainOnly) {
    manager.appendMessage(fauxAssistantMessage("这里的加号会根据操作数类型处理。\n\n"+question));
    manager.appendMessage({role:"user",content:"先补一下什么是字符串，等会回来回答。",timestamp:Date.now()});
    manager.appendMessage({role:"toolResult",toolName:"propose_learning_branch",toolCallId:"proposal",isError:false,content:[{type:"text",text:JSON.stringify({branch:{id:"synthetic-detour"}})}],timestamp:Date.now()});
    manager.appendMessage(fauxAssistantMessage("先复习字符串表示文本。"));
    manager.appendCustomEntry("lawa.route-transition",{action:"enter",branchId:"synthetic-detour",path:"goal:synthetic-detour",taskId:"synthetic-task"});
    manager.appendMessage(fauxAssistantMessage("'3' 是字符串，3 是数字。字符串参与加法时做拼接。字符串是什么？"));
    manager.appendMessage({role:"user",content:"字符串表示文本。",timestamp:Date.now()});
    manager.appendMessage(fauxAssistantMessage("对，可以返回主线回答原题。"));
    manager.appendCustomEntry("lawa.route-transition",{action:"return",branchId:"synthetic-detour",path:"goal:main",taskId:"ta"});
    if(retryHistory) {
      const userId=manager.appendMessage({role:"user",content:answer,timestamp:Date.now()});
      for(let i=0;i<3;i++) {
        manager.appendMessage(fauxAssistantMessage(fauxToolCall("record_answer_assessment",{question:"原题的错误转述",topic:"字符串拼接",criteria,summary:"解释正确",strengths:[],gaps:[]},{id:`old-grade-${i}`}),{stopReason:"toolUse"}));
        manager.appendMessage({role:"toolResult",toolName:"record_answer_assessment",toolCallId:`old-grade-${i}`,isError:true,
          content:[{type:"text",text:"评分题面必须逐字对应上一教师回合实际提出的问题，不能自造题面或给普通提问评分。"}],timestamp:Date.now()});
      }
      manager.appendMessage(fauxAssistantMessage("这条回答没有对应的题目卡片，系统不肯存评分。我已经试了三次，不再尝试；这次不计分，也不开题卡。"));
      saveFeedbackRecovery(manager,await api("/api/learning/overview"),userId,"assessment_failed");
    }
  }
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  page.on("response",r=>{if(r.request().method()==="POST") console.log("POST",new URL(r.url()).pathname,r.status());});
  await page.goto(preview.base+"/#learn");
  const skip=page.locator("#learning-intro .intro-skip");await skip.waitFor({timeout:15000});await skip.click();await page.locator("#learning-intro").waitFor({state:"detached"});
  let previousRunId=(await(await fetch(preview.base+"/api/web/classroom/snapshot")).json()).run?.id;
  const started=Date.now();
  if(retryHistory) await page.locator("#retry-feedback-button").click();
  else {
    await page.locator("#message-input:enabled").fill(explainOnly?"这一轮只用100字左右解释JavaScript中加法与字符串拼接的差别，不出题，不创建知识卡片。":live&&!newQuestion?answer:"请先用一句话解释字符串拼接，然后出一道CHECK题，让我比较2 + 3和2 + '3'，我会在题卡作答。");
    await page.locator("#send-button").click();
  }
  if(explainOnly) {
    const deadline=Date.now()+120000;let snapshot;
    while(Date.now()<deadline) {
      snapshot=await(await fetch(preview.base+"/api/web/classroom/snapshot")).json();
      if(snapshot.run?.id!==previousRunId && snapshot.run?.status!=="running")break;
      await new Promise(done=>setTimeout(done,250));
    }
    assert.equal(snapshot.run.status,"completed");
    assert.equal(snapshot.session.state.teaching.learner_questions?.pending,null);
    assert.equal(events.some(e=>e.type==="question_ready"),false);
    const deltas=events.filter(e=>e.type==="assistant_delta");assert.ok(deltas.length>1);
    assert.match(snapshot.session.messages.map((m:{content:string})=>m.content).join("\n"),/字符串/);
    assert.deepEqual(errors,[]);
    const report={passed:true,mode:"live-explanation-only",model:binding?.model.id,streamChunks:deltas.length,
      firstDeltaMs:deltas[0]!.at-started,totalMs:Date.now()-started,browserErrors:errors,syntheticData:preview.directory};
    writeFileSync(join(output,"explain-live-report.json"),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));break scenario;
  }
  if(!live || newQuestion) {
    await page.locator("#learner-questions textarea").waitFor({timeout:live?120000:30000});
    assert.match(await page.locator("#learner-questions").innerText(),/2/);
    assert.ok(events.some(e=>e.type==="question_ready"),"card delivery is explicit");
    const ready=events.findIndex(e=>e.type==="question_ready"),first=events.findIndex(e=>e.type==="assistant_delta");
    assert.ok(first<0 || ready<first,"card committed before public speech");
    await page.screenshot({path:join(output,"desktop-card.png"),fullPage:true,animations:"disabled"});
    const pending=(await(await fetch(preview.base+"/api/web/classroom/snapshot")).json()).session.state.teaching.learner_questions.pending;
    const before=pending.id;presentedQuestion=pending.questions[0].prompt;
    await page.reload();
    await page.locator("#learning-intro").waitFor({state:"detached",timeout:15000});
    await page.locator('#connection-status[data-status="ready"]').waitFor({state:"attached"});
    await page.locator("#message-input:enabled").waitFor();
    await page.locator("#learner-questions textarea:enabled").waitFor({timeout:live?120000:30000});
    const after=(await(await fetch(preview.base+"/api/web/classroom/snapshot")).json()).session.state.teaching.learner_questions.pending.id;
    assert.equal(after,before,"refresh preserves the committed question identity");
    previousRunId=(await(await fetch(preview.base+"/api/web/classroom/snapshot")).json()).run?.id;
    await page.locator("#learner-questions textarea").fill(answer);
    assert.equal(await page.locator("#learner-questions textarea").inputValue(),answer,"refresh must not steal the focused answer input");
    const [submission]=await Promise.all([
      page.waitForResponse(r=>r.url().includes("/messages")&&r.request().method()==="POST",{timeout:30000}),
      page.getByRole("button",{name:"提交回答",exact:true}).click(),
    ]);
    assert.ok(submission.ok(),`submission failed: ${submission.status()} ${await submission.text()}`);
  }
  const deadline=Date.now()+(live?120000:30000);
  let snapshot;
  while(Date.now()<deadline) {
    snapshot=await(await fetch(preview.base+"/api/web/classroom/snapshot")).json();
    if(snapshot.run?.id===previousRunId) {await new Promise(done=>setTimeout(done,250));continue;}
    if(snapshot.run?.status==="completed" && snapshot.session?.messages.some((m:{assessment?:unknown})=>m.assessment)) break;
    if(snapshot.run?.status==="interrupted") {
      writeFileSync(join(output,"failed-smoke-snapshot.json"),JSON.stringify(snapshot,null,2));
      throw new Error(JSON.stringify(snapshot.session.state.feedback_recovery));
    }
    await new Promise(done=>setTimeout(done,250));
  }
  writeFileSync(join(output,retryHistory?"retry-live-snapshot.json":live?"live-snapshot.json":"browser-snapshot.json"),JSON.stringify(snapshot,null,2));
  const cards=snapshot.session.messages.filter((m:{assessment?:unknown})=>m.assessment);
  assert.equal(snapshot.run.status,"completed");
  assert.equal(cards.length,1);assert.ok(cards[0].assessment.score>=8);
  assert.equal(snapshot.session.state.feedback_recovery,null);
  const records=await api("/api/learning/answer-assessments?goal_id=goal");
  const actual=records.assessments.filter((a:{source_session_id:string})=>a.source_session_id===manager.getSessionId());
  assert.equal(actual.length,1);assert.equal(actual[0].question,presentedQuestion);assert.deepEqual(errors,[]);
  await page.locator('#connection-status[data-status="ready"]').waitFor({state:"attached"});
  await page.screenshot({path:join(output,retryHistory?"desktop-retry-deepseek.png":live?"desktop-deepseek.png":"desktop-saved.png"),fullPage:true,animations:"disabled"});
  const report={passed:true,mode:newQuestion?"live-publish-question-refresh-answer":retryHistory?"live-retry-after-repeated-refusal":live?"live-returned-main-question":"faux-publish-card-and-submit",model:binding?.model.id??"synthetic",score:actual[0].score,
    assistance:actual[0].assistance_level,question:actual[0].question,feedbackPending:false,syntheticData:preview.directory,browserErrors:errors,streamChunks:events.filter(e=>e.type==="assistant_delta").length,events};
  assert.ok(report.streamChunks>1,"native stream must deliver multiple chunks");
  writeFileSync(join(output,retryHistory?"retry-live-report.json":live?"live-report.json":"browser-report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} catch(error) {
  console.error(error);
  const page=browser.contexts()[0]?.pages()[0];
  if(page){await page.screenshot({path:join(output,"failed-publication-browser.png"),fullPage:true,animations:"disabled"});console.error((await page.locator("body").innerText()).slice(-2200));}
  throw error;
} finally {await browser.close();await preview.stop();}
