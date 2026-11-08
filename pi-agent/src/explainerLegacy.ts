// Frozen v1 protocol for persisted snapshots. New presentations use explainerTypes.
/** JSON-only stage protocol. This module is shared by Node validation and the browser player. */
export type ExplainerKind = "text" | "label" | "code" | "box" | "lane" | "cells" | "arrow" | "icon" | "note";
export interface ExplainerElement {
  id: string; k: ExplainerKind; x: number; y: number; t?: string | string[];
  w?: number; h?: number; len?: number; deg?: number; size?: number; tone?: "info" | "good" | "bad";
}
export type ExplainerOp = ["say",string] | ["show",string] | ["hide",string] | ["push",string,string] |
  ["set",string,string] | ["move",string,number,number] | ["rotate",string,number] |
  ["flash",string] | ["shake",string] | ["wait",number];
export interface ExplainerNode {label: string;ops: ExplainerOp[];next?: string;ask?: {q:string;opts:Array<{t:string;go:string}>};end?: true}
export interface ExplainerScript {title:string;subtitle?:string;canvas?:{w:number;h:number};start:string;stage:ExplainerElement[];nodes:Record<string,ExplainerNode>}
export interface ExplainerStats {sec:number;asks:number;nodes:number;operations:number}
export interface ExplainerArtifact {id:string;version:string;contentSha256:string;skillVersion:string;templateVersion:"explainer-v1";validatorVersion:"explainer-validator-v1";script:ExplainerScript;stats:ExplainerStats;warnings:string[]}
export interface ExplainerPresentation {id:string;sourceSessionId:string;goalId:string;taskId:string;skillId:string;artifact:ExplainerArtifact}
export interface ExplainerComponent extends ExplainerPresentation {entryId:string}
export interface ExplainerAnchor {presentation_id:string;source_entry_id:string;artifact_sha256:string;scene_id:string;scene_elapsed_ms:number;selected_object_id:null;explainer_path?:string[]}
export interface ExplainerElementState {
  id:string;k:ExplainerKind;x:number;y:number;rotation:number;visible:boolean;text:string;cells:string[];
  w?:number;h?:number;len?:number;size?:number;tone?:"info"|"good"|"bad";
}
export interface ExplainerStageState {caption:string;elements:Record<string,ExplainerElementState>}
export interface ExplainerReplay {
  previousState:ExplainerStageState;targetState:ExplainerStageState;transition:boolean;transitionProgress:number;
  caption:string;operation:ExplainerOp|null;nodeId:string;opIndex:number;durationMs:number;
}
export interface ExplainerContext {
  recipe:"explainer";presentationId:string;artifactSha256:string;title:string;target:string;templateVersion:string;skillVersion:string;
  sceneId:string;sceneIndex:number;sceneElapsedMs:number;sceneDurationMs:number;caption:string;why:string;
  parameters:{path:string[];node:string;operationIndex:number};assumptions:string[];scope:{goalId:string;taskId:string;skillId:string};
  previousState:ExplainerStageState;targetState:ExplainerStageState;transition:boolean;transitionProgress:number;
  verifiedStep:Record<string,unknown>;nextVerifiedStep:Record<string,unknown>|null;observation:string;
}

const kinds=new Set<ExplainerKind>(["text","label","code","box","lane","cells","arrow","icon","note"]);
const arity:Record<string,number>={say:2,show:2,hide:2,push:3,set:3,move:4,rotate:3,flash:2,shake:2,wait:2};
const identifier=(v:unknown):v is string=>typeof v==="string"&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v);
const finite=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v);
const validText=(v:unknown,max:number):v is string=>typeof v==="string"&&!!v.trim()&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(v);
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
function fail(message:string):never {throw new Error("讲解脚本校验失败："+message);}
function keys(value:Record<string,unknown>,allowed:string[],label:string):void {
  if(Object.keys(value).some(k=>!allowed.includes(k)))fail(label+"包含未支持字段。");
}
export function explainerSuccessors(node:ExplainerNode):string[] {return node.ask?node.ask.opts.map(option=>option.go):node.next?[node.next]:[];}
export function explainerOpDuration(op:ExplainerOp):number {
  switch(op[0]){case "say":return 1300+65*op[1].length;case "show":return 450;case "hide":return 0;
    case "push":return 650;case "set":return 300;case "move":case "rotate":case "shake":return 700;case "flash":return 900;case "wait":return op[1];}
}

