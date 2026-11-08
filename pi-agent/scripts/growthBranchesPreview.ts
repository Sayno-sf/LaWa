/** 可交互的隔离桌面示例：真实路径切换，合成课堂资料，不连接教学模型。 */
import {join} from "node:path";
import {mkdirSync, writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {fauxAssistantMessage} from "@earendil-works/pi-ai";
import {ConversationCatalog} from "../src/web/conversationCatalog.js";
import {TeachingSessionContext} from "../src/teachingSession.js";
import {LEARNER_QUESTIONS_ENTRY} from "../src/learnerQuestions.js";
import {startGrowthPreview} from "./growthPreview.js";

const root=fileURLToPath(new URL("../../",import.meta.url));
const resumeDirectory=process.env.GROWTH_PREVIEW_DATA_DIR;
const preview=await startGrowthPreview(Number(process.env.GROWTH_PREVIEW_PORT ?? "8793"),true,resumeDirectory);
try {
  const catalog=new ConversationCatalog(join(preview.directory,"sessions"),root), manager=resumeDirectory ? catalog.resumeRecent() : catalog.create();
  const sid=manager.getSessionId();
  if (!resumeDirectory) {
    catalog.recordGoal(manager,"goal","TypeScript 基础",true);
    manager.appendMessage(fauxAssistantMessage("这是独立的示例课堂，使用合成记录，不调用教学模型。你可以展开「路线」，试着进入补足分支，再返回原题。"));
    manager.appendMessage(fauxAssistantMessage("同一个加号，遇到不同类型时会有不同结果。\n\n```ts\n2 + 3   // 5\n2 + '3' // '23'\n```\n\n先看参与运算的值，再判断这里是在做数字相加，还是字符串拼接。"));
    const context=new TeachingSessionContext();context.bindSession(sid);
    context.learnerQuestions.ask({id:"preview-original-question",purpose:"CHECK",session_id:sid,goal_id:"goal",skill_id:"a",task_id:"ta",
      questions:[{id:"original",prompt:"2 + '3' 得到什么？请解释原因。",selection:"freeform",options:[]}]});
    manager.appendCustomEntry(LEARNER_QUESTIONS_ENTRY,context.learnerQuestions.snapshot());
    const post=async(path:string,body:unknown)=>{
      const response=await fetch(preview.apiBase+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      if(!response.ok)throw new Error(await response.text());return response.json();
    };
    await post("/api/learning/branches/propose",{id:"preview-string-conversion",goal_id:"goal",anchor_kind:"skill",anchor_id:"a",purpose:"prerequisite",
      title:"字符串转换",reason:"理解拼接前，先分清数值和它的文本表示。",scope:"用两个例子理解数字参与字符串拼接时的转换。",
      return_condition:"能解释原题中数字何时变成字符串，再回到原题。",expected_plan_revision:0});
    const atlas=await fetch(preview.apiBase+"/api/learning/growth").then(r=>r.json()) as {recommendations:{id:string;kind:string}[]};
    const recommendation=atlas.recommendations.find(r=>r.kind==="deepen");
    if(recommendation)await post(`/api/user/growth/recommendations/${recommendation.id}/adopt`,{});
  }
  const info={preview:preview.base,kernel:preview.apiBase,data:preview.directory,session_id:sid,pid:process.pid,synthetic:true};
  mkdirSync(join(root,"data/qa/growth-profile-branches"),{recursive:true});
  writeFileSync(join(root,"data/qa/growth-profile-branches/preview.json"),JSON.stringify(info,null,2));
  console.log(JSON.stringify(info));
  const stop=()=>{void preview.stop().then(()=>process.exit());};process.once("SIGINT",stop);process.once("SIGTERM",stop);
} catch(error) {await preview.stop();throw error;}
