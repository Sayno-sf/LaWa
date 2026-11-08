/** Compile named objects and teaching cues once. Both the classroom and tutor sample this clock. */
export const MAX_MOTION_MS = 90000;
const nameOfPart = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const positions = {
  line: ["x1","y1","x2","y2"], rect:["x","y","width","height","rx","ry"],
  circle:["cx","cy","r"], ellipse:["cx","cy","rx","ry"], text:["x","y"]
};
const sizes = new Set(["r","rx","ry","width","height"]);
function motionCheck(condition,message) {
  if (!condition) throw new Error("图解讲页 · "+message);
}
function objectOf(value) {return value!==null && typeof value==="object" && !Array.isArray(value);}

function buildPrediction(spec,cues,view) {
  if (spec===undefined) return undefined;
  const keys=(obj,allowed)=>objectOf(obj) && Object.keys(obj).every(k=>allowed.includes(k));
  const text=(value,limit)=>typeof value==="string" && value.trim() && value.length<=limit && !/[\u0000-\u001f]/.test(value);
  motionCheck(keys(spec,["after","through","prompt","options"]) && Number.isInteger(spec.after) && spec.after>=1 && spec.after<cues.length,
    "prediction.after 是已演完的段号，预测后还需有动作");
  const through=spec.through??spec.after+1;
  motionCheck(Number.isInteger(through) && through>spec.after && through<=cues.length && text(spec.prompt,120),"预测问题或反馈结束段号无效");
  motionCheck(cues.slice(spec.after,through).some(c=>c.changes.some(v=>v.field!=="opacity" && v.shape!=="text")),"预测之后应能直接看见对象的位置或形状如何变化");
  motionCheck(Array.isArray(spec.options) && spec.options.length>=2 && spec.options.length<=3,"预测点需要 2–3 个可选位置");
  const options=spec.options.map(o=>{
    motionCheck(keys(o,["id","label","point","feedback","replay"]) && typeof o.id==="string" && nameOfPart.test(o.id) &&
      o.id!=="waiting" && text(o.label,32) && text(o.feedback,160) && (o.replay===undefined || typeof o.replay==="boolean"),"预测选项需要 id、label、point 和 feedback");
    motionCheck(Array.isArray(o.point) && o.point.length===2 && o.point.every((n,i)=>Number.isFinite(n) && n>=0 && n<=view[i]),"预测位置必须在画纸内");
    return {...o,label:o.label.trim(),feedback:o.feedback.trim()};
  });
  for (const field of ["id","label","feedback"]) motionCheck(new Set(options.map(o=>o[field])).size===options.length,"预测选项与对应讲法应能区分");
  for(let i=0;i<options.length;i++) for(const b of options.slice(i+1)) {
    const [x,y]=options[i].point;
    motionCheck(Math.hypot(x-b.point[0],y-b.point[1])>=Math.min(view[0],view[1])*0.06,"请拉开可点击的预测位置");
  }
  const previous=cues[spec.after-1];
  const review=cues.slice(0,spec.after).findLast(c=>c.changes.some(v=>v.field!=="opacity" && v.shape!=="text"));
  motionCheck(review || !options.some(o=>o.replay),"要回看线索，请在预测之前先演一段可见运动");
  return {atMs:previous.end,reviewMs:review?.start??previous.start,reviewEndMs:review?.end??previous.end,joinMs:cues[through-1].end,after:spec.after,prompt:spec.prompt.trim(),options};
}

