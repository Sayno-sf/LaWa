import test from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {ExplainerPlayer,explainerMarkup,type ExplainerSelection} from "./src/explainerView.js";
import type {AnimationClock} from "./src/animationView.js";
import {replayExplainer,validateExplainerScript,type ExplainerComponent} from "../src/explainerTypes.js";

const scriptInput={title:"新格子怎样变化",subtitle:"先看变化，再做一个预测。",start:"start",stage:[
  {id:"items",k:"cells",x:60,y:120,t:["A"]},
  {id:"label",k:"label",x:60,y:80,t:"原来的值"},
  {id:"pointer",k:"arrow",x:210,y:146,len:100},
],nodes:{
  start:{label:"先看这里",ops:[["say","先看这一个格子。"],["show","items"],["say","新的一格会跟着改变吗？"]],ask:{q:"你觉得会怎样？",opts:[{t:"一起改变",go:"together"},{t:"保持不变",go:"separate"},{t:"还不确定",go:"unsure"}]}},
  together:{label:"一起看",ops:[["set","label","一起看这个变化"],["push","items","B"],["move","items",260,120],["say","看看两个格子之间的关系。"]],next:"end"},
  separate:{label:"分开看",ops:[["set","label","再看一遍这个变化"],["push","items","C"],["move","items",160,120],["say","看看新的一格来自哪里。"]],next:"end"},
  unsure:{label:"慢一点看",ops:[["set","label","我们一起拆开看"],["push","items","?"],["move","items",360,120],["say","先认清每一个格子，再看变化。"]],next:"end"},
  end:{label:"再想一步",ops:[["say","现在可以回到原来的问题了。"]],end:true},
}};

function fixture(reduced=false,input:unknown=scriptInput){
  const validated=validateExplainerScript(input),dom=new JSDOM('<div id="messages" class="message-content"></div>',{url:"http://localhost"});
  Object.defineProperty(dom.window,"matchMedia",{value:()=>({matches:reduced,addEventListener(){}})});
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event}))Object.defineProperty(globalThis,key,{value,configurable:true});
  let now=0,id=0;const pending=new Map<number,FrameRequestCallback>();
  const clock:AnimationClock={now:()=>now,frame:cb=>{pending.set(++id,cb);return id;},cancel:id=>{pending.delete(id);}};
  const advance=(ms:number)=>{const end=now+ms;while(now<end){now=Math.min(end,now+100);const callbacks=[...pending.values()];pending.clear();for(const cb of callbacks)cb(now);}};
  const component:ExplainerComponent={id:"explainer-1",sourceSessionId:"session-1",goalId:"goal-1",taskId:"task-1",skillId:"skill-1",entryId:"entry-1",artifact:{id:"fixture",version:"1",contentSha256:"a".repeat(64),skillVersion:"1",templateVersion:"explainer-v1",validatorVersion:"explainer-validator-v1",...validated}};
  const root=dom.window.document.querySelector<HTMLElement>("#messages")!,selections:Array<{value:ExplainerSelection;focus:boolean}>=[];let clears=0,beforePlay=0;
  const player=new ExplainerPlayer(root,(value,focus)=>selections.push({value,focus}),()=>clears++,()=>beforePlay++,clock);
  const context={sessionId:"session-1",goalId:"goal-1",taskId:"task-1",skillId:"skill-1",current:true,blocked:false};
  const mount=(components=[component])=>{root.innerHTML=components.map(explainerMarkup).join("");player.mount(components,context);};mount();
  const click=(action:string)=>root.querySelector<HTMLButtonElement>(`[data-explainer-action=${action}]`)!.click();
  const goToQuestion=()=>{click("next");click("next");};
  return{dom,root,player,component,context,mount,click,advance,selections,goToQuestion,clears:()=>clears,beforePlay:()=>beforePlay,pending:()=>pending.size};
}

