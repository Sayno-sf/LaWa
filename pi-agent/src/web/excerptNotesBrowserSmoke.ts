import assert from "node:assert/strict";
import {createServer} from "vite";
import {chromium} from "playwright-core";
import {mkdirSync} from "node:fs";
import {resolve} from "node:path";
import {ExcerptNotes,type ResolvedNoteSource} from "./excerptNotes.js";
import {renderMarkdown} from "../../web/src/markdown.js";
const store=new ExcerptNotes();
const sources:Record<string,ResolvedNoteSource>={};
for(const [id,role,channel]of [["teacher","assistant","teacher"],["self","user","teacher"],["helper","assistant","assistant"]]as const)sources[id]={source:{sessionId:"fixture",messageId:id,channel},role,goalId:"g",skillId:"k",content:"先看这里。重复，再看重复。\n\n```ts\n  const a_b = 2;\n  a_b * 3\n```"};
const html=`<!doctype html><html lang="zh"><body><main style="max-width:840px;margin:40px auto;font:18px/1.7 sans-serif"><div class="learning-stage"><div id="messages">${["teacher","self"].map(id=>`<article><h3>${id==="teacher"?"老师":"我"}</h3><div data-note-message="${id}" data-note-session="fixture" data-note-channel="teacher">${renderMarkdown(sources[id]!.content)}</div></article>`).join("")}</div><div id="assistant-messages"><h3>助教</h3><div data-note-message="helper" data-note-session="fixture" data-note-channel="assistant">${renderMarkdown(sources.helper!.content)}</div></div></div><section id="notes-page"><h2>我的笔记</h2><input data-collection-search="notes" placeholder="搜索"><div id="notes-content"><section class="notes-group"><strong>卡片知识点</strong><article class="notes-item" data-reading-key="card1"><div class="notes-note notes-note-preview">从卡片留下的理解</div><time datetime="2026-10-20T00:00:00Z"></time></article></section></div></section></main><script type="module">import {ExcerptNotesView} from '/src/excerptNotesView.ts';new ExcerptNotesView(()=>"fixture",()=>{},()=>"代码与表达式",()=>{},()=>{});</script></body></html>`;
const server=await createServer({configFile:false,appType:"custom",root:resolve("web"),server:{host:"127.0.0.1",port:0}});
server.middlewares.use(async(req,res,next)=>{
 if(req.url==="/fixture"){res.setHeader("Content-Type","text/html; charset=utf-8");res.end(html);return;}
 if(!req.url?.startsWith("/api/web/excerpt-notes")){next();return;}
 res.setHeader("Content-Type","application/json");try{
 const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const input=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
 const match=req.url.match(/excerpt-notes\/([^/]+)(\/source)?$/);let result:unknown;
 if(match?.[1]==="resolve-bindings")result=store.list();
 else if(match&&match[2]){const original=sources[store.get(match[1]!).source.messageId]!;result={...original,messages:[{id:"previous",role:"assistant",content:"这是选段之前的上下文。"},{id:original.source.messageId,role:original.role,content:original.content}]};}
 else if(match)result=store.update(match[1]!,input.understanding);
 else if(req.method==="POST")result=store.save(sources[input.source.messageId]!,input);
 else result=store.list();res.end(JSON.stringify(result));
 }catch(error){res.statusCode=409;res.end(JSON.stringify({detail:String(error)}));}
});
await server.listen();const address=server.httpServer!.address();assert.ok(address&&typeof address!=="string");
const browser=await chromium.launch({headless:true,executablePath:process.env.RESPONSIVE_BROWSER_PATH??"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"});
const page=await browser.newPage({viewport:{width:1260,height:900}});const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
async function select(id:string,text:string,last=false){await page.locator(`[data-note-message="${id}"]`).scrollIntoViewIfNeeded();await page.evaluate(({id,text,last})=>{const root=document.querySelector<HTMLElement>(`[data-note-message="${id}"]`)!;const full=root.textContent!;const start=last?full.lastIndexOf(text):full.indexOf(text);const walker=document.createTreeWalker(root,4);let node:Node|null,offset=0,begun=false;const range=document.createRange();while((node=walker.nextNode())){const n=node.textContent!.length;if(!begun&&start<offset+n){range.setStart(node,start-offset);begun=true;}if(begun&&start+text.length<=offset+n){range.setEnd(node,start+text.length-offset);break;}offset+=n;}getSelection()!.removeAllRanges();getSelection()!.addRange(range);},{id,text,last});await page.locator(".excerpt-save").waitFor({state:"visible"});}
try{
 await page.goto(`http://127.0.0.1:${address.port}/fixture`);
 assert.equal(await page.locator('#notes-tab-cards').getAttribute('aria-selected'),'true');
 await select("teacher","  const a_b = 2;\n  a_b * 3");
 await page.getByRole("button",{name:"记笔记",exact:true}).click();
 assert.equal(store.list().length,0,"opening the editor must not persist a note");
 await page.locator('#excerpt-understanding').fill('保留缩进才能读清代码。');
 assert.equal(await page.locator('.excerpt-editor').innerText().then(text=>text.includes('const a_b')),false);
 assert.equal(await page.evaluate(()=>(CSS as unknown as {highlights:Map<string,unknown>}).highlights.has('note-selection')),true);
 await page.evaluate(()=>{const root=document.querySelector("#messages")!;root.innerHTML=root.innerHTML;});
 assert.equal(await page.locator('#excerpt-understanding').inputValue(),'保留缩进才能读清代码。');
 await page.route('**/api/web/excerpt-notes',async route=>{if(route.request().method()==='POST')await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({detail:'测试保存失败，请重试'})});else await route.continue();});
 await page.getByRole('button',{name:'保存笔记',exact:true}).click();await page.locator('.excerpt-editor-error').waitFor({state:'visible'});
 assert.equal(store.list().length,0);assert.equal(await page.locator('#excerpt-understanding').inputValue(),'保留缩进才能读清代码。');await page.unroute('**/api/web/excerpt-notes');
 await page.getByRole('button',{name:'保存笔记',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll("[data-excerpt-id]").length===1);
 assert.equal(store.list()[0]!.understanding,'保留缩进才能读清代码。');assert.equal(store.list()[0]!.quote,"  const a_b = 2;\n  a_b * 3");assert.match(store.list()[0]!.html,/<pre><code>/);
 await select("self","重复",true);await page.getByRole("button",{name:"记笔记",exact:true}).click();await page.locator('#excerpt-understanding').fill('同一句话，要定位我选的第二处。');await page.getByRole('button',{name:'保存笔记',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll("[data-excerpt-id]").length===2);
 const second=store.list().find(n=>n.source.messageId==="self")!;assert.equal(second.start,10);
 await select("helper","先看这里。");await page.getByRole("button",{name:"记笔记",exact:true}).click();await page.getByRole('button',{name:'保存笔记',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll("[data-excerpt-id]").length===3);
 assert.equal(await page.locator('.notes-recent-row').count(),3);
 await page.locator('.notes-recent-row summary').first().click();assert.equal(await page.locator('.notes-recent-row[open] .notes-recent-body').isVisible(),true);assert.equal(await page.locator('#notes-tab-cards').getAttribute('aria-selected'),'true');
 await page.getByRole('tab',{name:'聊天摘录',exact:true}).click();assert.equal(await page.locator('#notes-content').isVisible(),false);
 const item=page.locator(`[data-excerpt-id="${second.id}"]`);
 await item.getByRole("button",{name:"查看原文"}).click();await page.locator('.note-source-preview mark').waitFor();
 assert.equal(await page.locator('.note-source-preview mark').innerText(),"重复");assert.equal(await page.locator('.note-source-preview [data-source-message="previous"]').innerText().then(text=>text.includes('上下文')),true);
 assert.equal(await page.locator('.note-source-preview mark').evaluate(mark=>{const range=document.createRange();range.selectNodeContents(mark.closest(".message-content")!);range.setEndBefore(mark);return range.toString().length;}),10);
 await page.getByRole('button',{name:'返回笔记',exact:true}).click();assert.equal(await page.locator('.note-source-preview').count(),0);assert.equal(await page.locator('#messages').evaluate(node=>(node as HTMLElement).inert),false);
 await page.reload();await page.waitForFunction(()=>document.querySelectorAll("[data-excerpt-id]").length===3);assert.equal(store.get(second.id).understanding,"同一句话，要定位我选的第二处。");
 mkdirSync(resolve("../data/qa/excerpt-notes-v2"),{recursive:true});await page.screenshot({path:resolve("../data/qa/excerpt-notes-v2/desktop.png"),fullPage:true});assert.deepEqual(errors,[]);console.log("PASS: write-before-save, persistent highlight, redraw, failure/retry, atomic understanding, recent three, tabs, learning-area source/context/highlight/return, reload");
}finally{await browser.close();await server.close();}
