"""成长资料的版本、权限、事务及导入续学契约，使用隔离临时账本。"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import replace
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from app.api.main import app, get_learning_service, get_material_store
from app.bootstrap import build_empty_learning_service
from app.domain import CurriculumMilestone, FrontierPlan, LearningDepth, LearningTask
from app.domain.growth import DIMENSIONS, GrowthState, zero_dimensions
from app.growth_protocol import LearningImport
from app.materials import MaterialStore
from app.persistence import JsonLearningStateStore, STATE_VERSION
from tests.test_answer_assessment import service_fixture, assessment


def payload():
    return {"schema_version": "lawa.learning-import/v1", "source": {"platform": "GPT", "conversation_title": "CSV"},
            "goals": [{"ref": "g1", "goal_profile": {"goal_description": "读取CSV", "desired_outcome": "读取并筛选行", "learning_domain": "python"},
                       "skills": [{"ref": "s1", "name": "CSV", "description": "读取表格"}],
                       "self_reports": [{"skill_ref": "s1", "statement": "我会读取CSV"}],
                       "work_samples": [{"ref": "w1", "skill_ref": "s1", "question": "一行是什么类型？", "learner_answer": "以列名为键的字典。", "occurred_at": None}]}]}


def commit(service, value=None, selected=None, targets=None):
    value = value or payload()
    return service.growth_commit_import(value, service.growth_preview_import(value)["preview_hash"], selected or ["g1"], targets or {})


def result(job, score=1.0):
    dims = zero_dimensions()
    dims[1] = {"id": DIMENSIONS[1][0], "score": score, "rationale": "仅有基础表格处理的有限依据。",
               "coverage": ["读取表格"], "missing": ["复杂系统"], "source_refs": [r["id"] for r in job["input"]["records"]]}
    return {"schema_version": "lawa.capability-evaluation/v1", "basis": job["input"]["basis"], "dimensions": dims}


def next_job(service, kind, model="fixture-model"):
    for _ in range(15):
        with patch("app.application.growth.time.time", return_value=time.time() + 31):
            job = service.growth_claim(model)
        if not job:
            raise AssertionError(f"Missing job {kind}")
        if job["key"] == kind:
            return job
        if job["key"] == "classify":
            value = {"goals": [{"goal_id": g["goal_id"], "weights": {"science": 0, "technology": 3, "humanities": 0, "expression": 0}, "reason": "技术主题"} for g in job["input"]["goals"]]}
        elif job["key"].startswith("review:"):
            value = {"sample_id": job["key"][7:], "supported": True, "reason": "回答符合字典结构；帮助情况未知。"}
        elif job["key"].startswith("score:"):
            value = result(job)
        else:
            value = {"items": []}
        service.growth_complete(job["key"], job["lease"], value)
    raise AssertionError("job loop")


class GrowthTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = JsonLearningStateStore(Path(self.tmp.name) / "state.json")
        self.service = self.store.bind(build_empty_learning_service())

    def test_no_information_is_zero_but_pending_and_failure_are_not_zero(self):
        atlas = self.service.growth_atlas()
        self.assertEqual([d["score"] for d in atlas["capability"]["evaluation"]["dimensions"]], [0] * 6)
        self.service.growth_supplement("写过一个CSV脚本")
        self.assertIsNone(self.service.growth_atlas()["capability"]["evaluation"])
        for i in range(2):
            job = next_job(self.service, "score:integrated")
            self.service.growth_release(job["key"], job["lease"], failed=True)
        self.assertEqual(self.service.growth_atlas()["capability"]["status"], "FAILED")
        self.assertIsNone(self.service.growth_atlas()["capability"]["evaluation"])
        self.service.growth_retry("score:integrated")
        self.assertEqual(self.service.growth_atlas()["capability"]["status"], "QUEUED")

    def test_self_reports_never_create_goals_or_learning_facts(self):
        before = self.service.snapshot()
        self.service.growth_supplement("我能独立完成一个短脚本")
        job = next_job(self.service, "score:integrated")
        self.service.growth_complete(job["key"], job["lease"], result(job))
        after = self.service.snapshot()
        self.assertEqual((after.skills, after.tasks, after.evidence), (before.skills, before.tasks, before.evidence))
        self.assertEqual(self.service.growth_atlas()["points"], [])
        self.assertEqual(self.service.growth_atlas()["capability"]["evaluation"]["dimensions"][1]["score"], 1)
        self.assertTrue(self.service.growth_atlas()["capability"]["evaluation"]["dimensions"][1]["awaiting_practice"])

    def test_import_review_and_withdraw_are_separate_from_mastery(self):
        batch = commit(self.service)
        project = self.service.get_learning_library().projects[0]
        self.assertIsNone(self.service.growth_atlas()["capability"]["evaluation"])
        observed = next_job(self.service, "score:integrated")
        self.service.growth_complete(observed["key"], observed["lease"], result(observed))
        self.assertEqual(self.service.growth_atlas()["capability"]["evaluation"]["dimensions"][1]["score"], 1)
        self.assertEqual(self.service.snapshot().evidence, ())
        self.assertEqual(project.skills[0].status.value, "NOT_STARTED")
        source = next(r for r in observed["input"]["records"] if r["origin"] == "observed")
        self.assertIsNone(source["occurred_at"])
        self.assertEqual(source["assistance"], "UNKNOWN")
        self.service.growth_withdraw_import(batch["id"])
        self.assertEqual(len(self.service.get_learning_library().projects), 1)
        with self.assertRaises(KeyError):
            self.service.growth_source(source["id"])
        self.assertEqual(self.service.growth_atlas()["capability"]["evaluation"]["dimensions"], zero_dimensions())

    def test_preview_selection_duplicate_and_same_name_does_not_merge(self):
        value = payload()
        second = deepcopy(value["goals"][0]); second["ref"] = "g2"; second["goal_profile"]["desired_outcome"] = "独立筛选"
        value["goals"].append(second)
        value["goals"].append({"ref": "invalid", "goal_profile": {"goal_description": "缺少结果"}})
        preview = self.service.growth_preview_import(value)
        self.assertEqual(len(preview["goals"]), 2)
        self.assertEqual(len(preview["invalid"]), 1)
        first = commit(self.service, value, ["g1"])
        repeated = commit(self.service, value, ["g1"])
        self.assertEqual(first["id"], repeated["id"])
        self.assertEqual(len(self.service.snapshot().growth.to_json()["samples"]), 1)
        commit(self.service, value, ["g2"])
        self.assertEqual(len(self.service.get_learning_library().projects), 2)

    def test_append_preserves_route_current_task_and_skill_identity(self):
        service = service_fixture()
        task, original = service.get_active_task(), service.snapshot()
        batch = commit(service, targets={"g1": "goal"})
        self.assertEqual(len(service.get_learning_library().projects), 1)
        self.assertEqual(service.get_active_task(), task)
        self.assertEqual(service.snapshot().curriculum_spine, original.curriculum_spine)
        self.assertEqual(service.get_skill("a"), original.skills[0])
        self.assertTrue(set(original.current_goal_skill_ids).issubset(service.snapshot().current_goal_skill_ids))
        service.record_answer_assessment(assessment())
        service.growth_withdraw_import(batch["id"])
        self.assertEqual(len(service.snapshot().answer_assessments), 1)
        self.assertEqual(service.get_active_task(), task)

    def test_atomic_save_failure_and_concurrent_native_writes(self):
        service = service_fixture()
        before = service.snapshot()
        service.enable_auto_save(lambda _: (_ for _ in ()).throw(OSError("disk unavailable")))
        with self.assertRaises(OSError):
            commit(service)
        self.assertEqual(service.snapshot(), before)
        service.enable_auto_save(self.store.save)
        with ThreadPoolExecutor(max_workers=3) as pool:
            futures = [pool.submit(commit, service), pool.submit(service.record_answer_assessment, assessment()),
                       pool.submit(service.growth_supplement, "会做基础统计")]
            for future in futures:
                future.result(timeout=10)
        restored = self.store.load()
        self.assertEqual(len(restored.snapshot().answer_assessments), 1)
        self.assertEqual(len(restored.get_learning_library().projects), 2)
        self.assertEqual(len(restored.growth_atlas()["supplements"]), 1)

    def test_import_protocol_limits_unknown_authority_and_wrong_references(self):
        for field, value in (("mastery", "MASTERED"), ("id", "formal-id"), ("coordinates", [1, 1]), ("score", 5)):
            body = payload(); body["goals"][0][field] = value
            self.assertEqual(len(self.service.growth_preview_import(body)["invalid"]), 1)
        body = payload(); body["goals"][0]["work_samples"][0]["skill_ref"] = "missing"
        self.assertEqual(len(self.service.growth_preview_import(body)["invalid"]), 1)
        body = payload(); body["goals"][0]["work_samples"][0]["learner_answer"] = "a" * 16001
        self.assertEqual(len(self.service.growth_preview_import(body)["invalid"]), 1)
        body = payload(); body["goals"] *= 21
        with self.assertRaises(ValueError): self.service.growth_preview_import(body)
        body = payload(); body["source"]["reference"] = "a" * 1048576
        with self.assertRaises(ValueError): self.service.growth_preview_import(body)
        body = payload(); body["goals"][0]["skills"] *= 201
        with self.assertRaises(ValueError): self.service.growth_preview_import(body)
        body = payload(); body["goals"][0]["work_samples"] *= 101
        with self.assertRaises(ValueError): self.service.growth_preview_import(body)

    def test_score_validation_basis_range_precision_and_forged_source(self):
        self.service.growth_supplement("读写CSV")
        job = next_job(self.service, "score:integrated")
        for value in (True, -1, 5.1, float("nan"), 1.11):
            invalid = result(job, value)
            with self.assertRaises(ValueError): self.service.growth_complete(job["key"], job["lease"], invalid)
        invalid = result(job); invalid["basis"] = "observed"
        with self.assertRaises(ValueError): self.service.growth_complete(job["key"], job["lease"], invalid)
        invalid = result(job); invalid["dimensions"][1]["source_refs"] = ["forged"]
        with self.assertRaises(ValueError): self.service.growth_complete(job["key"], job["lease"], invalid)
        invalid = result(job); invalid["dimensions"].append(None)
        with self.assertRaises(ValueError): self.service.growth_complete(job["key"], job["lease"], invalid)
        self.assertEqual(self.service.snapshot().growth.to_json()["evaluations"], [])

    def test_debounce_read_only_polling_and_unified_history(self):
        service = service_fixture()
        with patch("app.application.growth.time.time", return_value=1000): service.record_answer_assessment(assessment())
        initial = service.snapshot().growth.to_json()["jobs"]["score:integrated"]
        self.assertEqual(initial["due_at"], 1030)
        with patch("app.application.growth.time.time", return_value=1008): service.record_answer_assessment(assessment(1))
        job = service.snapshot().growth.to_json()["jobs"]["score:integrated"]
        self.assertEqual(job["due_at"], 1038)
        service.growth_atlas(); service.get_learning_overview(); service.ensure_state_saved()
        self.assertEqual(service.snapshot().growth.to_json()["jobs"]["score:integrated"], job)
        service.growth_supplement("学过写作")
        self.assertNotEqual(service.snapshot().growth.to_json()["jobs"]["score:integrated"]["input_hash"], job["input_hash"])
        records = next_job(service, "score:integrated")["input"]["records"]
        self.assertEqual(sum(r["origin"] == "observed" for r in records), 2)
        self.assertEqual(sum(r["origin"] == "self_report" for r in records), 1)

    def test_old_scores_retained_on_addition_but_edited_sources_invalidate_and_late_results_rejected(self):
        item = self.service.growth_supplement("读写CSV")
        job = next_job(self.service, "score:integrated")
        self.service.growth_complete(job["key"], job["lease"], result(job))
        self.service.growth_supplement("用过正则表达式")
        layer = self.service.growth_atlas()["capability"]
        self.assertEqual(layer["evaluation"]["dimensions"][1]["score"], 1)
        stale = next_job(self.service, "score:integrated")
        self.service.growth_supplement("只看过CSV教程，还没自己写", item["id"])
        self.assertIsNone(self.service.growth_atlas()["capability"]["evaluation"])
        with self.assertRaises(ValueError): self.service.growth_complete(stale["key"], stale["lease"], result(stale))

    def test_cache_model_identity_and_summary_checkpoint_survive_restart(self):
        item = self.service.growth_supplement("读写CSV")
        job = next_job(self.service, "score:integrated", "model-a")
        self.service.growth_checkpoint(job["key"], job["lease"], {"source_refs": [item["id"]], "summary": "[本人自述] 仅提到基础CSV操作。"})
        self.service.growth_release(job["key"], job["lease"])
        service = self.store.load()
        job = next_job(service, "score:integrated", "model-a")
        self.assertEqual(len(job["summaries"]), 1)
        service.growth_complete(job["key"], job["lease"], result(job))
        changed = next_job(service, "score:integrated", "model-b")
        self.assertEqual(changed["summaries"], [])
        service.growth_complete(changed["key"], changed["lease"], result(changed, 1.2))
        # 切回同一资料/说明/模型时复用旧结果，不创建评分租约。
        with patch("app.application.growth.time.time", return_value=time.time() + 31):
            job = service.growth_claim("model-a")
        self.assertTrue(job is None or job["key"] != "score:integrated")
        layer = service.growth_atlas()["capability"]
        self.assertEqual(layer["evaluation"]["model_id"], "model-a")
        self.assertEqual(layer["evaluation"]["dimensions"][1]["score"], 1)

    def test_classification_unknown_center_manual_and_stale(self):
        batch = commit(self.service)
        goal = batch["entries"][0]["goal_id"]
        point = self.service.growth_atlas()["points"][0]
        self.assertIsNone(point["x"])
        weights = {"science": 3, "technology": 0, "humanities": 0, "expression": 0}
        self.service.growth_set_classification(goal, weights)
        self.assertEqual((self.service.growth_atlas()["points"][0]["x"], self.service.growth_atlas()["points"][0]["y"]), (0, 1))
        self.service.growth_set_classification(goal, dict.fromkeys(weights, 1))
        self.assertEqual(self.service.growth_atlas()["points"][0]["x"], 0)
        self.service.growth_set_classification(goal, dict.fromkeys(weights, 0))
        self.assertIsNone(self.service.growth_atlas()["points"][0]["x"])

    def test_v8_migration_keeps_hardware_identity_and_feedback_fields(self):
        from tests.test_hardware_feedback import learner
        service = learner(); self.store.save(service)
        original = json.loads(self.store.path.read_text(encoding="utf-8"))
        original["version"] = 8; original.pop("growth")
        self.store.path.write_text(json.dumps(original), encoding="utf-8")
        restored = self.store.load(); self.store.save(restored)
        value = json.loads(self.store.path.read_text(encoding="utf-8"))
        self.assertEqual(value["version"], STATE_VERSION)
        self.assertEqual(value["hardware_feedback"], original["hardware_feedback"])
        self.assertEqual(value["knowledge_cards"], original["knowledge_cards"])
        self.assertTrue(self.store.path.with_name("state.json.v8.bak").exists())

    def test_migration_rehearsal_preserves_original_v8_bytes_with_new_growth_queue(self):
        from scripts.check_teaching_migration import check
        from tests.test_hardware_feedback import learner
        self.store.save(learner())
        original = json.loads(self.store.path.read_text(encoding="utf-8"))
        original["version"] = 8
        original.pop("growth")
        self.store.path.write_text(json.dumps(original), encoding="utf-8")
        captured = self.store.path.read_bytes()
        result = check(self.store.path)
        self.assertTrue(result["passed"])
        self.assertEqual((result["sourceVersion"], result["targetVersion"]), (8, STATE_VERSION))
        self.assertEqual(self.store.path.read_bytes(), captured)
        self.assertFalse(self.store.path.with_name("state.json.v8.bak").exists())

    def test_same_goal_first_route_and_continued_learning_survives_batch_withdraw(self):
        batch = commit(self.service)
        goal_id = batch["entries"][0]["goal_id"]
        self.service.switch_goal_by_user(goal_id)
        original = self.service.snapshot()
        skill = original.skills[0]
        spine = tuple(CurriculumMilestone(f"stage-{i}", f"阶段{i}", "练习", LearningDepth.PRACTICAL,
                                          skill_ids=(skill.id,) if i == 0 else ()) for i in range(5))
        frontier = FrontierPlan(focus_skill_id=skill.id, reason="继续已有知识", target_depth=LearningDepth.PRACTICAL, suggested_learning_mode="EXPLAIN", next_action="开始学习")
        self.service.initialize_curriculum(original.goal_profile, spine, (skill,), frontier, replace_existing=True)
        self.assertEqual(len(self.service.get_learning_library().projects), 1)
        self.assertEqual(self.service.snapshot().current_goal_skill_ids, original.current_goal_skill_ids)
        self.service.create_task(LearningTask("new-task", "继续CSV", "练习", (skill.id,), ()))
        self.service.activate_task("new-task")
        self.service.growth_withdraw_import(batch["id"])
        restored = self.store.load()
        self.assertEqual(restored.get_active_task().id, "new-task")
        self.assertEqual(restored.snapshot().goal_profile.id, goal_id)
        self.assertFalse(restored.growth_needs_route(goal_id))
        with self.assertRaises(ValueError): restored.initialize_curriculum(original.goal_profile, spine, (skill,), frontier)

    def test_browser_cannot_submit_evaluations_and_instances_do_not_share_records(self):
        app.dependency_overrides[get_learning_service] = lambda: self.service
        self.addCleanup(app.dependency_overrides.clear)
        client = TestClient(app)
        self.addCleanup(client.close)
        self.assertEqual(client.post("/api/internal/growth/claim", json={"model_id": "model"}, headers={"origin": "http://localhost", "x-lawa-worker": "growth-v1"}).status_code, 403)
        self.assertEqual(client.post("/api/user/growth/evaluations", json={"score": 5}).status_code, 404)
        item = client.post("/api/user/growth/supplements", json={"text": "读写CSV"}).json()
        self.assertEqual(client.get("/api/learning/growth/sources/" + item["id"]).status_code, 200)
        other = build_empty_learning_service()
        app.dependency_overrides[get_learning_service] = lambda: other
        self.assertEqual(client.get("/api/learning/growth/sources/" + item["id"]).status_code, 404)
        self.assertEqual(other.growth_atlas()["supplements"], [])

    def test_schema_artifact_matches_runtime(self):
        schema = json.loads((Path(__file__).resolve().parents[1] / "resources/growth/learning-import.schema.json").read_text(encoding="utf-8"))
        self.assertEqual(schema, LearningImport.model_json_schema())

    def test_import_preserves_code_and_originals_with_separate_source_times(self):
        value = payload()
        answer = "    return row['name']\n\n"
        value["goals"][0]["work_samples"][0]["learner_answer"] = answer
        value["source"]["reference"] = "https://example.invalid/conversation"
        value["source"]["media_descriptions"] = ["截图只保存说明，不评审像素"]
        batch = commit(self.service, value)
        context = self.service.growth_goal_context(batch["entries"][0]["goal_id"])
        self.assertEqual(context["samples"][0]["learner_answer"], answer)
        self.assertEqual(context["samples"][0]["source"], context["records"][0]["source"])
        self.assertIsNone(context["samples"][0]["occurred_at"])
        self.assertEqual(context["samples"][0]["imported_at"], batch["created_at"])
        original = "  我曾写过脚本\n"
        self.assertEqual(self.service.growth_supplement(original)["text"], original)
        self.service.switch_goal_by_user(batch["entries"][0]["goal_id"])
        self.assertIn("source", self.service.growth_learning_context()["records"][0]["truncated_fields"])

    def test_goal_navigation_does_not_requeue_unchanged_capability_input(self):
        first = commit(self.service)["entries"][0]["goal_id"]
        value = payload(); value["goals"][0]["goal_profile"]["goal_description"] = "另一个CSV目标"
        second = commit(self.service, value)["entries"][0]["goal_id"]
        before = self.service.snapshot().growth.to_json()["jobs"]["score:integrated"]
        for goal in (first, second, first):
            self.service.switch_goal_by_user(goal)
            self.assertEqual(self.service.snapshot().growth.to_json()["jobs"]["score:integrated"], before)

    def test_expired_lease_cannot_submit_and_second_abandonment_requires_manual_retry(self):
        self.service.growth_supplement("基础CSV")
        job = next_job(self.service, "score:integrated")
        expired = job["lease_until"] + 1
        with patch("app.application.growth.time.time", return_value=expired):
            with self.assertRaises(ValueError): self.service.growth_complete(job["key"], job["lease"], result(job))
            newer = self.service.growth_claim("fixture-model")
        self.assertNotEqual(newer["lease"], job["lease"])
        self.assertEqual(newer["attempts"], 1)
        with patch("app.application.growth.time.time", return_value=newer["lease_until"] + 1):
            self.service.growth_claim("fixture-model")
        self.assertEqual(self.service.snapshot().growth.to_json()["jobs"]["score:integrated"]["status"], "FAILED")
        self.service.growth_retry("score:integrated")
        self.assertEqual(self.service.snapshot().growth.to_json()["jobs"]["score:integrated"]["status"], "QUEUED")


if __name__ == "__main__": unittest.main()