test("starts only on click; pause, ask, remount and explanation preserve the same visible anchor",()=>{
  const f=fixture();try{
    const node=f.root.querySelector(".teaching-explainer");assert.equal(f.pending(),0);f.advance(400);assert.equal(f.selections.length,0);
    f.click("play");f.advance(750);f.click("play");
    assert.equal(f.selections.length,0);f.click("ask");assert.equal(f.selections.length,1);assert.equal(f.selections[0]!.focus,true);
    assert.equal(f.selections[0]!.value.anchor.scene_id,"start:0");assert.equal(f.selections[0]!.value.anchor.scene_elapsed_ms,750);
    assert.deepEqual(f.selections[0]!.value.anchor.explainer_path,["start"]);
    f.mount();assert.equal(f.root.querySelector(".teaching-explainer"),node);assert.equal(f.pending(),0);
    f.click("ask");assert.equal(f.selections.at(-1)!.focus,true);assert.equal(f.selections.at(-1)!.value.anchor.scene_elapsed_ms,750);
    f.player.sync({...f.context,blocked:true});f.advance(1000);f.player.sync(f.context);assert.equal(f.pending(),0);
    f.click("play");assert.ok(f.clears()>0);f.advance(100);f.click("play");f.click("ask");assert.equal(f.selections.at(-1)!.value.anchor.scene_elapsed_ms,850);
  }finally{f.player.pauseAll();f.dom.window.close();}
});

test("next sentence applies intervening actions but stops at the unanswered prediction; uncertainty keeps its real path",()=>{
  const f=fixture();try{
    f.click("next");assert.equal(f.root.querySelector(".explainer-caption")!.textContent,"新的一格会跟着改变吗？");
    assert.equal(f.root.querySelector<HTMLElement>('[data-explainer-element="items"]')!.style.opacity,"1");
    f.click("next");assert.equal(f.root.querySelector<HTMLElement>(".explainer-question")!.hidden,false);
    assert.equal(f.root.querySelector<HTMLButtonElement>("[data-explainer-action=next]")!.disabled,true);
    assert.equal(f.root.querySelector<HTMLButtonElement>("[data-explainer-action=play]")!.disabled,true);
    const options=f.root.querySelectorAll<HTMLButtonElement>(".explainer-options button");assert.equal(options.length,3);assert.equal(f.root.querySelector("[aria-selected=true],input:checked"),null);
    f.click("ask");assert.equal(f.selections.at(-1)!.value.anchor.scene_id,"start:3");assert.equal(f.selections.at(-1)!.value.anchor.scene_elapsed_ms,0);
    options[2]!.click();f.advance(100);f.click("play");f.click("ask");assert.deepEqual(f.selections.at(-1)!.value.anchor.explainer_path,["start","unsure"]);
    f.click("next");assert.equal(f.root.querySelector(".explainer-caption")!.textContent,"先认清每一个格子，再看变化。");
    assert.deepEqual([...f.root.querySelectorAll(".explainer-cell")].map(e=>e.textContent),["A","?"]);
    f.click("next");f.click("ask");assert.deepEqual(f.selections.at(-1)!.value.anchor.explainer_path,["start","unsure","end"]);
    assert.equal(f.selections.at(-1)!.value.anchor.scene_id,"end:0");assert.deepEqual([...f.root.querySelectorAll(".explainer-cell")].map(e=>e.textContent),["A","?"]);
    f.click("next");f.click("ask");assert.equal(f.selections.at(-1)!.value.anchor.scene_id,"end:1");assert.equal(f.pending(),0);
    f.click("replay");f.click("play");f.click("ask");assert.deepEqual(f.selections.at(-1)!.value.anchor.explainer_path,["start"]);
    assert.deepEqual([...f.root.querySelectorAll(".explainer-cell")].map(e=>e.textContent),["A"]);
  }finally{f.player.pauseAll();f.dom.window.close();}
});

test("move freezes at the quoted clock position and merge replay follows the selected branch",()=>{
  const f=fixture();try{
    f.goToQuestion();f.root.querySelectorAll<HTMLButtonElement>(".explainer-options button")[0]!.click();f.advance(1300);f.click("play");f.click("ask");
    const selected=f.selections.at(-1)!.value.anchor;assert.equal(selected.scene_id,"together:2");assert.equal(selected.scene_elapsed_ms,350);
    const item=f.root.querySelector<HTMLElement>('[data-explainer-element="items"]')!;assert.equal(item.style.left,"160px");
    f.advance(1000);assert.equal(item.style.left,"160px");f.mount();assert.equal(item.style.left,"160px");
    const canonical=replayExplainer(f.component.artifact.script,selected.explainer_path!,2,350);assert.equal(canonical.transitionProgress,.5);
    f.click("ask");assert.equal(f.selections.at(-1)!.value.anchor.scene_elapsed_ms,350);assert.equal(item.style.left,"160px");
    f.click("next");f.click("next");assert.deepEqual([...f.root.querySelectorAll(".explainer-cell")].map(e=>e.textContent),["A","B"]);
  }finally{f.player.pauseAll();f.dom.window.close();}
});

