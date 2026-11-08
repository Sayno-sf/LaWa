import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync,mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createBundledLearningSkills} from "./learningSkillBundles.js";
import {LearningSkillPreferences} from "./learningSkillPreferences.js";
import {prepareFigure,TICKS} from "../skills/lawa-illustrated-lesson/assets/ink.mjs";
import {TeachingSessionContext} from "./teachingSession.js";
import {GoalOnboardingContext} from "./planning/goalOnboarding.js";
import {createLessonFigureTool,createFigureBatch,placedFigures,readFigureBatch,referencedFigures,resolveFigureQuestion} from "./lessonFigures.js";

const lesson=JSON.parse(readFileSync(new URL("../skills/lawa-illustrated-lesson/examples/lamplight.json",import.meta.url),"utf8"));
const scope={sessionId:"s",goalId:"g",taskId:"t",skillId:"k"};
const predictionPage=JSON.parse(readFileSync(new URL("../skills/lawa-illustrated-lesson/examples/pinhole-prediction.json",import.meta.url),"utf8"));

test("a prediction freezes the shared geometry before the next cue and reconstructs just the visible path for the tutor",()=>{
  const figure=predictionPage.figures[0], drawing=prepareFigure(figure),gate=drawing.prediction!;
  const batch=createFigureBatch([figure],scope),messages=[{role:"assistant",entryId:"page",figures:placedFigures(batch)}];
  const anchor={batchId:batch.id,messageId:"page",key:figure.key,tick:gate.atMs,prediction:"waiting"};
  const waiting=resolveFigureQuestion(anchor,messages,scope);
  assert.equal(gate.atMs,13500);assert.equal(gate.reviewMs,10500);assert.equal(gate.joinMs,18000);
  assert.equal(waiting.motion?.caption,gate.prompt);
  assert.deepEqual(waiting.motion?.changes,[]);
  const incoming=waiting.movingMarks.find(m=>m.id==="rayBot1"),outgoing=waiting.movingMarks.find(m=>m.id==="rayBot2");
  assert.deepEqual(incoming?.values,{x1:60,x2:210,y1:200,y2:140});assert.equal(incoming?.extent,"segment");
  assert.equal(outgoing?.extent,"point");assert.equal(waiting.movingMarks.some(m=>m.id==="botSpot"),false);
  assert.doesNotMatch(JSON.stringify(waiting.motion),/空心圈保留你的预测/);
  assert.deepEqual(drawing.at(gate.atMs,"waiting").marks,drawing.at(gate.atMs).marks);
  const attempted=resolveFigureQuestion({...anchor,tick:gate.reviewMs+500,prediction:"lower"},messages,scope);
  assert.ok(attempted.movingMarks.find(m=>m.id==="rayBot1")!.values.x2!<210);
  const feedback=attempted.motion?.prediction;
  assert.ok(feedback?.phase==="feedback" && feedback.revisiting);
  assert.deepEqual(feedback.point,[360,200]);
  const upper=drawing.at(gate.atMs+400,"upper"),lower=drawing.at(gate.atMs+400,"lower");
  assert.deepEqual(upper.marks,lower.marks);
  assert.notDeepEqual(upper.moment?.prediction,lower.moment?.prediction);
  assert.equal(drawing.at(gate.joinMs).moment?.prediction,undefined);
  assert.throws(()=>resolveFigureQuestion({...anchor,prediction:"other"},messages,scope));
  assert.throws(()=>resolveFigureQuestion({...anchor,prediction:"lower",tick:gate.joinMs},messages,scope));
  assert.throws(()=>resolveFigureQuestion({...anchor,tick:gate.atMs-1},messages,scope));
  assert.throws(()=>resolveFigureQuestion({...anchor,feedback:"伪造"},messages,scope));
  assert.throws(()=>resolveFigureQuestion(anchor,messages,{...scope,taskId:"foreign"}));
});

test("review replays the last visible action and omits a subsequent authored hold",()=>{
  const figure=structuredClone(predictionPage.figures[0]);
  figure.motion.splice(5,0,{seconds:2,say:"留一点观察时间。"});
  figure.prediction.after++;figure.prediction.through++;
  const drawing=prepareFigure(figure),gate=drawing.prediction!;
  assert.deepEqual([gate.reviewMs,gate.reviewEndMs,gate.atMs],[10500,13500,15500]);
  assert.throws(()=>drawing.at(14000,"lower"));
  assert.ok(drawing.at(15500,"lower").moment?.prediction);
});

