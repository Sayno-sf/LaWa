import assert from "node:assert/strict";
import {mkdirSync,writeFileSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {createServer} from "vite";
import {chromium} from "playwright-core";

// 真实字体/布局回归；只运行固定组件、随机端口，不读取个人课堂或请求模型。
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../.."),agent=join(root,"pi-agent");
const output=resolve(process.env.EXPLAINER_LAYOUT_REPORT_DIR??join(root,"data/qa/explainer-layout"));
const modulePath="/@fs/"+join(agent,"web/src/explainerView.ts").replaceAll("\\","/");
const cssPath="/@fs/"+join(agent,"web/src/explainerView.css").replaceAll("\\","/");
const tokensPath="/@fs/"+join(agent,"web/src/designTokens.css").replaceAll("\\","/");
const html=`<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:20px}.message-content{width:640px;max-width:100%}</style></head><body><div class="message-content" id="fixture"></div><script type="module">
import ${JSON.stringify(tokensPath)};import ${JSON.stringify(cssPath)};
import {ExplainerPlayer,explainerMarkup} from ${JSON.stringify(modulePath)};
window.load=(width,narrow)=>{const script={title:"文字完整保留",canvas:{w:640,h:296},start:"start",stage:[{id:"note",k:"note",x:32,y:236,w:width,t:"这段说明验证文字增长后仍然完整保留，并且可以继续阅读。".repeat(8)}],nodes:{start:{label:"说明",ops:[["show","note"]],end:true}}};
const c={id:"layout"+Math.random(),entryId:"entry",sourceSessionId:"s",goalId:"g",taskId:"t",skillId:"k",artifact:{id:"layout",version:"1",contentSha256:"a".repeat(64),skillVersion:"2",templateVersion:"explainer-v2",validatorVersion:"explainer-validator-v2",script,stats:{},warnings:[]}};
const el=document.querySelector('#fixture');el.style.width=narrow?'480px':'640px';el.innerHTML=explainerMarkup(c);window.player=new ExplainerPlayer(el,()=>{},()=>{},()=>{});window.player.mount([c],{sessionId:'s',goalId:'g',taskId:'t',skillId:'k',current:true,blocked:false});el.querySelector('[data-explainer-action=next]').click();};
</script></body></html>`;
const server=await createServer({configFile:false,root:join(agent,"web"),server:{host:"127.0.0.1",port:0,fs:{allow:[root]}},plugins:[{name:"layout-fixture",configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=="/__layout")return next();res.setHeader("Content-Type","text/html; charset=utf-8");res.end(html);});}}]});
await server.listen();const base=server.resolvedUrls.local[0];
const browser=await chromium.launch({executablePath:process.env.RESPONSIVE_BROWSER_PATH??"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",headless:true});
const errors=[],results=[];
try{
  mkdirSync(output,{recursive:true});const page=await browser.newPage({viewport:{width:1188,height:761}});page.on("pageerror",error=>errors.push(error.message));
  await page.route("**/*",route=>route.request().url().startsWith(base)?route.continue():route.abort());
  await page.goto(base+"__layout");await page.waitForFunction(()=>typeof window.load==="function");
  for(const [name,width,narrow]of [["expanded",120,false],["bounded-scroll",64,true]]){
    await page.evaluate(([width,narrow])=>window.load(width,narrow),[width,narrow]);await page.waitForTimeout(80);
    const result=await page.evaluate(()=>{const fit=document.querySelector('.explainer-fit'),stage=document.querySelector('.explainer-stage'),note=document.querySelector('[data-explainer-element=note]'),copy=note.querySelector('.explainer-copy');
      const rect=fit.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(copy);const text=range.getBoundingClientRect();
      const before={fitHeight:rect.height,fitWidth:rect.width,scrollHeight:fit.scrollHeight,clientHeight:fit.clientHeight,expanded:fit.dataset.expanded,scrollable:fit.dataset.scrollable,copyFont:getComputedStyle(copy).fontSize,stageHeight:parseFloat(stage.style.height),scale:rect.width/640,textBottom:text.bottom,fitBottom:rect.bottom};
      fit.scrollTop=fit.scrollHeight;return {...before,lastTextVisible:range.getBoundingClientRect().bottom<=fit.getBoundingClientRect().bottom+.75};});
    assert.equal(result.expanded,"true","long note must expand beyond original canvas");assert.ok(result.fitHeight<=960*result.scale+1,"visible stage height must stay bounded");
    if(name==="expanded"){assert.equal(result.scrollable,"false");assert.ok(result.textBottom<=result.fitBottom+.75,"text must remain inside expanded stage");}
    else{assert.equal(result.scrollable,"true");assert.ok(result.scrollHeight>result.clientHeight);assert.ok(result.lastTextVisible,"last line must be reachable by scrolling");assert.ok(result.scrollHeight<=result.stageHeight*result.scale+2,"scale must not create an unscaled blank scroll tail");
      await page.waitForTimeout(100);const stable=await page.evaluate(()=>{const fit=document.querySelector('.explainer-fit'),note=document.querySelector('[data-explainer-element=note]');return {scrollTop:fit.scrollTop,lastLineVisible:note.getBoundingClientRect().bottom<=fit.getBoundingClientRect().bottom+1};});assert.ok(stable.scrollTop>0);assert.ok(stable.lastLineVisible);result.stable=stable;}
    results.push({name,...result});await page.screenshot({path:join(output,name+".png"),fullPage:true});
  }
  assert.deepEqual(errors,[]);writeFileSync(join(output,"report.json"),JSON.stringify({results,errors},null,2));console.log(JSON.stringify({results,errors}));
}finally{await browser.close();await server.close();}
