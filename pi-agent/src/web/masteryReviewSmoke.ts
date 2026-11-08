import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdir,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join,resolve,sep} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright-core";
import {build} from "vite";

// 桌面视觉夹具：只启动静态样例服务，所有用户决策/教师请求均在浏览器中拦截，不访问个人数据或模型。
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../../..");
const agent=join(root,"pi-agent");
const temp=await mkdtemp(join(tmpdir(),"lawa-mastery-desktop-"));
const screenshots=resolve(process.env.MASTERY_SCREENSHOT_DIR??join(root,"data/qa/mastery-review"));
await mkdir(screenshots,{recursive:true});
let fixture:ReturnType<typeof spawn>|undefined;
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try {
  const output=join(temp,"web");
  await build({configFile:join(agent,"web/vite.config.ts"),logLevel:"silent",build:{outDir:output}});
  fixture=spawn(process.execPath,["--import","tsx","src/web/academicWorkspaceFixture.ts"],{cwd:agent,
    env:{...process.env,READABLE_PORT:"0",READABLE_STATIC_DIR:output},stdio:["ignore","pipe","pipe"],windowsHide:true});
  const base=await new Promise<string>((done,reject)=>{
    let text="";fixture!.once("error",reject);fixture!.once("exit",code=>reject(Error(`Fixture exited: ${code}`)));
    fixture!.stdout!.on("data",chunk=>{text+=String(chunk);const match=/Academic fixture: (http:\/\/127\.0\.0\.1:\d+)/.exec(text);if(match)done(match[1]!);});
  });
  const session=await (await fetch(`${base}/api/web/sessions`,{method:"POST"})).json() as any;
  const pending={id:"mastery-desktop",purpose:"CONFIRM_MASTERY",session_id:session.sessionId,goal_id:"goal-0",task_id:"task-0",skill_id:"skill-0",scope_signature:"a".repeat(64),
    title:"这一节，你觉得掌握了吗？",questions:[{id:"mastery-review",prompt:"关于「函数参数：默认值与 rest 收敛数组」，你觉得现在掌握得怎样？",selection:"single",options:[
      {id:"proceed",label:"确认掌握并继续"},{id:"revise",label:"还有不清楚的地方"},{id:"skip",label:"暂不确认，继续下一节"}]}]};
  session.messages=[{role:"assistant",content:"你已经能解释默认参数的生效条件，也能判断 rest 数组的形状。我们可以先收一下这一节，再继续后面的内容。"}];
  let version=1;
  session.state.classroom_version=String(version);
  session.state.teaching.learner_questions={pending,last_answer:null};
  const decisions:any[]=[],messages:any[]=[],errors:string[]=[];
  browser=await chromium.launch({headless:true,executablePath:process.env.MASTERY_BROWSER_PATH??"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"});
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:"reduce"});
  await context.addInitScript(()=>localStorage.setItem("learn-anything:intro-watched:v1","true"));
  const page=await context.newPage();
  page.on("pageerror",error=>errors.push(error.message));
  await page.route("**/api/**",async route=>{
    const path=new URL(route.request().url()).pathname;
    const json=(value:unknown)=>route.fulfill({contentType:"application/json",body:JSON.stringify(value)});
    if(path.endsWith("/mastery-decision")) {
      const body=route.request().postDataJSON();decisions.push(body);
      session.state.classroom_version=String(++version);
      return json({state:session.state,continue_teaching:true});
    }
    if(path.endsWith("/messages")) {
      messages.push(route.request().postDataJSON());
      session.state.classroom_version=String(++version);
      session.state.teaching.learner_questions={pending:null,last_answer:null};
      return route.fulfill({contentType:"text/event-stream",body:`data: ${JSON.stringify({type:"assistant_delta",delta:"好，先把 rest 的调用形状再讲清楚。"})}\n\ndata: ${JSON.stringify({type:"state",state:session.state})}\n\n`});
    }
    if(path==="/api/web/classroom/snapshot") return json({session,run:null,version:String(version),sequence:version});
    if(path.endsWith("/state")) return json(session.state);
    if(path==="/api/web/sessions"&&route.request().method()==="POST") return json(session);
    return route.continue();
  });
  await page.goto(base,{waitUntil:"domcontentloaded"});
  await page.locator("#learning-intro").waitFor({state:"detached"});
  const card=page.locator("#learner-questions.learner-mastery-review");
  await card.waitFor({state:"visible"});
  await card.scrollIntoViewIfNeeded();
  assert.equal(await card.locator("[data-question-action]").count(),3);
  for (const action of ["proceed","revise","skip"]) assert.equal(await card.locator(`[data-question-action="${action}"]`).isVisible(),true);
  const bounds=await card.boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=1440);
  await page.screenshot({path:join(screenshots,"mastery-review-desktop.png"),animations:"disabled"});
  await card.locator('[data-question-action="revise"]').click();
  await card.locator("textarea").fill("我能看懂例子，但还不确定什么时候应当使用 rest 参数。");
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({path:join(screenshots,"mastery-review-gap.png"),animations:"disabled"});
  assert.equal(decisions.length,0,"展开和填写草稿不提交用户决定");
  await card.locator("[data-question-submit]").click();
  await card.waitFor({state:"detached"});
  assert.equal(decisions.length,1);assert.equal(messages.length,1);
  assert.deepEqual(decisions[0].learner_reply.answers[0].selected_option_ids,["revise"]);
  assert.equal(messages[0].expected_version,"2");
  assert.equal(messages[0].learner_reply.answers[0].other_text,"我能看懂例子，但还不确定什么时候应当使用 rest 参数。");
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:"PASS",scope:"isolated desktop UI only; no personal Kernel or model",screenshots,
    checks:["three explicit actions","card within desktop viewport","gap expansion preserves draft","no premature confirmation","decision before teacher request","fresh version"]}));
} finally {
  await browser?.close();fixture?.kill();
  assert.ok(resolve(temp).startsWith(resolve(tmpdir())+sep));
  await rm(temp,{recursive:true,force:true});
}
