import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { AssistantView, type AssistantSnapshot } from "./src/assistantView.js";
import type {AnimationAnchor} from "../src/animationTypes.js";

const payload = (taskId = "task-1"): AssistantSnapshot => ({ available: true, scope: { goalId: "goal-1", taskId, skillId: "skill-1", attemptId: taskId, mainSessionId: "session-1" }, messages: [], busy: false });
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error("Assistant UI did not settle");
}
function fixture() {
  const dom = new JSDOM(`<button id="assistant-entry"></button><div class="learning-stage-viewport"></div><aside class="context-column"></aside><aside id="assistant-dock"></aside><section id="assistant-panel"><button id="assistant-close"></button><div id="assistant-messages"></div><span id="assistant-source"></span><p id="assistant-notice"></p><p id="assistant-status"></p><button id="assistant-retry"></button><form id="assistant-composer"><textarea id="assistant-input"></textarea><button id="assistant-send" type="submit"></button><button id="assistant-stop" type="button"></button></form></section>`, { url: "http://localhost" });
  const { window } = dom;
  Object.defineProperty(window, "matchMedia", { value: () => ({ matches: false, addEventListener() {} }) });
  for (const [key, value] of Object.entries({ window, document: window.document, HTMLElement: window.HTMLElement, Event: window.Event })) Object.defineProperty(globalThis, key, { value, configurable: true });
  const view = new AssistantView(() => undefined);
  view.setContext({ sessionId: "session-1", key: "session-1:task-1", available: true, taskTitle: "解释 async", teacherBusy: false });
  const input = window.document.querySelector<HTMLTextAreaElement>("#assistant-input")!;
  return { dom, view, input, form: window.document.querySelector<HTMLFormElement>("form")!, send: window.document.querySelector<HTMLButtonElement>("#assistant-send")!, status: window.document.querySelector<HTMLElement>("#assistant-status")! };
}

const animationAnchor:AnimationAnchor={presentation_id:"presentation",source_entry_id:"tool-entry",artifact_sha256:"a".repeat(64),scene_id:"start:1",scene_elapsed_ms:148.25,selected_object_id:null,explainer_path:["start"]};

test("ask this animation step opens TA without sending or altering an existing draft, then submits its exact anchor",async()=>{
  const bodies:Record<string,unknown>[]=[];
  globalThis.fetch=async(_url,init)=>{
    if(init?.method!=="POST")return Response.json(payload());
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({type:"text_delta",text:"当前这一份保持不变。"})+"\n");
  };
  const {dom,view,input,form,status}=fixture();
  try{
    input.value="我原来的助教问题";
    view.openForAnimation(animationAnchor);
    await until(()=>!status.textContent?.includes("恢复"));
    assert.equal(view.isOpen,true);assert.equal(input.value,"我原来的助教问题");assert.equal(bodies.length,0);
    assert.match(input.placeholder,/动画/);assert.equal(dom.window.document.querySelector(".animation-composer-reference"),null);
    form.dispatchEvent(new dom.window.Event("submit",{cancelable:true}));
    await until(()=>bodies.length===1&&!view.busy);
    assert.deepEqual(bodies[0],{text:"我原来的助教问题",animation_context:animationAnchor});
    assert.doesNotMatch(input.placeholder,/动画/);
  }finally{dom.window.close();}
});

