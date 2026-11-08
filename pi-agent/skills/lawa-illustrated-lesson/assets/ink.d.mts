export interface InkAxis {
  label:string; min:number; max:number; unit?:string;
  readings?:Array<{label:string;expr:string;unit?:string}>;
}
export interface PredictionOption {id:string;label:string;point:[number,number];feedback:string;replay?:boolean}
export interface PredictionSpec {after:number;through?:number;prompt:string;options:PredictionOption[]}
export type PredictionFrame =
  | {phase:"waiting";prompt:string;options:Array<Pick<PredictionOption,"id"|"label"|"point">>}
  | {phase:"feedback";prompt:string;id:string;label:string;point:[number,number];feedback:string;revisiting:boolean};
export interface InkFigure {
  prediction?:PredictionSpec;
  key:string; alt:string; caption:string; source?:string; view:[number,number];
  ink:Array<[string,Record<string,string|number>,string?]>; axis?:InkAxis;
  motion?:Array<{seconds:number;say:string;to?:Record<string,Record<string,number>>}>;
}
export interface MotionMoment {
  elapsedMs:number;durationMs:number;step:number;steps:number;startMs:number;endMs:number;caption:string;
  changes:Array<{id:string;field:string;from:number;to:number;value:number}>;
  prediction?:PredictionFrame;
}
export interface InkFrame {
  moment?:MotionMoment;
  x:number; marks:Array<{tag:string;attrs:Record<string,string|number>;label?:string}>;
  readings:Array<{label:string;value:number;unit:string}>;
}
export const TICKS:number;
export function prepareFigure(input:unknown):{figure:InkFigure;durationMs:number;prediction?:{atMs:number;reviewMs:number;reviewEndMs:number;joinMs:number;after:number;prompt:string;options:PredictionOption[]};at:(tick:number,route?:string)=>InkFrame};
export function formatValue(value:number):string;
export function figureKey(line:string):string|undefined;
