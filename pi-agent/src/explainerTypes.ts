import {sampleExplainerExpression} from "./explainerExpression.js";

/** Node与Browser共用的有限JSON舞台协议；模型不能提交可执行代码。 */
export type ExplainerKind = "text" | "label" | "code" | "box" | "lane" | "node" | "cells" | "bars" | "table" | "lines" | "plot" | "arrow" | "line" | "icon" | "note";
export type ExplainerRange=[number,number];
export interface ExplainerSeries {pts?:Array<[number,number]>;fn?:string;x?:ExplainerRange;n?:number;lb?:string}
export interface ExplainerElement {
  id:string;k:ExplainerKind;x:number;y:number;t?:string|string[]|number[]|string[][];
  w?:number;h?:number;len?:number;deg?:number;x2?:number;y2?:number;size?:number;tone?:"info"|"good"|"bad";
  max?:number;lb?:string[];series?:Record<string,ExplainerSeries>;xr?:ExplainerRange;yr?:ExplainerRange;xl?:string;yl?:string;
}
export type ExplainerOp = ["say",string]|["show",string]|["hide",string]|["push",string,string]|["set",string,string]|
  ["move",string,number,number]|["rotate",string,number]|["flash",string]|["shake",string]|["wait",number]|
  ["mark",string,number|number[]|"all","hot"|"done"|"off"]|["swap",string,number,number]|["bar",string,number,number]|
  ["row",string,number]|["draw",string,string]|["dot",string,string,number];