/** 只校验结构与可执行动作；不证明脚本描述的知识、因果或预测答案正确。 */
export function validateExplainerScript(value:unknown):{script:ExplainerScript;stats:ExplainerStats;warnings:string[]} {
  if(!object(value)||JSON.stringify(value).length>64000)fail("脚本必须为不超过64000字符的JSON对象。");
  keys(value,["title","subtitle","canvas","start","stage","nodes"],"脚本");
  if(!validText(value.title,30)||value.subtitle!==undefined&&!validText(value.subtitle,200))fail("标题或副标题无效。");
  const c=value.canvas??{w:640,h:296};
  if(!object(c))fail("画布无效。");keys(c,["w","h"],"画布");
  if(!finite(c.w)||!finite(c.h)||c.w<480||c.w>800||c.h<220||c.h>360)fail("画布宽480–800、高220–360。");
  if(!Array.isArray(value.stage)||!value.stage.length||value.stage.length>14)fail("舞台需1–14个元素。");
  const elements=new Map<string,ExplainerElement>(),warnings:string[]=[];
  for(const raw of value.stage){
    if(!object(raw))fail("舞台元素不是对象。");
    keys(raw,["id","k","x","y","t","w","h","len","deg","size","tone"],"舞台元素");
    if(!identifier(raw.id)||elements.has(raw.id)||!kinds.has(raw.k as ExplainerKind))fail("元素标识重复或类型无效。");
    if(!finite(raw.x)||!finite(raw.y)||raw.x<0||raw.y<0||raw.x>c.w||raw.y>c.h)fail("舞台坐标必须为画布内有限数值。");
    if(raw.k==="cells"){
      if(!Array.isArray(raw.t)||raw.t.length>10||raw.t.some(t=>!validText(t,30)))fail("cells需要最多10个短字符串。");
    }else if(raw.k!=="arrow"&&!validText(raw.t,raw.k==="code"?600:raw.k==="note"?240:80))fail("元素文字为空或过长。");
    else if(raw.k==="arrow"&&raw.t!==undefined)fail("arrow不能携带文字。");
    if(["box","lane"].includes(raw.k as string)&&(!finite(raw.w)||!finite(raw.h)||raw.w<=0||raw.h<=0))fail("容器需要正数w/h。");
    for(const key of ["w","h","len","size"]){
      const n=raw[key];if(n!==undefined&&(!finite(n)||n<=0||n>Math.max(c.w,c.h)))fail("尺寸必须为有限正数。");
    }
    if(raw.w!==undefined&&raw.x+(raw.w as number)>c.w||raw.h!==undefined&&raw.y+(raw.h as number)>c.h)fail("元素尺寸超出画布。");
    if(raw.k==="arrow"&&(!finite(raw.len)||raw.len<=0))fail("arrow需要有限正数len。");
    if(raw.deg!==undefined&&(!finite(raw.deg)||Math.abs(raw.deg)>3600)||raw.size!==undefined&&((raw.size as number)<10||(raw.size as number)>48))fail("角度或字号超出范围。");
    if(raw.tone!==undefined&&(!["info","good","bad"].includes(raw.tone as string)||raw.k!=="note"))fail("tone只用于note。");
    if(raw.k==="code"&&(raw.t as string).split("\n").length>4)fail("代码最多4行。");
    if(typeof raw.t==="string"&&!["code","note"].includes(raw.k as string)&&raw.t.length>12)warnings.push(`元素${raw.id}文字超过12字。`);
    elements.set(raw.id,raw as unknown as ExplainerElement);
  }
  if(!object(value.nodes))fail("nodes需要节点字典。");
  const names=Object.keys(value.nodes);if(!names.length||names.length>14||!identifier(value.start)||!Object.hasOwn(value.nodes,value.start))fail("节点数量或起点无效。");
  const nodes=value.nodes as unknown as Record<string,ExplainerNode>;let ends=0,operations=0;
  for(const name of names){
    const n=nodes[name] as unknown;
    if(!identifier(name)||!object(n))fail("节点名或节点对象无效。");keys(n,["label","ops","next","ask","end"],"节点");
    if(!validText(n.label,20))fail("节点label不能为空或过长。");
    if(n.label.length>6)warnings.push(`节点${name}标签超过6字。`);
    if([n.next!==undefined,n.ask!==undefined,n.end!==undefined].filter(Boolean).length!==1||n.end!==undefined&&n.end!==true)fail("节点必须在next/ask/end三选一。");
    if(n.end===true)ends++;
    if(!Array.isArray(n.ops)||!n.ops.length||n.ops.length>100)fail("每节点需1–100个动作。");
    operations+=n.ops.length;if(operations>400)fail("总动作数超过400。");
    for(const raw of n.ops){
      if(!Array.isArray(raw)||typeof raw[0]!=="string"||!Object.hasOwn(arity,raw[0])||raw.length!==arity[raw[0]])fail("未知动作或参数数量错误。");
      const op=raw[0];
      if(op==="say"){
        if(!validText(raw[1],40))fail("字幕需1–40字。");if(raw[1].length>28)warnings.push(`节点${name}字幕超过28字。`);
      }else if(op==="wait"){
        if(!finite(raw[1])||raw[1]<0||raw[1]>10000)fail("wait需0–10000毫秒的有限数值。");
      }else{
        const element=elements.get(raw[1]);if(!(op==="hide"&&raw[1]==="*")&&!element)fail("动作引用未知元素。");
        if(op==="push"&&(element?.k!=="cells"||!validText(raw[2],30)))fail("push需要cells和短字符串。");
        if(op==="set"&&(!element||["cells","arrow"].includes(element.k)||!validText(raw[2],element.k==="code"?600:element.k==="note"?240:80)))fail("set类型或文字不合法。");
        if(op==="set"&&element?.k==="code"&&(raw[2] as string).split("\n").length>4)fail("改写后的代码最多4行。");
        if(op==="move"&&(!finite(raw[2])||!finite(raw[3])||raw[2]<0||raw[3]<0||raw[2]>c.w||raw[3]>c.h||raw[2]+(element?.w??0)>c.w||raw[3]+(element?.h??0)>c.h))fail("move需要画布内有限坐标与尺寸。");
        if(op==="rotate"&&(element?.k!=="arrow"||!finite(raw[2])||Math.abs(raw[2])>3600))fail("rotate需要arrow和有限角度。");
      }
    }
    if(n.next!==undefined&&!identifier(n.next))fail("next需要合法节点名。");
    if(n.ask!==undefined){
      if(!object(n.ask))fail("ask无效。");keys(n.ask,["q","opts"],"ask");
      if(!validText(n.ask.q,80)||!Array.isArray(n.ask.opts)||n.ask.opts.length<2||n.ask.opts.length>4)fail("问题或选项数量无效。");
      if(n.ask.q.length>20)warnings.push(`节点${name}问题超过20字。`);
      const options=new Set<string>();
      for(const option of n.ask.opts){
        if(!object(option))fail("选项不是对象。");keys(option,["t","go"],"选项");
        if(!validText(option.t,120)||!identifier(option.go)||options.has(option.t))fail("选项文字/目标无效或重复。");options.add(option.t);
        if(option.t.length>24)warnings.push(`节点${name}选项超过24字。`);
      }
      const lens=(n.ask.opts as Array<{t:string}>).map(o=>o.t.length).filter(len=>len>4);
      if(lens.length>1&&Math.max(...lens)>Math.min(...lens)*1.8)warnings.push(`节点${name}选项长度可能暗示答案。`);
    }
    for(const next of explainerSuccessors(n as unknown as ExplainerNode))if(!Object.hasOwn(nodes,next))fail("分支目标不存在。");
  }
  if(ends!==1)fail("必须有且仅有一个end节点。");
  const seen=new Set<string>(),stack=new Set<string>(),memo=new Map<string,{ms:number;asks:number}>();
  const walk=(id:string):{ms:number;asks:number}=>{
    if(stack.has(id))fail("节点存在循环。");
    const saved=memo.get(id);if(saved)return saved;
    seen.add(id);stack.add(id);const node=nodes[id]!;
    const following=explainerSuccessors(node).map(walk);stack.delete(id);
    const result={ms:node.ops.reduce((n,op)=>n+explainerOpDuration(op),0)+Math.max(0,...following.map(n=>n.ms)),asks:(node.ask?1:0)+Math.max(0,...following.map(n=>n.asks))};
    memo.set(id,result);return result;
  };
  const max=walk(value.start);if(seen.size!==names.length)fail("存在从start不可达的节点。");
  if(max.ms>120000||max.asks>3)fail("路径超过120秒或3次提问。");
  if(max.ms>90000)warnings.push("最长路径超过建议的90秒。");if(max.asks>2)warnings.push("提问超过建议的两次。");
  const script=structuredClone(value) as unknown as ExplainerScript;script.canvas={w:c.w,h:c.h};
  // 对所有合法路径验证累积cells与可见元素，分支合流不能隐藏无界增长。
  const checkPath=(id:string,state:ExplainerStageState)=>{
    let next=state;for(const op of nodes[id]!.ops){next=applyExplainerOp(next,op);if(Object.values(next.elements).some(e=>e.cells.length>12))fail("单条路径中cells超过12格。");}
    for(const child of explainerSuccessors(nodes[id]!))checkPath(child,next);
  };
  checkPath(script.start,initialExplainerState(script));
  return {script,stats:{sec:Math.round(max.ms/1000),asks:max.asks,nodes:names.length,operations},warnings:[...new Set(warnings)]};
}

