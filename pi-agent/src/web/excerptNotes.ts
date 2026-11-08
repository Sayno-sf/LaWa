import {createHash, randomUUID} from "node:crypto";
import {existsSync, readFileSync, writeFileSync, renameSync, mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {JSDOM} from "jsdom";
import {renderMarkdown} from "../../web/src/markdown.js";

export interface NoteSource {sessionId:string; messageId:string; channel:"teacher"|"assistant"}
export interface ResolvedNoteSource {source:NoteSource; content:string; role:string; goalId:string|null; skillId:string|null}
export interface ExcerptNote extends ResolvedNoteSource {id:string; start:number; end:number; quote:string; html:string; contentHash:string; createdAt:string; updatedAt:string; understanding:string}
export class ExcerptError extends Error {constructor(message:string,readonly statusCode=400){super(message);}}

/** 同一Markdown渲染器提供服务端与浏览器相同的文本坐标，代码空格与换行不归一化。 */
export function excerptFragment(content:string,start:number,end:number,quote:string):string {
  const dom=new JSDOM(`<body>${renderMarkdown(content)}</body>`);
  try {
    const body=dom.window.document.body;
    const text=body.textContent??"";
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>text.length||end-start>20000||text.slice(start,end)!==quote||!quote.trim())
      throw new ExcerptError("选段已变化，请重新选择原文。",409);
    const walker=dom.window.document.createTreeWalker(body,4);let offset=0,node:Node|null;const range=dom.window.document.createRange();let begun=false;
    while((node=walker.nextNode())){const length=node.textContent?.length??0;if(!begun&&start<offset+length){range.setStart(node,start-offset);begun=true;}if(begun&&end<=offset+length){range.setEnd(node,end-offset);break;}offset+=length;}
    const container=dom.window.document.createElement("div");container.append(range.cloneContents());
    const parent=range.startContainer.parentElement;
    if(parent?.closest("pre")&&range.endContainer.parentElement?.closest("pre")===parent.closest("pre"))return `<pre><code>${escapeText(quote)}</code></pre>`;
    if(parent?.closest("code")&&range.endContainer.parentElement?.closest("code")===parent.closest("code"))return `<code>${escapeText(quote)}</code>`;
    return container.innerHTML;
  }finally{dom.window.close();}
}
function escapeText(text:string){return text.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");}
export class ExcerptNotes {
  private notes:ExcerptNote[]=[];
  constructor(private readonly file?:string){
    if(file&&existsSync(file)){
      const data=JSON.parse(readFileSync(file,"utf8"));
      if(data.version!==1||!Array.isArray(data.notes)||data.notes.length>10000)throw new Error("笔记文件不可读，已停止写入。");
      this.notes=data.notes.map((note:ExcerptNote)=>{
        if(!note||typeof note.id!=="string"||typeof note.content!=="string"||typeof note.understanding!=="string"||!note.source||typeof note.source.sessionId!=="string"||typeof note.source.messageId!=="string"||!["teacher","assistant"].includes(note.source.channel)||!Number.isFinite(Date.parse(note.createdAt)))throw new Error("笔记文件不可读，已停止写入。");
        // 持久化HTML不是执行权限；读取时从已保存原文和选段重新生成安全片段。
        return {...note,html:excerptFragment(note.content,note.start,note.end,note.quote)};
      });
    }
  }
  list(){return structuredClone(this.notes);}
  get(id:string){const note=this.notes.find(n=>n.id===id);if(!note)throw new ExcerptError("笔记不存在。",404);return structuredClone(note);}
  private commit(notes:ExcerptNote[]){if(this.file){mkdirSync(dirname(this.file),{recursive:true});const temp=this.file+".tmp";writeFileSync(temp,JSON.stringify({version:1,notes}),"utf8");renameSync(temp,this.file);}this.notes=notes;}
  save(source:ResolvedNoteSource,input:Record<string,unknown>){
    if(source.content.length>200000)throw new ExcerptError("这条消息过长，暂不支持摘录。",413);
    const {start,end,quote}=input;if(typeof start!=="number"||typeof end!=="number"||typeof quote!=="string")throw new ExcerptError("缺少选段。");
    const understanding=input.understanding??"";
    if(typeof understanding!=="string"||understanding.length>20000)throw new ExcerptError("理解内容需在20000字以内。");
    const html=excerptFragment(source.content,start,end,quote),contentHash=createHash("sha256").update(source.content).digest("hex");
    const existing=this.notes.find(n=>n.source.sessionId===source.source.sessionId&&n.source.messageId===source.source.messageId&&n.source.channel===source.source.channel&&n.start===start&&n.end===end&&n.contentHash===contentHash);
    if(existing){if(understanding!==existing.understanding&&understanding!=="")return this.update(existing.id,understanding);return structuredClone(existing);}
    if(this.notes.length>=10000)throw new ExcerptError("笔记库已达容量，请先整理已有笔记。",409);
    const now=new Date().toISOString();const note:ExcerptNote={...source,id:randomUUID(),start,end,quote,html,contentHash,createdAt:now,updatedAt:now,understanding};this.commit([...this.notes,note]);return structuredClone(note);
  }
  bind(id:string,goalId:string,skillId:string){const note={...this.get(id),goalId,skillId};this.commit(this.notes.map(n=>n.id===id?note:n));return note;}
  update(id:string,understanding:unknown){if(typeof understanding!=="string"||understanding.length>20000)throw new ExcerptError("理解内容需在20000字以内。");const note={...this.get(id),understanding,updatedAt:new Date().toISOString()};this.commit(this.notes.map(n=>n.id===id?note:n));return note;}
}
