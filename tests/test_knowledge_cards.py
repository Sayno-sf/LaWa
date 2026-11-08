"""Sprint 7 Phase 1: Knowledge Cards, Card Feedback and Learner Notes.

Covers domain invariants, LearningService use cases, persistence round-trip
and backward compatibility, API contract, and the critical permission
boundary: cards/feedback/notes never create Evidence, change SkillState,
or trigger Mastery.
"""

import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from app.api.main import app, get_learning_service
from app.application import LearningService
from app.domain import (
    CardFeedbackStatus,
    KnowledgeCard,
    SkillGraph,
    SkillNode,
    SkillState,
)
from app.persistence import JsonLearningStateStore


# ── Helpers ──────────────────────────────────────────────────────────


def make_service() -> LearningService:
    return LearningService(
        SkillGraph(
            [
                SkillNode("attention", "Attention Mechanism"),
                SkillNode("transformer", "Transformer", prerequisites=("attention",)),
            ]
        )
    )


def make_card(
    card_id: str = "card-1",
    skill_id: str = "attention",
    question: str = "为什么 Attention 要除以 √d_k？",
    answer: str = "避免点积过大导致 Softmax 饱和。",
) -> KnowledgeCard:
    return KnowledgeCard(
        id=card_id,
        skill_id=skill_id,
        question=question,
        answer=answer,
        created_at=datetime(2026, 9, 22, 12, 0, 0),
    )


# ── Domain Tests ─────────────────────────────────────────────────────


class KnowledgeCardDomainTests(unittest.TestCase):
    def test_create_valid_card(self) -> None:
        card = make_card()
        self.assertEqual(card.id, "card-1")
        self.assertEqual(card.skill_id, "attention")
        self.assertIsNone(card.feedback)
        self.assertIsNone(card.learner_note)

    def test_empty_question_rejected(self) -> None:
        with self.assertRaises(ValueError):
            KnowledgeCard(
                id="c1", skill_id="attention", question="   ", answer="ans",
                created_at=datetime.now(),
            )

    def test_empty_answer_rejected(self) -> None:
        with self.assertRaises(ValueError):
            KnowledgeCard(
                id="c1", skill_id="attention", question="q", answer="",
                created_at=datetime.now(),
            )

    def test_empty_id_rejected(self) -> None:
        with self.assertRaises(ValueError):
            KnowledgeCard(
                id="  ", skill_id="attention", question="q", answer="a",
                created_at=datetime.now(),
            )

    def test_empty_skill_id_rejected(self) -> None:
        with self.assertRaises(ValueError):
            KnowledgeCard(
                id="c1", skill_id="", question="q", answer="a",
                created_at=datetime.now(),
            )

    def test_source_conversation_id_optional(self) -> None:
        card = KnowledgeCard(
            id="c1", skill_id="attention", question="q", answer="a",
            created_at=datetime.now(), source_conversation_id="conv-abc",
        )
        self.assertEqual(card.source_conversation_id, "conv-abc")

    def test_set_feedback_returns_new_object(self) -> None:
        card = make_card()
        updated = card.set_feedback(CardFeedbackStatus.KNOWN)
        self.assertIsNot(updated, card)
        self.assertEqual(updated.feedback, CardFeedbackStatus.KNOWN)
        self.assertIsNotNone(updated.feedback_updated_at)
        self.assertIsNone(card.feedback)

    def test_set_note_returns_new_object(self) -> None:
        card = make_card()
        updated = card.set_note("我容易忘记为什么是平方根")
        self.assertIsNot(updated, card)
        self.assertEqual(updated.learner_note, "我容易忘记为什么是平方根")
        self.assertIsNotNone(updated.note_updated_at)
        self.assertIsNone(card.learner_note)

    def test_set_empty_note_rejected(self) -> None:
        card = make_card()
        with self.assertRaises(ValueError):
            card.set_note("   ")

    def test_clear_note_returns_new_object(self) -> None:
        card = make_card().set_note("note")
        cleared = card.clear_note()
        self.assertIsNot(cleared, card)
        self.assertIsNone(cleared.learner_note)
        self.assertIsNotNone(cleared.note_updated_at)