export function initialExplainerState(script:ExplainerScript):ExplainerStageState {
  const elements:Record<string,ExplainerElementState>={};
  for(const e of script.stage)elements[e.id]={id:e.id,k:e.k,x:e.x,y:e.y,rotation:e.deg??0,visible:false,text:typeof e.t==="string"?e.t:"",cells:Array.isArray(e.t)?[...e.t]:[],
    ...(e.w===undefined?{}:{w:e.w}),...(e.h===undefined?{}:{h:e.h}),...(e.len===undefined?{}:{len:e.len}),...(e.size===undefined?{}:{size:e.size}),...(e.tone===undefined?{}:{tone:e.tone})};
  return {caption:"",elements};
}
export function applyExplainerOp(state:ExplainerStageState,op:ExplainerOp):ExplainerStageState {
  const next=structuredClone(state);
  switch(op[0]){
    case "say":next.caption=op[1];break;
    case "show":next.elements[op[1]]!.visible=true;break;
    case "hide":for(const e of op[1]==="*"?Object.values(next.elements):[next.elements[op[1]]!])e.visible=false;break;
    case "push":next.elements[op[1]]!.cells.push(op[2]);break;
    case "set":next.elements[op[1]]!.text=op[2];break;
    case "move":next.elements[op[1]]!.x=op[2];next.elements[op[1]]!.y=op[3];break;
    case "rotate":next.elements[op[1]]!.rotation=op[2];break;
  }
  return next;
}

