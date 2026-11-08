"""Route detours retain the root Task and cannot manufacture mastery."""
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
import pytest
from app.domain import LearningTask, TaskStatus, FrontierPlan, LearningDepth, SkillNode
from app.domain.learning_branch import LearningBranch
from app.persistence import JsonLearningStateStore
from tests.test_answer_assessment import service_fixture


def propose(service, id="detour-1"):
    return service.propose_learning_branch(LearningBranch(id, "goal", "skill", "a", "prerequisite", "先补类型转换",
        "原题需要", "理解数字与字符串相加", "能解释原题中为什么触发拼接"), service.current_plan_revision)


def transition(service, branch, action, op=None, **extra):
    task = service.get_active_task()
    return service.transition_learning_branch_by_user(branch.id, action, operation_id=op or f"operation-{action}-{branch.revision}",
        expected_revision=branch.revision, expected_goal_id="goal", expected_task_id=task.id if task else None,
        expected_task_revision=task.activity_revision if task else 0, **extra)


def test_return_and_resume_keep_root_task_and_separate_progress():
    service = service_fixture()
    before = service.snapshot()
    b = transition(service, propose(service), "enter")
    task = service.get_active_task()
    assert service.get_task("ta").status is TaskStatus.PAUSED
    assert task.branch_id == b.id
    assert service.learning_paths()["main_skill_ids"] == ["a", "b"]
    with pytest.raises(ValueError):
        propose(service, "child")
    with pytest.raises(ValueError):
        service.complete_task("ta")
    b = transition(service, b, "return", handoff="讲了类型转换，还未作答", assistance_provided=True)
    assert service.get_active_task() == before.tasks[0]
    assert service.get_task(task.id).status is TaskStatus.PAUSED
    b = transition(service, b, "enter")
    assert service.get_active_task().id == task.id
    b = transition(service, b, "complete")
    assert b.status == "COMPLETED"
    assert service.get_active_task().id == "ta"
    assert service.get_skill("a") == before.skills[0]
    assert service.snapshot().evidence == before.evidence
    assert service.snapshot().curriculum_spine == before.curriculum_spine


def test_retry_stale_request_rollback_and_restart():
    with TemporaryDirectory() as folder:
        store = JsonLearningStateStore(Path(folder) / "state.json")
        service = store.bind(service_fixture())
        b = propose(service)
        entered = transition(service, b, "enter", "operation-enter")
        assert transition(service, b, "enter", "operation-enter") == entered
        restored = store.load()
        assert restored.active_learning_branch() == entered
        before = restored.snapshot()
        restored.enable_auto_save(lambda _: (_ for _ in ()).throw(OSError("disk full")))
        with pytest.raises(OSError):
            transition(restored, entered, "return")
        assert restored.snapshot() == before
        returned = transition(service, entered, "return")
        with pytest.raises(ValueError):
            transition(service, b, "enter", "late-operation")
        assert service.get_active_task().id == "ta"


def test_more_basics_extend_same_branch_without_rewriting_main():
    service = service_fixture()
    b = transition(service, propose(service), "enter")
    old = service.snapshot()
    frontier = FrontierPlan("new-basic", "回到原题需要", LearningDepth.PRACTICAL, "DIALOGUE", "解释字符串")
    service.apply_frontier_plan(frontier, added_skills=(SkillNode("new-basic", "字符串"),))
    assert service.snapshot().frontier == old.frontier
    assert service.get_learning_overview().current_frontier == frontier
    assert len(service.learning_paths()["branches"]) == 1
    with pytest.raises(ValueError):
        service.create_task(LearningTask("wrong", "主线", "不能写", ("a",), ()))
    with pytest.raises(ValueError):
        service.apply_frontier_plan(frontier, remove_skill_ids=("a",))
    with pytest.raises(ValueError):
        service.change_future_skill_depth("b", LearningDepth.DEEP)
    task = service.create_task(LearningTask("next-basic", "练习字符串", "分支内继续", ("new-basic",), ()))
    assert task.branch_id == b.id and task.goal_id == "goal"
    b = service.active_learning_branch()
    transition(service, b, "return")
    with pytest.raises(ValueError):
        service.update_frontier(frontier)
    with pytest.raises(ValueError):
        service.create_task(LearningTask("outside", "字符串", "不能混入主线", ("new-basic",), ()))


def test_v9_migrates_without_dropping_history():
    service = service_fixture()
    payload = JsonLearningStateStore._encode(service)
    payload["version"] = 9
    payload.pop("learning_branches")
    restored = JsonLearningStateStore._decode(payload)
    assert restored.snapshot() == service.snapshot()
