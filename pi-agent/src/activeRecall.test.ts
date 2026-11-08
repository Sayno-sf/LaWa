import assert from "node:assert/strict";
import test from "node:test";

import { ActiveRecallContext } from "./activeRecall.js";
import { TeachingSessionContext } from "./teachingSession.js";

const scope = { goal_id: "goal-a", session_id: "session-a", skill_id: "skill-a", task_id: "task-a" };
const questions = ["核心是什么？", "容易混淆什么？", "为什么成立？", "换场景如何用？"];

test("legacy automatic TA flags cannot veto a new correct observation judged independent", () => {
  const recall=new ActiveRecallContext();recall.beginUserTurn();recall.start({...scope,primary_questions:questions});
  recall.beginUserTurn();
  const result=recall.answer({...scope,outcome:"CORRECT",observation:"本题真实独立解释",assistance_level:"INDEPENDENT",next:"FINISH",
    assistant_assistance:{floor:"WITH_HELP",summary:"上一题的自动归因",revision:"old",unknown:true,full_answer_exposed:true},
    evidence_claims:[{evidence_type:"EXPLAIN",description:"本次真实表现",supporting_interaction_summary:"本题回答",observation_indices:[0]}]});
  assert.equal(result.evidence[0]!.assistance_level,"INDEPENDENT");
  assert.match(result.evidence[0]!.supporting_interaction_summary,/非本题结论/);
});

test("checkpoint plans 3–5 questions but exposes only Q1 and requires a later user turn", () => {
  const recall = new ActiveRecallContext();
  recall.beginUserTurn();
  assert.throws(() => recall.start({ ...scope, primary_questions: questions.slice(0, 2) }), /3～5/);
  assert.throws(() => recall.start({ ...scope, primary_questions: [...questions, "综合？", "多余？"] }), /3～5/);
  const started = recall.start({ ...scope, primary_questions: questions });
  assert.equal(started.current_question, questions[0]);
  assert.equal(started.asked_count, 1);
  assert.deepEqual(started.observations, []);
  assert.throws(() => recall.answer({ ...scope, outcome: "CORRECT", observation: "真实回答", next: "PRIMARY" }), /尚未收到用户/);
  recall.beginUserTurn();
  const next = recall.answer({ ...scope, outcome: "CORRECT", observation: "真实回答", next: "PRIMARY" });
  assert.equal(next.checkpoint?.current_question, questions[1]);
  assert.equal(next.checkpoint?.primary_index, 1);
  assert.deepEqual(next.evidence, []);
});

test("adaptive follow-up tracks hint assistance; wrong answers and incomplete checks create no Evidence", () => {
  const recall = new ActiveRecallContext();
  recall.beginUserTurn();
  recall.start({ ...scope, primary_questions: questions });
  recall.beginUserTurn();
  const followUp = recall.answer({ ...scope, outcome: "PARTIAL", observation: "漏掉关键条件", next: "FOLLOW_UP", next_question: "这个条件为何必要？", next_hint_level: 1 });
  assert.equal(followUp.checkpoint?.current_question, "这个条件为何必要？");
  assert.equal(followUp.checkpoint?.hint_level, 1);
  assert.deepEqual(followUp.evidence, []);
  recall.beginUserTurn();
  const finished = recall.answer({
    ...scope, outcome: "CORRECT", observation: "根据方向提示补出条件", next: "FINISH",
    evidence_claims: [{ evidence_type: "EXPLAIN", description: "能够解释关键条件", supporting_interaction_summary: "经提示完成定向追问", observation_indices: [1] }],
  });
  assert.equal(finished.evidence[0]?.assistance_level, "WITH_HINT");
  assert.equal(finished.checkpoint, null);
});

