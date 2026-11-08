"""用途分流复用原件与权限；不把附件或用途决定写为学习事实。"""
import json
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient
from app.api.main import app, get_learning_service, get_material_store
from app.bootstrap import build_gradient_demo_learning_service
from app.materials import MaterialStore, MaterialError
from app.retrieval_sources import RetrievalSources, material_version


class MaterialPurposeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = MaterialStore(self.root / "materials")
        self.service = build_gradient_demo_learning_service()
        self.goal = self.service.snapshot().goal_profile.id
        self.sources = RetrievalSources(self.service, self.store)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def upload(self, purpose="conversation_attachment", owner=None, conversation="conversation-one"):
        path = self.root / "source.txt"
        path.write_text("附件正文，包含完整末尾。", encoding="utf-8")
        return self.store.create(path, "source.txt", owner or self.goal,
                                 purpose=purpose, conversation_id=conversation)

    def test_attachment_is_excluded_from_catalog_but_explicit_current_read_is_complete(self):
        before = self.service.snapshot()
        row = self.upload()
        self.assertEqual(self.store.list(self.goal)["total"], 0)
        self.assertEqual(self.sources.catalog()["sources"], [])
        self.assertEqual(self.store.list(self.goal, include_attachments=True,
                                        conversation_id="another-conversation")["total"], 0)
        self.assertEqual(self.store.list(self.goal, include_attachments=True,
                                        conversation_id="conversation-one")["total"], 1)
        result = self.sources.full_context(self.goal, "current", 32000, 32000, material_id=row["id"])
        self.assertEqual(result["mode"], "full_context")
        self.assertIn("完整末尾", result["sources"][0]["text"])
        self.assertNotEqual(self.sources.full_context(self.goal, "library", 32000, 32000,
                                                     material_id=row["id"])["mode"], "full_context")
        self.assertEqual(self.service.snapshot(), before)

    def test_purpose_change_invalidates_old_version_and_honors_revision_and_goal(self):
        before = self.service.snapshot()
        row = self.upload()
        old = self.sources.full_context(self.goal, "current", 32000, 32000, material_id=row["id"])
        old_identity = [{"source_id": "material:" + row["id"], "version": material_version(row),
                         "scope": "current", "current_scope": self.goal}]
        with self.assertRaises(MaterialError):
            self.store.set_purpose(row["id"], "wrong-goal", "learning_material", 0)
        promoted = self.store.set_purpose(row["id"], self.goal, "learning_material", 0)
        self.assertEqual(promoted["purpose_revision"], 1)
        self.assertEqual(self.store.list(self.goal)["total"], 1)
        self.assertEqual(len(self.sources.catalog()["sources"]), 1)
        self.assertEqual(self.sources.validate_full_context(old_identity, self.goal)["valid_sources"], [])
        with self.assertRaises(MaterialError):
            self.store.set_purpose(row["id"], self.goal, "conversation_attachment", 0)
        with self.assertRaises(MaterialError):
            self.store.set_purpose(row["id"], self.goal, "conversation_attachment", 1, "other")
        self.store.set_purpose(row["id"], self.goal, "conversation_attachment", 1)
        self.assertEqual(self.sources.catalog()["sources"], [])
        self.assertEqual(old["sources"][0]["text"], "附件正文，包含完整末尾。")
        self.assertEqual(self.service.snapshot(), before)

    def test_legacy_metadata_is_not_rewritten_or_reclassified_on_restart(self):
        row = self.upload("learning_material")
        path = self.store.root / row["id"] / "metadata.json"
        raw = json.loads(path.read_text(encoding="utf-8"))
        for key in ["purpose", "purpose_revision", "conversation_id"]:
            raw.pop(key)
        path.write_text(json.dumps(raw), encoding="utf-8")
        original = path.read_bytes()
        self.store.close()
        self.store = MaterialStore(self.store.root)
        self.assertEqual(self.store.list(self.goal)["materials"][0]["purpose"], "learning_material")
        self.assertEqual(path.read_bytes(), original)

    def test_draft_binding_includes_attachments_beyond_default_library_filter(self):
        for i in range(23):
            self.upload(owner=MaterialStore.draft_scope("draft-one"), conversation="draft-one")
        self.assertEqual(self.store.list("draft:draft-one")["total"], 0)
        self.store.bind_draft("draft-one", self.goal)
        rows = self.store.list(self.goal, include_attachments=True)["materials"]
        self.assertEqual(len(rows), 20)
        self.assertTrue(all(row["goal_id"] == self.goal and row["purpose"] == "conversation_attachment" for row in rows))
        self.assertEqual(self.store.list(self.goal, offset=20, include_attachments=True)["total"], 23)

    def test_explicit_new_upload_contract_and_unknown_purpose_rejection(self):
        app.dependency_overrides[get_learning_service] = lambda: self.service
        app.dependency_overrides[get_material_store] = lambda: self.store
        try:
            with TestClient(app) as client:
                query = {"filename": "note.txt", "expected_goal_id": self.goal,
                         "purpose": "conversation_attachment", "conversation_id": "one"}
                result = client.post("/api/user/materials", params=query, content=b"exact original")
                self.assertEqual(result.status_code, 201)
                row = result.json()
                self.assertEqual(row["purpose"], "conversation_attachment")
                self.assertEqual(client.get("/api/learning/materials").json()["total"], 0)
                update = client.patch(f"/api/user/materials/{row['id']}/purpose",
                                      params={"expected_goal_id": self.goal},
                                      json={"purpose": "learning_material", "expected_revision": 0})
                self.assertEqual(update.status_code, 200)
                self.assertEqual(client.get("/api/learning/materials").json()["total"], 1)
                query["purpose"] = "invalid"
                self.assertEqual(client.post("/api/user/materials", params=query, content=b"text").status_code, 422)
                query.update(purpose="conversation_attachment", conversation_id="")
                self.assertEqual(client.post("/api/user/materials", params=query, content=b"text").status_code, 422)
        finally:
            app.dependency_overrides.clear()

    def test_metadata_is_scoped_and_available_without_parsed_text(self):
        row = self.upload()
        metadata = self.store.root / row["id"] / "metadata.json"
        value = json.loads(metadata.read_text(encoding="utf-8"))
        value.update(parse_status="failed", parse_error={"code": "TEST_FAILURE"})
        metadata.write_text(json.dumps(value), encoding="utf-8")
        before = self.service.snapshot()
        app.dependency_overrides[get_learning_service] = lambda: self.service
        app.dependency_overrides[get_material_store] = lambda: self.store
        try:
            with TestClient(app) as client:
                path = f"/api/learning/materials/{row['id']}/metadata"
                result = client.get(path, params={"expected_goal_id": self.goal})
                self.assertEqual(result.status_code, 200)
                self.assertEqual(result.json()["purpose_revision"], 0)
                self.assertEqual(result.json()["parse_status"], "failed")
                self.assertNotIn("text", result.json())
                self.assertNotEqual(client.get(path, params={"expected_goal_id": "wrong"}).status_code, 200)
            self.assertEqual(self.service.snapshot(), before)
        finally:
            app.dependency_overrides.clear()

    def test_scanned_attachment_stays_visual_only_after_parse_and_restart(self):
        from pypdf import PdfWriter
        path = self.root / "scan.pdf"
        writer = PdfWriter()
        writer.add_blank_page(width=612, height=792)
        with path.open("wb") as output:
            writer.write(output)
        row = self.store.create(path, "scan.pdf", self.goal, purpose="conversation_attachment",
                                 conversation_id="conversation-one", background=True)
        self.store._parse_queue.join()
        meta_path = self.store.root / row["id"] / "metadata.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        self.assertEqual(meta["parse_status"], "ready")
        self.assertTrue(meta["ocr_disabled"])
        self.assertIsNone(meta["ocr"])
        self.assertEqual(len(meta["visual_assets"]), 1)
        self.store.close()
        self.store = MaterialStore(self.store.root)
        self.assertEqual(self.store._queued, set(), "retired local OCR must never reschedule a visual-only attachment")
        self.assertEqual(self.sources.catalog()["sources"], [])
