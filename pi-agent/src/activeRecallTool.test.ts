import assert from "node:assert/strict";
import test from "node:test";

import { createActiveRecallTool } from "./activeRecallTool.js";
import { LEARNING_AGENT_TOOL_NAMES } from "./learningAgentTools.js";
import { TeachingSessionContext } from "./teachingSession.js";

const overview = (goalId = "goal-a", taskId = "task-a") => ({
  current_goal: "学习架构", goal_profile: { id: goalId }, curriculum_spine: [], current_frontier: null,
  current_focus: null, skills: [{ id: "skill-a" }], recent_evidence: [],
  active_task: { id: taskId, related_skill_ids: ["skill-a"], status: "ACTIVE" },
  learning_history: [], current_goal_skill_ids: ["skill-a"],
});

test("Agent registry exposes one checkpoint tool; tool output only shows the current question", async () => {
  assert.equal(LEARNING_AGENT_TOOL_NAMES.filter((name) => name === "active_recall_checkpoint").length, 1);
  const context = new TeachingSessionContext();
  context.bindSession("session-a");
  context.beginUserTurn("可以考我");
  const tool = createActiveRecallTool(context, { fetchImpl: async () => Response.json(overview()), log: () => undefined });
  const result = await tool.execute("start", {
    action: "START", active_skill_id: "skill-a", active_task_id: "task-a",
    primary_questions: ["核心？", "区别？", "因果？", "迁移？"],
  }, new AbortController().signal, undefined, {} as Parameters<typeof tool.execute>[4]);
  const output = JSON.parse(result.content[0]!.type === "text" ? result.content[0]!.text : "") as Record<string, unknown>;
  assert.equal(output.current_question, "核心？");
  assert.equal(output.primary_progress, "1 / 4");
  assert.doesNotMatch(JSON.stringify(output), /区别？|因果？|迁移？/);
  assert.equal(context.snapshot().candidate_evidence, null);
});

test("tool refuses another Goal or Task before recording an answer", async () => {
  let goalId = "goal-a";
  const context = new TeachingSessionContext();
  context.bindSession("session-a");
  context.beginUserTurn("开始");
  const tool = createActiveRecallTool(context, { fetchImpl: async () => Response.json(overview(goalId)), log: () => undefined });
  await tool.execute("start", { action: "START", active_skill_id: "skill-a", active_task_id: "task-a", primary_questions: ["一？", "二？", "三？"] }, new AbortController().signal, undefined, {} as Parameters<typeof tool.execute>[4]);
  goalId = "goal-b";
  context.beginUserTurn("回答一");
  await assert.rejects(() => tool.execute("answer", { action: "ANSWER", active_skill_id: "skill-a", active_task_id: "task-a", outcome: "CORRECT", observation: "回答", next: "PRIMARY" }, new AbortController().signal, undefined, {} as Parameters<typeof tool.execute>[4]), /失效/);
  assert.equal(context.activeRecall.snapshot(), null);
  assert.equal(context.snapshot().candidate_evidence, null);
});

test("a learner's skip message cannot restart the checkpoint in that turn", async () => {
  const context = new TeachingSessionContext();
  context.bindSession("session-a");
  context.beginUserTurn("之后再问");
  const tool = createActiveRecallTool(context, { fetchImpl: async () => Response.json(overview()), log: () => undefined });
  await assert.rejects(() => tool.execute("start", { action: "START", active_skill_id: "skill-a", active_task_id: "task-a", primary_questions: ["一？", "二？", "三？"] }, new AbortController().signal, undefined, {} as Parameters<typeof tool.execute>[4]), /不得立即重新开始/);
});

test("Checkpoint uses the teacher's per-answer judgment, not the last question's assistance", async () => {
  const context = new TeachingSessionContext(); context.bindSession("session-a");
  const tool = createActiveRecallTool(context, {fetchImpl: async () => Response.json(overview()), log: () => undefined});
  const invoke = (id: string, params: Parameters<typeof tool.execute>[1]) => tool.execute(id, params, undefined, undefined, {} as never);
  const common={active_skill_id:"skill-a",active_task_id:"task-a"};
  context.beginUserTurn("开始检查");
  await invoke("start",{...common,action:"START",primary_questions:["解释第一概念？","推导第二规律？","分析第三示例？"]});
  for(const [index,level] of ["WITH_HINT","INDEPENDENT","WITH_REFERENCE"].entries()) {
    context.beginUserTurn(`第${index+1}题的真实输出`);
    await invoke(`q${index}`,{...common,action:"ANSWER",outcome:"CORRECT",observation:`第${index+1}题判断`,
      assistance_level:level as "WITH_HINT"|"INDEPENDENT"|"WITH_REFERENCE", next:index===2?"FINISH":"PRIMARY",
      ...(index===2?{evidence_claims:[{evidence_type:"EXPLAIN" as const,description:"第一题能力",supporting_interaction_summary:"第一题真实输出和相关提示",observation_indices:[0]},
        {evidence_type:"TRANSFER" as const,description:"第二题新情境能力",supporting_interaction_summary:"第二题真实独立推导",observation_indices:[1]}]}:{})});
  }
  const candidates=context.checkpointCandidatesSnapshot();
  assert.equal(candidates[0]!.assistance_level,"WITH_HINT");assert.equal(candidates[1]!.assistance_level,"TRANSFERRED");
  assert.equal("assistant_revision" in candidates[1]!,false);
});

test("directly exposed full answers still cannot support immediate-repetition Evidence", async () => {
  const context = new TeachingSessionContext();context.bindSession("session-a");
  const tool = createActiveRecallTool(context, {fetchImpl: async () => Response.json(overview()), log: () => undefined});
  const invoke = (params: Parameters<typeof tool.execute>[1]) => tool.execute("call",params,undefined,undefined,{} as never);
  const common={active_skill_id:"skill-a",active_task_id:"task-a"};
  context.beginUserTurn("开始检查");await invoke({...common,action:"START",primary_questions:["一？","二？","三？"]});
  await invoke({...common,action:"PAUSE",full_answer_exposed:true});await invoke({...common,action:"RESUME"});
  context.beginUserTurn("照着刚展示的完整答案复述");
  await assert.rejects(()=>invoke({...common,action:"ANSWER",outcome:"CORRECT",observation:"立即复述",next:"FINISH",assistance_level:"INDEPENDENT",
    evidence_claims:[{evidence_type:"EXPLAIN",description:"第一题能力",supporting_interaction_summary:"第一回答",observation_indices:[0]}]}),/完整答案/);
  assert.equal(context.snapshot().candidate_evidence,null);
});
