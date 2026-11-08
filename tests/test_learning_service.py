"""Phase 2 use-case tests through the LearningService interface."""

import unittest

from app.application import LearningService
from app.domain import (
    AssistanceLevel,
    CurriculumMilestone,
    Evidence,
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


def make_goal_profile(goal_id: str = "goal-vision") -> GoalProfile:
    return GoalProfile(
        id=goal_id,
        goal_description="系统学习目标检测",
        background_summary="研究生，有数学基础，做过 AI 辅助的 YOLO 项目",
        desired_outcome="独立理解、修改并完成 YOLO 检测项目",
        learning_preferences=("项目实践为主", "核心视觉原理适当深入"),
        time_constraint="每天 1～2 小时",
        prior_knowledge_claims=("学过 CNN", "做过 YOLO 项目"),
    )


def make_spine() -> tuple[CurriculumMilestone, ...]:
    names = (
        ("pytorch-vision", "PyTorch Vision Practice", LearningDepth.PRACTICAL),
        ("cnn", "CNN", LearningDepth.PRACTICAL),
        ("feature-hierarchy", "Feature Hierarchy", LearningDepth.PRACTICAL),
        ("object-detection", "Object Detection Foundations", LearningDepth.DEEP),
        ("detection-architecture", "Detection Architecture", LearningDepth.DEEP),
        ("yolo", "YOLO", LearningDepth.DEEP),
        ("detection-project", "Independent Detection Project", LearningDepth.PRACTICAL),
    )
    return tuple(
        CurriculumMilestone(id=milestone_id, name=name, description=name, target_depth=depth)
        for milestone_id, name, depth in names
    )


def make_frontier() -> FrontierPlan:
    return FrontierPlan(
        focus_skill_id="feature-map",
        supporting_skill_ids=("channel",),
        reason="已有训练经验，直接进入 CNN 空间特征",
        target_depth=LearningDepth.PRACTICAL,
        suggested_learning_mode="EXPLAIN",
        next_action="理解 feature map 与 channel",
    )


def make_evidence(evidence_id: str = "e-1", skill_id: str = "autograd") -> Evidence:
    return Evidence(
        id=evidence_id,
        skill_id=skill_id,
        evidence_type=EvidenceType.BUILD,
        description="Implemented backward without a template",
        assistance_level=AssistanceLevel.INDEPENDENT,
        source="practice note",
    )


def make_task(task_id: str = "task-1", skill_id: str = "autograd") -> LearningTask:
    return LearningTask(
        id=task_id,
        title="Build an autograd example",
        description="Explain and run backward without a template",
        related_skill_ids=(skill_id,),
        expected_evidence_types=(EvidenceType.BUILD,),
    )


def make_service(*, autograd_status: SkillState = SkillState.NOT_STARTED) -> LearningService:
    return LearningService(
        SkillGraph(
            [
                SkillNode("tensor", "Tensor"),
                SkillNode(
                    "autograd",
                    "Autograd",
                    prerequisites=("tensor",),
                    status=autograd_status,
                ),
            ]
        )
    )


class LearningServiceEvidenceTests(unittest.TestCase):
    def test_current_goal_evidence_requires_matching_active_task(self) -> None:
        service = LearningService(SkillGraph([]), current_goal=None)
        service.initialize_curriculum(
            make_goal_profile(),
            make_spine(),
            (SkillNode("first", "First"), SkillNode("second", "Second")),
            FrontierPlan(
                focus_skill_id="first",
                supporting_skill_ids=("second",),
                reason="Teach in order",
                target_depth=LearningDepth.PRACTICAL,
                suggested_learning_mode="EXPLAIN",
                next_action="Teach first, then second",
            ),
        )
        first_task = service.create_task(make_task("task-first", "first"))
        service.activate_task(first_task.id)

        with self.assertRaisesRegex(ValueError, "ACTIVE LearningTask"):
            service.submit_evidence(make_evidence("e-second", "second"))
        self.assertEqual(service.get_skill("second").evidence_ids, ())

        service.complete_task(first_task.id)
        with self.assertRaisesRegex(ValueError, "ACTIVE LearningTask"):
            service.submit_evidence(make_evidence("e-second", "second"))

        second_task = service.create_task(make_task("task-second", "second"))
        service.activate_task(second_task.id)
        updated = service.submit_evidence(make_evidence("e-second", "second"))
        self.assertEqual(updated.status, SkillState.LEARNING)
        self.assertEqual(updated.evidence_ids, ("e-second",))

    def test_learning_overview_returns_goal_focus_skills_and_recent_evidence(self) -> None:
        service = make_service()
        task = service.create_task(make_task())
        service.activate_task(task.id)
        first = make_evidence("e-1")
        second = make_evidence("e-2")
        service.submit_evidence(first)
        service.submit_evidence(second)

        overview = service.get_learning_overview(recent_evidence_limit=1)
        self.assertEqual(overview.current_goal, "Deep Learning")
        self.assertEqual(overview.current_focus.id, task.id)
        self.assertIs(overview.active_task, overview.current_focus)
        self.assertEqual(len(overview.skills), 2)
        self.assertEqual(overview.recent_evidence, (second,))
        self.assertEqual(service.get_learning_overview(0).recent_evidence, ())
        with self.assertRaises(ValueError):
            service.get_learning_overview(-1)

    def test_get_skill_returns_domain_object(self) -> None:
        service = make_service()
        self.assertIsInstance(service.get_skill("autograd"), SkillNode)
        with self.assertRaises(KeyError):
            service.get_skill("unknown")

    def test_submit_evidence_links_skill_and_preserves_its_state(self) -> None:
        service = make_service(autograd_status=SkillState.PRACTICING)
        original_skill = service.get_skill("autograd")
        evidence = make_evidence()
        updated = service.submit_evidence(evidence)
        self.assertIsNot(updated, original_skill)
        self.assertEqual(updated.evidence_ids, ("e-1",))
        self.assertEqual(original_skill.evidence_ids, ())
        self.assertEqual(updated.status, SkillState.PRACTICING)
        self.assertIs(service.get_skill("autograd"), updated)
        self.assertIs(service.get_evidence("e-1"), evidence)
        self.assertEqual(service.get_evidence_for_skill("autograd"), (evidence,))

    def test_evidence_ids_are_unique_and_missing_skill_is_rejected(self) -> None:
        service = make_service()
        service.submit_evidence(make_evidence())
        with self.assertRaisesRegex(ValueError, "Duplicate Evidence"):
            service.submit_evidence(make_evidence(skill_id="tensor"))
        with self.assertRaises(KeyError):
            service.submit_evidence(make_evidence("e-2", "missing"))
        self.assertEqual(service.get_skill("tensor").evidence_ids, ())
        self.assertEqual(service.get_skill("autograd").evidence_ids, ("e-1",))
        with self.assertRaises(KeyError):
            service.get_evidence("e-2")

    def test_evidence_for_skill_follows_link_order(self) -> None:
        service = make_service()
        first = make_evidence("e-1")
        second = make_evidence("e-2")
        service.submit_evidence(first)
        service.submit_evidence(second)
        self.assertEqual(service.get_evidence_for_skill("autograd"), (first, second))
        self.assertEqual(service.get_evidence_for_skill("tensor"), ())

    def test_dangling_evidence_reference_is_not_silently_ignored(self) -> None:
        service = LearningService(
            SkillGraph([SkillNode("autograd", "Autograd", evidence_ids=("missing",))])
        )
        with self.assertRaisesRegex(KeyError, "Unknown Evidence"):
            service.get_evidence_for_skill("autograd")


class LearningServiceTaskTests(unittest.TestCase):
    def test_new_tasks_are_single_skill_and_legacy_multi_skill_todo_cannot_start(self) -> None:
        service = make_service()
        multi = LearningTask(
            id="task-multi",
            title="Teach two skills",
            description="Only the first is ready for teaching",
            related_skill_ids=("tensor", "autograd"),
            expected_evidence_types=(EvidenceType.EXPLAIN,),
        )
        with self.assertRaisesRegex(ValueError, "exactly one Skill"):
            service.create_task(multi)
        self.assertEqual(service.get_skill("tensor").status, SkillState.NOT_STARTED)
        self.assertEqual(service.get_skill("autograd").status, SkillState.NOT_STARTED)

        legacy = LearningService(
            SkillGraph([SkillNode("tensor", "Tensor"), SkillNode("autograd", "Autograd")]),
            tasks=(multi,),
        )
        with self.assertRaisesRegex(ValueError, "legacy multi-Skill TODO"):
            legacy.activate_task(multi.id)
        self.assertEqual(legacy.get_task(multi.id).status, TaskStatus.TODO)
        self.assertEqual(legacy.get_skill("autograd").status, SkillState.NOT_STARTED)

    def test_create_rejects_duplicate_nonterminal_task_and_activation_stays_explicit(self) -> None:
        service = make_service()
        created = service.create_task(make_task())
        active = service.activate_task(created.id)

        self.assertEqual(active.status, TaskStatus.ACTIVE)
        self.assertIs(service.get_current_focus(), active)

        with self.assertRaisesRegex(ValueError, "Duplicate current LearningTask"):
            service.create_task(make_task("task-2"))

        padded_duplicate = LearningTask(
            id="task-2b",
            title="  BUILD AN AUTOGRAD EXAMPLE  ",
            description="Same task with presentation-only title differences",
            related_skill_ids=("autograd",),
            expected_evidence_types=(EvidenceType.BUILD,),
        )
        with self.assertRaisesRegex(ValueError, "Duplicate current LearningTask"):
            service.create_task(padded_duplicate)

        different = LearningTask(
            id="task-3",
            title="Debug an autograd example",
            description="Find and explain a broken backward pass",
            related_skill_ids=("autograd",),
            expected_evidence_types=(EvidenceType.DEBUG,),
        )
        todo = service.create_task(different)
        self.assertEqual(todo.status, TaskStatus.TODO)
        with self.assertRaisesRegex(ValueError, "already ACTIVE"):
            service.activate_task(todo.id)

        self.assertEqual(service.get_all_tasks(), (active, todo))

    def test_create_task_validates_skills_and_does_not_activate(self) -> None:
        service = make_service()
        task = make_task()
        self.assertIs(service.create_task(task), task)
        self.assertIs(service.get_task(task.id), task)
        self.assertEqual(service.get_all_tasks(), (task,))
        self.assertIsNone(service.get_active_task())
        self.assertIsNone(service.get_current_focus())

    def test_rejects_duplicate_task_missing_skill_and_non_todo_creation(self) -> None:
        service = make_service()
        service.create_task(make_task())
        with self.assertRaisesRegex(ValueError, "Duplicate LearningTask"):
            service.create_task(make_task())
        with self.assertRaises(KeyError):
            service.create_task(make_task("task-2", "missing"))
        multi_skill_task = LearningTask(
            id="task-2",
            title="Connect concepts",
            description="Use Tensor and an unknown concept together",
            related_skill_ids=("tensor", "missing"),
            expected_evidence_types=(),
        )
        with self.assertRaises(KeyError):
            service.create_task(multi_skill_task)
        with self.assertRaisesRegex(ValueError, "must be TODO"):
            service.create_task(make_task("task-3").activate())
        self.assertEqual(len(service.get_all_tasks()), 1)

    def test_activate_complete_and_skip_call_domain_lifecycle(self) -> None:
        service = make_service()
        todo = service.create_task(make_task())
        active = service.activate_task(todo.id)
        self.assertEqual(todo.status, TaskStatus.TODO)
        self.assertEqual(active.status, TaskStatus.ACTIVE)
        self.assertIs(service.get_active_task(), active)
        self.assertIs(service.get_current_focus(), active)
        done = service.complete_task(todo.id)
        self.assertEqual(done.status, TaskStatus.DONE)
        self.assertIsNone(service.get_current_focus())

        service.create_task(make_task("task-2"))
        self.assertEqual(service.skip_task("task-2").status, TaskStatus.SKIPPED)
        service.create_task(make_task("task-3"))
        service.activate_task("task-3")
        self.assertEqual(service.skip_task("task-3").status, TaskStatus.SKIPPED)
        self.assertIsNone(service.get_active_task())

    def test_illegal_task_transitions_are_rejected(self) -> None:
        service = make_service()
        service.create_task(make_task())
        with self.assertRaises(ValueError):
            service.complete_task("task-1")
        service.activate_task("task-1")
        with self.assertRaises(ValueError):
            service.activate_task("task-1")
        service.complete_task("task-1")
        with self.assertRaises(ValueError):
            service.skip_task("task-1")
        with self.assertRaises(KeyError):
            service.get_task("missing")

    def test_second_active_task_is_rejected_without_ending_first(self) -> None:
        service = make_service()
        first = service.create_task(make_task("task-1"))
        second = service.create_task(
            LearningTask(
                id="task-2",
                title="Debug an autograd example",
                description="Find and explain a broken backward pass",
                related_skill_ids=("autograd",),
                expected_evidence_types=(EvidenceType.DEBUG,),
            )
        )
        active = service.activate_task(first.id)
        with self.assertRaisesRegex(ValueError, "already ACTIVE"):
            service.activate_task(second.id)
        self.assertIs(service.get_active_task(), active)
        self.assertEqual(service.get_task(second.id).status, TaskStatus.TODO)


class LearningServiceSkillStateTests(unittest.TestCase):
    def test_user_confirmation_and_reopen(self) -> None:
        service = make_service(autograd_status=SkillState.PRACTICING)
        mastered = service.confirm_mastery_by_user("autograd")
        self.assertEqual(mastered.status, SkillState.MASTERED_BY_USER)
        self.assertIs(service.get_skill("autograd"), mastered)
        reopened = service.reopen_skill_by_user("autograd")
        self.assertEqual(reopened.status, SkillState.PRACTICING)
        self.assertIs(service.get_skill("autograd"), reopened)

    def test_user_can_confirm_mastery_directly_from_learning(self) -> None:
        service = make_service(autograd_status=SkillState.LEARNING)
        mastered = service.confirm_mastery_by_user("autograd")
        self.assertEqual(mastered.status, SkillState.MASTERED_BY_USER)

    def test_mastery_still_rejects_not_started_and_mastered_states(self) -> None:
        not_started = make_service()
        with self.assertRaises(ValueError):
            not_started.confirm_mastery_by_user("autograd")

        mastered = make_service(autograd_status=SkillState.PRACTICING)
        mastered.confirm_mastery_by_user("autograd")
        with self.assertRaises(ValueError):
            mastered.confirm_mastery_by_user("autograd")

        service = make_service(autograd_status=SkillState.LEARNING)
        with self.assertRaises(ValueError):
            service.reopen_skill_by_user("autograd")

    def test_next_task_can_activate_without_mastering_previous_skill(self) -> None:
        service = make_service()
        first = service.create_task(make_task("task-first", "autograd"))
        second = service.create_task(make_task("task-next", "tensor"))

        service.activate_task(first.id)
        service.complete_task(first.id)
        active = service.activate_task(second.id)

        self.assertEqual(service.get_skill("autograd").status, SkillState.LEARNING)
        self.assertEqual(active.status, TaskStatus.ACTIVE)

    def test_return_to_learning_uses_domain_rule(self) -> None:
        service = make_service(autograd_status=SkillState.PRACTICING)
        original = service.get_skill("autograd")
        learning = service.return_skill_to_learning("autograd")
        self.assertIsNot(learning, original)
        self.assertEqual(learning.status, SkillState.LEARNING)
        self.assertEqual(original.status, SkillState.PRACTICING)
        with self.assertRaises(ValueError):
            service.return_skill_to_learning("autograd")


class LearningServiceEndToEndTests(unittest.TestCase):
    def test_task_evidence_focus_business_loop(self) -> None:
        service = make_service(autograd_status=SkillState.PRACTICING)
        task = service.create_task(make_task())
        service.activate_task(task.id)
        self.assertEqual(service.get_current_focus().id, task.id)
        evidence = make_evidence()
        service.submit_evidence(evidence)
        self.assertEqual(service.get_evidence_for_skill("autograd"), (evidence,))
        service.complete_task(task.id)
        self.assertIsNone(service.get_current_focus())
        self.assertEqual(service.get_skill("autograd").status, SkillState.PRACTICING)


class LearningServiceCurriculumTests(unittest.TestCase):
    def test_empty_service_enters_onboarding_and_initializes_a_coarse_curriculum(self) -> None:
        service = LearningService(SkillGraph([]), current_goal=None)
        self.assertIsNone(service.get_learning_overview().current_goal)

        profile = make_goal_profile()
        skills = (
            SkillNode(
                "feature-map",
                "Feature Map",
                target_depth=LearningDepth.PRACTICAL,
            ),
            SkillNode(
                "channel",
                "Channel",
                prerequisites=("feature-map",),
                target_depth=LearningDepth.PRACTICAL,
            ),
        )
        plan = service.initialize_curriculum(profile, make_spine(), skills, make_frontier())

        self.assertEqual(plan.goal_profile, profile)
        self.assertEqual(len(plan.curriculum_spine), 7)
        self.assertEqual(plan.frontier.focus_skill_id, "feature-map")
        self.assertEqual(service.get_skill("feature-map").status, SkillState.NOT_STARTED)
        self.assertEqual(
            service.get_skill("feature-map").target_depth,
            LearningDepth.PRACTICAL,
        )
        self.assertEqual(service.get_learning_overview().recent_evidence, ())

    def test_curriculum_spine_must_remain_coarse(self) -> None:
        service = LearningService(SkillGraph([]), current_goal=None)
        with self.assertRaisesRegex(ValueError, "5 to 8"):
            service.initialize_curriculum(
                make_goal_profile(),
                make_spine()[:4],
                (SkillNode("cnn", "CNN"),),
                FrontierPlan(
                    focus_skill_id="cnn",
                    reason="start",
                    target_depth=LearningDepth.PRACTICAL,
                    suggested_learning_mode="EXPLAIN",
                    next_action="start cnn",
                ),
            )

    def test_prior_knowledge_claim_never_creates_evidence_or_mastery(self) -> None:
        service = LearningService(SkillGraph([]), current_goal=None)
        service.initialize_curriculum(
            make_goal_profile(),
            make_spine(),
            (SkillNode("cnn", "CNN", target_depth=LearningDepth.DEEP),),
            FrontierPlan(
                focus_skill_id="cnn",
                reason="先做较高难度 diagnostic",
                target_depth=LearningDepth.DEEP,
                suggested_learning_mode="QUIZ",
                next_action="CNN diagnostic",
            ),
        )

        cnn = service.get_skill("cnn")
        self.assertEqual(cnn.status, SkillState.NOT_STARTED)
        self.assertEqual(cnn.evidence_ids, ())
        self.assertEqual(service.get_learning_overview().recent_evidence, ())

    def test_frontier_revision_can_change_future_skill_but_protects_learning_history(self) -> None:
        service = LearningService(SkillGraph([]), current_goal=None)
        service.initialize_curriculum(
            make_goal_profile(),
            make_spine(),
            (
                SkillNode("cnn", "CNN", target_depth=LearningDepth.PRACTICAL),
                SkillNode(
                    "object-detection",
                    "Object Detection",
                    prerequisites=("cnn",),
                    target_depth=LearningDepth.PRACTICAL,
                ),
            ),
            FrontierPlan(
                focus_skill_id="cnn",
                reason="start cnn",
                target_depth=LearningDepth.PRACTICAL,
                suggested_learning_mode="EXPLAIN",
                next_action="cnn concepts",
            ),
        )
        service.change_future_skill_depth("object-detection", LearningDepth.DEEP)
        self.assertEqual(
            service.get_skill("object-detection").target_depth,
            LearningDepth.DEEP,
        )

        task = service.create_task(make_task("task-cnn", "cnn"))
        service.activate_task(task.id)
        service.submit_evidence(make_evidence("e-cnn", "cnn"))
        with self.assertRaisesRegex(ValueError, "learning history"):
            service.change_future_skill_depth("cnn", LearningDepth.DEEP)
        self.assertEqual(service.get_skill("cnn").id, "cnn")
        self.assertEqual(service.get_skill("cnn").evidence_ids, ("e-cnn",))

    def test_structured_frontier_revision_changes_only_future_curriculum(self) -> None:
        service = LearningService(SkillGraph([]), current_goal=None)
        service.initialize_curriculum(
            make_goal_profile(),
            make_spine(),
            (
                SkillNode("cnn", "CNN"),
                SkillNode("feature-map", "Feature Map", prerequisites=("cnn",)),
                SkillNode("obsolete-future", "Obsolete Future Topic"),
            ),
            FrontierPlan(
                focus_skill_id="feature-map",
                reason="start with spatial features",
                target_depth=LearningDepth.PRACTICAL,
                suggested_learning_mode="QUIZ",
                next_action="feature map diagnostic",
            ),
        )

        revised = service.apply_frontier_plan(
            FrontierPlan(
                focus_skill_id="receptive-field",
                supporting_skill_ids=("feature-map",),
                reason="feature map is clear; expand the current frontier",
                target_depth=LearningDepth.DEEP,
                suggested_learning_mode="BUILD",
                next_action="build a receptive-field experiment",
            ),
            added_skills=(
                SkillNode(
                    "receptive-field",
                    "Receptive Field",
                    prerequisites=("feature-map",),
                    target_depth=LearningDepth.DEEP,
                ),
            ),
            depth_changes=(("feature-map", LearningDepth.DEEP),),
            prerequisite_additions=(("feature-map", "cnn"),),
            remove_skill_ids=("obsolete-future",),
        )

        self.assertEqual(revised.focus_skill_id, "receptive-field")
        self.assertEqual(service.get_skill("feature-map").target_depth, LearningDepth.DEEP)
        self.assertEqual(service.get_skill("receptive-field").prerequisites, ("feature-map",))
        with self.assertRaisesRegex(KeyError, "obsolete-future"):
            service.get_skill("obsolete-future")

    def test_frontier_revision_is_atomic_and_never_rewrites_learning_history(self) -> None:
        service = LearningService(SkillGraph([]), current_goal=None)
        service.initialize_curriculum(
            make_goal_profile(),
            make_spine(),
            (SkillNode("cnn", "CNN"), SkillNode("future", "Future Topic")),
            FrontierPlan(
                focus_skill_id="cnn",
                reason="start",
                target_depth=LearningDepth.PRACTICAL,
                suggested_learning_mode="EXPLAIN",
                next_action="cnn diagnostic",
            ),
        )
        task = service.create_task(make_task("task-cnn", "cnn"))
        service.activate_task(task.id)
        service.submit_evidence(make_evidence("e-cnn", "cnn"))
        before = service.get_learning_overview()

        with self.assertRaisesRegex(ValueError, "learning history"):
            service.apply_frontier_plan(
                FrontierPlan(
                    focus_skill_id="future",
                    reason="invalid rewrite",
                    target_depth=LearningDepth.DEEP,
                    suggested_learning_mode="QUIZ",
                    next_action="future",
                ),
                depth_changes=(("cnn", LearningDepth.DEEP),),
            )

        after = service.get_learning_overview()
        self.assertEqual(after.current_frontier, before.current_frontier)
        self.assertEqual(service.get_skill("cnn").evidence_ids, ("e-cnn",))
        self.assertEqual(service.get_skill("cnn").target_depth, LearningDepth.PRACTICAL)

    def test_replacing_goal_requires_explicit_confirmation_and_preserves_evidence(self) -> None:
        service = LearningService(SkillGraph([]), current_goal=None)
        service.initialize_curriculum(
            make_goal_profile(),
            make_spine(),
            (SkillNode("cnn", "CNN"),),
            FrontierPlan(
                focus_skill_id="cnn",
                reason="start",
                target_depth=LearningDepth.PRACTICAL,
                suggested_learning_mode="EXPLAIN",
                next_action="learn cnn",
            ),
        )
        task = service.create_task(make_task("task-cnn", "cnn"))
        service.activate_task(task.id)
        service.submit_evidence(make_evidence("e-cnn", "cnn"))
        service.complete_task(task.id)

        with self.assertRaisesRegex(ValueError, "already exists"):
            service.initialize_curriculum(
                make_goal_profile("goal-segmentation"),
                make_spine(),
                (SkillNode("segmentation", "Image Segmentation"),),
                FrontierPlan(
                    focus_skill_id="segmentation",
                    reason="new goal",
                    target_depth=LearningDepth.PRACTICAL,
                    suggested_learning_mode="EXPLAIN",
                    next_action="learn segmentation",
                ),
            )

        service.initialize_curriculum(
            make_goal_profile("goal-segmentation"),
            make_spine(),
            (SkillNode("segmentation", "Image Segmentation"),),
            FrontierPlan(
                focus_skill_id="segmentation",
                reason="confirmed major goal change",
                target_depth=LearningDepth.PRACTICAL,
                suggested_learning_mode="EXPLAIN",
                next_action="learn segmentation",
            ),
            replace_existing=True,
        )
        self.assertEqual(service.get_evidence("e-cnn").skill_id, "cnn")
        self.assertEqual(service.get_skill("cnn").evidence_ids, ("e-cnn",))
        self.assertEqual(service.get_learning_overview().current_goal, "系统学习目标检测")


if __name__ == "__main__":
    unittest.main()
