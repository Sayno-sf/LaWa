import assert from "node:assert/strict";
import test from "node:test";
import {createExplainerArtifact,explainerArtifactHash,readExplainerPresentation,resolveExplainerContext} from "./explainerCatalog.js";
import {validateExplainerScript as validateLegacyExplainerScript} from "./explainerLegacy.js";
import {sampleExplainerExpression} from "./explainerExpression.js";
import {explainerOpDuration,replayExplainer,validateExplainerScript} from "./explainerTypes.js";
import type {ExplainerAnchor,ExplainerOp,ExplainerPresentation,ExplainerScript} from "./explainerTypes.js";
import {createPresentExplainerTool} from "./explainerPresentationTool.js";
import {TeachingSessionContext} from "./teachingSession.js";
import {GoalOnboardingContext} from "./planning/goalOnboarding.js";

function newScript():ExplainerScript {
  return {title:"两个位置的变化",start:"start",stage:[{id:"item",k:"box",x:32,y:32,w:64,h:40,t:"粒子"},{id:"out",k:"cells",x:32,y:160,t:[]},{id:"arrow",k:"arrow",x:80,y:80,len:64}],nodes:{
    start:{label:"开始",ops:[["show","item"],["say","先预测粒子会去哪里。"]],ask:{q:"向哪边移动？",opts:[{t:"向右",go:"right"},{t:"向下",go:"down"}]}},
    right:{label:"向右",ops:[["move","item",160,32],["set","item","右侧"],["push","out","右"]],next:"end"},
    down:{label:"向下",ops:[["move","item",32,128],["set","item","下方"],["push","out","下"]],next:"end"},
    end:{label:"结束",ops:[["show","out"],["rotate","arrow",90],["say","路径不同，最后的位置也不同。"]],end:true}}};
}
function presentation(script=newScript()):ExplainerPresentation {return {id:"p-1",sourceSessionId:"session-1",goalId:"goal-1",taskId:"task-1",skillId:"skill-1",artifact:createExplainerArtifact(script)};}
function anchor(p=presentation()):ExplainerAnchor {return {presentation_id:p.id,source_entry_id:"entry-1",artifact_sha256:p.artifact.contentSha256,scene_id:"right:0",scene_elapsed_ms:350,selected_object_id:null,explainer_path:["start","right"]};}

test("arbitrary protocol scripts work independently of the sample directory and carry no semantic proof",()=>{
  const artifact=createExplainerArtifact(newScript());
  assert.equal(artifact.script.title,"两个位置的变化");assert.equal(artifact.templateVersion,"explainer-v2");
  assert.equal(artifact.stats.asks,1);assert.equal(artifact.stats.nodes,4);assert.equal(artifact.stats.operations,11);
  const context=resolveExplainerContext(presentation(),anchor());assert.equal(context.verifiedStep.semanticVerified,false);
});

test("malformed operation values, inherited operation names and nonfinite numbers fail before playback",()=>{
  const bad:unknown[]=[["wait","abc"],["wait",-1],["wait",Infinity],["say",{}],["set","item",{}],["push","out",false],["move","item",NaN,2],["move","item",9999,2],["rotate","arrow",Infinity],["move","item",20],["toString"],["__proto__"]];
  for(const operation of bad){const script=newScript();script.nodes.start!.ops=[operation as ExplainerOp];assert.throws(()=>validateExplainerScript(script),/校验失败/);}
  for(const mutate of [(s:ExplainerScript)=>{s.stage[0]=null as never;},(s:ExplainerScript)=>{s.stage[0]!.w=Infinity;},(s:ExplainerScript)=>{s.stage[0]!.w=800;},(s:ExplainerScript)=>{s.stage[1]!.t=[{}] as never;},(s:ExplainerScript)=>{s.nodes=null as never;}]){const s=newScript();mutate(s);assert.throws(()=>validateExplainerScript(s),/校验失败/);}
});

