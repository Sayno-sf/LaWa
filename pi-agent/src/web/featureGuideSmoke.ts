import assert from "node:assert/strict";
import {mkdir} from "node:fs/promises";
import {join} from "node:path";
import {chromium, type BrowserContext, type Page} from "playwright-core";
import {GUIDE_KEY, guideTips} from "../../web/src/featureGuideContent.js";

const baseUrl = process.env.GUIDE_BASE_URL ?? "http://127.0.0.1:5186";
const output = process.env.GUIDE_SCREENSHOT_DIR;
const browser = await chromium.launch({executablePath:process.env.INTRO_BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",headless:true});
const writes: string[] = [], errors: string[] = [];
const provider = {provider:"fixture",model:"fixture",baseUrl:"https://example.invalid/v1",thinkingLevel:"off",maxOutputTokens:32768,hasApiKey:true,apiKeyHint:"fixture"};
function session(existing = false, purpose: string | null = null) {
  return {
    sessionId:"guide-fixture",
    messages:existing ? [{role:"assistant",content:"这里是原来的课堂。"}] : [],
    state:{view_mode:"CURRENT",active_goal_id:existing ? "goal-guide" : null,
      overview:{current_goal:existing ? "练习清楚地表达" : null,current_goal_skill_ids:existing ? ["skill-guide"] : [],
        curriculum_spine:existing ? [{id:"stage-1",name:"表达",description:"",target_depth:"PRACTICAL",skill_ids:["skill-guide"]}] : [],
        current_frontier:existing ? {focus_skill_id:"skill-guide",supporting_skill_ids:[],reason:"",target_depth:"PRACTICAL",next_action:""} : null,
        skills:existing ? [{id:"skill-guide",name:"提出清晰的问题",description:"用自己的话说明问题。",status:"LEARNING",target_depth:"PRACTICAL",evidence_ids:[]}] : [],
        recent_evidence:[],knowledge_cards:purpose==="CARDS" ? [{id:"card-guide",skill_id:"skill-guide",question:"什么是清楚的表达？",answer:"用自己的话表达。",created_at:"2026-10-25T12:00:00Z",source_conversation_id:null,feedback:null,feedback_updated_at:null,learner_note:null,note_updated_at:null}] : [],active_task:existing ? {id:"task-guide",title:"练习表达",description:"",related_skill_ids:["skill-guide"],status:"ACTIVE"} : null},
      teaching:{active_skill_id:existing ? "skill-guide" : null,teaching_mode:existing ? "EXPLAIN" : null,
        learner_questions:{pending:purpose && purpose!=="CARDS" ? {id:"question-guide",purpose,session_id:"guide-fixture",goal_id:"goal-guide",skill_id:"skill-guide",task_id:"task-guide",questions:[{id:"q1",prompt:"请用一句话提出问题。",selection:"freeform",options:[]},...(purpose==="PRACTICE_SET"?[{id:"q2",prompt:"换一种说法。",selection:"freeform",options:[]}]:[])]} : null,last_answer:null}},
      onboarding:{status:"IDLE",replace_existing:false},recommended_action:null},
  };
}
async function open(context: BrowserContext, existing = false, purpose: string | null = null, oldCatalog = false): Promise<Page> {
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    let data: unknown = {};
    if (req.method()==="POST" && path==="/api/web/sessions") {
      assert.deepEqual(req.postDataJSON(),{mode:"resume-recent"}); data=session(existing,purpose);
    } else if (req.method()!=="GET") writes.push(`${req.method()} ${path}`);
    else if (path==="/api/web/sessions") data={activeSessionId:"guide-fixture",sessions:[],unlinkedGoals:oldCatalog?[{id:"old",name:"以前的目标"}]:[]};
    else if (path==="/api/web/provider-settings") data={activeProfileId:null,active:provider,profiles:[]};
    else if (path==="/api/web/materials") data={materials:[]};
    else if (path==="/api/web/learning-library") data={projects:[]};
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(data)});
  });
  await page.goto(baseUrl);
  return page;
}
async function fresh(options: {blocked?: boolean; preference?: {mode:string;seen:string[]}; fullIntro?: boolean} = {}): Promise<BrowserContext> {
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  await context.addInitScript(({key,options})=>{
    if (!options.fullIntro) localStorage.setItem("learn-anything:intro-watched:v1","true");
    localStorage.setItem("learn-anything:task-focus-collapsed","true");
    if (options.preference && !localStorage.getItem(key)) localStorage.setItem(key,JSON.stringify(options.preference));
    if(options.blocked){Storage.prototype.getItem=()=>{throw new Error("blocked")};Storage.prototype.setItem=()=>{throw new Error("blocked")};}
  },{key:GUIDE_KEY,options});
  return context;
}
async function tip(page: Page, id: string): Promise<void> {
  await page.locator(`#feature-guide[data-tip="${id}"]:not([hidden])`).waitFor({timeout:15000});
  const boxes=await page.evaluate(()=>{
    const p=document.querySelector("#feature-guide")!.getBoundingClientRect();
    const a=document.querySelector(".feature-guide-outline")!.getBoundingClientRect();
    const composer=document.querySelector("#composer")!.getBoundingClientRect();
    return {fits:p.left>=0&&p.top>=0&&p.right<=innerWidth&&p.bottom<=innerHeight,overlap:p.left<a.right&&p.right>a.left&&p.top<a.bottom&&p.bottom>a.top,composerOverlap:p.left<composer.right&&p.right>composer.left&&p.top<composer.bottom&&p.bottom>composer.top};
  });
  assert.ok(boxes.fits); assert.equal(boxes.overlap,false,"tip must not cover its anchor");
  assert.equal(boxes.composerOverlap,false,"tip must not cover the existing composer");
}
async function shot(page: Page, name: string) {if(output) await page.screenshot({path:join(output,`${name}.png`)});}
async function released(page: Page) {await page.locator("#learning-intro").waitFor({state:"detached",timeout:15000});}
try {
  if(output)await mkdir(output,{recursive:true});
  const newcomer=await fresh({fullIntro:true}), page=await open(newcomer);
  await page.locator("#learning-intro").waitFor();
  assert.equal(await page.locator("#feature-guide").isVisible(),false);
  await released(page); await tip(page,"start");
  assert.equal(await page.locator("#app").evaluate(n=>(n as HTMLElement).inert),false);
  await shot(page,"first-goal");
  const before=await page.locator("#message-input").boundingBox();
  await page.locator("[data-guide-stop]").click();
  assert.deepEqual(await page.locator("#message-input").boundingBox(),before,"guide must not move the classroom");
  await page.reload(); await released(page); await page.waitForTimeout(1100);
  assert.equal(await page.locator("#feature-guide").isVisible(),false,"skip persists");
  await newcomer.close();

  const returning=await fresh(), old=await open(returning,true);
  await released(old); await old.waitForTimeout(1100);
  assert.equal(await old.locator("#feature-guide").isVisible(),false,"existing classroom must not be interrupted");
  const original=await old.locator("#message-input").boundingBox();
  await old.locator("#settings-button").click();
  await old.locator("#feature-guide-reference > summary").click();
  assert.equal(await old.locator("#feature-guide-reference dt").count(),guideTips.length);
  await shot(old,"settings-reference");
  await old.locator("[data-guide-replay]").click();
  await tip(old,"chat");
  assert.deepEqual(await old.locator("#message-input").boundingBox(),original,"replay preserves existing layout");
  await old.locator("[data-guide-next]").click(); await tip(old,"assistant"); await shot(old,"assistant-tip");
  assert.equal(await old.locator("#assistant-entry").getAttribute("aria-expanded"),"false","guide must not open assistant");
  await old.locator("[data-guide-next]").click(); await tip(old,"route");
  await old.locator("[data-guide-next]").click(); await tip(old,"library");
  await old.keyboard.press("Escape");
  assert.equal(await old.locator("#feature-guide").isVisible(),false);
  await old.locator("#materials-button").hover(); await tip(old,"upload");
  await old.locator("#message-input").fill("我的未发送草稿");
  assert.equal(await old.locator("#feature-guide").isVisible(),false,"typing must dismiss the nonmodal tip");
  assert.equal(await old.locator("#message-input").inputValue(),"我的未发送草稿");
  await returning.close();

  for(const purpose of ["CHECK","PRACTICE_SET"]){
    const id=purpose==="CHECK"?"practice":"practice-set";
    const context=await fresh({preference:{mode:"active",seen:guideTips.filter(t=>t.id!==id).map(t=>t.id)}});
    const exercise=await open(context,true,purpose); await released(exercise); await tip(exercise,id); await shot(exercise,id);
    assert.equal(await exercise.locator("#learner-questions textarea").inputValue(),"");
    await context.close();
  }
  const cardContext=await fresh({preference:{mode:"active",seen:guideTips.filter(t=>!["cards","note"].includes(t.id)).map(t=>t.id)}});
  const cards=await open(cardContext,true,"CARDS"); await released(cards); await tip(cards,"cards");
  await cards.locator("[data-guide-next]").click(); await cards.locator("#task-focus-toggle").click();
  await cards.locator('[data-card-action="flip"]').click();
  await tip(cards,"note"); await shot(cards,"card-note"); await cardContext.close();
  const prior=await fresh(), blank=await open(prior,false,null,true);
  await released(blank); await blank.waitForTimeout(1100);
  assert.equal(await blank.locator("#feature-guide").isVisible(),false,"historical goals suppress guide even in empty draft");
  await prior.close();
  const limited=await fresh({blocked:true}), restricted=await open(limited);
  await released(restricted); await restricted.waitForTimeout(1100);
  assert.equal(await restricted.locator("#feature-guide").isVisible(),false,"blocked storage must not cause repeated onboarding");
  await restricted.locator("#settings-button").click(); await restricted.locator("#feature-guide-reference > summary").click();
  await restricted.locator("[data-guide-replay]").click(); await tip(restricted,"start");
  await restricted.locator("[data-guide-stop]").click(); await limited.close();
  assert.deepEqual(writes,[],"guide cannot write learning state, send messages, start media or accept proposals");
  assert.deepEqual(errors,[]);
  console.log("PASS: intro sequencing, new/returning/history-only users, skip persistence, explicit replay, unchanged layout, assistant/route/library/upload, draft protection, CHECK/practice set, blocked storage; no extra writes or browser errors.");
} finally {await browser.close();}
