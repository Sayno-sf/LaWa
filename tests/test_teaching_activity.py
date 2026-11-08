"""Task activity planning must preserve learning facts and reject stale writes."""

import json
from dataclasses import asdict, replace
from hashlib import sha256

import pytest

from app.application import LearningService
from app.domain import (
    ArchivedLearningProject, CurriculumMilestone, FrontierPlan, GoalProfile, LearningDepth,
    LearningTask, SkillGraph, SkillNode, TaskStatus,
    TeachingActivity, TeachingActivityMethod,
)
from app.domain.answer_assessment import AnswerAssessment, AssessmentCriterion, assessment_topic_id
from app.domain.teaching_evolution import QuestionContract, TeachingEvolutionState, TeachingProposal
from app.persistence import JsonLearningStateStore


def activity(**changes):
    return replace(TeachingActivity(
        TeachingActivityMethod.COMPARE, "区分规则的适用条件", "比较例子与反例", "判断新例子并说明关键区别",
        ("识别关键区别",), "只评价本题的文字判断，不推断长期保持或未观察的操作能力",
    ), **changes)


def service_with_task(status=TaskStatus.ACTIVE):
    return LearningService(
        SkillGraph([SkillNode("skill", "概念比较")]), current_goal="学习概念",
        goal_profile=GoalProfile("goal", "学习概念", "初学", "能辨别新例子"),
        current_goal_skill_ids=("skill",),
        tasks=(LearningTask("task", "概念辨别", "比较例子", ("skill",), (), status, "goal"),),
    )


def change(service, selected, revision, goal="goal"):
    return service.set_teaching_activity(
        "task", expected_goal_id=goal, expected_revision=revision, teaching_activity=selected,
    )


def test_activity_adjustment_preserves_learning_facts_and_route_signature():
    service = service_with_task()
    before = service.snapshot()
    signature = service._learning_plan_signature()
    task = change(service, activity(), 0)
    assert task.activity_revision == 1
    assert task.teaching_activity == activity()
    assert replace(task, teaching_activity=None, activity_revision=0) == before.tasks[0]
    assert replace(service.snapshot(), tasks=before.tasks) == before
    assert service._learning_plan_signature() == signature


def test_activity_retries_are_idempotent_and_stale_replacements_fail():
    service = service_with_task()
    first = change(service, activity(), 0)
    assert change(service, activity(), 0) == first
    assert change(service, activity(), 1) == first
    other = activity(method=TeachingActivityMethod.APPLY, learner_action="把规则用于新情境")
    with pytest.raises(ValueError, match="changed"):
        change(service, other, 0)
    second = change(service, other, 1)
    assert second.activity_revision == 2
    assert change(service, other, 1) == second
    with pytest.raises(ValueError, match="changed"):
        change(service, other, 0)
    with pytest.raises(ValueError, match="changed"):
        change(service, activity(), 1)


@pytest.mark.parametrize("status", [TaskStatus.PAUSED, TaskStatus.DONE, TaskStatus.SKIPPED])
def test_activity_cannot_rewrite_noncurrent_learning(status):
    service = service_with_task(status)
    before = service.snapshot()
    with pytest.raises(ValueError, match="TODO or ACTIVE"):
        change(service, activity(), 0)
    assert service.snapshot() == before


def test_activity_rejects_goal_switch_and_invalid_revision():
    service = service_with_task(TaskStatus.TODO)
    before = service.snapshot()
    with pytest.raises(ValueError, match="Goal"):
        change(service, activity(), 0, "other-goal")
    for invalid in (True, -1, 0.5, "0"):
        with pytest.raises(ValueError, match="revision"):
            change(service, activity(), invalid)
    assert service.snapshot() == before


def test_activity_save_failure_restores_original_task():
    service = service_with_task()
    before = service.snapshot()

    def unavailable(_service):
        raise OSError("disk unavailable")

    service.enable_auto_save(unavailable)
    with pytest.raises(OSError, match="disk unavailable"):
        change(service, activity(), 0)
    assert service.snapshot() == before


