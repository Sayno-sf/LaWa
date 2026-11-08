import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,readdirSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import {bailianOrigin} from "../skills/lawa-illustrated-lesson/scripts/bailian.mjs";
import {LessonArtwork} from "./lessonArtwork.js";
import {createFigureBatch,placedFigures,resolveFigureQuestion} from "./lessonFigures.js";

const origin="https://test-space.cn-beijing.maas.aliyuncs.com";
const profile={id:"art",name:"测试",provider:"aliyun-bailian",model:"test",baseUrl:origin+"/compatible-mode/v1",
  thinkingLevel:"low" as const,maxOutputTokens:2000,hasApiKey:true,apiKeyHint:null};
const credentials={
  async getPublicSettings(){return {activeProfileId:null,active:profile,profiles:[profile]};},
  async getProfileCredentials(){return {profileId:profile.id,baseUrl:profile.baseUrl,apiKey:"test-fixture",revision:"1"};}
};
const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==","base64");
const scope={sessionId:"session",goalId:"goal",taskId:"task",skillId:"skill"};
const brief={key:"garden",alt:"树下的长椅",caption:"观察树冠覆盖的区域。",paint:"一幅花园里的钢笔水彩画"};
function envelope(url:string) {return Response.json({output:{choices:[{message:{content:[{image:url}]}}]}});}
async function waitState(store:LessonArtwork,id:string,state:string) {
  for(let i=0;i<200 && store.status(scope.sessionId,id)?.state!==state;i++) await delay(5);
  assert.equal(store.status(scope.sessionId,id)?.state,state);
}
test("a paid illustration uses a trusted Bailian profile once, downloads without the key, and reopens locally",async t=>{
  const directory=mkdtempSync(join(tmpdir(),"lawa-book-art-"));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  let posts=0,downloads=0;
  const fetcher:typeof fetch=async (url,init)=>{
    assert.equal(init?.redirect,"error");
    if(init?.method==="POST") {
      posts++;assert.equal(String(url),origin+"/api/v1/services/aigc/multimodal-generation/generation");
      assert.equal(new Headers(init.headers).get("Authorization"),"Bearer test-fixture");
      const body=JSON.parse(String(init.body));
      assert.equal(body.model,"qwen-image-2.0");assert.equal(body.parameters.n,1);
      assert.match(body.input.messages[0].content[0].text,/花园/);
      return envelope("https://dashscope-result-test.oss-cn-beijing.aliyuncs.com/image");
    }
    downloads++;assert.equal(new Headers(init?.headers).has("Authorization"),false);
    return new Response(new Uint8Array(bytes));
  };
  const store=new LessonArtwork(directory,credentials,fetcher);
  const [figure,other]=await Promise.all([store.request(scope,"entry",brief),store.request(scope,"entry",brief)]);
  assert.deepEqual(figure,other);
  await waitState(store,figure.art.id,"ready");
  assert.equal(posts,1);assert.equal(downloads,1);
  await assert.rejects(store.request({...scope,taskId:"changed"},"entry",brief),/本轮已委托/);
  await assert.rejects(store.request(scope,"entry",{...brief,paint:"另一幅画"}),/本轮已委托/);
  const restarted=new LessonArtwork(directory);
  assert.deepEqual(restarted.image(scope.sessionId,figure.art.id),bytes);
  assert.equal(restarted.status("other-session",figure.art.id),null);
  assert.equal(restarted.image(scope.sessionId,"../escape"),null);
  const record=readFileSync(join(directory,figure.art.id+".json"),"utf8");
  assert.doesNotMatch(record,/test-fixture|oss-cn-beijing|花园里的钢笔/);
  const batch=createFigureBatch([figure],scope);
  const anchors=[{role:"assistant",entryId:"public",figures:placedFigures(batch)}];
  const anchor={messageId:"public",batchId:batch.id,key:figure.key,tick:0};
  assert.throws(()=>resolveFigureQuestion(anchor,anchors,scope,()=>false),/尚未完成/);
  const resolved=resolveFigureQuestion(anchor,anchors,scope,id=>restarted.status(scope.sessionId,id)?.state==="ready");
  assert.equal(resolved.generated?.basis,"description_and_caption");
  assert.throws(()=>resolveFigureQuestion({...anchor,tick:1},anchors,scope,()=>true));
  assert.throws(()=>resolveFigureQuestion({...anchor,batchId:"foreign"},anchors,scope,()=>true));
  restarted.purgeGoal("other-goal");assert.deepEqual(restarted.image(scope.sessionId,figure.art.id),bytes);
  restarted.purgeGoal(scope.goalId);assert.deepEqual(readdirSync(directory),[]);
});
test("an invalid provider result cannot redirect to another host or trigger automatic rebilling",async t=>{
  const directory=mkdtempSync(join(tmpdir(),"lawa-book-failure-"));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  assert.equal(bailianOrigin("https://dashscope.aliyuncs.com.invalid"),null);
  assert.equal(bailianOrigin("https://someone@dashscope.aliyuncs.com"),null);
  assert.equal(bailianOrigin("http://dashscope.aliyuncs.com"),null);
  let calls=0;
  const store=new LessonArtwork(directory,credentials,async()=>{calls++;return envelope("https://invalid.example/private");});
  const figure=await store.request(scope,"entry",brief);
  await waitState(store,figure.art.id,"failed");
  assert.equal(store.image(scope.sessionId,figure.art.id),null);
  assert.deepEqual(await store.request(scope,"entry",brief),figure);
  assert.equal(calls,1);
});
