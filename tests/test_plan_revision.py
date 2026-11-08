from dataclasses import replace
import unittest

from app.application import LearningService
from app.domain import (
    CurriculumMilestone,
    FrontierPlan,
    GoalProfile,
    LearningDepth,
    SkillGraph,
    SkillNode,
    SkillState,
)


def profile(outcome: str = "理解旧版") -> GoalProfile:
    return GoalProfile(
        "goal-plan",
        f"学习目标：{outcome}",
        "考试准备",
        outcome,
    )


def spine(label: str = "旧版流程") -> tuple[CurriculumMilestone, ...]:
    return tuple(
        CurriculumMilestone(
            f"stage-{index}",
            f"{label}{index}",
            f"{label}阶段 {index}",
            LearningDepth.PRACTICAL,
        )
        for index in range(1, 6)
    )


def frontier(skill_id: str = "old-skill") -> FrontierPlan:
    return FrontierPlan(
        skill_id,
        "从当前节点开始",
        LearningDepth.PRACTICAL,
        "EXPLAIN",
        "说明当前节点",
    )


class PlanRevisionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.service = LearningService(
            SkillGraph(
                [
                    SkillNode("old-skill", "旧版流程"),
                    SkillNode("support", "后续节点", prerequisites=("old-skill",)),
                ]
            ),
            current_goal="学习目标：理解旧版",
            goal_profile=profile(),
            curriculum_spine=spine(),
            frontier=frontier(),
            current_goal_skill_ids=("old-skill", "support"),
        )

    def test_confirmed_revision_atomically_updates_all_plan_layers(self) -> None:
        revision = self.service.prepare_plan_revision(
            curriculum_spine=spine("新版流程"),
            added_skills=(
                SkillNode("new-skill", "新版流程"),
                SkillNode("new-support", "后续节点", prerequisites=("new-skill",)),
            ),
            updated_skills=(),
            remove_skill_ids=("old-skill", "support"),
            frontier=frontier("new-skill"),
            goal_profile=profile("只学新版"),
            reason="用户确认考试范围只含新版",
        )

        self.assertEqual(revision.status, "PENDING")
        self.assertEqual(self.service.snapshot().goal_profile.desired_outcome, "理解旧版")
        self.assertEqual(self.service.current_plan_revision, 0)

        decided = self.service.decide_plan_revision(
            revision.id,
            action="CONFIRM",
            feedback="",
            request_id="confirm-request",
        )

        self.assertEqual(decided.status, "CONFIRMED")
        snapshot = self.service.snapshot()
        self.assertEqual(snapshot.goal_profile.desired_outcome, "只学新版")
        self.assertEqual(snapshot.curriculum_spine, spine("新版流程"))
        self.assertEqual(snapshot.current_goal_skill_ids, ("new-skill", "new-support"))
        self.assertEqual(snapshot.frontier.focus_skill_id, "new-skill")
        self.assertEqual(self.service.current_plan_revision, 1)
        self.assertEqual(self.service.get_plan_revision(revision.id).base_revision, 0)

        # A lost confirmation response is retryable without a second revision.
        repeated = self.service.decide_plan_revision(
            revision.id,
            action="CONFIRM",
            feedback="",
            request_id="confirm-request",
        )
        self.assertEqual(repeated, decided)
        self.assertEqual(self.service.current_plan_revision, 1)

    def test_revision_rejects_stale_plan_or_changes_to_learning_history(self) -> None:
        revision = self.service.prepare_plan_revision(
            curriculum_spine=spine("新版流程"),
            added_skills=(SkillNode("new-skill", "新版流程"),),
            updated_skills=(),
            remove_skill_ids=("old-skill", "support"),
            frontier=frontier("new-skill"),
            goal_profile=profile("只学新版"),
            reason="用户确认考试范围只含新版",
        )
        with self.assertRaisesRegex(ValueError, "plan revision is pending"):
            self.service.apply_frontier_plan(
                replace(frontier(), next_action="绕过完整修订"),
                added_skills=(),
                depth_changes=(),
                prerequisite_additions=(),
                remove_skill_ids=(),
            )
        self.service.update_frontier(replace(frontier(), next_action="继续旧节点"))
        with self.assertRaisesRegex(ValueError, "changed"):
            self.service.decide_plan_revision(
                revision.id,
                action="CONFIRM",
                feedback="",
                request_id="stale-request",
            )

        self.service = LearningService(
            SkillGraph([SkillNode("learned", "已学习", status=SkillState.LEARNING)]),
            current_goal="学习目标：保留历史",
            goal_profile=profile("保留历史"),
            curriculum_spine=spine(),
            frontier=frontier("learned"),
            current_goal_skill_ids=("learned",),
        )
        with self.assertRaisesRegex(ValueError, "learning history"):
            self.service.prepare_plan_revision(
                curriculum_spine=spine("新计划"),
                added_skills=(SkillNode("replacement", "替代节点"),),
                updated_skills=(SkillNode("learned", "试图改名的已学习节点"),),
                remove_skill_ids=(),
                frontier=frontier("learned"),
                goal_profile=profile("保留历史"),
                reason="尝试绕过学习历史",
            )

    def test_rejected_revision_keeps_the_current_plan(self) -> None:
        original = self.service.snapshot()
        original_plan = (
            original.goal_profile,
            original.curriculum_spine,
            original.frontier,
            original.skills,
            original.current_goal_skill_ids,
        )
        revision = self.service.prepare_plan_revision(
            curriculum_spine=spine("新版流程"),
            added_skills=(SkillNode("new-skill", "新版流程"),),
            updated_skills=(),
            remove_skill_ids=("old-skill", "support"),
            frontier=frontier("new-skill"),
            goal_profile=profile("只学新版"),
            reason="用户可能调整",
        )
        self.service.decide_plan_revision(
            revision.id,
            action="REJECT",
            feedback="先保持原路线",
            request_id="reject-request",
        )
        current = self.service.snapshot()
        self.assertEqual(
            (
                current.goal_profile,
                current.curriculum_spine,
                current.frontier,
                current.skills,
                current.current_goal_skill_ids,
            ),
            original_plan,
        )
        self.assertEqual(self.service.current_plan_revision, 0)

    def test_new_pending_revision_supersedes_the_old_candidate(self) -> None:
        first = self.service.prepare_plan_revision(
            revision_id="revision-first",
            curriculum_spine=spine("第一版"),
            added_skills=(SkillNode("new-skill", "第一版新版"),),
            updated_skills=(),
            remove_skill_ids=("old-skill", "support"),
            frontier=frontier("new-skill"),
            goal_profile=profile("第一版目标"),
            reason="第一次修订",
        )
        second = self.service.prepare_plan_revision(
            revision_id="revision-second",
            curriculum_spine=spine("第二版"),
            added_skills=(SkillNode("new-skill", "第二版新版"),),
            updated_skills=(),
            remove_skill_ids=("old-skill", "support"),
            frontier=frontier("new-skill"),
            goal_profile=profile("第二版目标"),
            reason="用户补充后再次修订",
        )
        self.assertEqual(self.service.get_plan_revision(first.id).status, "SUPERSEDED")
        self.assertEqual(self.service.get_plan_revision(second.id).status, "PENDING")

    def test_failed_save_rolls_back_whole_plan_and_decision(self) -> None:
        revision = self.service.prepare_plan_revision(
            revision_id="revision-save-failure",
            curriculum_spine=spine("新版流程"),
            added_skills=(SkillNode("new-skill", "新版流程"),),
            updated_skills=(),
            remove_skill_ids=("old-skill", "support"),
            frontier=frontier("new-skill"),
            goal_profile=profile("只学新版"),
            reason="保存失败回滚",
        )
        before = self.service.snapshot()

        def fail(_service: LearningService) -> None:
            raise OSError("disk full")

        self.service.enable_auto_save(fail)
        with self.assertRaisesRegex(OSError, "disk full"):
            self.service.decide_plan_revision(
                revision.id,
                action="CONFIRM",
                feedback="",
                request_id="save-failure",
            )
        self.assertEqual(self.service.snapshot(), before)
        self.assertEqual(self.service.get_plan_revision(revision.id).status, "PENDING")


if __name__ == "__main__":
    unittest.main()
