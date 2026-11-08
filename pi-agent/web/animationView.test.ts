import test from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {AnimationPlayer,animationMarkup,type AnimationClock,type AnimationSelection} from "./src/animationView.js";
import {getAnimationArtifact} from "../src/animationCatalog.js";
import type {AnimationComponent} from "../src/animationTypes.js";

function fixture(artifactId="factorial-3-return") {
  const dom=new JSDOM('<div id="messages"></div>',{url:"http://localhost"});
  Object.defineProperty(dom.window,"matchMedia",{value:()=>({matches:false,addEventListener(){}})});
  for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event}))Object.defineProperty(globalThis,key,{value,configurable:true});
  let now=0,id=0;const pending=new Map<number,FrameRequestCallback>();
  const clock: AnimationClock={now:()=>now,frame:cb=>{pending.set(++id,cb);return id;},cancel:id=>{pending.delete(id);}};
  const advance=(ms:number)=>{const end=now+ms;while(now<end){now=Math.min(end,now+100);const calls=[...pending.values()];pending.clear();for(const cb of calls)cb(now);}};
  const component: AnimationComponent={id:"animation-1",sourceSessionId:"session-1",goalId:"goal-1",taskId:"task-1",skillId:"skill-1",entryId:"entry-1",artifact:getAnimationArtifact(artifactId)};
  const root=dom.window.document.querySelector<HTMLElement>("#messages")!;
  const selections:Array<{value:AnimationSelection;focus:boolean}>=[];let clears=0;
  const player=new AnimationPlayer(root,(value,focus)=>selections.push({value,focus}),()=>clears++,()=>undefined,clock);
  const context={sessionId:"session-1",goalId:"goal-1",taskId:"task-1",current:true,blocked:false};
  const mount=(components=[component])=>{root.innerHTML=components.map(animationMarkup).join("");player.mount(components,context);};mount();
  const click=(action:string)=>root.querySelector<HTMLButtonElement>(`[data-animation-action=${action}]`)!.click();
  return{dom,root,player,component,context,mount,click,advance,selections,clears:()=>clears};
}

test("manual pause and ask bind the exact paused position; remount preserves the original player",()=>{
  const f=fixture();try{
    const node=f.root.querySelector(".teaching-animation");
    f.click("play");f.advance(750);f.click("play");
    assert.equal(f.selections.length,0);f.click("ask");assert.equal(f.selections.length,1);assert.equal(f.selections[0]!.focus,true);
    assert.equal(f.selections[0]!.value.anchor.scene_id,f.component.artifact.lesson.scenes[0]!.id);
    assert.equal(f.selections[0]!.value.anchor.scene_elapsed_ms,750);
    f.mount();assert.equal(f.root.querySelector(".teaching-animation"),node);
    f.click("ask");assert.equal(f.selections.at(-1)!.focus,true);assert.equal(f.selections.at(-1)!.value.anchor.scene_elapsed_ms,750);
    f.click("play");assert.ok(f.clears()>0);f.advance(100);f.click("play");f.click("ask");assert.equal(f.selections.at(-1)!.value.anchor.scene_elapsed_ms,850);
  }finally{f.player.pauseAll();f.dom.window.close();}
});

test("manual navigation cannot skip prediction; choosing the canonical answer continues its declared branch",()=>{
  const f=fixture();try{
    const cp=f.component.artifact.lesson.checkpoint;
    const target=f.component.artifact.lesson.scenes.findIndex(s=>s.id===cp.after_scene);
    for(let i=0;i<=target;i++)f.click("next");
    assert.equal(f.root.querySelector<HTMLElement>(".animation-checkpoint")!.hidden,false);
    assert.equal(f.root.querySelector<HTMLButtonElement>("[data-animation-action=next]")!.disabled,true);
    assert.equal(f.root.querySelector<HTMLButtonElement>("[data-animation-action=play]")!.disabled,true);
    assert.equal(f.root.querySelector(".animation-prompt")!.textContent,f.component.artifact.validation.canonicalQuestion);
    const answer=cp.options.findIndex(o=>o.id===f.component.artifact.validation.correctOptionId);
    f.root.querySelectorAll<HTMLButtonElement>(".animation-options button")[answer]!.click();
    assert.match(f.root.querySelector(".animation-feedback")!.textContent!,/预测一致/);
    f.click("play");f.advance(300);f.click("play");f.click("ask");
    assert.equal(f.selections.at(-1)!.value.anchor.scene_id,cp.branches.correct.replay_scene);
  }finally{f.player.pauseAll();f.dom.window.close();}
});