test("automatic pauses never select input; players exclude each other and historical scopes only replay",()=>{
  const f=fixture();try{
    const other={...f.component,id:"explainer-2",entryId:"entry-2"};f.mount([f.component,other]);f.click("play");f.advance(300);
    f.dom.window.dispatchEvent(new f.dom.window.Event("blur"));assert.equal(f.selections.length,0);assert.equal(f.pending(),0);
    f.click("play");f.advance(200);const nodes=f.root.querySelectorAll<HTMLElement>(".teaching-explainer");
    nodes[1]!.querySelector<HTMLButtonElement>("[data-explainer-action=play]")!.click();assert.match(nodes[0]!.querySelector(".explainer-play")!.textContent!,/继续看/);assert.match(nodes[1]!.querySelector(".explainer-play")!.textContent!,/暂停/);assert.equal(f.pending(),1);
    f.player.sync({...f.context,sessionId:"fork-session"});assert.equal(f.pending(),0);
    assert.equal(nodes[0]!.querySelector<HTMLButtonElement>("[data-explainer-action=ask]")!.disabled,true);assert.equal(nodes[0]!.querySelector<HTMLButtonElement>("[data-explainer-action=play]")!.disabled,false);
    f.click("ask");assert.equal(f.selections.length,0);f.click("play");assert.equal(f.pending(),1);
    f.player.sync({...f.context,blocked:true});assert.equal(f.pending(),0);assert.equal(nodes[0]!.querySelector<HTMLButtonElement>("[data-explainer-action=next]")!.disabled,true);
    assert.ok(f.beforePlay()>=3);
  }finally{f.player.pauseAll();f.dom.window.close();}
});

test("reduced motion reports the same stable state the learner can see",()=>{
  const f=fixture(true);try{
    f.goToQuestion();f.root.querySelectorAll<HTMLButtonElement>(".explainer-options button")[0]!.click();f.advance(1300);f.click("play");f.click("ask");
    assert.equal(f.root.querySelector<HTMLElement>('[data-explainer-element="items"]')!.style.left,"260px");
    const anchor=f.selections.at(-1)!.value.anchor;assert.equal(anchor.scene_id,"together:2");assert.equal(anchor.scene_elapsed_ms,700);
    const canonical=replayExplainer(f.component.artifact.script,anchor.explainer_path!,2,anchor.scene_elapsed_ms);assert.equal(canonical.transition,false);assert.equal(canonical.targetState.elements.items!.x,260);
  }finally{f.player.pauseAll();f.dom.window.close();}
});

test("all lesson copy stays text and zero-duration actions finish without starting an implicit clock",()=>{
  const f=fixture(false,{title:"安全的文本舞台",start:"start",stage:[{id:"text",k:"text",x:20,y:50,t:'<img src=x onerror="x()">'}],nodes:{start:{label:"文本",ops:[["show","text"],["hide","text"],["wait",0],["say","<svg onload=x>"]],end:true}}});try{
    assert.equal(f.root.querySelector("img,svg[onload]"),null);assert.match(f.root.querySelector('[data-explainer-element="text"]')!.textContent!,/<img/);
    f.click("play");f.advance(500);f.click("play");f.click("ask");assert.equal(f.selections.at(-1)!.value.anchor.scene_id,"start:3");
    assert.equal(f.root.querySelector(".explainer-caption")!.textContent,"<svg onload=x>");assert.equal(f.root.querySelector("img,svg[onload]"),null);
    f.click("play");f.advance(3000);assert.equal(f.pending(),0);f.click("ask");assert.equal(f.selections.at(-1)!.value.anchor.scene_id,"start:4");
  }finally{f.player.pauseAll();f.dom.window.close();}
});

test("fractional wait time stays inside the canonical action duration when quoted",()=>{
  const f=fixture(false,{title:"短暂停顿",start:"start",stage:[{id:"text",k:"text",x:20,y:50,t:"观察"}],nodes:{start:{label:"暂停",ops:[["wait",75.6]],end:true}}});try{
    f.click("play");f.advance(75.55);f.click("play");f.click("ask");const anchor=f.selections.at(-1)!.value.anchor;
    assert.equal(anchor.scene_elapsed_ms,75.55);assert.doesNotThrow(()=>replayExplainer(f.component.artifact.script,anchor.explainer_path!,0,anchor.scene_elapsed_ms));
  }finally{f.player.pauseAll();f.dom.window.close();}
});

