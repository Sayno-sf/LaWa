/** The same local choice is reachable on the drawing or with a keyboard. No transport or scoring. */
export function mountPrediction(gate,svg,node,choose) {
  const ns="http://www.w3.org/2000/svg";
  const layer=document.createElementNS(ns,"g");
  layer.setAttribute("aria-hidden","true");
  svg.append(layer);
  const controls=document.createElement("div");
  controls.className="lesson-prediction-options";controls.setAttribute("role","group");
  controls.setAttribute("aria-label",gate.prompt);controls.tabIndex=-1;
  const feedback=document.createElement("p");
  feedback.className="lesson-prediction-feedback";feedback.setAttribute("role","status");
  node.append(controls,feedback);
  controls.hidden=true;feedback.hidden=true;
  const radius=Math.min(svg.viewBox.baseVal.width,svg.viewBox.baseVal.height)*0.03;
  const closest=Math.min(...gate.options.flatMap((a,i)=>gate.options.slice(i+1).map(b=>Math.hypot(a.point[0]-b.point[0],a.point[1]-b.point[1]))));
  const hitRadius=Math.min(radius*1.8,closest*.49);
  const markers=gate.options.map(option=>{
    const marker=document.createElementNS(ns,"g");
    marker.setAttribute("class","lesson-prediction-target");
    marker.setAttribute("display","none");
    marker.setAttribute("transform","translate("+option.point.join(" ")+")");
    for (const [size,cls] of [[hitRadius,"hit"],[radius,"ring"]]) {
      const circle=document.createElementNS(ns,"circle");
      circle.setAttribute("r",String(size));circle.setAttribute("class",cls);
      marker.append(circle);
    }
    marker.addEventListener("click",()=>choose(option));
    layer.append(marker);
    const button=document.createElement("button");
    button.type="button";button.textContent=option.label;
    button.addEventListener("click",()=>choose(option));controls.append(button);
    return marker;
  });
  let shown;
  return route=>{
    if (shown===route) return;
    shown=route;
    const waiting=route==="waiting", selected=gate.options.find(o=>o.id===route);
    controls.hidden=!waiting;
    feedback.hidden=!selected;
    feedback.textContent=selected?selected.feedback:"";
    markers.forEach((mark,i)=>{
      const picked=selected===gate.options[i];
      mark.setAttribute("display",waiting||picked?"inline":"none");
      mark.classList.toggle("chosen",picked);
      mark.setAttribute("pointer-events",waiting?"all":"none");
    });
    if (waiting && node.contains(document.activeElement)) controls.focus({preventScroll:true});
  };
}
