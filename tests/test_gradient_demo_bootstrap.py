"""Regression coverage for the synthetic gradient demo."""

import unittest

from app.bootstrap import GRADIENT_DEMO_GOAL, build_gradient_demo_learning_service, build_learning_service
from app.domain import SkillState, TaskStatus


class GradientDemoBootstrapTests(unittest.TestCase):
    def test_gradient_demo_is_available_only_through_an_explicit_mode(self) -> None:
        self.assertIsNone(build_learning_service(None).get_learning_overview().current_goal)
        self.assertEqual(
            build_learning_service("gradient-demo").get_learning_overview().goal_profile.id,
            "gradient-for-deep-learning",
        )

    def test_gradient_demo_seeds_the_finished_course(self) -> None:
        service = build_gradient_demo_learning_service()
        overview = service.get_learning_overview()

        self.assertEqual(
            overview.current_goal,
            GRADIENT_DEMO_GOAL,
        )
        self.assertEqual(overview.goal_profile.id, "gradient-for-deep-learning")
        self.assertEqual(len(overview.curriculum_spine), 7)
        self.assertEqual(len(overview.skills), 6)
        self.assertEqual(
            overview.current_frontier.focus_skill_id,
            "contour-lines-and-gradient-geometry",
        )
        self.assertEqual(
            service.get_skill("partial-derivative-recall").status,
            SkillState.MASTERED_BY_USER,
        )
        self.assertEqual(
            service.get_skill("direction-derivative-and-gradient").status,
            SkillState.MASTERED_BY_USER,
        )
        self.assertEqual(
            service.get_skill("direction-derivative-and-gradient").evidence_ids,
            ("demo-gradient-evidence-01",),
        )
        self.assertEqual(
            service.get_skill("gradient-descent-update-rule").status,
            SkillState.MASTERED_BY_USER,
        )
        self.assertEqual(
            service.get_skill("gradient-descent-update-rule").evidence_ids,
            (
                "demo-gradient-evidence-02",
                "demo-gradient-evidence-03",
                "demo-gradient-evidence-07",
            ),
        )
        self.assertEqual(
            service.get_skill("learning-rate-and-optimization-pitfalls").status,
            SkillState.MASTERED_BY_USER,
        )
        self.assertEqual(
            service.get_skill("learning-rate-and-optimization-pitfalls").evidence_ids,
            (
                "demo-gradient-evidence-04",
                "demo-gradient-evidence-05",
                "demo-gradient-evidence-06",
            ),
        )
        self.assertEqual(
            service.get_skill("contour-lines-and-gradient-geometry").status,
            SkillState.MASTERED_BY_USER,
        )
        self.assertEqual(
            service.get_skill("contour-lines-and-gradient-geometry").evidence_ids,
            (
                "demo-gradient-evidence-08",
                "demo-gradient-evidence-10",
            ),
        )
        self.assertEqual(
            service.get_skill("loss-landscape-in-parameter-space").status,
            SkillState.MASTERED_BY_USER,
        )
        self.assertEqual(
            service.get_skill("loss-landscape-in-parameter-space").evidence_ids,
            ("demo-gradient-evidence-09",),
        )
        self.assertEqual(
            service.get_task("demo-gradient-task-direction").status,
            TaskStatus.DONE,
        )
        self.assertEqual(
            service.get_task("demo-gradient-task-step").status,
            TaskStatus.DONE,
        )
        self.assertIsNone(overview.active_task)
        self.assertEqual(
            tuple(item.id for item in overview.recent_evidence),
            (
                "demo-gradient-evidence-10",
                "demo-gradient-evidence-09",
                "demo-gradient-evidence-08",
                "demo-gradient-evidence-07",
                "demo-gradient-evidence-06",
            ),
        )


if __name__ == "__main__":
    unittest.main()
