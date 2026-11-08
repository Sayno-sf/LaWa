import assert from "node:assert/strict";
import test from "node:test";
import {createServer} from "node:http";
import {once} from "node:events";
import {fauxAssistantMessage} from "@earendil-works/pi-ai";
import type {SessionManager} from "@earendil-works/pi-coding-agent";
import {createGateway} from "./gateway.js";
import {WebSessionStore} from "./sessionStore.js";
import type {LearningOverview} from "../learningOverviewTool.js";
import type {RetrievalRuntime} from "../retrieval/runtime.js";

for(let repetition=1;repetition<=2;repetition++) test(`HTTP429 before Gateway admission never appends a Pi answer; explicit retry remains idempotent (${repetition})`,async()=>{
  const overview:LearningOverview={current_goal:"理解库存变化",goal_profile:{id:"goal"},curriculum_spine:[],current_frontier:{focus_skill_id:"skill"},
    current_focus:null,active_task:{id:"task",goal_id:"goal",status:"ACTIVE",related_skill_ids:["skill"]},
    skills:[{id:"skill",name:"库存判读",status:"LEARNING"}],recent_evidence:[],learning_history:[],current_goal_skill_ids:["skill"]};
  let manager!:SessionManager, modelTurns=0, rejected=true;
  const store=new WebSessionStore({fetchOverview:async()=>overview,fetchLibrary:async()=>({projects:[]}),
    createAgent:async(context,_planning,emit,current)=>{
      manager=current;
      return {prompt:async text=>{
        modelTurns++;current.appendMessage({role:"user",content:text,timestamp:Date.now()});
        if(text==="prepare") context.learnerQuestions.ask({id:"original-question",purpose:"CHECK",session_id:context.getSessionId(),goal_id:"goal",task_id:"task",skill_id:"skill",
          questions:[{id:"stock",prompt:"库存初始10，扣3和2分别写回旧值结果，最终多少？",selection:"freeform",options:[]}]});
        current.appendMessage(fauxAssistantMessage(text==="prepare"?"请回答原题。":"原回答已接收。"));
        emit({type:"assistant_delta",delta:text==="prepare"?"请回答原题。":"原回答已接收。"});
      },abort:async()=>undefined,dispose:()=>undefined};
    }});
  const gateway=createGateway({store,retrieval:{scopeChanged:()=>undefined} as unknown as RetrievalRuntime});
  const front=createServer((req,res)=>{
    if(rejected&&req.method==="POST"&&req.url?.endsWith("/messages")) {
      req.resume();res.writeHead(429,{"Content-Type":"application/json"});res.end(JSON.stringify({detail:"isolated admission rejection"}));return;
    }
    gateway.emit("request",req,res);
  });
  front.listen(0,"127.0.0.1");await once(front,"listening");
  try {
    const address=front.address();assert.ok(address&&typeof address==="object");const base=`http://127.0.0.1:${address.port}`;
    const session=await store.create("new");await store.sendMessage(session.sessionId,"prepare",()=>undefined);
    const before=manager.getBranch().filter(row=>row.type==="message"&&row.message.role==="user").length;
    const state=await store.state(session.sessionId);
    const body={message:"",learner_reply:{request_id:"original-question",answers:[{question_id:"stock",selected_option_ids:[],other_text:"最终8，正确应剩5，旧值覆盖造成差额。"}]},
      request_id:`original-submit-${repetition}`,expected_version:state.classroom_version};
    const post=()=>fetch(`${base}/api/web/sessions/${session.sessionId}/messages`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const denied=await post();assert.equal(denied.status,429);await denied.text();
    assert.equal(manager.getBranch().filter(row=>row.type==="message"&&row.message.role==="user").length,before);
    assert.equal(modelTurns,1,"denied delivery never reaches a teacher model turn");
    assert.equal((await store.state(session.sessionId)).feedback_recovery,null,"no saved turn can truthfully have a feedback recovery ticket");
    assert.equal((await store.state(session.sessionId)).teaching.learner_questions?.pending?.id,"original-question");
    rejected=false;
    const delivered=await post();assert.equal(delivered.status,200);await delivered.text();
    // Consume all stream output before asserting authoritative persisted Pi/context state.
    const duplicate=await post();assert.equal(duplicate.status,200);await duplicate.text();
    assert.equal(modelTurns,2,"one explicit delivery and a duplicate transport request produce only one new model turn");
    assert.equal(manager.getBranch().filter(row=>row.type==="message"&&row.message.role==="user").length,before+1);
    assert.deepEqual((await store.state(session.sessionId)).teaching.learner_questions?.last_answer?.reply,body.learner_reply);
  } finally {store.dispose();front.closeAllConnections();await new Promise<void>(done=>front.close(()=>done()));await new Promise<void>(done=>gateway.close(()=>done()));}
});
