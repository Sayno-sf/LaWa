import test from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {TeachingProposalView} from "./src/teachingProposalView.js";

test("closure card reads current Kernel route facts, ignores stale teacher completion claims, and acknowledges the user's end decision", async () => {
  const dom = new JSDOM("<main></main>");
  const previous = {document:globalThis.document, fetch:globalThis.fetch, CSS:globalThis.CSS};
  let status = "PENDING", covered = 3, changed = 0, activeTask = false;
  const body = () => ({current_goal_id:"goal", proposals:[{id:"closure",revision:status === "PENDING" ? 1 : 2,kind:"CLOSURE",
    text:"全部六阶段掌握，所有评分已齐全",reason:"综合题提到后续概念",scope:"GOAL",subject:"",status,goal_id:"goal"}],
    closure_progress:{goal_id:"goal", snapshot_signature:`${status}:${covered}:${activeTask}`,milestone_count:6, covered_milestone_count:covered,
      route_learning_complete:covered === 6, formal_assessment_coverage_complete:false,verification_status:"NOT_INFERRED",user_confirmed_count:0,expanded_skill_count:6,
      latest_end_choice_status:status,active_task_present:activeTask,unscored_skill_ids:["s2"],unassigned_skills:[],milestones:Array.from({length:6},(_,i)=>({id:`m${i+1}`,name:`阶段${i+1}`,
        expanded:true,covered:i<covered,tasks_completed:i<covered,skills:[{id:`s${i+1}`,name:`节点${i+1}`,task_completed:i<covered,response_recorded:i<covered,
          assessment_count:i===1?0:1,evidence_count:i<covered?1:0,assistance_levels:i===0?["WITH_HELP"]:["INDEPENDENT"],
          latest_assessment:i===1?null:{id:`a${i+1}`,score:10},mastered_by_user:false}]}))}});
  Object.assign(globalThis,{document:dom.window.document,CSS:{escape:(value:string)=>value},fetch:async(_url:unknown,init?:RequestInit)=>{
    if(init?.method === "POST") {status="CONFIRMED";return Response.json({status,closure_progress:body().closure_progress});}
    return Response.json(body());
  }});
  try {
    const view = new TeachingProposalView(()=>changed++);
    dom.window.document.querySelector("main")!.append(view.node);
    await view.refresh("session",true);
    assert.doesNotMatch(view.node.textContent!,/全部六阶段掌握|所有评分已齐全|综合题提到/);
    assert.match(view.node.textContent!,/学习记录覆盖[：:]?\s*3\s*\/\s*6/);
    assert.match(view.node.textContent!,/节点2.*正式评分缺失/s);
    assert.match(view.node.textContent!,/阶段6.*未覆盖/s);
    assert.match(view.node.textContent!,/用户确认掌握[：:]?\s*0/);
    covered=6;await view.refresh("session",true);
    assert.match(view.node.textContent!,/学习记录覆盖[：:]?\s*6\s*\/\s*6/);
    assert.match(view.node.textContent!,/节点6.*10\s*\/\s*10/s);
    assert.match(view.node.textContent!,/节点2.*正式评分缺失/s);
    view.node.querySelector<HTMLButtonElement>('[data-decision="CONFIRM"]')!.click();
    for(let i=0;i<20 && !changed;i++)await new Promise(done=>setTimeout(done,5));
    assert.equal(changed,1);
    assert.match(view.node.querySelector("[data-closure-receipt]")!.textContent!,/此前结束选择已保存.*继续复习/s);
    assert.equal(view.node.querySelector('[data-decision="CONFIRM"]'),null,"acknowledgement is not another confirmation");
    activeTask=true;await view.refresh("session",true);
    assert.equal(view.node.querySelector("[data-closure-receipt]"),null,"active review is not replaced by an old end choice");
    activeTask=false;await view.refresh("session",true);
    assert.match(view.node.querySelector("[data-closure-receipt]")!.textContent!,/此前结束选择已保存/);
    assert.doesNotMatch(view.node.querySelector("[data-closure-receipt]")!.textContent!,/本次学习已结束/);
  } finally {Object.assign(globalThis,previous);dom.window.close();}
});
