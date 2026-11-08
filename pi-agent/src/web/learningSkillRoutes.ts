import type {IncomingMessage,ServerResponse} from "node:http";
import {LearningSkillLibrary,prepareSkill,SKILL_UPLOAD_BYTES,SkillLibraryError} from "../learningSkillLibrary.js";
import {LearningSkillPreferences} from "../learningSkillPreferences.js";
import {createBundledLearningSkills} from "../learningSkillBundles.js";

async function readBody(request:IncomingMessage,limit:number):Promise<Buffer>{
  const chunks:Buffer[]=[];let size=0;
  for await(const part of request.iterator({destroyOnReturn:false})){
    const chunk=Buffer.from(part);if((size+=chunk.length)>limit)throw new SkillLibraryError("技能文件不能超过 10 MiB。",413);chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(request:IncomingMessage):Promise<Record<string,unknown>>{
  try{const body:unknown=JSON.parse((await readBody(request,4000)).toString("utf8"));if(!body||typeof body!=="object"||Array.isArray(body))throw new Error();return body as Record<string,unknown>;}
  catch(error){if(error instanceof SkillLibraryError)throw error;throw new SkillLibraryError("技能操作内容无效。");}
}
const send=(response:ServerResponse,status:number,value:unknown)=>{response.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});response.end(JSON.stringify(value));};

/** 安装/启停仅由同源用户入口操作；不注册成教师工具，也不创建课堂或请求 Kernel。 */
export function learningSkillRoutes(library:LearningSkillLibrary,preferences:LearningSkillPreferences){
  const runtime=createBundledLearningSkills("WEB","TEACHER",library,preferences);
  const catalog=()=>{const result=runtime.catalogSummary();return {revision:library.revision(),skills:result.skills.map(s=>({...s,...library.describe(s.name),enabled:preferences.enabled(s.name)})),available:library.available(),truncated:result.truncated};};
  return async(request:IncomingMessage,response:ServerResponse,pathname:string):Promise<boolean>=>{
    const base="/api/web/learning-skills";if(pathname!==base&&!pathname.startsWith(base+"/"))return false;
    try{
      const method=request.method??"GET",origin=request.headers.origin;
      if(origin){let host:string;try{host=new URL(origin).host;}catch{throw new SkillLibraryError("请在当前学习网页中管理技能。",403);}if(host!==request.headers.host)throw new SkillLibraryError("请在当前学习网页中管理技能。",403);}
      if(request.headers["sec-fetch-site"]==="cross-site")throw new SkillLibraryError("请在当前学习网页中管理技能。",403);
      if(method==="GET"&&pathname===base){send(response,200,catalog());return true;}
      if(method==="POST"&&pathname===base+"/install"){
        if(!request.headers["content-type"]?.startsWith("application/octet-stream"))throw new SkillLibraryError("请通过添加技能入口选择文件。",415);
        let filename:string;try{filename=decodeURIComponent(String(request.headers["x-skill-filename"]??""));}catch{throw new SkillLibraryError("文件名无效。");}
        const prepared=await prepareSkill(filename,await readBody(request,SKILL_UPLOAD_BYTES));
        const revision=request.headers["x-skill-revision"];if(revision!==undefined&&typeof revision!=="string")throw new SkillLibraryError("安装版本无效。");
        const installed=library.install(prepared,revision);
        send(response,200,{...catalog(),installed});return true;
      }
      if(method==="PUT"&&pathname===base||method==="POST"&&pathname===base+"/restore"){
        if(!request.headers["content-type"]?.startsWith("application/json"))throw new SkillLibraryError("技能操作内容无效。",415);
        const body=await jsonBody(request);
        if(typeof body.name!=="string")throw new SkillLibraryError("技能名称无效。");
        if(method==="PUT"){
          if(!runtime.catalogSummary().skills.some(s=>s.name===body.name)||typeof body.enabled!=="boolean")throw new SkillLibraryError("技能设置无效。");
          preferences.set(body.name,body.enabled);
        }else library.restore(body.name);
        send(response,200,catalog());return true;
      }
      const match=pathname.match(/^\/api\/web\/learning-skills\/([a-z0-9-]+)$/);
      if(method==="DELETE"&&match){library.remove(match[1]!,typeof request.headers["if-match"]==="string"?request.headers["if-match"]:undefined);send(response,200,catalog());return true;}
      send(response,404,{detail:"没有这个技能操作。"});
    }catch(error){send(response,error instanceof SkillLibraryError?error.status:500,{detail:error instanceof SkillLibraryError?error.message:"技能操作未保存，请重试。",...(error instanceof SkillLibraryError&&error.conflict?{conflict:error.conflict}:{})});}
    return true;
  };
}
