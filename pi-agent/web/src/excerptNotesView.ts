import {renderMarkdown} from "./markdown";
import type {ExcerptNote, NoteSource, ResolvedNoteSource} from "../../src/web/excerptNotes";
import "./excerptNotes.css";
type SelectionDraft={source:NoteSource;start:number;end:number;quote:string;content:string};
const escape=(value:string)=>value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
function excerptText(node:HTMLElement|DocumentFragment):string {
  if (!node.querySelector("[data-note-ignore]")) return node.textContent??"";
  const copy=node.cloneNode(true) as HTMLElement|DocumentFragment;
  copy.querySelectorAll("[data-note-ignore]").forEach(part=>part.remove());
  return copy.textContent??"";
}
export function textRange(root:HTMLElement,start:number,end:number):Range|null{
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:n=>n.parentElement?.closest('[data-note-ignore]')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});let offset=0,node:Node|null;const range=document.createRange();let begun=false;
  while((node=walker.nextNode())){const length=node.textContent?.length??0;if(!begun&&start<offset+length){range.setStart(node,start-offset);begun=true;}if(begun&&end<=offset+length){range.setEnd(node,end-offset);return range;}offset+=length;}return null;
}
export class ExcerptNotesView{
  private draft:SelectionDraft|null=null;
  private button=document.createElement("button");
  private status=document.createElement("p");
  private section=document.createElement("section");
  private list=document.createElement("div");
  private notes:ExcerptNote[]=[];
  private saving=false;
  private restoring=false;
  private version=0;
  private statusTimer:number|undefined;
  private editor=document.createElement("form");
  private understanding=document.createElement("textarea");
  private editing=false;
  private understandingDrafts=new Map<string,string>();
  private draftKey="";
  private recent=document.createElement("section");
  private tabs=document.createElement("div");
  private selectedType:"cards"|"excerpts"="cards";
  private sourceVersion=0;
  private closeSource:(()=>void)|null=null;
  refreshLabels(){this.render();}
  constructor(private readonly session:()=>string|null,private readonly learn:()=>void,private readonly label:(goal:string|null,skill:string|null)=>string,private readonly onChange:()=>void=()=>{},private readonly returnNotes:()=>void=()=>{},private readonly beforeSource:()=>void=()=>{}){
    this.button.type="button";this.button.className="excerpt-save";this.button.textContent="记笔记";this.button.hidden=true;
    this.status.className="excerpt-status";this.status.setAttribute("role","status");this.status.hidden=true;
    this.editor.className="excerpt-editor";this.editor.hidden=true;
    this.editor.setAttribute("aria-label","记下自己的理解");
    this.editor.innerHTML='<label for="excerpt-understanding">我的理解</label><div class="excerpt-editor-actions"><button type="button" class="text-button" data-note-dismiss>稍后再写</button><button type="submit" class="primary-button">保存笔记</button></div><p class="excerpt-editor-error" role="alert" hidden></p>';
    this.understanding.id="excerpt-understanding";this.understanding.rows=4;this.understanding.maxLength=20000;
    this.understanding.placeholder="写下你的理解、疑问或提醒……";
    this.editor.querySelector("label")!.after(this.understanding);
    this.editor.onsubmit=event=>{event.preventDefault();void this.save();};
    this.editor.querySelector<HTMLButtonElement>("[data-note-dismiss]")!.onclick=()=>this.dismissEditor();
    document.body.append(this.button,this.status,this.editor);
    this.section.className="excerpt-notes";
    this.section.append(this.list);
    this.section.id="excerpt-notes-panel";this.section.setAttribute("role","tabpanel");this.section.setAttribute("aria-labelledby","notes-tab-excerpts");
    const cards=document.querySelector<HTMLElement>("#notes-content");
    this.recent.className="notes-recent";this.recent.setAttribute("aria-label","最近笔记");
    this.tabs.className="notes-type-tabs";this.tabs.setAttribute("role","tablist");this.tabs.setAttribute("aria-label","笔记类型");
    this.tabs.innerHTML='<button type="button" id="notes-tab-cards" role="tab" aria-controls="notes-content">卡片</button><button type="button" id="notes-tab-excerpts" role="tab" aria-controls="excerpt-notes-panel">聊天摘录</button>';
    cards?.before(this.recent,this.tabs,this.section);
    cards?.setAttribute("role","tabpanel");cards?.setAttribute("aria-labelledby","notes-tab-cards");
    this.tabs.querySelectorAll<HTMLButtonElement>("button").forEach((button,index)=>{button.onclick=()=>this.switchType(index===0?"cards":"excerpts");button.onkeydown=event=>{if(["ArrowLeft","ArrowRight","Home","End"].includes(event.key)){event.preventDefault();const first=event.key==="Home"||(event.key!=="End"&&this.selectedType==="excerpts");this.switchType(first?"cards":"excerpts");this.tabs.querySelectorAll<HTMLButtonElement>("button")[first?0:1]!.focus();}};});
    if(cards)new MutationObserver(()=>this.renderRecent()).observe(cards,{childList:true,subtree:true});
    document.querySelector('[data-collection-search="notes"]')?.addEventListener("input",()=>this.renderRecent());
    this.switchType("cards");
    this.button.onpointerdown=e=>e.preventDefault();this.button.onclick=()=>this.openEditor();
    document.addEventListener("selectionchange",()=>this.capture());
    document.addEventListener("keydown",e=>{if(e.key==="Escape"){if(this.editing)this.dismissEditor();else{this.draft=null;this.button.hidden=true;this.status.hidden=true;}}});
    document.addEventListener("pointerdown",e=>{if(e.target!==this.button&&!this.saving&&!this.editing){this.draft=null;this.button.hidden=true;}},true);
    document.addEventListener("scroll",()=>{this.button.hidden=true;},true);
    for(const id of ["messages","assistant-messages"]){const root=document.getElementById(id);if(root)new MutationObserver(()=>this.restore()).observe(root,{childList:true,subtree:true});}
    void this.refresh();
  }
  private tell(text:string){window.clearTimeout(this.statusTimer);this.status.textContent=text;this.status.hidden=false;this.statusTimer=window.setTimeout(()=>{this.status.hidden=true;},6000);}
  private sourceRoot():HTMLElement|null{if(!this.draft)return null;return [...document.querySelectorAll<HTMLElement>("[data-note-message]")].find(n=>n.dataset.noteMessage===this.draft!.source.messageId&&n.dataset.noteSession===this.draft!.source.sessionId&&n.dataset.noteChannel===this.draft!.source.channel)??null;}
  private capture(){
    if(this.restoring||this.saving||this.editing)return;const selection=getSelection();
    if(!selection||selection.isCollapsed||!selection.rangeCount){if(this.draft&&!this.sourceRoot())return;this.button.hidden=true;return;}
    const range=selection.getRangeAt(0);const element=range.startContainer.nodeType===1?range.startContainer as Element:range.startContainer.parentElement;
    const root=element?.closest<HTMLElement>("[data-note-message]");
    if(!root||!root.contains(range.endContainer)||root.closest('[data-streaming="true"]')||!root.dataset.noteMessage){this.draft=null;this.button.hidden=true;return;}
    if ([...root.querySelectorAll("[data-note-ignore]")].some(part=>range.intersectsNode(part))) {this.draft=null;this.button.hidden=true;return;}
    const prefix=document.createRange();prefix.selectNodeContents(root);prefix.setEnd(range.startContainer,range.startOffset);
    const start=excerptText(prefix.cloneContents()).length,quote=range.toString();if(!quote.trim()||quote.length>20000)return;
    const nextKey=JSON.stringify([root.dataset.noteSession,root.dataset.noteMessage,root.dataset.noteChannel,start,start+quote.length]);
    if(nextKey!==this.draftKey){if(this.draftKey)this.understandingDrafts.set(this.draftKey,this.understanding.value);this.draftKey=nextKey;this.understanding.value=this.understandingDrafts.get(nextKey)??"";}
    this.button.textContent="记笔记";
    this.draft={source:{sessionId:root.dataset.noteSession??this.session()??"",messageId:root.dataset.noteMessage!,channel:root.dataset.noteChannel as "teacher"|"assistant"},start,end:start+quote.length,quote,content:excerptText(root)};
    this.position(range);
  }
  private position(range:Range){const rect=range.getBoundingClientRect();if(!rect.width&&!rect.height)return;this.button.hidden=false;this.button.style.left=`${Math.max(8,Math.min(innerWidth-100,rect.right-76))}px`;this.button.style.top=`${Math.max(8,Math.min(innerHeight-48,rect.bottom+6))}px`;}
  private restore(){
    if(!this.draft||this.saving)return;const root=this.sourceRoot();if(!root||excerptText(root)!==this.draft.content){this.button.hidden=true;return;}
    const range=textRange(root,this.draft.start,this.draft.end);if(!range)return;if(this.editing){this.highlight(range);return;}this.restoring=true;getSelection()?.removeAllRanges();getSelection()?.addRange(range);this.position(range);queueMicrotask(()=>{this.restoring=false;});
  }
  private highlight(range:Range){
    const api=CSS as typeof CSS&{highlights?:Map<string,unknown>};
    const HighlightClass=(window as unknown as {Highlight?:new(...ranges:Range[])=>unknown}).Highlight;
    if(api.highlights&&HighlightClass)api.highlights.set("note-selection",new HighlightClass(range));
  }
  private openEditor(){
    if(!this.draft)return;
    this.editing=true;this.editor.hidden=false;this.button.hidden=true;
    const left=Math.max(12,Math.min(innerWidth-348,parseFloat(this.button.style.left)||12));
    const top=Math.max(12,Math.min(innerHeight-270,parseFloat(this.button.style.top)||12));
    this.editor.style.left=`${left}px`;this.editor.style.top=`${top}px`;
    const root=this.sourceRoot(),range=root?textRange(root,this.draft.start,this.draft.end):null;if(range)this.highlight(range);
    this.understanding.focus({preventScroll:true});
  }
  private dismissEditor(){
    if(this.saving)return;this.editing=false;this.editor.hidden=true;
    (CSS as typeof CSS&{highlights?:Map<string,unknown>}).highlights?.delete("note-selection");
    if(this.draft){this.button.textContent="继续记笔记";this.button.hidden=false;}
  }
  private switchType(type:"cards"|"excerpts"){
    this.selectedType=type;this.section.hidden=type!=="excerpts";
    const cards=document.querySelector<HTMLElement>("#notes-content");if(cards)cards.hidden=type!=="cards";
    this.tabs.querySelectorAll<HTMLButtonElement>("button").forEach((button,index)=>{const active=(index===0)===(type==="cards");button.setAttribute("aria-selected",String(active));button.tabIndex=active?0:-1;});
    this.onChange();
  }
  private renderRecent(){
    const query=(document.querySelector<HTMLInputElement>('[data-collection-search="notes"]')?.value??"").trim().normalize("NFKC").toLocaleLowerCase();
    const entries:Array<{id:string;type:"cards"|"excerpts";text:string;date:string;label:string}>=this.notes.map(note=>({id:note.id,type:"excerpts",text:note.understanding||note.quote,date:note.updatedAt,label:this.label(note.goalId,note.skillId)}));
    document.querySelectorAll<HTMLElement>("#notes-content .notes-item").forEach(item=>entries.push({id:item.dataset.readingKey!,type:"cards",text:item.querySelector(".notes-note-preview")?.textContent?.trim()??"",date:item.querySelector("time")?.dateTime??"",label:item.closest(".notes-group")?.querySelector("strong")?.textContent??"卡片笔记"}));
    const recent=entries.filter(note=>!query||`${note.text} ${note.label}`.normalize("NFKC").toLocaleLowerCase().includes(query)).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,3);
    const opened=new Set([...this.recent.querySelectorAll<HTMLDetailsElement>("details[open]")].map(node=>node.dataset.recentId));
    this.recent.innerHTML='<h3>最近笔记</h3>'+ (recent.map(note=>{
      const excerpt=note.type==="excerpts"?this.notes.find(item=>item.id===note.id):undefined;
      const card=note.type==="cards"?document.querySelector<HTMLElement>(`#notes-content [data-reading-key="${CSS.escape(note.id)}"] .notes-note-preview`):null;
      const content=excerpt?(excerpt.understanding?renderMarkdown(excerpt.understanding):excerpt.html):(card?.innerHTML??escape(note.text));
      return `<details class="notes-recent-row" data-recent-id="${escape(note.id)}" ${opened.has(note.id)?"open":""}><summary><span class="notes-recent-text">${escape(note.text.slice(0,130))}</span><span class="notes-recent-meta">${note.type==="cards"?"卡片":"聊天摘录"} · ${escape(note.label)} · ${new Date(note.date).toLocaleDateString()} · 展开阅读</span></summary><div class="reading-content notes-recent-body">${content}</div>${excerpt?`<button type="button" class="text-button" data-recent-source="${excerpt.id}">查看原文</button>`:""}</details>`;
    }).join("")||'<p class="muted">'+(query?'没有匹配的最近笔记。':'记下一个想法，它会出现在这里。')+'</p>');
    this.recent.querySelectorAll<HTMLButtonElement>("[data-recent-source]").forEach(button=>button.onclick=()=>void this.openSource(button.dataset.recentSource!));
  }

  private async request<T>(url:string,init?:RequestInit):Promise<T>{const response=await fetch(url,init);const data=await response.json();if(!response.ok)throw new Error(data.detail??"笔记操作失败，请重试。");return data;}
  private async save(){
    const draft=this.draft;if(!draft||this.saving)return;this.saving=true;const submit=this.editor.querySelector<HTMLButtonElement>('[type="submit"]')!;submit.disabled=true;submit.textContent="保存中…";this.understanding.readOnly=true;const errorNode=this.editor.querySelector<HTMLElement>(".excerpt-editor-error")!;errorNode.hidden=true;
    try{const note=await this.request<ExcerptNote>("/api/web/excerpt-notes",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...draft,understanding:this.understanding.value})});this.notes=[...this.notes.filter(n=>n.id!==note.id),note];this.version++;this.render();this.tell("笔记已保存。");this.draft=null;this.button.hidden=true;this.editing=false;this.editor.hidden=true;this.understandingDrafts.delete(this.draftKey);this.understanding.value="";(CSS as typeof CSS&{highlights?:Map<string,unknown>}).highlights?.delete("note-selection");}
    catch(error){errorNode.textContent=error instanceof Error?error.message:String(error);errorNode.hidden=false;}
    finally{this.saving=false;submit.disabled=false;submit.textContent="保存笔记";this.understanding.readOnly=false;this.button.textContent="记笔记";}
  }
  private async refresh(){const version=++this.version;try{const notes=await this.request<ExcerptNote[]>("/api/web/excerpt-notes/resolve-bindings",{method:"POST"});if(version===this.version){this.notes=notes;this.render();}}catch{this.list.innerHTML='<p>聊天摘录暂时无法加载。<button type="button" class="text-button">重试</button></p>';this.list.querySelector("button")!.onclick=()=>void this.refresh();}}
  private render(){
    const drafts=new Map([...this.list.querySelectorAll<HTMLTextAreaElement>("textarea[data-note-id]")].map(n=>[n.dataset.noteId!,n.value]));
    const opened=new Set([...this.list.querySelectorAll<HTMLDetailsElement>("details[open]")].map(n=>`${n.closest<HTMLElement>("[data-excerpt-id]")!.dataset.excerptId}:${n.className}`));
    const groups=new Map<string,ExcerptNote[]>();for(const note of [...this.notes].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))){const key=JSON.stringify([note.goalId,note.skillId]);groups.set(key,[...(groups.get(key)??[]),note]);}
    const ordered=[...groups.values()];
    if(document.querySelector<HTMLSelectElement>("#notes-sort")?.value==="name")ordered.sort((a,b)=>this.label(a[0]!.goalId,a[0]!.skillId).localeCompare(this.label(b[0]!.goalId,b[0]!.skillId),"zh-CN"));
    this.list.innerHTML=ordered.map(notes=>`<section class="notes-group"><h4>${escape(this.label(notes[0]!.goalId,notes[0]!.skillId))}</h4>${notes.map(note=>`<article class="notes-item" data-excerpt-id="${note.id}" data-search-text="${escape(`${note.quote} ${note.understanding} ${this.label(note.goalId,note.skillId)}`)}">${note.understanding ? `<div class="reading-content excerpt-understanding">${renderMarkdown(note.understanding)}</div><details class="excerpt-saved-quote"><summary>摘录原文</summary><div class="reading-content excerpt-quote">${note.html}</div></details>` : `<div class="reading-content excerpt-quote">${note.html}</div>`}<div class="notes-metadata"><span>${note.source.channel==="assistant"?(note.role==="user"?"我对助教说":"助教"):note.role==="user"?"我":"老师"}</span><time datetime="${note.createdAt}">${new Date(note.createdAt).toLocaleString()}</time></div><details class="excerpt-edit-understanding"><summary>${note.understanding?"编辑理解":"补充理解"}</summary><textarea data-note-id="${note.id}" rows="3" aria-label="补充我的理解">${escape(drafts.get(note.id)??note.understanding)}</textarea><button type="button" class="ghost-button" data-understanding="${note.id}">保存理解</button></details><button type="button" class="text-button" data-note-source="${note.id}">查看原文</button><div data-source-preview="${note.id}"></div></article>`).join("")}</section>`).join("")||'<p class="muted">选中聊天中的文字，点击浮出的「记笔记」，摘录会保存在这里。</p>';
    for(const button of this.list.querySelectorAll<HTMLButtonElement>("[data-understanding]"))button.onclick=async()=>{const id=button.dataset.understanding!;button.disabled=true;try{const value=this.list.querySelector<HTMLTextAreaElement>(`[data-note-id="${id}"]`)!.value;const note=await this.request<ExcerptNote>(`/api/web/excerpt-notes/${id}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({understanding:value})});this.notes=this.notes.map(n=>n.id===id?note:n);this.render();this.tell("理解已保存。");}catch(error){this.tell(String(error));}finally{button.disabled=false;}};
    for(const button of this.list.querySelectorAll<HTMLButtonElement>("[data-note-source]"))button.onclick=()=>void this.openSource(button.dataset.noteSource!);
    for(const detail of this.list.querySelectorAll<HTMLDetailsElement>("details"))detail.open=opened.has(`${detail.closest<HTMLElement>("[data-excerpt-id]")!.dataset.excerptId}:${detail.className}`);
    this.renderRecent();this.onChange();
  }
  private async openSource(id:string){
    const route=location.hash;const version=++this.sourceVersion,note=this.notes.find(n=>n.id===id)!;
    try{
      const source=await this.request<ResolvedNoteSource&{messages?:Array<{id:string;role:string;content:string}>}>(`/api/web/excerpt-notes/${id}/source`);
      if(version!==this.sourceVersion||location.hash!==route)return;
      this.closeSource?.();this.beforeSource();this.learn();
      const stage=document.querySelector<HTMLElement>(".learning-stage")??document.querySelector<HTMLElement>("#messages")!.parentElement!;
      const panel=document.createElement("section");panel.className="note-source-preview";
      panel.innerHTML=`<header class="note-source-toolbar"><div><strong>笔记来源 · ${note.source.channel==="assistant"?"助教":"老师对话"}</strong><p>${escape(this.label(note.goalId,note.skillId))}</p></div><button type="button" class="ghost-button">返回笔记</button></header><div class="note-source-messages" tabindex="-1"></div>`;
      const originalChildren=[...stage.children].map(node=>({node:node as HTMLElement,inert:(node as HTMLElement).inert}));
      originalChildren.forEach(({node})=>{node.inert=true;});stage.classList.add("note-source-open");document.body.classList.add("note-source-browsing");stage.append(panel);
      const body=panel.querySelector<HTMLElement>(".note-source-messages")!;
      const messages=source.messages??[{id:note.source.messageId,role:source.role,content:source.content}];
      body.innerHTML=messages.map(message=>`<article class="message ${escape(message.role)}" data-source-message="${escape(message.id)}"><div class="message-meta">${message.role==="user"?"你":note.source.channel==="assistant"?"助教":"老师"}</div><div class="reading-content message-content">${renderMarkdown(message.content)}</div></article>`).join("");
      this.closeSource=()=>{panel.remove();stage.classList.remove("note-source-open");document.body.classList.remove("note-source-browsing");originalChildren.forEach(({node,inert})=>{node.inert=inert;});this.closeSource=null;this.onChange();document.dispatchEvent(new Event("note-source-change"));};
      panel.querySelector("button")!.onclick=()=>{this.sourceVersion++;this.closeSource?.();this.returnNotes();};
      const target=body.querySelector<HTMLElement>(`[data-source-message="${CSS.escape(note.source.messageId)}"] .message-content`)!;
      if(source.content!==note.content){const notice=document.createElement("p");notice.textContent="原消息已变化，未自动标记选段。";panel.prepend(notice);}
      else{const range=textRange(target,note.start,note.end);if(range&&range.toString()===note.quote){
        const parts:Array<{node:Text;start:number;end:number}>=[];const walker=document.createTreeWalker(target,NodeFilter.SHOW_TEXT);let node:Node|null;
        while((node=walker.nextNode()))if(range.intersectsNode(node))parts.push({node:node as Text,start:node===range.startContainer?range.startOffset:0,end:node===range.endContainer?range.endOffset:(node as Text).length});
        for(const {node,start,end}of parts.reverse()){if(end<=start)continue;const part=node.splitText(start);part.splitText(end-start);const mark=document.createElement("mark");part.replaceWith(mark);mark.append(part);}
      }}
      requestAnimationFrame(()=>{(target.querySelector("mark")??target).scrollIntoView({block:"center"});body.focus({preventScroll:true});});this.onChange();document.dispatchEvent(new Event("note-source-change"));
    }catch(error){if(version===this.sourceVersion)this.tell(error instanceof Error?error.message:String(error));}
  }
}