def test_creating_a_task_with_activity_rolls_back_when_save_fails():
    service = service_with_task()
    before = service.snapshot()
    task = LearningTask("next-task", "新任务", "下一段概念应用", ("skill",), (), goal_id="goal",
                        teaching_activity=activity(), activity_revision=1)

    def unavailable(_service):
        raise OSError("disk unavailable")

    service.enable_auto_save(unavailable)
    with pytest.raises(OSError, match="disk unavailable"):
        service.create_task(task)
    assert service.snapshot() == before
    service.enable_auto_save(lambda _service: None)
    assert service.create_task(task) == task


def test_activity_persistence_is_optional_for_old_tasks_and_durable_for_new(tmp_path):
    store = JsonLearningStateStore(tmp_path / "state.json")
    service = store.bind(service_with_task())
    store.save(service)
    original = json.loads(store.path.read_text(encoding="utf-8"))
    assert "teaching_activity" not in original["tasks"][0]
    assert "activity_revision" not in original["tasks"][0]
    restored = store.load()
    assert restored.get_task("task").teaching_activity is None
    assert restored.get_task("task").activity_revision == 0
    assert json.loads(store.path.read_text(encoding="utf-8")) == original
    task = change(restored, activity(teaching_preferences_revision="a" * 64), 0)
    assert store.load().get_task("task") == task


def test_activity_validation_rejects_ambiguous_or_empty_rubric():
    for labels in ((), ("same", "same"), ("same", " same "), (" ",), ("a" * 101,)):
        with pytest.raises(ValueError):
            activity(evaluation_focus=labels)
    with pytest.raises(ValueError):
        activity(method="COMPARE")
    with pytest.raises(ValueError):
        activity(observation_limits=" ")
    for revision in ("short", "A" * 64, 123):
        with pytest.raises(ValueError):
            activity(teaching_preferences_revision=revision)


def contract(**changes):
    return replace(QuestionContract(
        "question", "goal", "task", "skill", "session", "请选择符合规则的新例子。",
        (("识别关键区别", 10),), activity_revision=1,
    ), **changes)


def assessment_for_contract(value, *, identity="assessment"):
    answer = "第二个例子满足这个条件。"
    topic = "辨别适用条件"
    return AnswerAssessment(
        id=identity, goal_id=value.goal_id, skill_id=value.skill_id,
        topic_id=assessment_topic_id(value.goal_id, value.skill_id, topic), topic=topic,
        source_task_id=value.task_id, source_session_id=value.session_id,
        source_turn_id=f"answer-{identity}", question_entry_id=f"entry-{value.id}",
        question=value.question, answer_excerpt=answer,
        answer_sha256=sha256(answer.encode()).hexdigest(), answer_truncated=False,
        criteria=tuple(AssessmentCriterion(label, points, points, "准确识别了题目要求的区别")
                       for label, points in value.criteria),
        summary="能够辨别这个新例子", strengths=("识别了适用条件",), gaps=(),
        assistance_level="WITH_REFERENCE", contract_id=value.id,
    )


def test_contract_snapshots_activity_and_original_grade_survives_later_adjustment(tmp_path):
    store = JsonLearningStateStore(tmp_path / "state.json")
    service = store.bind(service_with_task())
    original_activity = activity(teaching_preferences_revision="a" * 64)
    change(service, original_activity, 0)
    request = contract()
    saved = service.record_question_contract(request)
    assert saved.teaching_activity == original_activity
    change(service, activity(method=TeachingActivityMethod.REASON,
                             evaluation_focus=("用材料支持判断",), teaching_preferences_revision="b" * 64), 1)
    assert service.record_question_contract(request) == saved
    assert service.snapshot().teaching.contracts == (saved,)
    grade = service.record_answer_assessment(assessment_for_contract(saved))
    assert grade.criteria[0].label == "识别关键区别"
    with pytest.raises(ValueError, match="requirements"):
        service.record_answer_assessment(replace(grade, criteria=(AssessmentCriterion("用材料支持判断", 10, 10, "新要求"),)))
    restored = store.load()
    assert restored.snapshot().teaching.contracts == (saved,)
    assert restored.snapshot().answer_assessments == (grade,)
    assert restored.get_task("task").activity_revision == 2
    assert restored.get_task("task").teaching_activity != saved.teaching_activity
    assert restored.snapshot().evidence == ()


