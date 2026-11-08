import { animationTransitionProgress, type AnimationAnchor, type AnimationComponent } from "../../src/animationTypes";
import { icon } from "./icons";

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
const fmt = (n: number) => Number(n.toPrecision(5)).toString();
type Scene = {id: string;caption: string;why: string;duration_s: number;state: Record<string, unknown>};
type Lesson = {title: string;recipe: string;scenes: Scene[];checkpoint: {after_scene: string;options: Array<{id: string;value: number}>;branches:{correct:{replay_scene:string};incorrect:{replay_scene:string}}}};

export interface AnimationSelection {component: AnimationComponent;anchor: AnimationAnchor;label: string}
export interface AnimationViewContext {sessionId: string | null;current: boolean;blocked: boolean;askBlocked?: boolean;goalId?: string | null;taskId?: string | null;skillId?:string|null}
interface Playback {component: AnimationComponent;node: HTMLElement;scene: number;elapsed: number;playing: boolean;gate: boolean;answered: boolean;feedback: "correct" | "incorrect" | null;frame: number;last: number;width: number}
export interface AnimationClock {now(): number;frame(callback: FrameRequestCallback): number;cancel(id: number): void}

export function animationMarkup(component: AnimationComponent): string {
  return `<div data-animation-slot="${escape(component.id)}"></div>`;
}

