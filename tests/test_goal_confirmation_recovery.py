"""无资料目标确认的真实Kernel回执恢复；全部使用临时目录与空账本。"""
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from app.api.main import app, get_learning_service, get_material_store
from app.bootstrap import build_empty_learning_service
from app.materials import MaterialStore
from tests.test_material_planning import plan


class GoalConfirmationRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="lawa-goal-recovery-")
        self.materials = MaterialStore(Path(self.tmp.name) / "materials")
        self.service = build_empty_learning_service()
        app.dependency_overrides[get_learning_service] = lambda: self.service
        app.dependency_overrides[get_material_store] = lambda: self.materials
        self.client = TestClient(app, raise_server_exceptions=False)
        self.payload = {**plan(), "onboarding_session_id": "real-draft-session"}

    def tearDown(self):
        self.client.close()
        app.dependency_overrides.clear()
        self.materials.close()
        self.tmp.cleanup()

    def submit(self, **changes):
        return self.client.post("/api/learning/curriculum/initialize", json={**self.payload, **changes})

    def test_query_missing_result_never_creates_a_goal(self):
        response = self.submit(recover_only=True)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["code"], "PLANNING_RESULT_NOT_FOUND")
        self.assertEqual(self.client.get("/api/learning/library").json()["projects"], [])

    def test_lost_response_replays_authoritative_result_without_second_initialize(self):
        with patch.object(self.service, "initialize_curriculum", wraps=self.service.initialize_curriculum) as create:
            saved = self.submit()
            self.assertEqual(saved.status_code, 201)
            # 客户端未收到第一次回包；必须查询现存结果，不把同一目标重建为新历史。
            recovered = self.submit(recover_only=True)
            repeated = self.submit(recover_only=True)
            self.assertEqual(recovered.status_code, 201)
            self.assertEqual(recovered.json(), saved.json())
            self.assertEqual(repeated.json(), saved.json())
            self.assertEqual(create.call_count, 1)
        self.assertEqual(len(self.client.get("/api/learning/library").json()["projects"]), 1)

    def test_changed_payload_is_not_a_recovery_receipt(self):
        self.assertEqual(self.submit().status_code, 201)
        changed = deepcopy(self.payload["frontier"])
        changed["next_action"] = "不同路线"
        self.assertEqual(self.submit(recover_only=True, frontier=changed).status_code, 409)
        self.assertEqual(self.service.snapshot().frontier.next_action, self.payload["frontier"]["next_action"])

    def test_another_session_cannot_claim_the_saved_result(self):
        self.assertEqual(self.submit().status_code, 201)
        response = self.submit(recover_only=True, onboarding_session_id="another-session-never-confirmed")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "PLANNING_RECOVERY_REQUIRED")

    def test_validation_rejection_keeps_authority_empty(self):
        self.assertEqual(self.submit(curriculum_spine=self.payload["curriculum_spine"][:2]).status_code, 422)
        self.assertIsNone(self.service.snapshot().goal_profile)

    def test_in_memory_state_is_not_acknowledged_when_persistence_fails(self):
        self.assertEqual(self.submit().status_code, 201)
        with patch.object(self.service, "ensure_state_saved", side_effect=OSError("isolated disk failure")):
            self.assertEqual(self.submit(recover_only=True).status_code, 503)

    def test_failed_initial_save_does_not_publish_an_in_memory_goal(self):
        before = self.service.snapshot()
        self.service.enable_auto_save(lambda _: (_ for _ in ()).throw(OSError("isolated initial save failure")))
        self.assertEqual(self.submit().status_code, 503)
        self.assertEqual(self.service.snapshot(), before)
        self.assertEqual(self.client.get("/api/learning/library").json()["projects"], [])


if __name__ == "__main__":
    unittest.main()
