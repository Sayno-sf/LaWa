import {createHash} from "node:crypto";
import {lstatSync,readFileSync,readdirSync,realpathSync} from "node:fs";
import {basename,extname,isAbsolute,join,relative,resolve} from "node:path";
import {defineTool,loadSkills,type ToolDefinition} from "@earendil-works/pi-coding-agent";
import {Type} from "typebox";

export interface LearningSkillAdapter {
  description?:string;
  hostInstructions?:string;
  resources?:Record<string,()=>string>;
  requiredResourcesByTool?:Record<string,string[]|((args?:Record<string,unknown>)=>string[])>;
}
export interface LearningSkillRuntimeOptions {
  roots:readonly string[];
  additionalRoots?:()=>readonly string[];
  installed?:(name:string)=>boolean;
  enabled?:(name:string)=>boolean;
  surface:"WEB"|"CLI";
  role:"TEACHER"|"ASSISTANT";
  adapters?:Record<string,LearningSkillAdapter>;
}
interface Entry {name:string;description:string;directory:string;raw:string;version:string;explicitOnly:boolean;adapter:LearningSkillAdapter}
interface Catalog {entries:Map<string,Entry>;omitted:number}
export interface LearningSkillCatalogSummary {
  skills:Array<{name:string;description:string;explicitOnly:boolean}>;
  truncated:boolean;
}
interface ResourceReceipt {
  schema:"lawa.learning-skill/v1";skill:string;resource:string;version:string;sha256:string;body:string;
  host_instructions?:string;resources?:string[];
}
const SCHEMA="lawa.learning-skill/v1";
const MAX_SKILLS=128,MAX_RESOURCES=128,MAX_FILE_BYTES=128000,MAX_ENTRY_CHARS=24000,MAX_RESOURCE_CHARS=32000,MAX_RECEIPT_CHARS=128000;
const READ_TOOLS=new Set(["load_learning_skill","read_learning_skill_resource"]);
export const LEARNING_SKILL_TOOL_NAMES=Object.freeze(["list_learning_skills","load_learning_skill","read_learning_skill_resource"]);
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const validName=(value:unknown):value is string=>typeof value==="string"&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)&&value.length<=64;
const receiptKey=(skill:string,path:string)=>skill+"\0"+path;
const cleanDescription=(value:string)=>value.replace(/[\u0000-\u001f]/g," ").trim().slice(0,600);
function resourcePath(value:unknown):string {
  if(typeof value!=="string"||!value||value.length>220||value.includes("\\")||value.includes(":")||value.includes("\0")||isAbsolute(value))throw new Error("技能资源必须使用包内相对路径。");
  const parts=value.split("/");
  if(parts.some(p=>!p||p==="."||p===".."||p.trim()!==p||p.startsWith("."))||parts.some(p=>["source-v1","node_modules"].includes(p.toLowerCase())))throw new Error("该技能资源路径不在允许范围内。");
  if(![".md",".txt",".json",".yaml",".yml",".csv",".tsv",".xml",".html",".css",".py",".js",".mjs",".ts",".sh",".ps1",".sql"].includes(extname(value).toLowerCase()))throw new Error("仅支持技能说明与文本参考资源。");
  return parts.join("/");
}
function isInside(root:string,file:string):boolean {const rel=relative(root,file);return !!rel&&!isAbsolute(rel)&&rel!==".."&&!rel.startsWith("..\\")&&!rel.startsWith("../");}
function safeFile(directory:string,path:string):string {
  const normalized=resourcePath(path);let current=directory;
  if(lstatSync(directory).isSymbolicLink())throw new Error("技能目录不能使用符号链接。");
  for(const part of normalized.split("/")){current=join(current,part);if(lstatSync(current).isSymbolicLink())throw new Error("技能资源不能通过符号链接读取。");}
  const real=realpathSync(current);
  if(!isInside(realpathSync(directory),real))throw new Error("技能资源越出已批准目录。");
  const stat=lstatSync(real);if(!stat.isFile()||stat.size>MAX_FILE_BYTES)throw new Error("技能资源不是有界文本文件。");
  return real;
}
function safeText(directory:string,path:string,maximum:number):string {
  const text=readFileSync(safeFile(directory,path),"utf8");if(text.length>maximum||text.includes("\0")||text.includes("\ufffd"))throw new Error("技能资源过大或不是有效UTF-8文本。");
  return text.replace(/^\ufeff/,"");
}
function linkedResources(raw:string):Set<string> {
  const result=new Set<string>();
  for(const match of raw.matchAll(/\[[^\]]*\]\(([^\s)]+)\)|`([^`\r\n]+)`/g)){
    const candidate=(match[1]??match[2]??"").replace(/^<|>$/g,"").split("#")[0]!;
    try{const path=resourcePath(candidate);if(path!=="SKILL.md")result.add(path);}catch{/* 普通代码/网址不是可读资源声明。 */}
    if(result.size>=MAX_RESOURCES)break;
  }
  return result;
}

/**
 * 应用技能只公开短目录，正文通过显式只读工具进入模型历史。
 * 批准目录和宿主工具权限来自代码；技能文件没有扩权、注册代码或执行脚本的能力。
 */
export class LearningSkillRuntime {
  private readonly options:LearningSkillRuntimeOptions;
  private readonly bindings=new Map<string,{skill:string;paths:string[]|((args?:Record<string,unknown>)=>string[])}>;
  private readonly visible=new Map<string,{version:string;sha256:string}>();
  constructor(options:LearningSkillRuntimeOptions){
    if(options.roots.length>4)throw new Error("应用技能目录数量超过上限。");
    const adapters:Record<string,LearningSkillAdapter>=Object.create(null);
    for(const [name,a]of Object.entries(options.adapters??{})){
      if(!validName(name))throw new Error("技能宿主适配名称无效。");
      if((a.hostInstructions?.length??0)>6000)throw new Error("技能宿主约定过长。");
      const resources={...a.resources};for(const path of Object.keys(resources))resourcePath(path);
      const required:NonNullable<LearningSkillAdapter["requiredResourcesByTool"]>=Object.create(null);
      for(const [tool,paths]of Object.entries(a.requiredResourcesByTool??{})){
        if(!tool||LEARNING_SKILL_TOOL_NAMES.includes(tool)||this.bindings.has(tool)||typeof paths!=="function"&&paths.length>8)throw new Error("技能工具前置资源绑定无效或重复。");
        const normalized=typeof paths==="function"?paths:[...new Set(paths.map(resourcePath))];
        if(typeof normalized!=="function"&&!normalized.includes("SKILL.md"))normalized.unshift("SKILL.md");
        required[tool]=normalized;this.bindings.set(tool,{skill:name,paths:normalized});
      }
      adapters[name]={...a,resources,requiredResourcesByTool:required};
    }
    this.options={...options,roots:options.roots.map(p=>resolve(p)),adapters};
  }
  /** 不共享“模型已经读过”的状态；恢复历史时也要用该次实际模型输入重新证明。 */
  fork():LearningSkillRuntime {return new LearningSkillRuntime(this.options);}

  private catalog():Catalog {
    const candidates:Array<{directory:string;file:string;raw:string}>=[];let omitted=0;
    // 用户安装的版本优先；根目录来自实例安装索引，不来自模型参数或 SKILL.md。
    for(const configured of [...this.options.additionalRoots?.()??[],...this.options.roots]){
      let root:string;try{if(lstatSync(configured).isSymbolicLink())continue;root=realpathSync(configured);if(!lstatSync(root).isDirectory())continue;}catch{continue;}
      let children;try{children=readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name));}catch{continue;}
      // 只看批准根的直接子目录，source-v1等历史归档不会成为另一个插件。
      for(const child of children){
        if(!child.isDirectory()||child.isSymbolicLink()||!validName(child.name))continue;
        if(this.options.installed&&!this.options.installed(child.name))continue;
        if(candidates.some(c=>basename(c.directory)===child.name))continue;
        if(candidates.length>=MAX_SKILLS){omitted++;continue;}
        const directory=join(root,child.name);
        try{const raw=safeText(directory,"SKILL.md",MAX_ENTRY_CHARS);candidates.push({directory,file:join(directory,"SKILL.md"),raw});}catch{omitted++;}
      }
    }
    if(!candidates.length)return {entries:new Map(),omitted};
    // 使用SDK现有frontmatter规则，但明确includeDefaults:false，绝不扫描宿主~/.pi或当前项目隐藏配置。
    const parsed=loadSkills({cwd:process.cwd(),agentDir:this.options.roots[0]??process.cwd(),skillPaths:candidates.map(c=>c.file),includeDefaults:false});
    const entries=new Map<string,Entry>();
    for(const skill of parsed.skills){
      const candidate=candidates.find(c=>resolve(c.file)===resolve(skill.filePath));
      if(!candidate||!validName(skill.name)||skill.name!==basename(candidate.directory)||entries.has(skill.name)){omitted++;continue;}
      const adapter=this.options.adapters?.[skill.name]??{},description=cleanDescription(adapter.description??skill.description);
      if(!description){omitted++;continue;}
      const version=hash(JSON.stringify({entry:hash(candidate.raw),host:adapter.hostInstructions??"",description,
        required:Object.fromEntries(Object.entries(adapter.requiredResourcesByTool??{}).map(([key,value])=>[key,typeof value==="function"?value.toString():value])),surface:this.options.surface,role:this.options.role}));
      entries.set(skill.name,{name:skill.name,description,directory:candidate.directory,raw:candidate.raw,version,explicitOnly:skill.disableModelInvocation,adapter});
    }
    return {entries,omitted};
  }
  private entry(name:unknown,catalog=this.catalog()):Entry {
    if(!validName(name))throw new Error("请选择目录中的技能名称。");
    if(this.options.enabled&&!this.options.enabled(name))throw new Error("该技能已关闭，请使用其他方式讲解。");
    const entry=catalog.entries.get(name);if(!entry)throw new Error("该技能未安装、不可读或未获应用批准。");return entry;
  }
  private resourceNames(entry:Entry):string[] {
    const names=new Set<string>();
    let scanned=0;
    const visit=(folder:string,depth=0)=>{
      if(depth>8||scanned>=512||names.size>=MAX_RESOURCES)return;
      try{const dir=join(entry.directory,folder);if(lstatSync(dir).isSymbolicLink())return;
        for(const child of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
          if(++scanned>512||names.size>=MAX_RESOURCES)break;
          if(child.isSymbolicLink()||child.name.startsWith(".")||child.name==="node_modules")continue;
          const path=folder+"/"+child.name;
          if(child.isDirectory()){visit(path,depth+1);continue;}
          if(child.isFile())try{safeFile(entry.directory,path);names.add(resourcePath(path));}catch{/* 非文本或过大资源不公开。 */}
        }
      }catch{/* 缺少可选资源目录不阻止加载入口。 */}
    };
    for(const folder of ["references","examples","assets","scripts"])visit(folder);
    for(const path of linkedResources(entry.raw)){
      if(names.size>=MAX_RESOURCES)break;
      // 列目录只验证路径与文件类型；引用正文直到显式read工具调用才读取。
      try{safeFile(entry.directory,path);names.add(path);}catch{/* 无效链接不授予读取权限。 */}
    }
    for(const path of Object.keys(entry.adapter.resources??{})){if(names.size>=MAX_RESOURCES&&!names.has(path))throw new Error("技能资源目录超过上限。");names.add(path);}
    return [...names].sort();
  }
  private receipt(entry:Entry,path:string):ResourceReceipt {
    const normalized=resourcePath(path);
    if(normalized!=="SKILL.md"&&!this.resourceNames(entry).includes(normalized))throw new Error("只可读取这个技能公开的参考资源。");
    const override=entry.adapter.resources?.[normalized];
    const body=normalized==="SKILL.md"?entry.raw:override?override():safeText(entry.directory,normalized,MAX_RESOURCE_CHARS);
    if(typeof body!=="string"||body.length>(normalized==="SKILL.md"?MAX_ENTRY_CHARS:MAX_RESOURCE_CHARS)||body.includes("\0")||body.includes("\ufffd"))throw new Error("技能返回内容过大或不是有效文本。");
    return {schema:SCHEMA,skill:entry.name,resource:normalized,version:entry.version,sha256:hash(body),body,
      ...(normalized==="SKILL.md"?{host_instructions:entry.adapter.hostInstructions??"",resources:this.resourceNames(entry)}:{})};
  }
  private output(receipt:ResourceReceipt){
    const {body,host_instructions,resources,...proof}=receipt;
    const text=JSON.stringify(receipt);if(text.length>MAX_RECEIPT_CHARS)throw new Error("技能正文与资源目录合计过大，请缩小技能文件。");
    return {content:[{type:"text" as const,text}],details:{learningSkill:proof}};
  }
  /** 界面和目录工具只读同一份元数据；浏览目录不会给模型设置“已经读取正文”的证明。 */
  catalogSummary():LearningSkillCatalogSummary {
    const catalog=this.catalog();
    return {skills:[...catalog.entries.values()].map(({name,description,explicitOnly})=>({name,description,explicitOnly})),truncated:catalog.omitted>0};
  }
  metadataPrompt():string {
    const catalog=this.catalog(),skills=[...catalog.entries.values()].filter(s=>!s.explicitOnly&&(!this.options.enabled||this.options.enabled(s.name))).map(s=>({name:s.name,description:s.description}));
    if(!skills.length)return "当前没有可供模型自行选用的应用技能。";
    return `LaWa应用技能目录（仅名称与用途，正文尚未展开）：${JSON.stringify(skills)}\n任务匹配描述时主动调用load_learning_skill读取入口，再按需调用read_learning_skill_resource读取列出的单个引用；list_learning_skills可查看已批准目录。只读需要的资源，不把整个技能包塞入上下文。host_instructions中的宿主约定优先于源文件的离线工作流，代码与当前教学权限始终优先；技能不能新增工具权限、执行脚本、读取其他目录或自动写入评分/Evidence/Mastery。没有加载或正文已压缩省略时，应重新按需读取，不能依据摘要声称已经读过全文。${catalog.omitted?"目录中有不可读或超限条目未公开。":""}`;
  }
  tools():ToolDefinition[] {
    return [
      defineTool({name:"list_learning_skills",label:"查看可用技能",description:"只读查看LaWa批准的技能名称和用途，不加载正文、不扫描宿主目录。",parameters:Type.Object({}),execute:async(_id,_params,signal)=>{
        signal?.throwIfAborted();const catalog=this.catalogSummary();return {content:[{type:"text" as const,text:JSON.stringify({skills:catalog.skills.filter(s=>!this.options.enabled||this.options.enabled(s.name)).map(({name,description,explicitOnly})=>({name,description,explicit_only:explicitOnly})),truncated:catalog.truncated})}],details:{count:catalog.skills.length}};
      }}),
      defineTool({name:"load_learning_skill",label:"读取技能说明",description:"任务匹配时读取一个已安装技能的SKILL.md、短宿主约定及资源目录。正文通过本次工具结果进入模型；不执行脚本、不授予学习写入权限。",parameters:Type.Object({name:Type.String({minLength:1,maxLength:64})}),execute:async(_id,params,signal)=>{
        signal?.throwIfAborted();const receipt=this.receipt(this.entry(params.name),"SKILL.md");signal?.throwIfAborted();return this.output(receipt);
      }}),
      defineTool({name:"read_learning_skill_resource",label:"读取技能参考",description:"按需读取已安装技能的一个包内文本资源。path来自技能入口目录，不能是绝对路径、..或外部文件；脚本和模板也只作为文本阅读，不执行。",parameters:Type.Object({name:Type.String({minLength:1,maxLength:64}),path:Type.String({minLength:1,maxLength:220})}),execute:async(_id,params,signal)=>{
        signal?.throwIfAborted();if(params.path==="SKILL.md")throw new Error("技能入口请使用load_learning_skill。");const receipt=this.receipt(this.entry(params.name),params.path);signal?.throwIfAborted();return this.output(receipt);
      }}),
    ];
  }
  /** 仅投影模型输入副本。移除、关闭或替换后，旧工具正文不能继续充当当前技能指令。 */
  projectMessages<T>(messages:readonly T[]):T[] {
    const catalog=this.catalog();
    return messages.map(value=>{
      if(!object(value)||value.role!=="toolResult"||typeof value.toolName!=="string")return value;
      if(value.toolName==="list_learning_skills")return {...value,content:[{type:"text",text:JSON.stringify(this.catalogSummary().skills.filter(s=>!this.options.enabled||this.options.enabled(s.name)))}]} as T;
      if(!READ_TOOLS.has(value.toolName)||value.isError||!Array.isArray(value.content))return value;
      const valid=value.content.every(part=>{
        if(!object(part)||part.type!=="text"||typeof part.text!=="string")return false;
        try{const data:unknown=JSON.parse(part.text);if(!object(data)||typeof data.skill!=="string"||typeof data.resource!=="string")return false;
          const expected=this.receipt(this.entry(data.skill,catalog),data.resource);
          return data.version===expected.version&&data.sha256===expected.sha256&&data.body===expected.body&&data.host_instructions===expected.host_instructions;
        }catch{return false;}
      });
      return valid?value:{...value,isError:true,content:[{type:"text",text:"这份历史技能说明已关闭、移除或更新。以当前可用技能目录为准，需要时重新读取。学习者原话和学习记录保持不变。"}]} as T;
    });
  }
  /**
   * 只看即将发给模型的实际消息，不看Pi原始分支，也不让execute提前设“已读”。
   * 因此同一个工具组里先load再调用业务工具仍会被拒；摘要/压缩丢失正文后也需重新展开。
   */
  observeModelContext(messages:readonly unknown[]):void {
    this.visible.clear();const catalog=this.catalog(),current=new Map<string,ResourceReceipt>();
    for(const value of messages){
      if(!object(value)||value.role!=="toolResult"||value.isError!==false||typeof value.toolName!=="string"||!READ_TOOLS.has(value.toolName)||!Array.isArray(value.content))continue;
      for(const part of value.content){
        if(!object(part)||part.type!=="text"||typeof part.text!=="string"||part.text.length>MAX_RECEIPT_CHARS)continue;
        let data:unknown;try{data=JSON.parse(part.text);}catch{continue;}
        if(!object(data)||data.schema!==SCHEMA||typeof data.skill!=="string"||typeof data.resource!=="string"||typeof data.body!=="string")continue;
        if(value.toolName==="load_learning_skill"&&data.resource!=="SKILL.md"||value.toolName==="read_learning_skill_resource"&&data.resource==="SKILL.md")continue;
        const key=receiptKey(data.skill,data.resource);
        try{
          let expected=current.get(key);if(!expected){expected=this.receipt(this.entry(data.skill,catalog),data.resource);current.set(key,expected);}
          if(data.version!==expected.version||data.sha256!==expected.sha256||data.body!==expected.body||data.host_instructions!==expected.host_instructions)continue;
          this.visible.set(key,{version:expected.version,sha256:expected.sha256});
        }catch{/* 失效/越界/不完整或已更换版本的正文不构成已读证明。 */}
      }
    }
  }
  hasToolAdapter(name:string):boolean {return this.bindings.has(name);}

  /** 模型只看到已开启技能的工具；执行时再检查一次，以覆盖中途关闭的情况。 */
  toolEnabled(name:string):boolean {
    const binding=this.bindings.get(name);
    return !binding || ((!this.options.enabled || this.options.enabled(binding.skill))&&this.catalog().entries.has(binding.skill));
  }
  guardTool(name:string,args?:Record<string,unknown>):{block:true;reason:string}|undefined {
    const binding=this.bindings.get(name);if(!binding)return;
    if(this.options.enabled&&!this.options.enabled(binding.skill))return {block:true,reason:"该技能已关闭，请使用其他方式讲解。"};
    if(!this.toolEnabled(name))return {block:true,reason:"该技能已移除或不可读取，请使用其他方式讲解。"};
    let paths:string[];
    try{const requested=typeof binding.paths==="function"?binding.paths(args):binding.paths;if(!Array.isArray(requested)||requested.length>8)throw new Error("invalid requirements");paths=[...new Set(requested.map(resourcePath))];if(!paths.includes("SKILL.md"))paths.unshift("SKILL.md");}
    catch{return {block:true,reason:"技能工具前置资源配置无效，请检查已安装技能。"};}
    const missing:string[]=[];
    for(const path of paths){
      try{const expected=this.receipt(this.entry(binding.skill),path),seen=this.visible.get(receiptKey(binding.skill,path));if(!seen||seen.version!==expected.version||seen.sha256!==expected.sha256)missing.push(path);}catch{missing.push(path);}
    }
    if(missing.length)return {block:true,reason:`先按需展开技能${binding.skill}并在下一次模型请求中阅读完整返回，再使用${name}。尚未读取、已省略或版本变化的资源：${missing.join("、")}。`};
  }
}
