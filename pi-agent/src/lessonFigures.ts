import {renderMarkdown} from "../web/src/markdown.js";
import {createHash,randomUUID} from "node:crypto";
import {defineTool} from "@earendil-works/pi-coding-agent";
import {Type} from "typebox";
import {prepareFigure,TICKS,figureKey,formatValue,type InkFigure,type InkFrame} from "../skills/lawa-illustrated-lesson/assets/ink.mjs";
import {fetchLearningOverview,type LearningOverviewToolOptions} from "./learningOverviewTool.js";
import type {TeachingSessionContext} from "./teachingSession.js";
import type {GoalOnboardingContext} from "./planning/goalOnboarding.js";

export type {FigureScope,FigureBatch,PlacedFigure,FigureAnchor,FigureQuestion} from "./lessonFigureTypes.js";
import type {FigureScope,FigureBatch,PlacedFigure,FigureAnchor,FigureQuestion,LessonFigure,PaintedFigure} from "./lessonFigureTypes.js";
import {BOOK_IMAGE_MODEL,validateBrief,type LessonArtwork} from "./lessonArtwork.js";
export const FIGURE_TOOL = "prepare_lesson_figures";
function digest(value:unknown):string {return createHash("sha256").update(JSON.stringify(value)).digest("hex");}
const verified = new Map<string,FigureBatch>();
function validId(value:unknown):value is string {return typeof value==="string" && value.length>0 && value.length<=200;}
function savedFigure(value:unknown):LessonFigure {
  if (value && typeof value==="object" && "art" in value) {
    const f=value as PaintedFigure;
    if (Object.keys(f).sort().join(",")!=="alt,art,caption,key,source" || !f.art || Object.keys(f.art).sort().join(",")!=="id,model" ||
        !/^[a-f0-9]{64}$/.test(f.art.id) || f.art.model!==BOOK_IMAGE_MODEL || f.source!=="百炼生成插画") throw new Error("插画来源无效。");
    validateBrief({key:f.key,alt:f.alt,caption:f.caption,paint:"已保存的书页插画"});
    return structuredClone(f);
  }
  return prepareFigure(value).figure;
}
function figuresOf(input:unknown):LessonFigure[] {
  if (!Array.isArray(input) || input.length<1 || input.length>4) throw new Error("一批需要 1–4 幅插画。");
  const figures = input.map(savedFigure);
  if (new Set(figures.map(f=>f.key)).size!==figures.length) throw new Error("每幅插画需要不同的 key。");
  return figures;
}
export function createFigureBatch(input:unknown,scope:FigureScope):FigureBatch {
  const payload = {version:1 as const,id:randomUUID(),...scope,figures:figuresOf(input)};
  return {...payload,digest:digest(payload)};
}
/** 只接受受信工具结果中的本版画稿。历史正文中的图址本身不能加载文件或创建插画。 */
export function readFigureBatch(raw:unknown):FigureBatch|null {
  if (!raw || typeof raw!=="object") return null;
  const b=raw as FigureBatch;
  if (b.version!==1 || ![b.id,b.sessionId,b.goalId,b.taskId,b.skillId].every(validId) ||
      typeof b.digest!=="string" || !Array.isArray(b.figures) || !b.figures.length || b.figures.length>4) return null;
  try {
    const payload={version:b.version,id:b.id,sessionId:b.sessionId,goalId:b.goalId,taskId:b.taskId,skillId:b.skillId,figures:b.figures};
    if (JSON.stringify(payload).length>82000 || digest(payload)!==b.digest) return null;
    const cached=verified.get(b.digest);
    if (cached) return cached;
    const batch={...payload,figures:figuresOf(b.figures),digest:b.digest};
    if (verified.size>=32) verified.delete(verified.keys().next().value!);
    verified.set(b.digest,batch);
    return batch;
  } catch {return null;}
}
export function placedFigures(b:FigureBatch):PlacedFigure[] {
  return b.figures.map(figure=>({batchId:b.id,sessionId:b.sessionId,goalId:b.goalId,taskId:b.taskId,skillId:b.skillId,figure}));
}
// 与课堂共用 Markdown 分块，代码围栏、引文或数学公式里的字面图址不能成为已发表插图。
export function referencedFigures(text:string,available:PlacedFigure[]):PlacedFigure[] {
  if (!available.length || !text.includes("lawa-figure:")) return [];
  const keys=new Set<string>();
  renderMarkdown(text,line=>{const key=figureKey(line);if (key) keys.add(key);return undefined;});
  return available.filter(item=>keys.has(item.figure.key));
}
/** 停在预测时不能拿尚未播放的目标坐标解释当前画面。只读当前有墨迹的笔画及尚未展开的线头。 */
function predictionParts(figure:InkFigure,frame:InkFrame):FigureQuestion["movingMarks"] {
  return frame.marks.flatMap((mark,index)=>{
    const {tag,attrs}=mark, id=figure.ink[index]?.[1].id;
    if (typeof id!=="string" || Number(attrs.opacity??1)<=0 || attrs.fill==="none" && attrs.stroke==="none") return [];
    const offset=String(attrs.transform??"").match(/^translate\(([^ ]+) ([^)]+)\)$/);
    const dx=Number(offset?.[1]??0),dy=Number(offset?.[2]??0);
    const values:Record<string,number>={};
    for (const k of ["x","cx","x1","x2"]) if (typeof attrs[k]==="number") values[k]=Number(attrs[k])+dx;
    for (const k of ["y","cy","y1","y2"]) if (typeof attrs[k]==="number") values[k]=Number(attrs[k])+dy;
    for (const k of ["r","rx","ry","width","height"]) if (typeof attrs[k]==="number") values[k]=Number(attrs[k]);
    if (!Object.keys(values).length) return [];
    const part:FigureQuestion["movingMarks"][number]={index,id,shape:tag,values};
    if (mark.label) part.label=mark.label;
    if (tag==="line") part.extent=values.x1===values.x2 && values.y1===values.y2?"point":"segment";
    return [part];
  });
}
export function resolveFigureQuestion(input:unknown,messages:ReadonlyArray<{role:string;entryId?:string;figures?:PlacedFigure[]}>,scope:FigureScope,
    isArtworkReady?:(assetId:string)=>boolean):FigureQuestion {
  if (!input || typeof input!=="object" || !["batchId,key,messageId,tick","batchId,key,messageId,prediction,tick"].includes(Object.keys(input).sort().join(","))) throw new Error("插画位置无效。");
  const a=input as FigureAnchor;
  if (![a.messageId,a.batchId,a.key].every(validId) || !Number.isInteger(a.tick) || a.tick<0) throw new Error("插画位置无效。");
  const message=messages.find(m=>m.role==="assistant" && m.entryId===a.messageId);
  const item=message?.figures?.find(f=>f.batchId===a.batchId && f.figure.key===a.key);
  if (!item || item.sessionId!==scope.sessionId || item.goalId!==scope.goalId || item.taskId!==scope.taskId || item.skillId!==scope.skillId)
    throw new Error("请回到这幅插画所属的当前课堂提问。");
  const {figure}=item;
  if (a.prediction!==undefined && (!("prediction" in figure) || !figure.prediction || !validId(a.prediction))) throw new Error("预测位置无效。");
  if ("art" in figure) {
    if (a.tick!==0) throw new Error("书页插图没有时间位置。");
    if (!isArtworkReady?.(figure.art.id)) throw new Error("插画尚未完成，暂时无法定位到成图。");
    return {anchor:{...a},alt:figure.alt,caption:figure.caption,source:figure.source,
      generated:{model:figure.art.model,basis:"description_and_caption"},movingMarks:[],omittedMarks:0,readings:[]};
  }
  const drawing=prepareFigure(figure);
  const frame=drawing.at(a.tick,a.prediction);
  // 浏览器只提交位置。当前字幕、尚未结束的动作与目标坐标都以原稿为准。
  if (frame.moment) {
    const {changes,...moment}=frame.moment;
    const parts=moment.prediction?predictionParts(figure,frame):[];
    return {anchor:{...a},alt:figure.alt,caption:figure.caption,...(figure.source?{source:figure.source}:{}),
      motion:{...moment,changes:changes.slice(0,24),omittedChanges:Math.max(0,changes.length-24)},
      movingMarks:parts.slice(0,16),omittedMarks:Math.max(0,parts.length-16),readings:[]};
  }
  // 助教读取与这张图同一时刻的实际几何值，浏览器只提供位置。
  const changing=figure.ink.flatMap(([shape,attrs],index)=>{
    const values:Record<string,number>={};
    for (const [name,term] of Object.entries(attrs)) if (typeof term==="string" && term.startsWith("="))
      values[name]=Number(frame.marks[index]!.attrs[name]);
    return Object.keys(values).length?[{index,shape,values}]:[];
  });
  const readings=frame.readings.map((reading,index)=>{
    const formula=figure.axis!.readings![index]!.expr;
    const substituted=formula.replace(/\bx\b/g,"("+formatValue(frame.x)+")");
    return {...reading,formula,calculation:substituted+" ≈ "+formatValue(reading.value)};
  });
  return {anchor:{...a},movingMarks:changing.slice(0,16),omittedMarks:Math.max(0,changing.length-16),alt:figure.alt,caption:figure.caption,...(figure.source?{source:figure.source}:{}),
    ...(figure.axis?{variable:{label:figure.axis.label,value:frame.x,unit:figure.axis.unit??""},
      endpoints:[0,TICKS].map(tick=>{const {x,readings}=drawing.at(tick);return {x,readings};})}:{}),readings};
}
export function createLessonFigureTool(context:TeachingSessionContext,planning:GoalOnboardingContext,options:LearningOverviewToolOptions,surface:"WEB"|"CLI",artwork?:LessonArtwork,turnId?:()=>string|undefined) {
  return defineTool({name:FIGURE_TOOL,label:"绘制文中插画",
    description:"制作正文中的讲解动画或书页插图。跟着讲解看一个过程时传 require_motion=true，figures 中用 motion 写每段的字幕和运动。画插图用 paint，读者自行调条件用 axis。按返回的图址放进正文。",
    parameters:Type.Object({figures:Type.Array(Type.Unknown(),{minItems:1,maxItems:4}),require_motion:Type.Optional(Type.Boolean({description:"需要一次播放即可看完整段讲解时设为 true"})),
      require_prediction:Type.Optional(Type.Boolean({description:"明确要先猜且能跳过时设为 true"})),
      keep_preparing:Type.Optional(Type.Boolean({description:"动画保存后仍需要继续其他课堂工具时设为 true"}))}),
    execute:async (_call,args,signal)=>{
      if (surface!=="WEB" || !["IDLE","INITIALIZED"].includes(planning.snapshot().status)) throw new Error("请在已开始的网页课堂中配图。");
      const overview=await fetchLearningOverview(options,signal);
      const goal=overview.goal_profile as {id?:string}|null,task=overview.active_task as {id?:string;status?:string;related_skill_ids?:string[]}|null;
      if (!goal?.id || !task?.id || task.status!=="ACTIVE" || !task.related_skill_ids?.length) throw new Error("先开始当前学习任务，再准备插画。");
      const active=context.snapshot().active_skill_id;
      const scope={sessionId:context.getSessionId(),goalId:goal.id,taskId:task.id,
        skillId:active && task.related_skill_ids.includes(active)?active:task.related_skill_ids[0]!};
      // 先校验整批再委托生图，后面的错误画稿不能导致一次无效的付费调用。
      const plans=args.figures.map(f=>f && typeof f==="object" && "paint" in f?validateBrief(f):prepareFigure(f).figure);
      const predicted=plans.filter(p=>"prediction" in p && p.prediction);
      if (predicted.length>1 || args.require_prediction && !predicted.length) throw new Error("一批只安排一个可跳过的预测点，请按 references/prediction.md 填写 prediction。");
      if (args.require_motion && !plans.some(p=>"motion" in p && p.motion)) throw new Error("此次需要讲解动画。请按 references/motion.md 填写随时间运动的对象和分段字幕。");
      if (new Set(plans.map(p=>p.key)).size!==plans.length || plans.filter(p=>"paint" in p).length>1)
        throw new Error("图址需要各不相同，每轮最多委托一幅百炼插画。");
      const prepared:LessonFigure[]=[];
      for (const plan of plans) {
        if ("paint" in plan) {
          if (!artwork) throw new Error("此课堂尚未配置百炼生图。");
          prepared.push(await artwork.request(scope,turnId?.()??"",plan));
        } else prepared.push(plan);
      }
      const batch=createFigureBatch(prepared,scope);
      const streamAfterMotion=!args.keep_preparing && prepared.some(f=>"motion" in f && f.motion);
      return {content:[{type:"text" as const,text:JSON.stringify({status:"REFERENCES_READY",background_painting:prepared.some(f=>"art" in f),
        displays:prepared.map(f=>({key:f.key,kind:"art" in f?"百炼书籍插画":f.motion?"讲解动画":f.axis?"可调示意图":"静态插图",...("prediction" in f && f.prediction?{prediction:f.prediction.prompt}:{})})),references:batch.figures.map(f=>"!["+f.alt.replace(/[[\]]/g,"")+"](lawa-figure:"+f.key+")"),
        ...(predicted.length?{teaching:"前文只给观察线索，预测出来以前留住结果。选择或直接继续都在播放器本地完成，不记作评分。"}:{}),
        next:streamAfterMotion?"本批动画保存后按宿主返回的课堂阶段继续。公开讲解时直接写正文并在观察位置放入图址。":"完成必要的教学操作后调用 begin_teacher_reply，再将图址放在相关正文段落之间。"})}],details:{lessonFigures:batch,streamAfterMotion}};
    }});
}