test("the pause pointer target survives every playback frame and pausing alone never selects a question",()=>{
  const f=fixture();try{
    f.click("play");const button=f.root.querySelector<HTMLButtonElement>("[data-explainer-action=play]")!,span=button.querySelector("span");
    f.advance(100);assert.equal(button.querySelector("span"),span);f.advance(100);assert.equal(button.querySelector("span"),span);
    f.click("play");assert.equal(f.pending(),0);assert.equal(f.selections.length,0);f.advance(800);assert.equal(f.selections.length,0);
    f.click("ask");assert.equal(f.selections.length,1);assert.equal(f.selections[0]!.value.anchor.scene_elapsed_ms,200);
  }finally{f.player.pauseAll();f.dom.window.close();}
});

test("swap and bars interpolate with the shared clock and freeze at the canonical midpoint",()=>{
  const f=fixture(false,{title:"交换与柱子",start:"start",stage:[{id:"items",k:"cells",x:32,y:32,t:["A","B"]},{id:"bars",k:"bars",x:220,y:32,w:200,h:150,t:[4,2],max:10,lb:["甲","乙"]}],nodes:{start:{label:"比较",ops:[["show","*"],["swap","items",0,1],["bar","bars",0,8],["say","同一组数据，观察变化。"]],end:true}}});try{
    f.click("play");f.advance(760);f.click("play");f.click("ask");
    const cells=f.root.querySelectorAll<HTMLElement>(".explainer-cell");assert.equal(cells[0]!.textContent,"A");assert.match(cells[0]!.style.transform,/translateX\(/);const frozen=cells[0]!.style.transform;f.advance(500);assert.equal(cells[0]!.style.transform,frozen);
    assert.equal(f.selections.at(-1)!.value.anchor.scene_id,"start:1");assert.equal(f.selections.at(-1)!.value.anchor.scene_elapsed_ms,310);
    f.click("play");f.advance(710);f.click("play");f.click("ask");
    assert.deepEqual([...f.root.querySelectorAll(".explainer-cell")].map(e=>e.textContent),["B","A"]);
    const fill=f.root.querySelector<HTMLElement>(".explainer-bar-fill")!;assert.equal(fill.style.height,"60%");assert.equal(f.root.querySelector(".explainer-bar-value")!.textContent,"6");f.advance(900);assert.equal(fill.style.height,"60%");
  }finally{f.player.pauseAll();f.dom.window.close();}
});

test("row reveal, marks and curve drawing use deterministic replay instead of CSS animations",()=>{
  const f=fixture(false,{title:"逐行和曲线",start:"start",stage:[{id:"table",k:"table",x:24,y:16,w:240,t:[["名称","数值"],["甲","4"]]},{id:"lines",k:"lines",x:24,y:128,w:240,t:["a + a = 2a"]},{id:"plot",k:"plot",x:300,y:16,w:300,h:200,xr:[0,2],yr:[0,4],series:{curve:{pts:[[0,0],[1,1],[2,4]],lb:"增长"}}}],nodes:{start:{label:"一步步看",ops:[["show","*"],["row","table",0],["row","lines",0],["mark","table",0,"hot"],["draw","plot","curve"],["dot","plot","curve",2],["say","沿着同一个点看变化。"]],end:true}}});try{
    f.click("play");f.advance(700);f.click("play");
    assert.equal(f.root.querySelector<HTMLElement>(".explainer-table-row")!.style.opacity,"0.5");f.advance(1000);assert.equal(f.root.querySelector<HTMLElement>(".explainer-table-row")!.style.opacity,"0.5");
    f.click("play");f.advance(1900);f.click("play");
    assert.equal(f.root.querySelector(".explainer-table-row")!.classList.contains("ex-hot"),true);
    const curve=f.root.querySelector(".explainer-plot-curve")!;assert.equal(curve.getAttribute("stroke-dashoffset"),"0.5");const originalCurve=curve;f.mount();assert.equal(f.root.querySelector(".explainer-plot-curve"),originalCurve);
    f.click("play");f.advance(1100);f.click("play");f.click("ask");
    const dot=f.root.querySelector(".explainer-plot-dot")!,x=dot.getAttribute("cx");assert.equal(x,"158");f.advance(800);assert.equal(dot.getAttribute("cx"),x);assert.equal(f.selections.at(-1)!.value.anchor.scene_id,"start:5");
  }finally{f.player.pauseAll();f.dom.window.close();}
});