test("ill-formed choices and prediction points on ordinary diagrams are rejected",()=>{
  const figure=predictionPage.figures[0],spec=figure.prediction;
  for(const patch of [{after:0},{after:99},{through:3},{through:50},{options:[spec.options[0]]},
    {options:[spec.options[0],{...spec.options[1],point:[1e6,5]}]},
    {options:[spec.options[0],{...spec.options[1],point:spec.options[0].point}]},
    {options:[spec.options[0],{...spec.options[1],id:"waiting"}]}]) {
    assert.throws(()=>prepareFigure({...figure,prediction:{...spec,...patch}}));
  }
  assert.throws(()=>prepareFigure({...lesson.figures[0],prediction:spec}));
});

const journey={
  key:"corner",alt:"墨点转弯",caption:"看墨点按顺序经过两个位置。",view:[220,120],
  ink:[["circle",{id:"dot",cx:20,cy:80,r:5}],["line",{id:"trail",x1:20,y1:80,x2:20,y2:80}]],
  motion:[
    {seconds:2,say:"先向右。",to:{dot:{dx:80},trail:{x2:100}}},
    {seconds:3,say:"到转角后向上。",to:{dot:{dy:-60},trail:{opacity:0.4}}},
    {seconds:1,say:"观察停下的位置。"}
  ]
};

test("a timed teaching figure carries simultaneous movement into the next cue and reconstructs the displayed instant",()=>{
  const drawing=prepareFigure(journey);
  assert.equal(drawing.durationMs,6000);
  const near=drawing.at(1000),corner=drawing.at(2000),turn=drawing.at(3500);
  assert.equal(near.marks[0]!.attrs.transform,"translate(40 0)");
  assert.equal(near.marks[1]!.attrs.x2,60);
  assert.equal(corner.moment?.caption,"到转角后向上。");
  assert.equal(corner.marks[0]!.attrs.transform,"translate(80 0)");
  assert.equal(turn.marks[0]!.attrs.transform,"translate(80 -30)");
  assert.equal(drawing.at(6000).marks[0]!.attrs.transform,"translate(80 -60)");
  assert.equal(drawing.at(0).marks[0]!.attrs.transform,"translate(0 0)");
  assert.equal(drawing.at(0).marks[1]!.attrs.opacity,1);
  const batch=createFigureBatch([journey],scope);
  const stored=readFigureBatch(JSON.parse(JSON.stringify(batch)))!;
  const messages=[{role:"assistant",entryId:"m",figures:placedFigures(stored)}];
  const anchor={messageId:"m",batchId:batch.id,key:"corner",tick:3500};
  const context=resolveFigureQuestion(anchor,messages,scope);
  assert.equal(context.motion?.elapsedMs,3500);
  assert.deepEqual(context.motion?.changes,turn.moment?.changes);
  assert.throws(()=>resolveFigureQuestion({...anchor,tick:6001},messages,scope),/时间超出/);
  assert.throws(()=>resolveFigureQuestion({...anchor,caption:"已完成"},messages,scope));
  assert.throws(()=>resolveFigureQuestion(anchor,messages,{...scope,taskId:"foreign"}));
});

test("time-based teaching rejects a non-moving slide deck, ambiguous or executable targets and oversized clocks",()=>{
  const cues=(to:Record<string,unknown>)=>[{seconds:1,say:"开始观察",to},{seconds:1,say:"接着看"}];
  for (const to of [{ghost:{dx:20}},{dot:{onclick:1}},{dot:{dx:"=x+1"}},{dot:{r:-2}},{dot:{opacity:0.3}},{dot:{dx:0}}]) {
    assert.throws(()=>prepareFigure({...journey,motion:cues(to)}));
  }
  assert.throws(()=>prepareFigure({...journey,axis:{label:"距离",min:0,max:1}}));
  assert.throws(()=>prepareFigure({...journey,ink:[journey.ink[0],journey.ink[0]]}),/唯一/);
  assert.throws(()=>prepareFigure({...journey,motion:Array(5).fill({seconds:20,say:"停留"})}),/90/);
});

test("requesting a narrated animation cannot issue a matching receipt for a static plate or a variable sweep",async()=>{
  const overview={current_goal:"示例",goal_profile:{id:"g"},active_task:{id:"t",status:"ACTIVE",related_skill_ids:["k"]},
    curriculum_spine:[],current_frontier:null,current_focus:null,skills:[],recent_evidence:[],learning_history:[],current_goal_skill_ids:["k"]};
  const tool=createLessonFigureTool(new TeachingSessionContext(),new GoalOnboardingContext(),
    {fetchImpl:async()=>Response.json(overview),log:()=>{}},"WEB");
  const submit=(figures:unknown[])=>tool.execute("prepare",{figures,require_motion:true},undefined,undefined,{} as never);
  for(const visual of lesson.figures) await assert.rejects(submit([visual]),/需要讲解动画/);
  const result=await submit([journey]);
  const receipt=result.content.find(part=>part.type==="text");
  assert.ok(receipt && receipt.type==="text");
  assert.deepEqual(JSON.parse(receipt.text).displays,[{key:"corner",kind:"讲解动画"}]);
  await assert.rejects(tool.execute("predict",{figures:[journey],require_prediction:true},undefined,undefined,{} as never),/预测点/);
});