test("failed animation question retains the precise position; closing and changing scope release it without losing text",async()=>{
  const bodies:Record<string,unknown>[]=[];
  globalThis.fetch=async(_url,init)=>{
    if(init?.method!=="POST")return Response.json(payload());
    bodies.push(JSON.parse(String(init.body)));return Response.json({detail:"临时失败"},{status:503});
  };
  const {dom,view,input,form,status}=fixture();
  try{
    view.openForAnimation(animationAnchor);await until(()=>!status.textContent?.includes("恢复"));
    input.value="为什么这里停住？";form.dispatchEvent(new dom.window.Event("submit",{cancelable:true}));
    await until(()=>bodies.length===1&&!view.busy&&input.value==="为什么这里停住？");
    assert.match(input.placeholder,/动画/);assert.deepEqual(bodies[0]!.animation_context,animationAnchor);
    view.setOpen(false);view.setOpen(true);assert.equal(input.value,"为什么这里停住？");assert.doesNotMatch(input.placeholder,/动画/);
    view.openForAnimation(animationAnchor);view.clearAnimationContext();assert.doesNotMatch(input.placeholder,/动画/);
    view.openForAnimation(animationAnchor);view.setContext({sessionId:"session-1",key:"session-1:task-2",available:true,taskTitle:"下一任务",teacherBusy:false});
    assert.doesNotMatch(input.placeholder,/动画/);assert.equal(bodies.length,1);
  }finally{dom.window.close();}
});

test("opening and closing TA preserves an unsent independent draft without any POST", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (_url, init) => { calls.push(init?.method ?? "GET"); return Response.json(payload()); };
  const { dom, view, input } = fixture();
  try {
    view.setOpen(true); await until(() => !dom.window.document.querySelector("#assistant-status")?.textContent?.includes("恢复"));
    input.value = "await 为什么要等待？"; input.dispatchEvent(new dom.window.Event("input"));
    view.setOpen(false); view.setOpen(true);
    assert.equal(input.value, "await 为什么要等待？");
    assert.deepEqual(calls, ["GET"]);
    assert.equal(view.visibleInClassroom, true);
  } finally { dom.window.close(); }
});

test("teacher generation blocks TA submission while preserving its draft", async () => {
  let posts = 0;
  globalThis.fetch = async (_url, init) => { if (init?.method === "POST") posts++; return Response.json(payload()); };
  const { dom, view, input, form, send } = fixture();
  try {
    view.setOpen(true); await until(() => !dom.window.document.querySelector("#assistant-status")?.textContent?.includes("恢复"));
    input.value = "请求帮助"; input.dispatchEvent(new dom.window.Event("input"));
    view.setTeacherBusy(true); form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    assert.equal(send.disabled, true); assert.equal(input.value, "请求帮助"); assert.equal(posts, 0);
    view.setTeacherBusy(false); assert.equal(send.disabled, false);
  } finally { dom.window.close(); }
});

test("same-task question changes preserve the editing draft, while another session cannot inherit it", async () => {
  let attempt = 0;
  globalThis.fetch = async () => Response.json({...payload(),scope:{...payload().scope!,attemptId:`question-${++attempt}`}});
  const {dom,view,input,status}=fixture();
  const draftScope={goalId:"goal-1",taskId:"task-1",skillId:"skill-1"};
  try {
    view.setContext({sessionId:"session-1",key:"question-1",draftScope,available:true,taskTitle:"原任务",teacherBusy:true});
    view.setOpen(true);await until(()=>!status.textContent?.includes("恢复"));
    input.value="同一任务里仍在写的问题";input.dispatchEvent(new dom.window.Event("input"));input.focus();
    view.setContext({sessionId:"session-1",key:"question-2",draftScope,available:true,taskTitle:"原任务",teacherBusy:false});
    await until(()=>!status.textContent?.includes("恢复"));
    assert.equal(input.value,"同一任务里仍在写的问题");assert.equal(dom.window.document.activeElement,input);
    assert.equal(dom.window.document.querySelector<HTMLElement>(".assistant-draft-recovery")!.hidden,true);
    view.setContext({sessionId:"session-1",key:"task-ended",draftScope:{...draftScope,taskId:null,skillId:null},available:false,taskTitle:"任务已结束",teacherBusy:false});
    await until(()=>!status.textContent?.includes("恢复"));
    assert.equal(input.value,"同一任务里仍在写的问题");assert.equal(input.disabled,false);assert.equal(input.readOnly,true);
    input.focus();assert.equal(dom.window.document.activeElement,input);
    view.setContext({sessionId:"session-1",key:"goal-ended",draftScope:{goalId:null,taskId:null,skillId:null},available:false,taskTitle:"目标已结束",teacherBusy:false});
    await until(()=>!status.textContent?.includes("恢复"));
    assert.equal(input.value,"同一任务里仍在写的问题");assert.equal(input.readOnly,true);
    view.setContext({sessionId:"another-session",key:"another-session",draftScope,available:true,taskTitle:"另一会话",teacherBusy:false});
    await until(()=>!status.textContent?.includes("恢复"));
    assert.equal(input.value,"");
  } finally {dom.window.close();}
});

