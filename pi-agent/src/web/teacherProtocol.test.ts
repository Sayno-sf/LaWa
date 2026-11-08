import assert from "node:assert/strict";
import test from "node:test";
import {join} from "node:path";
import {ModelRuntime, type SessionManager} from "@earendil-works/pi-coding-agent";
import {createFauxCore, fauxAssistantMessage, fauxToolCall, type Context} from "@earendil-works/pi-ai";
import {createLearningAgentSession} from "../agentSession.js";
import {WebSessionStore, type WebSessionEvent} from "./sessionStore.js";
import {startGrowthPreview} from "../../scripts/growthPreview.js";
import {teachingPreferenceSnapshot} from "../teachingPreferences.js";
import {BEGIN_REPLY, QUESTION_DELIVERY, teacherVisibility} from "../teacherTurn.js";
import {readFileSync} from "node:fs";

const check = {purpose:"CHECK", active_skill_id:"a", active_task_id:"ta", assessment_criteria:[{label:"说明转换条件",possible:10}],
  questions:[{id:"conversion",prompt:"2 + '3' 的结果是什么？为什么？",selection:"freeform",options:[]}]};

test("action-phase text cannot claim a delivered question without a durable question",async()=>fixture(async f=>{
  f.faux.setResponses([fauxAssistantMessage("题卡在下面，请作答。"),fauxAssistantMessage("题卡在下面，请作答。")]);
  const session=await f.store.create(); const events:WebSessionEvent[]=[];
  await f.store.sendMessage(session.sessionId,"请出题",e=>events.push(e));
  assert.equal(events.some(e=>e.type==="assistant_delta"),false,"unconfirmed action-phase text leaked to the classroom");
  assert.equal((await f.store.sharedClassroom()).session!.messages.some(m=>m.content.includes("题卡在下面")),false);
  assert.equal(f.inputs.length,2,"the omitted phase gets one recovery attempt");
  assert.equal(f.store.classroom.snapshot()?.status,"interrupted");
}));

const begin = () => fauxAssistantMessage(fauxToolCall(BEGIN_REPLY,{}),{stopReason:"toolUse"});

test("a tool-free reply that misses the public phase recovers once on the same learner turn",async()=>fixture(async f=>{
  const explanation="加号遇到字符串时会把另一侧转成字符串，再把两段拼起来。";
  f.faux.setResponses([fauxAssistantMessage("这个准备阶段的草稿不能出现在课堂。"),begin(),fauxAssistantMessage(explanation)]);
  const session=await f.store.create(),events:WebSessionEvent[]=[];
  await f.store.sendMessage(session.sessionId,"解释加号",e=>events.push(e));
  const deltas=events.flatMap(e=>e.type==="assistant_delta"?[e.delta]:[]);
  assert.ok(deltas.length>1);
  assert.equal(deltas.join(""),explanation);
  assert.equal(f.store.classroom.snapshot()?.status,"completed");
  assert.equal(events.some(e=>e.type==="question_ready" || e.type==="model_error"),false);
  const saved=(await f.store.sharedClassroom()).session!.messages;
  assert.equal(saved.filter(m=>m.role==="user").length,1);
  assert.doesNotMatch(saved.map(m=>m.content).join("\n"),/准备阶段的草稿/);
  const recoveredInput = JSON.stringify(f.inputs[1]?.messages);
  assert.match(recoveredInput,/解释加号/);
  assert.doesNotMatch(recoveredInput,/准备阶段的草稿|系统恢复讲解阶段/);
  assert.deepEqual(f.inputs.at(-1)?.tools,[]);
}));
const animationPlate={key:"track",alt:"点的位置",caption:"观察一来一回。",view:[200,100],
  ink:[["circle",{id:"dot",cx:20,cy:50,r:4}]],motion:[
    {seconds:2,say:"向右走。",to:{dot:{cx:120}}},{seconds:2,say:"沿原路回来。",to:{dot:{cx:20}}}]};

