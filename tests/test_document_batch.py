"""原PDF切页的协议、原件一致性和发布竞态；不以切页成功证明老师已经读完。"""
import base64
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
from threading import Thread
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from app.api.main import app, get_learning_service, get_material_store
from app.bootstrap import build_gradient_demo_learning_service
from app.materials import MaterialStore, MaterialError


class DocumentBatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = MaterialStore(self.root / "materials")
        self.service = build_gradient_demo_learning_service()
        self.goal = self.service.snapshot().goal_profile.id
        source = self.root / "native.pdf"
        writer = PdfWriter()
        font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
        for index in range(1, 19):
            page = writer.add_blank_page(width=400, height=400)
            page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
            stream = DecodedStreamObject()
            stream.set_data(f"BT /F1 14 Tf 20 350 Td (Original page {index}) Tj ET".encode())
            page[NameObject("/Contents")] = stream
        writer.write(source)
        self.row = self.store.create(source, "native.pdf", self.goal, purpose="conversation_attachment", conversation_id="original")

    def tearDown(self):
        app.dependency_overrides.clear()
        self.store.close()
        self.tmp.cleanup()

    def test_native_batch_retains_original_page_content_and_real_mapping_without_learning_changes(self):
        before = self.service.snapshot()
        result = self.store.document_batch(self.row["id"], self.goal, 3, 5)
        data = base64.b64decode(result["data"], validate=True)
        self.assertEqual(result["total_units"], 18)
        self.assertEqual(result["source_hash"], self.row["sha256"])
        self.assertEqual(hashlib.sha256(data).hexdigest(), result["content_hash"])
        reader = PdfReader(io.BytesIO(data))
        self.assertEqual(len(reader.pages), 3)
        self.assertIn("Original page 3", reader.pages[0].extract_text())
        self.assertIn("Original page 5", reader.pages[-1].extract_text())
        self.assertIn("3-5", result["citation"])
        self.assertEqual(self.service.snapshot(), before)
        self.assertFalse((self.store.root / self.row["id"] / "document-batch.json").exists())

    def test_batch_is_independent_of_text_parse_but_requires_current_source_and_scope(self):
        metadata = self.store.root / self.row["id"] / "metadata.json"
        meta = json.loads(metadata.read_text(encoding="utf-8"))
        meta["parse_status"] = "failed"
        metadata.write_text(json.dumps(meta), encoding="utf-8")
        self.assertEqual(self.store.document_batch(self.row["id"], self.goal)["end"], 1)
        with self.assertRaises(MaterialError):
            self.store.document_batch(self.row["id"], "wrong")
        for start, end in [(0, 1), (1, 257), (19, 19), (3, 2), (True, 1)]:
            with self.assertRaises(MaterialError):
                self.store.document_batch(self.row["id"], self.goal, start, end)
        source = self.store.root / self.row["id"] / "source"
        source.write_bytes(b"%PDF-changed")
        with self.assertRaises(MaterialError):
            self.store.document_batch(self.row["id"], self.goal)

    def test_render_runs_outside_write_lock_and_late_purpose_change_is_not_published(self):
        run = subprocess.run
        changed = []

        def render_then_change(*args, **kwargs):
            result = run(*args, **kwargs)
            thread = Thread(target=lambda: changed.append(self.store.set_purpose(self.row["id"], self.goal, "learning_material", 0)))
            thread.start()
            thread.join(2)
            self.assertFalse(thread.is_alive(), "document rendering held the shared material write lock")
            return result

        with patch("app.materials.subprocess.run", side_effect=render_then_change):
            with self.assertRaises(MaterialError) as raised:
                self.store.document_batch(self.row["id"], self.goal)
        self.assertEqual(raised.exception.code, "MATERIAL_CHANGED")
        self.assertEqual(len(changed), 1)

    def test_delete_during_render_cannot_publish_or_recreate_source(self):
        run = subprocess.run

        def render_then_delete(*args, **kwargs):
            result = run(*args, **kwargs)
            self.store.delete(self.row["id"], self.goal)
            return result

        with patch("app.materials.subprocess.run", side_effect=render_then_delete):
            with self.assertRaises(MaterialError):
                self.store.document_batch(self.row["id"], self.goal)
        self.assertFalse((self.store.root / self.row["id"]).exists())

    def test_http_batch_requires_owned_original_not_arbitrary_file_url(self):
        app.dependency_overrides[get_learning_service] = lambda: self.service
        app.dependency_overrides[get_material_store] = lambda: self.store
        with TestClient(app) as client:
            path = f"/api/learning/materials/{self.row['id']}/document-batch"
            result = client.get(path, params={"expected_goal_id": self.goal, "start": 17, "end": 18})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()["start"], 17)
            self.assertNotEqual(client.get(path, params={"expected_goal_id": "wrong"}).status_code, 200)
            wide = client.get(path, params={"start": 1, "end": 18})
            self.assertEqual(wide.status_code, 200)
            self.assertEqual(len(PdfReader(io.BytesIO(base64.b64decode(wide.json()["data"]))).pages), 18)
            self.assertEqual(client.get(path, params={"start": 1, "end": 257}).status_code, 422)
