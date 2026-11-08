import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, readFile, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve, basename} from "node:path";
import {fileURLToPath} from "node:url";
import {JSDOM} from "jsdom";
import {build} from "vite";

test("a rejected HTTP429 answer stays visibly pending and can be explicitly retried with its original request identity", {timeout: 45_000}, async t => {
  const root=dirname(fileURLToPath(new URL("../package.json",import.meta.url)));
  const output=await mkdtemp(join(tmpdir(),"lawa-admission-429-"));
  let server:ReturnType<typeof spawn>|undefined;
  try {
    await build({configFile:join(root,"web/vite.config.ts"),logLevel:"silent",build:{outDir:output}});
    server=spawn(process.execPath,["--import","tsx","src/web/academicWorkspaceFixture.ts"],{cwd:root,
      env:{...process.env,READABLE_PORT:"0",READABLE_STATIC_DIR:output},stdio:["ignore","pipe","pipe"],windowsHide:true});
    const base=await new Promise<string>((done,reject)=>{let text="";server!.once("error",reject);server!.once("exit",code=>reject(Error(`fixture ${code}`)));
      server!.stdout!.on("data",chunk=>{text+=String(chunk);const match=/Academic fixture: (http:\/\/127\.0\.0\.1:\d+)/.exec(text);if(match)done(match[1]!);});});
    const html=await readFile(join(output,"index.html"),"utf8");
    const assets=await readdir(join(output,"assets"));
    const script=await readFile(join(output,"assets",assets.find(name=>/^index-.*\.js$/.test(name))!),"utf8");
    for(let repetition=1;repetition<=4;repetition++) await t.test(repetition<=2?`isolated repetition ${repetition}`:repetition===3?"changed task cannot receive an old pending answer":"accepted original answer switches to server feedback recovery without a second answer",async()=>{
      const session=await (await fetch(`${base}/api/web/sessions`,{method:"POST"})).json() as any;
      let state=structuredClone(session.state), currentMessages=session.messages, sequence=1, accepted=0, rejected=true;
      state.classroom_version=String(sequence);
      const bodies:any[]=[];const recoveryBodies:any[]=[];const errors:string[]=[];
      const answerText=`原题原答 ${repetition}：相同整体下，四份中的每份更大。`;
      const dom=new JSDOM(html,{url:base,runScripts:"outside-only",pretendToBeVisual:true}),w=dom.window;
      w.addEventListener("error",event=>errors.push(event.message));
      w.matchMedia=query=>({matches:query.includes("min-width: 821px"),media:query,addEventListener(){},removeEventListener(){}} as unknown as MediaQueryList);
      w.HTMLElement.prototype.scrollIntoView=function(){};w.scrollTo=()=>undefined;
      w.HTMLElement.prototype.animate=()=>({finished:Promise.resolve(),cancel(){}} as unknown as Animation);
      Object.assign(w,{TextDecoder,TextEncoder,Headers,Request,Response,AbortController,
        CSS:{escape:(text:string)=>text.replace(/[^a-zA-Z0-9_-]/g,char=>`\\${char}`)},
        ResizeObserver:class{observe(){}unobserve(){}disconnect(){}},EventSource:class{static OPEN=1;readyState=1;close(){}},
        fetch:async(input:string,init?:RequestInit)=>{
          const url=new URL(input,base),path=url.pathname;
          if(path.endsWith("/messages")) {
            const body=JSON.parse(String(init?.body));bodies.push(body);
            if(rejected) return Response.json({detail:"暂时无法接收，请稍后重试。"},{status:429});
            accepted++;
            const request=state.teaching.learner_questions.pending;
            state=structuredClone(state);state.classroom_version=String(++sequence);
            state.teaching.learner_questions={pending:null,last_answer:{request,reply:body.learner_reply,text:answerText,used_choices:false,choices_exposed:false}};
            const messages=currentMessages=[...currentMessages,{role:"user",content:answerText},{role:"assistant",content:"已接收原题回答，反馈已完成。"}];
            return new Response(`${JSON.stringify({type:"conversation_update",messages})}\n${JSON.stringify({type:"state",state})}\n${JSON.stringify({type:"done"})}\n`,{headers:{"Content-Type":"application/x-ndjson"}});
          }
          if(path.endsWith("/retry-feedback")) {
            recoveryBodies.push(JSON.parse(String(init?.body)));
            state=structuredClone(state);state.feedback_recovery=null;state.classroom_version=String(++sequence);
            return new Response(`${JSON.stringify({type:"conversation_update",messages:currentMessages})}\n${JSON.stringify({type:"state",state})}\n${JSON.stringify({type:"done"})}\n`,{headers:{"Content-Type":"application/x-ndjson"}});
          }
          if(path==="/api/web/classroom/snapshot") return Response.json({session:{...session,messages:currentMessages,state},run:null,version:String(sequence),sequence});
          if(path.endsWith("/state")) return Response.json(state);
          if(path==="/api/web/sessions"&&init?.method==="POST") return Response.json({...session,messages:currentMessages,state});
          if(path.endsWith("/assistant")) return Response.json({available:false,busy:false,messages:[],scope:null});
          return fetch(url,init);
        }});
      try {
        w.eval(script.replaceAll("import.meta.url",JSON.stringify(base)));
        const q=<T extends Element=HTMLElement>(selector:string)=>{const node=w.document.querySelector<T>(selector);assert.ok(node,selector);return node;};
        const wait=async(predicate:()=>boolean)=>{for(let i=0;i<300;i++){if(errors.length)assert.fail(errors.join("\n"));if(predicate())return;await new Promise(done=>setTimeout(done,10));}assert.fail("admission UI did not settle");};
        await wait(()=>Boolean(w.document.querySelector("#learner-questions textarea")));
        const answer=q<HTMLTextAreaElement>("#learner-questions textarea");answer.value=answerText;answer.dispatchEvent(new w.Event("input",{bubbles:true}));
        q<HTMLButtonElement>("[data-question-submit]").click();
        await wait(()=>bodies.length===1&&q("#connection-status").getAttribute("data-status")==="error");
        assert.equal(accepted,0,"a rejected admission is never a stored answer or model turn");
        assert.equal(q<HTMLButtonElement>("#retry-feedback-button").hidden,false,"rejected admission needs an explicit original-answer resubmit, not only reconnect");
        assert.match(q("#retry-feedback-button").textContent??"",/重新提交/);
        assert.match(q("#error-text").textContent??"",/未.*接收|尚未.*接收/);
        q<HTMLButtonElement>("#retry-button").click();
        await wait(()=>!q<HTMLButtonElement>("#retry-button").disabled);
        assert.equal(bodies.length,1,"reconnection never resends an answer automatically");
        assert.equal(q("#error-banner").classList.contains("hidden"),false,"successful reconnect must not erase the still-unaccepted answer state");
        assert.match(q("#error-text").textContent??"",/未.*接收|尚未.*接收/);
        assert.equal(q<HTMLTextAreaElement>("#learner-questions textarea").value,answerText);
        if(repetition===3) {
          state=structuredClone(state);state.classroom_version=String(++sequence);state.overview.active_task={...state.overview.active_task,id:"different-task"};
          state.teaching.learner_questions.pending={...state.teaching.learner_questions.pending,id:"different-question",task_id:"different-task"};
          q<HTMLButtonElement>("#retry-feedback-button").click();
          await wait(()=>Boolean(q("#error-text").textContent?.includes("原题现场已变化")));
          assert.equal(bodies.length,1,"a different current Task must never receive the pending original answer");
          assert.equal(accepted,0);assert.equal(recoveryBodies.length,0);
          assert.equal(q<HTMLTextAreaElement>("#learner-questions textarea").value,"","old answer must not leak into the new question's draft");
          return;
        }
        if(repetition===4) {
          const request=state.teaching.learner_questions.pending;
          state=structuredClone(state);state.classroom_version=String(++sequence);state.teaching.learner_questions={pending:null,last_answer:{request,reply:bodies[0].learner_reply,text:answerText,used_choices:false,choices_exposed:false}};
          state.feedback_recovery={id:"server-original-feedback",reason:"model_error"};
          currentMessages=[...currentMessages,{role:"user",content:answerText}];
          q<HTMLButtonElement>("#retry-feedback-button").click();
          await wait(()=>recoveryBodies.length===1&&q("#connection-status").getAttribute("data-status")==="ready");
          assert.equal(bodies.length,1,"server-confirmed original answer must never be resubmitted as another answer");
          assert.equal(recoveryBodies[0].recovery_id,"server-original-feedback");
          assert.deepEqual(Object.keys(recoveryBodies[0]).sort(),["expected_version","recovery_id"]);
          return;
        }
        rejected=false;
        const retry=q<HTMLButtonElement>("#retry-feedback-button");retry.click();retry.click();
        await wait(()=>accepted===1&&q("#connection-status").getAttribute("data-status")==="ready");
        assert.equal(bodies.length,2,"one explicit resubmit runs once, double clicks do not duplicate it");
        assert.equal(bodies[0].request_id,bodies[1].request_id,"transport retries retain the same idempotent submission identity");
        assert.deepEqual(bodies[0].learner_reply,bodies[1].learner_reply,"the original task/question answer is never turned into ordinary chat");
        assert.equal(q("#error-banner").classList.contains("hidden"),true);
        assert.equal(retry.hidden,true);
        assert.equal((q("#messages").textContent??"").split(answerText).length-1,1,"no duplicate optimistic answer survives authoritative confirmation");
      } finally {dom.window.close();}
    });
  } finally {
    server?.kill();assert.equal(dirname(resolve(output)),resolve(tmpdir()));assert.ok(basename(output).startsWith("lawa-admission-429-"));
    await rm(output,{recursive:true,force:true});
  }
});
