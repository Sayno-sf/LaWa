"""主要资料先读再定稿：版本、原请求、幂等与并发删除均在真实HTTP/Kernel上验证。"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
from pathlib import Path
import tempfile
from threading import Event
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import retrieval
from app.api.main import app, get_learning_service, get_material_store
from app.bootstrap import build_empty_learning_service
from app.materials import MaterialStore, MaterialError
from app.material_planning import MaterialPlanningStore
from app.material_reading import MaterialReadingStore


def plan():
    return {"goal_profile": {"id": "goal-lab", "goal_description": "用资料学习校准", "background_summary": "初学者",
            "desired_outcome": "可读懂并完成校准", "learning_preferences": [], "time_constraint": "", "prior_knowledge_claims": []},
            "curriculum_spine": [{"id": f"stage-{n}", "name": f"阶段{n}", "description": f"阶段{n}", "target_depth": "PRACTICAL"} for n in range(5)],
            "frontier_skills": [{"id": "calibration", "name": "校准", "description": "读懂步骤", "prerequisites": [], "target_depth": "PRACTICAL"}],
            "frontier": {"focus_skill_id": "calibration", "supporting_skill_ids": [], "reason": "实际目标",
                         "target_depth": "PRACTICAL", "suggested_learning_mode": "EXPLAIN", "next_action": "读懂流程"}, "replace_existing": False}


class MaterialPlanningTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.materials = MaterialStore(Path(self.tmp.name) / "materials")
        self.reading, self.planning = MaterialReadingStore(self.materials), MaterialPlanningStore(self.materials)
        self.service = build_empty_learning_service()
        self.session = "planning-session"
        self.owner = self.materials.draft_scope(self.session)
        source = Path(self.tmp.name) / "source.md"
        source.write_text("先零参考，再校准，再比较。q=3v+4。", encoding="utf-8")
        self.id = self.materials.create(source, source.name, self.owner, purpose="conversation_attachment", conversation_id=self.session)["id"]
        app.dependency_overrides[get_learning_service] = lambda: self.service
        app.dependency_overrides[get_material_store] = lambda: self.materials
        self.client = TestClient(app, raise_server_exceptions=False)

    def tearDown(self):
        self.client.close()
        app.dependency_overrides.clear()
        self.materials.close()
        self.tmp.cleanup()

    def register(self, request="a" * 64, user="actual-user-1", ids=None):
        body = {"request_id": request, "user_entry_id": user, "goal_id": plan()["goal_profile"]["id"],
                "goal_profile_hash": retrieval.checksum(plan()["goal_profile"]), "material_ids": [self.id] if ids is None else ids}
        response = self.client.post(f"/api/learning/material-planning/{self.session}/requirements",
                                    params={"draft_session_id": self.session}, json=body)
        self.assertEqual(response.status_code, 200, response.text)
        return request

    def ready(self):
        self.reading.enqueue(self.id, self.owner, "basis")
        batch = self.reading.claim(self.id, self.owner, "fixture-reader")
        self.reading.commit(self.id, self.owner, batch["job"]["lease"]["id"], {"summary": "真实已交付批次。"}, {"provider": "fixture", "id": "vision"})
        final = self.reading.claim(self.id, self.owner, "fixture-reader")
        return self.reading.commit(self.id, self.owner, final["job"]["lease"]["id"], {"summary": "完整原件与前后依赖。", "facts": ["q=3v+4"], "dependencies": ["比较依赖校准"]},
                                   {"provider": "fixture", "id": "vision"}, True, [])

    def context(self, max_tokens=100_000, **scope):
        return self.client.post(f"/api/learning/material-planning/{self.session}/requirements/{'a' * 64}/context",
                                params=scope or {"draft_session_id": self.session}, json={"max_tokens": max_tokens})

    def test_planning_context_delivers_actual_synthesis_dependencies_and_original_without_learning_writes(self):
        self.register()
        self.assertEqual(self.context().json()["code"], "PLANNING_READING_WAITING")
        self.ready()
        before = deepcopy(self.service.snapshot())
        packet = self.context()
        self.assertEqual(packet.status_code, 200, packet.text)
        row = packet.json()["sources"][0]
        self.assertIn("q=3v+4", row["synthesis"]["facts"])
        self.assertIn("比较依赖校准", row["synthesis"]["dependencies"])
        self.assertIn("先零参考，再校准，再比较", row["native_text"])
        self.assertTrue(row["native_text_complete"])
        self.assertEqual(row["reading_nodes"][0]["start"], 0)
        self.assertEqual(self.service.snapshot(), before)
        self.assertEqual(self.context(1).json()["code"], "PLANNING_CONTEXT_TOO_LARGE")
        self.assertEqual(self.initialize().status_code, 201)
        bound = self.context(expected_goal_id="goal-lab")
        self.assertEqual(bound.status_code, 200, bound.text)
        self.assertEqual(bound.json()["sources"][0]["source"]["scope"], "goal-lab")
        self.materials.delete(self.id, "goal-lab")
        self.assertEqual(self.context(expected_goal_id="goal-lab").status_code, 404)
        self.assertEqual(self.initialize().status_code, 201, "historical commit receipt survives source deletion")

    def test_context_keeps_every_selected_book_and_rejects_scope_or_purpose_change(self):
        other = Path(self.tmp.name) / "second.md"
        other.write_text("第二份教材：误差不得超过0.2。", encoding="utf-8")
        first, second = self.id, self.materials.create(other, other.name, self.owner)["id"]
        self.register(ids=[first, second])
        self.ready()
        self.id = second
        self.ready()
        self.id = first
        packet = self.context().json()
        self.assertEqual([row["source"]["material_id"] for row in packet["sources"]], [first, second])
        self.assertTrue(all(row["native_text_complete"] for row in packet["sources"]))
        self.assertEqual(self.context(draft_session_id="foreign-session").status_code, 409)
        self.materials.set_purpose(second, self.owner, "conversation_attachment", 0, self.session)
        self.assertEqual(self.context().json()["code"], "PLANNING_READING_SOURCE_CHANGED")

    def test_context_prepares_originals_outside_lock_and_rejects_concurrent_deletion(self):
        self.register()
        self.ready()
        entered, release = Event(), Event()
        actual = self.materials.reading_source
        def held(*args):
            entered.set()
            self.assertTrue(release.wait(5))
            return actual(*args)
        with ThreadPoolExecutor(max_workers=2) as pool, patch.object(self.materials, "reading_source", side_effect=held):
            pending = pool.submit(self.context)
            self.assertTrue(entered.wait(3))
            pool.submit(self.materials.delete, self.id, self.owner).result(timeout=2)
            release.set()
            self.assertEqual(pending.result(timeout=3).status_code, 404)

    def initialize(self, request="a" * 64, **changes):
        return self.client.post("/api/learning/curriculum/initialize",
                                json={**plan(), "onboarding_session_id": self.session, "reading_requirement_id": request, **changes})

    def test_parsed_or_one_batch_does_not_allow_formal_route_then_ready_receipt_is_idempotent(self):
        self.register()
        before = deepcopy(self.service.snapshot())
        response = self.initialize()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "PLANNING_READING_WAITING")
        self.assertEqual(self.service.snapshot(), before)
        self.reading.enqueue(self.id, self.owner, "basis")
        batch = self.reading.claim(self.id, self.owner, "fixture")
        self.reading.commit(self.id, self.owner, batch["job"]["lease"]["id"], {"summary": "一个批次"}, {"provider": "fixture", "id": "vision"})
        self.assertEqual(self.initialize().status_code, 409)
        final = self.reading.claim(self.id, self.owner, "fixture")
        self.reading.commit(self.id, self.owner, final["job"]["lease"]["id"], {"summary": "全部整合"}, {"provider": "fixture", "id": "vision"}, True, [])
        result = self.initialize()
        self.assertEqual(result.status_code, 201, result.text)
        current = deepcopy(self.service.snapshot())
        self.assertEqual(current.tasks, ())
        self.assertEqual(current.evidence, ())
        self.assertEqual(self.reading.get(self.id, "goal-lab")["state"], "READY", "binding the real draft reuses unchanged reading conclusions")
        repeated = self.initialize()
        self.assertEqual(repeated.status_code, 201, repeated.text)
        self.assertEqual(result.json(), repeated.json())
        self.assertEqual(self.service.snapshot(), current)
        changed = self.initialize(frontier={**plan()["frontier"], "reason": "改换路线"})
        self.assertEqual(changed.status_code, 409)
        self.assertEqual(changed.json()["code"], "PLANNING_RECEIPT_CONFLICT")

    def test_omitted_scope_old_request_profile_change_and_source_version_cannot_bypass_guard(self):
        self.register()
        self.ready()
        self.assertEqual(self.initialize(reading_requirement_id=None).status_code, 409)
        omitted = self.client.post("/api/learning/curriculum/initialize", json=plan())
        self.assertEqual(omitted.status_code, 409)
        self.assertEqual(self.initialize(goal_profile={**plan()["goal_profile"], "desired_outcome": "偷偷换目标"}).status_code, 409)
        self.register("b" * 64, "actual-user-2")
        self.assertEqual(self.initialize().status_code, 409)
        self.materials.set_purpose(self.id, self.owner, "learning_material", 0, self.session)
        invalid = self.initialize("b" * 64)
        self.assertEqual(invalid.status_code, 409)
        self.assertEqual(invalid.json()["code"], "PLANNING_READING_BLOCKED")
        self.assertIsNone(self.service.snapshot().goal_profile)

    def test_delete_keeps_requirement_blocked_and_cannot_resurrect_source(self):
        self.register()
        self.ready()
        self.materials.delete(self.id, self.owner)
        self.assertEqual(self.initialize().json()["code"], "PLANNING_READING_BLOCKED")
        self.assertFalse((self.materials.root / self.id).exists())
        self.assertIsNone(self.service.snapshot().goal_profile)

    def test_actual_draft_scope_forgery_clear_in_same_turn_and_unknown_storage_are_rejected(self):
        self.register()
        with self.assertRaises(MaterialError):
            self.planning.register(self.owner, "another-session", "c" * 64, "actual-user", "goal-lab", "a" * 64, [self.id])
        with self.assertRaises(MaterialError):
            self.planning.register(self.owner, self.session, "c" * 64, "actual-user-1", "goal-lab", retrieval.checksum(plan()["goal_profile"]), [])
        path = self.planning._path(self.session)
        value = json.loads(path.read_text(encoding="utf-8"))
        value["version"] = 99
        path.write_text(json.dumps(value), encoding="utf-8")
        before = path.read_bytes()
        self.assertEqual(self.initialize().status_code, 503)
        with self.assertRaises(MaterialError):
            self.planning.register(self.owner, self.session, "d" * 64, "actual-user-3", "goal-lab", "a" * 64, [])
        self.assertEqual(path.read_bytes(), before)

    def test_delete_cannot_interleave_between_final_reading_check_and_kernel_write(self):
        self.register()
        self.ready()
        entered, release, deletion_started = Event(), Event(), Event()
        actual = self.service.initialize_curriculum
        def slow(*args, **kwargs):
            entered.set()
            self.assertTrue(release.wait(5))
            return actual(*args, **kwargs)
        def delete():
            deletion_started.set()
            return self.materials.delete(self.id, self.owner)
        with ThreadPoolExecutor(max_workers=2) as pool, patch.object(self.service, "initialize_curriculum", side_effect=slow):
            pending = pool.submit(self.initialize)
            self.assertTrue(entered.wait(3))
            deleted = pool.submit(delete)
            self.assertTrue(deletion_started.wait(1))
            with self.assertRaises(TimeoutError):
                deleted.result(timeout=.1)
            release.set()
            result = pending.result(timeout=4)
            self.assertEqual(result.status_code, 201, result.text)
            deleted.result(timeout=4)
        self.assertEqual(self.service.snapshot().goal_profile.id, "goal-lab")
        self.assertFalse((self.materials.root / self.id).exists())

    def test_crash_after_kernel_save_recovers_receipt_without_reinitializing_or_changing_learning_facts(self):
        self.register()
        self.ready()
        with patch.object(MaterialPlanningStore, "complete", side_effect=OSError("synthetic receipt failure")):
            self.assertEqual(self.initialize().status_code, 503)
        before = deepcopy(self.service.snapshot())
        with patch.object(self.service, "initialize_curriculum", side_effect=AssertionError("must not initialize twice")):
            result = self.initialize()
        self.assertEqual(result.status_code, 201, result.text)
        self.assertEqual(self.service.snapshot(), before)
        self.assertEqual(self.planning.get(self.owner, self.session, "a" * 64)["state"], "COMPLETED")

    def test_in_memory_proposal_after_save_failure_is_not_acknowledged_until_original_persistence_succeeds(self):
        self.register()
        self.ready()
        writes = []
        def unavailable(service):
            writes.append(service.snapshot())
            raise OSError("synthetic disk failure")
        self.service.enable_auto_save(unavailable)
        self.assertEqual(self.initialize().status_code, 503)
        self.assertEqual(self.initialize().status_code, 503, "must not turn an unsaved memory snapshot into a successful receipt")
        self.assertEqual(self.planning.get(self.owner, self.session, "a" * 64)["state"], "OPEN")
        saved = []
        self.service.enable_auto_save(lambda service: saved.append(service.snapshot()))
        self.assertEqual(self.initialize().status_code, 201)
        self.assertEqual(len(saved), 1)
        self.assertEqual(len(writes), 2)

    def test_recovery_only_cannot_create_a_new_goal_even_when_sources_are_ready(self):
        self.register()
        self.ready()
        before = deepcopy(self.service.snapshot())
        response = self.initialize(recover_only=True)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "PLANNING_RECOVERY_REQUIRED")
        self.assertEqual(self.service.snapshot(), before)

    def test_crash_before_draft_binding_recovers_only_the_original_route_without_duplicate_history(self):
        self.register()
        self.ready()
        with patch.object(self.materials, "bind_draft", side_effect=OSError("synthetic bind failure")):
            self.assertEqual(self.initialize().status_code, 503)
        before = deepcopy(self.service.snapshot())
        self.assertEqual(before.goal_profile.id, "goal-lab")
        different = self.initialize(recover_only=True, frontier={**plan()["frontier"], "reason": "另一份路线"})
        self.assertEqual(different.status_code, 409)
        self.assertEqual(self.service.snapshot(), before)
        self.assertEqual(self.initialize(recover_only=True).status_code, 201)
        self.assertEqual(self.service.snapshot(), before)
        self.assertEqual(before.learning_history, ())

    def test_crash_before_binding_recovers_without_runtime_preference_revision(self):
        self.register()
        self.ready()
        revision = "b" * 64
        with patch.object(self.materials, "bind_draft", side_effect=OSError("synthetic bind failure")):
            response = self.initialize(frontier={**plan()["frontier"], "teaching_preferences_revision": revision})
        self.assertEqual(response.status_code, 503, response.text)
        before = deepcopy(self.service.snapshot())
        self.assertEqual(before.frontier.teaching_preferences_revision, revision)
        with patch.object(self.service, "initialize_curriculum", side_effect=AssertionError("must not initialize twice")):
            # 恢复来源是模型原toolCall，不能要求它携带Node运行时后来注入的偏好版本。
            recovered = self.initialize(recover_only=True)
            self.assertEqual(recovered.status_code, 201, recovered.text)
            cached = self.initialize(recover_only=True)
            self.assertEqual(cached.status_code, 201, cached.text)
        self.assertEqual(recovered.json()["frontier"]["teaching_preferences_revision"], revision)
        self.assertEqual(cached.json(), recovered.json())
        self.assertEqual(self.service.snapshot(), before)
        self.assertEqual(before.learning_history, ())
        self.assertEqual(self.planning.get(self.owner, self.session, "a" * 64)["state"], "COMPLETED")
