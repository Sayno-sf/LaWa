interface LearningSkillSummary {
  name:string;description:string;explicitOnly:boolean;enabled:boolean;
  displayName?:string;origin?:"bundled"|"imported";
}
interface Catalog {skills:LearningSkillSummary[];truncated:boolean;revision?:string;available?:Array<{name:string;displayName:string;description:string}>}
const names:Record<string,string>={"lawa-illustrated-lesson":"图解讲页","explainer-animation":"互动讲解动画","lawa-teaching-animation":"基础教学演示"};
const button=(text:string,className="learning-skill-action")=>{const node=document.createElement("button");node.type="button";node.className=className;node.textContent=text;return node;};

/** 管理方法包和用户开关。浏览/安装都不启动老师，草稿与课堂由原工作区持有。 */
export class LearningSkillsView {
  readonly node=document.createElement("section");
  private readonly list:HTMLUListElement;
  private readonly status:HTMLParagraphElement;
  private readonly retry:HTMLButtonElement;
  private readonly file:HTMLInputElement;
  private readonly builtins:HTMLDetailsElement;
  private readonly replacement:HTMLDivElement;
  private loading:Promise<void>|null=null;
  private busy=false;
  private revision:string|undefined;

  constructor(){
    this.node.className="learning-skills";this.node.setAttribute("aria-label","技能插件");
    this.node.innerHTML=`<div class="learning-skills-heading"><h3>技能插件</h3><button type="button" class="learning-skill-action" data-add>添加技能</button></div>
      <input type="file" accept=".md,.zip" aria-label="选择技能文件" hidden>
      <ul class="learning-skills-list"></ul>
      <details class="learning-skills-builtins" hidden><summary>内置技能</summary><ul class="learning-skills-list"></ul></details>
      <div class="learning-skills-feedback"><p class="learning-skills-status" role="status" aria-live="polite"></p><button type="button" class="ghost-button" hidden>重新读取</button></div>
      <div class="learning-skills-replacement" hidden></div>`;
    this.list=this.node.querySelector("ul")!;this.status=this.node.querySelector("[role=status]")!;
    this.retry=this.node.querySelector(".learning-skills-feedback button")!;this.file=this.node.querySelector("input")!;
    this.builtins=this.node.querySelector("details")!;this.replacement=this.node.querySelector(".learning-skills-replacement")!;
    this.retry.addEventListener("click",()=>void this.load());
    this.node.querySelector("[data-add]")!.addEventListener("click",()=>{this.file.value="";this.file.click();});
    this.file.addEventListener("change",()=>{const file=this.file.files?.[0];if(file)void this.install(file);});
  }
  load():Promise<void>{
    if(this.loading)return this.loading;
    if(this.busy)return Promise.resolve();
    this.node.setAttribute("aria-busy","true");this.feedback("正在读取技能插件…");this.retry.hidden=true;
    this.loading=this.read().finally(()=>{this.loading=null;this.node.setAttribute("aria-busy","false");});return this.loading;
  }
  private feedback(text:string,error=false){this.status.textContent=text;if(error)this.status.dataset.tone="error";else delete this.status.dataset.tone;}
  private async read(){
    try{const response=await fetch("/api/web/learning-skills");if(!response.ok)throw new Error();const value:unknown=await response.json();if(!isCatalog(value))throw new Error();this.render(value);}
    catch{this.feedback("技能插件暂时无法读取，请重新读取。",true);this.retry.hidden=false;}
  }
  private render(value:Catalog){
    this.revision=value.revision;
    this.list.replaceChildren(...value.skills.map(skill=>{
      const item=document.createElement("li");item.className="learning-skill";item.dataset.skillName=skill.name;
      const heading=document.createElement("div");heading.className="learning-skill-heading";
      const name=document.createElement("h4");name.textContent=skill.displayName??(Object.hasOwn(names,skill.name)?names[skill.name]!:skill.name);
      const actions=document.createElement("div");actions.className="learning-skill-actions";
      const toggle=button(skill.enabled?"已开启":"已关闭","learning-skill-availability");
      toggle.setAttribute("role","switch");toggle.setAttribute("aria-label",name.textContent+"开关");toggle.setAttribute("aria-checked",String(skill.enabled));
      toggle.addEventListener("click",()=>void this.mutate("/api/web/learning-skills",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:skill.name,enabled:!skill.enabled})}));
      const remove=button("移除");remove.setAttribute("aria-label","移除"+name.textContent);
      remove.addEventListener("click",()=>void this.mutate(`/api/web/learning-skills/${encodeURIComponent(skill.name)}`,{method:"DELETE",headers:this.revision?{"If-Match":this.revision}:{}},`已移除「${name.textContent}」。已有学习记录保留。`));
      const description=document.createElement("p");description.textContent=skill.description;
      actions.append(toggle,remove);heading.append(name,actions);item.append(heading,description);return item;
    }));
    this.builtins.hidden=!value.available?.length;
    this.builtins.querySelector("ul")!.replaceChildren(...(value.available??[]).map(skill=>{
      const li=document.createElement("li");li.className="learning-skill-heading";
      const name=document.createElement("span");name.textContent=skill.displayName;
      const add=button("添加");add.setAttribute("aria-label","添加"+skill.displayName);
      add.addEventListener("click",()=>void this.mutate("/api/web/learning-skills/restore",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:skill.name})}));
      li.append(name,add);return li;
    }));
    this.feedback(value.skills.length===0?"还没有已安装的技能插件。":value.truncated?"部分插件暂时无法读取，当前仅显示可用项。":"");this.retry.hidden=true;
  }
  private setBusy(value:boolean){this.busy=value;this.node.setAttribute("aria-busy",String(value));this.node.querySelectorAll<HTMLButtonElement>("button").forEach(b=>b.disabled=value);}
  private async mutate(path:string,init:RequestInit,notice?:string){
    if(this.busy)return;
    this.setBusy(true);await this.loading;this.setBusy(true);
    try{const response=await fetch(path,init);const value=await response.json();if(!response.ok)throw new Error(value.detail??"操作未保存，请重试。");if(!isCatalog(value))throw new Error("技能目录未能刷新，请重新读取。");this.render(value);if(notice)this.feedback(notice);}
    catch(error){this.feedback(error instanceof Error?error.message:"操作未保存，请重试。",true);this.retry.hidden=false;}
    finally{this.setBusy(false);}
  }
  private async install(file:File,revision?:string){
    if(this.busy)return;
    if(file.size>10*1024*1024){this.feedback("技能文件不能超过 10 MiB。",true);return;}
    this.replacement.hidden=true;this.replacement.replaceChildren();this.setBusy(true);await this.loading;this.setBusy(true);this.feedback("正在添加技能…");
    try{
      const response=await fetch("/api/web/learning-skills/install",{method:"POST",headers:{"Content-Type":"application/octet-stream","X-Skill-Filename":encodeURIComponent(file.name),...(revision?{"X-Skill-Revision":revision}:{})},body:file});
      const value=await response.json();
      if(response.status===409&&value.conflict&&typeof value.conflict.revision==="string"){
        this.feedback(value.detail);const replace=button("替换"),cancel=button("取消");
        replace.addEventListener("click",()=>void this.install(file,value.conflict.revision));cancel.addEventListener("click",()=>{this.replacement.hidden=true;this.replacement.replaceChildren();this.feedback("");});
        this.replacement.append(replace,cancel);this.replacement.hidden=false;return;
      }
      if(!response.ok)throw new Error(value.detail??"技能未能安装，请重试。");
      if(!isCatalog(value))throw new Error("技能目录未能刷新，请重新读取。");
      this.render(value);const installed=(value as Catalog&{installed?:{name:string;hasScripts?:boolean;changed?:boolean}}).installed;
      const name=value.skills.find(s=>s.name===installed?.name)?.displayName??installed?.name??"技能";
      this.feedback(`已添加「${name}」。${installed?.hasScripts?"包内脚本作为参考保留，不会自动执行。":""}`);this.file.value="";
    }catch(error){this.feedback(error instanceof Error?error.message:"技能未能安装，请重试。",true);}
    finally{this.setBusy(false);}
  }
}
function isCatalog(value:unknown):value is Catalog {
  if(!value||typeof value!=="object")return false;const v=value as Partial<Catalog>;
  return Array.isArray(v.skills)&&v.skills.length<=128&&typeof v.truncated==="boolean"&&v.skills.every(s=>!!s&&typeof s==="object"&&typeof s.name==="string"&&s.name.length>0&&s.name.length<=64&&typeof s.description==="string"&&s.description.length<=600&&typeof s.enabled==="boolean"&&typeof s.explicitOnly==="boolean")
    &&(v.available===undefined||Array.isArray(v.available)&&v.available.every(s=>!!s&&typeof s.name==="string"&&typeof s.displayName==="string"));
}