export interface ExplainerNode {label:string;ops:ExplainerOp[];next?:string;ask?:{q:string;opts:Array<{t:string;go:string}>};end?:true}
export interface ExplainerScript {title:string;subtitle?:string;canvas?:{w:number;h:number};start:string;stage:ExplainerElement[];nodes:Record<string,ExplainerNode>}
export interface ExplainerStats {sec:number;asks:number;nodes:number;operations:number}
export interface ExplainerArtifact {id:string;version:string;contentSha256:string;skillVersion:string;templateVersion:"explainer-v1"|"explainer-v2";validatorVersion:"explainer-validator-v1"|"explainer-validator-v2";script:ExplainerScript;stats:ExplainerStats;warnings:string[]}
export interface ExplainerPresentation {id:string;sourceSessionId:string;goalId:string;taskId:string;skillId:string;artifact:ExplainerArtifact}
export interface ExplainerComponent extends ExplainerPresentation {entryId:string}
export interface ExplainerAnchor {presentation_id:string;source_entry_id:string;artifact_sha256:string;scene_id:string;scene_elapsed_ms:number;selected_object_id:null;explainer_path?:string[]}
export interface ExplainerElementState {
  id:string;k:ExplainerKind;x:number;y:number;rotation:number;visible:boolean;text:string;cells:string[];
  w?:number;h?:number;len?:number;size?:number;tone?:"info"|"good"|"bad";
  marks?:Record<string,"hot"|"done">;values?:number[];labels?:string[];rows?:boolean[];lines?:string[];table?:string[][];
  series?:Record<string,{pts:Array<[number,number]>;lb?:string}>;drawn?:string[];dots?:Record<string,number>;
  xr?:ExplainerRange;yr?:ExplainerRange;xl?:string;yl?:string;max?:number;
}
export interface ExplainerStageState {caption:string;elements:Record<string,ExplainerElementState>}
export interface ExplainerReplay {previousState:ExplainerStageState;targetState:ExplainerStageState;transition:boolean;transitionProgress:number;caption:string;operation:ExplainerOp|null;nodeId:string;opIndex:number;durationMs:number}
export interface ExplainerContext {
  recipe:"explainer";presentationId:string;artifactSha256:string;title:string;target:string;templateVersion:string;skillVersion:string;
  sceneId:string;sceneIndex:number;sceneElapsedMs:number;sceneDurationMs:number;caption:string;why:string;
  parameters:{path:string[];node:string;operationIndex:number};assumptions:string[];scope:{goalId:string;taskId:string;skillId:string};
  previousState:ExplainerStageState;targetState:ExplainerStageState;transition:boolean;transitionProgress:number;
  verifiedStep:Record<string,unknown>;nextVerifiedStep:Record<string,unknown>|null;observation:string;
}
const kinds=new Set<ExplainerKind>(["text","label","code","box","lane","node","cells","bars","table","lines","plot","arrow","line","icon","note"]);
const arity:Record<string,number>={say:2,show:2,hide:2,push:3,set:3,move:4,rotate:3,flash:2,shake:2,wait:2,mark:4,swap:4,bar:4,row:3,draw:3,dot:4};
const noSet=new Set<ExplainerKind>(["cells","bars","table","lines","plot","arrow","line"]);
const identifier=(v:unknown):v is string=>typeof v==="string"&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v);
const finite=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v);
const validText=(v:unknown,max:number,empty=false):v is string=>typeof v==="string"&&(empty||!!v.trim())&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(v);
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const range=(v:unknown):v is ExplainerRange=>Array.isArray(v)&&v.length===2&&v.every(finite)&&v[0]!<v[1]!&&v.every(n=>Math.abs(n)<=1e12);
function fail(message:string):never{throw new Error("讲解脚本校验失败："+message);}
function keys(value:Record<string,unknown>,allowed:string[],label:string):void{if(Object.keys(value).some(k=>!allowed.includes(k)))fail(label+"包含未支持字段。");}
export function explainerSuccessors(node:ExplainerNode):string[]{return node.ask?node.ask.opts.map(o=>o.go):node.next?[node.next]:[];}
export function explainerOpDuration(op:ExplainerOp):number{
  switch(op[0]){case "say":return 1300+65*op[1].length;case "show":return 450;case "hide":return 0;case "push":return 650;case "set":return 300;
    case "move":case "rotate":case "shake":return 700;case "flash":case "dot":return 900;case "mark":case "row":return 500;case "swap":return 620;case "bar":return 800;case "draw":return 1300;case "wait":return op[1];}
}
function textLayoutWarning(element:ExplainerElement,text:string,warnings:string[]):void{
  if(!element.w||!["box","node","note","lane"].includes(element.k))return;
  const units=[...text].reduce((n,c)=>n+(/[\u0000-\u00ff]/.test(c)?0.6:1),0),font=element.size??(element.k==="box"?16:14),width=Math.max(1,element.w-20);
  const lines=Math.ceil(units*font/width),height=element.h??40;
  if(font>24&&text.length>8||lines*font*1.35>height-12)warnings.push(`元素${element.id}文字可能挤出边框：缩短标签、增加尺寸，长解释改字幕；不要用大字号硬塞。`);
}
function elementPoints(raw:Record<string,unknown>):void{
  if(!object(raw.series))fail("plot需要series字典。");
  const entries=Object.entries(raw.series);if(!entries.length||entries.length>2)fail("plot需1–2条曲线。");
  const all:Array<[number,number]>=[];
  for(const [name,entry]of entries){
    if(!/^[\p{L}][\p{L}\p{N}_-]{0,39}$/u.test(name)||!object(entry))fail("曲线名或内容无效。");
    keys(entry,["fn","pts","x","n","lb"],"曲线");
    if(entry.lb!==undefined&&!validText(entry.lb,30))fail("曲线标签无效。");
    if((entry.fn!==undefined)===(entry.pts!==undefined))fail("每条曲线fn与pts需二选一。");
    if(entry.fn!==undefined){
      if(!validText(entry.fn,160))fail("fn需要有限数学表达式。");
      const domain=entry.x??raw.xr??[0,1],count=entry.n??41;
      if(!range(domain)||!Number.isInteger(count)||Number(count)<2||Number(count)>129)fail("fn采样范围或数量无效（2–129）。");
      try{entry.pts=sampleExplainerExpression(entry.fn,domain,Number(count));}catch(error){fail(error instanceof Error?error.message:"fn表达式无效。");}
      delete entry.fn;delete entry.x;delete entry.n;
    }else if(entry.x!==undefined||entry.n!==undefined)fail("pts曲线不接受fn采样参数。");
    const points=entry.pts;
    if(!Array.isArray(points)||points.length<2||points.length>129||points.some(p=>!Array.isArray(p)||p.length!==2||!p.every(finite)||p.some(n=>Math.abs(n)>1e12)))fail("曲线需要2–129个有限坐标点。");
    for(let i=1;i<points.length;i++)if(points[i]![0]<=points[i-1]![0])fail("曲线x坐标必须严格递增。");
    all.push(...points as Array<[number,number]>);
  }
  if(raw.xr===undefined)raw.xr=[Math.min(...all.map(p=>p[0])),Math.max(...all.map(p=>p[0]))];
  if(raw.yr===undefined){const low=Math.min(0,...all.map(p=>p[1])),high=Math.max(0,...all.map(p=>p[1]));raw.yr=[low,high+(high-low||1)*.05];}
  if(!range(raw.xr)||!range(raw.yr))fail("plot范围必须递增且有限。");
  for(const p of all)if(p[0]<raw.xr[0]||p[0]>raw.xr[1]||p[1]<raw.yr[0]||p[1]>raw.yr[1])fail("曲线坐标超出声明的plot范围。");
}

