import assert from "node:assert/strict";
import test from "node:test";

import { TeachingSessionContext } from "./teachingSession.js";

test("teacher judgment supplies current-answer help while known choice exposure remains factual", () => {
  for (const level of ["INDEPENDENT", "WITH_HINT", "WITH_REFERENCE", "WITH_HELP", "TRANSFERRED"] as const) {
    const context = new TeachingSessionContext();
    const candidate = context.recordTurn({active_skill_id:"skill", active_task_id:"task", teaching_mode:"QUIZ", outcome:"CORRECT",
      candidate_evidence:{evidence_type:"EXPLAIN",description:"真实输出",supporting_interaction_summary:"主教师判断本次帮助",assistance_level:level}}).candidate_evidence!;
    assert.equal(candidate.assistance_level,level);
    assert.equal(context.validateEvidenceSubmission(candidate),undefined);
    assert.ok(context.validateEvidenceSubmission({...candidate,description:"伪造另一答案"}));
  }
  const context = new TeachingSessionContext();
  context.learnerQuestions.ask({id:"request",purpose:"CHECK",session_id:"cli-runtime",goal_id:"goal",task_id:"task",skill_id:"skill",
    questions:[{id:"q",prompt:"本题是什么？",selection:"single",options:[{id:"a",label:"一个选项"},{id:"b",label:"另一选项"}]}]});
  context.learnerQuestions.answer("",{request_id:"request",answers:[{question_id:"q",selected_option_ids:["a"],other_text:"真实理由"}]});
  const candidate=context.recordTurn({active_skill_id:"skill",active_task_id:"task",teaching_mode:"QUIZ",outcome:"CORRECT",
    candidate_evidence:{evidence_type:"EXPLAIN",description:"选项及真实解释",supporting_interaction_summary:"本题输出",assistance_level:"INDEPENDENT"}}).candidate_evidence!;
  assert.equal(candidate.assistance_level,"WITH_HINT");
});

test("TeachingSessionContext cannot start outside an ACTIVE task", () => {
  const context = new TeachingSessionContext();
  assert.throws(
    () =>
      context.recordTurn({
        active_skill_id: "cnn",
        active_task_id: "",
        teaching_mode: "EXPLAIN",
        outcome: "START",
        current_question: "为什么卷积保留空间结构？",
      }),
    /ACTIVE LearningTask/,
  );
});

test("TeachingSessionContext records the current teaching intent without prescribing cadence", () => {
  const context = new TeachingSessionContext();
  const first = context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "EXPLAIN",
    outcome: "START",
    current_question: "你觉得卷积层为什么比全连接层更适合图像？",
  });

  assert.equal(first.teaching_flow, "LEARNING");
  assert.equal("response_directive" in first, false);
  assert.deepEqual(first.check_questions, []);
  assert.equal(first.teaching_phase, "CHECK");
});

test("Teacher can ask several related questions when a coherent knowledge block benefits", () => {
  const context = new TeachingSessionContext();
  const result = context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "EXPLAIN",
    outcome: "START",
    current_question: "卷积核怎样提取局部模式？输出 shape 又由哪些参数决定？",
    check_scope: ["卷积核", "输出 shape"],
    check_questions: ["卷积核权重是什么形状？", "输出 shape 是什么？"],
  });

  assert.equal(result.current_question?.includes("输出 shape"), true);
});

test("Teacher can explain a coherent block without forcing an immediate question", () => {
  const context = new TeachingSessionContext();
  const result = context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "EXPLAIN",
    outcome: "START",
  });

  assert.equal(result.teaching_mode, "EXPLAIN");
  assert.equal(result.current_question, null);
});

test("Review intent accepts the number of questions that fits the knowledge block", () => {
  const context = new TeachingSessionContext();
  context.beginUserTurn("请系统复习这部分，一次给我几道题");
  const review = context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "EXPLAIN",
    teaching_flow: "REVIEW",
    review_reason: "USER_REQUEST",
    outcome: "START",
    current_question: "CNN 基础知识检查",
    check_scope: ["局部连接", "参数共享"],
    check_questions: [
      "局部连接为什么适合图像？",
      "参数共享怎样减少参数量？",
    ],
  });

  assert.equal(review.teaching_flow, "REVIEW");
  assert.deepEqual(review.check_scope, ["局部连接", "参数共享"]);
  assert.equal(review.check_questions.length, 2);
});

test("Review label is descriptive rather than a runtime gate", () => {
  const context = new TeachingSessionContext();
  context.beginUserTurn("开始学习");
  const result = context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "EXPLAIN",
    teaching_flow: "REVIEW",
    outcome: "START",
    current_question: "CNN 基础知识检查",
  });

  assert.equal(result.teaching_flow, "REVIEW");
});