/** 服务端及浏览器共用路径回放，客户端仅报告路径和动作时间，不提供舞台事实。 */
export function replayExplainer(script:ExplainerScript,path:string[],opIndex:number,elapsedMs:number):ExplainerReplay {
  if(!Array.isArray(path)||!path.length||path.length>14||path[0]!==script.start||new Set(path).size!==path.length)fail("播放路径无效。");
  let state=initialExplainerState(script);
  for(let i=0;i<path.length;i++){
    const id=path[i]!,node=Object.hasOwn(script.nodes,id)?script.nodes[id]:undefined;if(!node)fail("路径含未知节点。");
    if(i<path.length-1){if(!explainerSuccessors(node).includes(path[i+1]!))fail("播放路径跨越了不存在的分支。");for(const op of node.ops)state=applyExplainerOp(state,op);}
  }
  const nodeId=path.at(-1)!,node=script.nodes[nodeId]!;
  if(!Number.isInteger(opIndex)||opIndex<0||opIndex>node.ops.length||!finite(elapsedMs)||elapsedMs<0)fail("播放动作位置无效。");
  for(let i=0;i<opIndex;i++)state=applyExplainerOp(state,node.ops[i]!);
  const op=node.ops[opIndex]??null,durationMs=op?explainerOpDuration(op):0;
  if(elapsedMs>durationMs)fail("动作时间超出范围。");
  const targetState=op?applyExplainerOp(state,op):structuredClone(state),moving=!!op&&["show","hide","push","move","rotate","flash","shake"].includes(op[0]);
  return {previousState:state,targetState,transition:moving&&elapsedMs<durationMs,transitionProgress:durationMs?elapsedMs/durationMs:1,caption:targetState.caption,operation:op,nodeId,opIndex,durationMs};
}
