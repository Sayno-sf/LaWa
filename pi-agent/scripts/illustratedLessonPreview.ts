/** Isolated LaWa desktop preview and repeatable book-page acceptance. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {pngSize} from "../skills/lawa-illustrated-lesson/scripts/bailian.mjs";
import {spawnSync} from "node:child_process";
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import {createFauxCore,fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai";
import {chromium} from "playwright-core";
import {createLearningAgentSession} from "../src/agentSession.js";
import {createFigureBatch,FIGURE_TOOL,type PlacedFigure} from "../src/lessonFigures.js";
import {createAssistantAgent} from "../src/assistantAgent.js";
import type {AssistantAgentFactory,AssistantContext} from "../src/assistantTypes.js";
import {LessonArtwork} from "../src/lessonArtwork.js";
import {BEGIN_REPLY} from "../src/teacherTurn.js";
import {ConversationCatalog} from "../src/web/conversationCatalog.js";
import {ProviderSettingsService,type ProviderSettingsCoordinator} from "../src/web/providerSettings.js";
import {inspectIllustratedPrediction} from "./inspectIllustratedPrediction.js";
import {inspectIllustratedMotion} from "./inspectIllustratedMotion.js";
import {startGrowthPreview} from "./growthPreview.js";

const root=fileURLToPath(new URL("../../",import.meta.url));
const live=process.argv.includes("--live"),serve=process.argv.includes("--serve");
const tutor=live && !serve && process.argv.includes("--tutor");
const mix=live && !serve && !tutor && process.argv.includes("--case=mix");
const book=live && !serve && process.argv.includes("--case=book");
const distance=live && !serve && process.argv.includes("--case=distance");
const pinhole=live && !serve && process.argv.includes("--case=pinhole");
const queue=live && !serve && process.argv.includes("--case=queue");
const continuousCase=live && !serve && process.argv.includes("--case=continuous");
const stackPrediction=live && !serve && process.argv.includes("--case=stack-prediction");
const prediction=stackPrediction || process.argv.includes("--case=prediction");
const continuous=process.argv.includes("--continuous");
if (continuous && (!serve || !prediction)) throw new Error("--continuous 仅用于同稿对照预览");
const music=live && !serve && !mix && !tutor && !book && !distance && !pinhole && !queue && !prediction && !continuousCase;
const mode=serve?"preview":continuousCase?"deepseek-continuous":stackPrediction?"deepseek-stack-prediction":prediction?(live?"deepseek-prediction":"desktop-prediction"):pinhole?"deepseek-pinhole":queue?"deepseek-queue":distance?"deepseek-distance":book?"deepseek-book":tutor?"deepseek-tutor":mix?"deepseek-mix":live?"deepseek":"desktop";
const out=join(root,"data/qa/illustrated-lesson");
mkdirSync(out,{recursive:true});
const sandbox=join(root,"data/qa/growth-atlas");
mkdirSync(sandbox,{recursive:true});
const replay=process.argv.includes("--replay-motion");
const playbackOnly=replay && process.argv.includes("--playback-only");
const resume=serve||replay?process.env.ILLUSTRATED_RESUME_DIR:undefined;
if (replay && (!resume || !(pinhole||queue||prediction))) throw new Error("复验动画请指定原合成目录和 --live --case=pinhole 或 queue");
const directory=resume?resolve(resume):mkdtempSync(join(sandbox,"preview-illustrated-"));
if (resume && (!directory.startsWith(resolve(sandbox,"preview-illustrated-")) || !/^preview-illustrated-[A-Za-z0-9]+$/.test(directory.slice(resolve(sandbox).length+1)) || !existsSync(join(directory,"state.json")))) throw new Error("只能恢复此工作树的图解合成课堂");
process.env.WEB_SESSION_DIR=join(directory,"sessions");
const title=continuousCase?"光线通过一个小孔":stackPrediction?"从栈顶取书":prediction?"跟着两束光走":pinhole?"小孔后面的倒像":queue?"队列里的先来后到":music?"一拍里的两个音":mix?"给糖水加水":"路灯下的影子";
if (!resume) {
const seed=spawnSync(join(root,".venv/Scripts/python.exe"),["-X","utf8","-c",`
import sys
from pathlib import Path
from app.application import LearningService
from app.domain import GoalProfile, LearningTask, SkillGraph, SkillNode, SkillState, TaskStatus
from app.persistence import JsonLearningStateStore
title=sys.argv[2]
service=LearningService(SkillGraph([SkillNode("a",title,status=SkillState.LEARNING)]),
    current_goal=title,goal_profile=GoalProfile("goal",title,"初学","能够解释观察结果"),
    current_goal_skill_ids=("a",),tasks=(LearningTask("ta",title,"解释关键关系",("a",),(),status=TaskStatus.ACTIVE,goal_id="goal"),))
JsonLearningStateStore(Path(sys.argv[1])).save(service)
`,join(directory,"state.json"),title],{cwd:root,encoding:"utf8",windowsHide:true});
assert.equal(seed.status,0,seed.stderr);
}
const skillDir=join(root,"pi-agent/skills/lawa-illustrated-lesson");
const lesson=JSON.parse(readFileSync(join(skillDir,"examples",prediction?"pinhole-prediction.json":serve?"printed-page.json":"lamplight.json"),"utf8"));
const teachers=createFauxCore({api:"openai-completions",provider:"aliyun-bailian",models:[{id:"qwen3.8-flash",contextWindow:1000000,maxTokens:32768}],tokensPerSecond:0});
if (continuous) delete lesson.figures[0].prediction;
const localRuntime=await ModelRuntime.create({authPath:join(directory,"test-auth.json"),modelsPath:null,modelsStorePath:join(directory,"test-models.json"),allowModelNetwork:false,refreshOnCreate:false});
localRuntime.streamSimple=(model,context,options)=>teachers.streamSimple(model,context,options);
localRuntime.hasConfiguredAuth=()=>true;
localRuntime.getAuth=async()=>({auth:{apiKey:"fixture"},env:{}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
const settings=process.env.ILLUSTRATED_SETTINGS_DIR;
if (live && !settings) throw new Error("真实模型需要显式的 ILLUSTRATED_SETTINGS_DIR");
const provider=live?new ProviderSettingsService({settingsPath:join(settings!,"provider-settings.json"),secretsPath:join(settings!,"provider-secrets.json")}):undefined;
const binding=await provider?.getActiveRuntime();
const artwork=new LessonArtwork(join(directory,"sessions/lesson-art"),provider);
const readOnly=async():Promise<never>=>{throw new Error("隔离预览使用只读模型配置。");};
const readonlyProvider:ProviderSettingsCoordinator|undefined=provider?{
  getPublicSettings:()=>provider.getPublicSettings(),getActiveRuntime:()=>provider.getActiveRuntime(),
  activate:readOnly,delete:readOnly,saveAndUse:readOnly,testConnection:readOnly}:undefined;
const toolsSeen:Array<{tool:string;error:boolean}>=[];let deltas=0,ready=0,firstDeltaAt=0;
let actualQuestion:AssistantContext["figureQuestion"];
const stubTutor:AssistantAgentFactory=async options=>{
  actualQuestion=options.context.figureQuestion;
  const predictionFrame=actualQuestion?.motion?.prediction;
  const reply=predictionFrame?.phase==="waiting"?"回看物体与孔口之间的方向，想象把它延长。":predictionFrame?.phase==="feedback"?
    "空心圈是你选的"+predictionFrame.label+"。可以比较它和接下来演出的结果。":"这时桩到灯垂足 6 米，影长 3 米。光线在后半段只再下降 1 米，所以水平距离也是前一段的一半。";
  return {async prompt(){await options.onEvent({type:"assistant_delta",delta:reply});},async abort(){},dispose(){}};
};
const realTutor:AssistantAgentFactory=async options=>{
  actualQuestion=options.context.figureQuestion;
  return createAssistantAgent({...options,context:{...options.context,model:binding!.model,modelRuntime:binding!.runtime,thinkingLevel:binding!.thinkingLevel}});
};
const preview=await startGrowthPreview(serve?Number(process.env.ILLUSTRATED_PORT??8794):0,true,directory,
  (context,planning,onEvent,sessionManager,branchProposed)=>createLearningAgentSession(context,planning,{
    apiBaseUrl:preview.apiBase,lessonArt:artwork,model:tutor?teachers.getModel():binding?.model??teachers.getModel(),modelRuntime:tutor?localRuntime:binding?.runtime??localRuntime,
    thinkingLevel:binding?.thinkingLevel??"off",surface:"WEB",retrieval:false,assistantSupport:false,sessionManager,
    teachingInstructions:()=>"",branchProposed,log:()=>{},onEvent:event=>{
      if (event.type==="assistant_delta") {deltas++;firstDeltaAt ||= Date.now();}
      if (event.type==="figures_ready") ready++;
      if (event.type==="tool_end") toolsSeen.push({tool:event.toolName,error:event.isError});
      onEvent(event);
    }}),{lessonArt:artwork,providerSettings:readonlyProvider,createAssistantAgent:tutor||pinhole||prediction && live?realTutor:live?undefined:stubTutor});
const catalog=new ConversationCatalog(join(directory,"sessions"),root);
const manager=resume?catalog.resumeRecent():catalog.create();if (!resume) catalog.recordGoal(manager,"goal",title,true);
const toggle=(name:string,enabled:boolean)=>fetch(preview.base+"/api/web/learning-skills",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,enabled})});
try {
  if (serve) {
    if (!resume) {
      // 预览的第一课是一页已审过的出版样例。安装本地成图，无需再次调用付费服务。
      const scope={sessionId:manager.getSessionId(),goalId:"goal",taskId:"ta",skillId:"a"};
      const painted=lesson.figures[0];
      let sourceFigures=lesson.figures;
      if (painted.art) {
        const id=painted.art.id;
        const originalBrief=JSON.parse(readFileSync(join(skillDir,"examples/lamplight-brief.json"),"utf8"));
        const png=readFileSync(join(skillDir,"assets/prints",id+".png"));
        assert.equal(createHash("sha256").update(png).digest("hex"),id);
        const [width,height]=pngSize(png);
        const assets=join(directory,"sessions/lesson-art");
        mkdirSync(assets,{recursive:true});
        writeFileSync(join(assets,id+".png"),png,{flag:"wx"});
        writeFileSync(join(assets,id+".json"),JSON.stringify({id,...scope,status:"ready",width,height,figure:painted,
          requestedAt:new Date().toISOString(),origin:"packaged-example"}),{flag:"wx"});
        sourceFigures=[{key:painted.key,alt:painted.alt,caption:painted.caption,paint:originalBrief.paint},...lesson.figures.slice(1)];
      }
      manager.appendMessage({role:"user",content:prediction?"带我看两束光是怎样经过小孔的。":"为什么把木桩放远一些，地上的影子也会变长？",timestamp:Date.now()});
      const batch=createFigureBatch(lesson.figures,scope);
      manager.appendMessage(fauxAssistantMessage(fauxToolCall(FIGURE_TOOL,{figures:sourceFigures},{id:"book-preview"}),{stopReason:"toolUse"}));
      manager.appendMessage({role:"toolResult",isError:false,toolCallId:"book-preview",toolName:FIGURE_TOOL,
        content:[{type:"text",text:"示例画稿已准备好。"}],details:{lessonFigures:batch},timestamp:Date.now()});
      manager.appendMessage(fauxAssistantMessage(lesson.body));
    }
    const info={url:preview.base+"/#learn",directory,model:binding?.model.id??"synthetic",pid:process.pid};
    writeFileSync(join(out,prediction?"prediction-preview-"+new URL(preview.base).port+".json":"preview.json"),JSON.stringify(info,null,2));console.log(JSON.stringify(info));
    await new Promise<void>(done=>{
      const timer=setInterval(()=>{if(existsSync(join(directory,"stop-"+process.pid))) stop();},400);
      function stop(){clearInterval(timer);done();}
      process.once("SIGINT",stop);process.once("SIGTERM",stop);
    });
  } else {
    const call=(name:string,args:Record<string,unknown>)=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:"toolUse"});
    if (!live || tutor) teachers.setResponses([call("load_learning_skill",{name:"lawa-illustrated-lesson"}),call(FIGURE_TOOL,{figures:lesson.figures,...(prediction?{require_prediction:true}:{})}),...(prediction?[]:[call(BEGIN_REPLY,{})]),fauxAssistantMessage(lesson.body)]);
    const browser=await chromium.launch({channel:"msedge",headless:true});
    try {
      const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:"reduce"}),errors:string[]=[];
      page.on("pageerror",e=>errors.push(e.message));
      await page.addInitScript(()=>localStorage.setItem("learn-anything:intro-watched:v1","true"));
      await page.goto(preview.base+"/#learn");
      await page.locator("#learning-intro").waitFor({state:"detached"});
      const request=continuousCase?"我第一次看小孔成像，想连续跟着两束光从物体的两端走过孔口，请用短动画讲。我想先一口气看完，遇到疑问我自己暂停问。":stackPrediction?"栈为什么是后放的先拿？用叠书的动画给我看一次如何从顶上拿走一本，然后再放一本。下一本拿走谁让我自己在图上点，猜偏了带我回看线索，也让我能跳过。先别把书名告诉我。":prediction?"我想弄清小孔两边的光是怎么走的。先带我看一束，再让我在画面上自己猜另一束会落到屏幕哪里。我也想能跳过直接看。开头请留给我自己判断。":pinhole?"小孔成像为什么是上下倒过来的？我想看一个会自己播放的简短讲解动画，跟着物体顶端、底端发出的光分别走一遍，一直看到它们落在屏上的位置。途中我想能停下来问。":queue?"窗口前依次排着甲、乙，后来丙也来了。队列里的先进先出和插队有什么区别？请用图解讲页做一段会自己播放的短动画，让我看到丙到队尾、甲离开、乙成为队首。":distance?"灯高 3 米，木桩高 1 米。为什么我把木桩挪远，影子就变长？请让我移动木桩比较一下距离和影长。想先听简短直观的解释。":book?"为什么把木桩放得离路灯更远，影子也变长？请用图解讲页写成科学读本中的一页，委托百炼生成一幅有纸纹、水彩和钢笔细节的横幅插画放在正文中。画一条傍晚的平坦小路，左边一盏亮起的单臂路灯，右边一根矮木桩，影子向右。我想先看一幅没有文字或刻度的纯风景画。再配一幅我可以拖动距离的示意图，假设灯高3米、桩高1米。":mix?"200 毫升糖水里有 8 克糖。我逐渐加入 0 到 200 毫升清水，假设体积可直接相加。用图解讲页在讲解中间配一幅可以拖动加水量的图，让我看到每 100 毫升里有多少克糖，并解释原因。":music?"四四拍，以四分音符为一拍，每分钟100拍。为什么把一拍分成两个八分音符，整首并没有变快？请用图解讲页，在讲解段落之间配一幅插画，讲清该看哪里。":"用图解讲页解释路灯与木桩的影子，在正文之间配图。";
      const start=Date.now();
      if (replay) await page.locator("article.message .lesson-motion").first().waitFor();
      else {
        await page.locator("#message-input:enabled").fill(request);
        await page.locator("#send-button").click();
      }
      let snapshot:any;
      const deadline=start+(pinhole||queue||prediction||continuousCase?300_000:180_000);
      do {
        snapshot=await(await fetch(preview.base+"/api/web/classroom/snapshot")).json();
        if (snapshot.run && snapshot.run.status!=="running") break;
        await new Promise(r=>setTimeout(r,200));
      } while(Date.now()<deadline);
      if (snapshot.run?.status==="running") await fetch(preview.base+"/api/web/sessions/"+snapshot.session.sessionId+"/stop",{method:"POST"});
      const totalMs=Date.now()-start;
      const reply=snapshot.session.messages.filter((m:any)=>m.role==="assistant" && m.content.trim()).at(-1);
      if (!replay) writeFileSync(join(out,mode+"-result.json"),JSON.stringify({directory,run:snapshot.run?.status,model:binding?.model.id??"synthetic",thinking:binding?.thinkingLevel,totalMs,firstTextMs:firstDeltaAt?firstDeltaAt-start:null,deltas,ready,toolsSeen,reply},null,2));
      assert.equal(snapshot.run?.status,"completed");
      assert.ok((replay || deltas>1 && ready>0) && reply?.figures?.length,"正文应引用本轮已创建的图");
      const figures=reply.figures.map((f:PlacedFigure)=>f.figure);
      if (!replay) writeFileSync(join(out,mode+"-lesson.json"),JSON.stringify({body:reply.content,figures},null,2));
      const article=page.locator('article.message[data-entry-id="'+reply.entryId+'"]');
      const plates=article.locator(".lesson-plate");
      await plates.first().waitFor();
      assert.equal(await plates.count(),figures.length);
      await page.waitForFunction(id=>{
        const content=document.querySelector('article.message[data-entry-id="'+id+'"] [data-note-message]');
        const tags=content?[...content.children].filter(c=>c.matches("p,figure")).map(c=>c.tagName):[];
        const first=tags.indexOf("FIGURE"); return first>0 && tags.slice(first+1).includes("P");
      },reply.entryId,{timeout:12000});
      const sequence=await article.locator("[data-note-message]").evaluate(n=>[...n.children].filter(c=>c.matches("figure,p")).map(c=>c.tagName));
      for (const width of [1440,1100]) {
        await page.setViewportSize({width,height:1000});
        for (const plate of await plates.all()) {
          const fits=await plate.evaluate(node=>{
            const svg=node.querySelector("svg,.lesson-painting-paper")!.getBoundingClientRect(),caption=node.querySelector("figcaption")!.getBoundingClientRect();
            const parent=node.closest(".message-content")!.getBoundingClientRect();
            return svg.bottom<=caption.top+1 && svg.left>=parent.left-1 && svg.right<=parent.right+1 && caption.right<=parent.right+1;
          });
          assert.ok(fits,"图片与图注独立排版，均在当前正文宽度内");
        }
      }
      await page.setViewportSize({width:1440,height:1000});
      const first=sequence.indexOf("FIGURE");
      assert.ok(first>0 && sequence.slice(first+1).includes("P"),"插画须在同一教师消息的正文段落之间");
      if (book) {
        assert.ok(figures.some((f:any)=>f.art) && figures.some((f:any)=>f.axis),"书籍插画与可调示意都需出现");
        const painting=article.locator(".lesson-painting").first();
        await page.waitForFunction(()=>document.querySelector(".lesson-painting img") || document.querySelector('.lesson-painting[data-art-state="failed"]'),{},{timeout:130000});
        assert.ok(await painting.locator("img").count(),await painting.innerText());
        await painting.scrollIntoViewIfNeeded();await page.screenshot({path:join(out,mode+"-painting.png")});
      }
      await plates.first().scrollIntoViewIfNeeded();await page.screenshot({path:join(out,mode+"-classroom.png")});
      if (continuousCase) assert.ok(figures.every((f:any)=>!f.prediction),"要求连播时应能直接看完");
      if (pinhole || queue || continuousCase) {
        const motion=figures.find((f:any)=>f.motion);
        assert.ok(motion,"讲解动画需要有时间编排，静态插画和可调示意不能代替此次验收");
        await inspectIllustratedMotion(page,article,motion,out,playbackOnly?mode+"-replay":mode,pinhole && !playbackOnly ? async()=>{
          await page.locator("#assistant-input:enabled").fill("请只根据我停下的这一刻说明，现在正在画哪一段，它已经走完了吗？");
          const sent=page.waitForResponse(r=>r.url().endsWith("/assistant") && r.request().method()==="POST");
          await page.locator("#assistant-send:enabled").click();
          const response=await sent; assert.ok(response.ok());await response.finished();
          const consultation=JSON.parse(readFileSync(join(directory,"sessions/assistants/consultations-v1.json"),"utf8")).records.at(-1);
          assert.equal(consultation.status,"COMPLETED");assert.ok(consultation.reply.trim());
          writeFileSync(join(out,mode+"-tutor.json"),JSON.stringify({frame:consultation.figureQuestion,answer:consultation.reply},null,2));
          return consultation.figureQuestion;
        } : undefined);
      }
      if (prediction) {
        const interactive=figures.find((f:any)=>f.prediction);
        assert.ok(interactive,"课堂实际需要呈现可跳过的预测");
        const ledgerBefore=JSON.parse(readFileSync(join(directory,"state.json"),"utf8"));
        await inspectIllustratedPrediction(page,article.locator(".lesson-plate").nth(figures.indexOf(interactive)),interactive,out,mode,
          playbackOnly?undefined:async stage=>{
            await page.locator("#assistant-input:enabled").fill(stage==="waiting"?"我现在可以观察什么来判断？请只提示观察方法，先保留落点。":"现在的空心圈代表什么？为什么回看刚才的运动？");
            const sent=page.waitForResponse(r=>r.url().endsWith("/assistant") && r.request().method()==="POST");
            await page.locator("#assistant-send:enabled").click();
            const response=await sent;assert.ok(response.ok());await response.finished();
            const consultation=JSON.parse(readFileSync(join(directory,"sessions/assistants/consultations-v1.json"),"utf8")).records.at(-1);
            assert.equal(consultation.status,"COMPLETED");
            writeFileSync(join(out,mode+"-"+stage+"-tutor.json"),JSON.stringify({frame:consultation.figureQuestion,answer:consultation.reply},null,2));
            return consultation.figureQuestion;
          });
        const ledgerAfter=JSON.parse(readFileSync(join(directory,"state.json"),"utf8"));
        for (const key of ["tasks","skills","evidence","answer_assessments"]) assert.deepEqual(ledgerAfter[key],ledgerBefore[key],key);
      }
      if (mix || distance) assert.ok(figures.some((f:any)=>f.axis),"控制一个条件时需要可拨动的图");
      await page.reload();await page.locator("#learning-intro").waitFor({state:"detached"});await plates.first().waitFor();
      assert.equal(await plates.count(),figures.length);
      if ((!live || tutor) && !prediction) {
        const active=plates.nth(1),button=active.locator(".lesson-plate-action"),slider=active.locator("input");
        await page.bringToFront();
        if (!tutor) {
          await button.click();await page.waitForFunction(()=>Number(document.querySelector<HTMLInputElement>(".lesson-plate-slider")?.value)>3);
          await button.click();const paused=await slider.inputValue();
          await page.waitForTimeout(150);assert.equal(await slider.inputValue(),paused);
        }
        await slider.focus();await slider.press("End");assert.match(await active.locator("output").innerText(),/影长 3/);
        await active.getByRole("button",{name:"问这幅图"}).click();
        await page.locator("#assistant-input:enabled").fill("这个位置为什么是这个长度？");
        assert.ok(!actualQuestion);
        const replyDone=page.waitForResponse(r=>r.url().endsWith("/assistant") && r.request().method()==="POST");
        await page.locator("#assistant-send:enabled").click();
        const replyStream=await replyDone;
        const withDeadline=AbortSignal.timeout(120000);
        await Promise.race([replyStream.finished(),new Promise((_,reject)=>withDeadline.addEventListener("abort",()=>reject(new Error("助教回复超时")),{once:true}))]);
        const payload=await(await fetch(preview.base+"/api/web/sessions/"+snapshot.session.sessionId+"/assistant")).json();
        const consultation=JSON.parse(readFileSync(join(directory,"sessions/assistants/consultations-v1.json"),"utf8")).records.at(-1);
        assert.equal(payload.messages.at(-1).content,consultation.reply);
        assert.equal(consultation.status,"COMPLETED");assert.ok(consultation.reply.trim());
        writeFileSync(join(out,mode+"-tutor.json"),JSON.stringify({question:actualQuestion,reply:consultation.reply},null,2));
        assert.equal(actualQuestion?.variable?.value,6);
        assert.equal(actualQuestion?.readings.find(r=>r.label==="影长")?.value,3);
        assert.equal(actualQuestion?.anchor.messageId,reply.entryId);
        await page.locator("#assistant-close").click();
        const quote="从灯到桩顶，光线下降 2 米。";
        await article.evaluate((el,quote)=>{
          const paragraph=[...el.querySelectorAll("p")].find(p=>p.textContent?.startsWith(quote))!;
          const text=paragraph.firstChild!,range=document.createRange();
          range.setStart(text,0);range.setEnd(text,quote.length);
          getSelection()!.removeAllRanges();getSelection()!.addRange(range);
          document.dispatchEvent(new Event("selectionchange"));
        },quote);
        await page.locator(".excerpt-save:visible").click();
        await page.locator("#excerpt-understanding:visible").fill("两段高之比可转为水平距离之比。");
        const saved=page.waitForResponse(r=>r.url().endsWith("/api/web/excerpt-notes") && r.request().method()==="POST");
        await page.locator(".excerpt-editor:visible [type=submit]").click();
        assert.ok((await saved).ok(),"可从插画之后的原文保存准确选段");

        const list=await(await toggle("lawa-illustrated-lesson",false)).json();
        assert.equal(list.skills.find((s:any)=>s.name==="lawa-illustrated-lesson").enabled,false);
        await page.reload();await plates.first().waitFor();
        assert.equal(await plates.count(),2,"关闭开关后旧图仍能看");
        const removed=await fetch(preview.base+"/api/web/learning-skills/lawa-illustrated-lesson",{method:"DELETE"});
        assert.ok(removed.ok);await page.reload();await plates.first().waitFor();
        assert.equal(await plates.count(),2,"移除技能后历史插图和可调示意仍能看");
      }
      const overview=await(await fetch(preview.apiBase+"/api/learning/overview")).json();
      assert.equal(overview.active_task.id,"ta");assert.equal(JSON.parse(readFileSync(join(directory,"state.json"),"utf8")).evidence.length,0);assert.deepEqual(errors,[]);
      console.log(JSON.stringify({mode,model:binding?.model.id??"synthetic",totalMs,deltas,figures:figures.length,sequence,toolsSeen,errors,anchor:actualQuestion?.anchor}));
    } finally {await browser.close();}
  }
} finally {await preview.stop();}
