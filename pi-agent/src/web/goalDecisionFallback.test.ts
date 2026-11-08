import assert from "node:assert/strict";
import test from "node:test";
import {fauxAssistantMessage, fauxToolCall} from "@earendil-works/pi-ai";
import {WebSessionStore} from "./sessionStore.js";
import {createRecordGoalUnderstandingTool} from "../planning/planningTools.js";
import {createLearnerQuestionTool} from "../learnerQuestionTool.js";
import type {LearningOverview} from "../learningOverviewTool.js";

const profile={id:"fallback-boundary",goal_description:"理解隔离草案",background_summary:"初学",desired_outcome:"解释一个概念",
  learning_preferences:[],time_constraint:"",prior_knowledge_claims:[]};
const empty:LearningOverview={current_goal:null,goal_profile:null,curriculum_spine:[],skills:[],recent_evidence:[],
  current_frontier:null,current_focus:null,active_task:null,current_goal_skill_ids:[],learning_history:[]};

type Mode="background"|"model_error"|"stopped"|"late-stop";
async function boundary(mode:Mode){
  let modelCompleted=false,gated=false,releaseOverview:(()=>void)|undefined,enteredOverview!:()=>void;
  const waitingForOverview=new Promise<void>(resolve=>{enteredOverview=resolve;});
  const store=new WebSessionStore({fetchOverview:async()=>{
    if(mode==="late-stop"&&modelCompleted&&!gated){
      gated=true;enteredOverview();
      return new Promise<LearningOverview>(resolve=>{releaseOverview=()=>resolve(structuredClone(empty));});
    }
    return structuredClone(empty);
  },fetchLibrary:async()=>({projects:[]}),log:()=>{},createAgent:async(context,planning,_emit,manager)=>({
    prompt:async text=>{
      manager.appendMessage({role:"user",content:text,timestamp:Date.now()});
      const params={outcome:"READY_FOR_CONFIRMATION" as const,profile};
      manager.appendMessage(fauxAssistantMessage(fauxToolCall("record_goal_understanding",params,{id:"ready"}),{stopReason:"toolUse"}));
      const tool=createRecordGoalUnderstandingTool(planning);
      const result=await tool.execute("ready",params,new AbortController().signal,undefined,{} as Parameters<typeof tool.execute>[4]);
      manager.appendMessage({role:"toolResult",toolName:"record_goal_understanding",toolCallId:"ready",content:result.content,isError:false,timestamp:Date.now()});
      if(mode==="background"){
        const question=createLearnerQuestionTool(context,planning);
        await question.execute("background",{purpose:"BACKGROUND",questions:[{id:"background",prompt:"哪些基础还需说明？",selection:"freeform",options:[]}]},
          new AbortController().signal,undefined,{} as Parameters<typeof question.execute>[4]);
      }
      manager.appendMessage(fauxAssistantMessage("目标草案已说明，未调用确认组件。"));modelCompleted=true;
      return {status:mode==="model_error"?"model_error" as const:mode==="stopped"?"stopped" as const:"completed" as const};
    },abort:async()=>{},dispose:()=>{},
  })});
  try{
    const session=await store.create("new-goal");
    const pending=store.sendMessage(session.sessionId,"建立这个新目标",()=>{});
    if(mode==="late-stop"){
      // 真正的Store结束边界：模型已经completed，但最后一次权威读取仍在等待；此时用户停止。
      await waitingForOverview;await store.stop(session.sessionId);releaseOverview!();
    }
    await pending;
    const state=await store.state(session.sessionId);
    assert.equal(state.onboarding.status,"READY_FOR_CONFIRMATION","成功保存的草案内容保留，不从失败/停止恢复用户同意");
    assert.deepEqual(state.onboarding.pending_profile,profile);
    assert.equal(state.teaching.learner_questions?.pending?.purpose,mode==="background"?"BACKGROUND":undefined,
      "已有询问不覆盖，失败或停止后不能补出新的确认卡");
    assert.equal(state.overview.current_goal,null);assert.equal(state.overview.active_task,null);
    assert.deepEqual(state.overview.recent_evidence,[]);
  }finally{releaseOverview?.();store.dispose();}
}

for(let repetition=1;repetition<=2;repetition++){
  test(`confirmation fallback preserves an existing BACKGROUND question (repeat ${repetition})`,()=>boundary("background"));
  test(`confirmation fallback does not run after model failure (repeat ${repetition})`,()=>boundary("model_error"));
  test(`confirmation fallback does not run after stopped model (repeat ${repetition})`,()=>boundary("stopped"));
  test(`stop during final overview read prevents a new confirmation card (repeat ${repetition})`,()=>boundary("late-stop"));
}