test("wrong prediction and skip are local navigation; blocked explanation freezes controls and inherited sessions cannot ask",()=>{
  const f=fixture("linear-2x-plus3");try{
    const cp=f.component.artifact.lesson.checkpoint,target=f.component.artifact.lesson.scenes.findIndex(s=>s.id===cp.after_scene);
    for(let i=0;i<=target;i++)f.click("next");
    const wrong=cp.options.findIndex(o=>o.id!==f.component.artifact.validation.correctOptionId);
    f.root.querySelectorAll<HTMLButtonElement>(".animation-options button")[wrong]!.click();f.click("play");f.advance(100);f.click("play");f.click("ask");
    assert.equal(f.selections.at(-1)!.value.anchor.scene_id,cp.branches.incorrect.replay_scene);
    f.player.sync({...f.context,blocked:true});
    assert.equal(f.root.querySelector<HTMLButtonElement>("[data-animation-action=play]")!.disabled,true);
    f.player.sync({...f.context,sessionId:"fork-session"});
    assert.equal(f.root.querySelector<HTMLButtonElement>("[data-animation-action=ask]")!.disabled,true);
    assert.equal(f.root.querySelector<HTMLButtonElement>("[data-animation-action=play]")!.disabled,false);
  }finally{f.player.pauseAll();f.dom.window.close();}
  const g=fixture();try{
    const target=g.component.artifact.lesson.scenes.findIndex(s=>s.id===g.component.artifact.lesson.checkpoint.after_scene);
    for(let i=0;i<=target;i++)g.click("next");
    const skip=g.root.querySelectorAll<HTMLButtonElement>(".animation-options button");skip[skip.length-1]!.click();
    assert.equal(g.root.querySelector<HTMLElement>(".animation-checkpoint")!.hidden,true);
    assert.equal(g.selections.length,0);
  }finally{g.player.pauseAll();g.dom.window.close();}
});

test("automatic pause does not select input and switching player pauses the previous instance",()=>{
  const f=fixture();try{
    const other={...f.component,id:"animation-2",entryId:"entry-2"};f.mount([f.component,other]);
    f.click("play");f.advance(300);f.dom.window.dispatchEvent(new f.dom.window.Event("blur"));
    assert.equal(f.selections.length,0);assert.match(f.root.querySelector(".animation-play")!.textContent!,/继续看/);
    f.click("play");f.advance(200);
    const players=f.root.querySelectorAll<HTMLElement>(".teaching-animation");players[1]!.querySelector<HTMLButtonElement>("[data-animation-action=play]")!.click();
    assert.match(players[0]!.querySelector(".animation-play")!.textContent!,/继续看/);
    assert.match(players[1]!.querySelector(".animation-play")!.textContent!,/暂停/);
  }finally{f.player.pauseAll();f.dom.window.close();}
});

test("legacy play button keeps the same mouse target across frames and manual pause creates no quote",()=>{
  const f=fixture();try{
    f.click("play");const button=f.root.querySelector<HTMLButtonElement>("[data-animation-action=play]")!,span=button.querySelector("span");
    f.advance(100);assert.equal(button.querySelector("span"),span);f.advance(100);assert.equal(button.querySelector("span"),span);
    f.click("play");assert.equal(f.selections.length,0);assert.match(button.textContent!,/继续看/);f.advance(500);assert.equal(f.selections.length,0);
    f.click("ask");assert.equal(f.selections[0]!.value.anchor.scene_elapsed_ms,200);
  }finally{f.player.pauseAll();f.dom.window.close();}
});