test("DAG validation rejects unreachable nodes, cycles, missing targets, duplicate ends, and oversize paths",()=>{
  const cases:Array<(s:ExplainerScript)=>void>=[s=>{s.nodes.orphan={label:"孤立",ops:[["wait",0]],next:"end"};},s=>{s.nodes.right!.next="start";},s=>{s.nodes.right!.next="missing";},s=>{s.nodes.right={label:"终点",ops:[["wait",0]],end:true};},s=>{s.nodes.start!.ops=Array.from({length:13},()=>["wait",10000]);},s=>{s.nodes.start!.ops=Array.from({length:101},()=>["hide","*"]);},s=>{s.nodes.end!.ops=Array.from({length:13},()=>["push","out","x"]);}];
  for(const mutate of cases){const s=newScript();mutate(s);assert.throws(()=>validateExplainerScript(s),/校验失败/);}
  const s=newScript();s.stage[0]={...s.stage[0]!,html:"<script>"} as never;assert.throws(()=>validateExplainerScript(s),/未支持字段/);
  const fourAsks=newScript();for(let i=0;i<4;i++)fourAsks.nodes["ask"+i]={label:"预测",ops:[["wait",0]],ask:{q:"下一步呢？",opts:[{t:"继续",go:i===3?"end":"ask"+(i+1)},{t:"不确定",go:i===3?"end":"ask"+(i+1)}]}};
  delete fourAsks.nodes.right;delete fourAsks.nodes.down;fourAsks.nodes.start={label:"开始",ops:[["wait",0]],next:"ask0"};assert.throws(()=>validateExplainerScript(fourAsks),/3次提问/);
  const accumulated=newScript();accumulated.stage[1]!.t=Array(10).fill("初始");accumulated.nodes.start!.ops.push(["push","out","一"]);accumulated.nodes.end!.ops.push(["push","out","末尾"]);assert.throws(()=>validateExplainerScript(accumulated),/cells超过12/);
  const outside=newScript();outside.nodes.right!.ops[0]=["move","item",640,32];assert.throws(()=>validateExplainerScript(outside),/坐标与尺寸/);
});

test("fixed operation timings match the source player and replay preserves the selected branch state",()=>{
  assert.equal(explainerOpDuration(["say","你好"]),1430);assert.equal(explainerOpDuration(["hide","*"]),0);assert.equal(explainerOpDuration(["wait",75]),75);
  const script=validateExplainerScript(newScript()).script,partial=replayExplainer(script,["start","right"],0,350);
  assert.equal(partial.previousState.elements.item!.x,32);assert.equal(partial.targetState.elements.item!.x,160);assert.equal(partial.transitionProgress,.5);assert.equal(partial.transition,true);
  const right=replayExplainer(script,["start","right","end"],0,0),down=replayExplainer(script,["start","down","end"],0,0);
  assert.equal(right.previousState.elements.item!.text,"右侧");assert.deepEqual(right.previousState.elements.out!.cells,["右"]);
  assert.equal(down.previousState.elements.item!.y,128);assert.deepEqual(down.previousState.elements.out!.cells,["下"]);
  right.targetState.elements.item!.text="mutated";assert.equal(replayExplainer(script,["start","right","end"],0,0).previousState.elements.item!.text,"右侧");
  const asked=replayExplainer(script,["start"],script.nodes.start!.ops.length,0);assert.equal(asked.operation,null);assert.equal(asked.durationMs,0);
  const growing=replayExplainer(script,["start","right"],2,325);assert.equal(growing.transition,true);assert.equal(growing.transitionProgress,.5);assert.deepEqual(growing.previousState.elements.out!.cells,[]);assert.deepEqual(growing.targetState.elements.out!.cells,["右"]);
});