test("a complete saved narrated animation publishes the next native reply without an extra model handshake",async()=>fixture(async f=>{
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("load_learning_skill",{name:"lawa-illustrated-lesson"}),{stopReason:"toolUse"}),
    fauxAssistantMessage(fauxToolCall("prepare_lesson_figures",{require_motion:true,figures:[animationPlate]}),{stopReason:"toolUse"}),
    fauxAssistantMessage("先看行进方向。\n\n![点](lawa-figure:track)\n\n它回到了起点。")
  ]);
  const s=await f.store.create(),events:WebSessionEvent[]=[];
  await f.store.sendMessage(s.sessionId,"用动画讲解",e=>events.push(e));
  assert.equal(f.store.classroom.snapshot()?.status,"completed");
  assert.ok(events.filter(e=>e.type==="assistant_delta").length>1);
  assert.equal((await f.store.sharedClassroom()).session?.messages.at(-1)?.figures?.length,1);
  assert.deepEqual(f.inputs.at(-1)?.tools,[]);
  assert.equal(teacherVisibility(f.manager()).deliveries.size,0);
}));

test("a teacher reserving further preparation cannot publish a private draft through the animation receipt",async()=>fixture(async f=>{
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("load_learning_skill",{name:"lawa-illustrated-lesson"}),{stopReason:"toolUse"}),
    fauxAssistantMessage(fauxToolCall("prepare_lesson_figures",{figures:[animationPlate],keep_preparing:true}),{stopReason:"toolUse"}),
    fauxAssistantMessage("内部草稿")
  ]);
  const s=await f.store.create(),events:WebSessionEvent[]=[];
  await f.store.sendMessage(s.sessionId,"先准备画稿",e=>events.push(e));
  assert.equal(f.store.classroom.snapshot()?.status,"interrupted");
  assert.equal(events.some(e=>e.type==="assistant_delta"),false);
}));

test("DeepSeek serialized tool syntax never leaks through public speech or restored history",async()=>fixture(async f=>{
  const prose="这一节从切分讲到链路，四次作答分别是8、8、9、8。要不要把这一节收尾？";
  const protocol='\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="ask_learner_questions">\n'
    +'<｜｜DSML｜｜ parameter name="purpose" string="true">CONFIRM_MASTERY</｜｜DSML｜｜ parameter>\n'
    +'</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
  f.faux.setResponses([begin(),fauxAssistantMessage(prose+protocol)]);
  const session=await f.store.create(),events:WebSessionEvent[]=[];
  await f.store.sendMessage(session.sessionId,"总结这一节",e=>events.push(e));
  const streamed=events.flatMap(e=>e.type==="assistant_delta"?[e.delta]:[]).join("");
  assert.doesNotMatch(streamed,/DSML|ask_learner_questions|CONFIRM_MASTERY/);
  assert.equal(streamed.trim(),prose);
  const saved=(await f.store.sharedClassroom()).session!.messages.map(m=>m.content).join("\n");
  assert.doesNotMatch(saved,/DSML|ask_learner_questions|CONFIRM_MASTERY/);
  assert.ok(saved.includes(prose));
  assert.equal(events.some(e=>e.type==="question_ready"),false,"serialized text is not an authorized tool call");
  assert.equal((await f.store.state(session.sessionId)).teaching.learner_questions?.pending,null);
  assert.equal(f.store.classroom.snapshot()?.status,"interrupted");
  assert.ok(events.some(e=>e.type==="model_error" && e.message.includes("没有执行")));
  f.faux.setResponses([begin(),fauxAssistantMessage("接着澄清收尾方式。")]);
  await f.store.sendMessage(session.sessionId,"继续",()=>{});
  const input=f.inputs.at(-1)!.messages.filter(m=>m.role==="assistant").map(m=>m.content.filter(p=>p.type==="text").map(p=>p.text).join("")).join("");
  assert.doesNotMatch(input,/DSML/);
  assert.match(readFileSync(f.manager().getSessionFile()!,"utf8"),/DSML/,"raw diagnostic history is retained");
}));

test("ordinary explanations stream multiple native deltas before the run finishes",async()=>fixture(async f=>{
  const explanation="数字相加得到和；加号遇到字符串时会进行字符串拼接。";
  f.faux.setResponses([begin(),fauxAssistantMessage(explanation)]);
  const session=await f.store.create();let finished=false; const deltas:string[]=[];
  await f.store.sendMessage(session.sessionId,"解释加号",e=>{
    if(e.type==="assistant_delta") {assert.equal(finished,false);deltas.push(e.delta);}
    if(e.type==="done")finished=true;
  });
  assert.ok(deltas.length>1,"must be real incremental output, not one buffered paragraph");
  assert.equal(deltas.join(""),explanation);
  assert.deepEqual(f.inputs.at(-1)!.tools,[],"tools must be removed during public speech");
  assert.equal(f.store.classroom.snapshot()?.status,"completed");
}));