# ── LearningService Tests ────────────────────────────────────────────


class LearningServiceCardTests(unittest.TestCase):
    def test_create_valid_card(self) -> None:
        service = make_service()
        card = service.create_knowledge_card(make_card())
        self.assertEqual(card.id, "card-1")
        self.assertEqual(service.get_knowledge_card("card-1"), card)

    def test_invalid_skill_reference_rejected(self) -> None:
        service = make_service()
        bad = KnowledgeCard(
            id="c1", skill_id="nonexistent", question="q", answer="a",
            created_at=datetime.now(),
        )
        with self.assertRaises(KeyError):
            service.create_knowledge_card(bad)

    def test_duplicate_card_id_rejected(self) -> None:
        service = make_service()
        service.create_knowledge_card(make_card())
        with self.assertRaisesRegex(ValueError, "Duplicate KnowledgeCard"):
            service.create_knowledge_card(make_card())

    def test_list_cards_by_skill(self) -> None:
        service = make_service()
        c1 = make_card("card-1", "attention")
        c2 = make_card("card-2", "transformer")
        c3 = make_card("card-3", "attention")
        service.create_knowledge_card(c1)
        service.create_knowledge_card(c2)
        service.create_knowledge_card(c3)
        attention_cards = service.get_knowledge_cards_for_skill("attention")
        self.assertEqual(len(attention_cards), 2)
        self.assertEqual({c.id for c in attention_cards}, {"card-1", "card-3"})

    def test_list_cards_for_unknown_skill_rejected(self) -> None:
        service = make_service()
        with self.assertRaises(KeyError):
            service.get_knowledge_cards_for_skill("unknown")

    def test_get_all_cards(self) -> None:
        service = make_service()
        service.create_knowledge_card(make_card("card-1"))
        service.create_knowledge_card(make_card("card-2", "transformer"))
        self.assertEqual(len(service.get_all_knowledge_cards()), 2)

    def test_get_unknown_card_rejected(self) -> None:
        service = make_service()
        with self.assertRaises(KeyError):
            service.get_knowledge_card("nope")


class LearningServiceCardFeedbackTests(unittest.TestCase):
    def test_set_feedback_known(self) -> None:
        service = make_service()
        service.create_knowledge_card(make_card())
        updated = service.set_card_feedback_by_user("card-1", CardFeedbackStatus.KNOWN)
        self.assertEqual(updated.feedback, CardFeedbackStatus.KNOWN)
        self.assertIsNotNone(updated.feedback_updated_at)

    def test_set_feedback_unsure(self) -> None:
        service = make_service()
        service.create_knowledge_card(make_card())
        updated = service.set_card_feedback_by_user("card-1", CardFeedbackStatus.UNSURE)
        self.assertEqual(updated.feedback, CardFeedbackStatus.UNSURE)

    def test_set_feedback_unknown(self) -> None:
        service = make_service()
        service.create_knowledge_card(make_card())
        updated = service.set_card_feedback_by_user("card-1", CardFeedbackStatus.UNKNOWN)
        self.assertEqual(updated.feedback, CardFeedbackStatus.UNKNOWN)

    def test_feedback_can_be_overwritten(self) -> None:
        service = make_service()
        service.create_knowledge_card(make_card())
        service.set_card_feedback_by_user("card-1", CardFeedbackStatus.UNKNOWN)
        updated = service.set_card_feedback_by_user("card-1", CardFeedbackStatus.KNOWN)
        self.assertEqual(updated.feedback, CardFeedbackStatus.KNOWN)

    def test_feedback_unknown_card_rejected(self) -> None:
        service = make_service()
        with self.assertRaises(KeyError):
            service.set_card_feedback_by_user("nope", CardFeedbackStatus.KNOWN)


