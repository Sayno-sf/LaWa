import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLearningAgentSession } from "./agentSession.js";
import { GoalOnboardingContext } from "./planning/goalOnboarding.js";
import { AssistantStore } from "./assistantStore.js";
import type { AssistantAssistance, AssistantConsultation, AssistantHelpKind, AssistantScope } from "./assistantTypes.js";
import { TeachingSessionContext } from "./teachingSession.js";
import { TeacherAssistantSupport } from "./teacherAssistantSupport.js";

const scope: AssistantScope = {goalId:"goal-a",taskId:"task-a",skillId:"skill-a",mainSessionId:"main-a",branchId:"branch-a",questionId:"q-a",attemptId:"attempt-a"};
function record(kind: AssistantHelpKind, id = "help-a"): AssistantConsultation {
  return {id,scope:{...scope},userMessageId:"user-a",assistantMessageId:"reply-a",question:"怎样理解参数共享？",reply:"同一个卷积核在不同位置重复使用，因此参数不随图片位置变化。",
    createdAt:"2026-10-12T01:00:00Z",status:"COMPLETED",delivery:"CONFIRMED",classification:{kind,reason:"实际解释当前知识点",replyQuote:"同一个卷积核"},sequence:2};
}
function assistance(records: AssistantConsultation[] = [], priors: AssistantConsultation[] = []): AssistantAssistance {
  return {kind:records[0]?.classification.kind ?? "NONE",revision:"revision-a",summary:JSON.stringify({storage_unknown:false}),records,priorRecords:priors,
    unknown:false,hasHelp:records.length > 0,truncated:false};
}
function setup(initial = assistance()) {
  let current = initial;
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry("lawa.assessment-attempt", {scope,question:"解释卷积核参数共享如何减少参数数量。"});
  const support = new TeacherAssistantSupport({read:async()=>structuredClone(current)}, manager);
  const invoke = async (name: string, params: Record<string, unknown>) => {
    const tool = support.tools().find(item=>item.name === name)!;
    return tool.execute("tool-a", params as never, new AbortController().signal, undefined, {} as Parameters<typeof tool.execute>[4]);
  };
  return {manager,support,invoke,set:(value:AssistantAssistance)=>{current = value;}};
}

test("automatic classifications and unavailable history are advisory, not a minimum or permission state", async()=> {
  const prior = record("ANSWER"); prior.scope.questionId="previous-question";
  const {support,set}=setup(assistance([], [prior]));
  const summary=JSON.parse((await support.assessment()).summary);
  assert.equal(summary.advisory_only,true);
  assert.equal(summary.records[0].automatic_classification,"ANSWER");
  assert.equal(summary.help_floor,undefined);
  assert.match(await support.promptSummary(),/不必先绑定题目/);
  const corrupt=assistance();corrupt.unknown=true;corrupt.summary='{"storage_unknown":true}';set(corrupt);
  assert.equal((await support.assessment()).unknown,true);
  assert.match(await support.promptSummary(),/不因此一律阻止写入/);
});

test("teacher may correct classification or same-attempt relevance without rewriting the TA record", async()=> {
  const exact=record("UNKNOWN"),{support,invoke}=setup(assistance([exact]));
  const review={consultation_id:exact.id,relevance:"RELATED",help_kind:"CLARIFICATION",reply_quote:"同一个卷积核",question_quote:"参数数量",reason:"主教师核对真实题面后判断这是澄清，并未提供本题推导"};
  await assert.rejects(()=>invoke("review_assistant_consultations",{reviews:[review]}),/先回读/);
  await invoke("read_assistant_consultations",{consultation_id:exact.id});
  await invoke("review_assistant_consultations",{reviews:[review]});
  let row=JSON.parse((await support.assessment()).summary).records[0];
  assert.equal(row.automatic_classification,"UNKNOWN");assert.equal(row.teacher_review.helpKind,"CLARIFICATION");
  await invoke("review_assistant_consultations",{reviews:[{...review,relevance:"UNRELATED"}]});
  row=JSON.parse((await support.assessment()).summary).records[0];
  assert.equal(row.teacher_review.relevance,"UNRELATED");assert.equal(exact.classification.kind,"UNKNOWN");
});