test("one completed Review Mode batch can form meaningful EXPLAIN evidence", () => {
  const context = new TeachingSessionContext();
  context.beginUserTurn("请做一次系统复习和综合检查");
  context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "EXPLAIN",
    teaching_flow: "REVIEW",
    review_reason: "USER_REQUEST",
    outcome: "START",
    current_question: "CNN 基础知识检查",
    check_scope: ["局部连接", "参数共享", "输出 shape"],
    check_questions: [
      "局部连接为什么适合图像？",
      "参数共享怎样减少参数量？",
      "输出 shape 怎样计算？",
    ],
  });
  context.beginUserTurn("我一次回答了三题，全部正确");
  const result = context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "QUIZ",
    outcome: "CORRECT",
    current_question: "CNN 基础知识检查",
    candidate_evidence: {
      evidence_type: "EXPLAIN",
      description: "能够解释 CNN 三个基础机制并推导输出 shape。",
      supporting_interaction_summary: "完成三题知识检查，未接受提示。",
    },
  });

  assert.equal(result.candidate_evidence?.assistance_level, "INDEPENDENT");
});

test("Teacher can record the connected gaps needed for a coherent correction", () => {
  const context = new TeachingSessionContext();
  const result = context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "EXPLAIN",
    outcome: "PARTIAL",
    current_question: "输出 shape 是什么？",
    key_gap: "输出通道；padding 的一般条件",
    hint_level: 2,
  });

  assert.equal(result.hint_level, 2);
});

test("Teacher chooses hint depth from the learner response rather than attempt count", () => {
  const context = new TeachingSessionContext();
  context.beginUserTurn("开始学习 CNN");
  context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "QUIZ",
    outcome: "START",
    current_question: "为什么卷积保留空间结构？",
  });

  const first = context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "EXPLAIN",
    outcome: "INCORRECT",
    current_question: "为什么卷积保留空间结构？",
    key_gap: "用户把卷积理解成逐像素独立计算，需要重建局部连接心智模型。",
    hint_level: 3,
  });
  const second = context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "QUIZ",
    outcome: "PARTIAL",
    current_question: "为什么卷积保留空间结构？",
    key_gap: "已经理解局部连接，只需补充参数共享。",
    hint_level: 1,
  });

  assert.equal(first.attempt_count, 1);
  assert.equal(first.hint_level, 3);
  assert.equal(second.attempt_count, 2);
  assert.equal(second.hint_level, 1);
});

test("direct-answer intent immediately selects level 4", () => {
  const context = new TeachingSessionContext();
  context.beginUserTurn("我有点累了，直接告诉我答案");
  const snapshot = context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "QUIZ",
    outcome: "INCORRECT",
    current_question: "输出 shape 是什么？",
    key_gap: "padding",
  });

  assert.equal(snapshot.hint_level, 4);
});

test("meaningful interaction can form Evidence without a fixed check count", () => {
  const context = new TeachingSessionContext();
  context.beginUserTurn("开始");
  context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "QUIZ",
    outcome: "START",
    current_question: "输出 shape 是什么？",
  });
  context.beginUserTurn("我第一次答错了");
  context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "QUIZ",
    outcome: "INCORRECT",
    current_question: "输出 shape 是什么？",
    key_gap: "padding",
    hint_level: 1,
  });
  context.beginUserTurn("我现在能正确推导第一题了");
  const completed = context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "QUIZ",
    outcome: "CORRECT",
    current_question: "输出 shape 是什么？",
    candidate_evidence: {
      evidence_type: "EXPLAIN",
      description: "能够推导卷积输出 shape 并解释 padding 的影响。",
      supporting_interaction_summary: "首次错误，经方向提示后正确推导。",
    },
  });

  assert.equal(completed.candidate_evidence?.assistance_level, "WITH_HINT");
  assert.equal(completed.candidate_evidence?.source, "interactive-teaching-session");
});

test("starting a new question does not erase earlier help from the evidence segment", () => {
  const context = new TeachingSessionContext();
  context.beginUserTurn("开始");
  context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "QUIZ",
    outcome: "START",
    current_question: "为什么卷积共享参数？",
  });
  context.beginUserTurn("答错了");
  context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "QUIZ",
    outcome: "INCORRECT",
    current_question: "为什么卷积共享参数？",
    key_gap: "同一卷积核复用",
    hint_level: 1,
  });
  context.beginUserTurn("补对第一题");
  context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "QUIZ",
    outcome: "CORRECT",
    current_question: "为什么卷积共享参数？",
  });
  context.beginUserTurn("下一题");
  context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "QUIZ",
    outcome: "START",
    current_question: "参数共享如何影响参数量？",
  });
  context.beginUserTurn("答对第二题");
  const result = context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "QUIZ",
    outcome: "CORRECT",
    current_question: "参数共享如何影响参数量？",
    candidate_evidence: {
      evidence_type: "EXPLAIN",
      description: "能够解释参数共享及其对参数量的影响。",
      supporting_interaction_summary: "第一题经提示，第二题独立完成。",
    },
  });

  assert.equal(result.candidate_evidence?.assistance_level, "WITH_HINT");
});

