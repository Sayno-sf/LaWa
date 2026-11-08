import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {animationArtifactHash,animationTeachingPrompt,getAnimationArtifact,listAnimationArtifacts,readAnimationPresentation,validateAnimationLesson} from "./animationCatalog.js";
import {resolveAnimationContext} from "./animationContext.js";
import {parseAnimationAnchor,type AnimationAnchor,type AnimationPresentation,type CallStackState,type LinearBalanceState} from "./animationTypes.js";
import {createPresentAnimationTool} from "./animationPresentationTool.js";
import {TeachingSessionContext} from "./teachingSession.js";
import {GoalOnboardingContext} from "./planning/goalOnboarding.js";

function presentation(id="factorial-3-return"):AnimationPresentation {
  return {id:"presentation-1",sourceSessionId:"session-1",goalId:"goal-1",taskId:"task-1",skillId:"skill-1",artifact:getAnimationArtifact(id)};
}
function anchor(p=presentation()):AnimationAnchor {
  return {presentation_id:p.id,source_entry_id:"entry-1",artifact_sha256:p.artifact.contentSha256,scene_id:"base_case",scene_elapsed_ms:800,selected_object_id:null};
}

test("catalog independently checks the two retained DeepSeek lesson snapshots and installed version",()=>{
  const artifacts=listAnimationArtifacts();assert.equal(artifacts.length,2);
  assert.equal(getAnimationArtifact("factorial-3-return").validation.expected,6);
  const linear=getAnimationArtifact("linear-2x-plus3");assert.equal(linear.validation.expected,4);
  assert.match(linear.validation.canonicalQuestion,/最终 x/);
  assert.throws(()=>getAnimationArtifact("made-up"),/尚未登记/);
  const manifest=JSON.parse(readFileSync(new URL("../resources/legacy-animation/manifest.json",import.meta.url),"utf8"));
  assert.equal(manifest.version,artifacts[0]!.skillVersion);
  for (const [file,expected] of Object.entries(manifest.files_sha256))
    assert.equal(createHash("sha256").update(readFileSync(new URL("../resources/legacy-animation/"+file,import.meta.url))).digest("hex"),expected);
  const prompt=animationTeachingPrompt("WEB");assert.match(prompt,/0\.3\.0/);assert.match(prompt,/按需加载/);assert.ok(prompt.length<500);
  assert.match(prompt,/factorial-3-return/);assert.match(prompt,/2x\+3=11/);assert.match(prompt,/正常课堂仍自然回复/);
  assert.match(animationTeachingPrompt("CLI"),/不调用present_teaching_animation/);
});

test("one-sided operations, divide zero, skipped calls and wrong multiplication fail before presentation",()=>{
  const linear=getAnimationArtifact("linear-2x-plus3").lesson;
  (linear.scenes[1]!.state as LinearBalanceState).equation[3]=11;
  assert.throws(()=>validateAnimationLesson(linear),/同一变形/);
  const zero=getAnimationArtifact("linear-2x-plus3").lesson;
  (zero.scenes[3]!.state as LinearBalanceState).operand=0;
  assert.throws(()=>validateAnimationLesson(zero),/除零/);
  const skip=getAnimationArtifact("factorial-3-return").lesson;skip.scenes.splice(2,1);
  assert.throws(()=>validateAnimationLesson(skip),/基例/);
  const multiply=getAnimationArtifact("factorial-3-return").lesson;
  (multiply.scenes[4]!.state as CallStackState).return_value=3;
  assert.throws(()=>validateAnimationLesson(multiply),/乘法错误/);
});

test("prediction identity is independently derived and already revealed answers are rejected",()=>{
  const lesson=getAnimationArtifact("linear-2x-plus3").lesson;
  lesson.checkpoint.prompt="2x等于多少？";
  const {validation}=validateAnimationLesson(lesson);
  assert.equal(validation.expected,4);assert.match(validation.canonicalQuestion,/最终 x/);
  lesson.checkpoint.after_scene="divide";assert.throws(()=>validateAnimationLesson(lesson),/已显示答案/);
  const duplicate=getAnimationArtifact("factorial-3-return").lesson;
  duplicate.checkpoint.options[0]!.value=6;assert.throws(()=>validateAnimationLesson(duplicate),/恰好一个/);
});