test("assistance aggregates across observations and full-answer restatement cannot support Evidence", () => {
  const recall = new ActiveRecallContext();
  recall.beginUserTurn();
  recall.start({ ...scope, primary_questions: questions });
  recall.beginUserTurn();
  recall.answer({ ...scope, outcome: "CORRECT", observation: "独立解释", next: "PRIMARY" });
  recall.beginUserTurn();
  const next = recall.answer({ ...scope, outcome: "INCORRECT", observation: "概念误解", next: "RETEACH", next_question: "换例子再解释？", next_hint_level: 3, full_answer_exposed: true });
  assert.equal(next.checkpoint?.full_answer_exposed, true);
  recall.beginUserTurn();
  assert.throws(() => recall.answer({
    ...scope, outcome: "CORRECT", observation: "复述完整答案", next: "FINISH",
    evidence_claims: [{ evidence_type: "EXPLAIN", description: "复述", supporting_interaction_summary: "刚看完整答案", observation_indices: [2] }],
  }), /完整答案/);
  assert.equal(recall.snapshot()?.observations.length, 2);
  const finished = recall.answer({
    ...scope, outcome: "CORRECT", observation: "复述完整答案", next: "FINISH",
    evidence_claims: [{ evidence_type: "EXPLAIN", description: "独立解释核心", supporting_interaction_summary: "第一题独立解释", observation_indices: [0] }],
  });
  assert.equal(finished.evidence[0]?.assistance_level, "INDEPENDENT");
});

test("a paused checkpoint remembers answer exposure before the learner resumes", () => {
  const recall = new ActiveRecallContext();
  recall.beginUserTurn();
  recall.start({ ...scope, primary_questions: questions });
  const paused = recall.pause(scope, { hint_level: 3, full_answer_exposed: true });
  assert.equal(paused.full_answer_exposed, true);
  recall.resume(scope);
  recall.beginUserTurn();
  assert.throws(() => recall.answer({
    ...scope, outcome: "CORRECT", observation: "刚刚复述答案", next: "FINISH",
    evidence_claims: [{ evidence_type: "EXPLAIN", description: "不能独立", supporting_interaction_summary: "复述", observation_indices: [0] }],
  }), /完整答案/);
});

test("stop rolls back question progression; skip and scope changes never persist candidates", () => {
  const context = new TeachingSessionContext();
  context.bindSession(scope.session_id);
  context.beginUserTurn("开始检查");
  context.beginAgentTurn();
  context.activeRecall.start({ ...scope, primary_questions: questions });
  context.endAgentTurn(true);
  context.beginUserTurn("我认为这样解释");
  context.beginAgentTurn();
  context.activeRecall.answer({ ...scope, outcome: "CORRECT", observation: "独立回答", next: "PRIMARY" });
  context.endAgentTurn(false);
  assert.equal(context.activeRecall.snapshot()?.current_question, questions[0]);
  assert.equal(context.snapshot().candidate_evidence, null);
  assert.throws(() => context.activeRecall.pause({ ...scope, goal_id: "goal-b" }), /失效/);
  assert.equal(context.activeRecall.snapshot(), null);
  context.beginUserTurn("重新开始");
  context.activeRecall.start({ ...scope, primary_questions: questions });
  context.skipCheckpoint();
  assert.equal(context.activeRecall.snapshot(), null);
});

test("checkpoint candidates use the existing Evidence preflight and are consumed only after successful persistence", () => {
  const context = new TeachingSessionContext();
  context.bindSession(scope.session_id);
  context.setCheckpointCandidates(scope, [
    { evidence_type: "EXPLAIN", description: "独立解释核心", supporting_interaction_summary: "真实回答", assistance_level: "INDEPENDENT" },
  ]);
  const input = { skill_id: "skill-a", evidence_type: "EXPLAIN" as const, description: "独立解释核心", assistance_level: "INDEPENDENT" as const, source: "interactive-teaching-session" };
  assert.equal(context.validateEvidenceSubmission(input, "call-1"), undefined);
  context.clearCandidateEvidence("call-1", false);
  assert.equal(context.snapshot().candidate_evidence?.description, "独立解释核心");
  assert.equal(context.validateEvidenceSubmission(input, "call-2"), undefined);
  context.clearCandidateEvidence("call-2", true);
  assert.equal(context.snapshot().candidate_evidence, null);
  assert.equal(context.validateEvidenceSubmission(input, "call-3")?.block, true);
});