test("pause context rejects invented scenes, crossed branches, illegal paths and beyond-operation elapsed times",()=>{
  const p=presentation(),context=resolveExplainerContext(p,anchor(p));assert.equal(context.recipe,"explainer");assert.equal(context.transitionProgress,.5);assert.equal(context.previousState.elements.item!.x,32);assert.equal(context.targetState.elements.item!.x,160);
  for(const change of [{scene_id:"absent:0"},{scene_id:"right:99"},{scene_elapsed_ms:701},{scene_elapsed_ms:NaN},{artifact_sha256:"a".repeat(64)},{explainer_path:["right"]},{explainer_path:["start","right","down"]},{explainer_path:undefined},{scene_id:"right:3",scene_elapsed_ms:1}])assert.throws(()=>resolveExplainerContext(p,{...anchor(p),...change}));
  assert.throws(()=>replayExplainer(p.artifact.script,["start","right","start"],0,0));
  assert.throws(()=>resolveExplainerContext(p,{...anchor(p),targetState:{text:"invented"}} as never),/自定义事实/);
});

test("snapshot rehydration verifies hash and derived stats while preserving retired versions",()=>{
  const p=presentation();assert.ok(readExplainerPresentation(p));
  p.artifact.script.title="未重新计算散列";assert.equal(readExplainerPresentation(p),null);
  const wrongStats=presentation();wrongStats.artifact.stats.asks=3;
  const {contentSha256:_,...body}=wrongStats.artifact;wrongStats.artifact.contentSha256=explainerArtifactHash(body);assert.equal(readExplainerPresentation(wrongStats),null);
  const retired=presentation();retired.artifact.id="retired-snapshot";retired.artifact.version="older";retired.artifact.skillVersion="0.9.0";
  const {contentSha256:__,...old}=retired.artifact;retired.artifact.contentSha256=explainerArtifactHash(old);assert.ok(readExplainerPresentation(retired));
  assert.equal(readExplainerPresentation({...retired,untrustedFact:true}),null);
});

const overview={current_goal:"测试学习",goal_profile:{id:"goal-1"},curriculum_spine:[],current_frontier:null,current_focus:null,skills:[{id:"skill-1"}],recent_evidence:[],active_task:{id:"task-1",status:"ACTIVE",related_skill_ids:["skill-1"]},current_goal_skill_ids:["skill-1"],learning_history:[]};
test("presentation tool accepts a new script, sends compact model text, derives scope and writes no teaching state",async()=>{
  const context=new TeachingSessionContext();context.bindSession("session-1");const before=context.snapshot(),planning=new GoalOnboardingContext();
  const tool=createPresentExplainerTool(context,planning,{fetchImpl:async()=>Response.json(overview),log:()=>{}}),args={teaching_goal:"看懂位置改变",script:newScript()};
  const result=await tool.execute("call",args,new AbortController().signal,undefined,{} as Parameters<typeof tool.execute>[4]);
  assert.equal(result.details.explainer.goalId,"goal-1");assert.equal(result.details.explainer.taskId,"task-1");assert.ok(readExplainerPresentation(result.details.explainer));assert.deepEqual(context.snapshot(),before);
  const text=result.content[0]!;assert.equal(text.type,"text");if(text.type!=="text")throw new Error("Expected text");
  assert.ok(text.text.length<600);assert.equal(JSON.parse(text.text).script,undefined);assert.equal(JSON.parse(text.text).explainer,undefined);
  await assert.rejects(()=>tool.execute("call",{...args,script:null},undefined,undefined,{} as Parameters<typeof tool.execute>[4]),/校验失败/);
  const cli=createPresentExplainerTool(context,planning,{},"CLI");await assert.rejects(()=>cli.execute("call",args,undefined,undefined,{} as Parameters<typeof cli.execute>[4]),/没有互动讲解/);
  planning.start();await assert.rejects(()=>tool.execute("call",args,undefined,undefined,{} as Parameters<typeof tool.execute>[4]),/先完成目标确认/);
});

