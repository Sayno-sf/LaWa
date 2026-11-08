import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {extname,resolve,sep} from "node:path";
import {chromium} from "playwright-core";

// 只运行隔离静态候选；浏览器API全部由fixture提供，不使用个人课堂或模型。
const staticDir=resolve(process.env.LEARNING_SKILLS_STATIC_DIR??"../data/qa/learning-skills-ui-web");
const output=resolve(process.env.LEARNING_SKILLS_SCREENSHOT_DIR??"../data/qa/learning-skills-ui-browser");
const mime:Record<string,string>={".html":"text/html; charset=utf-8",".js":"text/javascript",".css":"text/css",".json":"application/json",".svg":"image/svg+xml",".wasm":"application/wasm",".png":"image/png",".woff2":"font/woff2",".task":"application/octet-stream"};
const timestamp="2026-10-28T12:00:00Z";
const provider={provider:"fixture",model:"fixture",thinkingLevel:"off",maxOutputTokens:32768,hasApiKey:false};
const session={sessionId:"learning-skills-fixture",messages:[{role:"assistant",content:"我们从一个具体问题开始。",created_at:timestamp}],state:{
  view_mode:"CURRENT",active_goal_id:"goal-1",view_goal_id:"goal-1",
  overview:{current_goal:"读懂JS语法",current_goal_skill_ids:["skill-0"],skills:[{id:"skill-0",name:"读懂JS语法",description:"先看例子，再总结规则。",status:"LEARNING",target_depth:"APPLY",evidence_ids:[]}],
    curriculum_spine:[],recent_evidence:[],knowledge_cards:[],current_frontier:{focus_skill_id:"skill-0",supporting_skill_ids:[],reason:"",target_depth:"APPLY",next_action:""},
    active_task:{id:"task-1",title:"读懂一段代码",description:"",related_skill_ids:["skill-0"],status:"ACTIVE"}},
  teaching:{active_skill_id:"skill-0",teaching_mode:"EXPLAIN"},onboarding:{status:"IDLE",replace_existing:false},recommended_action:null,
}};
const defaults=[
  {name:"explainer-animation",description:"根据具体疑惑，使用对象变化、分支和预测讲清一个想法。",explicitOnly:false},
  {name:"lawa-teaching-animation",description:"用于递归返回与等式变形的两个精确教学样例。",explicitOnly:false},
];
const longName="custom-"+"long-name-".repeat(5)+"skill";
const longDescription="用于把复杂过程逐步讲清楚。".repeat(20)+" UnbrokenReference".repeat(7)+" <img src=x onerror=alert(1)>";
const server=createServer(async(request,response)=>{
  try{
    const url=new URL(request.url??"/","http://127.0.0.1"),path=resolve(staticDir,"."+decodeURIComponent(url.pathname==="/"?"/index.html":url.pathname));
    if(!path.startsWith(staticDir+sep)){response.writeHead(403);response.end();return;}
    response.writeHead(200,{"Content-Type":mime[extname(path)]??"application/octet-stream"});response.end(await readFile(path));
  }catch{response.writeHead(404);response.end();}
});
await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
const address=server.address();assert.ok(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}`;
await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.RESPONSIVE_BROWSER_PATH??"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",headless:true});
const errors:string[]=[],checks:unknown[]=[];
try{
  for(const [width,height]of [[1188,761],[1260,761]] as const){
    const context=await browser.newContext({viewport:{width,height},reducedMotion:"reduce"});
    await context.addInitScript(()=>{
      localStorage.setItem("learn-anything:intro-watched:v1","true");
      localStorage.setItem("learn-anything:feature-guide:v1",JSON.stringify({dismissed:true}));
    });
    const page=await context.newPage();page.setDefaultTimeout(10000);page.on("pageerror",error=>errors.push(`${width}: ${error.message}`));
    let mode:"ready"|"failure"|"empty"|"long"="ready",release:(()=>void)|undefined;
    let pending=new Promise<void>(done=>{release=done;}),reads=0;
    const writes:string[]=[];
    await page.route("**/api/**",async route=>{
      const request=route.request(),path=new URL(request.url()).pathname;
      if(request.method()!=="GET")writes.push(`${request.method()} ${path}`);
      const json=(body:unknown,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
      if(path==="/api/web/learning-skills"){
        reads++;await pending;
        if(mode==="failure")return json({detail:"技能目录暂时无法读取。"},503);
        return json({skills:mode==="empty"?[]:mode==="long"?[{name:longName,description:longDescription,explicitOnly:true}]:defaults,truncated:false});
      }
      if(path==="/api/web/teaching-instructions")return json({text:"",updatedAt:null,maxChars:4000});
      if(path==="/api/web/sessions")return json(request.method()==="POST"?session:{activeSessionId:session.sessionId,sessions:[]});
      if(path==="/api/web/provider-settings")return json({activeProfileId:null,active:provider,profiles:[]});
      if(path==="/api/web/speech-settings")return json({enabled:false,profileId:null,region:"beijing",asrModel:"qwen3-asr-flash",ttsModel:"qwen3-tts-flash",voice:"Cherry"});
      if(path==="/api/web/study-time")return json({scope:null,taskFocusedMs:0,goalFocusedMs:0,runFocusedMs:0,taskObservedMs:0,taskWaitingMs:0,observation:"UNKNOWN",recording:false});
      if(path==="/api/web/materials")return json({materials:[]});
      if(path==="/api/web/recycle")return json({items:[]});
      if(path==="/api/web/learning-library")return json({projects:[]});
      if(path==="/api/web/teaching")return json({proposals:[],current_goal_id:"goal-1"});
      return json({detail:"隔离验收不提供该接口。"},404);
    });
    try{
      await page.goto(base,{waitUntil:"domcontentloaded"});await page.locator("#learning-intro").waitFor({state:"detached"});
      const nav=page.locator('.nav-item[data-workspace-target="teaching"]');
      await nav.click();await page.locator("#teaching-arrangements-page:visible").waitFor();
      const section=page.locator("section.learning-skills"),input=page.locator("#teaching-instructions-input");
      await section.waitFor();assert.equal(await section.getAttribute("aria-label"),"技能插件");
      assert.match(await section.textContent()??"",/读取|加载/);
      release!();pending=Promise.resolve();
      await section.getByText("互动讲解动画",{exact:true}).waitFor();await section.getByText("基础教学演示",{exact:true}).waitFor();
      assert.equal(await page.locator('.nav-item').filter({hasText:"技能插件"}).count(),0,"复用教学安排导航，无独立技能导航");
      assert.equal(await section.locator("button").filter({hasText:/启用|停用|安装|卸载/}).count(),0);
      const computed=await section.evaluate(node=>{
        return {styles:["#teaching-arrangements-page h2",".learning-skills h3",".learning-skill h4",".learning-skill p",".learning-skill-availability"].map(selector=>{
          const element=document.querySelector(selector);if(!element)return {selector,missing:true};const css=getComputedStyle(element);
          return {selector,fontSize:css.fontSize,fontWeight:css.fontWeight,color:css.color,lineHeight:css.lineHeight};
        }),canvas:getComputedStyle(document.body).backgroundColor,sectionWidth:node.clientWidth};
      });
      assert.deepEqual(computed.styles.slice(1,4).map(value=>value.fontSize),["18px","15px","13px"]);
      await section.screenshot({path:resolve(output,`${width}-ready.png`)});
      await page.screenshot({path:resolve(output,`${width}-page.png`),fullPage:true});

      // 先导航重读，再在插件目录尚未返回时编辑。只要求本页目录操作保留偏好草稿。
      mode="failure";pending=new Promise<void>(done=>{release=done;});
      await page.locator('.nav-item[data-workspace-target="learn"]').click();await nav.click();
      await page.waitForFunction(()=>!document.querySelector(".teaching-instructions-status")?.textContent?.includes("正在读取"));
      const draft="目录失败或重试时，保留我尚未保存的教学偏好。";await input.fill(draft);
      release!();pending=Promise.resolve();const retry=section.getByRole("button",{name:"重新读取",exact:true});await retry.waitFor();
      assert.equal(await input.inputValue(),draft);await section.screenshot({path:resolve(output,`${width}-failure.png`)});
      mode="ready";await retry.click();await section.getByText("互动讲解动画",{exact:true}).waitFor();assert.equal(await input.inputValue(),draft);
      assert.equal(await page.locator('.teaching-instructions [data-action="save"]').isDisabled(),false);

      mode="empty";await page.locator('.nav-item[data-workspace-target="learn"]').click();await nav.click();
      await section.getByText(/还没有|尚未|暂无/).waitFor();assert.equal(await section.getByText("互动讲解动画",{exact:true}).count(),0);

      mode="long";await page.locator('.nav-item[data-workspace-target="learn"]').click();await nav.click();
      await section.getByText(longName,{exact:true}).first().waitFor();
      assert.match(await section.textContent()??"",/明确请求/);
      assert.equal(await section.locator("img").count(),0,"描述仅作文本，不能执行HTML");
      const overflow=await section.evaluate(node=>({scroll:node.scrollWidth,client:node.clientWidth,viewport:document.documentElement.scrollWidth,inner:innerWidth}));
      assert.ok(overflow.scroll<=overflow.client+1,JSON.stringify(overflow));assert.ok(overflow.viewport<=overflow.inner+1,JSON.stringify(overflow));
      await section.screenshot({path:resolve(output,`${width}-long.png`)});
      assert.deepEqual(writes.filter(value=>value!=="POST /api/web/sessions"),[],"插件目录不写偏好、聊天或学习事实");
      checks.push({width,height,reads,computed,passed:["existing teaching navigation","loading","two installed skills","failure and retry preserve current-page draft","empty","navigation rereads catalog","long names and description wrap","text-only description","no teaching or Kernel writes"],writes});
    }finally{await context.close();}
  }
  assert.deepEqual(errors,[]);
  const report={checks,errors,staticDir,output,scope:"static candidate and fixture API only; desktop; no actual model or personal data"};
  await writeFile(resolve(output,"report.json"),JSON.stringify(report,null,2),"utf8");console.log(JSON.stringify(report,null,2));
}finally{
  await browser.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));
}