test("reference, substantial help and independent transfer have distinct assistance", () => {
  const referenced = new TeachingSessionContext();
  referenced.beginUserTurn("我参考了 PyTorch 文档后完成");
  assert.equal(
    referenced.recordTurn({
      active_skill_id: "cnn",
      active_task_id: "task-cnn",
      teaching_mode: "BUILD",
      outcome: "CORRECT",
      candidate_evidence: {
        evidence_type: "BUILD",
        description: "参考文档完成卷积模块。",
        supporting_interaction_summary: "用户明确说明查阅文档。",
      },
    }).candidate_evidence?.assistance_level,
    "WITH_REFERENCE",
  );

  const transferred = new TeachingSessionContext();
  transferred.beginUserTurn("我独立把它迁移到医学图像场景");
  assert.equal(
    transferred.recordTurn({
      active_skill_id: "cnn",
      active_task_id: "task-cnn",
      teaching_mode: "BUILD",
      outcome: "CORRECT",
      candidate_evidence: {
        evidence_type: "TRANSFER",
        description: "独立迁移到医学图像分类。",
        supporting_interaction_summary: "无提示完成新场景迁移。",
      },
    }).candidate_evidence?.assistance_level,
    "TRANSFERRED",
  );

  const helped = new TeachingSessionContext();
  helped.beginUserTurn("开始");
  helped.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "BUILD",
    outcome: "START",
    current_question: "实现一个最小卷积模块",
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    helped.beginUserTurn("我还没有完成");
    helped.recordTurn({
      active_skill_id: "cnn",
      active_task_id: "task-cnn",
      teaching_mode: "BUILD",
      outcome: "INCORRECT",
      current_question: "实现一个最小卷积模块",
      key_gap: "forward 结构",
      hint_level: 3,
    });
  }
  helped.beginUserTurn("根据伪代码完成了");
  assert.equal(
    helped.recordTurn({
      active_skill_id: "cnn",
      active_task_id: "task-cnn",
      teaching_mode: "BUILD",
      outcome: "CORRECT",
      current_question: "实现一个最小卷积模块",
      candidate_evidence: {
        evidence_type: "BUILD",
        description: "根据结构提示完成最小卷积模块。",
        supporting_interaction_summary: "Level 3 已提供部分答案。",
      },
    }).candidate_evidence?.assistance_level,
    "WITH_HELP",
  );
});

test("teaching evidence submission must exactly match the runtime candidate", () => {
  const context = new TeachingSessionContext();
  context.beginUserTurn("我独立完成了");
  const candidate = context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "BUILD",
    outcome: "CORRECT",
    candidate_evidence: {
      evidence_type: "BUILD",
      description: "独立实现最小 Conv2d 模型并验证输出 shape。",
      supporting_interaction_summary: "用户无提示完成实现。",
    },
  }).candidate_evidence;
  assert.ok(candidate);

  assert.equal(
    context.validateEvidenceSubmission({
      skill_id: candidate.skill_id,
      evidence_type: candidate.evidence_type,
      description: candidate.description,
      assistance_level: candidate.assistance_level,
      source: candidate.source,
    }),
    undefined,
  );
  assert.equal(
    context.validateEvidenceSubmission({
      skill_id: candidate.skill_id,
      evidence_type: candidate.evidence_type,
      description: candidate.description,
      assistance_level: "WITH_HELP",
      source: candidate.source,
    })?.block,
    true,
  );

  context.clearCandidateEvidence();
  assert.equal(context.snapshot().candidate_evidence, null);
});

test("reference disclosed on the START turn remains part of the teaching trace", () => {
  const context = new TeachingSessionContext();
  context.beginUserTurn("我参考 PyTorch 文档开始这个练习");
  context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "BUILD",
    outcome: "START",
    current_question: "实现一个最小 Conv2d 模块",
  });
  context.beginUserTurn("我完成了");
  const result = context.recordTurn({
    active_skill_id: "cnn",
    active_task_id: "task-cnn",
    teaching_mode: "BUILD",
    outcome: "CORRECT",
    current_question: "实现一个最小 Conv2d 模块",
    candidate_evidence: {
      evidence_type: "BUILD",
      description: "参考文档完成最小 Conv2d 模块。",
      supporting_interaction_summary: "用户在片段开始时声明使用文档。",
    },
  });

  assert.equal(result.candidate_evidence?.assistance_level, "WITH_REFERENCE");
});