/** 播放实例属于当前浏览器；消息重绘只重挂原节点，不根据教师token重置时间轴。 */
export class AnimationPlayer {
  private readonly players=new Map<string,Playback>();
  private context: AnimationViewContext={sessionId:null,current:false,blocked:false};
  private selectedKey: string | null=null;
  private readonly clock: AnimationClock;
  constructor(private readonly container: HTMLElement,
              private readonly onSelect: (selection: AnimationSelection, focus: boolean) => void,
              private readonly onClear: () => void,
              private readonly beforePlay: () => void,
              clock?: AnimationClock) {
    this.clock=clock ?? {now:()=>performance.now(),frame:callback=>window.requestAnimationFrame(callback),cancel:id=>window.cancelAnimationFrame(id)};
    window.addEventListener("pagehide",()=>this.pauseAll());
    window.addEventListener("blur",()=>this.pauseAll());
    document.addEventListener("visibilitychange",()=>{if(document.hidden)this.pauseAll();});
  }
  private key(c: AnimationComponent): string {return `${c.sourceSessionId}:${c.id}:${c.artifact.contentSha256}`;}
  private lesson(p: Playback): Lesson {return p.component.artifact.lesson as unknown as Lesson;}
  private scene(p: Playback): Scene {return this.lesson(p).scenes[p.scene]!;}
  private available(p: Playback): boolean {return this.context.current && p.component.sourceSessionId===this.context.sessionId && p.component.goalId===this.context.goalId && p.component.taskId===this.context.taskId && (this.context.skillId===undefined||p.component.skillId===this.context.skillId);}
  mount(components: AnimationComponent[],context: AnimationViewContext): void {
    const changed=this.context.sessionId!==context.sessionId || this.context.goalId!==context.goalId || this.context.taskId!==context.taskId || this.context.skillId!==context.skillId || this.context.current!==context.current;
    this.context=context;
    if(changed){this.pauseAll();this.clearSelection();}
    const visible=new Set<string>();
    for(const c of components){
      const slot=[...this.container.querySelectorAll<HTMLElement>("[data-animation-slot]")].find(n=>n.dataset.animationSlot===c.id);
      if(!slot)continue;
      const key=this.key(c);visible.add(key);let p=this.players.get(key);
      if(!p){p=this.create(c);this.players.set(key,p);}
      slot.replaceWith(p.node);this.update(p);
    }
    for(const [key,p]of this.players)if(!visible.has(key))this.pause(p);
    if(this.selectedKey && !visible.has(this.selectedKey))this.clearSelection();
    if(context.blocked) this.pauseAll();
  }
  sync(context: AnimationViewContext): void {this.context=context;if(context.blocked)this.pauseAll();for(const p of this.players.values())this.update(p);}
  pauseAll(): void {for(const p of this.players.values())this.pause(p);}
  clearSelection(): void {if(this.selectedKey!==null){this.selectedKey=null;this.onClear();}}
  locate(id: string): void {for(const p of this.players.values())if(p.component.id===id&&p.node.isConnected){p.node.scrollIntoView({block:"center"});p.node.querySelector<HTMLButtonElement>("[data-animation-action=ask]")?.focus({preventScroll:true});return;}}
  private pause(p: Playback): void {p.playing=false;this.clock.cancel(p.frame);this.update(p);}
  private select(p: Playback,focus: boolean): void {
    this.pause(p);if(!this.available(p)||this.context.blocked||this.context.askBlocked)return;
    this.selectedKey=this.key(p.component);
    // 减少动态效果直接显示稳定终态，发送的语义锚点也必须表示该终态。
    const visibleElapsed=window.matchMedia?.("(prefers-reduced-motion: reduce)").matches&&p.scene>0?Math.max(2000,Math.round(p.elapsed*1000)):Math.round(p.elapsed*1000);
    this.onSelect({component:p.component,anchor:{presentation_id:p.component.id,source_entry_id:p.component.entryId,artifact_sha256:p.component.artifact.contentSha256,scene_id:this.scene(p).id,scene_elapsed_ms:visibleElapsed,selected_object_id:null},label:`${this.lesson(p).title} · 第${p.scene+1}幕`},focus);
  }
  private create(component: AnimationComponent): Playback {
    const node=document.createElement("section");node.className="teaching-animation";node.dataset.animationId=component.id;
    node.innerHTML=`<h3 class="animation-title"></h3><svg class="animation-stage" role="img"></svg><p class="animation-caption" aria-live="polite"></p><div class="animation-checkpoint" hidden><p class="animation-prompt"></p><div class="animation-options"></div><p class="animation-feedback" role="status"></p></div><div class="animation-controls"><button type="button" class="animation-play" data-animation-action="play"></button><button type="button" data-animation-action="previous">上一幕</button><button type="button" data-animation-action="next">下一幕</button><button type="button" data-animation-action="ask">问这一步</button><span class="animation-step"></span></div><p class="animation-status" role="status"></p>`;
    const p: Playback={component,node,scene:0,elapsed:0,playing:false,gate:false,answered:false,feedback:null,frame:0,last:0,width:640};
    node.querySelector<HTMLElement>(".animation-title")!.textContent=this.lesson(p).title;
    node.addEventListener("click",event=>{
      const button=(event.target as Element).closest<HTMLButtonElement>("[data-animation-action]");if(!button||button.disabled)return;
      const action=button.dataset.animationAction;
      if(action==="ask")this.select(p,true);
      else if(action==="play"){
        if(p.playing){this.pause(p);return;}
        this.clearSelection();
        if(p.gate&&p.feedback){p.scene=this.lesson(p).scenes.findIndex(s=>s.id===this.lesson(p).checkpoint.branches[p.feedback!].replay_scene);p.elapsed=0;p.gate=false;p.feedback=null;}
        else if(p.scene===this.lesson(p).scenes.length-1&&p.elapsed>=this.scene(p).duration_s){p.scene=0;p.elapsed=0;p.gate=false;p.answered=false;p.feedback=null;}
        else if(p.elapsed>=this.scene(p).duration_s&&!this.next(p,false))return;
        this.start(p);
      }else if(action==="next"){this.clearSelection();this.pause(p);if(p.gate&&p.feedback){p.scene=this.lesson(p).scenes.findIndex(s=>s.id===this.lesson(p).checkpoint.branches[p.feedback!].replay_scene);p.gate=false;p.feedback=null;p.elapsed=this.scene(p).duration_s;this.update(p);}else this.next(p,true);}
      else if(action==="previous"){this.clearSelection();this.pause(p);p.scene=Math.max(0,p.scene-1);p.elapsed=this.scene(p).duration_s;p.gate=false;p.feedback=null;this.update(p);}
    });
    if(typeof ResizeObserver!=="undefined")new ResizeObserver(entries=>{p.width=Math.max(280,entries[0]!.contentRect.width);this.draw(p);}).observe(node.querySelector("svg")!);
    this.update(p);return p;
  }
  private boundary(p: Playback): boolean {
    if(!p.answered&&this.scene(p).id===this.lesson(p).checkpoint.after_scene){p.gate=true;this.pause(p);return true;}return false;
  }
  private next(p: Playback,settled: boolean): boolean {
    if(this.boundary(p))return false;
    if(p.scene>=this.lesson(p).scenes.length-1){p.elapsed=this.scene(p).duration_s;this.pause(p);return false;}
    p.scene++;p.elapsed=settled?this.scene(p).duration_s:0;this.update(p);return true;
  }
  private start(p: Playback): void {
    if(this.context.blocked||p.gate)return;
    this.clearSelection();
    this.pauseAll();this.beforePlay();p.playing=true;p.last=this.clock.now();this.update(p);
    const tick=(now: number)=>{
      if(!p.playing)return;p.elapsed+=Math.min(.12,Math.max(0,(now-p.last)/1000));p.last=now;
      if(p.elapsed>=this.scene(p).duration_s){p.elapsed=this.scene(p).duration_s;if(!this.next(p,false))return;}
      this.draw(p);p.frame=this.clock.frame(tick);
    };
    p.frame=this.clock.frame(tick);
  }
  private update(p: Playback): void {
    const q=<T extends Element>(s: string)=>p.node.querySelector<T>(s)!;
    q(".animation-caption").textContent=this.scene(p).caption;q(".animation-step").textContent=`${p.scene+1} / ${this.lesson(p).scenes.length} 幕`;
    const play=q<HTMLButtonElement>("[data-animation-action=play]");const label=p.playing?"暂停":p.gate&&p.feedback?"继续看":p.scene===this.lesson(p).scenes.length-1&&p.elapsed>=this.scene(p).duration_s?"再看一次":p.scene===0&&p.elapsed===0?"开始看":"继续看";
    // 保持按下目标跨帧稳定，鼠标在动画中按住再松开也能可靠暂停。
    if(play.dataset.label!==label){play.dataset.label=label;play.innerHTML=`${icon(p.playing?"stop":"play")}<span>${label}</span>`;}
    play.disabled=this.context.blocked||p.gate&&!p.feedback;play.setAttribute("aria-pressed",String(p.playing));
    q<HTMLButtonElement>("[data-animation-action=previous]").disabled=this.context.blocked||p.scene===0;
    q<HTMLButtonElement>("[data-animation-action=next]").disabled=this.context.blocked||p.gate&&!p.feedback||p.scene===this.lesson(p).scenes.length-1;
    q<HTMLButtonElement>("[data-animation-action=ask]").disabled=this.context.blocked||Boolean(this.context.askBlocked)||!this.available(p);
    q(".animation-status").textContent=!this.available(p)?"回看这段演示；回到当前课堂后可继续提问。":"";
    q<HTMLElement>(".animation-checkpoint").hidden=!p.gate;q(".animation-prompt").textContent=p.component.artifact.validation.canonicalQuestion;
    const options=q<HTMLElement>(".animation-options"),optionsKey=`${p.gate}:${p.feedback}`;
    // 课堂快照只更新可操作性，不能在学习者用键盘选择时替换焦点所在的选项。
    if(options.dataset.state!==optionsKey){options.dataset.state=optionsKey;options.replaceChildren();
    if(p.gate&&!p.feedback){
      for(const option of this.lesson(p).checkpoint.options){const b=document.createElement("button");b.type="button";b.textContent=fmt(option.value);b.disabled=this.context.blocked;b.onclick=()=>{p.answered=true;p.feedback=option.id===p.component.artifact.validation.correctOptionId?"correct":"incorrect";this.update(p);};options.append(b);}
      const skip=document.createElement("button");skip.type="button";skip.textContent="先看演示";skip.disabled=this.context.blocked;skip.onclick=()=>{p.answered=true;p.gate=false;this.next(p,false);this.start(p);};options.append(skip);
    }
    }
    for(const b of options.querySelectorAll<HTMLButtonElement>("button"))b.disabled=this.context.blocked;
    q(".animation-feedback").textContent=p.feedback?`${p.feedback==="correct"?"预测一致。":"这次预测与计算结果不同。"}这个量的结果是 ${fmt(p.component.artifact.validation.expected)}，继续看它怎样得到。`:"";
    this.draw(p);
  }
  private draw(p: Playback): void {
    const svg=p.node.querySelector<SVGSVGElement>(".animation-stage")!;svg.replaceChildren();svg.setAttribute("viewBox",`0 0 ${p.width} 330`);svg.setAttribute("aria-label",this.scene(p).caption);
    const state=this.scene(p).state,prev=p.scene?this.lesson(p).scenes[p.scene-1]!.state:null;
    const progress=window.matchMedia?.("(prefers-reduced-motion: reduce)").matches?1:animationTransitionProgress(p.scene,p.elapsed*1000);
    const add=(tag: string,attrs: Record<string,string|number>,text?: string)=>{const e=document.createElementNS("http://www.w3.org/2000/svg",tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,String(v));if(text!==undefined)e.textContent=text;svg.append(e);return e;};
    const text=(x:number,y:number,value:string,size=15,anchor="start",color="var(--text-primary)")=>add("text",{x,y,"text-anchor":anchor,"font-size":size,fill:color},value);
    const rect=(x:number,y:number,w:number,h:number,fill:string)=>add("rect",{x,y,width:Math.max(0,w),height:h,rx:5,fill});
    if(this.lesson(p).recipe==="call_stack"){
      const frames=state.frames as number[],old=(prev?.frames??[])as number[],w=Math.min(p.width-56,420),x=(p.width-w)/2,top=34;
      text(x,20,"调用现场",13);text(x+w,20,state.phase==="call"?"向内调用":"逐层返回",13,"end");rect(x,top,w,34,"var(--accent-soft)");text(x+12,top+23,"外部调用者");
      const all=[...new Set([...old,...frames])];all.forEach((n,i)=>{
        const live=frames.includes(n),was=old.includes(n),opacity=live?(was||p.scene===0?1:progress):1-progress,dy=live?(was?0:-22*(1-progress)):-28*progress,y=top+(i+1)*39+dy,active=live&&n===frames.at(-1);
        rect(x+12,y,w-12,33,active?"var(--accent)":"var(--accent-soft)").setAttribute("opacity",String(opacity));text(x+24,y+22,`factorial(${n})`,15,"start",active?"var(--surface)":"var(--text-primary)").setAttribute("opacity",String(opacity));
        if(active&&state.return_value!==null)text(x+w-12,y+22,`结果 ${state.return_value}`,14,"end","var(--surface)").setAttribute("opacity",String(opacity));
      });
      if(state.phase==="done"){rect(x+12,top+39,w-12,50,"var(--accent)");text(p.width/2,top+71,`收到返回值 ${state.return_value}`,20,"middle","var(--surface)");}
      text(p.width/2,310,state.phase==="call"?"每一层保留自己的 n，等待内层结果":state.phase==="base"?"基例得到 1，准备交回上一层":state.phase==="done"?"所有调用已结束":"上一层收到结果，完成自己的乘法",p.width<460?12:14,"middle");
    }else if(this.lesson(p).recipe==="linear_balance"){
      const eq=state.equation as number[],old=(prev?.equation??eq)as number[],cx=p.width/2,span=p.width*.27,pan=206;
      const expr=(a:number,b:number)=>{const v=a===0?"":a===1?"x":a===-1?"−x":fmt(a)+"x";return v+(b===0?v?"":"0":v?(b>0?" + ":" − ")+fmt(Math.abs(b)):fmt(b));};
      text(cx,42,`${expr(eq[0]!,eq[1]!)} = ${expr(eq[2]!,eq[3]!)}`,24,"middle");add("path",{d:`M ${cx-22} 279 L ${cx} 104 L ${cx+22} 279 Z`,fill:"var(--accent-soft)"});add("line",{x1:cx-span,y1:116,x2:cx+span,y2:116,stroke:"var(--accent)","stroke-width":4,"stroke-linecap":"round"});
      for(let side=0;side<2;side++){
        const center=cx+(side?span:-span),plate=Math.min(93,p.width*.2),a=eq[side*2]!,b=eq[side*2+1]!,oa=old[side*2]!,ob=old[side*2+1]!;
        add("path",{d:`M ${center} 116 L ${center-plate} ${pan} M ${center} 116 L ${center+plate} ${pan}`,fill:"none",stroke:"var(--text-secondary)","stroke-width":1});add("path",{d:`M ${center-plate} ${pan} Q ${center} ${pan+23} ${center+plate} ${pan}`,fill:"var(--accent-soft)",stroke:"var(--accent)","stroke-width":2});
        if([a,b,oa,ob].every(Number.isInteger)&&Math.min(a,b,oa,ob)>=0&&Math.max(a,oa)<=3&&Math.max(b,ob)<=16){
          const count=Math.max(a,oa),units=Math.max(b,ob),r=Math.min(7,p.width/80),bw=Math.min(24,p.width/17),bs=count?count*(bw+3)-3:0,us=units?(Math.min(4,units)-1)*r*2.4+2*r:0,gap=count&&units?9:0,start=center-(bs+gap+us)/2;
          for(let j=0;j<count;j++){const live=j<a,dy=live?0:-45*progress,op=live?1:1-progress;rect(start+j*(bw+3),pan-34+dy,bw,29,"var(--accent)").setAttribute("opacity",String(op));text(start+j*(bw+3)+bw/2,pan-14+dy,"x",17,"middle","var(--surface)").setAttribute("opacity",String(op));}
          for(let j=0;j<units;j++){const live=j<b;add("circle",{cx:start+bs+gap+r+(j%4)*r*2.4,cy:pan-r-5-Math.floor(j/4)*r*2.25-(live?0:45*progress),r,fill:"var(--accent)",opacity:live?.65:.65*(1-progress)});}
        }else text(center,pan-24,expr(a,b),19,"middle");
      }
      text(cx,307,state.operation==="subtract"?`两边同时减去 ${state.operand}`:state.operation==="divide"?`两边同时除以 ${state.operand}`:"两边相等，关系保持",14,"middle");
    }else text(p.width/2,160,"这段演示暂时无法播放",16,"middle");
  }
}
