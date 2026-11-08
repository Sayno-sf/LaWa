import {prepareFigure,formatValue,TICKS} from "./ink.mjs";
import {mountPrediction} from "./prediction-view.mjs";

const NS = "http://www.w3.org/2000/svg";
function element(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

/** Every control, drawing and annotation reads the same tick, including a pause between sentences. */
export function mountFigure(input, options={}) {
  const drawing = prepareFigure(input), {figure} = drawing;
  const timed = !!figure.motion;
  const lastTick = timed ? drawing.durationMs : TICKS;
  const node = element("figure",timed ? "lesson-plate lesson-motion" : "lesson-plate");
  const svg = document.createElementNS(NS,"svg");
  svg.setAttribute("viewBox","0 0 " + figure.view.join(" "));
  svg.setAttribute("role","img");
  svg.setAttribute("aria-label",figure.alt);
  const painted = figure.ink.map(([tag,,label]) => {
    const mark = document.createElementNS(NS,tag);
    if (label) mark.textContent = label;
    svg.append(mark);
    return mark;
  });
  node.append(svg);
  const caption = element("figcaption","lesson-plate-caption");
  const wording = element("span",timed ? "lesson-motion-caption" : "",figure.caption);
  caption.append(wording);
  if (figure.source) caption.append(element("small","lesson-plate-source",figure.source));
  node.append(caption);

  let tick = 0, running = false, request = 0, origin = 0, initial = 0;
  let slider,play,readout,progress,clock,seek;
  const gate=drawing.prediction;
  let waiting=false,answered=false,picked;
  const showPrediction=gate && mountPrediction(gate,svg,node,choose);
  function routeAt(ms) {
    if (waiting) return "waiting";
    if (picked && (ms>=gate.atMs || picked.replay && ms>=gate.reviewMs && ms<gate.reviewEndMs) && ms<gate.joinMs) return picked.id;
  }
  const time = ms => Math.floor(ms/60000)+":"+String(Math.floor(ms/1000)%60).padStart(2,"0");
  function draw(value) {
    tick = value;
    const route=routeAt(tick);
    const frame = drawing.at(tick,route);
    showPrediction?.(route);
    frame.marks.forEach(({attrs},i) => {
      for (const [name,value] of Object.entries(attrs)) {
        const text = String(value);
        if (painted[i].getAttribute(name) !== text) painted[i].setAttribute(name,text);
      }
    });
    if (frame.moment) {
      const current=frame.moment;
      if (wording.textContent!==current.caption) wording.textContent=current.caption;
      progress.value=tick;seek.value=String(tick);
      const timeDisplay=time(tick)+" / "+time(lastTick);
      if (clock.textContent!==timeDisplay) {clock.textContent=timeDisplay;seek.setAttribute("aria-valuetext",timeDisplay);}
      node.dataset.elapsedMs=String(tick);
      node.dataset.step=String(current.step);
    }
    if (slider) {
      slider.value = String(tick);
      const display = formatValue(frame.x) + (figure.axis.unit ?? "");
      slider.setAttribute("aria-valuetext",display);
      readout.textContent = [figure.axis.label + " " + display,...frame.readings.map(r => r.label + " " + formatValue(r.value) + r.unit)].join("　·　");
    }
  }
  function pause() {
    running = false;
    cancelAnimationFrame(request);
    if (play) {
      play.textContent = waiting ? "继续看" : tick === lastTick ? "重播" : tick ? "继续" : timed ? "播放讲解" : "播放";
      play.setAttribute("aria-pressed","false");
    }
  }
  function resume() {
    initial=tick;origin=performance.now();running=true;
    play.textContent="暂停";play.setAttribute("aria-pressed","true");
    request=requestAnimationFrame(advance);
  }
  function choose(option) {
    if (!waiting) return;
    options.onInteract?.();
    waiting=false;answered=true;picked=option;
    draw(option?.replay?gate.reviewMs:gate.atMs);
    play.focus({preventScroll:true});resume();
  }
  function advance(now) {
    if (!running) return;
    // 浏览器可能把点击后的首个回调归入已经开始的绘制帧，时间戳会稍早于点击时刻。
    const elapsed = Math.max(0,now-origin);
    let value = Math.min(lastTick,initial + Math.floor(timed ? elapsed : elapsed*TICKS/8000));
    if (picked?.replay && tick<gate.reviewEndMs && value>=gate.reviewEndMs && gate.reviewEndMs<gate.atMs) {
      // 回看真实动作后直接接结果，略过已经回答过的静止等待段。
      value=Math.min(lastTick,gate.atMs+value-gate.reviewEndMs);initial=value;origin=now;
    }
    if (gate && !answered && value>=gate.atMs) {
      waiting=true;draw(gate.atMs);pause();return;
    }
    if (value !== tick) draw(value);
    if (value === lastTick) pause();
    else request = requestAnimationFrame(advance);
  }
  if (figure.axis || timed) {
    const controls = element("div","lesson-plate-controls");
    play = element("button","lesson-plate-action",timed ? "播放讲解" : "播放");
    play.type = "button"; play.setAttribute("aria-pressed","false");
    controls.append(play);node.append(controls);
    if (timed) {
      progress=element("progress","lesson-motion-progress");progress.max=lastTick;
      const track=element("span","lesson-motion-track");
      progress.setAttribute("aria-hidden","true");
      seek=element("input","lesson-motion-seek");
      seek.type="range";seek.min="0";seek.max=String(lastTick);seek.step="1";
      seek.setAttribute("aria-label","讲解动画时间线");
      const seekTo=ms=>{
        options.onInteract?.();
        const next=Math.max(0,Math.min(lastTick,ms));
        if (gate && next!==tick) {waiting=false;if (next>=gate.atMs) answered=true;}
        draw(next);pause();
      };
      seek.oninput=()=>seekTo(Number(seek.value));
      seek.onkeydown=event=>{
        if (event.key!=="ArrowLeft" && event.key!=="ArrowRight") return;
        event.preventDefault();seekTo(tick+(event.key==="ArrowLeft"?-1000:1000));
      };
      track.append(progress,seek);clock=element("span","lesson-motion-time");controls.append(track,clock);
    } else {
      slider = element("input","lesson-plate-slider");
      slider.type = "range"; slider.min = "0"; slider.max = String(TICKS); slider.step = "1";
      slider.setAttribute("aria-label",figure.axis.label);
      readout = element("output","lesson-plate-readings");
      controls.append(slider); node.append(readout);
      slider.oninput = () => {options.onInteract?.(); draw(Number(slider.value)); pause();};
    }
    play.onclick = () => {
      if (running) {pause(); return;}
      if (waiting) {choose(undefined);return;}
      options.onInteract?.();
      if (tick === lastTick) {answered=false;picked=undefined;draw(0);}
      resume();
    };
  }
  const ask = element("button","lesson-plate-ask","问这幅图");
  ask.type = "button";
  ask.onclick = () => {pause(); options.onAsk?.(tick,routeAt(tick));};
  if (options.onAsk) node.append(ask);
  draw(0);
  return {node,pause,getTick:()=>tick,setAskEnabled(enabled){ask.disabled = !enabled;}};
}