function richScript():ExplainerScript {
  return {title:"跟踪结构中的变化",canvas:{w:640,h:296},start:"start",stage:[
    {id:"arr",k:"cells",x:32,y:24,t:["2","1"]},{id:"bs",k:"bars",x:200,y:24,w:120,h:100,t:[2,3],lb:["甲","乙"],max:10},
    {id:"tb",k:"table",x:32,y:120,w:140,t:[["项","量"],["甲","2"]]},
    {id:"ln",k:"lines",x:32,y:192,t:["x=1","x+1=2"]},
    {id:"nd",k:"node",x:350,y:24,t:"A"},{id:"edge",k:"line",x:372,y:46,x2:432,y2:106},
    {id:"g",k:"plot",x:400,y:144,w:200,h:120,xr:[0,2],yr:[0,4],series:{曲线:{fn:"x^2",x:[0,2],n:3,lb:"平方"}}}
  ],nodes:{start:{label:"变化",ops:[["show","*"],["mark","arr",[0,1],"hot"],["swap","arr",0,1],["bar","bs",1,5],["row","tb",0],["row","ln",1],["mark","nd","all","done"],["draw","g","曲线"],["dot","g","曲线",1],["rotate","edge",90],["say","结构与数值各自按步骤变化。"]],end:true}}};
}
test("new shapes and actions share deterministic replay and expose partial transition endpoints",()=>{
  const script=validateExplainerScript(richScript()).script,state=replayExplainer(script,["start"],11,0).targetState;
  assert.deepEqual(state.elements.arr!.cells,["1","2"]);assert.deepEqual(state.elements.arr!.marks,{0:"hot",1:"hot"});assert.deepEqual(state.elements.bs!.values,[2,5]);
  assert.deepEqual(state.elements.tb!.rows,[true,false]);assert.deepEqual(state.elements.ln!.rows,[false,true]);assert.deepEqual(state.elements.nd!.marks,{all:"done"});
  assert.equal(state.elements.nd!.w,44);assert.equal(state.elements.edge!.rotation,90);assert.ok(state.elements.edge!.len!>80);
  assert.deepEqual(state.elements.g!.drawn,["曲线"]);assert.deepEqual(state.elements.g!.dots,{曲线:1});
  for(const [index,ms]of [[2,310],[3,400],[4,250],[7,650],[8,450]]){const f=replayExplainer(script,["start"],index!,ms!);assert.equal(f.transition,true);assert.equal(f.transitionProgress,.5);}
  const normalized=validateExplainerScript(script);assert.deepEqual(normalized.script,script);
});

test("v2 rejects wrong new-action types, out-of-range child access, and crossed-path pushes before playback",()=>{
  const bad:ExplainerOp[]=[["mark","nd",0,"hot"],["mark","arr",[0,9],"hot"],["mark","arr","all","bad"] as never,["swap","arr",0,2],["bar","bs",2,5],["bar","bs",0,-1],["bar","bs",0,11],["row","tb",9],["row","bs",0],["draw","g","missing"],["dot","g","曲线",3],["dot","g","曲线",NaN]];
  for(const op of bad){const s=richScript();s.nodes.start!.ops=[op];assert.throws(()=>validateExplainerScript(s),/校验失败/);}
  const branch=newScript();branch.nodes.right!.ops=[["push","out","右"]];branch.nodes.down!.ops=[["wait",0]];branch.nodes.end!.ops=[["mark","out",0,"hot"]];assert.throws(()=>validateExplainerScript(branch),/下标/);
  branch.nodes.down!.ops=[["push","out","下"]];assert.doesNotThrow(()=>validateExplainerScript(branch));
  const invalid=richScript();invalid.stage[1]!.t=[-1,2];assert.throws(()=>validateExplainerScript(invalid),/非负/);
});