test("a protocol failure retains a genuinely saved question and cannot grant mastery",async()=>fixture(async f=>{
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("ask_learner_questions",{purpose:"CONFIRM_MASTERY"}),{stopReason:"toolUse"}),
    fauxAssistantMessage('这一节的反馈。<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="complete_learning_task">'),
  ]);
  const session=await f.store.create(),events:WebSessionEvent[]=[];
  await f.store.sendMessage(session.sessionId,"小结一下",e=>events.push(e));
  const state=await f.store.state(session.sessionId);
  assert.equal(events.filter(e=>e.type==="question_ready").length,1);
  assert.equal(state.teaching.learner_questions?.pending?.purpose,"CONFIRM_MASTERY");
  assert.equal((state.overview.active_task as {status:string})?.status,"ACTIVE");
  assert.equal(f.store.classroom.snapshot()?.status,"interrupted");
  assert.equal(events.some(e=>e.type==="tool_start" && e.toolName==="complete_learning_task"),false);
  const reopened=(await import("@earendil-works/pi-coding-agent")).SessionManager.open(f.manager().getSessionFile()!);
  assert.equal(teacherVisibility(reopened).deliveries.size,1);
  assert.equal(teacherVisibility(reopened).texts.size,1);
  assert.equal(events.flatMap(e=>e.type==="assistant_delta"?[e.delta]:[]).join(""),"这一节的反馈。");
}));

test("a durable question is delivered before speech and survives a failed explanation",async()=>fixture(async f=>{
  f.faux.setResponses([
    fauxAssistantMessage([{type:"text",text:"尚未保存的出题承诺"},fauxToolCall("ask_learner_questions",check)],{stopReason:"toolUse"}),
    fauxAssistantMessage("先看这道题。",{stopReason:"error",errorMessage:"synthetic stream interruption"}),
  ]);
  const session=await f.store.create();const events:WebSessionEvent[]=[];
  await f.store.sendMessage(session.sessionId,"请出题",e=>{
    events.push(e);
    if(e.type==="question_ready") {
      assert.match(readFileSync(f.manager().getSessionFile()!,"utf8"),new RegExp(QUESTION_DELIVERY));
      assert.equal(e.request.questions[0]!.prompt,check.questions[0]!.prompt);
    }
  });
  const ready=events.findIndex(e=>e.type==="question_ready"), firstText=events.findIndex(e=>e.type==="assistant_delta");
  assert.ok(ready>=0 && (firstText<0 || ready<firstText));
  assert.equal(events.some(e=>e.type==="assistant_delta" && e.delta.includes("尚未保存")),false);
  const pending=(await f.store.state(session.sessionId)).teaching.learner_questions?.pending;
  assert.ok(pending,"a model failure must not retract a committed question");
  assert.equal(pending.questions[0]!.prompt,check.questions[0]!.prompt);
  assert.equal(teacherVisibility(f.manager()).deliveries.size,1);
}));

test("a rejected question has no success event and the model can stream an honest failure",async()=>fixture(async f=>{
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("ask_learner_questions",{...check,active_task_id:"stale"}),{stopReason:"toolUse"}),
    begin(),fauxAssistantMessage("当前任务已经变化，这次题目没有创建成功。"),
  ]);
  const session=await f.store.create();const events:WebSessionEvent[]=[];
  await f.store.sendMessage(session.sessionId,"请出题",e=>events.push(e));
  assert.equal(events.some(e=>e.type==="question_ready"),false);
  assert.equal((await f.store.state(session.sessionId)).teaching.learner_questions?.pending,null);
  assert.match(events.flatMap(e=>e.type==="assistant_delta"?[e.delta]:[]).join(""),/没有创建成功/);
  assert.equal(teacherVisibility(f.manager()).deliveries.size,0);
}));