test("unavailable card context retains a return action with existing assistant messages", async () => {
  const saved = payload(); saved.messages = [{id: "reply",role: "assistant",content: "已有解释"}];
  globalThis.fetch = async () => Response.json(saved);
  const {dom,view,input,status} = fixture();
  try {
    view.setOpen(true); await until(() => !status.textContent?.includes("恢复"));
    view.setContext({sessionId:"session-1", key:"session-1:task-1", available:false, canReturn:true, taskTitle:"当前任务", teacherBusy:false});
    assert.ok(dom.window.document.querySelector("[data-return-current]"));
    assert.equal(input.disabled,true);
    assert.match(dom.window.document.querySelector("#assistant-messages")!.textContent!, /已有解释/);
  } finally {dom.window.close();}
});

test("closing the assistant before an automatic task switch still offers its unsent source draft when reopened", async () => {
  let posts = 0;
  globalThis.fetch = async (_url, init) => { if (init?.method === "POST") posts++; return Response.json(payload()); };
  const {dom,view,input,status} = fixture();
  try {
    view.setContext({sessionId:"session-1",key:"question-1",draftScope:{goalId:"goal-1",taskId:"task-1",skillId:"skill-1"},available:true,taskTitle:"旧题任务",teacherBusy:true});
    view.setOpen(true);await until(()=>!status.textContent?.includes("恢复"));
    input.value="自动换题前未发送的问题";input.dispatchEvent(new dom.window.Event("input"));
    view.setOpen(false);
    view.setContext({sessionId:"session-1",key:"task-between",draftScope:{goalId:"goal-1",taskId:null,skillId:null},available:false,taskTitle:"",teacherBusy:true});
    view.setContext({sessionId:"session-1",key:"question-2",draftScope:{goalId:"goal-1",taskId:"task-2",skillId:"skill-2"},available:true,taskTitle:"自动生成的新题",teacherBusy:false});
    view.setOpen(true);await until(()=>!status.textContent?.includes("恢复"));
    assert.equal(input.value,"自动换题前未发送的问题");
    assert.equal(dom.window.document.querySelector<HTMLElement>(".assistant-draft-recovery")!.hidden,false);
    assert.match(dom.window.document.querySelector(".assistant-draft-recovery")!.textContent!,/旧题任务/);
    assert.equal(dom.window.document.querySelector<HTMLButtonElement>("#assistant-send")!.disabled,true);
    assert.equal(posts,0,"draft recovery must not submit the old question to the new task");
    view.setContext({sessionId:"session-1",key:"question-1-history",draftScope:{goalId:"goal-1",taskId:"task-1",skillId:"skill-1"},available:false,taskTitle:"旧题任务",teacherBusy:false});
    await until(()=>!status.textContent?.includes("恢复"));
    assert.equal(input.value,"自动换题前未发送的问题");
    assert.equal(input.readOnly,true);
  } finally {dom.window.close();}
});