/** 只验证结构/类型/资源与可重放动作，不证明知识事实、数学推导或学习效果。 */
export function validateExplainerScript(value:unknown):{script:ExplainerScript;stats:ExplainerStats;warnings:string[]}{
  if(!object(value)||JSON.stringify(value).length>64000)fail("脚本必须为不超过64000字符的JSON对象。");
  const input=structuredClone(value);keys(input,["title","subtitle","canvas","start","stage","nodes"],"脚本");
  if(!validText(input.title,30)||input.subtitle!==undefined&&!validText(input.subtitle,200))fail("标题或副标题无效。");
  const c=input.canvas??{w:640,h:296};if(!object(c))fail("画布无效。");keys(c,["w","h"],"画布");
  if(!finite(c.w)||!finite(c.h)||c.w<480||c.w>800||c.h<220||c.h>360)fail("画布宽480–800、高220–360。");
  if(!Array.isArray(input.stage)||!input.stage.length||input.stage.length>24)fail("舞台需1–24个元素。");
  const elements=new Map<string,ExplainerElement>(),warnings:string[]=[];if(input.stage.length>14)warnings.push("舞台超过建议的14个元素，注意同时可见数量。");
  for(const raw of input.stage){
    if(!object(raw))fail("舞台元素不是对象。");keys(raw,["id","k","x","y","t","w","h","len","deg","x2","y2","size","tone","max","lb","series","xr","yr","xl","yl"],"舞台元素");
    if(!identifier(raw.id)||elements.has(raw.id)||!kinds.has(raw.k as ExplainerKind))fail("元素标识重复或类型无效。");
    if(!finite(raw.x)||!finite(raw.y)||raw.x<0||raw.y<0||raw.x>c.w||raw.y>c.h)fail("舞台坐标必须为画布内有限数值。");
    const kind=raw.k as ExplainerKind;
    if(kind==="node"){raw.w??=44;raw.h??=raw.w;}
    if(kind==="arrow"||kind==="line"){
      if(raw.x2!==undefined||raw.y2!==undefined){
        if(!finite(raw.x2)||!finite(raw.y2)||raw.x2<0||raw.x2>c.w||raw.y2<0||raw.y2>c.h)fail("连线终点必须位于画布内。");
        raw.len=Math.hypot(raw.x2-raw.x,raw.y2-raw.y);raw.deg=Math.atan2(raw.y2-raw.y,raw.x2-raw.x)*180/Math.PI;delete raw.x2;delete raw.y2;
      }
      if(!finite(raw.len)||raw.len<=0)fail("arrow/line需要正数len或有效终点。");
    }else if(raw.x2!==undefined||raw.y2!==undefined)fail("只有arrow/line接受终点。");
    if(["box","lane","bars","plot"].includes(kind)&&(!finite(raw.w)||!finite(raw.h)||raw.w<=0||raw.h<=0))fail("容器需要正数w/h。");
    for(const key of ["w","h","len","size"]){const n=raw[key];if(n!==undefined&&(!finite(n)||n<=0||n>(key==="len"?Math.hypot(c.w,c.h):Math.max(c.w,c.h))))fail("尺寸必须为有限正数。");}
    if(raw.w!==undefined&&raw.x+Number(raw.w)>c.w||raw.h!==undefined&&raw.y+Number(raw.h)>c.h)fail("元素尺寸超出画布。");
    if(raw.deg!==undefined&&(!finite(raw.deg)||Math.abs(raw.deg)>3600)||raw.size!==undefined&&(Number(raw.size)<10||Number(raw.size)>48))fail("角度或字号超出范围。");
    if(raw.tone!==undefined&&(!["info","good","bad"].includes(String(raw.tone))||kind!=="note"))fail("tone只用于note。");
    if(kind==="cells"||kind==="lines"){
      if(!Array.isArray(raw.t)||raw.t.length>(kind==="cells"?10:8)||raw.t.some(t=>!validText(t,kind==="cells"?30:120)))fail(kind+"需要有限短字符串数组。");
    }else if(kind==="bars"){
      if(!Array.isArray(raw.t)||!raw.t.length||raw.t.length>6||raw.t.some(n=>!finite(n)||n<0||n>1e12))fail("bars需要1–6个非负有限数值。");
      if(raw.lb!==undefined&&(!Array.isArray(raw.lb)||raw.lb.length!==raw.t.length||raw.lb.some(t=>!validText(t,30))))fail("bars名称需与柱数一致。");
      if(raw.max===undefined){const later=object(input.nodes)?Object.values(input.nodes).flatMap(n=>object(n)&&Array.isArray(n.ops)?n.ops:[]).filter(o=>Array.isArray(o)&&o[0]==="bar"&&o[1]===raw.id&&finite(o[3])).map(o=>(o as unknown[])[3] as number):[];raw.max=Math.max(1,...raw.t as number[],...later);}
      if(!finite(raw.max)||raw.max<=0||raw.max>1e12||raw.t.some(n=>Number(n)>Number(raw.max)))fail("bars.max需覆盖非负柱值。");
    }else if(kind==="table"){
      if(!Array.isArray(raw.t)||!raw.t.length||raw.t.length>8||!Array.isArray(raw.t[0])||!raw.t[0].length||raw.t[0].length>6||raw.t.some(r=>!Array.isArray(r)||r.length!==(raw.t as unknown[][])[0]!.length||r.some(t=>!validText(t,80,true))))fail("table需要最多8行6列的等长文字表格。");
    }else if(kind==="plot")elementPoints(raw);
    else if(kind==="arrow"||kind==="line"){if(raw.t!==undefined)fail("连线不能携带文字。");}
    else if(!validText(raw.t,kind==="code"?600:kind==="note"?240:80))fail("元素文字为空或过长。");
    if(kind!=="bars"&&(raw.max!==undefined||raw.lb!==undefined))fail("max/lb只用于bars。");
    if(kind!=="plot"&&["series","xr","yr","xl","yl"].some(k=>raw[k]!==undefined))fail("曲线字段只用于plot。");
    for(const key of ["xl","yl"])if(raw[key]!==undefined&&!validText(raw[key],30))fail("坐标轴标签过长。");
    if(kind==="code"&&(raw.t as string).split("\n").length>4)fail("代码最多4行。");
    const e=raw as unknown as ExplainerElement;if(typeof raw.t==="string"){if(!["code","note"].includes(kind)&&raw.t.length>12)warnings.push(`元素${raw.id}文字超过12字。`);textLayoutWarning(e,raw.t,warnings);}
    elements.set(e.id,e);
  }
  if(!object(input.nodes))fail("nodes需要节点字典。");const names=Object.keys(input.nodes);
  if(!names.length||names.length>14||!identifier(input.start)||!Object.hasOwn(input.nodes,input.start))fail("节点数量或起点无效。");
  const nodes=input.nodes as unknown as Record<string,ExplainerNode>;let ends=0,operations=0;
  for(const name of names){
    const n=nodes[name] as unknown;if(!identifier(name)||!object(n))fail("节点名或对象无效。");keys(n,["label","ops","next","ask","end"],"节点");
    if(!validText(n.label,20))fail("节点label不能为空或过长。");if(n.label.length>6)warnings.push(`节点${name}标签超过6字。`);
    if([n.next!==undefined,n.ask!==undefined,n.end!==undefined].filter(Boolean).length!==1||n.end!==undefined&&n.end!==true)fail("节点必须在next/ask/end三选一。");if(n.end===true)ends++;
    if(!Array.isArray(n.ops)||!n.ops.length||n.ops.length>100)fail("每节点需1–100个动作。");operations+=n.ops.length;if(operations>400)fail("总动作数超过400。");
    for(const raw of n.ops){
      if(!Array.isArray(raw)||typeof raw[0]!=="string"||!Object.hasOwn(arity,raw[0])||raw.length!==arity[raw[0]])fail("未知动作或参数数量错误。");
      const op=raw[0];if(op==="say"){if(!validText(raw[1],40))fail("字幕需1–40字。");if(raw[1].length>28)warnings.push(`节点${name}字幕超过28字。`);continue;}
      if(op==="wait"){if(!finite(raw[1])||raw[1]<0||raw[1]>10000)fail("wait需0–10000毫秒的有限数值。");continue;}
      if((op==="show"||op==="hide")&&raw[1]==="*")continue;
      const e=elements.get(raw[1]);if(!e)fail("动作引用未知元素。");
      if(op==="push"&&(e.k!=="cells"||!validText(raw[2],30)))fail("push需要cells和短字符串。");
      if(op==="set"){if(noSet.has(e.k)||!validText(raw[2],e.k==="code"?600:e.k==="note"?240:80))fail("set类型或文字不合法。");if(e.k==="code"&&(raw[2] as string).split("\n").length>4)fail("改写后的代码最多4行。");textLayoutWarning(e,raw[2],warnings);}
      if(op==="move"&&(!finite(raw[2])||!finite(raw[3])||raw[2]<0||raw[3]<0||raw[2]+(e.w??0)>c.w||raw[3]+(e.h??0)>c.h))fail("move需要画布内有限坐标与尺寸。");
      if(op==="rotate"&&(!["arrow","line"].includes(e.k)||!finite(raw[2])||Math.abs(raw[2])>3600))fail("rotate需要连线和有限角度。");
      if(op==="mark"){
        const index=raw[2];if(!["hot","done","off"].includes(raw[3])||index!=="all"&&(!["cells","bars","table","lines"].includes(e.k)||!(Number.isInteger(index)&&index>=0||Array.isArray(index)&&index.length>0&&index.length<=12&&index.every(i=>Number.isInteger(i)&&i>=0))))fail("mark下标或样式无效。");
      }
      if(op==="swap"&&(e.k!=="cells"||![raw[2],raw[3]].every(i=>Number.isInteger(i)&&i>=0&&i<12)))fail("swap需要cells及有效下标。");
      if(op==="bar"&&(e.k!=="bars"||!Number.isInteger(raw[2])||raw[2]<0||!finite(raw[3])||raw[3]<0||raw[3]>(e.max??0)))fail("bar需要有效柱子下标与不超max的非负值。");
      if(op==="row"&&(!["table","lines"].includes(e.k)||!Number.isInteger(raw[2])||raw[2]<0))fail("row需要表格/推导行和下标。");
      if(op==="draw"||op==="dot"){
        if(e.k!=="plot"||typeof raw[2]!=="string"||!e.series||!Object.hasOwn(e.series,raw[2]))fail("曲线不存在。");
        if(op==="dot"){const pts=e.series[raw[2]]!.pts!;if(!finite(raw[3])||raw[3]<pts[0]![0]||raw[3]>pts.at(-1)![0])fail("dot需要曲线采样范围内的有限x。");}
      }
    }
    if(n.next!==undefined&&!identifier(n.next))fail("next需要合法节点名。");
    if(n.ask!==undefined){
      if(!object(n.ask))fail("ask无效。");keys(n.ask,["q","opts"],"ask");if(!validText(n.ask.q,80)||!Array.isArray(n.ask.opts)||n.ask.opts.length<2||n.ask.opts.length>4)fail("问题或选项数量无效。");
      if(n.ask.q.length>20)warnings.push(`节点${name}问题超过20字。`);const options=new Set<string>();
      for(const o of n.ask.opts){if(!object(o))fail("选项不是对象。");keys(o,["t","go"],"选项");if(!validText(o.t,120)||!identifier(o.go)||options.has(o.t))fail("选项文字/目标无效或重复。");options.add(o.t);if(o.t.length>24)warnings.push(`节点${name}选项超过24字。`);}
      const lens=(n.ask.opts as Array<{t:string}>).map(o=>o.t.length).filter(n=>n>4);if(lens.length>1&&Math.max(...lens)>Math.min(...lens)*1.8)warnings.push(`节点${name}选项长度可能暗示答案。`);
    }
    for(const next of explainerSuccessors(n as unknown as ExplainerNode))if(!Object.hasOwn(nodes,next))fail("分支目标不存在。");
  }
  if(ends!==1)fail("必须有且仅有一个end节点。");
  const seen=new Set<string>(),stack=new Set<string>(),memo=new Map<string,{ms:number;asks:number}>();
  const walk=(id:string):{ms:number;asks:number}=>{
    if(stack.has(id))fail("节点存在循环。");const saved=memo.get(id);if(saved)return saved;seen.add(id);stack.add(id);const node=nodes[id]!;
    const children=explainerSuccessors(node).map(walk);stack.delete(id);const result={ms:node.ops.reduce((s,op)=>s+explainerOpDuration(op),0)+Math.max(0,...children.map(n=>n.ms)),asks:(node.ask?1:0)+Math.max(0,...children.map(n=>n.asks))};memo.set(id,result);return result;
  };
  const max=walk(input.start);if(seen.size!==names.length)fail("存在从start不可达的节点。");if(max.ms>120000||max.asks>3)fail("路径超过120秒或3次提问。");
  if(max.ms>90000)warnings.push("最长路径超过建议的90秒。");if(max.asks>2)warnings.push("提问超过建议的两次。");
  const script=input as unknown as ExplainerScript;script.canvas={w:c.w,h:c.h};
  // 校验只追踪各分支的子项数量，避免为每次检查复制整张曲线数据；实际播放仍用完整纯状态回放。
  const counts=Object.fromEntries(script.stage.filter(e=>["cells","bars","table","lines"].includes(e.k)).map(e=>[e.id,(e.t as unknown[]).length]));
  const checkPath=(id:string,before:Record<string,number>)=>{
    const current={...before};for(const op of nodes[id]!.ops){
      if(op[0]==="push"){current[op[1]]!++;if(current[op[1]]!>12)fail("单条路径中cells超过12格。");}
      const indexes=op[0]==="mark"&&op[2]!=="all"?[op[2]].flat():op[0]==="swap"?[op[2],op[3]]:op[0]==="row"||op[0]==="bar"?[op[2]]:[];
      if(indexes.some(i=>i>=current[op[1]]!))fail("动作下标超出当前分支的元素范围。");
    }
    for(const child of new Set(explainerSuccessors(nodes[id]!)))checkPath(child,current);
  };
  checkPath(script.start,counts);if(JSON.stringify(script).length>64000)fail("采样后脚本超过64000字符。");
  return {script,stats:{sec:Math.round(max.ms/1000),asks:max.asks,nodes:names.length,operations},warnings:[...new Set(warnings)]};
}
export function initialExplainerState(script:ExplainerScript):ExplainerStageState{
  const elements:Record<string,ExplainerElementState>={};
  for(const e of script.stage){
    const state:ExplainerElementState={id:e.id,k:e.k,x:e.x,y:e.y,rotation:e.deg??0,visible:false,text:typeof e.t==="string"?e.t:"",cells:e.k==="cells"?structuredClone(e.t as string[]):[],
      ...(e.w===undefined?{}:{w:e.w}),...(e.h===undefined?{}:{h:e.h}),...(e.len===undefined?{}:{len:e.len}),...(e.size===undefined?{}:{size:e.size}),...(e.tone===undefined?{}:{tone:e.tone})};
    if(e.k==="bars"){state.values=structuredClone(e.t as number[]);state.labels=e.lb?structuredClone(e.lb):state.values.map((_,i)=>String(i+1));state.max=e.max??Math.max(1,...state.values);}
    if(e.k==="lines"){state.lines=structuredClone(e.t as string[]);state.rows=state.lines.map(()=>false);}
    if(e.k==="table"){state.table=structuredClone(e.t as string[][]);state.rows=state.table.map(()=>false);}
    if(e.k==="plot"){state.series=structuredClone(e.series) as ExplainerElementState["series"];state.drawn=[];state.dots={};state.xr=e.xr?structuredClone(e.xr):undefined;state.yr=e.yr?structuredClone(e.yr):undefined;state.xl=e.xl;state.yl=e.yl;}
    elements[e.id]=state;
  }
  return {caption:"",elements};
}
function itemCount(e:ExplainerElementState):number|null{return e.k==="cells"?e.cells.length:e.values?.length??e.rows?.length??null;}
function requireIndex(e:ExplainerElementState,index:number):void{const count=itemCount(e);if(count===null||!Number.isInteger(index)||index<0||index>=count)fail("动作下标超出当前分支的元素范围。");}
export function applyExplainerOp(state:ExplainerStageState,op:ExplainerOp):ExplainerStageState{
  const next=structuredClone(state),e=next.elements[op[1]];
  switch(op[0]){
    case "say":next.caption=op[1];break;
    case "show":case "hide":for(const item of op[1]==="*"?Object.values(next.elements):[e!])item.visible=op[0]==="show";break;
    case "push":e!.cells.push(op[2]);if(e!.cells.length>12)fail("单条路径中cells超过12格。");break;
    case "set":e!.text=op[2];break;case "move":e!.x=op[2];e!.y=op[3];break;case "rotate":e!.rotation=op[2];break;
    case "mark":{
      e!.marks??={};const count=itemCount(e!),indexes=op[2]==="all"?(count===null?["all"]:Array.from({length:count},(_,i)=>String(i))):[op[2]].flat().map(i=>{requireIndex(e!,i as number);return String(i);});
      for(const index of indexes)if(op[3]==="off")delete e!.marks[index];else e!.marks[index]=op[3];break;
    }
    case "swap":requireIndex(e!,op[2]);requireIndex(e!,op[3]);[e!.cells[op[2]],e!.cells[op[3]]]=[e!.cells[op[3]]!,e!.cells[op[2]]!];break;
    case "bar":requireIndex(e!,op[2]);e!.values![op[2]]=op[3];break;
    case "row":requireIndex(e!,op[2]);e!.rows![op[2]]=true;break;
    case "draw":if(!e!.drawn!.includes(op[2]))e!.drawn!.push(op[2]);break;
    case "dot":e!.dots![op[2]]=op[3];break;
  }
  return next;
}
/** 服务器按真实合法路径重建前后状态；合流不抹掉学习者走过的分支。 */
export function replayExplainer(script:ExplainerScript,path:string[],opIndex:number,elapsedMs:number):ExplainerReplay{
  if(!Array.isArray(path)||!path.length||path.length>14||path[0]!==script.start||new Set(path).size!==path.length)fail("播放路径无效。");let state=initialExplainerState(script);
  for(let i=0;i<path.length;i++){const id=path[i]!,node=Object.hasOwn(script.nodes,id)?script.nodes[id]:undefined;if(!node)fail("路径含未知节点。");if(i<path.length-1){if(!explainerSuccessors(node).includes(path[i+1]!))fail("播放路径跨越了不存在的分支。");for(const op of node.ops)state=applyExplainerOp(state,op);}}
  const nodeId=path.at(-1)!,node=script.nodes[nodeId]!;if(!Number.isInteger(opIndex)||opIndex<0||opIndex>node.ops.length||!finite(elapsedMs)||elapsedMs<0)fail("播放动作位置无效。");
  for(let i=0;i<opIndex;i++)state=applyExplainerOp(state,node.ops[i]!);const op=node.ops[opIndex]??null,durationMs=op?explainerOpDuration(op):0;if(elapsedMs>durationMs)fail("动作时间超出范围。");
  const targetState=op?applyExplainerOp(state,op):structuredClone(state),moving=!!op&&!["say","set","wait"].includes(op[0]);
  return {previousState:state,targetState,transition:moving&&elapsedMs<durationMs,transitionProgress:durationMs?elapsedMs/durationMs:1,caption:targetState.caption,operation:op,nodeId,opIndex,durationMs};
}