test("saving an answer then offering mastery still teaches, without completing the task",async()=>fixture(async f=>{
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("ask_learner_questions",check),{stopReason:"toolUse"}),
    fauxAssistantMessage("请判断结果，并说明运算条件。")]);
  const session=await f.store.create();await f.store.sendMessage(session.sessionId,"请出题",()=>{});
  const question=(await f.store.state(session.sessionId)).teaching.learner_questions!.pending!;
  const feedback="结果是字符串23。你把字符串和数字的区别说明白了。加号先看操作数，出现字符串时做拼接；这里转换的是数字2，随后把两个文本接起来。";
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("record_answer_assessment",{question:check.questions[0]!.prompt,topic:"字符串拼接",assistance_level:"INDEPENDENT",
      criteria:[{label:"说明转换条件",earned:10,possible:10,feedback:"区分数字相加与字符串拼接"}],summary:"解释正确",strengths:["识别转换条件"],gaps:[]}),{stopReason:"toolUse"}),
    fauxAssistantMessage(fauxToolCall("ask_learner_questions",{purpose:"CONFIRM_MASTERY"}),{stopReason:"toolUse"}),
    // 即便模型违反已关闭的工具定义，等待用户选择仍由运行时保证。
    fauxAssistantMessage(fauxToolCall("complete_learning_task",{task_id:"ta"}),{stopReason:"toolUse"}),
    fauxAssistantMessage(feedback),
  ]);
  const events:WebSessionEvent[]=[];
  await f.store.sendMessage(session.sessionId,"",event=>events.push(event),{request_id:question.id,
    answers:[{question_id:question.questions[0]!.id,selected_option_ids:[],other_text:"结果是字符串23，因为右边是字符串，左边数字2转换为字符串后拼接。"}]});
  assert.ok(events.some(e=>e.type==="tool_end"&&e.toolName==="record_answer_assessment"&&!e.isError),"the regression must exercise a saved real answer");
  assert.equal(events.flatMap(e=>e.type==="assistant_delta"?[e.delta]:[]).join(""),feedback,"saved score must not replace public feedback");
  assert.ok(events.some(e=>e.type==="tool_end"&&e.toolName==="complete_learning_task"&&e.isError));
  const state=await f.store.state(session.sessionId);
  assert.equal(state.teaching.learner_questions?.pending?.purpose,"CONFIRM_MASTERY");
  assert.equal((state.overview.active_task as {status:string})?.status,"ACTIVE");
  assert.notEqual((state.overview.skills as Array<{id:string;status:string}>).find(s=>s.id==="a")?.status,"MASTERED_BY_USER");
  assert.ok((await f.store.sharedClassroom()).session!.messages.some(m=>m.assessment));
  assert.deepEqual(f.inputs.at(-1)!.tools,[]);
  assert.equal(f.store.classroom.snapshot()?.status,"completed");
}));

test("failed closing feedback retains the saved mastery card and an unfinished task",async()=>fixture(async f=>{
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("ask_learner_questions",{purpose:"CONFIRM_MASTERY"}),{stopReason:"toolUse"}),
    fauxAssistantMessage("这次解释",{stopReason:"error",errorMessage:"synthetic closing interruption"}),
  ]);
  const session=await f.store.create();await f.store.sendMessage(session.sessionId,"这一节可以收尾了吗",()=>{});
  assert.equal(f.store.classroom.snapshot()?.status,"interrupted","failed feedback must not be treated as a completed teaching turn");
  const state=await f.store.state(session.sessionId);
  assert.equal(state.teaching.learner_questions?.pending?.purpose,"CONFIRM_MASTERY");
  assert.equal((state.overview.active_task as {status:string})?.status,"ACTIVE");
  assert.notEqual((state.overview.skills as Array<{id:string;status:string}>).find(s=>s.id==="a")?.status,"MASTERED_BY_USER");
}));

test("question persistence failure never emits success and rolls back the pending question",async()=>fixture(async f=>{
  const session=await f.store.create();
  // Agent lazily binds the actual persistent manager on its first request.
  f.faux.setResponses([begin(),fauxAssistantMessage("先说明规则。")]);
  await f.store.sendMessage(session.sessionId,"先解释",()=>{});
  const manager=f.manager(),append=manager.appendCustomEntry.bind(manager);
  manager.appendCustomEntry=(type,data)=>{
    if(type===QUESTION_DELIVERY)throw new Error("synthetic disk failure");
    return append(type,data);
  };
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("ask_learner_questions",check),{stopReason:"toolUse"}),
    begin(),fauxAssistantMessage("题目保存失败，请稍后再试。")]);
  const events:WebSessionEvent[]=[];
  await f.store.sendMessage(session.sessionId,"现在出题",e=>events.push(e));
  assert.equal(events.some(e=>e.type==="question_ready"),false);
  assert.equal((await f.store.state(session.sessionId)).teaching.learner_questions?.pending,null);
  assert.equal(teacherVisibility(manager).deliveries.size,0);
}));

