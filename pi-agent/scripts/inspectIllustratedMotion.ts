import assert from "node:assert/strict";
import {writeFileSync} from "node:fs";
import {join} from "node:path";
import type {Locator,Page} from "playwright-core";
import {prepareFigure,type InkFigure} from "../skills/lawa-illustrated-lesson/assets/ink.mjs";

/** Exercise the real clock, not a programmatically assigned slider or a detached demo. */
export async function inspectIllustratedMotion(page:Page,article:Locator,figure:InkFigure,reportDir:string,name:string,
    askTutor?:()=>Promise<{anchor:{tick:number};motion?:{elapsedMs:number;caption:string;changes:unknown[]}}>) {
  const drawing=prepareFigure(figure);
  assert.ok(figure.motion && drawing.durationMs>0);
  const plate=article.locator(".lesson-motion").first();
  const play=plate.locator(".lesson-plate-action"),caption=plate.locator(".lesson-motion-caption");
  await plate.scrollIntoViewIfNeeded();
  await page.bringToFront();
  const tick=async()=>Number(await plate.getAttribute("data-elapsed-ms"));
  async function checkDisplayedFrame() {
    const painted=await plate.evaluate(el=>({
      ms:Number((el as HTMLElement).dataset.elapsedMs),
      caption:el.querySelector(".lesson-motion-caption")!.textContent,
      attrs:[...el.querySelector("svg")!.children].map(mark=>Object.fromEntries([...mark.attributes].map(a=>[a.name,a.value])))
    }));
    const expected=drawing.at(painted.ms);
    assert.equal(painted.caption,expected.moment!.caption);
    expected.marks.forEach((mark,i)=>{
      for (const [key,value] of Object.entries(mark.attrs)) assert.equal(painted.attrs[i]![key],String(value),key);
    });
    return painted.ms;
  }
  assert.equal(await plate.locator(".lesson-plate-slider").count(),0);
  assert.equal(await play.innerText(),"播放讲解");
  assert.equal(await checkDisplayedFrame(),0);
  // Observe unchanged DOM during pause and record the actual captions crossed during play.
  await plate.evaluate(el=>{
    const seen:Record<string,string>={};
    seen[(el as HTMLElement).dataset.step!]=el.querySelector(".lesson-motion-caption")!.textContent!;
    new MutationObserver(()=>{seen[(el as HTMLElement).dataset.step!]=el.querySelector(".lesson-motion-caption")!.textContent!;})
      .observe(el,{attributes:true,attributeFilter:["data-step"]});
    (el as HTMLElement & {seen:typeof seen}).seen=seen;
  });
  let start=0,stopAt=0;
  for(const cue of figure.motion) {
    const length=Math.round(cue.seconds*1000),mid=start+Math.floor(length*.45);
    if(drawing.at(mid).moment!.changes.some(c=>c.field!=="opacity")) {stopAt=mid;break;}
    start+=length;
  }
  assert.ok(stopAt);
  await play.click();
  await page.waitForFunction(ms=>Number(document.querySelector<HTMLElement>(".lesson-motion")?.dataset.elapsedMs)>=ms,stopAt,{timeout:100000});
  await play.click();
  const paused=await checkDisplayedFrame(),moment=drawing.at(paused).moment!;
  assert.ok(paused>moment.startMs && paused<moment.endMs && moment.changes.length,"须在动作中途停帧");
  const text=await caption.innerText();
  await page.waitForTimeout(240);assert.equal(await tick(),paused);
  await page.screenshot({path:join(reportDir,name+"-paused.png")});
  if (askTutor) {
    await plate.getByRole("button",{name:"问这幅图"}).click();
    const actual=await askTutor();
    assert.equal(actual.anchor.tick,paused);
    assert.equal(actual.motion?.caption,text);
    assert.deepEqual(actual.motion?.changes,moment.changes.slice(0,24));
    await page.locator("#assistant-close").click();
    assert.equal(await tick(),paused);
  }
  await play.click();
  await page.waitForFunction(()=>document.querySelector(".lesson-motion .lesson-plate-action")?.textContent==="重播",undefined,{timeout:drawing.durationMs+12000});
  assert.equal(await checkDisplayedFrame(),drawing.durationMs);
  const seen=await plate.evaluate(el=>(el as HTMLElement & {seen:Record<string,string>}).seen);
  assert.equal(Object.keys(seen).length,figure.motion.length);
  assert.deepEqual(Object.values(seen),figure.motion.map(c=>c.say.trim()));
  await plate.scrollIntoViewIfNeeded();
  await page.screenshot({path:join(reportDir,name+"-end.png")});
  const seek=plate.getByRole("slider",{name:"讲解动画时间线"});
  await seek.focus();await seek.press("ArrowLeft");assert.equal(await checkDisplayedFrame(),drawing.durationMs-1000);
  await seek.press("End");assert.equal(await tick(),drawing.durationMs);
  // On replay, exercise a legal browser timestamp from just before the click that started this frame.
  await play.evaluate(button=>button.addEventListener("click",()=>{
    const native=window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame=callback=>{window.requestAnimationFrame=native;return native(now=>callback(now-150));};
  },{once:true,capture:true}));
  await play.click();await page.waitForFunction(()=>Number(document.querySelector<HTMLElement>(".lesson-motion")?.dataset.elapsedMs)>0);
  await play.click();assert.ok(await tick()<figure.motion[0]!.seconds*1000);
  const evidence={key:figure.key,durationMs:drawing.durationMs,seen,pausedMs:paused,pausedFrame:moment,
    completeFrame:drawing.at(drawing.durationMs),verifiedAssistant:!!askTutor};
  writeFileSync(join(reportDir,name+"-playback.json"),JSON.stringify(evidence,null,2));
}