test("incomplete checkpoint blocks Evidence writes even when the source is not interactive", () => {
  const context = new TeachingSessionContext();
  context.bindSession(scope.session_id);
  context.beginUserTurn("开始检查");
  context.activeRecall.start({ ...scope, primary_questions: questions });
  const unrelatedSource = { skill_id: scope.skill_id, evidence_type: "EXPLAIN" as const, description: "凭空声称", assistance_level: "INDEPENDENT" as const, source: "user report" };
  assert.equal(context.evidenceWriteGuard(unrelatedSource)?.block, true);
  context.skipCheckpoint();
  assert.equal(context.evidenceWriteGuard(unrelatedSource), undefined);
  context.setCheckpointCandidates(scope, [{ evidence_type: "EXPLAIN", description: "真实表现", supporting_interaction_summary: "完成回忆", assistance_level: "INDEPENDENT" }]);
  assert.equal(context.evidenceWriteGuard(unrelatedSource)?.block, true);
});

test("six-question cap and reference disclosure cannot become independent", () => {
  const recall = new ActiveRecallContext();
  recall.beginUserTurn();
  recall.start({ ...scope, primary_questions: questions });
  for (let index = 1; index < 6; index += 1) {
    recall.beginUserTurn();
    recall.answer({ ...scope, outcome: "PARTIAL", observation: `第 ${index} 次部分回答`, next: "FOLLOW_UP", next_question: `追问 ${index}` });
  }
  recall.beginUserTurn();
  assert.throws(() => recall.answer({ ...scope, outcome: "PARTIAL", observation: "仍然不足", next: "FOLLOW_UP", next_question: "第七问" }), /6 个问题/);
  const finished = recall.answer({ ...scope, outcome: "CORRECT", observation: "参考文档完成", next: "FINISH", used_reference: true,
    evidence_claims: [{ evidence_type: "EXPLAIN", description: "参考文档解释", supporting_interaction_summary: "第六次回答参考了文档", observation_indices: [5] }],
  });
  assert.equal(finished.evidence[0]?.assistance_level, "WITH_REFERENCE");
});

test("two checkpoint Evidence writes may reserve independently and a failed write remains retryable", () => {
  const context = new TeachingSessionContext();
  context.bindSession(scope.session_id);
  context.setCheckpointCandidates(scope, [
    { evidence_type: "EXPLAIN", description: "解释边界", supporting_interaction_summary: "回答一", assistance_level: "INDEPENDENT" },
    { evidence_type: "TRANSFER", description: "迁移设计", supporting_interaction_summary: "回答二", assistance_level: "TRANSFERRED" },
  ]);
  const first = { skill_id: scope.skill_id, evidence_type: "EXPLAIN" as const, description: "解释边界", assistance_level: "INDEPENDENT" as const, source: "interactive-teaching-session" };
  const second = { skill_id: scope.skill_id, evidence_type: "TRANSFER" as const, description: "迁移设计", assistance_level: "TRANSFERRED" as const, source: "interactive-teaching-session" };
  assert.equal(context.validateEvidenceSubmission(first, "first"), undefined);
  assert.equal(context.validateEvidenceSubmission(second, "second"), undefined);
  context.clearCandidateEvidence("second", false);
  context.clearCandidateEvidence("first", true);
  assert.equal(context.snapshot().candidate_evidence?.description, "迁移设计");
  assert.equal(context.validateEvidenceSubmission(second, "retry"), undefined);
  context.clearCandidateEvidence("retry", true);
  assert.equal(context.snapshot().candidate_evidence, null);
});
