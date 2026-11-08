import {mountBookPainting} from "./bookPaintingView";
import type {PlacedFigure,FigureAnchor,PaintedFigure} from "../../src/lessonFigureTypes";
import {figureKey} from "../../skills/lawa-illustrated-lesson/assets/ink.mjs";
import {mountFigure} from "../../skills/lawa-illustrated-lesson/assets/reader.mjs";
import "../../skills/lawa-illustrated-lesson/assets/paper.css";
import {renderMarkdown} from "./markdown";

interface IllustratedMessage {role:string;content:string;entryId?:string;streaming?:boolean;figures?:PlacedFigure[]}
export function illustrateMessage(message:IllustratedMessage):string {
  if (message.role!=="assistant" || !message.figures?.length) return renderMarkdown(message.content);
  const keys=new Set(message.figures.map(f=>f.figure.key));
  let body=message.content;
  if (message.streaming) {
    const last=body.lastIndexOf("\n")+1, tail=body.slice(last);
    if (tail.startsWith("![") && !figureKey(tail)) body=body.slice(0,last);
  }
  return renderMarkdown(body,line=>{
    const key=figureKey(line);
    if (!key) return undefined;
    return keys.has(key)?'<div data-lesson-plate="'+key+'"><div hidden aria-hidden="true">'+renderMarkdown(line)+'</div></div>':undefined;
  });
}

export class LessonFigureView {
  private readonly mounted=new Map<string,ReturnType<typeof mountFigure> & {dispose?:()=>void}>();
  constructor(private readonly ask:(anchor:FigureAnchor)=>void,private readonly interact:()=>void) {
    window.addEventListener("pagehide",()=>this.pauseAll());
    window.addEventListener("blur",()=>this.pauseAll());
    document.addEventListener("visibilitychange",()=>{if(document.hidden)this.pauseAll();});
  }
  mount(root:ParentNode,message:IllustratedMessage,canAsk:(f:PlacedFigure)=>boolean) {
    if (!message.figures?.length) return;
    const occurrences=new Map<string,number>();
    for (const slot of root.querySelectorAll<HTMLElement>("[data-lesson-plate]")) {
      const key=slot.dataset.lessonPlate!, placed=message.figures.find(f=>f.figure.key===key);
      if (!placed) continue;
      const occurrence=occurrences.get(key)??0;
      occurrences.set(key,occurrence+1);
      const suffix=placed.batchId+"/"+key+"/"+occurrence;
      const identity=(message.entryId??"stream")+"/"+suffix;
      let plate=this.mounted.get(identity);
      if (!plate && message.entryId) {
        const ephemeral="stream/"+suffix;
        plate=this.mounted.get(ephemeral);
        if (plate) {this.mounted.delete(ephemeral);this.mounted.set(identity,plate);}
      }
      if (!plate) {
        const ask=(tick:number,prediction?:string)=>{
          const messageId=plate!.node.closest<HTMLElement>("[data-entry-id]")?.dataset.entryId;
          if (messageId && canAsk(placed)) this.ask({messageId,batchId:placed.batchId,key,tick,...(prediction?{prediction}:{})});
        };
        plate="art" in placed.figure?mountBookPainting(placed as PlacedFigure & {figure:PaintedFigure},()=>ask(0)):
          mountFigure(placed.figure,{onInteract:this.interact,onAsk:ask});
        this.mounted.set(identity,plate);
      }
      // 保留与服务端相同的 Markdown 摘录坐标，按钮、图注和动态读数不参与正文选段。
      const source=slot.firstElementChild;
      plate.node.dataset.noteIgnore="true";
      if (source) slot.replaceWith(source,plate.node);
      else slot.replaceWith(plate.node);
      plate.setAskEnabled(!!message.entryId && canAsk(placed));
    }
  }
  pauseAll() {for (const plate of this.mounted.values()) plate.pause();}
  prune() {for (const [id,plate] of this.mounted) if (!plate.node.isConnected) {plate.pause();plate.dispose?.();this.mounted.delete(id);}}
}
