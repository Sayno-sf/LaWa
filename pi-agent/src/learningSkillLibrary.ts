import {createHash,randomUUID} from "node:crypto";
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,writeFileSync} from "node:fs";
import {basename,dirname,isAbsolute,join,relative,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {crc32} from "node:zlib";
import {parseFrontmatter} from "@earendil-works/pi-coding-agent";
import {fromBufferPromise} from "yauzl";

export const SKILL_UPLOAD_BYTES=10*1024*1024;
const MAX_FILES=512,MAX_EXPANDED_BYTES=32*1024*1024,MAX_FILE_BYTES=8*1024*1024,MAX_SKILLS=64;
export const bundledSkillRoot=fileURLToPath(new URL("../skills/",import.meta.url));
export const validSkillName=(name:unknown):name is string=>typeof name==="string"&&name.length<=64&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
export const skillSessionDirectory=()=>process.env.WEB_SESSION_DIR?.trim()||fileURLToPath(new URL("../../data/web-sessions/",import.meta.url));
const digest=(value:Buffer|string)=>createHash("sha256").update(value).digest("hex");
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const inside=(root:string,path:string)=>{const rel=relative(root,path);return !!rel&&!isAbsolute(rel)&&rel!==".."&&!rel.startsWith("../")&&!rel.startsWith("..\\");};
const labels:Record<string,string>=Object.assign(Object.create(null),{"lawa-illustrated-lesson":"图解讲页"});
const descriptions:Record<string,string>=Object.assign(Object.create(null),{"lawa-illustrated-lesson":"在讲解中穿插书籍插画、可调示意和短动画，可暂停提问。"});
interface PackageRecord {id:string;digest:string;installedAt:string}
interface LibraryState {schema:1;revision:string;packages:Record<string,PackageRecord>;removed:string[]}
interface SkillMetadata {name:string;displayName:string;description:string;hasScripts:boolean}
export interface PreparedSkill extends SkillMetadata {files:Map<string,Buffer>;digest:string}
export interface LibraryItem {name:string;displayName:string;description:string;origin:"bundled"|"imported"}
export class SkillLibraryError extends Error {
  constructor(message:string,readonly status=400,readonly conflict?:{name:string;revision:string}){super(message);}
}

function packagePath(value:string):string {
  if(!value||value.length>220||value.includes("\\")||isAbsolute(value))throw new SkillLibraryError("技能包含无效文件路径。");
  const parts=value.replace(/\/$/,"").split("/");
  if(parts.some(p=>!p||p==="."||p===".."||/[\x00-\x1f<>:"|?*]/.test(p)||/[ .]$/.test(p)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)))throw new SkillLibraryError("技能包含不安全的文件路径。");
  return parts.join("/");
}
function textFile(data:Buffer):string {
  try{return new TextDecoder("utf-8",{fatal:true}).decode(data).replace(/^\uFEFF/,"");}
  catch{throw new SkillLibraryError("SKILL.md 必须使用 UTF-8 编码。");}
}
function metadata(data:Buffer):SkillMetadata {
  const raw=textFile(data);
  if(raw.length>24000||raw.includes("\0"))throw new SkillLibraryError("SKILL.md 最多 24,000 字符，请把详细资料移到 references 中。");
  let fm:Record<string,unknown>;
  try{fm=parseFrontmatter<Record<string,unknown>>(raw).frontmatter;}catch{throw new SkillLibraryError("SKILL.md 顶部的 YAML 格式有误。");}
  if(!validSkillName(fm.name))throw new SkillLibraryError("SKILL.md 需要 name，使用小写字母、数字及连字符，最多 64 字符。");
  if(typeof fm.description!=="string"||!fm.description.trim())throw new SkillLibraryError("SKILL.md 需要简短的 description，说明这个技能有什么用。");
  const extra=record(fm.metadata)?fm.metadata:{};
  const display=extra.display_name??fm.display_name??fm.title;
  const brief=extra.short_description??fm.description;
  return {name:fm.name,displayName:typeof display==="string"&&display.trim()?display.trim().slice(0,100):labels[fm.name]??fm.name,
    description:(descriptions[fm.name]??String(brief)).replace(/[\x00-\x1f]/g," ").trim().slice(0,180),hasScripts:false};
}

/** ZIP 只解包成受限数据。脚本、依赖清单和 allowed-tools 都不会被执行或注册成教师工具。 */
export async function prepareSkill(filename:string,bytes:Buffer):Promise<PreparedSkill> {
  if(!bytes.length||bytes.length>SKILL_UPLOAD_BYTES)throw new SkillLibraryError("技能文件不能为空，且不能超过 10 MiB。",413);
  let files=new Map<string,Buffer>();
  if(/\.md$/i.test(filename)){files.set("SKILL.md",bytes);}
  else if(/\.zip$/i.test(filename)) {
    try {
      const archive=await fromBufferPromise(bytes,{validateEntrySizes:true,strictFileNames:true});
      if(archive.entryCount>MAX_FILES)throw new SkillLibraryError("技能包最多包含 512 个文件和目录。");
      const seen=new Set<string>();let total=0;
      try{for await(const entry of archive.eachEntry()){
        const path=packagePath(entry.fileName),key=path.normalize("NFC").toLowerCase();
        if(seen.has(key))throw new SkillLibraryError("技能包中存在重名文件。");seen.add(key);
        const kind=(entry.externalFileAttributes>>>16)&0xf000;
        if(kind&&kind!==0x8000&&kind!==0x4000)throw new SkillLibraryError("技能包不能包含符号链接或设备文件。");
        if(entry.isEncrypted())throw new SkillLibraryError("请使用未加密的技能 ZIP。");
        if(entry.fileName.endsWith("/"))continue;
        if(entry.uncompressedSize>MAX_FILE_BYTES||(total+=entry.uncompressedSize)>MAX_EXPANDED_BYTES)throw new SkillLibraryError("技能包解压后最多 32 MiB，单个文件最多 8 MiB。",413);
        const stream=await archive.openReadStreamPromise(entry);const parts:Buffer[]=[];let size=0;
        for await(const part of stream){const chunk=Buffer.from(part);size+=chunk.length;if(size>entry.uncompressedSize||size>MAX_FILE_BYTES){stream.destroy();throw new SkillLibraryError("技能包的文件大小与声明不一致。");}parts.push(chunk);}
        const data=Buffer.concat(parts);
        if(size!==entry.uncompressedSize||crc32(data)!==entry.crc32)throw new SkillLibraryError("技能包文件不完整或校验失败。");
        // 常见系统打包附带信息不参与技能选择；隐藏配置和依赖缓存不装入。
        if(path.split("/").some(p=>p.startsWith(".")||p==="__MACOSX"||p==="node_modules"))continue;
        files.set(path,data);
      }}finally{archive.close();}
    }catch(error){if(error instanceof SkillLibraryError)throw error;throw new SkillLibraryError("无法读取这个 ZIP，请重新压缩完整的技能目录。");}
    const entries=[...files.keys()].filter(p=>basename(p)==="SKILL.md");
    // 允许 ZIP 外面套一层或多层目录，但不猜测多技能包中要安装哪一个。
    const roots=entries.filter(p=>!entries.some(other=>other!==p&&p.startsWith(other.slice(0,-8))));
    if(roots.length!==1)throw new SkillLibraryError("ZIP 中需要一个主 SKILL.md，请一次添加一个技能。");
    const prefix=roots[0]!.slice(0,-8);
    files=new Map([...files].filter(([p])=>p.startsWith(prefix)).map(([p,b])=>[p.slice(prefix.length),b]));
  }else throw new SkillLibraryError("请选择 SKILL.md 或技能 ZIP。");
  const entry=files.get("SKILL.md");if(!entry)throw new SkillLibraryError("没有找到 SKILL.md。");
  const meta=metadata(entry);
  const paths=[...files.keys()].sort();
  for(const path of paths){packagePath(path);let parent=dirname(path);while(parent!=="."){if(files.has(parent))throw new SkillLibraryError("技能包中同一路径同时是文件和目录。");parent=dirname(parent);}}
  const hash=createHash("sha256");for(const path of paths){hash.update(JSON.stringify(path));hash.update(digest(files.get(path)!));}
  return {...meta,files,digest:hash.digest("hex"),hasScripts:paths.some(p=>p.startsWith("scripts/"))};
}

/** 每个实例独立持有安装索引。先落完整不可变包，再原子切换索引，失败不会替换旧技能。 */
export class LearningSkillLibrary {
  readonly directory:string;
  readonly indexPath:string;
  constructor(directory=join(skillSessionDirectory(),"learning-skill-library"),readonly bundledRoot=bundledSkillRoot){this.directory=resolve(directory);this.indexPath=join(this.directory,"index.json");}
  private read():LibraryState {
    try {
      const value:unknown=JSON.parse(readFileSync(this.indexPath,"utf8"));
      if(!record(value)||value.schema!==1||typeof value.revision!=="string"||!record(value.packages)||!Array.isArray(value.removed)||!value.removed.every(validSkillName)||Object.keys(value.packages).length>MAX_SKILLS)throw new Error();
      for(const [name,pkg]of Object.entries(value.packages))if(!validSkillName(name)||!record(pkg)||typeof pkg.id!=="string"||!/^[0-9a-f-]{36}$/.test(pkg.id)||typeof pkg.digest!=="string"||!/^[0-9a-f]{64}$/.test(pkg.digest)||typeof pkg.installedAt!=="string")throw new Error();
      return {...value,packages:Object.assign(Object.create(null),value.packages)} as unknown as LibraryState;
    }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return {schema:1,revision:"initial",packages:Object.create(null),removed:[]};throw new SkillLibraryError("技能安装记录无法读取，请先恢复安装索引，不会覆盖已有技能。",500);}
  }
  private assertDirectory():void {
    mkdirSync(this.directory,{recursive:true});
    if(lstatSync(this.directory).isSymbolicLink())throw new SkillLibraryError("技能安装目录不能使用符号链接。",500);
    const packages=join(this.directory,"packages");mkdirSync(packages,{recursive:true});
    if(lstatSync(packages).isSymbolicLink())throw new SkillLibraryError("技能包目录不能使用符号链接。",500);
  }
  private save(state:LibraryState):void {
    this.assertDirectory();state.revision=randomUUID();
    const temp=join(this.directory,`index-${randomUUID()}.tmp`);
    try{writeFileSync(temp,JSON.stringify(state),{mode:0o600,flag:"wx"});renameSync(temp,this.indexPath);}finally{if(existsSync(temp))rmSync(temp);}
  }
  private removePackage(id:string):void {
    const root=join(this.directory,"packages"),path=resolve(root,id);
    if(!inside(root,path)||!existsSync(path))return;
    // 只清理本库生成的 UUID 包目录；不能跟随外部链接执行递归删除。
    if(lstatSync(root).isSymbolicLink()||lstatSync(path).isSymbolicLink()||!inside(realpathSync(root),realpathSync(path)))throw new SkillLibraryError("技能包路径异常，已停止清理。",500);
    rmSync(path,{recursive:true,force:true});
  }
  installed(name:string):boolean{return !this.read().removed.includes(name);}
  revision():string{return this.read().revision;}
  additionalRoots():string[]{const state=this.read();return Object.entries(state.packages).filter(([n])=>!state.removed.includes(n)).map(([,p])=>join(this.directory,"packages",p.id));}
  private bundledNames():string[]{try{return readdirSync(this.bundledRoot,{withFileTypes:true}).filter(p=>p.isDirectory()&&!p.isSymbolicLink()&&validSkillName(p.name)&&existsSync(join(this.bundledRoot,p.name,"SKILL.md"))).map(p=>p.name);}catch{return [];}}
  describe(name:string):LibraryItem {
    if(!validSkillName(name))throw new SkillLibraryError("技能名称无效。");
    const state=this.read(),pkg=state.packages[name];
    const directory=pkg?join(this.directory,"packages",pkg.id,name):join(this.bundledRoot,name);
    let meta:SkillMetadata;try{meta=metadata(readFileSync(join(directory,"SKILL.md")));}catch{meta={name,displayName:labels[name]??name,description:"技能说明暂不可读，请重新安装。",hasScripts:false};}
    return {name,displayName:meta.displayName,description:meta.description,origin:pkg?"imported":"bundled"};
  }
  available():LibraryItem[]{const removed=this.read().removed;return this.bundledNames().filter(n=>removed.includes(n)).map(n=>this.describe(n));}
  install(skill:PreparedSkill,expectedRevision?:string):{name:string;changed:boolean;hasScripts:boolean} {
    const state=this.read(),old=state.packages[skill.name];
    if(old?.digest===skill.digest&&!state.removed.includes(skill.name))return {name:skill.name,changed:false,hasScripts:skill.hasScripts};
    const exists=!!old||this.bundledNames().includes(skill.name)&&!state.removed.includes(skill.name);
    if(exists&&expectedRevision!==state.revision)throw new SkillLibraryError(`已安装「${this.describe(skill.name).displayName}」，可以替换为所选版本。`,409,{name:skill.name,revision:state.revision});
    if(expectedRevision&&expectedRevision!==state.revision)throw new SkillLibraryError("技能目录已经变化，请重新选择文件。",409);
    if(!old&&Object.keys(state.packages).length>=MAX_SKILLS)throw new SkillLibraryError("最多安装 64 个外部技能，请先移除不用的技能。");
    this.assertDirectory();const id=randomUUID(),parent=join(this.directory,"packages",id),directory=join(parent,skill.name);
    try{
      mkdirSync(directory,{recursive:true});
      for(const [path,bytes]of skill.files){const target=resolve(directory,packagePath(path));if(!inside(directory,target))throw new SkillLibraryError("技能资源路径无效。");mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes,{mode:0o600,flag:"wx"});}
      state.packages[skill.name]={id,digest:skill.digest,installedAt:new Date().toISOString()};state.removed=state.removed.filter(n=>n!==skill.name);this.save(state);
    }catch(error){this.removePackage(id);throw error;}
    if(old)try{this.removePackage(old.id);}catch{/* 已提交新索引；残留旧包不可发现，文件占用不回滚成功安装。 */}
    return {name:skill.name,changed:true,hasScripts:skill.hasScripts};
  }
  remove(name:string,expectedRevision?:string):void {
    if(!validSkillName(name))throw new SkillLibraryError("技能名称无效。");
    const state=this.read(),old=state.packages[name];
    if(!old&&state.removed.includes(name))return;
    if(expectedRevision&&expectedRevision!==state.revision)throw new SkillLibraryError("技能目录已经变化，请刷新后再移除。",409);
    if(!old&&!this.bundledNames().includes(name)&&!state.removed.includes(name))throw new SkillLibraryError("技能已不存在。",404);
    delete state.packages[name];if(!state.removed.includes(name))state.removed.push(name);this.save(state);
    if(old)try{this.removePackage(old.id);}catch{/* 索引撤下后不再可读，稍后可清理被外部占用的原包。 */}
  }
  restore(name:string):void {
    if(!validSkillName(name)||!this.bundledNames().includes(name))throw new SkillLibraryError("没有这个内置技能。",404);
    const state=this.read();state.removed=state.removed.filter(n=>n!==name);this.save(state);
  }
}
