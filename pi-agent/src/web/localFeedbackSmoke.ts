import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdir,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename,dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright-core";
import {build} from "vite";

// 只用隔离样例检验1188px桌面实际布局，不读取个人数据或调用模型。
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../../..");
const agent=join(root,"pi-agent"),temp=await mkdtemp(join(tmpdir(),"lawa-local-feedback-desktop-"));
const screenshots=resolve(process.env.LOCAL_FEEDBACK_SCREENSHOTS??join(root,"data/qa/local-feedback"));
await mkdir(screenshots,{recursive:true});
let server:ReturnType<typeof spawn>|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
let releaseTeacher:(()=>Promise<void>)|undefined;
try {
  const output=join(temp,"web");
  await build({configFile:join(agent,"web/vite.config.ts"),logLevel:"silent",build:{outDir:output}});
  server=spawn(process.execPath,["--import","tsx","src/web/academicWorkspaceFixture.ts"],{cwd:agent,
    env:{...process.env,READABLE_PORT:"0",READABLE_STATIC_DIR:output},stdio:["ignore","pipe","pipe"],windowsHide:true});
  const base=await new Promise<string>((done,reject)=>{let text="";server!.once("error",reject);server!.once("exit",code=>reject(Error(`Fixture exited: ${code}`)));
    server!.stdout!.on("data",chunk=>{text+=String(chunk);const match=/Academic fixture: (http:\/\/127\.0\.0\.1:\d+)/.exec(text);if(match)done(match[1]!);});});
  browser=await chromium.launch({headless:true,executablePath:process.env.LOCAL_FEEDBACK_BROWSER??"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"});
  const context=await browser.newContext({viewport:{width:1188,height:761},reducedMotion:"reduce"});
  await context.addInitScript(()=>{localStorage.setItem("learn-anything:intro-watched:v1","true");localStorage.setItem("learn-anything:sidebar-collapsed","false");});
  const page=await context.newPage(),errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await page.route("**/api/web/sessions/*/messages",route=>new Promise<void>(done=>{releaseTeacher=async()=>{await route.fulfill({contentType:"text/event-stream",body:""});done();};}));
  await page.goto(base,{waitUntil:"domcontentloaded"});await page.locator("#learning-intro").waitFor({state:"detached"});
  await page.locator("[data-action=toggle-focused-introduction]").waitFor({state:"visible"});
  await page.locator("#message-input").fill("请继续解释刚才的内容。");
  await page.locator("#send-button").click();
  await page.locator('#connection-status[data-status="connecting"]').waitFor({state:"visible"});
  await page.locator("#assistant-entry").click();await page.locator("#assistant-panel").waitFor({state:"visible"});
  const metrics=await page.evaluate(()=>{
    const header=document.querySelector<HTMLElement>(".learning-header-secondary")!;
    const route=header.querySelector<HTMLElement>(".route-toggle")!;
    const text=route.querySelector("span")!;
    const range=document.createRange();range.selectNodeContents(text);
    return {routeTextHeight:range.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(route).lineHeight)||parseFloat(getComputedStyle(route).fontSize)*1.4,
      headerWidth:header.clientWidth,headerScrollWidth:header.scrollWidth,routeWidth:route.clientWidth,
      tools:[...header.children].map(node=>({className:node.className,width:node.getBoundingClientRect().width,left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right})),
      documentWidth:document.documentElement.clientWidth,documentScrollWidth:document.documentElement.scrollWidth};
  });
  await page.screenshot({path:join(screenshots,"desktop-1188-assistant.png"),animations:"disabled"});
  console.log(JSON.stringify(metrics));
  assert.ok(metrics.routeTextHeight<=metrics.lineHeight*1.4,"路线文本不能被挤成两行单字");
  assert.ok(metrics.headerScrollWidth<=metrics.headerWidth+1,"页头不能溢出其可用宽度");
  assert.equal(metrics.documentScrollWidth,metrics.documentWidth,"桌面展开助教不能产生整页横向溢出");
  await page.setViewportSize({width:1260,height:761});
  await page.waitForTimeout(100);
  const narrowStage=await page.evaluate(()=>{
    const route=document.querySelector<HTMLElement>(".learning-header-secondary .route-toggle")!;
    const range=document.createRange();range.selectNodeContents(route.querySelector("span")!);
    const header=document.querySelector<HTMLElement>(".learning-header-secondary")!;
    const children=[...header.children].map(node=>node.getBoundingClientRect()).filter(rect=>rect.width&&rect.height);
    const overlaps=children.flatMap((a,i)=>children.slice(i+1).filter(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1));
    return {routeTextHeight:range.getBoundingClientRect().height,headerWidth:header.clientWidth,headerScrollWidth:header.scrollWidth,
      sideBySide:document.body.classList.contains("assistant-side-by-side"),overlaps:overlaps.length};
  });
  await page.screenshot({path:join(screenshots,"desktop-1260-assistant.png"),animations:"disabled"});
  console.log(JSON.stringify({narrowStage}));
  assert.ok(narrowStage.routeTextHeight<25,"助教并排后的窄课堂也必须保留完整路线标签");
  assert.ok(narrowStage.headerScrollWidth<=narrowStage.headerWidth+1,"并排页头不能溢出");
  assert.equal(narrowStage.overlaps,0,"页头动作、观察和生成状态不能重叠");
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:"PASS",screenshots,scope:"1188px desktop layout; isolated fixture, no personal model or data"}));
} finally {
  await releaseTeacher?.().catch(()=>undefined);
  await browser?.close();server?.kill();
  assert.equal(dirname(resolve(temp)),resolve(tmpdir()));assert.ok(basename(temp).startsWith("lawa-local-feedback-desktop-"));
  await rm(temp,{recursive:true,force:true});
}
