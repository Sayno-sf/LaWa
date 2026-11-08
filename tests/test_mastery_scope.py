"""A teacher invitation never makes an old user confirmation valid in a new task."""

import unittest

from fastapi.testclient import TestClient

from app.api.main import app, get_learning_service
from app.application import LearningService
from app.domain import GoalProfile, LearningTask, SkillGraph, SkillNode, SkillState, TaskStatus


def classroom() -> LearningService:
    return LearningService(
        SkillGraph([SkillNode("skill", "Current", status=SkillState.LEARNING),
                    SkillNode("other", "Other", status=SkillState.LEARNING)]),
        current_goal="Current goal", goal_profile=GoalProfile("goal", "Current goal", "background", "outcome"),
        tasks=(LearningTask("task", "Current task", "Practice", ("skill",), (), TaskStatus.ACTIVE, "goal"),),
    )


class MasteryScopeServiceTests(unittest.TestCase):
    def test_current_scoped_confirmation_saves_mastery_without_completing_an_ordinary_task(self):
        service = classroom()
        saved = []
        service.enable_auto_save(lambda current: saved.append(current.snapshot()))
        skill = service.confirm_mastery_by_user("skill", expected_goal_id="goal", expected_task_id="task")
        self.assertIs(skill.status, SkillState.MASTERED_BY_USER)
        self.assertIs(service.get_active_task().status, TaskStatus.ACTIVE)
        self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0], service.snapshot())

    def test_stale_or_unrelated_scope_cannot_mutate_any_learning_fact(self):
        for skill_id, goal_id, task_id in [("skill", "old-goal", "task"),
                                           ("skill", "goal", "old-task"),
                                           ("other", "goal", "task")]:
            with self.subTest(skill=skill_id, goal=goal_id, task=task_id):
                service = classroom()
                saved = []
                service.enable_auto_save(lambda current: saved.append(current.snapshot()))
                before = service.snapshot()
                with self.assertRaises(ValueError):
                    service.confirm_mastery_by_user(skill_id, expected_goal_id=goal_id, expected_task_id=task_id)
                self.assertEqual(service.snapshot(), before)
                self.assertEqual(saved, [])

    def test_partial_or_blank_scope_is_rejected_before_any_write(self):
        for scope in [{"expected_goal_id": "goal"}, {"expected_task_id": "task"},
                      {"expected_goal_id": " ", "expected_task_id": "task"}]:
            with self.subTest(scope=scope):
                service = classroom()
                before = service.snapshot()
                with self.assertRaises(ValueError):
                    service.confirm_mastery_by_user("skill", **scope)
                self.assertEqual(service.snapshot(), before)

    def test_completed_task_cannot_accept_its_old_invitation(self):
        service = classroom()
        service.complete_task("task")
        before = service.snapshot()
        with self.assertRaises(ValueError):
            service.confirm_mastery_by_user("skill", expected_goal_id="goal", expected_task_id="task")
        self.assertEqual(service.snapshot(), before)

    def test_legacy_manual_confirmation_and_duplicate_domain_guard_are_preserved(self):
        service = classroom()
        # Manual user controls still allow a learned Skill other than the current task.
        self.assertIs(service.confirm_mastery_by_user("other").status, SkillState.MASTERED_BY_USER)
        before = service.snapshot()
        with self.assertRaises(ValueError):
            service.confirm_mastery_by_user("other")
        self.assertEqual(service.snapshot(), before)

    def test_scoped_review_confirmation_saves_mastery_and_parent_resumption_together(self):
        service = classroom()
        service.confirm_mastery_by_user("other")
        review = service.start_review_by_user("other", "scope-review-001")
        saved = []
        service.enable_auto_save(lambda current: saved.append(current.snapshot()))
        service.confirm_mastery_by_user("other", expected_goal_id="goal", expected_task_id=review.id)
        self.assertIs(service.get_skill("other").status, SkillState.MASTERED_BY_USER)
        self.assertIs(service.get_task(review.id).status, TaskStatus.DONE)
        self.assertEqual(service.get_active_task().id, "task")
        self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0], service.snapshot())


class MasteryScopeApiTests(unittest.TestCase):
    def setUp(self):
        self.service = classroom()
        app.dependency_overrides[get_learning_service] = lambda: self.service
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        app.dependency_overrides.clear()

    def test_optional_body_keeps_manual_user_route_compatible(self):
        response = self.client.post("/api/user/skills/skill/confirm-mastery")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "MASTERED_BY_USER")

    def test_scoped_body_rejects_changed_task_and_keeps_original_state(self):
        before = self.service.snapshot()
        response = self.client.post("/api/user/skills/skill/confirm-mastery",
                                    json={"expected_goal_id": "goal", "expected_task_id": "old-task"})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.service.snapshot(), before)

    def test_scoped_body_accepts_current_task(self):
        response = self.client.post("/api/user/skills/skill/confirm-mastery",
                                    json={"expected_goal_id": "goal", "expected_task_id": "task"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "MASTERED_BY_USER")

    def test_malformed_scope_requires_both_identifiers(self):
        before = self.service.snapshot()
        for body in [{"expected_goal_id": "goal"}, {"expected_task_id": "task"},
                     {"expected_goal_id": "", "expected_task_id": "task"}]:
            with self.subTest(body=body):
                response = self.client.post("/api/user/skills/skill/confirm-mastery", json=body)
                self.assertEqual(response.status_code, 422)
        self.assertEqual(self.service.snapshot(), before)
