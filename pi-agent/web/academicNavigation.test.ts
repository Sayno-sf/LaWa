import {test} from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {CardSourceNavigation, resolveCardSource} from "./src/cardSource.js";
import {captureReadingPosition, restoreReadingPosition} from "./src/readingPosition.js";

test("a historical note resolves only its exact goal/skill/card, independently of the active task", () => {
  const projects = [
    {goal_profile:{id:"a",goal_description:"History"},skills:[{id:"sa",name:"Same name"}],knowledge_cards:[{id:"ca",skill_id:"sa"}]},
    {goal_profile:{id:"b",goal_description:"Current"},skills:[{id:"sb",name:"Same name"}],knowledge_cards:[]},
  ];
  const ref = {goalId:"a",skillId:"sa",cardId:"ca"};
  assert.equal(resolveCardSource(projects,ref)?.card.id,"ca");
  assert.equal(resolveCardSource(projects,{...ref,goalId:"b"}),null);
  assert.equal(resolveCardSource(projects,{...ref,skillId:"sb"}),null);
  assert.equal(resolveCardSource(projects,{...ref,cardId:"deleted"}),null);
  assert.deepEqual(projects[1]!.knowledge_cards,[]);
});

test("late source loads cannot overwrite a newer source or resurrect an explicitly closed view", () => {
  const view = new CardSourceNavigation();
  const old = view.begin({goalId:"a",skillId:"sa",cardId:"ca"});
  const latest = view.begin({goalId:"b",skillId:"sb",cardId:"cb"});
  assert.equal(view.finish(old,true),false);
  assert.equal(view.reference?.cardId,"cb");
  assert.equal(view.finish(latest,false,"Unavailable"),true);
  assert.equal(view.phase,"unavailable");
  view.clear();
  assert.equal(view.finish(latest,true),false);
  assert.equal(view.reference,null);
});

test("reading anchor survives replacement and reflow; only readers already at the end follow new content", () => {
  const dom = new JSDOM('<div id="scroll"><article data-reading-key="first"></article><article data-reading-key="second"></article></div>');
  const container = dom.window.document.querySelector<HTMLElement>("#scroll")!;
  let shift = 0;
  Object.defineProperties(container,{clientHeight:{value:400},scrollHeight:{get:()=>1200+shift}});
  container.scrollTop = 500;
  container.getBoundingClientRect = () => ({top:100,bottom:500} as DOMRect);
  const measure = () => [...container.children].forEach((node,index) => {
    (node as HTMLElement).getBoundingClientRect = () => ({top:100+index*600+shift-container.scrollTop,bottom:100+(index+1)*600+shift-container.scrollTop} as DOMRect);
  });
  measure();
  const history = captureReadingPosition(container);
  assert.equal(history.following,false);
  assert.equal(history.key,"first");
  container.innerHTML = '<article data-reading-key="first"></article><article data-reading-key="second"></article>';
  shift = 180; measure();
  restoreReadingPosition(container,history,true);
  assert.equal(container.scrollTop,680);
  container.scrollTop=container.scrollHeight-container.clientHeight;
  const end = captureReadingPosition(container);
  shift += 200;
  restoreReadingPosition(container,end,true);
  assert.equal(container.scrollTop,container.scrollHeight);
  dom.window.close();
});
