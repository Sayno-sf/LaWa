import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {LearningSkillPreferences} from "./learningSkillPreferences.js";
import {LearningSkillRuntime} from "./learningSkills.js";
test("preferences persist per account and reject remembered animation calls after disable",()=>{
 const root=mkdtempSync(join(tmpdir(),"lawa-switch-"));
 try {
  const a=new LearningSkillPreferences(join(root,"a/settings.json")),b=new LearningSkillPreferences(join(root,"b/settings.json"));
  assert.equal(a.enabled("explainer-animation"),true);
  const runtime=new LearningSkillRuntime({roots:[],surface:"WEB",role:"TEACHER",enabled:n=>a.enabled(n),adapters:{"explainer-animation":{requiredResourcesByTool:{present_explainer_animation:["SKILL.md"]}},"lawa-teaching-animation":{requiredResourcesByTool:{present_teaching_animation:["SKILL.md"]}}}});
  a.set("explainer-animation",false);
  assert.equal(new LearningSkillPreferences(a.path).enabled("explainer-animation"),false);
  assert.equal(a.enabled("lawa-teaching-animation"),true);assert.equal(b.enabled("explainer-animation"),true);
  a.set("lawa-teaching-animation",false);
  for(const tool of ["present_explainer_animation","present_teaching_animation"])assert.match(runtime.fork().guardTool(tool)!.reason,/已关闭/);
  a.set("explainer-animation",true);assert.doesNotMatch(runtime.guardTool("present_explainer_animation")!.reason,/已关闭/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
