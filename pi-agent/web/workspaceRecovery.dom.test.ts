import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,readFile,readdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {JSDOM} from "jsdom";
import {build} from "vite";

// 真实构建/事件处理器配隔离 HTTP 样例，明确控制响应先后，不连接学习账本或模型。
test("workspace recovers source, list and new-goal loading without presenting stale facts",{timeout:40_000},async t=>{
  const root=dirname(fileURLToPath(new URL("../package.json",import.meta.url)));
  const output=await mkdtemp(join(tmpdir(),"lawa-workspace-recovery-"));
  let server:ReturnType<typeof spawn>|undefined,dom:JSDOM|undefined;
  try{
    await build({configFile:join(root,"web/vite.config.ts"),logLevel:"silent",build:{outDir:output}});
    server=spawn(process.execPath,["--import","tsx","src/web/academicWorkspaceFixture.ts"],{cwd:root,env:{...process.env,READABLE_PORT:"0",READABLE_STATIC_DIR:output},stdio:["ignore","pipe","pipe"],windowsHide:true});
    const base=await new Promise<string>((resolve,reject)=>{let out="";server!.once("error",reject);server!.once("exit",code=>reject(Error(`Fixture exited ${code}`)));server!.stdout!.on("data",chunk=>{out+=chunk;const match=/Academic fixture: (http:\/\/127\.0\.0\.1:\d+)/.exec(out);if(match)resolve(match[1]!);});});
    const original=await(await fetch(`${base}/api/web/sessions`,{method:"POST"})).json() as any;
    const library=await(await fetch(`${base}/api/web/learning-library`)).json() as any;
    const errors:string[]=[],requests:string[]=[];
    const libraryReplies:Array<Promise<Response>>=[];
    let draft:any=null,finishNewGoal:((response:Response)=>void)|undefined,draftKeepsPriorGoal=false;
    let slowActivation=false,finishActivation:((response:Response)=>void)|undefined;
    let currentSession=original,sequence=1,closure:any=null,shared:any;
    dom=new JSDOM(await readFile(join(output,"index.html"),"utf8"),{url:base,runScripts:"outside-only",pretendToBeVisual:true});
    const w=dom.window;
    w.addEventListener("error",event=>errors.push(event.message));
    w.matchMedia=query=>({matches:query.includes("min-width: 821px"),media:query,addEventListener(){},removeEventListener(){}} as unknown as MediaQueryList);
    w.HTMLElement.prototype.scrollIntoView=function(){};w.scrollTo=()=>undefined;
    w.HTMLElement.prototype.animate=()=>({finished:Promise.resolve(),cancel(){}} as unknown as Animation);
    w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
    Object.assign(w,{TextDecoder,TextEncoder,Headers,Request,Response,AbortController,CSS:{escape:(text:string)=>text.replace(/[^a-zA-Z0-9_-]/g,char=>`\\${char}`)},ResizeObserver:class{observe(){}unobserve(){}disconnect(){}},EventSource:class{static OPEN=1;readyState=1;constructor(){shared=this;}close(){}},fetch:async(input:string,init?:RequestInit)=>{
      const url=new URL(input,base);requests.push(`${init?.method??"GET"} ${url.pathname}`);
      if(url.pathname==="/api/web/learning-library"&&libraryReplies.length)return libraryReplies.shift()!;
      if(url.pathname==="/api/web/learning-library")return Response.json(library);
      if(url.pathname==="/api/web/cards/card-history/note"&&init?.method==="PUT"){
        const card=library.projects.flatMap((project:any)=>project.knowledge_cards).find((card:any)=>card.id==="card-history");
        Object.assign(card,{learner_note:JSON.parse(String(init.body)).note,note_updated_at:"2026-10-27T04:00:00Z"});return Response.json(card);
      }
      if(url.pathname==="/api/web/teaching"&&closure)return Response.json({current_goal_id:"goal-0",closure_progress:closure,proposals:[{id:"ended-proposal",revision:1,kind:"CLOSURE",text:"旧总结",reason:"",scope:"GOAL",subject:"general",status:closure.latest_end_choice_status,goal_id:"goal-0"}]});
      if(url.pathname.endsWith("/state"))return Response.json(currentSession.state);
      if(url.pathname==="/api/web/sessions/old-session/activate"&&slowActivation)return new Promise<Response>(resolve=>{finishActivation=resolve;});
      if(url.pathname==="/api/web/sessions"&&init?.method==="POST"&&JSON.parse(String(init.body)).mode==="new-goal"){
        draft=structuredClone(draftKeepsPriorGoal?currentSession:original);draft.sessionId="new-goal-draft";draft.messages=[];draft.state.onboarding={status:"NEEDS_CLARIFICATION",replace_existing:false};
        if(!draftKeepsPriorGoal){draft.state.active_goal_id=null;draft.state.overview={...draft.state.overview,current_goal:null,current_goal_skill_ids:[],skills:[],curriculum_spine:[],active_task:null,knowledge_cards:[],recent_evidence:[],current_frontier:null};}
        draft.state.teaching={};
        currentSession=draft;return Response.json(draft);
      }
      if(url.pathname==="/api/web/sessions/new-goal-draft/new-goal")return new Promise<Response>(resolve=>{finishNewGoal=resolve;});
      if(url.pathname==="/api/web/classroom/snapshot")return Response.json({session:currentSession,run:null,version:String(sequence),sequence});
      return fetch(url,init);
    }});
    const asset=(await readdir(join(output,"assets"))).find(name=>/^index-.*\.js$/.test(name))!;
    w.eval((await readFile(join(output,"assets",asset),"utf8")).replaceAll("import.meta.url",JSON.stringify(base)));
    const q=<T extends Element=HTMLElement>(selector:string)=>{const node=w.document.querySelector<T>(selector);assert.ok(node,selector);return node;};
    const wait=async(predicate:()=>boolean)=>{for(let i=0;i<250;i++){if(errors.length)assert.fail(errors.join("\n"));if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail("Workspace did not settle");};
    const click=(selector:string)=>q<HTMLElement>(selector).click();
    await wait(()=>Boolean(w.document.querySelector("#learner-questions textarea")));

    await t.test("a slow earlier library response cannot replace the list from a later visit",async()=>{
      let resolveOld!:(response:Response)=>void;
      const old=structuredClone(library),fresh=structuredClone(library);
      old.projects[0].goal_profile.goal_description="过期目标列表";fresh.projects[0].goal_profile.goal_description="最新目标列表";
      libraryReplies.push(new Promise(resolve=>{resolveOld=resolve;}));click('[data-workspace-target="library"]');
      await wait(()=>requests.filter(item=>item==="GET /api/web/learning-library").length>=1);
      click('[data-workspace-target="learn"]');libraryReplies.push(Promise.resolve(Response.json(fresh)));click('[data-workspace-target="library"]');
      await wait(()=>q("#learning-library-content").textContent!.includes("最新目标列表"));
      resolveOld(Response.json(old));await new Promise(resolve=>setTimeout(resolve,30));
      assert.match(q("#learning-library-content").textContent!,/最新目标列表/);
      assert.doesNotMatch(q("#learning-library-content").textContent!,/过期目标列表/);
    });
    await t.test("library loading remains read-only and never presents a stale current-task claim",async()=>{
      click('[data-workspace-target="learn"]');
      currentSession=structuredClone(original);currentSession.state.overview.active_task=null;
      let finish!:(response:Response)=>void;libraryReplies.push(new Promise(resolve=>{finish=resolve;}));
      click('[data-workspace-target="library"]');
      assert.equal(q("#learning-library-content").getAttribute("aria-busy"),"true");
      finish(Response.json(library));
      await wait(()=>!q("#learning-library-content").hasAttribute("aria-busy"));
      assert.equal(w.document.querySelector(".current-study-entry"),null);
      assert.doesNotMatch(q("#learning-library-content").textContent!,/正在学习/);
      currentSession=original;shared.onmessage({data:JSON.stringify({type:"snapshot",snapshot:{session:original,run:null,version:String(++sequence),sequence}})});
    });
    await t.test("loading a saved note source does not claim the source was deleted",async()=>{
      click('[data-workspace-target="notes"]');await wait(()=>Boolean(w.document.querySelector('[data-card-id="card-history"][data-card-action="open-card"]')));
      let finish!:(response:Response)=>void;libraryReplies.push(new Promise(resolve=>{finish=resolve;}));
      click('[data-card-id="card-history"][data-card-action="open-card"]');
      const pending=q("#knowledge-cards-panel").textContent!;
      finish(Response.json(library));await wait(()=>Boolean(w.document.querySelector('.knowledge-card[data-card-id="card-history"]')));
      assert.match(pending,/正在定位来源卡片/);assert.doesNotMatch(pending,/已删除|不可访问/);
      click("[data-card-source-return]");
    });
    await t.test("a saved note and its source survive an older library response",async()=>{
      click('[data-workspace-target="learn"]');
      let finish!:(response:Response)=>void;const stale=structuredClone(library);libraryReplies.push(new Promise(resolve=>{finish=resolve;}));
      click('[data-workspace-target="notes"]');click('[data-card-action="edit-note"][data-card-id="card-history"]');
      const input=q<HTMLTextAreaElement>('[data-note-textarea="card-history"]');input.value="刚刚保存的新笔记来源";input.dispatchEvent(new w.Event("input",{bubbles:true}));
      click('[data-card-action="save-note"][data-card-id="card-history"]');
      await wait(()=>!w.document.querySelector('[data-note-textarea="card-history"]'));
      finish(Response.json(stale));await new Promise(resolve=>setTimeout(resolve,30));
      assert.match(q("#notes-content").textContent!,/刚刚保存的新笔记来源/);
      click('[data-card-action="open-card"][data-card-id="card-history"]');await wait(()=>Boolean(w.document.querySelector('.knowledge-card[data-card-id="card-history"]')));
      assert.match(q("#knowledge-cards-panel").textContent!,/刚刚保存的新笔记来源/);click("[data-card-source-return]");
    });
    await t.test("a confirmed session end shows a receipt without reverting to an old consolidation node",async()=>{
      click('[data-workspace-target="learn"]');
      currentSession=structuredClone(original);currentSession.state.overview.active_task=null;
      currentSession.state.teaching.active_skill_id="skill-1";
      closure={goal_id:"goal-0",snapshot_signature:"latest-end",milestone_count:3,covered_milestone_count:3,route_learning_complete:true,formal_assessment_coverage_complete:false,verification_status:"NOT_INFERRED",user_confirmed_count:0,expanded_skill_count:3,latest_end_choice_status:"CONFIRMED",active_task_present:false,unscored_skill_ids:["skill-1"],milestones:[],unassigned_skills:[]};
      shared.onmessage({data:JSON.stringify({type:"snapshot",snapshot:{session:currentSession,run:null,version:String(++sequence),sequence}})});
      await wait(()=>q("#skill-card").textContent!.includes("此前结束选择已保存"));
      assert.match(q("#header-task-info").textContent!,/此前结束选择已保存/);
      assert.doesNotMatch(q("#skill-card").textContent!,/辨别常见问题/);
      assert.match(q("[data-closure-receipt]").textContent!,/缺少正式评分/);
      assert.match(q("[data-closure-receipt]").textContent!,/用户确认掌握：0/);
      currentSession=original;closure={...closure,active_task_present:true};
      shared.onmessage({data:JSON.stringify({type:"snapshot",snapshot:{session:original,run:null,version:String(++sequence),sequence}})});
      await wait(()=>q("#skill-card").textContent!.includes("神经网络"));
      currentSession=structuredClone(original);currentSession.state.overview.active_task=null;
      closure={...closure,active_task_present:false,snapshot_signature:"review-now-done"};
      shared.onmessage({data:JSON.stringify({type:"snapshot",snapshot:{session:currentSession,run:null,version:String(++sequence),sequence}})});
      await wait(()=>q("#header-task-info").textContent!.includes("此前结束选择已保存"));
      assert.doesNotMatch(q("#header-task-info").textContent!,/本次学习已结束/);
      assert.match(q("[data-closure-receipt]").textContent!,/此前结束选择已保存/);
      currentSession=original;closure={...closure,active_task_present:true};
      shared.onmessage({data:JSON.stringify({type:"snapshot",snapshot:{session:original,run:null,version:String(++sequence),sequence}})});
      await wait(()=>q("#skill-card").textContent!.includes("神经网络"));
    });
    await t.test("quickly returning to the current goal cannot be undone by an earlier slow activation",async()=>{
      slowActivation=true;click('#conversation-library-menu-button');
      await wait(()=>Boolean(w.document.querySelector('[data-conversation-action="activate"][data-session-id="old-session"]')));
      click('[data-conversation-action="activate"][data-session-id="old-session"]');await wait(()=>Boolean(finishActivation));
      click(`[data-conversation-action="activate"][data-session-id="${original.sessionId}"]`);
      const stale=structuredClone(original);stale.sessionId="old-session";stale.messages=[{role:"assistant",content:"迟到的旧目标课堂"}];
      finishActivation!(Response.json(stale));
      await new Promise(resolve=>setTimeout(resolve,60));
      assert.doesNotMatch(q("#messages").textContent!,/迟到的旧目标课堂/);
      assert.match(q("#skill-card").textContent!,/神经网络/);
      slowActivation=false;
    });
    await t.test("starting a new-goal draft clears the previous conversation before the second request returns",async()=>{
      click('[data-workspace-target="learn"]');click("#new-goal-button");
      const dialog=q<HTMLDialogElement>("#new-goal-dialog");dialog.returnValue="confirm";dialog.open=false;dialog.dispatchEvent(new w.Event("close"));
      await wait(()=>Boolean(finishNewGoal));
      const during=q("#messages").textContent!;
      const heading=q("#skill-card").textContent!;
      draft.state.onboarding.replace_existing=true;finishNewGoal!(Response.json(draft.state));
      await wait(()=>q("#messages").textContent!.includes("描述目标"));
      assert.doesNotMatch(during,/理解模型如何学习|学习记录：从概念/);
      assert.doesNotMatch(heading,/理解神经网络的输入/);
      assert.equal(requests.filter(item=>item.endsWith("/messages")).length,0,"navigation must not send a teaching message");
    });
    await t.test("an old Kernel goal closure cannot redraw its header and route over a new uninitialized draft",async()=>{
      const stale:Array<{repetition:number;header:string;route:string}>=[];
      draftKeepsPriorGoal=true;
      for(let repetition=0;repetition<2;repetition++){
        currentSession=structuredClone(original);currentSession.state.overview.active_task=null;
        closure={...closure,latest_end_choice_status:"CONFIRMED",active_task_present:false,snapshot_signature:`end-before-draft-${repetition}`};
        shared.onmessage({data:JSON.stringify({type:"snapshot",snapshot:{session:currentSession,run:null,version:String(++sequence),sequence}})});
        await wait(()=>q("#header-task-info").textContent!.includes("此前结束选择已保存"));
        finishNewGoal=undefined;click("#new-goal-button");
        const dialog=q<HTMLDialogElement>("#new-goal-dialog");dialog.returnValue="confirm";dialog.open=false;dialog.dispatchEvent(new w.Event("close"));
        await wait(()=>Boolean(finishNewGoal));
        draft.state.onboarding.replace_existing=true;finishNewGoal!(Response.json(draft.state));
        await wait(()=>q("#messages").textContent!.includes("描述目标"));
        await new Promise(resolve=>setTimeout(resolve,30));
        const header=q("#header-task-info").textContent!,route=q("#skill-route").textContent!;
        if(!header.includes("正在建立新目标")||!route.includes("新目标确认后"))stale.push({repetition,header,route});
      }
      assert.deepEqual(stale,[],"planning drafts keep their own presentation even while Kernel correctly retains the old goal");
    });
    assert.deepEqual(errors,[]);
  }finally{dom?.window.close();server?.kill();await rm(output,{recursive:true,force:true});}
});
