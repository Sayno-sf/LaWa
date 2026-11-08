"""The software edition preserves old device receipts without exposing device writes."""

from dataclasses import replace
from datetime import datetime
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from uuid import uuid4

from fastapi.testclient import TestClient

from app.api.main import app, get_learning_service
from app.application import LearningService
from app.domain import CardFeedbackStatus, GoalProfile, KnowledgeCard, SkillGraph, SkillNode, SkillState
from app.domain.hardware_feedback import HardwareFeedbackEvent, HardwareFeedbackReceipt, HardwareFeedbackState
from app.persistence import JsonLearningStateStore


def learner(hardware_feedback=None, card=None):
    return LearningService(
        SkillGraph([SkillNode("skill", "Skill", status=SkillState.LEARNING)]),
        goal_profile=GoalProfile("goal", "Goal", "Background", "Outcome"),
        current_goal_skill_ids=("skill",),
        knowledge_cards=(card or KnowledgeCard("card", "skill", "Question", "Answer", datetime(2026, 1, 1)),),
        hardware_feedback=hardware_feedback,
    )


class LegacyDeviceLedgerTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = JsonLearningStateStore(Path(directory.name) / "state.json")

    def test_device_routes_are_absent(self):
        self.store.save(learner())
        original = self.store.path.read_bytes()
        app.dependency_overrides[get_learning_service] = self.store.load
        self.addCleanup(app.dependency_overrides.clear)
        with TestClient(app) as client:
            self.assertEqual(client.post("/api/user/hardware/identity").status_code, 404)
            self.assertEqual(client.post("/api/user/hardware/card-feedback", json={}).status_code, 404)
        self.assertEqual(self.store.path.read_bytes(), original)

    def test_existing_receipts_and_card_revision_survive_software_feedback(self):
        owner, device, event_id = (str(uuid4()) for _ in range(3))
        event = HardwareFeedbackEvent(owner, device, event_id, "goal", "card", "a" * 64, 0, "KNOWN", True)
        receipt = HardwareFeedbackReceipt(event, "saved", None, 1, "2026-01-01T00:00:00+00:00")
        legacy = HardwareFeedbackState(owner, (receipt,))
        card = learner().get_knowledge_card("card")
        self.store.save(learner(legacy, replace(card, feedback=CardFeedbackStatus.KNOWN, feedback_revision=1)))

        service = self.store.load()
        self.assertEqual(service.snapshot().hardware_feedback, legacy)
        self.assertEqual(service.get_knowledge_card("card").feedback_revision, 1)
        service.set_card_feedback_by_user("card", CardFeedbackStatus.UNSURE)
        self.store.save(service)
        restored = self.store.load()
        self.assertEqual(restored.snapshot().hardware_feedback, legacy)
        self.assertEqual(restored.get_knowledge_card("card").feedback, CardFeedbackStatus.UNSURE)
        self.assertEqual(restored.get_knowledge_card("card").feedback_revision, 2)

    def test_v7_card_feedback_keeps_value_when_migrated(self):
        self.store.save(learner())
        service = self.store.load()
        service.set_card_feedback_by_user("card", CardFeedbackStatus.UNSURE)
        self.store.save(service)
        payload = json.loads(self.store.path.read_text(encoding="utf-8"))
        payload["version"] = 7
        payload.pop("hardware_feedback")
        payload["knowledge_cards"][0].pop("feedback_revision")
        self.store.path.write_text(json.dumps(payload), encoding="utf-8")
        restored = self.store.load()
        self.assertEqual(restored.get_knowledge_card("card").feedback, CardFeedbackStatus.UNSURE)
        self.assertEqual(restored.get_knowledge_card("card").feedback_revision, 0)
        self.assertTrue(self.store.path.with_name("state.json.v7.bak").exists())
