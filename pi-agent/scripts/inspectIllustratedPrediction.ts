import assert from "node:assert/strict";
import {writeFileSync} from "node:fs";
import {join} from "node:path";
import type {Locator,Page,Request} from "playwright-core";
import {prepareFigure,type InkFigure} from "../skills/lawa-illustrated-lesson/assets/ink.mjs";

export async function inspectIllustratedPrediction(page:Page,plate:Locator,figure:InkFigure,out:string,name:string,
    askTutor?:(stage:"waiting"|"feedback")=>Promise<{anchor:{tick:number;prediction?:string};motion?:{caption:string;changes:unknown[];prediction?:unknown}}>) {
  const drawing=prepareFigure(figure), gate=drawing.prediction;
  assert.ok(gate);
  const play=plate.locator(".lesson-plate-action"),seek=plate.getByRole("slider",{name:"讲解动画时间线"});
  const choices=plate.locator(".lesson-prediction-options"),feedback=plate.locator(".lesson-prediction-feedback");
  const tick=async()=>Number(await plate.getAttribute("data-elapsed-ms"));
  const routes:unknown[]=[], writes:string[]=[];
  let watching=false,commonFrame:string|undefined;
  const onRequest=(r:Request)=>{if(watching && !["GET","HEAD","OPTIONS"].includes(r.method()))writes.push(new URL(r.url()).pathname);};
  page.on("request",onRequest);
  try {
    await page.bringToFront();await plate.scrollIntoViewIfNeeded();
    for (const [index,choice] of [...gate.options,undefined].entries()) {
      assert.ok(!(await choices.isVisible()));
      await play.click();
      await choices.waitFor({state:"visible",timeout:gate.atMs+12000});
      assert.equal(await tick(),gate.atMs);assert.equal(await plate.locator(".lesson-motion-caption").innerText(),gate.prompt);
      assert.equal(await play.innerText(),"继续看");await page.waitForTimeout(180);assert.equal(await tick(),gate.atMs);
      if (index===0) {
        await page.screenshot({path:join(out,name+"-waiting.png")});
        if (askTutor) {
          await plate.getByRole("button",{name:"问这幅图"}).click();
          const question=await askTutor("waiting");
          assert.equal(question.anchor.tick,gate.atMs);assert.equal(question.anchor.prediction,"waiting");
          assert.deepEqual(question.motion?.prediction,drawing.at(gate.atMs,"waiting").moment!.prediction);
          assert.deepEqual(question.motion?.changes,[]);
          await page.locator("#assistant-close").click();assert.equal(await tick(),gate.atMs);
        }
      }
      watching=true;
      if (!choice) await play.click();
      else if (index===0) await plate.locator(".lesson-prediction-target").nth(index).locator(".hit").click();
      else await choices.getByRole("button",{name:choice.label,exact:true}).press("Enter");
      await choices.waitFor({state:"hidden"});await play.click();
      const paused=await tick(),from=choice?.replay?gate.reviewMs:gate.atMs;
      assert.ok(paused>=from && paused<Math.min(from+1300,gate.joinMs),"选择与跳过均应立即走相应时间段");
      if (choice) {
        assert.equal(await feedback.innerText(),choice.feedback);
        assert.equal(await plate.locator(".lesson-prediction-target.chosen").getAttribute("transform"),"translate("+choice.point.join(" ")+")");
        if (choice.replay) {
          await page.screenshot({path:join(out,name+"-compare.png")});
          if (askTutor) {
            watching=false;
            await plate.getByRole("button",{name:"问这幅图"}).click();
            const question=await askTutor("feedback");
            assert.equal(question.anchor.tick,paused);assert.equal(question.anchor.prediction,choice.id);
            assert.deepEqual(question.motion?.prediction,drawing.at(paused,choice.id).moment!.prediction);
            await page.locator("#assistant-close").click();assert.equal(await tick(),paused);
            watching=true;
          }
        }
      } else {
        assert.ok(!(await feedback.isVisible()));assert.equal(await plate.locator(".lesson-prediction-target.chosen").count(),0);
      }
      await play.click();
      await plate.getByRole("button",{name:"重播",exact:true}).waitFor({timeout:drawing.durationMs+8000});
      assert.ok(!(await choices.isVisible()) && !(await feedback.isVisible()));
      const state=await plate.locator("svg").evaluate(svg=>[...svg.children].filter(n=>n.tagName.toLowerCase()!=="g").map(n=>n.outerHTML).join(""));
      if (commonFrame!==undefined) assert.equal(state,commonFrame);else commonFrame=state;
      watching=false;routes.push({choice:choice?.id??"skip",from,paused,ended:await tick()});
    }
    // An intentional seek over an unanswered checkpoint is another way to keep watching.
    await play.click();await play.click();await seek.focus();await seek.press("End");
    assert.equal(await tick(),drawing.durationMs);assert.ok(!(await choices.isVisible()));
    const teachingWrites=writes.filter(url=>!url.includes("study-time"));
    assert.deepEqual(teachingWrites,[],"预测、选错与跳过均在本地完成");
    writeFileSync(join(out,name+"-paths.json"),JSON.stringify({atMs:gate.atMs,joinMs:gate.joinMs,routes,teachingWrites},null,2));
  } finally {page.off("request",onRequest);}
}
