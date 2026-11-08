import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSystemPrompt,
  summarizeKernelRoute,
  SYSTEM_PROMPT,
} from "./agentPolicy.js";

// 政策措辞可以精简；忽略排版空白，只检查必须保留的语义边界。
const policy = SYSTEM_PROMPT.replace(/\s+/g, "");

const emptyTeachingContext = {
  active_skill_id: null,
  active_task_id: null,
  teaching_mode: null,
  teaching_flow: null,
  teaching_phase: null,
  current_question: null,
  check_scope: [],
  check_questions: [],
  attempt_count: 0,
  hint_level: 0 as const,
  candidate_evidence: null,
};

test("Teacher Constitution keeps Kernel constraints strict and teaching strategy flexible", () => {
  assert.match(policy, /Kernel严格，Teacher自由/);
  assert.match(policy, /不得.*Master/i);
  assert.match(policy, /Evidence.*历史事实/s);
  assert.match(policy, /已有学习历史.*不得.*改写/s);
  assert.match(policy, /MajorGoalChange.*用户确认/s);
  assert.match(policy, /连贯讲清.*知识块/s);
  assert.match(policy, /动态调整.*解释深度.*问题难度/s);
  assert.match(policy, /直接给答案.*尊重/s);
  assert.match(policy, /EXPLAIN.*QUIZ.*BUILD.*DEBUG.*当前意图/s);
  assert.match(policy, /Evidence.*后台.*阶段末/s);
  assert.match(policy, /present_practice_set.*2～10道题/s);
  assert.match(policy, /题组.*不自动逐题评分.*写Evidence/s);
  assert.match(policy, /同一Frontier.*自然推进/s);
  assert.match(policy, /教学Evidence只能写给当前ACTIVETask关联的Skill/);
  assert.match(policy, /不得仅凭同章节Evidence宣称整条路线学完/);
  assert.match(policy, /Evidence先成功提交，再完成该Task/);
  assert.match(policy, /推荐下一章节或更新Frontier前依据最新状态核对SkillState/);

  assert.doesNotMatch(policy, /一次只推进一个认知单元/);
  assert.doesNotMatch(policy, /Level 0.*Level 1.*Level 2/s);
  assert.doesNotMatch(policy, /3～5 道/);
  assert.doesNotMatch(policy, /必须.*Retry/);
});

test("Teacher receives a flexible knowledge-card timing and deduplication boundary", () => {
  assert.match(policy, /讲清连贯单元.*1～3张高价值卡片/);
  assert.match(policy, /探索、纠错或结论未定时暂缓/);
  assert.match(policy, /不是必须先练习的状态机/);
  assert.match(policy, /参考已取得的knowledge_cards去重/);
  assert.match(policy, /不每条回复建卡或额外读overview/);
  assert.match(policy, /卡片、自评、笔记.*不是Evidence或Mastery/);
});

test("practice remains optional and mastery stays user-owned", () => {
  assert.match(policy, /\/practice<skill_id>/);
  assert.match(policy, /LEARNING.*\/master<skill_id>.*一步确认/s);
  assert.match(policy, /\/practice.*可选/s);
});

test("system prompt exposes only real local commands", () => {
  assert.match(policy, /\/abandon-task<task_id>/);
  assert.match(policy, /不得虚构CLI命令/);
  assert.match(policy, /不得建议不存在的\/status、\/tasks、\/skip/);
});

test("web prompt names browser controls instead of teaching CLI commands", () => {
  const dynamic = buildSystemPrompt(emptyTeachingContext, undefined, "WEB");
  assert.match(dynamic, /技能操作.*按钮/s);
  assert.match(dynamic, /不提示.*\/master/s);
  assert.doesNotMatch(dynamic, /允许告知用户的本地命令/);
});

test("runtime context informs the Teacher without prescribing a response", () => {
  const dynamic = buildSystemPrompt({
    ...emptyTeachingContext,
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "DEBUG",
    current_question: "为什么输出 shape 不对？",
    attempt_count: 2,
    hint_level: 3,
  });
  assert.match(dynamic, /"active_skill_id": "cnn"/);
  assert.match(dynamic, /"teaching_mode": "DEBUG"/);
  assert.match(dynamic, /"hint_level": 3/);
});

test("fresh Kernel route summary exposes current task and pending Frontier without long Evidence text", () => {
  const route = summarizeKernelRoute({
    current_goal: "Learn Carnegie",
    goal_profile: { id: "goal-carnegie" },
    curriculum_spine: [],
    current_frontier: {
      focus_skill_id: "second",
      supporting_skill_ids: ["third"],
      next_action: "Teach second, then third",
    },
    current_focus: null,
    skills: [
      { id: "first", status: "LEARNING", evidence_ids: ["e-1"] },
      { id: "second", status: "LEARNING", evidence_ids: ["e-2", "e-3"] },
      { id: "third", status: "NOT_STARTED", evidence_ids: [] },
    ],
    recent_evidence: [{ description: "private learning details must not enter the short summary" }],
    active_task: { id: "task-second", status: "ACTIVE", related_skill_ids: ["second"] },
    learning_history: [],
    current_goal_skill_ids: ["first", "second", "third"],
  });
  assert.match(route, /task-second/);
  assert.match(route, /second.*LEARNING/);
  assert.match(route, /third.*NOT_STARTED/);
  assert.doesNotMatch(route, /private learning details/);
  const prompt = buildSystemPrompt(emptyTeachingContext, undefined, "WEB", route);
  assert.match(prompt, /当前 Python Kernel 路线快照/);
  assert.match(prompt, /task-second/);
});