test("the book tool has its own live permission, even after the model read its entry",async()=>{
  const previous=process.env.WEB_SESSION_DIR;
  process.env.WEB_SESSION_DIR=mkdtempSync(join(tmpdir(),"lawa-illustration-switch-"));
  try {
    const prefs=new LearningSkillPreferences(),runtime=createBundledLearningSkills("WEB","TEACHER");
    assert.equal(runtime.hasToolAdapter("present_explainer_animation"),false);
    assert.equal(runtime.hasToolAdapter("present_teaching_animation"),false);
    assert.equal(runtime.toolEnabled("prepare_lesson_figures"),true);
    const load=runtime.tools().find(t=>t.name==="load_learning_skill")!;
    const result=await load.execute("read",{name:"lawa-illustrated-lesson"},undefined,undefined,{} as never);
    runtime.observeModelContext([{role:"toolResult",isError:false,toolName:load.name,content:result.content}]);
    assert.equal(runtime.guardTool("prepare_lesson_figures"),undefined);
    prefs.set("lawa-illustrated-lesson",false);
    assert.ok(runtime.guardTool("prepare_lesson_figures")?.block);
    assert.equal(runtime.toolEnabled("prepare_lesson_figures"),false);
    assert.doesNotMatch(runtime.metadataPrompt(),/lawa-illustrated-lesson/);
  } finally {
    if (previous===undefined) delete process.env.WEB_SESSION_DIR;
    else process.env.WEB_SESSION_DIR=previous;
  }
});

test("paper figures compute geometry and readouts from the same physical quantity at endpoints and midpoint",()=>{
  const drawing=prepareFigure(lesson.figures[1]);
  for (const [tick,distance] of [[0,1],[TICKS/2,3.5],[TICKS,6]] as const) {
    const frame=drawing.at(tick);
    const shadow=frame.marks.find(m=>m.tag==="line" && m.attrs["stroke-width"]===5)!;
    assert.equal((Number(shadow.attrs.x2)-Number(shadow.attrs.x1))/50,distance/2);
    assert.equal(frame.readings.find(r=>r.label==="影长")?.value,distance/2);
  }
  const pole=structuredClone(lesson.figures[1]);
  pole.axis.readings[0].expr="1/(x-3.5)";
  assert.throws(()=>prepareFigure(pole),/有效数值/,"singularity between the endpoints must be caught");
});

test("book illustration input cannot carry an executable, a URL paint or a browser-supplied answer",()=>{
  for (const mark of [["script",{}],["image",{href:"https://invalid.invalid"}],["rect",{width:20,height:20,onload:"alert(1)"}],["rect",{width:20,height:20,fill:"url(https://invalid.invalid)"}]]) {
    assert.throws(()=>prepareFigure({...lesson.figures[0],ink:[mark]}));
  }
  const batch=createFigureBatch(lesson.figures,scope);
  assert.ok(readFigureBatch(JSON.parse(JSON.stringify(batch))));
  const corrupt=structuredClone(batch);corrupt.figures[0]!.caption="另一份图注";
  assert.equal(readFigureBatch(corrupt),null);
  const all=placedFigures(batch);
  const exampleFence="~~~md\n![示例](lawa-figure:street)\n~~~";
  const used=referencedFigures(exampleFence+"\n\n![测量](lawa-figure:measure)",all);
  assert.deepEqual(used.map(f=>f.figure.key),["measure"]);
  const messages=[{role:"assistant",entryId:"public",figures:used}];
  const anchor={batchId:batch.id,key:"measure",messageId:"public",tick:TICKS};
  const question=resolveFigureQuestion(anchor,messages,scope);
  assert.equal(question.variable?.value,6);assert.equal(question.readings[1]?.value,3);
  assert.ok(question.movingMarks.length>0);
  assert.deepEqual(question.endpoints?.map(p=>[p.x,p.readings[1]?.value]),[[1,0.5],[6,3]]);
  assert.equal(question.readings[1]?.formula,"x/2");assert.equal(question.readings[1]?.calculation,"(6)/2 ≈ 3");
  assert.throws(()=>resolveFigureQuestion({...anchor,readings:[100]},messages,scope));
  assert.throws(()=>resolveFigureQuestion({...anchor,key:"street"},messages,scope));
  assert.throws(()=>resolveFigureQuestion(anchor,messages,{...scope,taskId:"other"}));
});
