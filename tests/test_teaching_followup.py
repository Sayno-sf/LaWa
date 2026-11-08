"""知识点身份、独立个人安排与v5升级的真实Application契约。"""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from app.domain.answer_assessment import AssessmentCriterion
from app.domain.task import TeachingActivity, TeachingActivityMethod
from app.domain.teaching_evolution import QuestionContract
from app.persistence import JsonLearningStateStore, STATE_VERSION
from tests.test_answer_assessment import service_fixture, assessment
from tests.test_teaching_evolution import proposal


class TeachingFollowupTests(unittest.TestCase):
    def test_registered_alias_reuses_identity_without_regrading_history(self):
        service = service_fixture()
        original = service.record_answer_assessment(assessment(), topic_aliases=("字符串连接",))
        newer = service.record_answer_assessment(assessment(1, topic="字符串连接", score=10))
        self.assertEqual(newer.topic_id, original.topic_id)
        self.assertEqual(newer.topic, original.topic)
        self.assertEqual(service.snapshot().answer_assessments[0], original)
        self.assertEqual(service.get_learning_overview().practice_context["topic_count"], 1)
        result = service.list_assessment_topics("字符串连接")
        self.assertEqual((len(result), result[0]["match"], result[0]["automatic_merge"]), (1, "EXACT", False))

    def test_similarity_is_only_a_hint_and_conflicting_alias_cannot_merge_records(self):
        service = service_fixture()
        one = service.record_answer_assessment(assessment())
        other = service.record_answer_assessment(assessment(1, topic="字符串加法的计算顺序"))
        self.assertNotEqual(one.topic_id, other.topic_id)
        self.assertTrue(any(t["match"] == "POSSIBLE" for t in service.list_assessment_topics("字符串加法")))
        before = service.snapshot()
        with self.assertRaisesRegex(ValueError, "Alias already belongs"):
            service.record_answer_assessment(assessment(2), topic_aliases=(other.topic,))
        self.assertEqual(service.snapshot(), before)

    def test_concurrent_alias_answers_share_one_topic_and_atomic_failure_leaves_no_alias(self):
        service = service_fixture()
        source = service.record_answer_assessment(assessment(), topic_aliases=("字符串连接",))
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda i: service.record_answer_assessment(assessment(i, topic="字符串连接")), (1, 2)))
        self.assertTrue(all(v.topic_id == source.topic_id for v in results))
        before = service.snapshot()
        def fail(_):
            raise OSError("disk full")
        service.enable_auto_save(fail)
        with self.assertRaises(OSError):
            service.record_answer_assessment(assessment(3), topic_aliases=("加号拼接",))
        self.assertEqual(service.snapshot(), before)
        self.assertTrue(all(v["match"] != "EXACT" for v in service.list_assessment_topics("加号拼接")))

    def test_new_contract_can_review_old_skill_without_claiming_current_skill(self):
        service = service_fixture()
        source = service.record_answer_assessment(assessment())
        service.complete_task("ta")
        service.activate_task("tb")
        service.set_teaching_activity("tb", expected_goal_id="goal", expected_revision=0,
            teaching_activity=TeachingActivity(TeachingActivityMethod.APPLY, "理解函数参数", "预测函数调用结果",
                                               "输出及参数解释", ("函数参数",), "仅评价当前代码文字回答"))
        record = assessment(1, task="tb")
        contract = QuestionContract("review", "goal", "tb", "a", "session", record.question,
                                    (("输出与解释", 10),), review_topic_id=source.topic_id, activity_revision=1)
        service.record_question_contract(contract)
        saved = service.record_answer_assessment(replace(record, contract_id=contract.id))
        self.assertEqual((saved.skill_id, saved.topic_id, service.get_active_task().id), ("a", source.topic_id, "tb"))
        self.assertEqual(service.snapshot().evidence, ())
        with self.assertRaises(ValueError):
            service.record_question_contract(replace(contract, id="forged", review_topic_id="unavailable"))

    def test_independent_method_survives_source_purge_but_source_copies_do_not(self):
        service = service_fixture()
        service.record_answer_assessment(assessment())
        pending = proposal(source_independent=True, reason="来源含机密例子，但确认的是通用教法。")
        service.propose_teaching(pending)
        self.assertEqual(service.teaching_context()["strategies"], [])
        confirmed = service.decide_teaching("strategy", 1, "CONFIRM", "", "yes")
        self.assertIsNone(confirmed.goal_id)
        self.assertEqual(service.decide_teaching("strategy", 1, "CONFIRM", "", "yes"), confirmed,
                         "响应丢失重试不能因成功解耦而失效或重复确认")
        with self.assertRaises(ValueError):
            service.decide_teaching("strategy", 1, "REJECT", "", "yes")
        service.recycle_goal_by_user("goal")
        self.assertEqual(service.teaching_context()["strategies"][0]["text"], pending.text)
        service.purge_goal_by_user("goal")
        state = service.snapshot()
        self.assertNotIn("机密例子", json.dumps(state.teaching.to_json(), ensure_ascii=False))
        self.assertEqual((state.teaching.proposal_versions, state.teaching.decisions), ((), ()))
        with TemporaryDirectory() as directory:
            store = JsonLearningStateStore(Path(directory)/"state.json")
            store.save(service)
            restored = store.load()
            self.assertEqual(restored.teaching_context()["strategies"][0]["text"], pending.text)
            restored.decide_teaching("strategy", 2, "WITHDRAW", "", "withdraw")
            self.assertEqual(restored.teaching_context()["strategies"], [])
            restored.decide_teaching("strategy", 3, "DELETE", "", "delete")
            self.assertEqual(restored.snapshot().teaching.proposals, ())
            self.assertNotIn(pending.text, store.path.read_text(encoding="utf-8"))

    def test_independent_edit_is_inactive_until_new_exact_confirmation(self):
        service = service_fixture()
        service.record_answer_assessment(assessment())
        service.propose_teaching(proposal(source_independent=True))
        service.decide_teaching("strategy", 1, "CONFIRM", "", "yes")
        service.decide_teaching("strategy", 2, "SUPPLEMENT", "只在新概念使用", "edit")
        self.assertEqual(service.teaching_context()["strategies"], [])
        self.assertEqual(service.teaching_context()["proposals"][0]["feedback"], "只在新概念使用")
        service.propose_teaching(proposal(source_independent=True, revision=4, text="只在新概念先举例。"), 3)
        with self.assertRaises(ValueError):
            service.decide_teaching("strategy", 2, "CONFIRM", "", "old-view")
        service.decide_teaching("strategy", 4, "CONFIRM", "", "updated")
        self.assertEqual(service.teaching_context()["strategies"][0]["text"], "只在新概念先举例。")

    def test_v5_migration_keeps_old_strategy_scope_and_restores_aliases_after_v6_write(self):
        service = service_fixture()
        original = service.record_answer_assessment(assessment())
        service.propose_teaching(proposal())
        service.decide_teaching("strategy", 1, "CONFIRM", "", "old-consent")
        payload = JsonLearningStateStore._encode(service)
        payload["version"] = 5
        payload["teaching"].pop("topics")
        for value in (*payload["teaching"]["proposals"], *payload["teaching"]["proposal_versions"]):
            value.pop("source_independent")
        with TemporaryDirectory() as directory:
            store = JsonLearningStateStore(Path(directory)/"state.json")
            store.path.write_text(json.dumps(payload), encoding="utf-8")
            restored = store.load()
            self.assertEqual(restored.snapshot().answer_assessments, (original,))
            self.assertFalse(restored.snapshot().teaching.proposals[0].source_independent)
            self.assertTrue(store.path.with_name("state.json.v5.bak").exists())
            restored.record_answer_assessment(assessment(1), topic_aliases=("字符串连接",))
            self.assertEqual(json.loads(store.path.read_text(encoding="utf-8"))["version"], STATE_VERSION)
            self.assertEqual(store.load().list_assessment_topics("字符串连接")[0]["id"], original.topic_id)
            restored.recycle_goal_by_user("goal")
            self.assertEqual(restored.teaching_context()["strategies"], [], "旧确认不得静默升级为独立保存")