class LearningServiceCardNoteTests(unittest.TestCase):
    def test_set_note(self) -> None:
        service = make_service()
        service.create_knowledge_card(make_card())
        updated = service.set_card_note_by_user("card-1", "我的理解：防止梯度消失")
        self.assertEqual(updated.learner_note, "我的理解：防止梯度消失")
        self.assertIsNotNone(updated.note_updated_at)

    def test_edit_note(self) -> None:
        service = make_service()
        service.create_knowledge_card(make_card())
        service.set_card_note_by_user("card-1", "v1")
        updated = service.set_card_note_by_user("card-1", "v2 revised")
        self.assertEqual(updated.learner_note, "v2 revised")

    def test_clear_note(self) -> None:
        service = make_service()
        service.create_knowledge_card(make_card())
        service.set_card_note_by_user("card-1", "some note")
        cleared = service.clear_card_note_by_user("card-1")
        self.assertIsNone(cleared.learner_note)

    def test_note_unknown_card_rejected(self) -> None:
        service = make_service()
        with self.assertRaises(KeyError):
            service.set_card_note_by_user("nope", "note")


class LearningServiceCardPermissionBoundaryTests(unittest.TestCase):
    """Critical: cards/feedback/notes must never leak into Evidence or SkillState."""

    def test_card_creation_does_not_create_evidence(self) -> None:
        service = make_service()
        service.create_knowledge_card(make_card())
        self.assertEqual(len(service.get_evidence_for_skill("attention")), 0)

    def test_card_creation_does_not_change_skill_state(self) -> None:
        service = make_service()
        before = service.get_skill("attention").status
        service.create_knowledge_card(make_card())
        self.assertEqual(service.get_skill("attention").status, before)

    def test_feedback_does_not_create_evidence(self) -> None:
        service = make_service()
        service.create_knowledge_card(make_card())
        service.set_card_feedback_by_user("card-1", CardFeedbackStatus.KNOWN)
        self.assertEqual(len(service.get_evidence_for_skill("attention")), 0)

    def test_feedback_does_not_change_skill_state(self) -> None:
        service = make_service()
        service.create_knowledge_card(make_card())
        service.set_card_feedback_by_user("card-1", CardFeedbackStatus.KNOWN)
        self.assertEqual(service.get_skill("attention").status, SkillState.NOT_STARTED)

    def test_known_feedback_does_not_trigger_mastery(self) -> None:
        service = make_service()
        service.create_knowledge_card(make_card())
        service.set_card_feedback_by_user("card-1", CardFeedbackStatus.KNOWN)
        self.assertNotEqual(service.get_skill("attention").status, SkillState.MASTERED_BY_USER)

    def test_note_does_not_create_evidence(self) -> None:
        service = make_service()
        service.create_knowledge_card(make_card())
        service.set_card_note_by_user("card-1", "my note")
        self.assertEqual(len(service.get_evidence_for_skill("attention")), 0)

    def test_note_does_not_change_skill_state(self) -> None:
        service = make_service()
        service.create_knowledge_card(make_card())
        service.set_card_note_by_user("card-1", "my note")
        self.assertEqual(service.get_skill("attention").status, SkillState.NOT_STARTED)

    def test_overview_includes_cards(self) -> None:
        service = make_service()
        service.create_knowledge_card(make_card())
        overview = service.get_learning_overview()
        self.assertEqual(len(overview.knowledge_cards), 1)
        self.assertEqual(overview.knowledge_cards[0].id, "card-1")

    def test_library_project_includes_cards_separate_from_evidence(self) -> None:
        from app.domain import GoalProfile
        service = LearningService(
            SkillGraph([SkillNode("attention", "Attention")]),
            goal_profile=GoalProfile(
                id="g1", goal_description="test goal", background_summary="bg",
                desired_outcome="outcome", created_at=datetime.now(),
            ),
            current_goal_skill_ids=("attention",),
        )
        service.create_knowledge_card(make_card(skill_id="attention"))
        library = service.get_learning_library()
        self.assertEqual(len(library.projects), 1)
        project = library.projects[0]
        self.assertEqual(len(project.knowledge_cards), 1)
        self.assertEqual(len(project.evidence), 0)


