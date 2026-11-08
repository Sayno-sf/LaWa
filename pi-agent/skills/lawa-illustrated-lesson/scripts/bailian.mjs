import {createHash} from "node:crypto";
import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
export const BOOK_IMAGE_MODEL="qwen-image-2.0";

export function bailianOrigin(raw) {
  try {
    const u=new URL(raw);
    const host=/^(?:dashscope(?:-intl)?\.aliyuncs\.com|[a-z0-9-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com)$/;
    return u.protocol==="https:" && !u.port && !u.username && !u.password && host.test(u.hostname)?u.origin:null;
  } catch {return null;}
}
function resultLocation(raw) {
  if (typeof raw!=="string") throw new Error("百炼未返回成图。");
  const u=new URL(raw);
  if (u.protocol!=="https:" || u.port || u.username || u.password ||
    !/^dashscope-[a-z0-9-]+\.oss-(?:accelerate|[a-z0-9-]+)\.aliyuncs\.com$/.test(u.hostname)) throw new Error("生图下载地址未获识别。");
  return u;
}
async function boundedBytes(response,limit) {
  if (!response.body || Number(response.headers.get("content-length")??0)>limit) throw new Error("生图响应大小超限。");
  const reader=response.body.getReader(),chunks=[];
  let size=0;
  try {
    for (;;) {
      const part=await reader.read();
      if (part.done) break;
      size+=part.value.length;
      if (size>limit) {await reader.cancel();throw new Error("生图响应大小超限。");}
      chunks.push(part.value);
    }
    return Buffer.concat(chunks,size);
  } finally {reader.releaseLock();}
}
export function pngSize(data) {
  if (data.length<45 || data.subarray(0,8).toString("hex")!=="89504e470d0a1a0a" ||
    data.subarray(12,16).toString()!=="IHDR" || data.subarray(-8,-4).toString()!=="IEND") throw new Error("生图服务没有交付完整 PNG。");
  const width=data.readUInt32BE(16),height=data.readUInt32BE(20);
  if (!width || !height || width*height>4194304) throw new Error("生图尺寸无效。");
  return [width,height];
}
export async function paintBookImage({baseUrl,apiKey,brief,signal=AbortSignal.timeout(120000),fetcher=fetch}) {
  const origin=bailianOrigin(baseUrl);
  if (!origin || !apiKey || typeof brief!=="string" || !brief.trim() || brief.length>1000) throw new Error("百炼配置或画面描述无效。");
  const response=await fetcher(origin+"/api/v1/services/aigc/multimodal-generation/generation",{
    method:"POST",redirect:"error",signal,headers:{"Content-Type":"application/json",Authorization:"Bearer "+apiKey},
    body:JSON.stringify({model:BOOK_IMAGE_MODEL,input:{messages:[{role:"user",content:[{text:
      "绘制一幅独立完整的横向书籍插画。自然、细腻，主体清晰，颜料边缘融入留白的纸张。画面内容："+brief}]}]},
      parameters:{size:"1280*768",n:1,prompt_extend:false,watermark:false,
        negative_prompt:"文字、字母、数字、尺子、标尺、刻度、坐标轴、图表、尺寸线、箭头、装饰边框、水印"}})});
  if (!response.ok) {
    const detail=await boundedBytes(response,16000);
    let code="";
    try {const raw=JSON.parse(detail.toString("utf8")).code;if(typeof raw==="string" && /^[a-zA-Z0-9_.-]{1,90}$/.test(raw))code=" ("+raw+")";} catch {}
    throw new Error("百炼生图返回 "+response.status+code+"。");
  }
  const result=JSON.parse((await boundedBytes(response,128000)).toString("utf8"));
  const url=resultLocation(result.output?.choices?.[0]?.message?.content?.find(v=>v?.image)?.image);
  // 临时 URL 只用于这一次下载；凭证只送到已选百炼业务域名。
  const download=await fetcher(url,{signal,redirect:"error"});
  if (!download.ok) throw new Error("百炼成图下载失败。");
  const bytes=await boundedBytes(download,10*1024*1024),[width,height]=pngSize(bytes);
  return {bytes,width,height};
}

// Standalone authoring is opt-in. Importing this module or reading a finished page is offline.
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [flag,file,directory]=process.argv.slice(2);
  if (flag!=="--generate" || !file || !directory) throw new Error("用法为 node scripts/bailian.mjs --generate brief.json art-dir");
  const brief=JSON.parse(readFileSync(file,"utf8").replace(/^\uFEFF/,""));
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(brief.key) || typeof brief.alt!=="string" || !brief.alt.trim() ||
    brief.alt.length>180 || typeof brief.caption!=="string" || !brief.caption.trim() || brief.caption.length>300 ||
    typeof brief.paint!=="string" || !brief.paint.trim() || brief.paint.length>1000) throw new Error("画稿需要 key、alt、caption 和 paint。");
  const id=createHash("sha256").update(JSON.stringify([BOOK_IMAGE_MODEL,brief.paint])).digest("hex");
  mkdirSync(directory,{recursive:true});
  const png=join(directory,id+".png");
  if (existsSync(png)) pngSize(readFileSync(png));
  else {
    const apiKey=process.env.DASHSCOPE_API_KEY;
    const baseUrl=process.env.DASHSCOPE_BASE_URL??"https://dashscope.aliyuncs.com";
    if (!apiKey || !bailianOrigin(baseUrl)) throw new Error("请在当前进程配置有效的百炼域名和 DASHSCOPE_API_KEY。");
    // 锁先于付费请求。失败保留锁，便于人工核对，读取和重跑不会静默再次扣费。
    writeFileSync(png+".request",new Date().toISOString(),{flag:"wx",mode:0o600});
    const {bytes}=await paintBookImage({baseUrl,apiKey,brief:brief.paint});
    writeFileSync(png+".tmp",bytes,{mode:0o600});renameSync(png+".tmp",png);
  }
  const ref={key:brief.key,alt:brief.alt,caption:brief.caption,source:"百炼生成插画",art:{id,model:BOOK_IMAGE_MODEL}};
  writeFileSync(join(directory,id+".figure.json"),JSON.stringify(ref,null,2));
  console.log(join(directory,id+".figure.json"));
}
