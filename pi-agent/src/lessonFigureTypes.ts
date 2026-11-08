import type {InkFigure,MotionMoment} from "../skills/lawa-illustrated-lesson/assets/ink.mjs";

export interface FigureScope {sessionId:string;goalId:string;taskId:string;skillId:string}
export interface PaintedFigure {key:string;alt:string;caption:string;source:string;art:{id:string;model:string}}
export type LessonFigure=InkFigure|PaintedFigure;
export interface FigureBatch extends FigureScope {version:1;id:string;figures:LessonFigure[];digest:string}
export interface PlacedFigure extends FigureScope {batchId:string;figure:LessonFigure}
export interface FigureAnchor {messageId:string;batchId:string;key:string;tick:number;prediction?:string}
export interface FigureQuestion {
  anchor:FigureAnchor; alt:string;caption:string;source?:string;
  generated?:{model:string;basis:"description_and_caption"};
  motion?:MotionMoment & {omittedChanges:number};
  variable?:{label:string;value:number;unit:string};
  readings:Array<{label:string;value:number;unit:string;formula?:string;calculation?:string}>;
  endpoints?:Array<{x:number;readings:Array<{label:string;value:number;unit:string}>}>;
  movingMarks:Array<{index:number;id?:string;shape:string;label?:string;extent?:"segment"|"point";values:Record<string,number>}>;
  omittedMarks:number;
}

export function mergeFigures(prior:PlacedFigure[],later:PlacedFigure[]):PlacedFigure[] {
  const figures=new Map(prior.map(f=>[f.figure.key,f]));
  for (const f of later) {figures.delete(f.figure.key);figures.set(f.figure.key,f);}
  return [...figures.values()].slice(-16);
}
