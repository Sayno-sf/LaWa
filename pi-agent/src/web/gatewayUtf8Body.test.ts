import assert from "node:assert/strict";
import test from "node:test";
import {once} from "node:events";
import {request as httpRequest} from "node:http";
import {fauxAssistantMessage} from "@earendil-works/pi-ai";
import {createGateway} from "./gateway.js";
import {WebSessionStore} from "./sessionStore.js";

// 实际HTTP请求在汉字/emoji中间拆包；不能仅测试Buffer拼接helper而绕过Gateway入站链。
test("Gateway preserves learner UTF-8 bytes split inside Chinese and emoji code points",async()=>{
  const received:string[]=[];
  const store=new WebSessionStore({fetchOverview:async()=>({current_goal:null,goal_profile:null,curriculum_spine:[],skills:[],recent_evidence:[],
    current_frontier:null,current_focus:null,active_task:null,current_goal_skill_ids:[],learning_history:[]}),fetchLibrary:async()=>({projects:[]}),
    createAgent:async(_context,_planning,_emit,manager)=>({prompt:async(text)=>{
      received.push(text);manager.appendMessage({role:"user",content:text,timestamp:Date.now()});manager.appendMessage(fauxAssistantMessage("已收到原文。"));
    },abort:async()=>{},dispose:()=>{}})});
  const gateway=createGateway({store});gateway.listen(0,"127.0.0.1");await once(gateway,"listening");
  const address=gateway.address();assert.ok(address&&typeof address==="object");const base=`http://127.0.0.1:${address.port}`;
  const corruptions:Array<{repetition:number;split:string;actual:string}>=[];
  try{
    for(let repetition=0;repetition<2;repetition++){
      const session=await store.create("new");
      const text="没有送达的显示不计成绩；检测死锁环，保留中文与🧭原文。";
      const body=Buffer.from(JSON.stringify({message:text}));
      for(const [word,offset]of [["送",1],["死",2],["🧭",1],["🧭",3]]as const){
        const split=body.indexOf(Buffer.from(word))+offset;
        const response=await new Promise<{status:number;body:string}>((resolve,reject)=>{
          const req=httpRequest(`${base}/api/web/sessions/${session.sessionId}/messages`,{method:"POST",agent:false,headers:{"Content-Type":"application/json","Content-Length":body.length,"Connection":"close"}},res=>{
            const chunks:Buffer[]=[];res.on("data",chunk=>chunks.push(chunk));res.on("end",()=>resolve({status:res.statusCode!,body:Buffer.concat(chunks).toString("utf8")}));
          });
          req.once("error",reject);req.flushHeaders();req.write(body.subarray(0,split));
          setTimeout(()=>req.end(body.subarray(split)),20);
        });
        assert.equal(response.status,200);
        if(received.at(-1)!==text)corruptions.push({repetition,split:`${word}+${offset}`,actual:received.at(-1)!});
      }
    }
    assert.equal(received.length,8);
    assert.deepEqual(corruptions,[],"every admitted learner text must retain exact UTF-8 across both repeated split matrices");
  }finally{store.dispose();await new Promise<void>(resolve=>gateway.close(()=>resolve()));}
});