test("optional review works with actual conversational question and no formal attempt", async()=> {
  const row=record("ANSWER"),manager=SessionManager.inMemory();
  manager.appendMessage(fauxAssistantMessage("解释 bind 绑定 this 的行为。"));
  manager.appendMessage({role:"user",content:"bind 固定 this。",timestamp:Date.now()});
  const support=new TeacherAssistantSupport({read:async()=>assistance([], [row])},manager);
  const invoke=async(name:string,params:Record<string,unknown>)=>{const tool=support.tools().find(t=>t.name===name)!;return tool.execute("review",params as never,undefined,undefined,{} as never);};
  await invoke("read_assistant_consultations",{});
  const reviews=[{consultation_id:row.id,relevance:"UNRELATED",help_kind:"ANSWER",reply_quote:"同一个卷积核",question_quote:"bind",reason:"原答疑是卷积参数共享，当前实际题目是函数 this 绑定"}];
  await invoke("review_assistant_consultations",{current_question:"解释 bind 绑定 this 的行为。",reviews});
  await assert.rejects(()=>invoke("review_assistant_consultations",{current_question:"伪造题面",reviews}),/真实题目/);
});

test("original reads stay bounded and task scoped; reviews cannot fabricate quotes", async()=> {
  const long=record("HINT");long.reply="同一个卷积核".repeat(6000);
  const {invoke,support,set}=setup(assistance([long]));
  const result=await invoke("read_assistant_consultations",{});
  const output=JSON.parse(result.content[0]!.type === "text" ? result.content[0]!.text : "");
  assert.equal(output.records[0].reply_omitted,true);assert.equal(output.records[0].reply.length,12000);
  assert.match(await support.promptSummary(),/reply_omitted/);
  await assert.rejects(()=>invoke("read_assistant_consultations",{consultation_id:"another-task"}),/当前学习任务/);
  const review={consultation_id:long.id,relevance:"RELATED",help_kind:"HINT",reply_quote:"伪造的原文",question_quote:"参数数量",reason:"具体说明原问答与当前题面的真实关系"};
  await assert.rejects(()=>invoke("review_assistant_consultations",{reviews:[review]}),/真实助教/);
  long.status="DELETED";long.reply="";set(assistance([], [long]));
  await assert.rejects(()=>invoke("review_assistant_consultations",{reviews:[review]}),/已清空/);
});