test("planning prompt keeps onboarding and curriculum history boundaries", () => {
  const dynamic = buildSystemPrompt(emptyTeachingContext, {
    status: "READY_FOR_CONFIRMATION",
    pending_profile: null,
    missing_information: [],
    replace_existing: false,
  });
  assert.match(dynamic, /5～8个粗粒度Curriculum Spine/);
  assert.match(dynamic, /1～3个近期Skill/);
  assert.match(dynamic, /Prior Knowledge Claim.*绝不创建Evidence/s);
  assert.match(dynamic, /考试范围.*propose_plan_revision.*独立确认/s);
  assert.match(dynamic, /Curriculum milestone不是LearningTask/);
  assert.match(dynamic, /"status": "READY_FOR_CONFIRMATION"/);
});

test("replacement onboarding takes priority over the old overview", () => {
  const dynamic = buildSystemPrompt(emptyTeachingContext, {
    status: "NEEDS_CLARIFICATION",
    pending_profile: null,
    missing_information: [],
    replace_existing: true,
  });

  assert.match(
    dynamic,
    /replace_existing.*true[\s\S]*当前用户输入.*新 Goal 描述/i,
  );
  assert.match(dynamic, /优先调用 record_goal_understanding/);
  assert.match(dynamic, /不得再次要求.*\/new-goal replace/);
  assert.match(dynamic, /旧 Goal.*ACTIVE Task.*可恢复的工作区/s);
});

test("initialized planning profiles stop duplicating stale preferences in each model input", () => {
  const profile = { id: "goal", goal_description: "goal", background_summary: "", desired_outcome: "",
    learning_preferences: ["STALE_PREFERENCE"], time_constraint: "", prior_knowledge_claims: [] };
  const planning = { status: "INITIALIZED" as const, pending_profile: profile, missing_information: [], replace_existing: false };
  const prompt = buildSystemPrompt(emptyTeachingContext, planning, "WEB", '{"learning_preferences":["CURRENT_PREFERENCE"]}');
  assert.doesNotMatch(prompt, /STALE_PREFERENCE/);
  assert.match(prompt, /CURRENT_PREFERENCE/);
  assert.deepEqual(planning.pending_profile, profile);
  assert.match(buildSystemPrompt(emptyTeachingContext, { ...planning, status: "CONFIRMED" }), /STALE_PREFERENCE/);
  assert.match(policy, /不为复核而再调用get_learning_overview/);
});


test("surface instructions are explicit and compaction detection keeps its role marker", () => {
  const cli = buildSystemPrompt(emptyTeachingContext, undefined, "CLI");
  const web = buildSystemPrompt(emptyTeachingContext, undefined, "WEB");
  for (const prompt of [cli, web]) {
    assert.ok(prompt.startsWith("你是面向学习者的 Learning Planner、Adaptive Teacher"));
    assert.equal(prompt.split("面向学习者的 Learning Planner").length - 1, 1);
    assert.doesNotMatch(prompt, /最终回复表达检查|32K|6000估算来源tokens|网页右侧的技能/);
  }
  assert.match(cli, /当前界面是CLI/);
  assert.match(cli, /\/abandon-task <task_id>/);
  assert.doesNotMatch(web, /当前界面是CLI|可告知：/);
  assert.match(web, /CONFIRM_GOAL\/START_LEARNING/);
  assert.match(web, /有补充说明的同意先处理并重新询问/);
  assert.equal(web.split("来源表达（规划与教学共用）").length - 1, 1);
  assert.match(web, /已保存的.*标注章节\/行号出处.*集中形式/);
});

test("assembled policy retains assessment, strategy consent and evidence isolation", () => {
  const prompt = buildSystemPrompt(emptyTeachingContext, undefined, "WEB").replace(/\s+/g, "");
  assert.match(prompt, /assessment_criteria固定1-5个评分维度、合计10分/);
  assert.match(prompt, /不追加解释\/术语\/步骤要求/);
  assert.match(prompt, /策略与答题独立.*不评分、不写Evidence、不清空当前题/);
  assert.match(prompt, /REVISION_REQUESTED.*最新revision修订后再次确认/);
  assert.match(prompt, /propose_plan_revision.*完整/s);
  assert.match(prompt, /CONFIRM_PLAN_REVISION.*plan_revision_id/s);
  assert.match(prompt, /不得通过删除重加Skill绕过旧Goal\/Spine/);
  assert.match(prompt, /穿插.*原topic_id|复测复用原topic_id/);
  assert.match(prompt, /低分.*进度门槛/);
  assert.match(prompt, /INDEPENDENT.*不证明用户在系统外没有帮助/);
  assert.match(prompt, /assets.*只有实际图像输入才表示你看到了原图/);
});
test("runtime explicitly denies a question card when no pending request exists",()=>{
 const prompt=buildSystemPrompt(emptyTeachingContext,undefined,"WEB");
 assert.match(prompt,/题卡呈现状态：尚未创建待答题卡/);
 assert.match(prompt,/不得声称.*下面.*题/);
});
test("question receipt is current task scoped and is not a browser visibility receipt",()=>{
 const context={...emptyTeachingContext,active_skill_id:"skill",active_task_id:"task",learner_questions:{pending:{purpose:"PRACTICE_SET",task_id:"task",skill_id:"skill",questions:[{},{}]}}} as unknown as Parameters<typeof buildSystemPrompt>[0];
 assert.match(buildSystemPrompt(context,undefined,"WEB"),/工具已创建当前待答题卡，类型PRACTICE_SET，题数2/);
 assert.match(buildSystemPrompt(context,undefined,"WEB"),/不是浏览器已渲染的证明/);
 context.active_task_id="other";
 assert.match(buildSystemPrompt(context,undefined,"WEB"),/尚未创建待答题卡/);
});
