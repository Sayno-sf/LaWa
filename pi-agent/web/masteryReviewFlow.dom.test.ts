import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,readFile,readdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,dirname,resolve,sep} from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "vite";
import {JSDOM} from "jsdom";

// 运行真实构建前端；只与隔离夹具/假HTTP交互，既不连接用户Kernel，也不调用模型。
test("built mastery flow applies a user decision before teaching, retries safely and restores review conversations", {timeout:40_000}, async()=>{
  const root=dirname(fileURLToPath(new URL("../package.json",import.meta.url)));
  const output=await mkdtemp(join(tmpdir(),"lawa-mastery-ui-"));
  let server:ReturnType<typeof spawn>|undefined;
  let dom:JSDOM|undefined;
  try {
    await build({configFile:join(root,"web/vite.config.ts"),logLevel:"silent",build:{outDir:output}});
    server=spawn(process.execPath,["--import","tsx","src/web/academicWorkspaceFixture.ts"],{cwd:root,
      env:{...process.env,READABLE_PORT:"0",READABLE_STATIC_DIR:output},stdio:["ignore","pipe","pipe"]});
    const base=await new Promise<string>((done,reject)=>{
      let text="";server!.once("error",reject);server!.once("exit",code=>reject(Error(`Fixture exited: ${code}`)));
      server!.stdout!.on("data",chunk=>{text+=String(chunk);const match=/Academic fixture: (http:\/\/127\.0\.0\.1:\d+)/.exec(text);if(match)done(match[1]!);});
    });
    const assets=await readdir(join(output,"assets"));
    const script=await readFile(join(output,"assets",assets.find(name=>/^index-.*\.js$/.test(name))!),"utf8");
    for (const review of [false,true]) {
      let state:any,session:any,version=1;
      const decisions:any[]=[],messages:any[]=[],paths:string[]=[],errors:string[]=[];
      let release:(()=>void)|undefined;
      const pending={id:review?"review-confirm":"normal-skip",purpose:"CONFIRM_MASTERY",session_id:"readable-fixture",goal_id:"goal-0",task_id:"task-0",skill_id:"skill-0",scope_signature:"a".repeat(64),
        title:"这一节，你觉得掌握了吗？",questions:[{id:"mastery-review",prompt:"关于函数参数，你觉得现在掌握得怎样？",selection:"single",options:[
          {id:"proceed",label:"确认掌握并继续"},{id:"revise",label:"还有不清楚的地方"},{id:"skip",label:"暂不确认，继续下一节"}]}]};
      const initial=await (await fetch(`${base}/api/web/sessions`,{method:"POST"})).json() as any;
      state=structuredClone(initial.state);state.classroom_version=String(version);
      state.teaching.learner_questions={pending,last_answer:null};session={...initial,state};
      dom=new JSDOM(await readFile(join(output,"index.html"),"utf8"),{url:base,runScripts:"outside-only",pretendToBeVisual:true});
      const w=dom.window;
      w.addEventListener("error",event=>errors.push(event.message));
      w.matchMedia=query=>({matches:query.includes("min-width: 821px"),media:query,addEventListener(){},removeEventListener(){}} as unknown as MediaQueryList);
      w.HTMLElement.prototype.scrollIntoView=function(){};w.scrollTo=()=>undefined;
      Object.assign(w,{TextDecoder,TextEncoder,Headers,Request,Response,AbortController,
        CSS:{escape:(text:string)=>text.replace(/[^a-zA-Z0-9_-]/g,char=>`\\${char}`)},
        ResizeObserver:class{observe(){}unobserve(){}disconnect(){}},EventSource:class{static OPEN=1;readyState=1;close(){}},
        fetch:async(input:string,init?:RequestInit)=>{
          const url=new URL(input,base),path=url.pathname;paths.push(path);
          if(path.endsWith("/mastery-decision")) {
            decisions.push(JSON.parse(String(init?.body)));
            if(!review&&decisions.length===1) {
              await new Promise<void>(done=>{release=done;});
              return Response.json({detail:"隔离测试：网络应答丢失，请重试。"},{status:503});
            }
            state.classroom_version=String(++version);
            if(review) {
              state={...state,teaching:{...state.teaching,learner_questions:{pending:null,last_answer:null}},
                overview:{...state.overview,current_frontier:{...state.overview.current_frontier,focus_skill_id:"skill-1"},
                  active_task:{id:"parent-task",title:"继续原课堂",related_skill_ids:["skill-1"],status:"ACTIVE"},
                  skills:state.overview.skills.map((skill:any)=>skill.id==="skill-0"?{...skill,status:"MASTERED_BY_USER"}:skill.id==="skill-1"?{...skill,status:"LEARNING",name:"回到原课堂"}:skill)}};
              session={...session,sessionId:"parent-session",state};
              return Response.json({state:{...state,restored_session:session},continue_teaching:false});
            }
            return Response.json({state,continue_teaching:true});
          }
          if(path.endsWith("/messages")) {
            const body=JSON.parse(String(init?.body));messages.push(body);
            state={...state,classroom_version:String(++version),teaching:{...state.teaching,learner_questions:{pending:null,last_answer:null}}};
            session={...session,state};
            return new Response(`data: ${JSON.stringify({type:"assistant_delta",delta:"好，我们继续下一节。"})}\n\ndata: ${JSON.stringify({type:"state",state})}\n\n`,{headers:{"Content-Type":"text/event-stream"}});
          }
          if(path==="/api/web/classroom/snapshot") return Response.json({session,run:null,version:String(version),sequence:version});
          if(path.endsWith("/state")) return Response.json(state);
          if(path==="/api/web/sessions"&&init?.method==="POST") return Response.json(session);
          return fetch(url,init);
        }});
      w.eval(script.replaceAll("import.meta.url",JSON.stringify(base)));
      const waitFor=async(predicate:()=>boolean)=>{for(let i=0;i<250;i++){if(errors.length)assert.fail(errors.join("\n"));if(predicate())return;await new Promise(done=>setTimeout(done,10));}assert.fail("Mastery UI did not settle");};
      const click=(selector:string)=>{const button=w.document.querySelector<HTMLButtonElement>(selector);assert.ok(button,selector);button.click();};
      await waitFor(()=>Boolean(w.document.querySelector('[data-question-action="skip"]')));
      if(!review) {
        click('[data-question-action="skip"]');
        await waitFor(()=>Boolean(release));
        click('[data-question-action="skip"]');
        assert.equal(decisions.length,1,"用户决策在途时阻止重复点击");
        assert.equal(messages.length,0,"用户决策尚未成功，不得先向模型发送");
        release!();
        await waitFor(()=>/网络应答丢失/.test(w.document.querySelector("#error-banner")?.textContent??""));
        click('[data-question-action="skip"]');
        await waitFor(()=>messages.length===1&&!w.document.querySelector("#learner-questions"));
        assert.equal(decisions.length,2);
        assert.deepEqual(decisions[0].learner_reply,decisions[1].learner_reply,"重试保留同一真实请求与选择");
        assert.equal(messages[0].expected_version,"2","继续教学使用决策后刷新版本");
        assert.deepEqual(messages[0].learner_reply,decisions[1].learner_reply);
        assert.deepEqual(state.overview.skills.map((skill:any)=>skill.status),initial.state.overview.skills.map((skill:any)=>skill.status),"跳过确认不在页面伪造掌握");
      } else {
        click('[data-question-action="proceed"]');
        await waitFor(()=>/回到原课堂/.test(w.document.querySelector("#skill-card")?.textContent??""));
        assert.equal(decisions.length,1);assert.equal(messages.length,0,"复习结束不向旧复习分支发送教师请求");
        assert.equal(w.document.querySelector("#learner-questions"),null);
        assert.equal(paths.filter(path=>path.endsWith("/messages")).length,0);
      }
      assert.deepEqual(errors,[]);dom.window.close();dom=undefined;
    }
  } finally {
    dom?.window.close();server?.kill();
    assert.ok(resolve(output).startsWith(resolve(tmpdir())+sep));
    await rm(output,{recursive:true,force:true});
  }
});
