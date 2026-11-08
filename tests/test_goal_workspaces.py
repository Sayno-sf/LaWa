"""Returning to earlier Goals and review tasks preserves each learning workspace."""

import json
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from app.application import LearningService
from app.domain import (
    CurriculumMilestone, FrontierPlan, GoalProfile, LearningDepth,
    LearningTask, SkillGraph, SkillNode, SkillState, TaskStatus,
)
from app.persistence import JsonLearningStateStore


def install(service: LearningService, goal_id: str, skill_id: str, *, replace: bool = False) -> None:
    spine = tuple(CurriculumMilestone(f"{goal_id}-{i}", f"Step {i}", "Practice", LearningDepth.PRACTICAL) for i in range(5))
    service.initialize_curriculum(
        GoalProfile(goal_id, f"Learn {goal_id}", "background", "outcome"),
        spine, (SkillNode(skill_id, skill_id),),
        FrontierPlan(focus_skill_id=skill_id, supporting_skill_ids=(), reason="reason", target_depth=LearningDepth.PRACTICAL, suggested_learning_mode="BUILD", next_action="continue"),
        replace_existing=replace,
    )


def test_two_goal_tasks_and_review_roundtrip_survive_restart() -> None:
    with TemporaryDirectory() as directory:
        store = JsonLearningStateStore(Path(directory) / "state.json")
        service = store.bind(LearningService(SkillGraph([]), current_goal=None))
        install(service, "goal-a", "skill-a")
        service.create_task(LearningTask("task-a", "Task A", "Study A", ("skill-a",), ()))
        service.activate_task("task-a")
        service.confirm_mastery_by_user("skill-a")
        install(service, "goal-b", "skill-b", replace=True)
        service.create_task(LearningTask("task-b", "Task B", "Study B", ("skill-b",), ()))
        service.activate_task("task-b")

        service.switch_goal_by_user("goal-a")
        assert service.get_active_task().id == "task-a"
        assert service.get_learning_overview().current_frontier.focus_skill_id == "skill-a"
        with pytest.raises(ValueError, match="current Goal"):
            service.confirm_mastery_by_user("skill-b")
        review = service.start_review_by_user("skill-a", "operation-001")
        assert service.start_review_by_user("skill-a", "operation-001") == review
        assert service.get_task("task-a").status is TaskStatus.PAUSED
        assert service.get_skill("skill-a").status is SkillState.PRACTICING
        service.switch_goal_by_user("goal-b")
        assert service.get_active_task().id == "task-b"

        restored = store.load()
        assert restored is not None
        restored.switch_goal_by_user("goal-a")
        assert restored.get_active_task().id == review.id
        assert restored.finish_review_by_user(review.id).id == "task-a"
        assert restored.get_active_task().id == "task-a"
        assert restored.get_task(review.id).status is TaskStatus.DONE


def test_v1_migration_backups_original_ledger() -> None:
    with TemporaryDirectory() as directory:
        path = Path(directory) / "state.json"
        store = JsonLearningStateStore(path)
        service = store.bind(LearningService(SkillGraph([]), current_goal=None))
        install(service, "legacy-goal", "legacy-skill")
        old = json.loads(path.read_text(encoding="utf-8"))
        old["version"] = 1
        old["learning_history"] = []
        path.write_text(json.dumps(old), encoding="utf-8")
        loaded = store.load()
        assert loaded is not None
        assert loaded.get_learning_overview().goal_profile.id == "legacy-goal"
        backup = path.with_name("state.json.v1.bak")
        assert backup.exists()
        assert json.loads(backup.read_text(encoding="utf-8"))["version"] == 1


def test_confirming_mastery_during_review_restores_the_unfinished_learning_task() -> None:
    with TemporaryDirectory() as directory:
        store = JsonLearningStateStore(Path(directory) / "state.json")
        service = store.bind(LearningService(SkillGraph([]), current_goal=None))
        spine = tuple(CurriculumMilestone(f"step-{i}", f"Step {i}", "Practice", LearningDepth.PRACTICAL) for i in range(5))
        service.initialize_curriculum(
            GoalProfile("goal-review", "Learn review", "background", "outcome"),
            spine, (SkillNode("reviewed-skill", "Reviewed", status=SkillState.MASTERED_BY_USER), SkillNode("next-skill", "Continue")),
            FrontierPlan(focus_skill_id="next-skill", supporting_skill_ids=(), reason="reason", target_depth=LearningDepth.PRACTICAL, suggested_learning_mode="BUILD", next_action="continue"),
        )
        service.create_task(LearningTask("next-task", "Continue current lesson", "Study next", ("next-skill",), ()))
        service.activate_task("next-task")
        review = service.start_review_by_user("reviewed-skill", "review-completion-001")
        assert service.get_active_task().id == review.id
        service.confirm_mastery_by_user("reviewed-skill")
        assert service.get_skill("reviewed-skill").status is SkillState.MASTERED_BY_USER
        assert service.get_active_task().id == "next-task", "再次掌握必须结束复习并恢复原学习，不能继续把已掌握技能作为当前任务"
        assert service.get_task(review.id).status is TaskStatus.DONE
        restored = store.load()
        assert restored is not None
        assert restored.get_active_task().id == "next-task"


