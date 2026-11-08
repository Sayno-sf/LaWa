"""Closure cards read current Kernel facts, never a teacher's completion claim."""

from dataclasses import asdict, replace
import unittest

from fastapi.testclient import TestClient
from app.api.main import app, get_learning_service
from app.application import LearningService
from app.domain import GoalProfile, LearningTask, SkillGraph, SkillNode, SkillState, TaskStatus
from app.domain.evidence import AssistanceLevel, Evidence, EvidenceType
from app.domain.planning import CurriculumMilestone, LearningDepth
from app.domain.teaching_evolution import TeachingProposal
from tests.test_answer_assessment import assessment


def route_fixture(covered=3, *, missing_score=2, empty_stage=False):
    skills = tuple(SkillNode(f"s{i}", f"节点{i}", status=SkillState.LEARNING,
        evidence_ids=(f"e{i}",) if i <= covered else ()) for i in range(1, 7))
    evidence = tuple(Evidence(f"e{i}", f"s{i}", EvidenceType.EXPLAIN,
        "实际作答", AssistanceLevel.WITH_HELP if i == 1 else AssistanceLevel.INDEPENDENT,
        f"session/turn-{i}") for i in range(1, covered + 1))
    tasks = tuple(LearningTask(f"t{i}", f"任务{i}", "解释并作答", (f"s{i}",), (),
        status=TaskStatus.DONE if i <= covered else TaskStatus.TODO, goal_id="goal") for i in range(1, 7))
    scores = tuple(replace(assessment(i, skill=f"s{i}", task=f"t{i}", score=10),
        question=f"第{i}题", question_entry_id=f"q{i}") for i in range(1, covered + 1) if i != missing_score)
    spine = tuple(CurriculumMilestone(f"m{i}", f"阶段{i}", "真实路线阶段", LearningDepth.PRACTICAL,
        () if empty_stage and i == 6 else (f"s{i}",)) for i in range(1, 7))
    return LearningService(SkillGraph(skills), current_goal="六阶段目标",
        goal_profile=GoalProfile("goal", "六阶段目标", "初学", "逐项学习"),
        current_goal_skill_ids=tuple(s.id for s in skills), curriculum_spine=spine,
        tasks=tasks, evidence=evidence, answer_assessments=scores)


class GoalClosureCoverageTests(unittest.TestCase):
    def setUp(self):
        self.service = route_fixture()
        app.dependency_overrides[get_learning_service] = lambda: self.service
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()

    def propose(self):
        p = TeachingProposal("close", "goal", "CLOSURE", "六阶段全部学完并掌握", "综合题提到后续概念", "GOAL", "", ("assessment-3",))
        body = asdict(p)
        for key in ("status", "feedback", "created_at", "goal_signature"):
            body.pop(key)
        response = self.client.post("/api/learning/teaching/proposals", json=body)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_three_actual_nodes_cannot_make_six_node_closure_claim(self):
        before = self.service.snapshot()
        proposed = self.propose()
        report = proposed["closure_progress"]
        self.assertEqual(report["milestone_count"], 6)
        self.assertEqual(report["covered_milestone_count"], 3)
        self.assertEqual(report["uncovered_milestone_ids"], ["m4", "m5", "m6"])
        self.assertEqual(report["unscored_skill_ids"], ["s2", "s4", "s5", "s6"])
        self.assertFalse(report["route_learning_complete"])
        self.assertEqual(report["verification_status"], "NOT_INFERRED")
        self.assertEqual(report["user_confirmed_count"], 0)
        after = self.service.snapshot()
        self.assertEqual((before.skills, before.tasks, before.evidence, before.answer_assessments),
            (after.skills, after.tasks, after.evidence, after.answer_assessments))

    def test_finishing_session_is_allowed_with_gaps_and_is_not_mastery(self):
        self.propose()
        response = self.client.post("/api/user/teaching/proposals/close/decision", json={
            "expected_revision": 1, "action": "CONFIRM", "feedback": "", "request_id": "end-session"})
        self.assertEqual(response.status_code, 200)
        report = response.json()["closure_progress"]
        self.assertEqual(report["latest_end_choice_status"], "CONFIRMED")
        self.assertFalse(report["route_learning_complete"])
        self.assertEqual(report["user_confirmed_count"], 0)

    def test_resume_then_task_done_retains_only_a_historical_end_choice(self):
        self.propose()
        self.service.decide_teaching("close", 1, "CONFIRM", "", "end-session")
        self.service.activate_task("t4")
        resumed = self.service.goal_closure_progress()
        self.assertTrue(resumed["active_task_present"])
        self.assertEqual(resumed["latest_end_choice_status"], "CONFIRMED")
        self.service.complete_task("t4")
        completed = self.service.goal_closure_progress()
        self.assertFalse(completed["active_task_present"])
        self.assertEqual(completed["latest_end_choice_status"], "CONFIRMED")
        self.assertNotIn("session_end_status", completed, "old choice is never promoted to current session status")
        self.assertFalse(completed["route_learning_complete"])

    def test_old_summary_reads_new_facts_after_remaining_nodes_are_learned(self):
        self.propose()
        old = self.client.get("/api/user/teaching").json()["closure_progress"]
        # Simulate later legitimate learning through an isolated reconstructed Kernel snapshot.
        later = route_fixture(6)
        later._teaching = self.service._teaching
        self.service = later
        current = self.client.get("/api/user/teaching").json()
        report = current["closure_progress"]
        self.assertNotEqual(report["snapshot_signature"], old["snapshot_signature"])
        self.assertTrue(report["route_learning_complete"])
        self.assertEqual(report["covered_milestone_count"], 6)
        self.assertEqual(report["unscored_skill_ids"], ["s2"])
        self.assertFalse(report["formal_assessment_coverage_complete"])
        self.assertEqual(report["milestones"][5]["skills"][0]["latest_assessment"]["score"], 10)
        self.assertEqual(report["milestones"][1]["skills"][0]["latest_assessment"], None)
        self.assertEqual(report["user_confirmed_count"], 0)
        self.assertEqual(current["proposals"][0]["text"], "六阶段全部学完并掌握", "history is not rewritten")

    def test_empty_unexpanded_stage_and_task_done_without_output_are_not_verified(self):
        self.service = route_fixture(6, empty_stage=True)
        report = self.client.get("/api/learning/teaching").json()["closure_progress"]
        self.assertFalse(report["route_learning_complete"])
        self.assertIn("m6", report["uncovered_milestone_ids"])
        self.service._evidence = {}
        self.service._answer_assessments = ()
        report = self.client.get("/api/learning/teaching").json()["closure_progress"]
        self.assertEqual(report["covered_milestone_count"], 0)
        self.assertEqual(report["verification_status"], "NOT_INFERRED")


if __name__ == "__main__":
    unittest.main()
