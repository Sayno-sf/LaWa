"""历史附件回看不激活Goal，不扩大资料权限，不写学习事实。"""
import io
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image
from pypdf import PdfWriter

from app.api.main import app, get_learning_service, get_material_store
from app.bootstrap import build_gradient_demo_learning_service
from app.domain import CurriculumMilestone, FrontierPlan, GoalProfile, LearningDepth, SkillNode
from app.materials import MaterialStore, MaterialError


class ConversationAttachmentPreviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = MaterialStore(self.root / "materials")
        self.service = build_gradient_demo_learning_service()
        self.goal = self.service.snapshot().goal_profile.id
        app.dependency_overrides[get_learning_service] = lambda: self.service
        app.dependency_overrides[get_material_store] = lambda: self.store
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()
        self.store.close()
        self.tmp.cleanup()

    def upload(self, owner=None, session="original-conversation", legacy=False):
        source = self.root / "source.txt"
        source.write_text("原文首尾，不应改变学习现场。", encoding="utf-8")
        return self.store.create(source, source.name, owner or self.goal,
                                 purpose="learning_material" if legacy else "conversation_attachment",
                                 conversation_id=None if legacy else session)

    def test_archived_read_and_delete_preserve_current_task_and_learning_state(self):
        row = self.upload()
        spine = tuple(CurriculumMilestone(f"second-{i}", f"Step {i}", "Practice", LearningDepth.PRACTICAL) for i in range(5))
        self.service.initialize_curriculum(GoalProfile("second-goal", "Second", "background", "outcome"), spine,
            (SkillNode("second-skill", "Second"),),
            FrontierPlan(focus_skill_id="second-skill", supporting_skill_ids=(), reason="reason",
                         target_depth=LearningDepth.PRACTICAL, suggested_learning_mode="BUILD", next_action="continue"),
            replace_existing=True)
        before = self.service.snapshot()
        path = f"/api/learning/conversation-attachments/{row['id']}"
        params = {"reference_session_id": "original-conversation", "reference_goal_id": self.goal}
        self.assertEqual(self.client.get(path + "/metadata", params=params).status_code, 200)
        self.assertIn("原文首尾", self.client.get(path, params=params).json()["text"])
        self.assertEqual(self.client.get(f"/api/learning/materials/{row['id']}/metadata",
                                        params={"expected_goal_id": self.goal}).status_code, 409)
        self.assertEqual(self.service.snapshot(), before)
        self.assertEqual(self.client.delete(path.replace("/learning/", "/user/"), params=params).status_code, 204)
        self.assertEqual(self.client.get(path + "/metadata", params=params).status_code, 404)
        self.assertEqual(self.service.snapshot(), before)

    def test_wrong_owner_is_rejected_and_bound_draft_keeps_original_reference(self):
        row = self.upload("draft:original-conversation")
        self.store.bind_draft("original-conversation", self.goal)
        self.assertEqual(self.store.conversation_reference_scope(row["id"], "original-conversation", None, {self.goal}), self.goal)
        for session, goal, available in [("other", None, {self.goal}), ("original-conversation", None, set()),
                                          ("other", "foreign-goal", {self.goal})]:
            with self.assertRaises(MaterialError):
                self.store.conversation_reference_scope(row["id"], session, goal, available)
        legacy = self.upload(legacy=True)
        self.assertEqual(self.store.conversation_reference_scope(legacy["id"], "legacy-session", self.goal, {self.goal}), self.goal)
        with self.assertRaises(MaterialError):
            self.store.conversation_reference_scope(legacy["id"], "legacy-session", None, {self.goal})

    def test_failed_pdf_text_still_previews_original_pages(self):
        source = self.root / "scan.pdf"
        writer = PdfWriter()
        for _ in range(4):
            writer.add_blank_page(width=300, height=300)
        writer.write(source)
        row = self.store.create(source, source.name, self.goal, purpose="conversation_attachment", conversation_id="original-conversation")
        path = f"/api/learning/conversation-attachments/{row['id']}"
        params = {"reference_session_id": "original-conversation", "reference_goal_id": self.goal}
        self.assertEqual(self.client.get(path + "/metadata", params=params).json()["unit_count"], 4)
        response = self.client.get(path + "/visual/page-4", params=params)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "private, no-store")
        Image.open(io.BytesIO(response.content)).verify()
        self.assertEqual(self.client.get(path + "/visual/page-5", params=params).status_code, 422)
