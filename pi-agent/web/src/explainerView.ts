import {replayExplainer,explainerOpDuration,type ExplainerComponent,type ExplainerAnchor,type ExplainerElementState} from "../../src/explainerTypes";
import type {AnimationViewContext,AnimationClock} from "./animationView";
import {icon} from "./icons";

const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
const mix=(a:number,b:number,p:number)=>a+(b-a)*p;
const NS="http://www.w3.org/2000/svg";
let plotSerial=0;
type VisualState=ExplainerElementState;
export interface ExplainerSelection {component:ExplainerComponent;anchor:ExplainerAnchor;label:string}
interface Playback {
  component:ExplainerComponent;node:HTMLElement;elements:Map<string,HTMLElement>;path:string[];op:number;elapsed:number;
  playing:boolean;done:boolean;frame:number;last:number;seen:Set<string>;width:number;failed:boolean;
}
export function explainerMarkup(component:ExplainerComponent):string {return `<div data-explainer-slot="${escape(component.id)}"></div>`;}

/** 浏览器只播放固定动作协议；脚本中的文字始终作为文字，选择不进入学习账本。 */
export class ExplainerPlayer {
  private readonly players=new Map<string,Playback>();
  private context:AnimationViewContext={sessionId:null,current:false,blocked:false};
  private selectedKey:string|null=null;
  private readonly clock:AnimationClock;
  constructor(private readonly container:HTMLElement,
    private readonly onSelect:(selection:ExplainerSelection,focus:boolean)=>void,
    private readonly onClear:()=>void,private readonly beforePlay:()=>void,clock?:AnimationClock){
    this.clock=clock??{now:()=>performance.now(),frame:callback=>window.requestAnimationFrame(callback),cancel:id=>window.cancelAnimationFrame(id)};
    window.addEventListener("pagehide",()=>this.pauseAll());window.addEventListener("blur",()=>this.pauseAll());
    document.addEventListener("visibilitychange",()=>{if(document.hidden)this.pauseAll();});
  }
  private key(c:ExplainerComponent):string{return `${c.sourceSessionId}:${c.id}:${c.artifact.contentSha256}`;}
  private script(p:Playback){return p.component.artifact.script;}
  private current(p:Playback){return this.script(p).nodes[p.path.at(-1)!]!;}
  private gate(p:Playback):boolean{return p.op===this.current(p).ops.length&&Boolean(this.current(p).ask);}
  private available(p:Playback):boolean{return this.context.current&&p.component.sourceSessionId===this.context.sessionId&&
    p.component.goalId===this.context.goalId&&p.component.taskId===this.context.taskId&&
    (this.context.skillId===undefined||p.component.skillId===this.context.skillId);}
  mount(components:ExplainerComponent[],context:AnimationViewContext):void{
    const changed=this.context.sessionId!==context.sessionId||this.context.goalId!==context.goalId||this.context.taskId!==context.taskId||this.context.skillId!==context.skillId||this.context.current!==context.current;
    this.context=context;if(changed){this.pauseAll();this.clearSelection();}
    const visible=new Set<string>();
    for(const component of components){
      const slot=[...this.container.querySelectorAll<HTMLElement>("[data-explainer-slot]")].find(n=>n.dataset.explainerSlot===component.id);if(!slot)continue;
      const key=this.key(component);visible.add(key);let p=this.players.get(key);
      if(!p){p=this.create(component);this.players.set(key,p);}slot.replaceWith(p.node);this.update(p);
    }
    for(const[key,p]of this.players)if(!visible.has(key))this.pause(p);
    if(this.selectedKey&&!visible.has(this.selectedKey))this.clearSelection();if(context.blocked)this.pauseAll();
  }
  sync(context:AnimationViewContext):void{
    const changed=this.context.sessionId!==context.sessionId||this.context.goalId!==context.goalId||this.context.taskId!==context.taskId||this.context.skillId!==context.skillId||this.context.current!==context.current;
    this.context=context;if(changed){this.pauseAll();this.clearSelection();}else if(context.blocked)this.pauseAll();for(const p of this.players.values())this.update(p);
  }
  pauseAll():void{for(const p of this.players.values())this.pause(p);}
  clearSelection():void{if(this.selectedKey!==null){this.selectedKey=null;this.onClear();}}
  locate(id:string):void{for(const p of this.players.values())if(p.component.id===id&&p.node.isConnected){p.node.scrollIntoView({block:"center"});p.node.querySelector<HTMLButtonElement>('[data-explainer-action="ask"]')?.focus({preventScroll:true});return;}}
  private reduced():boolean{return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);}
  private pause(p:Playback):void{p.playing=false;this.clock.cancel(p.frame);this.update(p);}
  private select(p:Playback,focus:boolean):void{
    this.pause(p);if(!this.available(p)||this.context.blocked||this.context.askBlocked||p.failed)return;
    this.selectedKey=this.key(p.component);
    const op=this.current(p).ops[p.op],elapsed=op?(this.reduced()?explainerOpDuration(op):p.elapsed):0;
    this.onSelect({component:p.component,anchor:{presentation_id:p.component.id,source_entry_id:p.component.entryId,
      artifact_sha256:p.component.artifact.contentSha256,scene_id:`${p.path.at(-1)}:${p.op}`,scene_elapsed_ms:elapsed,selected_object_id:null,
      explainer_path:[...p.path]},label:`${this.script(p).title} · ${this.current(p).label||"当前步骤"}`},focus);
  }
  private create(component:ExplainerComponent):Playback{
    const node=document.createElement("section");node.className="teaching-explainer";node.dataset.explainerId=component.id;
    node.innerHTML='<h3 class="explainer-title"></h3><p class="explainer-subtitle"></p><div class="explainer-fit"><div class="explainer-extent"><div class="explainer-stage" role="img"></div></div></div><p class="explainer-caption" aria-live="polite"></p><div class="explainer-question" hidden><p></p><div class="explainer-options"></div></div><div class="explainer-controls"><button type="button" class="explainer-play" data-explainer-action="play"></button><button type="button" data-explainer-action="next">下一句</button><button type="button" data-explainer-action="replay">重播</button><button type="button" data-explainer-action="ask">问这一步</button></div><p class="explainer-status" role="status"></p><details class="explainer-branches"><summary>分支路径</summary><div class="explainer-map"></div></details>';
    const script=component.artifact.script,p:Playback={component,node,elements:new Map(),path:[script.start],op:0,elapsed:0,playing:false,done:false,frame:0,last:0,seen:new Set([script.start]),width:640,failed:false};
    node.querySelector(".explainer-title")!.textContent=script.title;
    node.querySelector(".explainer-subtitle")!.textContent=script.subtitle??"";
    node.addEventListener("click",event=>{
      const button=(event.target as Element).closest<HTMLButtonElement>("[data-explainer-action]");if(!button||button.disabled)return;
      if(button.dataset.explainerAction==="ask")this.select(p,true);
      else if(button.dataset.explainerAction==="play"){if(p.playing)this.pause(p);else {if(p.done)this.reset(p);this.start(p);}}
      else if(button.dataset.explainerAction==="next"){this.clearSelection();this.pause(p);this.nextSentence(p);}
      else if(button.dataset.explainerAction==="replay"){this.clearSelection();this.pause(p);this.reset(p);this.start(p);}
    });
    if(typeof ResizeObserver!=="undefined")new ResizeObserver(entries=>{p.width=Math.max(1,entries[0]!.contentRect.width);this.fit(p);}).observe(node.querySelector(".explainer-fit")!);
    this.update(p);return p;
  }
  private reset(p:Playback):void{p.path=[this.script(p).start];p.op=0;p.elapsed=0;p.done=false;p.seen.add(this.script(p).start);this.update(p);}
  private advance(p:Playback):boolean{
    if(p.op<this.current(p).ops.length){p.op++;p.elapsed=0;}
    if(p.op<this.current(p).ops.length)return true;
    const node=this.current(p);
    if(node.ask){this.pause(p);return false;}
    if(node.end){p.done=true;this.pause(p);return false;}
    if(node.next){p.path.push(node.next);p.seen.add(node.next);p.op=0;p.elapsed=0;return true;}
    p.failed=true;this.pause(p);return false;
  }
  private nextSentence(p:Playback):void{
    if(this.context.blocked||p.done||this.gate(p)||p.failed)return;
    // 跳过本句时仍执行之间的确定性动作，但绝不穿过尚未回答的提问。
    for(let guard=0;guard<700;guard++){
      if(!this.advance(p)){this.update(p);return;}
      if(this.current(p).ops[p.op]?.[0]==="say"){this.update(p);return;}
    }
    p.failed=true;this.pause(p);
  }
  private start(p:Playback):void{
    if(this.context.blocked||this.gate(p)||p.failed)return;
    this.clearSelection();this.pauseAll();this.beforePlay();p.playing=true;p.last=this.clock.now();this.update(p);
    const tick=(now:number)=>{
      if(!p.playing)return;let remaining=Math.min(120,Math.max(0,now-p.last));p.last=now;
      for(let guard=0;guard<700;guard++){
        const op=this.current(p).ops[p.op];if(!op){if(!this.advance(p))return;continue;}
        const duration=explainerOpDuration(op),left=Math.max(0,duration-p.elapsed),used=Math.min(left,remaining);
        p.elapsed+=used;remaining-=used;
        if(p.elapsed>=duration){if(!this.advance(p))return;if(remaining>0||explainerOpDuration(this.current(p).ops[p.op]??["wait",0])===0)continue;}
        break;
      }
      this.update(p);p.frame=this.clock.frame(tick);
    };
    p.frame=this.clock.frame(tick);
  }
  private update(p:Playback):void{
    const q=<T extends Element>(selector:string)=>p.node.querySelector<T>(selector)!;
    const play=q<HTMLButtonElement>('[data-explainer-action="play"]'),label=p.playing?"暂停":p.done?"再看一次":p.path.length===1&&p.op===0&&p.elapsed===0?"开始看":"继续看";
    // rAF期间不能反复替换鼠标按下的文字节点，否则抬起时click会丢失，导致步骤中无法暂停。
    if(play.dataset.label!==label){play.dataset.label=label;play.innerHTML=`${icon(p.playing?"stop":"play")}<span>${label}</span>`;}
    play.disabled=this.context.blocked||this.gate(p)||p.failed;play.setAttribute("aria-pressed",String(p.playing));
    q<HTMLButtonElement>('[data-explainer-action="next"]').disabled=this.context.blocked||this.gate(p)||p.done||p.failed;
    q<HTMLButtonElement>('[data-explainer-action="replay"]').disabled=this.context.blocked||p.failed;
    q<HTMLButtonElement>('[data-explainer-action="ask"]').disabled=this.context.blocked||Boolean(this.context.askBlocked)||!this.available(p)||p.failed;
    q(".explainer-status").textContent=p.failed?"这段演示暂时无法播放。":!this.available(p)?"回看这段演示；回到当前课堂后可继续提问。":p.done?"演示已结束，可以重播并换一个选择。":"";
    const ask=q<HTMLElement>(".explainer-question"),key=this.gate(p)?p.path.join(">"):"none";ask.hidden=!this.gate(p);
    if(ask.dataset.state!==key){ask.dataset.state=key;q(".explainer-question > p").textContent=this.current(p).ask?.q??"";const options=q<HTMLElement>(".explainer-options");options.replaceChildren();
      if(this.gate(p))for(const option of this.current(p).ask!.opts){const b=document.createElement("button");b.type="button";b.textContent=option.t;
        b.onclick=()=>{if(this.context.blocked)return;this.clearSelection();p.path.push(option.go);p.seen.add(option.go);p.op=0;p.elapsed=0;this.start(p);};options.append(b);}
    }
    for(const button of ask.querySelectorAll<HTMLButtonElement>("button"))button.disabled=this.context.blocked;
    this.draw(p);this.map(p);
  }
  private fit(p:Playback):void{
    const canvas=this.script(p).canvas??{w:640,h:296},stage=p.node.querySelector<HTMLElement>(".explainer-stage")!,fit=p.node.querySelector<HTMLElement>(".explainer-fit")!;
    const scale=Math.min(1,p.width/canvas.w),extent=p.node.querySelector<HTMLElement>(".explainer-extent")!;
    // 文字增长只扩展可见画布，不移动对象或改写面积图。极端长文保留滚动阅读，不能在原canvas底部裁掉。
    let bottom=canvas.h;for(const element of p.elements.values())if(Number(element.style.opacity)>0){const end=parseFloat(element.style.top)+element.offsetHeight;if(end>bottom)bottom=end;}
    const height=bottom>canvas.h?Math.ceil(bottom+8):canvas.h;
    stage.style.width=canvas.w+"px";stage.style.height=height+"px";stage.style.transform=`scale(${scale})`;
    extent.style.height=height*scale+"px";fit.style.height=Math.min(height,960)*scale+"px";fit.style.overflowY=height>960?"auto":"hidden";
    fit.dataset.expanded=String(height>canvas.h);fit.dataset.scrollable=String(height>960);
  }
  private draw(p:Playback):void{
    try{
      const op=this.current(p).ops[p.op],elapsed=op&&this.reduced()?explainerOpDuration(op):p.elapsed;
      const frame=replayExplainer(this.script(p),p.path,p.op,elapsed),stage=p.node.querySelector<HTMLElement>(".explainer-stage")!;
      const caption=p.node.querySelector(".explainer-caption")!;if(caption.textContent!==frame.caption)caption.textContent=frame.caption;stage.setAttribute("aria-label",this.script(p).title+"。"+frame.caption);
      const progress=frame.transitionProgress;
      for(const [id,target]of Object.entries(frame.targetState.elements)){
        const previous=frame.previousState.elements[id]??target;let element=p.elements.get(id);
        if(!element){element=document.createElement("div");element.className=`explainer-element ex-${target.k}`;element.dataset.explainerElement=id;element.setAttribute("aria-hidden","true");p.elements.set(id,element);stage.append(element);}
        const alpha=previous.visible===target.visible?(target.visible?1:0):target.visible?progress:1-progress;
        const kind=String(target.k);
        element.style.opacity=String(alpha);element.style.left=mix(previous.x,target.x,progress)+"px";element.style.top=mix(previous.y,target.y,progress)-(kind==="arrow"?2:kind==="line"?1:0)+"px";
        element.style.setProperty("--ex-rotation",mix(previous.rotation,target.rotation,progress)+"deg");
        element.style.transform=`rotate(${mix(previous.rotation,target.rotation,progress)}deg)`;
        if(frame.operation?.[0]==="show"&&(frame.operation[1]===id||frame.operation[1]==="*")&&!previous.visible&&!this.reduced())element.style.transform+=` translateY(${6*(1-progress)}px) scale(${.96+.04*progress})`;
        if(frame.operation?.[1]===id&&frame.operation[0]==="shake"&&!this.reduced())element.style.transform+=` translateX(${Math.sin(progress*Math.PI*8)*7*(1-progress)}px)`;
        element.classList.toggle("ex-highlight",frame.operation?.[0]==="flash"&&frame.operation[1]===id&&progress>0&&progress<1);
        this.content(element,target,previous,frame.operation,progress,(this.script(p).canvas?.w??640)-target.x);
        // 新格子生长与动作使用同一时间，暂停提问时不会继续播放独立的CSS动画。
        if(frame.operation?.[0]==="push"&&frame.operation[1]===id&&!this.reduced()){
          const cell=element.lastElementChild as HTMLElement|null,growth=progress;
          if(cell){cell.style.transform=`scale(${.3+.7*growth})`;cell.style.opacity=String(growth);}
        }
      }
      this.fit(p);
    }catch{p.failed=true;p.playing=false;this.clock.cancel(p.frame);for(const button of p.node.querySelectorAll<HTMLButtonElement>("button"))button.disabled=true;p.node.querySelector(".explainer-status")!.textContent="这段演示暂时无法播放。";}
  }
  private mark(element:Element,state:VisualState,index="all"):void{
    const mark=state.marks?.[index]??state.marks?.all;
    element.classList.toggle("ex-hot",mark==="hot");element.classList.toggle("ex-done",mark==="done");
  }
  private content(element:HTMLElement,state:VisualState,previous:VisualState,operation:readonly unknown[]|null,progress:number,available:number):void{
    const kind=String(state.k),line=kind==="arrow"||kind==="line";
    element.style.width=(line?state.len:state.w)!==undefined?String(line?state.len:state.w)+"px":"";
    element.style.maxWidth=line?"":Math.max(20,available)+"px";
    element.style.height=state.h===undefined?"":state.h+"px";element.style.fontSize=state.size===undefined?"":state.size+"px";
    element.classList.toggle("ex-good",state.tone==="good");element.classList.toggle("ex-bad",state.tone==="bad");this.mark(element,state);
    if(kind==="cells"){
      const swapping=operation?.[0]==="swap"&&operation[1]===state.id;
      const texts=swapping&&progress<420/620?previous.cells:state.cells,key=JSON.stringify(texts);
      if(element.dataset.cells!==key){element.dataset.cells=key;element.replaceChildren();for(const text of texts){const cell=document.createElement("span");cell.className="explainer-cell";const copy=document.createElement("span");copy.className="explainer-copy";copy.textContent=text;cell.append(copy);element.append(cell);}}
      const width=Math.max(28,Math.min(56,((state.w??available)-Math.max(0,texts.length-1)*6)/Math.max(1,texts.length)));
      [...element.children].forEach((child,i)=>{const cell=child as HTMLElement;cell.style.width=width+"px";cell.style.height=Math.min(56,width)+"px";cell.style.transform="";cell.style.opacity="";this.mark(cell,state,String(i));
        if(swapping&&progress<420/620){const a=operation![2] as number,b=operation![3] as number;const distance=(width+6)*(b-a)*Math.min(1,progress/(420/620));if(i===a)cell.style.transform=`translateX(${distance}px)`;if(i===b)cell.style.transform=`translateX(${-distance}px)`;}
        this.fitCopy(cell,Math.min(20,width*.4));});
    }else if(kind==="bars")this.bars(element,state,previous,operation,progress);
    else if(kind==="table"||kind==="lines")this.rows(element,state,previous,operation,progress);
    else if(kind==="plot")this.plot(element,state,previous,operation,progress);
    else if(!line){
      const text=(kind==="note"?(state.tone==="good"?"✓ ":state.tone==="bad"?"✕ ":""):"")+state.text;
      let copy=element.querySelector<HTMLElement>(":scope > .explainer-copy");
      if(!copy){copy=document.createElement("span");copy.className="explainer-copy";element.replaceChildren(copy);}
      if(copy.textContent!==text)copy.textContent=text;
      this.fitCopy(element,state.size);
    }
  }
  /** 模型给出的是布局建议。实际字体度量兜底，不能把长中文裁在固定边框外。 */
  private fitCopy(element:HTMLElement,preferred?:number):void{
    const copy=element.querySelector<HTMLElement>(":scope > .explainer-copy");if(!copy||!element.clientWidth)return;
    const css=window.getComputedStyle(element),width=element.clientWidth-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight),height=element.clientHeight-parseFloat(css.paddingTop)-parseFloat(css.paddingBottom);
    const requested=preferred??parseFloat(css.fontSize),key=[copy.textContent,width,height,requested].join("|");if(element.dataset.fit===key){if(element.dataset.grown==="true")element.style.height="auto";return;}
    element.dataset.fit=key;let size=requested;copy.style.fontSize=size+"px";
    for(;size>12&&(copy.scrollWidth>width+.5||height>0&&copy.scrollHeight>height+.5);size--)copy.style.fontSize=Math.max(12,size-1)+"px";
    // 极端窄框保留可读下限，边框随文字生长；普通可容纳内容仍严格保持作者尺寸。
    element.dataset.grown=String(height>0&&copy.scrollHeight>height+.5);if(element.dataset.grown==="true"){element.style.minHeight=element.style.height;element.style.height="auto";}
    copy.dataset.fittedSize=copy.style.fontSize;
  }
  private bars(element:HTMLElement,state:VisualState,previous:VisualState,operation:readonly unknown[]|null,progress:number):void{
    const values=state.values??[],key=JSON.stringify(state.labels??[])+"|"+values.length;
    if(element.dataset.content!==key){element.dataset.content=key;element.replaceChildren();values.forEach((_v,i)=>{const column=document.createElement("div");column.className="explainer-bar-column";column.innerHTML='<span class="explainer-bar-value"></span><div class="explainer-bar-fill"></div><span class="explainer-bar-label"></span>';column.querySelector(".explainer-bar-label")!.textContent=state.labels?.[i]??"";element.append(column);});}
    const max=Math.max(1,state.max??Math.max(0,...values));[...element.children].forEach((child,i)=>{
      const column=child as HTMLElement,fill=column.querySelector<HTMLElement>(".explainer-bar-fill")!,changing=operation?.[0]==="bar"&&operation[1]===state.id&&operation[2]===i;
      const value=changing?mix(previous.values?.[i]??0,values[i]!,progress):values[i]!,height=Math.max(0,value)/max*100;fill.style.height=height+"%";fill.style.visibility=value>0?"visible":"hidden";const label=column.querySelector<HTMLElement>(".explainer-bar-value")!;label.textContent=Number(value.toPrecision(4)).toString();label.style.bottom=`calc(${height}% + 4px)`;this.mark(fill,state,String(i));
    });
  }
  private rows(element:HTMLElement,state:VisualState,previous:VisualState,operation:readonly unknown[]|null,progress:number):void{
    const table=String(state.k)==="table",rows=table?state.table??[]:(state.lines??[]).map(line=>[line]),key=JSON.stringify(rows);
    if(element.dataset.content!==key){element.dataset.content=key;element.replaceChildren();rows.forEach((texts,i)=>{
      const row=document.createElement("div");row.className=table?"explainer-table-row":"explainer-derivation-row";row.dataset.index=String(i);if(table)row.style.gridTemplateColumns=`repeat(${texts.length},minmax(0,1fr))`;
      for(const text of texts){const cell=document.createElement("span");cell.className=table?"explainer-table-cell":"explainer-copy";cell.textContent=text;row.append(cell);}element.append(row);
    });}
    [...element.children].forEach((child,i)=>{const row=child as HTMLElement,was=previous.rows?.[i]??false,is=state.rows?.[i]??false;
      row.style.opacity=String(was===is?(is?1:0):is?progress:1-progress);this.mark(row,state,String(i));if(!table)this.fitCopy(row,17);
    });
  }
  private plot(element:HTMLElement,state:VisualState,previous:VisualState,operation:readonly unknown[]|null,progress:number):void{
    const w=state.w??400,h=state.h??220,xr=state.xr??[0,1],yr=state.yr??[0,1],series=state.series??{},key=JSON.stringify([w,h,xr,yr,state.xl,state.yl,series]);
    const X=(x:number)=>40+(x-xr[0])/(xr[1]-xr[0])*(w-64),Y=(y:number)=>h-36-(y-yr[0])/(yr[1]-yr[0])*(h-54);
    if(element.dataset.content!==key){element.dataset.content=key;element.replaceChildren();const svg=document.createElementNS(NS,"svg");svg.setAttribute("viewBox",`0 0 ${w} ${h}`);svg.setAttribute("width",String(w));svg.setAttribute("height",String(h));
      const clipId="explainer-plot-clip-"+(++plotSerial),defs=document.createElementNS(NS,"defs"),clip=document.createElementNS(NS,"clipPath"),rect=document.createElementNS(NS,"rect");clip.id=clipId;rect.setAttribute("x","34");rect.setAttribute("y","12");rect.setAttribute("width",String(w-52));rect.setAttribute("height",String(h-42));clip.append(rect);defs.append(clip);svg.append(defs);
      const add=(tag:string,attrs:Record<string,string|number>,text?:string)=>{const node=document.createElementNS(NS,tag);for(const[k,v]of Object.entries(attrs))node.setAttribute(k,String(v));if(text!==undefined)node.textContent=text;svg.append(node);return node;};
      add("path",{d:`M40 18V${h-36}H${w-24}`,class:"explainer-plot-axis"});
      for(const[x,y,text,anchor]of [[40,h-17,String(xr[0]),"middle"],[w-24,h-17,String(xr[1]),"end"],[34,h-33,String(yr[0]),"end"],[34,24,String(yr[1]),"end"]] as const)add("text",{x,y,"text-anchor":anchor,class:"explainer-plot-tick"},text);
      if(state.xl)add("text",{x:w/2,y:h-8,"text-anchor":"middle",class:"explainer-plot-tick"},state.xl);if(state.yl)add("text",{x:48,y:14,class:"explainer-plot-tick"},state.yl);
      for(const[name,curve]of Object.entries(series)){const group=document.createElementNS(NS,"g");group.dataset.series=name;const path=document.createElementNS(NS,"polyline");path.setAttribute("points",curve.pts.map(([x,y])=>`${X(x)},${Y(y)}`).join(" "));path.setAttribute("class","explainer-plot-curve");path.setAttribute("pathLength","1");path.setAttribute("clip-path",`url(#${clipId})`);group.append(path);
        const last=curve.pts.at(-1)!,label=document.createElementNS(NS,"text");label.setAttribute("x",String(Math.max(48,Math.min(w-24,X(last[0])-6))));label.setAttribute("y",String(Math.max(15,Math.min(h-44,Y(last[1])-9))));label.setAttribute("text-anchor","end");label.setAttribute("class","explainer-plot-label");label.textContent=curve.lb??name;group.append(label);
        const dot=document.createElementNS(NS,"circle");dot.setAttribute("r","5");dot.setAttribute("class","explainer-plot-dot");dot.setAttribute("clip-path",`url(#${clipId})`);group.append(dot);svg.append(group);
      }element.append(svg);
    }
    for(const[name,curve]of Object.entries(series)){const group=[...element.querySelectorAll<SVGGElement>("g[data-series]")].find(g=>g.dataset.series===name)!,drawing=operation?.[0]==="draw"&&operation[1]===state.id&&operation[2]===name;
      const shown=state.drawn?.includes(name)??false,amount=drawing?progress:shown?1:0;group.querySelector("polyline")!.setAttribute("stroke-dasharray","1");group.querySelector("polyline")!.setAttribute("stroke-dashoffset",String(1-amount));group.querySelector("text")!.setAttribute("opacity",String(amount===1?1:0));
      const dot=group.querySelector("circle")!,dotX=state.dots?.[name];dot.setAttribute("visibility",dotX===undefined?"hidden":"visible");if(dotX!==undefined){const moving=operation?.[0]==="dot"&&operation[1]===state.id&&operation[2]===name,x=moving?mix(previous.dots?.[name]??curve.pts[0]![0],dotX,progress):dotX;
        let i=1;while(i<curve.pts.length-1&&curve.pts[i]![0]<x)i++;const a=curve.pts[i-1]!,b=curve.pts[i]!,ratio=b[0]===a[0]?0:Math.max(0,Math.min(1,(x-a[0])/(b[0]-a[0])));dot.setAttribute("cx",String(X(x)));dot.setAttribute("cy",String(Y(mix(a[1],b[1],ratio))));}
    }
  }
  private map(p:Playback):void{
    const map=p.node.querySelector<HTMLElement>(".explainer-map")!,key=p.path.join(">")+"|"+[...p.seen].join(">");if(map.dataset.state===key)return;map.dataset.state=key;map.replaceChildren();
    const script=this.script(p),depth=new Map<string,number>([[script.start,0]]),queue=[script.start];
    while(queue.length){const id=queue.shift()!,node=script.nodes[id]!,next=node.ask?node.ask.opts.map(option=>option.go):node.next?[node.next]:[];for(const target of next)if(!depth.has(target)){depth.set(target,depth.get(id)!+1);queue.push(target);}}
    for(let level=0;level<=Math.max(...depth.values());level++){const column=document.createElement("div");column.className="explainer-map-column";
      for(const[id,d]of depth)if(d===level){const chip=document.createElement("span");chip.textContent=script.nodes[id]!.label||id;chip.className="explainer-map-node";chip.classList.toggle("is-current",id===p.path.at(-1));chip.classList.toggle("is-seen",p.seen.has(id));column.append(chip);}map.append(column);
    }
  }
}
