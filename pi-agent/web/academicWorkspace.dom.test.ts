import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, readFile, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {JSDOM} from "jsdom";
import {build} from "vite";

// 执行真实前端构建和隔离 API；JSDOM 只验交互/数据边界，不冒充像素布局验收。
test("built workspace keeps intro, record disclosures and historical card context consistent", {timeout:30_000}, async () => {
  const root=dirname(fileURLToPath(new URL("../package.json",import.meta.url)));
  const output=await mkdtemp(join(tmpdir(),"lawa-workspace-"));
  let server: ReturnType<typeof spawn> | undefined;
  let dom: JSDOM | undefined;
  try {
    await build({configFile:join(root,"web/vite.config.ts"),logLevel:"silent",build:{outDir:output}});
    server=spawn(process.execPath,["--import","tsx","src/web/academicWorkspaceFixture.ts"],{cwd:root,env:{...process.env,READABLE_PORT:"0",READABLE_STATIC_DIR:output},stdio:["ignore","pipe","pipe"]});
    const base=await new Promise<string>((resolve,reject)=>{
      let text="";
      server!.once("error",reject);
      server!.once("exit",code=>reject(new Error(`Fixture exited: ${code}`)));
      server!.stdout!.on("data",chunk=>{text+=String(chunk);const match=/Academic fixture: (http:\/\/127\.0\.0\.1:\d+)/.exec(text);if(match)resolve(match[1]!);});
    });
    dom=new JSDOM(await readFile(join(output,"index.html"),"utf8"),{url:base,runScripts:"outside-only",pretendToBeVisual:true});
    const w=dom.window;
    const errors: string[]=[];
    w.addEventListener("error",event=>errors.push(event.message));
    w.matchMedia=query=>({matches:query.includes("min-width: 821px"),media:query,addEventListener(){},removeEventListener(){}} as unknown as MediaQueryList);
    w.HTMLElement.prototype.scrollIntoView=function(){};
    w.scrollTo=()=>undefined;
    Object.assign(w,{TextDecoder,TextEncoder,Headers,Request,Response,AbortController,CSS:{escape:(text:string)=>text.replace(/[^a-zA-Z0-9_-]/g,char=>`\\${char}`)},
      ResizeObserver:class {observe(){} unobserve(){} disconnect(){}},
      EventSource:class {static OPEN=1;readyState=1;close(){}},
      fetch:(url:string,init?:RequestInit)=>fetch(new URL(url,base),init)});
    const assets=await readdir(join(output,"assets"));
    const script=assets.find(name=>/^index-.*\.js$/.test(name))!;
    // JSDOM 不执行 ES modules；仅替换 worker URL 的 import.meta，摄像头不会启动。
    w.eval((await readFile(join(output,"assets",script),"utf8")).replaceAll("import.meta.url",JSON.stringify(base)));
    const document=w.document;
    const query=<T extends Element=HTMLElement>(selector:string)=>{const node=document.querySelector<T>(selector);assert.ok(node,selector);return node;};
    const waitFor=async(predicate:()=>boolean)=>{
      for(let i=0;i<200;i++){if(errors.length)assert.fail(errors.join("\n"));if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}
      assert.fail("UI state did not settle");
    };
    const click=(selector:string)=>query<HTMLElement>(selector).click();
    await waitFor(()=>Boolean(document.querySelector("[data-action=toggle-focused-introduction]")));
    const introduction="[data-action=toggle-focused-introduction]";
    assert.equal(query(introduction).textContent,"查看介绍");
    click(introduction);
    assert.equal(query(introduction).getAttribute("aria-expanded"),"true");
    assert.equal(document.querySelectorAll(".skill-introduction-points > li").length,3);
    document.dispatchEvent(new w.KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
    assert.equal(query(introduction).textContent,"查看介绍");
    assert.equal(document.activeElement,query(introduction));
    click(introduction); click("[data-action=close-focused-introduction]");
    assert.equal(query(introduction).textContent,"查看介绍");

    const answer=query<HTMLTextAreaElement>("#learner-questions textarea");
    answer.value="保留我的未提交答案";answer.dispatchEvent(new w.Event("input",{bubbles:true}));
    click('[data-workspace-target="library"]');
    await waitFor(()=>Boolean(document.querySelector('[data-view="goals"]')));
    click('[data-view="goals"]');
    click('[data-open-goal="goal-0"]');
    await waitFor(()=>Boolean(document.querySelector(".learning-record-list")));
    await waitFor(()=>!document.querySelector('#learning-library-content[aria-busy]'));
    await new Promise(resolve=>setTimeout(resolve,100));
    query<HTMLDetailsElement>('.learning-record-list .learning-record').open=true;
    assert.ok(document.querySelector(".learning-record-list .learning-record pre code"));
    click('[data-workspace-target="notes"]');
    await waitFor(()=>Boolean(document.querySelector('[data-card-id="card-history"][data-card-action="open-card"]')));
    assert.ok(document.querySelector(".notes-question summary > .ui-icon"));
    click('[data-card-id="card-history"][data-card-action="open-card"]');
    await waitFor(()=>Boolean(document.querySelector('.knowledge-card[data-card-id="card-history"]')));
    assert.match(query("#skill-card .current-skill-title").textContent!,/Session → Context/);
    assert.equal(query("#skill-card").dataset.context,"source");
    assert.equal(query("#skill-card .focused-skill-label").textContent,"笔记来源");
    assert.equal(document.querySelector('[data-action="master"]'),null);
    click(introduction);
    assert.equal(query(".skill-introduction-heading h3").textContent,"笔记来源介绍");
    assert.doesNotMatch(query("#evidence-list").textContent!,/损失函数与训练/);
    click('[data-card-action="edit"][data-card-id="card-history"]');
    const cardAnswer=query<HTMLTextAreaElement>('[data-edit-answer="card-history"]');
    cardAnswer.value="尚未保存的来源卡片草稿";cardAnswer.dispatchEvent(new w.Event("input",{bubbles:true}));
    click("[data-card-mode]");
    assert.equal(query<HTMLTextAreaElement>('[data-edit-answer="card-history"]').value,"尚未保存的来源卡片草稿");
    click("[data-card-source-return]");
    click('[data-workspace-target="library"]');
    await waitFor(()=>Boolean(document.querySelector('[data-detail-goal="goal-0"]')));
    // 等待请求回写后仍保持展开，而不是只验证尚未被替换的旧节点。
    const oldRecord=query(".learning-record-list .learning-record");
    await waitFor(()=>query(".learning-record-list .learning-record")!==oldRecord);
    assert.equal(query<HTMLDetailsElement>(".learning-record-list .learning-record").open,true);
    click('[data-workspace-target="learn"]');
    assert.match(query("#skill-card .current-skill-title").textContent!,/神经网络/);
    assert.equal(query("#skill-card").dataset.context,"current");
    assert.equal(query<HTMLTextAreaElement>("#learner-questions textarea"),answer);
    assert.equal(answer.value,"保留我的未提交答案");
    click("#task-focus-toggle");
    assert.ok(document.querySelector('.knowledge-card[data-card-id="card-0"]'));
    assert.equal(document.querySelector('.knowledge-card[data-card-id="card-history"]'),null);
    await fetch(`${base}/fixture/materials-empty`);
    // 资料入口在无资料时可隐藏，但该页仍可由历史 hash 打开。
    w.location.hash="#materials";
    await waitFor(()=>Boolean(document.querySelector(".materials-empty-state button")));
    click(".materials-empty-state button");
    await waitFor(()=>w.location.hash==="#learn");
    assert.equal(query<HTMLTextAreaElement>("#learner-questions textarea"),answer);
    assert.equal(answer.value,"保留我的未提交答案");
    const requests=await (await fetch(`${base}/fixture/requests`)).json() as string[];
    assert.deepEqual(requests.filter(item=>!item.startsWith("GET ")),["POST /api/web/excerpt-notes/resolve-bindings", "POST /api/web/sessions"]);
    assert.deepEqual(errors,[]);
  } finally {
    dom?.window.close();
    server?.kill();
    await rm(output,{recursive:true,force:true});
  }
});