export function compileMotion(figure, marks) {
  const script=figure.motion;
  motionCheck(Array.isArray(script) && script.length>=2 && script.length<=12,"motion 需要 2–12 段讲解");
  const indexById=new Map();
  figure.ink.forEach(([,attrs],index)=>{
    if (attrs.id===undefined) return;
    motionCheck(typeof attrs.id==="string" && nameOfPart.test(attrs.id) && !indexById.has(attrs.id),"运动对象 id 需要唯一的英文名称");
    indexById.set(attrs.id,index);
  });
  const finished=marks.map(()=>({}));
  let total=0, hasMovement=false;
  const cues=script.map(cue=>{
    motionCheck(objectOf(cue) && Object.keys(cue).every(k=>["seconds","say","to"].includes(k)),"每段只填写 seconds、say 和可选的 to");
    motionCheck(Number.isFinite(cue.seconds) && cue.seconds>=0.5 && cue.seconds<=20,"每段时长应在 0.5–20 秒之间");
    motionCheck(typeof cue.say==="string" && cue.say.trim() && cue.say.length<=180 && !/[\u0000-\u001f]/.test(cue.say),"每段需要一条简短的讲解字幕");
    const start=total;
    total+=Math.round(cue.seconds*1000);
    motionCheck(total<=MAX_MOTION_MS,"整段讲解最多 90 秒");
    const before=finished.map(attrs=>({...attrs})), changes=[];
    if (cue.to!==undefined) {
      motionCheck(objectOf(cue.to),"to 需要按对象 id 填写目标属性");
      for (const [id,target] of Object.entries(cue.to)) {
        const index=indexById.get(id);
        motionCheck(index!==undefined && objectOf(target),"找不到运动对象或目标属性 "+id);
        const mark=marks[index];
        for (const [field,to] of Object.entries(target)) {
          const offset=field==="dx" || field==="dy";
          motionCheck(offset || field==="opacity" || positions[mark.tag]?.includes(field),id+" 不支持运动属性 "+field);
          motionCheck(Number.isFinite(to) && Math.abs(to)<=1e6 && (!sizes.has(field) || to>=0) &&
            (field!=="opacity" || (to>=0 && to<=1)),id+" 的目标数值无效");
          const from=finished[index][field] ?? (offset?0:field==="opacity"?(mark.attrs.opacity??1):mark.attrs[field]);
          motionCheck(typeof from==="number",id+" 要先在画稿中给 "+field+" 初值");
          if (to!==from) {
            changes.push({id,index,shape:mark.tag,field,from,to});
            if (mark.tag!=="text" && field!=="opacity") hasMovement=true;
          }
          finished[index][field]=to;
        }
      }
    }
    return {start,end:total,say:cue.say.trim(),before,changes};
  });
  motionCheck(hasMovement,"安排至少一个图中物体的位置、形状或尺寸发生变化");
  motionCheck(new Set(cues.map(c=>c.say)).size>=2,"请随关键变化安排不同的讲解");
  const prediction=buildPrediction(figure.prediction,cues,figure.view);
  function at(ms,route) {
    motionCheck(Number.isInteger(ms) && ms>=0 && ms<=total,"动画时间超出范围");
    const index=ms===total?cues.length-1:cues.findIndex(c=>ms<c.end);
    const cue=cues[index], progress=(ms-cue.start)/(cue.end-cue.start);
    const values=cue.before.map(attrs=>({...attrs}));
    const changes=cue.changes.map(({id,index,field,from,to})=>{
      const value=progress===1?to:from+(to-from)*progress;
      values[index][field]=value;
      return {id,field,from,to,value};
    });
    const frame=marks.map((mark,i)=>{
      const {dx=0,dy=0,...updates}=values[i];
      const attrs={opacity:1,...mark.attrs,...updates,transform:"translate("+dx+" "+dy+")"};
      return {...mark,attrs};
    });
    const moment={elapsedMs:ms,durationMs:total,step:index+1,steps:cues.length,startMs:cue.start,endMs:cue.end,caption:cue.say,changes};
    if (route!==undefined) {
      motionCheck(prediction,"这幅画没有预测点");
      if (route==="waiting") {
        motionCheck(ms===prediction.atMs,"请定位到实际预测位置");
        // 停在段落边界时，下一段的字幕和目标坐标尚未向读者呈现。
        Object.assign(moment,{step:prediction.after,startMs:ms,endMs:ms,caption:prediction.prompt,changes:[],
          prediction:{phase:"waiting",prompt:prediction.prompt,options:prediction.options.map(({id,label,point})=>({id,label,point}))}});
      } else {
        const choice=prediction.options.find(o=>o.id===route);
        motionCheck(choice && (ms>=prediction.atMs || choice.replay && ms>=prediction.reviewMs && ms<prediction.reviewEndMs) && ms<prediction.joinMs,"预测路径与当前时间不符");
        moment.prediction={phase:"feedback",prompt:prediction.prompt,id:choice.id,label:choice.label,point:choice.point,
          feedback:choice.feedback,revisiting:ms<prediction.atMs};
      }
    }
    return {x:0,marks:frame,readings:[],moment};
  }
  return {at,durationMs:total,prediction};
}