def test_contract_http_rejects_wrong_goal_stale_revision_and_forged_snapshot():
    # 单独挂真实router到内存service，避免导入app.api.main触碰默认用户账本。
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.api.teaching_evolution import teaching_router

    service = service_with_task()
    change(service, activity(), 0)
    isolated = FastAPI()
    isolated.include_router(teaching_router(lambda: service))
    with TestClient(isolated) as client:
        body = {key: value for key, value in asdict(contract()).items()
                if key not in {"created_at", "teaching_activity"}}
        for update in ({"goal_id": "other-goal"}, {"activity_revision": 0}, {"activity_revision": 2},
                       {"criteria": [["未经安排的新要求", 10]]}):
            reply = client.post("/api/learning/question-contracts", json={**body, **update})
            assert reply.status_code == 409, reply.text
        assert service.snapshot().teaching.contracts == ()
        forged = client.post("/api/learning/question-contracts", json={**body, "teaching_activity": asdict(activity())})
        assert forged.status_code == 422
        valid = client.post("/api/learning/question-contracts", json=body)
        assert valid.status_code == 200, valid.text
        assert valid.json()["teaching_activity"]["method"] == "COMPARE"
        change(service, activity(learner_action="换一组例子再比较"), 1)
        retry = client.post("/api/learning/question-contracts", json=body)
        assert retry.status_code == 200
        assert retry.json() == valid.json()
        stale_new = client.post("/api/learning/question-contracts", json={**body, "id": "new-question"})
        assert stale_new.status_code == 409


def test_contract_save_failure_rolls_back_and_retry_uses_current_activity():
    service = service_with_task()
    change(service, activity(), 0)
    before = service.snapshot()

    def unavailable(_service):
        raise OSError("disk unavailable")

    service.enable_auto_save(unavailable)
    with pytest.raises(OSError, match="disk unavailable"):
        service.record_question_contract(contract())
    assert service.snapshot() == before
    service.enable_auto_save(lambda _service: None)
    assert service.record_question_contract(contract()).teaching_activity == activity()


def test_legacy_contract_without_activity_still_loads_and_grades(tmp_path):
    service = service_with_task()
    payload = JsonLearningStateStore._encode(service)
    legacy_contract = contract(activity_revision=0)
    payload["teaching"]["contracts"] = [{key: value for key, value in asdict(legacy_contract).items()
                                          if key not in {"teaching_activity", "activity_revision"}}]
    store = JsonLearningStateStore(tmp_path / "old-state.json")
    store.path.write_text(json.dumps(payload, default=str), encoding="utf-8")
    before_bytes = store.path.read_bytes()
    restored = store.load()
    assert store.path.read_bytes() == before_bytes
    assert restored.snapshot().teaching.contracts == (legacy_contract,)
    assert restored.get_task("task").teaching_activity is None
    saved_grade = restored.record_answer_assessment(assessment_for_contract(legacy_contract))
    assert store.load().snapshot().answer_assessments == (saved_grade,)


def test_domain_scopes_do_not_broaden_legacy_general_strategies(tmp_path):
    source_profile = GoalProfile("source-goal", "来源课程", "初学", "理解材料", learning_domain="历史")
    source_task = LearningTask("source-task", "旧任务", "旧学习", ("source-skill",), (),
                               TaskStatus.DONE, "source-goal")
    source_question = contract(id="source-question", goal_id="source-goal", task_id="source-task",
                               skill_id="source-skill", activity_revision=0)
    observed = replace(assessment_for_contract(source_question, identity="source-assessment"), contract_id=None)
    legacy = TeachingProposal("legacy", "source-goal", "STRATEGY", "先看材料后判断", "原课程真实观察", "SUBJECT",
                              "general", (observed.id,), status="CONFIRMED")
    scoped = replace(legacy, id="scoped", subject="domain:历史", text="比较来源与立场")
    service = LearningService(
        SkillGraph([SkillNode("skill", "当前概念"), SkillNode("source-skill", "来源材料")]),
        current_goal="新课程", goal_profile=GoalProfile("goal", "新课程", "初学", "理解材料", learning_domain="历史"),
        current_goal_skill_ids=("skill",),
        learning_history=(ArchivedLearningProject(source_profile, (), ("source-skill",)),),
        tasks=(LearningTask("task", "当前任务", "比较", ("skill",), (), TaskStatus.ACTIVE, "goal"), source_task),
        answer_assessments=(observed,), teaching=TeachingEvolutionState(proposals=(legacy, scoped)),
    )
    assert [item["id"] for item in service.teaching_context("general")["strategies"]] == ["scoped"]
    service._goal_profile = replace(service._goal_profile, learning_domain="编程")
    assert service.teaching_context("domain:历史")["strategies"] == []
    service._goal_profile = replace(service._goal_profile, learning_domain="")
    assert service.teaching_context("general")["strategies"] == []
    store = JsonLearningStateStore(tmp_path / "state.json")
    store.save(service)
    restored = store.load()
    assert restored.teaching_context()["strategies"] == []
    restored.switch_goal_by_user("source-goal")
    assert {item["id"] for item in restored.teaching_context()["strategies"]} == {"legacy", "scoped"}


