import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ExcerptNotes,excerptFragment,type ResolvedNoteSource} from "./excerptNotes.js";
import {ConversationCatalog} from "./conversationCatalog.js";
import {WebSessionStore} from "./sessionStore.js";
import {JSDOM} from "jsdom";
import {renderMarkdown} from "../../web/src/markdown.js";
import {AssistantStore} from "../assistantStore.js";
import {createGateway} from "./gateway.js";
import {StudyTimeStore} from "./studyTimeStore.js";
import type {RetrievalRuntime} from "../retrieval/runtime.js";
import {once} from "node:events";
const source:ResolvedNoteSource={source:{sessionId:"s",messageId:"m",channel:"teacher"},content:"你好世界",role:"assistant",goalId:"g",skillId:"k"};
test("excerpt persists immutable source, original time and learner understanding; duplicate retry is idempotent",()=>{
 const file=join(mkdtempSync(join(tmpdir(),"lawa-excerpts-")),"notes.json");const store=new ExcerptNotes(file);
 const note=store.save(source,{start:0,end:2,quote:"你好",understanding:"当场记录"});assert.equal(new ExcerptNotes(file).get(note.id).understanding,"当场记录");assert.equal(store.save(source,{start:0,end:2,quote:"你好"}).id,note.id);
 store.update(note.id,"我的理解");const restored=new ExcerptNotes(file).get(note.id);assert.equal(restored.createdAt,note.createdAt);assert.equal(restored.understanding,"我的理解");assert.equal(restored.content,source.content);assert.equal(restored.skillId,"k");
});
test("code indentation, newlines, operators and inline-code formatting survive partial selection",()=>{
 const code="```ts\n  a_b * 2\n  c < 3\n```";const dom=new JSDOM(renderMarkdown(code));const start=dom.window.document.body.textContent!.indexOf("a_b * 2");dom.window.close();
 assert.equal(excerptFragment(code,start,start+7,"a_b * 2"),"<pre><code>a_b * 2</code></pre>");
 assert.equal(excerptFragment("`a_b`",0,3,"a_b"),"<code>a_b</code>");
 assert.match(excerptFragment("```\n  a\n  b\n```",4,11,"  a\n  b"),/  a\n  b/);
});
test("forged, empty, fractional and stale selections are rejected without overwriting notes",()=>{
 const store=new ExcerptNotes();for(const input of [{start:0,end:2,quote:"错误"},{start:-1,end:2,quote:"你好"},{start:0.5,end:2,quote:"你好"},{start:0,end:90,quote:"你好"}])assert.throws(()=>store.save(source,input));assert.equal(store.list().length,0);
});
test("rendered HTML cannot inject executable source",()=>{assert.doesNotMatch(excerptFragment("<script>alert(1)</script>",0,25,"<script>alert(1)</script>"),/<script>/);});
test("corrupt persisted notes fail closed",()=>{const file=join(mkdtempSync(join(tmpdir(),"lawa-excerpts-")),"notes.json");writeFileSync(file,"broken");assert.throws(()=>new ExcerptNotes(file));assert.equal(readFileSync(file,"utf8"),"broken");});
test("historical source resolves original branch knowledge, never current classroom, and rejects foreign sessions",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"lawa-note-source-")),catalog=new ConversationCatalog(directory,directory),manager=catalog.create();catalog.recordGoal(manager,"old-goal","原目标");
 manager.appendMessage({role:"toolResult",toolCallId:"t",toolName:"record_teaching_turn",content:[{type:"text",text:JSON.stringify({active_skill_id:"old-skill"})}],isError:false,timestamp:Date.now()});
 const id=manager.appendMessage({role:"user",content:"原回答",timestamp:Date.now()});
 catalog.recordGoal(manager,"new-goal","新目标",true);
 const store=new WebSessionStore({conversationDir:directory,conversationCwd:directory,fetchOverview:async()=>{throw new Error("must not activate/read current learning");}});
 const resolved=await store.resolveNoteSource({sessionId:manager.getSessionId(),messageId:id,channel:"teacher"});assert.equal(resolved.goalId,"old-goal");assert.equal(resolved.skillId,"old-skill");assert.equal(resolved.content,"原回答");
 await assert.rejects(store.resolveNoteSource({sessionId:"../../foreign",messageId:id,channel:"teacher"}));await assert.rejects(store.resolveNoteSource({sessionId:manager.getSessionId(),messageId:"missing",channel:"teacher"}));
});
test("assistant excerpts use persisted consultation scope and exact user/assistant IDs",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"lawa-helper-note-")),catalog=new ConversationCatalog(directory,directory),manager=catalog.create(),assistants=new AssistantStore();
 const scope={goalId:"old-goal",taskId:"old-task",skillId:"old-skill",mainSessionId:manager.getSessionId(),branchId:"branch",questionId:null,attemptId:null};
 await assistants.send(scope,"我不明白",{},()=>{},async options=>({prompt:async()=>{options.onEvent({type:"assistant_delta",delta:"看原来的两个量。"});},abort:async()=>{},dispose:()=>{}}));
 const store=new WebSessionStore({conversationDir:directory,conversationCwd:directory,assistantStore:assistants});
 for(const message of assistants.get(scope).messages){const source=await store.resolveNoteSource({sessionId:manager.getSessionId(),messageId:message.id,channel:"assistant"});assert.equal(source.skillId,"old-skill");assert.equal(source.content,message.content);assert.equal(source.role,message.role);}
 assert.equal(assistants.noteMessage("foreign",assistants.get(scope).messages[0]!.id),null);
});
test("real note API validates source, refuses foreign origin, persists understanding and reads original without classroom writes",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"lawa-note-api-")),catalog=new ConversationCatalog(directory,directory),manager=catalog.create();catalog.recordGoal(manager,"g","目标");const id=manager.appendMessage({role:"user",content:"你好世界",timestamp:Date.now()});
 const store=new WebSessionStore({conversationDir:directory,conversationCwd:directory,fetchOverview:async()=>{throw new Error("must not read current classroom");}});
 const gateway=createGateway({store,studyTime:new StudyTimeStore(join(directory,"time.json")),retrieval:{scopeChanged:()=>{}} as unknown as RetrievalRuntime});gateway.listen(0,"127.0.0.1");await once(gateway,"listening");const address=gateway.address();assert.ok(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}/api/web/excerpt-notes`;
 try{
 const input={source:{sessionId:manager.getSessionId(),messageId:id,channel:"teacher"},start:0,end:2,quote:"你好",skillId:"forged"};
 assert.equal((await fetch(base,{method:"POST",headers:{"Content-Type":"application/json",Origin:"https://foreign.invalid"},body:JSON.stringify(input)})).status,403);
 const saved=await fetch(base,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});assert.equal(saved.status,200);const note=await saved.json() as {id:string;skillId:string|null};assert.equal(note.skillId,null);
 const bad=await fetch(base,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...input,quote:"伪造"})});assert.equal(bad.status,409);
 assert.equal((await fetch(`${base}/${note.id}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({understanding:"我理解了区别"})})).status,200);
 const original=await(await fetch(`${base}/${note.id}/source`)).json() as {content:string;messages:Array<{id:string;content:string}>};assert.equal(original.content,"你好世界");assert.equal(original.messages.at(-1)?.id,id);assert.equal((await(await fetch(base)).json() as unknown[]).length,1);
 }finally{gateway.closeAllConnections();await new Promise<void>(done=>gateway.close(()=>done()));}
});