for (const historyCase of ["previous-answer", "unknown", "unavailable", "changed-after-candidate", "same-text"] as const) test(`real Agent: ${historyCase} cannot veto teacher judgment; Candidate guard remains`, async()=> {
  const directory=mkdtempSync(join(tmpdir(),"lawa-ta-cli-")), previousDirectory=process.env.WEB_SESSION_DIR;
  process.env.WEB_SESSION_DIR=directory;
  const store=new AssistantStore({rootDir:join(directory,"assistants")});
  const help=record("ANSWER"); help.question="空数组 map 会执行什么？"; help.reply="回调不会执行，返回新的空数组。"; help.classification.replyQuote=help.reply;
  await store.send(scope,"帮助理解参数共享",{},()=>undefined,async options=>({prompt:async()=>options.onEvent({type:"assistant_delta",delta:help.reply}),
    classify:async()=>help.classification,abort:async()=>{},dispose:()=>{}}));
  let writes=0;
  const server=createServer((request,response)=>{
    response.setHeader("Content-Type","application/json");
    if(request.url==="/api/learning/overview") response.end(JSON.stringify({current_goal:"卷积学习",goal_profile:{id:"goal-a"},current_frontier:null,current_focus:null,
      active_task:{id:"task-a",status:"ACTIVE",related_skill_ids:["skill-a"]},skills:[{id:"skill-a"}],current_goal_skill_ids:["skill-a"],curriculum_spine:[],recent_evidence:[],learning_history:[]}));
    else if(request.method==="POST") {
      writes++;let body="";request.on("data",part=>{body+=part});request.on("end",()=>response.end(JSON.stringify({...JSON.parse(body),id:"isolated-evidence",created_at:"2026-10-12T02:00:00Z"})));
    }
    else {response.statusCode=404;response.end("{}");}
  });
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
  const address=server.address();assert.ok(address&&typeof address!=="string");
  const manager=SessionManager.inMemory(); // 普通师生对话没有正式 attempt 标记，仍可判断新题表现。
  let history=assistance([], [help]);
  if(historyCase === "unknown") {help.classification.kind="UNKNOWN";help.status="INTERRUPTED";history.unknown=true;}
  const faux=createFauxCore({tokensPerSecond:0});
  faux.setResponses([
    ()=>fauxAssistantMessage([
      fauxToolCall("submit_evidence",{skill_id:"skill-a",evidence_type:"EXPLAIN",description:"回答",assistance_level:"INDEPENDENT",source:"cli-report"},{id:"custom"}),
      fauxToolCall("submit_evidence",{skill_id:"skill-a",evidence_type:"EXPLAIN",description:"回答",assistance_level:"TRANSFERRED",source:"interactive-teaching-session"},{id:"interactive"}),
    ],{stopReason:"toolUse"}),
    current=>{
      if(historyCase!=="unavailable") assert.match(JSON.stringify(current),/空数组/);
      assert.match(JSON.stringify(current),/advisory_only/);
      assert.match(JSON.stringify(current.messages),/Candidate/);
      assert.equal(writes,1,"TA history must not veto the teacher's independent judgment");
      return fauxAssistantMessage(fauxToolCall("record_teaching_turn",{active_skill_id:"skill-a",active_task_id:"task-a",teaching_mode:"QUIZ",outcome:"CORRECT",
        candidate_evidence:{evidence_type:"EXPLAIN",description:"本题真实输出",supporting_interaction_summary:"主教师判断旧 map 求助与本题无关",assistance_level:"INDEPENDENT"}},{id:"candidate"}),{stopReason:"toolUse"});
    },
    current=>{
      const message=current.messages.findLast(row=>row.role==="toolResult" && row.toolName==="record_teaching_turn");
      assert.ok(message && message.role==="toolResult");
      const candidate=JSON.parse(message.content.filter(row=>row.type==="text").map(row=>row.text).join("" )).candidate_evidence;
      assert.equal(candidate.assistance_level,"INDEPENDENT");
      if(historyCase==="changed-after-candidate") history={...history,revision:"new-after-candidate",unknown:true};
      return fauxAssistantMessage(fauxToolCall("submit_evidence",candidate,{id:"candidate-write"}),{stopReason:"toolUse"});
    },
    ()=>{assert.equal(writes,2);return fauxAssistantMessage(fauxToolCall("submit_evidence",{skill_id:"skill-a",evidence_type:"EXPLAIN",description:"另一表现确实得到提示",assistance_level:"WITH_HINT",source:"cli-report"},{id:"actual-help"}),{stopReason:"toolUse"});},
    ()=>fauxAssistantMessage("本题证据已按实际帮助保存。"),
  ]);
  const runtime=await ModelRuntime.create({authPath:join(directory,"auth.json"),modelsPath:null,modelsStorePath:join(directory,"models.json"),allowModelNetwork:false,refreshOnCreate:false});
  runtime.streamSimple=faux.streamSimple;runtime.hasConfiguredAuth=provider=>provider===faux.getModel().provider;
  runtime.getAuth=async()=>({auth:{apiKey:"isolated-faux-key"},env:{}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  let agent:Awaited<ReturnType<typeof createLearningAgentSession>>|undefined;
  try {
    agent=await createLearningAgentSession(new TeachingSessionContext(),new GoalOnboardingContext(),{surface:"CLI",apiBaseUrl:`http://127.0.0.1:${address.port}`,
      model:faux.getModel(),modelRuntime:runtime,sessionManager:manager,retrieval:false,log:()=>undefined,
      ...(historyCase!=="previous-answer"?{assistantSupport:{read:async()=>{if(historyCase==="unavailable") throw new Error("fixture unreadable");return history;}}}:{})});
    await agent.prompt(historyCase==="same-text"?help.reply:"bind 固定了 this，箭头函数捕获外层 this。这是我的实际回答。");
    assert.equal(writes,3);assert.equal(faux.state.callCount,5);
  } finally {
    agent?.dispose();await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));
    if(previousDirectory===undefined) delete process.env.WEB_SESSION_DIR;else process.env.WEB_SESSION_DIR=previousDirectory;
    rmSync(directory,{recursive:true,force:true});
  }
});
