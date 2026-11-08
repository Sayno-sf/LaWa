"""真实作答评分的持久化、复测归属与不阻塞学习进度的契约。"""

from dataclasses import asdict, replace
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event
import unittest

from fastapi.testclient import TestClient

from app.api.main import app, get_learning_service
from app.application import LearningService
from app.domain import GoalProfile, LearningTask, SkillGraph, SkillNode, SkillState, TaskStatus
from app.domain.answer_assessment import AnswerAssessment, AssessmentCriterion, assessment_topic_id
from app.persistence import JsonLearningStateStore


def service_fixture():
    return LearningService(SkillGraph([SkillNode("a", "加法", status=SkillState.LEARNING), SkillNode("b", "函数")]),
        current_goal="JavaScript", goal_profile=GoalProfile("goal", "JavaScript", "初学", "解释短代码"),
        current_goal_skill_ids=("a", "b"), tasks=(LearningTask("ta", "练习加法", "预测输出", ("a",), (), status=TaskStatus.ACTIVE, goal_id="goal"),
                                                  LearningTask("tb", "练习函数", "解释参数", ("b",), (), goal_id="goal")))


def assessment(index=0, *, score=4, topic="字符串加法", skill="a", task="ta", assistance="INDEPENDENT"):
    answer = "5，23。因为第二个参数是字符串。"
    return AnswerAssessment(id=f"assessment-{index}", goal_id="goal", skill_id=skill,
        topic_id=assessment_topic_id("goal", skill, topic), topic=topic, source_task_id=task,
        source_session_id="session", source_turn_id=f"answer-{index}", question_entry_id=f"question-{index}",
        question="add(2, 3)和add(2, '3')分别输出什么？", answer_excerpt=answer,
        answer_sha256=sha256(answer.encode()).hexdigest(), answer_truncated=False,
        criteria=(AssessmentCriterion("输出与解释", score, 10, "输出判断正确，解释仍需明确转换规则。"),),
        summary="能判断部分结果，需要补充加号的类型转换规则。", strengths=("给出了两个输出",),
        gaps=("解释字符串拼接的触发条件",) if score < 8 else (), assistance_level=assistance)


