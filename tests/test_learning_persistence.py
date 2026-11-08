"""Local learning-ledger persistence and completed-project history tests."""

from pathlib import Path
from tempfile import TemporaryDirectory
import json
import unittest

from app.application import LearningService
from app.bootstrap import build_gradient_demo_learning_service
from app.domain import (
    CurriculumMilestone,
    EvidenceType,
    FrontierPlan,
    GoalProfile,
    LearningDepth,
    LearningTask,
    SkillGraph,
    SkillNode,
    SkillState,
    TaskStatus,
)
from app.persistence import JsonLearningStateStore


class LearningPersistenceTests(unittest.TestCase):
    def test_legacy_multi_skill_active_task_still_restores(self) -> None:
        with TemporaryDirectory() as directory:
            store = JsonLearningStateStore(Path(directory) / "learning-state.json")
            legacy = LearningService(
                SkillGraph([
                    SkillNode("first", "First", status=SkillState.LEARNING),
                    SkillNode("second", "Second", status=SkillState.LEARNING),
                ]),
                tasks=(LearningTask(
                    id="legacy-task", title="Legacy lesson", description="Both skills",
                    related_skill_ids=("first", "second"),
                    expected_evidence_types=(EvidenceType.EXPLAIN,),
                    status=TaskStatus.ACTIVE,
                ),),
            )
            store.save(legacy)
            restored = store.load()
            self.assertIsNotNone(restored)
            assert restored is not None
            self.assertEqual(restored.get_active_task().related_skill_ids, ("first", "second"))

    def test_every_successful_mutation_is_restored_after_service_restart(self) -> None:
        with TemporaryDirectory() as directory:
            store = JsonLearningStateStore(Path(directory) / "learning-state.json")
            service = store.bind(build_gradient_demo_learning_service())

            service.reopen_skill_by_user("learning-rate-and-optimization-pitfalls")

            restored = store.load()
            self.assertIsNotNone(restored)
            assert restored is not None
            self.assertEqual(
                restored.get_skill("learning-rate-and-optimization-pitfalls").status,
                SkillState.PRACTICING,
            )
            self.assertEqual(
                tuple(item.id for item in restored.snapshot().evidence),
                tuple(item.id for item in service.snapshot().evidence),
            )
            self.assertEqual(
                tuple(item.id for item in restored.get_all_tasks()),
                tuple(item.id for item in service.get_all_tasks()),
            )

    def test_replacing_goal_archives_the_finished_project_and_preserves_its_history(self) -> None:
        with TemporaryDirectory() as directory:
            store = JsonLearningStateStore(Path(directory) / "learning-state.json")
            service = store.bind(build_gradient_demo_learning_service())
            old_skill_ids = tuple(item.id for item in service.get_learning_overview().skills)
            profile = GoalProfile(
                id="goal-next",
                goal_description="独立完成下一个机器学习目标",
                background_summary="已经完成梯度数学学习",
                desired_outcome="把已有梯度知识迁移到新的模型实践",
            )
            spine = tuple(
                CurriculumMilestone(
                    f"next-{index}",
                    f"下一阶段 {index}",
                    f"下一阶段里程碑 {index}",
                    LearningDepth.PRACTICAL,
                )
                for index in range(1, 6)
            )
            next_skill = SkillNode("next-skill", "Next Skill")

            service.initialize_curriculum(
                profile,
                spine,
                (next_skill,),
                FrontierPlan(
                    focus_skill_id="next-skill",
                    reason="开始新的已确认目标",
                    target_depth=LearningDepth.PRACTICAL,
                    suggested_learning_mode="BUILD",
                    next_action="完成第一个迁移练习",
                ),
                replace_existing=True,
            )

            restored = store.load()
            self.assertIsNotNone(restored)
            assert restored is not None
            overview = restored.get_learning_overview()
            self.assertEqual(overview.current_goal, "独立完成下一个机器学习目标")
            self.assertEqual(len(overview.learning_history), 1)
            archived = overview.learning_history[0]
            self.assertEqual(archived.goal_profile.id, "gradient-for-deep-learning")
            self.assertEqual(archived.skill_ids, old_skill_ids)
            self.assertTrue(all(restored.get_skill(item).evidence_ids or restored.get_skill(item).status is SkillState.MASTERED_BY_USER for item in archived.skill_ids))

    def test_missing_store_uses_factory_once_then_auto_saves(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "learning-state.json"
            store = JsonLearningStateStore(path)
            calls = 0

            def factory():
                nonlocal calls
                calls += 1
                return build_gradient_demo_learning_service()

            service = store.load_or_create(factory)
            self.assertEqual(calls, 1)
            self.assertFalse(path.exists())

            service.reopen_skill_by_user("gradient-descent-update-rule")
            self.assertTrue(path.exists())

            store.load_or_create(factory)
            self.assertEqual(calls, 1)

    def test_pending_plan_revision_and_confirmed_successor_survive_restart(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "learning-state.json"
            store = JsonLearningStateStore(path)
            profile = GoalProfile("goal-plan", "学习旧版", "考试准备", "理解旧版")
            spine = tuple(
                CurriculumMilestone(
                    f"old-{index}", f"旧阶段{index}", f"旧阶段说明{index}",
                    LearningDepth.PRACTICAL,
                )
                for index in range(1, 6)
            )
            service = store.bind(LearningService(
                SkillGraph([SkillNode("old-skill", "旧版节点")]),
                current_goal=profile.goal_description,
                goal_profile=profile,
                curriculum_spine=spine,
                frontier=FrontierPlan(
                    "old-skill", "学习旧版", LearningDepth.PRACTICAL,
                    "EXPLAIN", "讲旧版",
                ),
                current_goal_skill_ids=("old-skill",),
            ))
            new_profile = GoalProfile("goal-plan", "学习新版", "考试准备", "只学新版")
            new_spine = tuple(
                CurriculumMilestone(
                    f"new-{index}", f"新版阶段{index}", f"新版阶段说明{index}",
                    LearningDepth.PRACTICAL,
                )
                for index in range(1, 6)
            )
            prepared = service.prepare_plan_revision(
                revision_id="revision-restart",
                goal_profile=new_profile,
                curriculum_spine=new_spine,
                added_skills=(SkillNode("new-skill", "新版节点"),),
                updated_skills=(),
                remove_skill_ids=("old-skill",),
                frontier=FrontierPlan(
                    "new-skill", "学习新版", LearningDepth.PRACTICAL,
                    "EXPLAIN", "讲新版",
                ),
                reason="考试只含新版",
            )
            restored = store.load()
            assert restored is not None
            self.assertEqual(restored.get_plan_revision(prepared.id).status, "PENDING")
            self.assertEqual(restored.snapshot().goal_profile.desired_outcome, "理解旧版")

            restored.decide_plan_revision(
                prepared.id,
                action="CONFIRM",
                feedback="",
                request_id="confirmed-after-restart",
            )
            final = store.load()
            assert final is not None
            self.assertEqual(final.snapshot().goal_profile.desired_outcome, "只学新版")
            self.assertEqual(final.current_plan_revision, 1)
            self.assertEqual(final.get_plan_revision(prepared.id).status, "CONFIRMED")

    def test_version_six_ledger_loads_without_losing_current_plan(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "learning-state.json"
            store = JsonLearningStateStore(path)
            service = store.bind(build_gradient_demo_learning_service())
            store.save(service)
            payload = json.loads(path.read_text(encoding="utf-8"))
            payload["version"] = 6
            payload.pop("plan_revisions", None)
            path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

            restored = store.load()
            assert restored is not None
            self.assertEqual(
                restored.snapshot().goal_profile.id,
                "gradient-for-deep-learning",
            )
            self.assertEqual(restored.current_plan_revision, 0)
            self.assertTrue(path.with_name("learning-state.json.v6.bak").exists())


if __name__ == "__main__":
    unittest.main()
