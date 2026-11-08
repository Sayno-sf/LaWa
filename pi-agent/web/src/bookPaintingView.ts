import type {PlacedFigure,PaintedFigure} from "../../src/lessonFigureTypes";

/** Poll only the local, receipt-bound resource. Looking at a page never requests a new generation. */
export function mountBookPainting(placed:PlacedFigure & {figure:PaintedFigure},onAsk:()=>void) {
  const {figure}=placed;
  const node=document.createElement("figure");
  node.className="lesson-plate lesson-painting";
  const paper=document.createElement("div"),notice=document.createElement("span");
  paper.className="lesson-painting-paper";notice.textContent="插画绘制中…";paper.append(notice);
  const caption=document.createElement("figcaption");
  caption.className="lesson-plate-caption";caption.textContent=figure.caption;
  const credit=document.createElement("small");credit.className="lesson-plate-source";credit.textContent=figure.source;caption.append(credit);
  const ask=document.createElement("button");ask.type="button";ask.className="lesson-plate-ask";ask.textContent="问这幅图";ask.onclick=onAsk;ask.disabled=true;
  node.append(paper,caption,ask);
  const base="/api/web/sessions/"+encodeURIComponent(placed.sessionId)+"/lesson-art/"+encodeURIComponent(placed.batchId)+"/"+encodeURIComponent(figure.art.id);
  let timer=0,active=true,ready=false,allowed=false,misses=0;
  const controller=new AbortController();
  const source=()=>{const id=node.closest<HTMLElement>("[data-entry-id]")?.dataset.entryId;return id?"?message="+encodeURIComponent(id):"";};
  function fail(reason:string) {notice.textContent=reason;paper.classList.add("unavailable");node.dataset.artState="failed";ask.disabled=true;}
  async function poll() {
    if (!active) return;
    try {
      const response=await fetch(base+source(),{cache:"no-store",signal:controller.signal});
      // 流式正文可能早于最后一条 Pi 回执的落盘。短暂重读本机状态不重复委托生图。
      if (!response.ok) {
        if (++misses<4) {timer=window.setTimeout(poll,750);return;}
        fail("插画暂不可用");return;
      }
      const result=await response.json();
      if (!active) return;
      node.dataset.artState=result.state;
      if (result.state==="drawing") {timer=window.setTimeout(poll,1300);return;}
      if (result.state!=="ready") {fail(result.reason||"这幅插画尚未完成");return;}
      const img=document.createElement("img");
      img.alt=figure.alt;img.width=result.width;img.height=result.height;img.decoding="async";
      img.onload=()=>{if (active) {ready=true;paper.replaceChildren(img);ask.disabled=!allowed;}};
      img.onerror=()=>fail("插画暂时无法读取");
      img.src=base+"/image"+source();
    } catch {if (active) {if (++misses<4) timer=window.setTimeout(poll,900);else fail("插画暂时无法读取");}}
  }
  timer=window.setTimeout(poll,0);
  return {node,pause(){},getTick:()=>0,setAskEnabled(value:boolean){allowed=value;ask.disabled=!ready||!allowed;},
    dispose(){active=false;window.clearTimeout(timer);controller.abort();}};
}
