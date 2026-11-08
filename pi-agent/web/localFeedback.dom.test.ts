import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, readFile, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve, basename} from "node:path";
import {fileURLToPath} from "node:url";
import {JSDOM} from "jsdom";
import {build} from "vite";

test("built feedback UI separates local validation and preserves an assistant draft during the teacher's automatic task transition", {timeout: 40_000}, async t => {
  const root=dirname(fileURLToPath(new URL("../package.json",import.meta.url)));
  const output=await mkdtemp(join(tmpdir(),"lawa-local-feedback-"));
  let server: ReturnType<typeof spawn>|undefined, dom: JSDOM|undefined;
  try {
    await build({configFile:join(root,"web/vite.config.ts"),logLevel:"silent",build:{outDir:output}});
    server=spawn(process.execPath,["--import","tsx","src/web/academicWorkspaceFixture.ts"],{cwd:root,
      env:{...process.env,READABLE_PORT:"0",READABLE_STATIC_DIR:output},stdio:["ignore","pipe","pipe"],windowsHide:true});
    const base=await new Promise<string>((done,reject)=>{let text="";
      server!.once("error",reject);server!.once("exit",code=>reject(Error(`Fixture exited: ${code}`)));
      server!.stdout!.on("data",chunk=>{text+=String(chunk);const match=/Academic fixture: (http:\/\/127\.0\.0\.1:\d+)/.exec(text);if(match)done(match[1]!);});
    });
    const session=await (await fetch(`${base}/api/web/sessions`,{method:"POST"})).json() as any;
    let state=session.state, version=1, teacherCalls=0;
    const recoveryBodies:any[]=[];
    let shared:any;
    state.classroom_version=String(version);
    let stream: ReadableStreamDefaultController<Uint8Array>|undefined;
    const errors:string[]=[], requests:string[]=[];
    dom=new JSDOM(await readFile(join(output,"index.html"),"utf8"),{url:base,runScripts:"outside-only",pretendToBeVisual:true});
    const w=dom.window;
    w.addEventListener("error",event=>errors.push(event.message));
    w.matchMedia=query=>({matches:query.includes("min-width: 821px"),media:query,addEventListener(){},removeEventListener(){}} as unknown as MediaQueryList);
    w.HTMLElement.prototype.scrollIntoView=function(){};w.scrollTo=()=>undefined;
    w.HTMLElement.prototype.animate=()=>({finished:Promise.resolve(),cancel(){}} as unknown as Animation);
    Object.assign(w,{TextDecoder,TextEncoder,Headers,Request,Response,AbortController,
      CSS:{escape:(text:string)=>text.replace(/[^a-zA-Z0-9_-]/g,char=>`\\${char}`)},
      ResizeObserver:class{observe(){}unobserve(){}disconnect(){}},EventSource:class{static OPEN=1;readyState=1;constructor(){shared=this;}close(){}},
      fetch:async(input:string,init?:RequestInit)=>{
        const url=new URL(input,base),path=url.pathname;requests.push(`${init?.method??"GET"} ${path}`);
        if(path.endsWith("/messages")) {teacherCalls++; return new Response(new ReadableStream<Uint8Array>({start(controller){stream=controller;}}));}
        if(path.endsWith("/retry-feedback")) {recoveryBodies.push(JSON.parse(String(init?.body)));return new Response(new ReadableStream<Uint8Array>({start(controller){stream=controller;}}));}
        if(path==="/api/web/materials"&&init?.method==="POST") return Response.json({id:"new-unsent-file",name:"未发送的新附件.txt",format:"txt",unit_kind:"line",goal_id:state.active_goal_id});
        if(path.endsWith("/assistant")) return Response.json({available:Boolean(state.overview.active_task),busy:false,teacher_busy:Boolean(stream),
          scope:state.overview.active_task?{goalId:state.active_goal_id,taskId:state.overview.active_task.id,skillId:state.overview.active_task.related_skill_ids[0],attemptId:state.teaching.learner_questions?.pending?.id??null,mainSessionId:session.sessionId}:null,messages:[]});
        if(path==="/api/web/classroom/snapshot") return Response.json({session:{...session,state},run:null,version:String(version),sequence:version});
        if(path.endsWith("/state")) return Response.json(state);
        if(path==="/api/web/sessions"&&init?.method==="POST") return Response.json({...session,state});
        return fetch(url,init);
      }});
    const assets=await readdir(join(output,"assets"));
    w.eval((await readFile(join(output,"assets",assets.find(name=>/^index-.*\.js$/.test(name))!),"utf8")).replaceAll("import.meta.url",JSON.stringify(base)));
    const q=<T extends Element=HTMLElement>(selector:string)=>{const node=w.document.querySelector<T>(selector);assert.ok(node,selector);return node;};
    const waitFor=async(predicate:()=>boolean)=>{for(let i=0;i<250;i++){if(errors.length)assert.fail(errors.join("\n"));if(predicate())return;await new Promise(done=>setTimeout(done,10));}assert.fail("Feedback UI did not settle");};
    await waitFor(()=>Boolean(w.document.querySelector("#learner-questions textarea")));
    await t.test("empty answer focuses the answer without offering a connection retry or sending a request",async()=>{
      q<HTMLButtonElement>("[data-question-submit]").click();
      assert.match(q("#error-text").textContent??"",/请选择一项或写下自己的回答/);
      assert.equal(teacherCalls,0);
      assert.equal(q<HTMLButtonElement>("#retry-button").hidden,true,"local validation must not offer network recovery");
      assert.equal(w.document.activeElement,q("#learner-questions textarea"));
    });
    await t.test("automatic task completion keeps the visible assistant draft and its focus without silently rebinding it",async()=>{
      const answer=q<HTMLTextAreaElement>("#learner-questions textarea");
      answer.value="相同整体，四份中的每份更大。";answer.dispatchEvent(new w.Event("input",{bubbles:true}));
      q<HTMLButtonElement>("[data-question-submit]").click();await waitFor(()=>Boolean(stream));
      q<HTMLButtonElement>("#assistant-entry").click();
      await waitFor(()=>!q("#assistant-status").textContent?.includes("恢复"));
      const input=q<HTMLTextAreaElement>("#assistant-input");
      input.focus();input.value="我还想问刚才那个分数的整体是什么？";input.dispatchEvent(new w.Event("input",{bubbles:true}));
      assert.equal(q<HTMLButtonElement>("#assistant-send").disabled,true,"teacher generation still blocks assistant submission");
      state=structuredClone(state);state.classroom_version=String(++version);
      state.overview.active_task={...state.overview.active_task,id:"task-next",related_skill_ids:["skill-1"]};
      const nextQuestion={...state.teaching.learner_questions.pending,id:"question-next",task_id:"task-next",skill_id:"skill-1",questions:[{id:"automatic-next",selection:"freeform",options:[],prompt:"这是自动进入下一任务后实际呈现的新题，请解释相同整体的含义。"}]};
      state.teaching.learner_questions={pending:nextQuestion,last_answer:null};
      const betweenTasks=structuredClone(state);betweenTasks.overview.active_task=null;
      betweenTasks.teaching.learner_questions.pending=null;
      const nextTask=state;state=betweenTasks;
      const currentStream=stream!;
      currentStream.enqueue(new TextEncoder().encode(`${JSON.stringify({type:"state",state:betweenTasks})}\n`));
      await waitFor(()=>w.document.querySelector<HTMLButtonElement>("[data-assistant-adopt-draft]")?.disabled===true);
      assert.equal(input.value,"我还想问刚才那个分数的整体是什么？","even the no-active-task interval must retain the source draft");
      assert.equal(input.disabled,false,"a retained draft must stay focusable for copying while there is no task");
      assert.equal(input.readOnly,true,"a no-task draft is readable and copyable without allowing a submission");
      input.focus();assert.equal(w.document.activeElement,input);
      state=nextTask;stream=undefined;
      currentStream.enqueue(new TextEncoder().encode(`${JSON.stringify({type:"state",state})}\n${JSON.stringify({type:"assistant_delta",delta:"我们继续下一节。"})}\n`));currentStream.close();
      await waitFor(()=>q("#connection-status").getAttribute("data-status")==="ready");
      await waitFor(()=>!q("#assistant-status").textContent?.includes("恢复"));
      assert.match(q("#learner-questions").textContent??"",/自动进入下一任务后实际呈现的新题/);
      assert.equal(input.value,"我还想问刚才那个分数的整体是什么？","the automatic transition must not blank the user's unsent question");
      assert.equal(w.document.activeElement,input,"teacher completion must not steal focus from the assistant editor");
      assert.equal(q<HTMLButtonElement>("#assistant-send").disabled,true,"a retained old-task draft must not be silently sent to a new task");
      q<HTMLButtonElement>("[data-assistant-adopt-draft]").click();
      assert.equal(q<HTMLButtonElement>("#assistant-send").disabled,false);
      assert.equal(requests.filter(path=>path.startsWith("POST ")&&path.endsWith("/assistant")).length,0);
      assert.equal(teacherCalls,1);
    });
    await t.test("server-backed feedback recovery survives a same-session snapshot and reports the real retry lifecycle",async()=>{
      const input=q<HTMLTextAreaElement>("#message-input");
      input.value="请点评刚才的正确回答。";
      q<HTMLFormElement>("#composer").dispatchEvent(new w.Event("submit",{bubbles:true,cancelable:true}));
      await waitFor(()=>teacherCalls===2&&Boolean(stream));
      state=structuredClone(state);state.classroom_version=String(++version);
      state.feedback_recovery={id:"recovery-1",reason:"model_error"};
      const failedStream=stream!;stream=undefined;
      failedStream.enqueue(new TextEncoder().encode(`${JSON.stringify({type:"state",state})}\n${JSON.stringify({type:"error",message:"隔离测试：回复中断，请恢复本次反馈。"})}\n`));failedStream.close();
      await waitFor(()=>q("#connection-status").getAttribute("data-status")==="error");
      state.classroom_version=String(++version);
      shared.onmessage({data:JSON.stringify({type:"snapshot",snapshot:{session:{...session,state},run:{id:"old-run",sessionId:session.sessionId,status:"interrupted",text:""},version:String(version),sequence:version}})});
      await waitFor(()=>!q<HTMLButtonElement>("#retry-feedback-button").hidden);
      input.value="这份新的主聊天草稿还没有提交";input.dispatchEvent(new w.Event("input",{bubbles:true}));
      const file=q<HTMLInputElement>("#material-file");
      Object.defineProperty(file,"files",{configurable:true,value:[new w.File(["新的学习资料"],"未发送的新附件.txt",{type:"text/plain"})]});
      file.dispatchEvent(new w.Event("change",{bubbles:true}));
      await waitFor(()=>Boolean(q("#composer-attachments").textContent?.includes("未发送的新附件.txt")));
      assert.equal(q<HTMLButtonElement>("#retry-button").hidden,true,"a server operation recovery must not be labelled as reconnect");
      const retry=q<HTMLButtonElement>("#retry-feedback-button");retry.click();retry.click();
      await waitFor(()=>recoveryBodies.length===1);
      assert.equal(retry.disabled,true);assert.match(retry.textContent??"",/正在重新生成/);
      assert.deepEqual(recoveryBodies[0],{recovery_id:"recovery-1",expected_version:String(version)});
      assert.equal(teacherCalls,2,"recovery must not append a new user submission");
      assert.equal(input.value,"这份新的主聊天草稿还没有提交");
      assert.match(q("#composer-attachments").textContent??"",/未发送的新附件/);
      const failedRetry=stream!;stream=undefined;
      failedRetry.enqueue(new TextEncoder().encode(`${JSON.stringify({type:"state",state})}\n${JSON.stringify({type:"error",message:"隔离测试：这次恢复仍未完成，可以重试。"})}\n`));failedRetry.close();
      await waitFor(()=>!retry.disabled&&q("#connection-status").getAttribute("data-status")==="error");
      assert.equal(retry.hidden,false);retry.click();await waitFor(()=>recoveryBodies.length===2);
      assert.deepEqual(recoveryBodies[1],recoveryBodies[0],"failed retry preserves the same server operation rather than making a new answer");
      state=structuredClone(state);state.classroom_version=String(++version);state.feedback_recovery=null;
      const currentStream=stream!;stream=undefined;
      currentStream.enqueue(new TextEncoder().encode(`${JSON.stringify({type:"state",state})}\n${JSON.stringify({type:"assistant_delta",delta:"这次的反馈已完成保存。"})}\n`));currentStream.close();
      await waitFor(()=>q("#connection-status").getAttribute("data-status")==="ready");
      assert.equal(q<HTMLButtonElement>("#retry-feedback-button").hidden,true);
      assert.equal(q("#error-banner").classList.contains("hidden"),true,"a completed retry must clear its error state");
      assert.equal(input.value,"这份新的主聊天草稿还没有提交");
      assert.ok(recoveryBodies.every(body=>Object.keys(body).sort().join(",")==="expected_version,recovery_id"),"new message text, answer IDs and attachments cannot leak into the saved turn retry");
    });
    assert.deepEqual(errors,[]);
  } finally {
    dom?.window.close();server?.kill();
    assert.equal(dirname(resolve(output)),resolve(tmpdir()));assert.ok(basename(output).startsWith("lawa-local-feedback-"));
    await rm(output,{recursive:true,force:true});
  }
});
