import type {InkFigure} from "./ink.mjs";
export function mountFigure(figure:InkFigure, options?:{onInteract?:()=>void;onAsk?:(tick:number,prediction?:string)=>void}):{
node:HTMLElement;pause:()=>void;getTick:()=>number;setAskEnabled:(enabled:boolean)=>void
};