class AnswerAssessmentTests(unittest.TestCase):
    def test_rubric_and_answer_provenance_are_validated(self):
        good = assessment()
        for changes in ({"criteria": (AssessmentCriterion("判断", 2, 5, "说明"),)},
                        {"answer_sha256": "0" * 64}, {"gaps": ()}):
            with self.assertRaises(ValueError):
                replace(good, **changes)
        with self.assertRaises(ValueError):
            AssessmentCriterion("判断", True, 10, "说明")

    def test_low_score_schedules_later_review_and_does_not_gate_task(self):
        service = service_fixture()
        before = service.get_skill("a")
        service.record_answer_assessment(assessment())
        self.assertEqual(service.get_skill("a"), before)
        self.assertEqual(service.snapshot().evidence, ())
        self.assertEqual(service.get_active_task().id, "ta")
        practice = service.get_learning_overview().practice_context
        self.assertIsNone(practice["topics"][0]["remaining_answers"])
        self.assertEqual(practice["due_reviews"], [])
        for i in range(1, 4):
            service.record_answer_assessment(assessment(i, score=9, topic=f"其他知识点{i}"))
        self.assertEqual(service.get_learning_overview().practice_context["due_reviews"], [])
        self.assertEqual(practice["topics"][0]["retention"], "NOT_YET_OBSERVED")
        service.complete_task("ta")
        service.activate_task("tb")
        self.assertEqual(service.get_active_task().id, "tb")
        self.assertEqual(service.get_skill("a").status, SkillState.LEARNING)

    def test_high_scores_distinguish_actual_assistance_and_clear_old_gap(self):
        service = service_fixture()
        low = service.record_answer_assessment(assessment())
        helped = service.record_answer_assessment(assessment(1, score=10, assistance="WITH_HINT"))
        self.assertEqual(helped.follow_up, "RECHECK")
        self.assertIsNone(helped.review_after)
        self.assertEqual(replace(assessment(4, score=9), gaps=("仍缺少关键转换条件",)).follow_up, "RECHECK")
        secure = service.record_answer_assessment(assessment(2, score=9))
        self.assertEqual(secure.topic_id, low.topic_id)
        topic = service.get_learning_overview().practice_context["topics"][0]
        self.assertEqual(topic["follow_up"], "SECURE")
        self.assertIsNone(topic["remaining_answers"])
        self.assertEqual(service.get_skill("a").status, SkillState.LEARNING)

    def test_interleaved_review_belongs_to_original_skill_without_changing_active_task(self):
        service = service_fixture()
        original = service.record_answer_assessment(assessment())
        service.complete_task("ta")
        service.activate_task("tb")
        service.record_answer_assessment(assessment(1, score=9, task="tb"))
        self.assertEqual(service.get_active_task().id, "tb")
        self.assertEqual(service.snapshot().answer_assessments[-1].skill_id, original.skill_id)
        with self.assertRaisesRegex(ValueError, "new assessment topic"):
            service.record_answer_assessment(assessment(2, task="tb", topic="凭空的新旧Skill知识点"))
        with self.assertRaises(ValueError):
            service.record_answer_assessment(replace(assessment(3, task="tb", skill="b"), goal_id="another-goal"))

    def test_idempotent_retry_freezes_first_grade_and_rejects_source_conflict(self):
        service = service_fixture()
        original = service.record_answer_assessment(assessment())
        self.assertEqual(service.record_answer_assessment(assessment(score=9)), original)
        self.assertEqual(len(service.snapshot().answer_assessments), 1)
        with self.assertRaisesRegex(ValueError, "provenance"):
            service.record_answer_assessment(replace(assessment(), question="其他题目"))

    def test_save_failure_does_not_publish_an_unsaved_score(self):
        service = service_fixture()
        def fail(_):
            raise OSError("disk full")
        service.enable_auto_save(fail)
        with self.assertRaises(OSError):
            service.record_answer_assessment(assessment())
        self.assertEqual(service.snapshot().answer_assessments, ())

    def test_restart_and_legacy_state_preserve_learning_facts(self):
        with TemporaryDirectory() as directory:
            store = JsonLearningStateStore(Path(directory) / "state.json")
            service = store.bind(service_fixture())
            record = service.record_answer_assessment(assessment())
            restored = store.load()
            self.assertEqual(restored.snapshot().answer_assessments, (record,))
            self.assertEqual(restored.get_learning_library().projects[0].answer_assessments, (record,))
            old = json.loads(store.path.read_text(encoding="utf-8"))
            old["version"] = 3
            del old["answer_assessments"]
            old.pop("teaching", None)  # v3还没有教学扩展，旧样本不能保留v6目录。
            store.path.write_text(json.dumps(old), encoding="utf-8")
            legacy = store.load()
            self.assertEqual(legacy.get_active_task(), service.get_active_task())
            self.assertEqual(legacy.snapshot().answer_assessments, ())
            self.assertEqual(json.loads(store.path.with_name("state.json.v3.bak").read_text(encoding="utf-8")), old)

    def test_recycle_hides_scores_restore_keeps_them_and_purge_deletes_goal_content(self):
        service = service_fixture()
        record = service.record_answer_assessment(assessment())
        service.recycle_goal_by_user("goal")
        with self.assertRaises(KeyError):
            service.list_answer_assessments("goal")
        self.assertEqual(service.get_learning_library().projects, ())
        service.restore_goal_by_user("goal")
        self.assertEqual(service.list_answer_assessments("goal"), (record,))
        service.recycle_goal_by_user("goal")
        service.purge_goal_by_user("goal")
        self.assertEqual(service.snapshot().answer_assessments, ())

    def test_api_durable_grade_history_and_scope(self):
        service = service_fixture()
        app.dependency_overrides[get_learning_service] = lambda: service
        self.addCleanup(app.dependency_overrides.clear)
        payload = asdict(assessment())
        payload.pop("created_at")
        payload.pop("topic_id")
        with TestClient(app) as client:
            saved = client.post("/api/learning/answer-assessments", json=payload)
            self.assertEqual(saved.status_code, 200, saved.text)
            self.assertEqual(saved.json()["score"], 4)
            self.assertEqual(saved.json()["max_score"], 10)
            self.assertEqual(client.post("/api/learning/answer-assessments", json=payload).json(), saved.json())
            self.assertEqual(client.get("/api/learning/answer-assessments?goal_id=goal").json()["assessments"][0]["id"], saved.json()["id"])
            topic_id = saved.json()["topic_id"]
            self.assertEqual(client.get(f"/api/learning/answer-assessments/topics/{topic_id}?goal_id=wrong").status_code, 404)
            self.assertEqual(client.get(f"/api/learning/answer-assessments/topics/{topic_id}?goal_id=goal").json()["skill_id"], "a")
            self.assertEqual(client.get("/api/learning/library").json()["projects"][0]["assessment_count"], 1)
            invalid = {**payload, "id": "other", "source_turn_id": "other", "criteria": [{"label": "点", "earned": 2, "possible": 5, "feedback": "说明"}]}
            self.assertEqual(client.post("/api/learning/answer-assessments", json=invalid).status_code, 409)

    def test_unknown_write_result_can_be_read_by_immutable_identity_without_a_second_grade(self):
        service = service_fixture()
        saved = service.record_answer_assessment(assessment())
        before = service.snapshot()
        app.dependency_overrides[get_learning_service] = lambda: service
        self.addCleanup(app.dependency_overrides.clear)
        with TestClient(app) as client:
            response = client.get(f"/api/learning/answer-assessments/{saved.id}?goal_id=goal")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["source_turn_id"], saved.source_turn_id)
            self.assertEqual(response.json()["answer_sha256"], saved.answer_sha256)
            self.assertEqual(response.json()["created_at"], saved.created_at.isoformat().replace("+00:00", "Z"))
            self.assertEqual(client.get(f"/api/learning/answer-assessments/{saved.id}?goal_id=other").status_code, 404)
            self.assertEqual(client.get("/api/learning/answer-assessments/not-saved?goal_id=goal").status_code, 404)
            self.assertEqual(service.snapshot(), before)
            service.recycle_goal_by_user("goal")
            self.assertEqual(client.get(f"/api/learning/answer-assessments/{saved.id}?goal_id=goal").status_code, 404)

    def test_reconciliation_cannot_read_an_appended_grade_while_its_persistence_is_failing(self):
        service = service_fixture()
        entered, release, reading = Event(), Event(), Event()
        def fail(_):
            entered.set()
            if not release.wait(2):
                raise RuntimeError("test did not release persistence")
            raise OSError("isolated persistence failure")
        service.enable_auto_save(fail)
        def lookup():
            reading.set()
            return service.get_answer_assessment("goal", "assessment-0")
        with ThreadPoolExecutor(max_workers=2) as executor:
            write = executor.submit(service.record_answer_assessment, assessment())
            self.assertTrue(entered.wait(1))
            read = executor.submit(lookup)
            try:
                self.assertTrue(reading.wait(1))
                with self.assertRaises(FutureTimeout):
                    read.result(timeout=0.1)
            finally:
                release.set()
            with self.assertRaises(OSError):
                write.result(timeout=1)
            with self.assertRaises(KeyError):
                read.result(timeout=1)
        self.assertEqual(service.snapshot().answer_assessments, ())

    def test_reconciliation_requires_the_original_state_writer_to_confirm_durability(self):
        service = service_fixture()
        saved = service.record_answer_assessment(assessment())
        def fail(_):
            raise OSError("isolated persistence failure")
        service.enable_auto_save(fail)
        with self.assertRaises(OSError):
            service.get_answer_assessment("goal", saved.id)
        writes = []
        service.enable_auto_save(lambda value: writes.append(value.snapshot()))
        self.assertEqual(service.get_answer_assessment("goal", saved.id), saved)
        self.assertEqual(len(writes), 1)
        self.assertEqual(service.snapshot().answer_assessments, (saved,))