def review_fixture(*, parent: bool = True) -> tuple[LearningService, LearningTask]:
    service = LearningService(
        SkillGraph([SkillNode("reviewed", "Reviewed", status=SkillState.MASTERED_BY_USER), SkillNode("next", "Next", status=SkillState.LEARNING)]),
        current_goal="Review goal", goal_profile=GoalProfile("goal-review", "Review goal", "background", "outcome"),
        tasks=(LearningTask("original", "Original", "Continue next", ("next",), (), TaskStatus.ACTIVE, "goal-review"),) if parent else (),
    )
    return service, service.start_review_by_user("reviewed", "operation-001")


def test_review_mastery_persists_one_complete_snapshot_and_preserves_ordinary_task() -> None:
    service, review = review_fixture()
    saved = []
    service.enable_auto_save(lambda current: saved.append(current.snapshot()))
    service.confirm_mastery_by_user("reviewed")
    assert len(saved) == 1
    assert saved[0] == service.snapshot()
    assert service.get_active_task().id == "original"
    assert service.get_task(review.id).status is TaskStatus.DONE
    # 普通下一课的用户 Mastery 不等同于 Task completion。
    service.confirm_mastery_by_user("next")
    assert service.get_active_task().id == "original"
    assert service.get_task("original").status is TaskStatus.ACTIVE


def test_finished_review_can_repair_legacy_paused_parent_after_restart() -> None:
    service, review = review_fixture()
    service.complete_task(review.id)  # 旧版老师完成复习，但原任务仍暂停。
    assert service.get_active_task() is None
    with TemporaryDirectory() as directory:
        store = JsonLearningStateStore(Path(directory) / "state.json")
        store.save(service)
        restored = store.load()
        assert restored is not None
        restored.confirm_mastery_by_user("reviewed")
        assert restored.get_active_task().id == "original"
        assert restored.get_skill("reviewed").status is SkillState.MASTERED_BY_USER
        assert restored.finish_review_by_user(review.id).id == "original"


def test_finish_review_retry_does_not_steal_later_task() -> None:
    service, review = review_fixture()
    service.finish_review_by_user(review.id)
    service.complete_task("original")
    service.create_task(LearningTask("later", "Later", "Later work", ("next",), ()))
    service.activate_task("later")
    assert service.finish_review_by_user(review.id).id == "later"
    assert service.get_task("original").status is TaskStatus.DONE
    assert service.get_active_task().id == "later"


def test_mastery_without_parent_closes_review_without_inventing_a_task() -> None:
    service, review = review_fixture(parent=False)
    service.confirm_mastery_by_user("reviewed")
    assert service.get_active_task() is None
    assert service.get_task(review.id).status is TaskStatus.DONE
    assert service.finish_review_by_user(review.id) is None


def test_nested_review_rejection_and_invalid_parent_do_not_mutate_skill() -> None:
    service, review = review_fixture()
    before = service.snapshot()
    with pytest.raises(ValueError, match="current review"):
        service.start_review_by_user("next", "operation-002")
    assert service.snapshot() == before
    # 损坏返回关系必须在确认 Skill 之前拒绝，不能留下半次保存。
    service._tasks[review.id] = replace(review, review_parent_task_id="missing-parent")
    before = service.snapshot()
    with pytest.raises(ValueError, match="parent task"):
        service.confirm_mastery_by_user("reviewed")
    assert service.snapshot() == before


def test_legacy_active_mastered_review_can_finish_without_second_mastery_transition() -> None:
    service, review = review_fixture()
    service._graph = service._graph.replace_skill(replace(service.get_skill("reviewed"), status=SkillState.MASTERED_BY_USER))
    service.confirm_mastery_by_user("reviewed")
    assert service.get_active_task().id == "original"
    assert service.get_task(review.id).status is TaskStatus.DONE


def test_task_detail_api_is_readonly_and_returns_missing_as_404() -> None:
    from fastapi.testclient import TestClient
    from app.api.main import app, get_learning_service
    service, review = review_fixture()
    before = service.snapshot()
    app.dependency_overrides[get_learning_service] = lambda: service
    try:
        with TestClient(app) as client:
            response = client.get(f"/api/learning/tasks/{review.id}")
            assert response.status_code == 200
            assert response.json()["review_parent_task_id"] == "original"
            assert response.json()["status"] == "ACTIVE"
            assert client.get("/api/learning/tasks/missing").status_code == 404
        assert service.snapshot() == before
    finally:
        app.dependency_overrides.clear()