def test_empty_domain_signatures_match_pre_upgrade_payloads():
    service = service_with_task()
    snapshot = service.snapshot()
    goal = snapshot.goal_profile
    legacy_goal = {name: getattr(goal, name) for name in (
        "id", "goal_description", "background_summary", "desired_outcome", "learning_preferences",
        "time_constraint", "prior_knowledge_claims", "created_at",
    )}
    task = snapshot.tasks[0]
    legacy_task = {name: getattr(task, name) for name in (
        "id", "title", "description", "related_skill_ids", "expected_evidence_types", "status",
        "goal_id", "review_parent_task_id",
    )}
    legacy_route = {"goal": legacy_goal, "spine": [], "frontier": None,
                    "skills": [asdict(skill) for skill in snapshot.skills],
                    "current_goal_skill_ids": ["skill"], "active_task": legacy_task}
    expected_route = sha256(json.dumps(legacy_route, default=str, sort_keys=True).encode()).hexdigest()
    expected_teaching = sha256(json.dumps({"goal": legacy_goal, "spine": []},
                                         default=str, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    assert service._learning_plan_signature() == expected_route
    assert service._teaching_goal_signature() == expected_teaching
    change(service, activity(), 0)
    assert service._learning_plan_signature() == expected_route
    assert service._teaching_goal_signature() == expected_teaching


def test_domain_revision_is_visible_and_requires_existing_user_confirmation():
    service = LearningService(
        SkillGraph([SkillNode("skill", "当前知识点")]), current_goal="理解材料",
        goal_profile=GoalProfile("goal", "理解材料", "初学", "能说明材料", learning_domain="编程"),
        current_goal_skill_ids=("skill",),
        curriculum_spine=tuple(CurriculumMilestone(f"stage-{i}", f"阶段{i}", "说明", LearningDepth.PRACTICAL,
                                                   skill_ids=("skill",) if i == 0 else ()) for i in range(5)),
        frontier=FrontierPlan("skill", "当前学习", LearningDepth.PRACTICAL, "EXPLAIN", "解释材料"),
    )
    before = service.snapshot()
    common = {"curriculum_spine": before.curriculum_spine, "added_skills": (), "updated_skills": (),
              "remove_skill_ids": (), "frontier": before.frontier, "reason": "调整适用领域"}
    revision = service.prepare_plan_revision(revision_id="change-domain", **common,
        goal_profile=replace(before.goal_profile, learning_domain="历史"))
    assert "学习领域：编程 → 历史" in revision.summary
    assert "学习结果" not in revision.summary
    assert service.snapshot().goal_profile.learning_domain == "编程"
    service.decide_plan_revision(revision.id, action="CONFIRM", feedback="", request_id="human-confirmation")
    assert service.snapshot().goal_profile.learning_domain == "历史"
    assert service.snapshot().skills == before.skills
    assert service.snapshot().evidence == before.evidence
    current = service.snapshot().goal_profile
    omitted = service.prepare_plan_revision(revision_id="old-client", **common,
        goal_profile=replace(current, learning_domain="", desired_outcome="能分析材料"))
    assert omitted.goal_profile.learning_domain == "历史"