test("unsent assistant drafts are page-local and a new browser document does not replay or submit them", async () => {
  let posts=0;
  globalThis.fetch=async(_url,init)=>{if(init?.method==="POST")posts++;return Response.json(payload());};
  const first=fixture();
  first.input.value="只保留在本页的未发送草稿";first.input.dispatchEvent(new first.dom.window.Event("input"));
  first.dom.window.close();
  const refreshed=fixture();
  try{
    refreshed.view.setOpen(true);await until(()=>!refreshed.status.textContent?.includes("恢复"));
    assert.equal(refreshed.input.value,"");
    assert.equal(posts,0,"a page reload must never turn an unsent draft into a question or evidence");
  }finally{refreshed.dom.window.close();}
});

test("a late consultation response cannot replace a new task and per-task drafts restore", async () => {
  let resolveOld!: (value: Response) => void;
  const old = new Promise<Response>(resolve => { resolveOld = resolve; });
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? old : Response.json(payload(calls === 2 ? "task-2" : "task-1"));
  const { dom, view, input } = fixture();
  try {
    view.setOpen(true);
    input.value = "原任务草稿"; input.dispatchEvent(new dom.window.Event("input"));
    view.setContext({ sessionId: "session-1", key: "session-1:task-2", available: true, taskTitle: "新任务", teacherBusy: false });
    await until(() => calls === 2 && !dom.window.document.querySelector("#assistant-status")?.textContent?.includes("恢复"));
    const late = payload(); late.messages = [{ id: "old", role: "assistant", content: "迟到的旧回答" }]; resolveOld(Response.json(late));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.doesNotMatch(dom.window.document.querySelector("#assistant-messages")!.textContent!, /迟到/);
    assert.equal(input.value, "");
    view.setContext({ sessionId: "session-1", key: "session-1:task-1", available: true, taskTitle: "原任务", teacherBusy: false });
    await until(() => calls === 3 && input.value === "原任务草稿");
    assert.equal(input.value, "原任务草稿");
  } finally { dom.window.close(); }
});

test("stream errors restore the user draft and reload persisted records rather than leaving fake saved messages", async () => {
  let posts = 0;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "POST") { posts++; return new Response(JSON.stringify({ detail: "临时不可用" }), { status: 503 }); }
    return Response.json(payload());
  };
  const { dom, view, input, form, status } = fixture();
  try {
    view.setOpen(true); await until(() => !status.textContent?.includes("恢复"));
    input.value = "原始问题"; form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await until(() => posts === 1 && !view.busy && input.value === "原始问题" && status.textContent === "临时不可用");
    await until(() => dom.window.document.querySelectorAll(".assistant-message").length === 0);
    assert.equal(input.value, "原始问题"); assert.equal(status.getAttribute("role"), "alert");
  } finally { dom.window.close(); }
});

test("initial persisted user state keeps subsequent streamed reply visible before completion", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const initial = payload(); initial.busy = true; initial.messages = [{ id: "user-saved", role: "user", content: "解释等待" }];
  const final = payload(); final.messages = [...initial.messages, { id: "reply-saved", role: "assistant", content: "先等待结果。" }];
  let sent = false;
  globalThis.fetch = async (_url, init) => {
    if (init?.method !== "POST") return Response.json(sent ? final : payload());
    sent = true;
    return new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; value.enqueue(new TextEncoder().encode(JSON.stringify({ type: "assistant_state", assistant: initial }) + "\n" + JSON.stringify({ type: "text_delta", text: "先等待结果。" }) + "\n")); } }));
  };
  const { dom, view, input, form, status } = fixture();
  try {
    view.setOpen(true); await until(() => !status.textContent?.includes("恢复"));
    input.value = "解释等待"; form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await until(() => dom.window.document.querySelector("#assistant-messages")!.textContent!.includes("先等待结果。"));
    assert.equal(view.busy, true);
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: "assistant_state", assistant: final }) + "\n")); controller.close();
    await until(() => !view.busy);
    assert.equal(dom.window.document.querySelectorAll(".assistant-message.assistant").length, 1);
  } finally { dom.window.close(); }
});
