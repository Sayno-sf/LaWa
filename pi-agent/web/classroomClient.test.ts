import test from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {ClassroomClient} from "./src/classroomClient.js";

test("classroom snapshots stay monotonic and an in-flight old read cannot overwrite explicit navigation",async()=>{
  const dom=new JSDOM("<!doctype html><p>classroom</p>",{url:"http://localhost"});
  const sources:Array<{onmessage?:(event:{data:string})=>void}>=[];
  class Source{static OPEN=1;readyState=1;onmessage?:(event:{data:string})=>void;constructor(){sources.push(this);}close(){}}
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,EventSource:Source});
  let finish!:(response:Response)=>void,calls=0;
  const received:string[]=[];
  globalThis.fetch=async()=>++calls===1?new Promise(resolve=>{finish=resolve;}):Response.json({session:{id:"latest"},run:null,version:"3",sequence:3});
  const client=new ClassroomClient(value=>received.push((value.session as {id:string}).id),()=>{});
  client.start();
  const publish=(sequence:number,id:string)=>sources[0]!.onmessage!({data:JSON.stringify({type:"snapshot",snapshot:{session:{id},run:null,version:String(sequence),sequence}})});
  try{
    publish(2,"newer");publish(1,"older");
    assert.deepEqual(received,["newer"],"an older SSE snapshot must not move the classroom backwards");
    const pending=client.refresh();
    const resume=client.pauseSnapshots();
    publish(3,"during-navigation");
    finish(Response.json({session:{id:"old-read"},run:null,version:"4",sequence:4}));await pending;
    assert.deepEqual(received,["newer"],"previous GETs and snapshots during navigation cannot replace its target");
    resume();
    for(let i=0;i<100&&received.length<2;i++)await new Promise(resolve=>setTimeout(resolve,2));
    assert.deepEqual(received,["newer","latest"]);
  }finally{dom.window.dispatchEvent(new dom.window.Event("pagehide"));dom.window.close();}
});