test("practice and assessment receipts bind historical excerpts and repair saved unknowns without changing timestamps",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"lawa-note-bindings-")),catalog=new ConversationCatalog(directory,directory),manager=catalog.create();catalog.recordGoal(manager,"g","目标");
 const receipt=(toolName:string,value:unknown,isError=false)=>manager.appendMessage({role:"toolResult",toolCallId:"t",toolName,content:[{type:"text",text:JSON.stringify(value)}],isError,timestamp:Date.now()});
 const user=()=>manager.appendMessage({role:"user",content:"我的问题",timestamp:Date.now()});
 receipt("present_practice_set",{request:{goal_id:"g",skill_id:"practice"}});const first=user();
 receipt("record_answer_assessment",{assessment:{goal_id:"g",skill_id:"assessment"}});const second=user();
 receipt("present_practice_set",{request:{goal_id:"g",skill_id:"failed"}},true);const failed=user();
 receipt("activate_learning_task",{goal_id:"g",related_skill_ids:["a","b"]});const multiple=user();
 const store=new WebSessionStore({conversationDir:directory,conversationCwd:directory});
 const resolve=(id:string)=>store.resolveNoteSource({sessionId:manager.getSessionId(),messageId:id,channel:"teacher"});
 assert.equal((await resolve(first)).skillId,"practice");assert.equal((await resolve(second)).skillId,"assessment");assert.equal((await resolve(failed)).skillId,"assessment");assert.equal((await resolve(multiple)).skillId,null);
 const note=store.excerptNotes.save({...await resolve(first),skillId:null},{start:0,end:2,quote:"我的",understanding:"理解"});
 await store.repairNoteBindings();const repaired=store.excerptNotes.get(note.id);assert.equal(repaired.skillId,"practice");assert.equal(repaired.updatedAt,note.updatedAt);assert.equal(repaired.understanding,"理解");
});
test("exact message anchors recover missing goal and skill without borrowing a sibling anchor",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"lawa-note-anchor-")),catalog=new ConversationCatalog(directory,directory),manager=catalog.create();
 const first=manager.appendMessage({role:"user",content:"早期消息",timestamp:Date.now()});const other=manager.appendMessage({role:"user",content:"另一消息",timestamp:Date.now()});
 manager.appendCustomEntry("lawa.skill-anchor",{goalId:"g",skillId:"s",entryId:first});
 const store=new WebSessionStore({conversationDir:directory,conversationCwd:directory});
 const resolved=await store.resolveNoteSource({sessionId:manager.getSessionId(),messageId:first,channel:"teacher"});assert.equal(resolved.goalId,"g");assert.equal(resolved.skillId,"s");
 assert.equal((await store.resolveNoteSource({sessionId:manager.getSessionId(),messageId:other,channel:"teacher"})).skillId,null);
});