test("saved snapshots are immutable, hash-checked, and do not need the current catalog alias",()=>{
  const original=presentation(),saved=structuredClone(original);
  const another=getAnimationArtifact("factorial-3-return");another.lesson.title="mutated returned object";
  assert.equal(readAnimationPresentation(saved)?.artifact.lesson.title,original.artifact.lesson.title);
  saved.artifact.lesson.scenes[0]!.caption="changed without version hash";
  assert.equal(readAnimationPresentation(saved),null);
  const retired=presentation();retired.artifact.id="retired-reviewed-version";retired.artifact.version="older";
  const {contentSha256:_,...body}=retired.artifact;retired.artifact.contentSha256=animationArtifactHash(body);
  assert.ok(readAnimationPresentation(retired));
  const wrongExpected=presentation();wrongExpected.artifact.validation.expected=99;
  const {contentSha256:__,...wrong}=wrongExpected.artifact;wrongExpected.artifact.contentSha256=animationArtifactHash(wrong);
  assert.equal(readAnimationPresentation(wrongExpected),null);
});

test("an animation anchor permits only finite positions and no client-provided facts or object IDs",()=>{
  assert.deepEqual(parseAnimationAnchor(anchor()),anchor());
  for (const value of [NaN,Infinity,-1,"1",true]) assert.throws(()=>parseAnimationAnchor({...anchor(),scene_elapsed_ms:value}));
  assert.throws(()=>parseAnimationAnchor({...anchor(),target_state:{frames:[]}}),/自定义事实/);
  assert.throws(()=>parseAnimationAnchor({...anchor(),selected_object_id:"invented"}),/对象选择/);
  for (const change of [{scene_id:"missing"},{scene_elapsed_ms:6001},{artifact_sha256:"a".repeat(64)},{presentation_id:"other"}])
    assert.throws(()=>resolveAnimationContext(presentation(),{...anchor(),...change}));
});

test("pause context distinguishes a transition from its target and preserves the base frame",()=>{
  const p=presentation(),context=resolveAnimationContext(p,anchor(p));
  assert.equal(context.transition,true);assert.ok(context.transitionProgress>0 && context.transitionProgress<1);
  assert.deepEqual((context.previousState as CallStackState).frames,[3,2,1]);
  assert.equal((context.previousState as CallStackState).return_value,null);
  assert.deepEqual((context.targetState as CallStackState).frames,[3,2,1]);
  assert.equal((context.targetState as CallStackState).return_value,1);
  assert.deepEqual(context.scope,{goalId:"goal-1",taskId:"task-1",skillId:"skill-1"});
  assert.deepEqual(context.verifiedStep,{kind:"base",currentCall:1,returnValue:1,frameRemoved:false,frames:[3,2,1]});
  assert.deepEqual(context.nextVerifiedStep,{kind:"return",returningCall:1,receivingCall:2,transferredValue:1,receiverResult:2,remainingFrames:[3,2]});
  assert.match(context.observation,/没有截图/);
  assert.equal(resolveAnimationContext(p,{...anchor(p),scene_elapsed_ms:2000}).transition,false);
  (context.targetState as CallStackState).frames.length=0;
  assert.deepEqual((p.artifact.lesson.scenes[3]!.state as CallStackState).frames,[3,2,1]);
});

const overview={current_goal:"测试学习",goal_profile:{id:"goal-1"},curriculum_spine:[],current_frontier:null,current_focus:null,
  skills:[{id:"skill-1"}],recent_evidence:[],active_task:{id:"task-1",status:"ACTIVE",related_skill_ids:["skill-1"]},current_goal_skill_ids:["skill-1"],learning_history:[]};
test("presentation tool derives scope from the active task and changes no teaching state",async()=>{
  const context=new TeachingSessionContext();context.bindSession("session-1");const planning=new GoalOnboardingContext();
  const before=context.snapshot(),tool=createPresentAnimationTool(context,planning,{fetchImpl:async()=>Response.json(overview),log:()=>{}});
  const result=await tool.execute("call",{artifact_id:"factorial-3-return",teaching_goal:"理解返回"},new AbortController().signal,undefined,{} as Parameters<typeof tool.execute>[4]);
  assert.deepEqual(context.snapshot(),before);assert.equal(result.details.animation.goalId,"goal-1");
  assert.equal(result.details.animation.taskId,"task-1");assert.equal(result.details.animation.sourceSessionId,"session-1");
  assert.ok(readAnimationPresentation(result.details.animation));
  const cli=createPresentAnimationTool(context,planning,{fetchImpl:async()=>{throw new Error("must not fetch");}},"CLI");
  await assert.rejects(()=>cli.execute("call",{artifact_id:"factorial-3-return",teaching_goal:"解释"},new AbortController().signal,undefined,{} as Parameters<typeof cli.execute>[4]),/没有教学动画/);
  planning.start();
  await assert.rejects(()=>tool.execute("call",{artifact_id:"factorial-3-return",teaching_goal:"解释"},new AbortController().signal,undefined,{} as Parameters<typeof tool.execute>[4]),/先完成目标确认/);
});