# ── Persistence Tests ────────────────────────────────────────────────


class KnowledgeCardPersistenceTests(unittest.TestCase):
    def test_round_trip_persistence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            service = make_service()
            store = JsonLearningStateStore(path)
            store.bind(service)
            service.create_knowledge_card(make_card())
            service.set_card_feedback_by_user("card-1", CardFeedbackStatus.UNSURE)
            service.set_card_note_by_user("card-1", "persisted note")

            restored = JsonLearningStateStore(path).load()
            self.assertIsNotNone(restored)
            card = restored.get_knowledge_card("card-1")
            self.assertEqual(card.question, "为什么 Attention 要除以 √d_k？")
            self.assertEqual(card.feedback, CardFeedbackStatus.UNSURE)
            self.assertEqual(card.learner_note, "persisted note")

    def test_old_snapshot_without_cards_loads_successfully(self) -> None:
        """A snapshot written before Sprint 7 has no knowledge_cards key."""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            # Build a minimal old-format snapshot manually (no knowledge_cards key).
            old_payload = {
                "version": 1,
                "current_goal": "Deep Learning",
                "goal_profile": None,
                "curriculum_spine": [],
                "frontier": None,
                "skills": [
                    {
                        "id": "attention", "name": "Attention", "description": "",
                        "prerequisites": [], "status": "NOT_STARTED",
                        "evidence_ids": [], "target_depth": "PRACTICAL",
                    }
                ],
                "evidence": [],
                "tasks": [],
                "learning_history": [],
                "current_goal_skill_ids": [],
            }
            path.write_text(json.dumps(old_payload), encoding="utf-8")
            restored = JsonLearningStateStore(path).load()
            self.assertIsNotNone(restored)
            self.assertEqual(restored.get_all_knowledge_cards(), ())
            # Can still create cards after loading old snapshot.
            restored.create_knowledge_card(make_card())
            self.assertEqual(len(restored.get_all_knowledge_cards()), 1)

    def test_feedback_survives_restart(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            service = make_service()
            JsonLearningStateStore(path).bind(service)
            service.create_knowledge_card(make_card())
            service.set_card_feedback_by_user("card-1", CardFeedbackStatus.UNKNOWN)

            restored = JsonLearningStateStore(path).load()
            self.assertEqual(
                restored.get_knowledge_card("card-1").feedback,
                CardFeedbackStatus.UNKNOWN,
            )

    def test_note_survives_restart(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            service = make_service()
            JsonLearningStateStore(path).bind(service)
            service.create_knowledge_card(make_card())
            service.set_card_note_by_user("card-1", "survive me")

            restored = JsonLearningStateStore(path).load()
            self.assertEqual(
                restored.get_knowledge_card("card-1").learner_note,
                "survive me",
            )

    def test_cards_survive_goal_archive(self) -> None:
        """Cards linked to a Skill must persist when that Goal is archived.

        We simulate the post-archive state: a service with learning_history
        and the original Skill still present. Cards must survive save/load.
        """
        from app.domain import (
            ArchivedLearningProject, GoalProfile,
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            archived = ArchivedLearningProject(
                goal_profile=GoalProfile(
                    id="old-goal", goal_description="Old Goal",
                    background_summary="old bg", desired_outcome="old outcome",
                    created_at=datetime(2026, 1, 1),
                ),
                curriculum_spine=(),
                skill_ids=("attention",),
                archived_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
            )
            service = LearningService(
                SkillGraph([SkillNode("attention", "Attention")]),
                goal_profile=GoalProfile(
                    id="new-goal", goal_description="New Goal",
                    background_summary="new bg", desired_outcome="new outcome",
                    created_at=datetime(2026, 6, 1),
                ),
                learning_history=(archived,),
                current_goal_skill_ids=(),
            )
            JsonLearningStateStore(path).bind(service)
            # Card linked to the archived-goal Skill.
            service.create_knowledge_card(make_card(skill_id="attention"))

            # Card still exists.
            self.assertEqual(len(service.get_all_knowledge_cards()), 1)
            self.assertEqual(service.get_knowledge_card("card-1").skill_id, "attention")

            # And it survives restart.
            restored = JsonLearningStateStore(path).load()
            self.assertEqual(len(restored.get_all_knowledge_cards()), 1)
            self.assertEqual(len(restored.snapshot().learning_history), 1)


# ── API Tests ─────────────────────────────────────────────────────────


class KnowledgeCardApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.service = make_service()
        app.dependency_overrides[get_learning_service] = lambda: self.service
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()

    def test_create_card_through_agent_path(self) -> None:
        response = self.client.post(
            "/api/learning/cards",
            json={
                "skill_id": "attention",
                "question": "为什么除以 √d_k？",
                "answer": "避免 Softmax 饱和",
            },
        )
        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertTrue(body["id"].startswith("card-"))
        self.assertEqual(body["skill_id"], "attention")
        self.assertIsNone(body["feedback"])
        self.assertIsNone(body["learner_note"])

    def test_create_card_with_source_conversation_id(self) -> None:
        response = self.client.post(
            "/api/learning/cards",
            json={
                "skill_id": "attention",
                "question": "q",
                "answer": "a",
                "source_conversation_id": "conv-123",
            },
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["source_conversation_id"], "conv-123")

    def test_create_card_invalid_skill_returns_404(self) -> None:
        response = self.client.post(
            "/api/learning/cards",
            json={"skill_id": "nope", "question": "q", "answer": "a"},
        )
        self.assertEqual(response.status_code, 404)

    def test_create_card_empty_question_returns_422(self) -> None:
        response = self.client.post(
            "/api/learning/cards",
            json={"skill_id": "attention", "question": "   ", "answer": "a"},
        )
        self.assertEqual(response.status_code, 422)

    def test_create_card_empty_answer_returns_422(self) -> None:
        response = self.client.post(
            "/api/learning/cards",
            json={"skill_id": "attention", "question": "q", "answer": ""},
        )
        self.assertEqual(response.status_code, 422)

    def test_list_cards_by_skill(self) -> None:
        self.client.post(
            "/api/learning/cards",
            json={"skill_id": "attention", "question": "q1", "answer": "a1"},
        )
        self.client.post(
            "/api/learning/cards",
            json={"skill_id": "transformer", "question": "q2", "answer": "a2"},
        )
        response = self.client.get("/api/learning/cards", params={"skill_id": "attention"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()), 1)
        self.assertEqual(response.json()[0]["question"], "q1")

    def test_list_all_cards(self) -> None:
        self.client.post(
            "/api/learning/cards",
            json={"skill_id": "attention", "question": "q1", "answer": "a1"},
        )
        response = self.client.get("/api/learning/cards")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()), 1)

    def test_list_cards_unknown_skill_returns_404(self) -> None:
        response = self.client.get("/api/learning/cards", params={"skill_id": "nope"})
        self.assertEqual(response.status_code, 404)

    def test_get_single_card(self) -> None:
        create_resp = self.client.post(
            "/api/learning/cards",
            json={"skill_id": "attention", "question": "q", "answer": "a"},
        )
        card_id = create_resp.json()["id"]
        response = self.client.get(f"/api/learning/cards/{card_id}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["id"], card_id)

    def test_get_unknown_card_returns_404(self) -> None:
        response = self.client.get("/api/learning/cards/nope")
        self.assertEqual(response.status_code, 404)

    def test_update_user_feedback(self) -> None:
        create_resp = self.client.post(
            "/api/learning/cards",
            json={"skill_id": "attention", "question": "q", "answer": "a"},
        )
        card_id = create_resp.json()["id"]
        response = self.client.post(
            f"/api/user/cards/{card_id}/feedback",
            json={"status": "KNOWN"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["feedback"], "KNOWN")
        self.assertIsNotNone(response.json()["feedback_updated_at"])

    def test_update_feedback_all_statuses(self) -> None:
        create_resp = self.client.post(
            "/api/learning/cards",
            json={"skill_id": "attention", "question": "q", "answer": "a"},
        )
        card_id = create_resp.json()["id"]
        for status in ("KNOWN", "UNSURE", "UNKNOWN"):
            response = self.client.post(
                f"/api/user/cards/{card_id}/feedback",
                json={"status": status},
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["feedback"], status)

    def test_hardware_feedback_rejects_content_edited_after_confirmation(self) -> None:
        created = self.client.post("/api/learning/cards", json={"skill_id":"attention", "question":"原问题", "answer":"原答案"}).json()
        card_id = created["id"]
        self.client.put(f"/api/user/cards/{card_id}", json={"question":"修改问题", "answer":"修改答案"})
        response = self.client.post(f"/api/user/cards/{card_id}/feedback", json={"status":"KNOWN",
            "expected_content":{"skill_id":"attention", "question":"原问题", "answer":"原答案"}})
        self.assertEqual(response.status_code, 409)
        current = self.client.get(f"/api/learning/cards/{card_id}").json()
        self.assertIsNone(current["feedback"])
        self.assertEqual(current["answer"], "修改答案")
        accepted = self.client.post(f"/api/user/cards/{card_id}/feedback", json={"status":"UNSURE",
            "expected_content":{"skill_id":"attention", "question":"修改问题", "answer":"修改答案"}})
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(accepted.json()["feedback"], "UNSURE")

    def test_update_feedback_unknown_card_returns_404(self) -> None:
        response = self.client.post(
            "/api/user/cards/nope/feedback",
            json={"status": "KNOWN"},
        )
        self.assertEqual(response.status_code, 404)

    def test_update_user_note(self) -> None:
        create_resp = self.client.post(
            "/api/learning/cards",
            json={"skill_id": "attention", "question": "q", "answer": "a"},
        )
        card_id = create_resp.json()["id"]
        response = self.client.put(
            f"/api/user/cards/{card_id}/note",
            json={"note": "我的笔记内容"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["learner_note"], "我的笔记内容")
        self.assertIsNotNone(response.json()["note_updated_at"])

    def test_clear_user_note(self) -> None:
        create_resp = self.client.post(
            "/api/learning/cards",
            json={"skill_id": "attention", "question": "q", "answer": "a"},
        )
        card_id = create_resp.json()["id"]
        self.client.put(
            f"/api/user/cards/{card_id}/note",
            json={"note": "temporary"},
        )
        response = self.client.delete(f"/api/user/cards/{card_id}/note")
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["learner_note"])

    def test_invalid_card_returns_safe_error(self) -> None:
        response = self.client.post(
            "/api/user/cards/not-a-card/feedback",
            json={"status": "KNOWN"},
        )
        self.assertEqual(response.status_code, 404)
        self.assertIn("detail", response.json())

    def test_feedback_does_not_create_evidence_via_api(self) -> None:
        create_resp = self.client.post(
            "/api/learning/cards",
            json={"skill_id": "attention", "question": "q", "answer": "a"},
        )
        card_id = create_resp.json()["id"]
        self.client.post(
            f"/api/user/cards/{card_id}/feedback",
            json={"status": "KNOWN"},
        )
        overview = self.client.get("/api/learning/overview").json()
        self.assertEqual(len(overview["recent_evidence"]), 0)

    def test_overview_includes_knowledge_cards(self) -> None:
        self.client.post(
            "/api/learning/cards",
            json={"skill_id": "attention", "question": "q", "answer": "a"},
        )
        overview = self.client.get("/api/learning/overview").json()
        self.assertEqual(len(overview["knowledge_cards"]), 1)
        self.assertEqual(overview["knowledge_cards"][0]["question"], "q")



class LearningServiceCardDeleteUpdateTests(unittest.TestCase):
    def test_delete_card_by_user(self) -> None:
        service = make_service()
        service.create_knowledge_card(make_card())
        self.assertEqual(len(service.get_all_knowledge_cards()), 1)
        service.delete_knowledge_card_by_user("card-1")
        self.assertEqual(len(service.get_all_knowledge_cards()), 0)

    def test_delete_unknown_card_rejected(self) -> None:
        service = make_service()
        with self.assertRaises(KeyError):
            service.delete_knowledge_card_by_user("nope")

    def test_update_card_content_by_user(self) -> None:
        service = make_service()
        service.create_knowledge_card(make_card())
        updated = service.update_knowledge_card_by_user(
            "card-1", "新问题？", "新答案。"
        )
        self.assertEqual(updated.question, "新问题？")
        self.assertEqual(updated.answer, "新答案。")
        self.assertIsNone(updated.feedback)
        self.assertIsNone(updated.learner_note)

    def test_update_preserves_feedback_and_note(self) -> None:
        service = make_service()
        service.create_knowledge_card(make_card())
        service.set_card_feedback_by_user("card-1", CardFeedbackStatus.KNOWN)
        service.set_card_note_by_user("card-1", "my note")
        updated = service.update_knowledge_card_by_user("card-1", "q2", "a2")
        self.assertEqual(updated.feedback, CardFeedbackStatus.KNOWN)
        self.assertEqual(updated.learner_note, "my note")

    def test_update_empty_question_rejected(self) -> None:
        service = make_service()
        service.create_knowledge_card(make_card())
        with self.assertRaises(ValueError):
            service.update_knowledge_card_by_user("card-1", "   ", "a")

    def test_update_empty_answer_rejected(self) -> None:
        service = make_service()
        service.create_knowledge_card(make_card())
        with self.assertRaises(ValueError):
            service.update_knowledge_card_by_user("card-1", "q", "")

    def test_update_unknown_card_rejected(self) -> None:
        service = make_service()
        with self.assertRaises(KeyError):
            service.update_knowledge_card_by_user("nope", "q", "a")

    def test_delete_does_not_create_evidence_or_change_skill_state(self) -> None:
        service = make_service()
        service.create_knowledge_card(make_card())
        service.delete_knowledge_card_by_user("card-1")
        self.assertEqual(len(service.get_evidence_for_skill("attention")), 0)
        self.assertEqual(service.get_skill("attention").status, SkillState.NOT_STARTED)


class KnowledgeCardDeleteUpdateApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.service = make_service()
        app.dependency_overrides[get_learning_service] = lambda: self.service
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()

    def _create_card(self) -> str:
        resp = self.client.post(
            "/api/learning/cards",
            json={"skill_id": "attention", "question": "q", "answer": "a"},
        )
        return resp.json()["id"]

    def test_delete_card_returns_204(self) -> None:
        card_id = self._create_card()
        response = self.client.delete(f"/api/user/cards/{card_id}")
        self.assertEqual(response.status_code, 204)
        get_resp = self.client.get(f"/api/learning/cards/{card_id}")
        self.assertEqual(get_resp.status_code, 404)

    def test_delete_unknown_card_returns_404(self) -> None:
        response = self.client.delete("/api/user/cards/nope")
        self.assertEqual(response.status_code, 404)

    def test_update_card_returns_updated(self) -> None:
        card_id = self._create_card()
        response = self.client.put(
            f"/api/user/cards/{card_id}",
            json={"question": "updated q", "answer": "updated a"},
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["question"], "updated q")
        self.assertEqual(body["answer"], "updated a")

    def test_update_empty_question_returns_422(self) -> None:
        card_id = self._create_card()
        response = self.client.put(
            f"/api/user/cards/{card_id}",
            json={"question": "   ", "answer": "a"},
        )
        self.assertEqual(response.status_code, 422)

    def test_update_unknown_card_returns_404(self) -> None:
        response = self.client.put(
            "/api/user/cards/nope",
            json={"question": "q", "answer": "a"},
        )
        self.assertEqual(response.status_code, 404)

    def test_delete_not_available_on_agent_path(self) -> None:
        card_id = self._create_card()
        response = self.client.delete(f"/api/learning/cards/{card_id}")
        self.assertEqual(response.status_code, 405)

if __name__ == "__main__":
    unittest.main()