test("math expressions use a bounded grammar with no executable code or hidden nonfinite intermediate",()=>{
  assert.deepEqual(sampleExplainerExpression("2^x",[0,2],3),[[0,1],[1,2],[2,4]]);
  assert.deepEqual(sampleExplainerExpression("max(abs(-x),sqrt(x))+sin(0)",[0,1],2),[[0,0],[1,1]]);
  assert.deepEqual(sampleExplainerExpression("pow(x,2)+cos(pi)",[0,2],3),[[0,-1],[1,0],[2,3]]);
  assert.deepEqual(sampleExplainerExpression("x",[0,1e-7],3),[[0,0],[5e-8,5e-8],[1e-7,1e-7]]);
  assert.ok(sampleExplainerExpression("x^2",[0,1e-7],3).at(-1)![1]>0);
  const tiny=richScript(),tinyPlot=tiny.stage.at(-1)!;tinyPlot.xr=[0,1e-7];tinyPlot.yr=[0,1e-7];tinyPlot.series={tiny:{fn:"x",x:[0,1e-7],n:3}};tiny.nodes.start!.ops=[["show","g"],["draw","g","tiny"],["dot","g","tiny",5e-8]];
  assert.equal(validateExplainerScript(tiny).script.stage.at(-1)!.series!.tiny!.pts![1]![0],5e-8);
  for(const expr of ["globalThis.alert(x)","x.constructor","Math.sin(x)","x=1","(()=>1)()","min(1/0,1)","pow(2,200)","sqrt(-1)","(".repeat(20)+"x"+")".repeat(20),Array(70).fill("x").join("+")])assert.throws(()=>sampleExplainerExpression(expr,[0,1],3));
  for(const mutate of [(e:any)=>e.series.曲线.n=1000000,(e:any)=>e.series.曲线.x=[0,0],(e:any)=>e.series.曲线={pts:[[0,1],[0,2]]},(e:any)=>e.series.曲线={pts:[[0,1],[1,NaN]]},(e:any)=>e.series.曲线={pts:[[0,1],[1,99]]}]){const s=richScript();mutate(s.stage.at(-1));assert.throws(()=>validateExplainerScript(s));}
});

test("v1 persisted snapshots retain their original validator, hash and pause semantics",()=>{
  const snapshot=validateLegacyExplainerScript({
    title:"一个点移动的位置",start:"start",stage:[{id:"dot",k:"box",x:24,y:24,w:50,h:30,t:"点"}],
    nodes:{start:{label:"移动",ops:[["show","dot"],["move","dot",100,24]],end:true}},
  });
  const artifact={...snapshot,id:"legacy-example",version:"1",skillVersion:"1.0.0",
    templateVersion:"explainer-v1",validatorVersion:"explainer-validator-v1"} as const;
  const saved={...presentation(),artifact:{...artifact,contentSha256:explainerArtifactHash(artifact)}};
  assert.ok(readExplainerPresentation(saved));
  const context=resolveExplainerContext(saved,{presentation_id:saved.id,source_entry_id:"legacy-entry",artifact_sha256:saved.artifact.contentSha256,scene_id:"start:1",scene_elapsed_ms:225,selected_object_id:null,explainer_path:["start"]});
  assert.equal(context.templateVersion,"explainer-v1");
  assert.equal(context.previousState.elements.dot?.x,24);
  assert.equal(context.targetState.elements.dot?.x,100);
  assert.equal(saved.artifact.contentSha256,readExplainerPresentation(saved)!.artifact.contentSha256);
  assert.equal(readExplainerPresentation({...saved,artifact:{...saved.artifact,validatorVersion:"explainer-validator-v2"}}),null);
});

test("v2 stage limits expand deliberately while crowded readable labels warn instead of losing their text",()=>{
  const expanded=newScript();expanded.stage.push(...Array.from({length:21},(_,i)=>({id:"extra"+i,k:"label" as const,x:0,y:0,t:"标记"})));
  assert.equal(expanded.stage.length,24);assert.ok(validateExplainerScript(expanded).warnings.some(w=>w.includes("14个")));
  expanded.stage.push({id:"tooMany",k:"label",x:0,y:0,t:"标记"});assert.throws(()=>validateExplainerScript(expanded),/24个/);
  const crowded=newScript(),text="左边是变量名，右边是类型";crowded.stage[0]={id:"item",k:"box",x:32,y:32,w:300,h:42,size:28,t:text};
  const result=validateExplainerScript(crowded);assert.equal(result.script.stage[0]!.t,text);assert.ok(result.warnings.some(w=>w.includes("文字可能挤出边框")));
});
