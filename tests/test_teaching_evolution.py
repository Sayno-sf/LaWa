"""用户决策不成为作答；事前要求、幂等、故障回滚与升级恢复的集成契约。"""

from dataclasses import replace, asdict
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from fastapi.testclient import TestClient
from app.api.main import app, get_learning_service
from app.domain.answer_assessment import AssessmentCriterion
from app.domain.task import TeachingActivity, TeachingActivityMethod
from app.domain.teaching_evolution import QuestionContract, TeachingProposal, AssessmentCorrection
from app.persistence import JsonLearningStateStore
from tests.test_answer_assessment import service_fixture, assessment


def proposal(**changes):
    return replace(TeachingProposal("strategy", "goal", "STRATEGY", "先给具体例子，再解释规则。", "这次对照后能解释差别；后续仍需观察。", "USER", "", ("assessment-0",)), **changes)


class TeachingEvolutionTests(unittest.TestCase):
    def test_active_preference_snapshot_is_complete_not_a_truncated_list(self):
        for index in range(9):
            item = proposal(id=f"strategy-{index}", text=f"偏好{index}:" + "按具体情况解释。" * 35)
            self.service.propose_teaching(item)
            self.service.decide_teaching(item.id, 1, "CONFIRM", "", f"confirm-{index}")
        context = self.service.teaching_context()
        self.assertEqual(len(context["strategies"]), 9)
        self.assertEqual(context["strategies_omitted"], 0)

    def test_preference_revision_tracks_decisions_and_survives_reload_without_changing_facts(self):
        before = self.service.snapshot()
        revisions = [self.service.teaching_context()["preference_revision"]]
        self.service.propose_teaching(proposal())
        for expected, action in ((1, "CONFIRM"), (2, "WITHDRAW"), (3, "RESTORE"), (4, "DELETE")):
            self.service.decide_teaching("strategy", expected, action, "", action)
            revisions.append(self.service.teaching_context()["preference_revision"])
            self.assertEqual(bool(self.service.teaching_context()["strategies"]), action in {"CONFIRM", "RESTORE"})
        self.assertEqual(len(set(revisions)), len(revisions))
        after = self.service.snapshot()
        self.assertEqual((before.tasks, before.skills, before.evidence, before.answer_assessments, before.frontier),
                         (after.tasks, after.skills, after.evidence, after.answer_assessments, after.frontier))
        with TemporaryDirectory() as tmp:
            store = JsonLearningStateStore(Path(tmp) / "state.json")
            store.save(self.service)
            self.assertEqual(store.load().teaching_context(), self.service.teaching_context())

    def test_frontier_preference_provenance_persists_and_legacy_defaults_to_unknown(self):
        from app.persistence import _frontier_to_json, _frontier_from_json
        from app.domain.planning import FrontierPlan
        from app.domain.planning import LearningDepth
        frontier = FrontierPlan("a", "reason", LearningDepth.PRACTICAL, "EXPLAIN", "next", teaching_preferences_revision="a" * 64)
        encoded = _frontier_to_json(frontier)
        self.assertEqual(_frontier_from_json(encoded), frontier)
        del encoded["teaching_preferences_revision"]
        self.assertIsNone(_frontier_from_json(encoded).teaching_preferences_revision)

    def setUp(self):
        self.service = service_fixture()
        self.service.record_answer_assessment(assessment())

    def test_contract_freezes_requirements_and_keeps_open_answers(self):
        a = assessment(1)
        self.service.set_teaching_activity("ta", expected_goal_id="goal", expected_revision=0,
            teaching_activity=TeachingActivity(TeachingActivityMethod.APPLY, "理解加法规则", "预测输出并解释",
                                               "两项输出及解释", ("输出与解释",), "仅评价当前代码文字回答"))
        c = QuestionContract("q1", "goal", "ta", "a", "session", a.question, (("输出与解释", 10),), activity_revision=1)
        c = self.service.record_question_contract(c)
        self.assertEqual(self.service.record_question_contract(replace(c, created_at="retry")), c)
        with self.assertRaises(ValueError):
            self.service.record_answer_assessment(replace(a, contract_id="q1", criteria=(AssessmentCriterion("新增术语要求", 3, 10, "临时加码"),)))
        self.service.record_answer_assessment(replace(a, contract_id="q1"))
        self.assertEqual(self.service.snapshot().evidence, ())

    def test_user_confirmation_is_atomic_idempotent_and_never_an_answer(self):
        self.service.propose_teaching(proposal())
        before = self.service.snapshot()
        saved = self.service.decide_teaching("strategy", 1, "CONFIRM", "", "click-1")
        self.assertEqual(saved.status, "CONFIRMED")
        self.assertEqual(self.service.decide_teaching("strategy", 1, "CONFIRM", "", "click-1"), saved)
        after = self.service.snapshot()
        self.assertEqual((before.evidence, before.answer_assessments, before.tasks, before.skills),
                         (after.evidence, after.answer_assessments, after.tasks, after.skills))
        self.assertEqual(len(self.service.teaching_context()["strategies"]), 1)
        with self.assertRaises(ValueError):
            self.service.decide_teaching("strategy", 1, "REJECT", "", "other-device")
        with self.assertRaises(ValueError):
            self.service.decide_teaching("strategy", 1, "REJECT", "", "click-1")

    def test_supplement_requires_new_version_and_a_fresh_confirmation(self):
        self.service.propose_teaching(proposal())
        self.service.decide_teaching("strategy", 1, "SUPPLEMENT", "熟悉内容直接说结论", "feedback")
        self.assertEqual(self.service.teaching_context()["strategies"], [])
        revised = proposal(text="新概念先给例子；熟悉内容直接说结论。", revision=3)
        self.service.propose_teaching(revised, 2)
        with self.assertRaises(ValueError):
            self.service.decide_teaching("strategy", 1, "CONFIRM", "", "stale")
        self.service.decide_teaching("strategy", 3, "CONFIRM", "", "fresh")
        self.assertEqual(self.service.teaching_context()["strategies"][0]["text"], revised.text)
        self.assertEqual(len(self.service.snapshot().teaching.proposal_versions), 3)

    def test_teacher_cannot_confirm_and_reject_is_not_repeated(self):
        with self.assertRaises(ValueError):
            self.service.propose_teaching(proposal(status="CONFIRMED"))
        self.service.propose_teaching(proposal())
        self.service.decide_teaching("strategy", 1, "REJECT", "", "reject")
        with self.assertRaises(ValueError):
            self.service.propose_teaching(proposal(id="new-id"))
        with self.assertRaises(ValueError):
            self.service.propose_teaching(proposal(id="forged-source", assessment_ids=("unknown",)))

    def test_confirmed_strategy_edit_needs_confirmation_and_delete_removes_all_copies(self):
        self.service.propose_teaching(proposal())
        self.service.decide_teaching("strategy", 1, "CONFIRM", "", "initial")
        self.service.decide_teaching("strategy", 2, "SUPPLEMENT", "只在新概念时用", "edit")
        self.assertEqual(self.service.teaching_context()["strategies"], [])
        self.service.propose_teaching(proposal(text="新概念先给例子。", revision=4), 3)
        self.service.decide_teaching("strategy", 4, "CONFIRM", "", "accept-edit")
        deleted = self.service.decide_teaching("strategy", 5, "DELETE", "", "delete")
        self.assertEqual(self.service.decide_teaching("strategy", 5, "DELETE", "", "delete"), deleted)
        state = self.service.snapshot().teaching
        self.assertEqual((state.proposals, state.proposal_versions, state.decisions), ((), (), ()))
        self.assertNotIn("只在新概念时用", json.dumps(state.to_json(), ensure_ascii=False))
        with self.assertRaises(ValueError):
            self.service.propose_teaching(proposal(id="recovered-from-old-chat"))
        with TemporaryDirectory() as tmp:
            store = JsonLearningStateStore(Path(tmp)/"state.json")
            store.save(self.service)
            restored = store.load()
            with self.assertRaises(ValueError):
                restored.propose_teaching(proposal(text="新概念先给例子。", id="new-id"))

    def test_disk_failure_does_not_acknowledge_a_strategy_or_pause_tasks(self):
        self.service.propose_teaching(proposal(kind="CLOSURE", scope="GOAL"))
        before = self.service.snapshot()
        def fail(_):
            raise OSError("disk full")
        self.service.enable_auto_save(fail)
        with self.assertRaises(OSError):
            self.service.decide_teaching("strategy", 1, "CONFIRM", "", "close")
        self.assertEqual(self.service.snapshot(), before)

    def test_closure_pauses_without_granting_mastery_or_fake_task_completion(self):
        self.service.propose_teaching(proposal(kind="CLOSURE", scope="GOAL"))
        before = self.service.get_skill("a")
        self.service.decide_teaching("strategy", 1, "PAUSE", "", "pause")
        self.assertIsNone(self.service.get_active_task())
        self.assertEqual(self.service.get_skill("a"), before)
        self.assertEqual(self.service.snapshot().evidence, ())

    def test_old_proposal_cannot_close_a_changed_goal(self):
        self.service.propose_teaching(proposal(kind="CLOSURE", scope="GOAL"))
        self.service._goal_profile = replace(self.service._goal_profile, desired_outcome="新增了一项实际用途")
        with self.assertRaisesRegex(ValueError, "Goal requirements changed"):
            self.service.decide_teaching("strategy", 1, "CONFIRM", "", "stale-goal")
        self.assertIsNotNone(self.service.get_active_task())
        revised = proposal(kind="CLOSURE", scope="GOAL", text="请按新增用途重新核对这份结束建议。", revision=2)
        self.service.propose_teaching(revised, 1)
        self.service.decide_teaching("strategy", 2, "CONFIRM", "", "updated-goal")
        self.assertIsNone(self.service.get_active_task())

    def test_correction_preserves_original_and_changes_effective_gap_only(self):
        original = self.service.snapshot().answer_assessments[0]
        c = AssessmentCorrection("fix", original.id, 0, "原输出判断有误，核对原题后更正", (AssessmentCriterion("输出与解释", 10, 10, "实际回答正确"),), "原回答正确", ("解释了规则",), ())
        self.service.correct_assessment(c)
        self.assertEqual(self.service.snapshot().answer_assessments[0], original)
        self.assertEqual(self.service.effective_assessment(original).score, 10)
        self.assertEqual(self.service.get_learning_overview().practice_context["topics"][0]["gaps"], [])
        with self.assertRaises(ValueError):
            self.service.correct_assessment(replace(c, id="stale-fix"))

    def test_migration_restart_withdrawal_and_source_deletion(self):
        with TemporaryDirectory() as tmp:
            store = JsonLearningStateStore(Path(tmp)/"state.json")
            store.bind(self.service)
            self.service.propose_teaching(proposal())
            self.service.decide_teaching("strategy", 1, "CONFIRM", "", "save")
            restored = store.load()
            self.assertEqual(restored.teaching_context()["strategies"], self.service.teaching_context()["strategies"])
            restored.decide_teaching("strategy", 2, "WITHDRAW", "", "withdraw")
            self.assertEqual(restored.teaching_context()["strategies"], [])
            restored.recycle_goal_by_user("goal")
            restored.purge_goal_by_user("goal")
            self.assertEqual(store.load().snapshot().teaching.proposals, ())
            old = JsonLearningStateStore._encode(service_fixture())
            old["version"] = 4
            old.pop("teaching")
            store.path.write_text(json.dumps(old), encoding="utf-8")
            self.assertEqual(store.load().snapshot().teaching.proposals, ())
            self.assertTrue(store.path.with_name("state.json.v4.bak").exists())

    def test_http_decisions_are_not_exposed_as_model_operations(self):
        app.dependency_overrides[get_learning_service] = lambda: self.service
        try:
            client = TestClient(app)
            body = asdict(proposal())
            for key in ("status", "feedback", "created_at", "goal_signature"):
                body.pop(key)
            self.assertEqual(client.post("/api/learning/teaching/proposals", json=body).status_code, 200)
            decision = {"expected_revision": 1, "action": "CONFIRM", "request_id": "http", "feedback": ""}
            self.assertEqual(client.post("/api/learning/teaching/proposals/strategy/decision", json=decision).status_code, 404)
            self.assertEqual(client.post("/api/user/teaching/proposals/strategy/decision", json=decision).status_code, 200)
            self.assertEqual(self.service.snapshot().evidence, ())
        finally:
            app.dependency_overrides.clear()

    def test_withdrawn_strategy_can_be_restored_and_injects_again(self):
        self.service.propose_teaching(proposal())
        self.service.decide_teaching("strategy", 1, "CONFIRM", "", "save")
        self.assertEqual(len(self.service.teaching_context()["strategies"]), 1)
        self.service.decide_teaching("strategy", 2, "WITHDRAW", "", "withdraw")
        self.assertEqual(self.service.teaching_context()["strategies"], [])
        restored = self.service.decide_teaching("strategy", 3, "RESTORE", "", "restore")
        self.assertEqual(restored.status, "CONFIRMED")
        self.assertEqual(restored.revision, 4)
        self.assertEqual(len(self.service.teaching_context()["strategies"]), 1, "恢复后重新注入老师")
        # 同请求重试保持幂等；恢复不是又一次确认，也不改正文。
        self.assertEqual(self.service.decide_teaching("strategy", 3, "RESTORE", "", "restore"), restored)
        self.assertEqual(restored.text, "先给具体例子，再解释规则。")
        # 只有已撤回的安排可以恢复。
        with self.assertRaises(ValueError):
            self.service.decide_teaching("strategy", 4, "RESTORE", "", "restore-again")

    def test_http_restore_is_accepted_for_withdrawn_strategy(self):
        app.dependency_overrides[get_learning_service] = lambda: self.service
        try:
            client = TestClient(app)
            self.service.propose_teaching(proposal())
            url = "/api/user/teaching/proposals/strategy/decision"
            self.assertEqual(client.post(url, json={"expected_revision": 1, "action": "CONFIRM", "feedback": "", "request_id": "c1"}).status_code, 200)
            self.assertEqual(client.post(url, json={"expected_revision": 2, "action": "WITHDRAW", "feedback": "", "request_id": "w1"}).status_code, 200)
            response = client.post(url, json={"expected_revision": 3, "action": "RESTORE", "feedback": "", "request_id": "r1"})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["status"], "CONFIRMED")
        finally:
            app.dependency_overrides.clear()