test("public speech cannot execute later writes or mix the phase transition with a question",async()=>fixture(async f=>{
  f.faux.setResponses([
    fauxAssistantMessage([fauxToolCall(BEGIN_REPLY,{}),fauxToolCall("ask_learner_questions",check)],{stopReason:"toolUse"}),
    begin(),
    fauxAssistantMessage(fauxToolCall("ask_learner_questions",check),{stopReason:"toolUse"}),
    fauxAssistantMessage("这里只继续解释，不改变学习状态。"),
  ]);
  const session=await f.store.create();const events:WebSessionEvent[]=[];
  await f.store.sendMessage(session.sessionId,"解释",e=>events.push(e));
  assert.equal(events.some(e=>e.type==="question_ready"),false);
  assert.equal(events.filter(e=>e.type==="tool_end"&&e.toolName==="ask_learner_questions"&&e.isError).length,2);
  assert.equal((await f.store.state(session.sessionId)).teaching.learner_questions?.pending,null);
}));

test("rollback compatibility preserves old published prose while hiding old private drafts",async()=>fixture(async f=>{
  f.faux.setResponses([begin(),fauxAssistantMessage("新版正常讲解。")]);
  const session=await f.store.create();await f.store.sendMessage(session.sessionId,"开始",()=>{});
  const manager=f.manager();
  manager.appendCustomEntry("lawa.teacher-delivery-start/v1",{});
  const id=manager.appendMessage(fauxAssistantMessage("旧内部草稿不应该展示"));
  manager.appendCustomEntry("lawa.teacher-delivery/v1",{assistantEntryId:id,text:"旧版已经发布的讲解。"});
  manager.appendCustomEntry("lawa.teacher-delivery-end/v1",{});
  const text=(await f.store.sharedClassroom()).session!.messages.map(m=>m.content).join("\n");
  assert.match(text,/新版正常讲解/);assert.match(text,/旧版已经发布/);assert.doesNotMatch(text,/旧内部草稿/);
  const reopened=(await import("@earendil-works/pi-coding-agent")).SessionManager.open(manager.getSessionFile()!);
  assert.deepEqual(teacherVisibility(reopened),teacherVisibility(manager));
}));

async function fixture(run:(f:{store:WebSessionStore; faux:ReturnType<typeof createFauxCore>; manager:()=>SessionManager; inputs:Context[]})=>Promise<void>) {
  const preview=await startGrowthPreview(0,false);
  const preferences=teachingPreferenceSnapshot(await (await fetch(preview.apiBase+"/api/learning/teaching")).json(),"");
  const activity=await fetch(preview.apiBase+"/api/learning/tasks/ta/teaching-activity",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({expected_goal_id:"goal",expected_revision:0,teaching_activity:{method:"REASON",purpose:"解释转换",learner_action:"预测输出并说明原因",
      observable_output:"输出与解释",evaluation_focus:["说明转换条件"],observation_limits:"不代表独立编程能力",teaching_preferences_revision:preferences.revision}})});
  assert.ok(activity.ok,await activity.text());
  const faux=createFauxCore({api:"openai-completions",provider:"aliyun-bailian",models:[{id:"qwen3.8-flash",contextWindow:1_000_000,maxTokens:32768}],tokensPerSecond:0});
  const inputs:Context[]=[];
  const runtime=await ModelRuntime.create({authPath:join(preview.directory,"auth.json"),modelsPath:null,
    modelsStorePath:join(preview.directory,"models.json"),allowModelNetwork:false,refreshOnCreate:false});
  runtime.streamSimple=(model,context,options)=>{inputs.push(JSON.parse(JSON.stringify(context)));return faux.streamSimple(model,context,options);};
  runtime.hasConfiguredAuth=()=>true;
  runtime.getAuth=async()=>({auth:{apiKey:"synthetic-only"},env:{}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
  let manager!:SessionManager;
  const store=new WebSessionStore({apiBaseUrl:preview.apiBase,conversationDir:join(preview.directory,"protocol-sessions"),conversationCwd:preview.directory,log:()=>{},
    createAgent:(context,planning,onEvent,sessionManager,branchProposed)=>{
      manager=sessionManager;
      return createLearningAgentSession(context,planning,{apiBaseUrl:preview.apiBase,model:faux.getModel(),modelRuntime:runtime,
        sessionManager,surface:"WEB",retrieval:false,assistantSupport:false,teachingInstructions:()=>"",onEvent,branchProposed,log:()=>{}});
    }});
  try {await run({store,faux,manager:()=>manager,inputs});} finally {store.dispose();await preview.stop();}
}
