import {createHash,randomUUID} from "node:crypto";
import {existsSync,linkSync,mkdirSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import type {PublicProviderCatalog,PrivateProviderCredentials} from "./web/providerSettings.js";
import type {FigureScope,PaintedFigure} from "./lessonFigureTypes.js";

import {BOOK_IMAGE_MODEL,bailianOrigin,paintBookImage} from "../skills/lawa-illustrated-lesson/scripts/bailian.mjs";
export {BOOK_IMAGE_MODEL};
interface Credentials {
  getPublicSettings():Promise<PublicProviderCatalog>;
  getProfileCredentials(id:string):Promise<PrivateProviderCredentials>;
}
export interface PaintBrief {key:string;alt:string;caption:string;paint:string}
type Status="drawing"|"ready"|"failed"|"interrupted";
interface Job extends FigureScope {
  id:string;status:Status;figure:PaintedFigure;briefHash:string;
  requestedAt:string;finishedAt?:string;reason?:string;width?:number;height?:number;
}
const keyOf=(s:string)=>createHash("sha256").update(s).digest("hex");
const safeId=(id:unknown):id is string=>typeof id==="string" && /^[a-f0-9]{64}$/.test(id);
function fileWrite(path:string, value:string|Buffer,claim=false) {
  const temp=path+"."+randomUUID()+".tmp";
  try {
    writeFileSync(temp,value,{mode:0o600});
    if (claim) linkSync(temp,path);
    else renameSync(temp,path);
  }
  finally {rmSync(temp,{force:true});}
}
export function validateBrief(value:unknown):PaintBrief {
  if (!value || typeof value!=="object" || Object.keys(value).sort().join(",")!=="alt,caption,key,paint") throw new Error("生图请填写 key、alt、caption 和 paint。");
  const b=value as PaintBrief;
  for (const [s,max] of [[b.key,40],[b.alt,180],[b.caption,300],[b.paint,1000]] as const)
    if (typeof s!=="string" || !s.trim() || s.length>max || /[\u0000-\u0008\u000b-\u001f]/.test(s)) throw new Error("插画描述或图注无效。");
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(b.key)) throw new Error("插画 key 需要小写字母开头。");
  return {key:b.key,alt:b.alt.trim(),caption:b.caption.trim(),paint:b.paint.trim()};
}

/** Per-instance private artwork. A paid request starts once and is never replayed by GET, refresh or restart. */
export class LessonArtwork {
  private readonly active=new Map<string,AbortController>();
  constructor(private readonly directory:string,private readonly credentials?:Credentials,private readonly fetcher:typeof fetch=fetch) {}
  private load(id:string):Job|null {
    if (!safeId(id)) return null;
    const path=join(this.directory,id+".json");
    return existsSync(path)?JSON.parse(readFileSync(path,"utf8")) as Job:null;
  }
  private save(job:Job,claim=false) {fileWrite(join(this.directory,job.id+".json"),JSON.stringify(job),claim);}
  async request(scope:FigureScope,turnId:string,brief:PaintBrief):Promise<PaintedFigure> {
    const b=validateBrief(brief);
    if (!turnId || !this.credentials) throw new Error("这间课堂尚未配置百炼生图。");
    // 教师可在同一回合切换任务，计费去重始终绑定真实用户消息。
    const id=keyOf(JSON.stringify([scope.sessionId,turnId,"book-art/1"]));
    const briefHash=keyOf(JSON.stringify(b));
    const reuse=(old:Job)=>{
      if (old.briefHash!==briefHash || old.goalId!==scope.goalId || old.taskId!==scope.taskId || old.skillId!==scope.skillId) throw new Error("本轮已委托一张书页插画，请使用已返回的图址。");
      return old.figure;
    };
    const old=this.load(id);if (old) return reuse(old);
    const profiles=(await this.credentials.getPublicSettings()).profiles.filter(p=>p.hasApiKey && p.provider==="aliyun-bailian" && bailianOrigin(p.baseUrl));
    const selected=process.env.LAWA_ILLUSTRATION_PROFILE;
    const profile=selected?profiles.find(p=>p.id===selected):profiles.find(p=>new URL(p.baseUrl).hostname.endsWith(".maas.aliyuncs.com"))??profiles[0];
    if (!profile) throw new Error("在设置中保存一组带 Key 的百炼模型配置后即可绘制书页插画。");
    const secret=await this.credentials.getProfileCredentials(profile.id);
    const origin=bailianOrigin(secret.baseUrl);
    if (!origin || origin!==bailianOrigin(profile.baseUrl) || !secret.apiKey) throw new Error("百炼档案的域名或凭证无效。");
    // 取得凭证的等待期间可能发生相同调用。持久占位早于计费请求。
    const raced=this.load(id);if (raced) return reuse(raced);
    if (this.active.size>=3) throw new Error("已有插画正在绘制，请先继续讲解。");
    mkdirSync(this.directory,{recursive:true,mode:0o700});
    const figure:PaintedFigure={key:b.key,alt:b.alt,caption:b.caption,source:"百炼生成插画",art:{id,model:BOOK_IMAGE_MODEL}};
    const job:Job={id,...scope,status:"drawing",figure,briefHash,requestedAt:new Date().toISOString()};
    try {this.save(job,true);} catch(error) {
      if ((error as NodeJS.ErrnoException).code!=="EEXIST") throw error;
      const existing=this.load(id);
      if (!existing) throw error;
      return reuse(existing);
    }
    const controller=new AbortController();this.active.set(id,controller);
    void this.draw(job,b.paint,origin,secret.apiKey,controller).catch(()=>{/* 写盘失败时原占位可恢复为已中断。 */});
    return figure;
  }
  private async draw(job:Job,brief:string,origin:string,apiKey:string,controller:AbortController) {
    const timer=setTimeout(()=>controller.abort(),120000);timer.unref();
    try {
      const {bytes,width,height}=await paintBookImage({baseUrl:origin,apiKey,brief,signal:controller.signal,fetcher:this.fetcher});
      if (controller.signal.aborted) throw new Error("生图请求已结束。");
      fileWrite(join(this.directory,job.id+".png"),bytes);
      this.save({...job,status:"ready",width,height,finishedAt:new Date().toISOString()});
    } catch(error) {
      if (existsSync(join(this.directory,job.id+".json"))) {
        const message=error instanceof Error?error.message:"";
        const reason=/^(?:百炼|生图)/.test(message) && message.length<150?message:controller.signal.aborted?"插画绘制超时或中断。":"暂时无法完成插画。";
        this.save({...job,status:"failed",reason,finishedAt:new Date().toISOString()});
      }
    } finally {clearTimeout(timer);this.active.delete(job.id);}
  }
  status(sessionId:string,id:string) {
    const job=this.load(id);
    if (!job || job.sessionId!==sessionId) return null;
    const state=job.status==="drawing" && !this.active.has(id)?"interrupted":job.status;
    return {state,width:job.width,height:job.height,reason:state==="interrupted"?"绘制时服务已重启。":job.reason};
  }
  image(sessionId:string,id:string) {
    const path=join(this.directory,id+".png");
    return this.status(sessionId,id)?.state==="ready" && existsSync(path)?readFileSync(path):null;
  }
  purgeGoal(goalId:string) {
    if (!existsSync(this.directory)) return;
    for (const name of readdirSync(this.directory)) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
      const id=name.slice(0,-5);
      if (this.load(id)?.goalId!==goalId) continue;
      this.active.get(id)?.abort();
      rmSync(join(this.directory,name),{force:true});rmSync(join(this.directory,id+".png"),{force:true});
    }
  }
}
