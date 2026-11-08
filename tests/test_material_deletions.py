"""持久删除先失效再清理；真实目录/并发阅读/重启，不写学习账本。"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
from pathlib import Path
import tempfile
from threading import Event
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.api.main import app, get_learning_service, get_material_store
from app.bootstrap import build_empty_learning_service
from app.materials import MaterialStore, MaterialError
from app.material_deletions import MaterialDeletions
from app.material_reading import MaterialReadingStore


class MaterialDeletionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = MaterialStore(Path(self.tmp.name) / "materials")
        self.deleted = MaterialDeletions(self.store)
        self.owner = "goal-alpha"
        source = Path(self.tmp.name) / "source.txt"
        source.write_text("DELETION_SOURCE：先校准，再比较。q=3v+4。", encoding="utf-8")
        self.id = self.store.create(source, source.name, self.owner)["id"]
        self.service = build_empty_learning_service()
        app.dependency_overrides[get_material_store] = lambda: self.store
        app.dependency_overrides[get_learning_service] = lambda: self.service
        self.client = TestClient(app, raise_server_exceptions=False)

    def tearDown(self):
        self.client.close()
        app.dependency_overrides.clear()
        self.store.close()
        self.tmp.cleanup()

    def test_failed_physical_cleanup_remains_unreadable_after_restart_and_retries_idempotently(self):
        before = deepcopy(self.service.snapshot())
        with patch("app.material_deletions.shutil.rmtree", side_effect=PermissionError("fixture open file")):
            self.store.delete(self.id, self.owner)
        self.assertTrue((self.store.root / self.id / "source").exists())
        self.assertEqual(self.deleted.read(self.id)["original_cleanup"], "pending")
        self.assertNotIn("DELETION_SOURCE", self.deleted.path(self.id).read_text(encoding="utf-8"))
        self.assertEqual(self.store.list(self.owner)["materials"], [])
        with self.assertRaises(MaterialError):
            self.store._load(self.id, self.owner)
        reopened = MaterialStore(self.store.root)
        try:
            with self.assertRaises(MaterialError):
                reopened._load(self.id, self.owner)
            with self.assertRaises(MaterialError):
                reopened.delete(self.id, "foreign-goal")
            reopened.delete(self.id, self.owner)
            reopened.delete(self.id, self.owner)
            self.assertFalse((self.store.root / self.id).exists())
            self.assertEqual(MaterialDeletions(reopened).read(self.id)["original_cleanup"], "complete")
        finally:
            reopened.close()
        self.assertEqual(self.service.snapshot(), before)

    def test_slow_cleanup_is_outside_write_lock_and_rejects_late_reading_commit(self):
        reader = MaterialReadingStore(self.store)
        reader.enqueue(self.id, self.owner)
        claim = reader.claim(self.id, self.owner, "fixture")
        entered, release = Event(), Event()
        import shutil
        actual = shutil.rmtree
        def held(path):
            entered.set()
            self.assertTrue(release.wait(5))
            return actual(path)
        with ThreadPoolExecutor(max_workers=2) as pool, patch("app.material_deletions.shutil.rmtree", side_effect=held):
            deleting = pool.submit(self.store.delete, self.id, self.owner)
            self.assertTrue(entered.wait(3))
            def verify():
                with self.store._write_lock:
                    self.assertTrue(self.deleted.contains(self.id))
                    with self.assertRaises(MaterialError):
                        reader.commit(self.id, self.owner, claim["job"]["lease"]["id"], {"summary": "late"}, {"provider": "fixture", "id": "model"})
            pool.submit(verify).result(timeout=2)
            release.set()
            deleting.result(timeout=3)
        self.assertFalse((self.store.root / self.id).exists())

    def test_corrupt_marker_never_reopens_original_or_overwrites_unknown_record(self):
        value = self.deleted.begin(self.id, self.owner)
        path = self.deleted.path(self.id)
        value["version"] = 999
        path.write_text(json.dumps(value), encoding="utf-8")
        original = path.read_bytes()
        with self.assertRaises(MaterialError):
            self.store._load(self.id, self.owner)
        with self.assertRaises(MaterialError):
            self.store.delete(self.id, self.owner)
        self.assertEqual(path.read_bytes(), original)
        self.assertTrue((self.store.root / self.id / "source").exists())

    def test_read_started_before_deletion_cannot_return_late_text_even_if_directory_cleanup_failed(self):
        entered, release = Event(), Event()
        actual = self.store._text
        def held(*args, **kwargs):
            units = actual(*args, **kwargs)
            entered.set()
            self.assertTrue(release.wait(5))
            return units
        with ThreadPoolExecutor(max_workers=2) as pool, patch.object(self.store, "_text", side_effect=held):
            reading = pool.submit(self.store.read, self.id, self.owner)
            self.assertTrue(entered.wait(3))
            with patch("app.material_deletions.shutil.rmtree", side_effect=PermissionError("fixture")):
                self.store.delete(self.id, self.owner)
            release.set()
            with self.assertRaises(MaterialError):
                reading.result(timeout=3)

    def test_http_deletion_events_survive_cleanup_and_retry_cannot_delete_an_undeleted_source(self):
        unknown = self.client.post(f"/api/learning/retrieval/material-deletions/{self.id}/retry")
        self.assertEqual(unknown.status_code, 503)
        self.assertTrue((self.store.root / self.id / "source").exists())
        self.store.delete(self.id, self.owner)
        response = self.client.get("/api/learning/retrieval/material-deletions")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([row["id"] for row in response.json()["deletions"]], [self.id])
        self.assertEqual(response.json()["deletions"][0]["original_cleanup"], "complete")
        self.assertEqual(self.client.post(f"/api/learning/retrieval/material-deletions/{self.id}/retry").status_code, 200)

    def test_goal_purge_retries_partial_deletion_without_requiring_old_metadata(self):
        self.store.scope_is_available = lambda scope: False
        with patch("app.material_deletions.shutil.rmtree", side_effect=PermissionError("fixture")):
            with self.assertRaises(MaterialError):
                self.store.purge_scope(self.owner)
        (self.store.root / self.id / "metadata.json").unlink()
        self.store.purge_scope(self.owner)
        self.assertFalse((self.store.root / self.id).exists())

    def test_a_deleted_draft_attachment_retries_only_through_its_verified_goal_binding(self):
        session = "deleted-draft-session"
        draft = self.store.draft_scope(session)
        source = Path(self.tmp.name) / "source.txt"
        material_id = self.store.create(source, source.name, draft, purpose="conversation_attachment", conversation_id=session)["id"]
        with patch("app.material_deletions.shutil.rmtree", side_effect=PermissionError("fixture")):
            self.store.delete(material_id, draft)
        self.store.bind_draft(session, "goal-bound")
        with self.assertRaises(MaterialError):
            self.store.delete(material_id, "goal-other")
        self.store.delete(material_id, "goal-bound")
        self.assertFalse((self.store.root / material_id).exists())
