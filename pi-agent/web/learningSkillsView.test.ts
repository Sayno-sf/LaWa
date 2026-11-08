import assert from "node:assert/strict";
import test from "node:test";
import {JSDOM} from "jsdom";
import {LearningSkillsView} from "./src/learningSkillsView.js";

const skills = [{name:"explainer-animation",description:"为具体疑惑使用短动画。",explicitOnly:false,enabled:true},
  {name:"lawa-teaching-animation",description:"两个精确教学演示。",explicitOnly:false,enabled:true}];

function fixture(fetcher:typeof fetch) {
  const dom = new JSDOM('<!doctype html><body><textarea id="preference">尚未保存的教学偏好</textarea><section id="confirmed">已确认的教法</section></body>');
  const previous = {document:globalThis.document,fetch:globalThis.fetch};
  Object.assign(globalThis,{document:dom.window.document,fetch:fetcher});
  const view = new LearningSkillsView();
  document.body.append(view.node);
  return {view,close:()=>{Object.assign(globalThis,previous);dom.window.close();}};
}

test("the skill section reads only the catalog and renders plugin text without executing markup",async()=>{
  const requests:Array<{url:string;method:string}> = [];
  const h=fixture(async(input,init)=>{
    requests.push({url:String(input),method:init?.method??"GET"});
    return Response.json({skills:[...skills,{name:"unknown-helper",description:'<img src=x onerror="alert(1)">',explicitOnly:true,enabled:true}],truncated:false});
  });
  try {
    await h.view.load();
    assert.deepEqual(requests,[{url:"/api/web/learning-skills",method:"GET"}]);
    assert.equal(h.view.node.getAttribute("aria-label"),"技能插件");
    assert.deepEqual([...h.view.node.querySelectorAll("h4")].map(n=>n.textContent),["互动讲解动画","基础教学演示","unknown-helper"]);
    assert.equal(h.view.node.querySelector("img"),null);
    assert.match(h.view.node.textContent!,/已开启/);
    assert.match(h.view.node.textContent!,/<img src=x/);
    assert.equal(h.view.node.querySelector(".learning-skills-feedback button")!.hidden,true);
    assert.equal((document.querySelector("textarea") as HTMLTextAreaElement).value,"尚未保存的教学偏好");
  } finally {h.close();}
});

test("failure and retry stay within the skill section and retain the existing list and preference draft",async()=>{
  let reads=0;
  const h=fixture(async()=>++reads===2?new Response("unavailable",{status:503}):Response.json({skills,truncated:false}));
  try {
    await h.view.load();
    await h.view.load();
    assert.equal(h.view.node.querySelectorAll(".learning-skill").length,2);
    assert.match(h.view.node.querySelector("[role=status]")!.textContent!,/暂时无法读取/);
    const retry=h.view.node.querySelector(".learning-skills-feedback button")!;
    assert.equal(retry.hidden,false);
    retry.click();
    await new Promise<void>(done=>setImmediate(done));
    assert.equal(reads,3);
    assert.equal(retry.hidden,true);
    assert.equal(h.view.node.querySelector("[role=status]")!.textContent,"");
    assert.equal((document.querySelector("textarea") as HTMLTextAreaElement).value,"尚未保存的教学偏好");
    assert.equal(document.querySelector("#confirmed")!.textContent,"已确认的教法");
  } finally {h.close();}
});

test("navigation reentry shares the pending catalog read and an empty result remains explicit",async()=>{
  let reads=0,resolve!: (value:Response)=>void;
  const h=fixture(async()=>{reads++;return new Promise<Response>(done=>{resolve=done;});});
  try {
    const pending=h.view.load();
    assert.equal(h.view.load(),pending);
    assert.equal(reads,1);
    assert.equal(h.view.node.getAttribute("aria-busy"),"true");
    resolve(Response.json({skills:[],truncated:false}));
    await pending;
    assert.match(h.view.node.querySelector("[role=status]")!.textContent!,/还没有已安装/);
    assert.equal(h.view.node.getAttribute("aria-busy"),"false");
    assert.equal(h.view.node.querySelector(".learning-skills-feedback button")!.hidden,true);
  } finally {h.close();}
});
test("switch saves the selected skill and reflects persisted state",async()=>{
 let enabled=true;const writes:unknown[]=[];
 const h=fixture(async(_input,init)=>{if(init?.method==="PUT"){const body=JSON.parse(String(init.body));writes.push(body);enabled=body.enabled;}return Response.json({skills:[{...skills[0],enabled}],truncated:false});});
 try {await h.view.load();const button=h.view.node.querySelector<HTMLButtonElement>('[role="switch"]')!;button.click();await new Promise<void>(done=>setImmediate(done));assert.deepEqual(writes,[{name:"explainer-animation",enabled:false}]);assert.equal(h.view.node.querySelector('[role="switch"]')!.getAttribute("aria-checked"),"false");}finally{h.close();}
});

test("import reviews an existing name before replacing, then remove and restore preserve the preference draft",async()=>{
  let replaced=false,removed=false;const writes:Array<{url:string;method:string;revision:unknown}>=[];
  const imported={name:"comparison-guide",displayName:"对照讲解",description:"用同一个例子比较两个概念。",enabled:true,explicitOnly:false};
  const catalog=()=>({revision:"r1",skills:removed?[]:[imported],truncated:false,available:removed?[{name:imported.name,displayName:imported.displayName,description:imported.description}]:[]});
  const h=fixture(async(input,init)=>{
    const url=String(input);if(init?.method){writes.push({url,method:init.method,revision:(init.headers as Record<string,string>)["X-Skill-Revision"]});}
    if(url.endsWith("/install")){
      if(!(init?.headers as Record<string,string>)["X-Skill-Revision"])return Response.json({detail:"已安装，可以替换。",conflict:{name:imported.name,revision:"r1"}},{status:409});
      replaced=true;return Response.json({...catalog(),installed:{name:imported.name,hasScripts:false}});
    }
    if(init?.method==="DELETE")removed=true;if(url.endsWith("/restore"))removed=false;
    return Response.json(catalog());
  });
  const settle=()=>new Promise<void>(done=>setImmediate(done));
  try{
    await h.view.load();const input=h.view.node.querySelector<HTMLInputElement>('input[type=file]')!;
    const file=new document.defaultView!.File(["skill"],"method.zip",{type:"application/zip"});Object.defineProperty(input,"files",{value:[file],configurable:true});
    input.dispatchEvent(new document.defaultView!.Event("change"));await settle();
    assert.equal(replaced,false);assert.equal(h.view.node.querySelector<HTMLElement>(".learning-skills-replacement")!.hidden,false);
    h.view.node.querySelector<HTMLButtonElement>(".learning-skills-replacement button")!.click();await settle();assert.equal(replaced,true);assert.equal(writes[1]!.revision,"r1");
    h.view.node.querySelector<HTMLButtonElement>('[aria-label="移除对照讲解"]')!.click();await settle();assert.equal(h.view.node.querySelectorAll(".learning-skill").length,0);
    assert.equal(h.view.node.querySelector<HTMLDetailsElement>("details")!.hidden,false);
    h.view.node.querySelector<HTMLButtonElement>('[aria-label="添加对照讲解"]')!.click();await settle();assert.equal(h.view.node.querySelectorAll(".learning-skill").length,1);
    assert.equal((document.querySelector("textarea") as HTMLTextAreaElement).value,"尚未保存的教学偏好");
    assert.deepEqual(writes.map(w=>w.method),["POST","POST","DELETE","POST"]);
  }finally{h.close();}
});
