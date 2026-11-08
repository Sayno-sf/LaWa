"""完整来源读取的实际缓存、预算、出处与Goal/草稿隔离。"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.bootstrap import build_gradient_demo_learning_service
from app.materials import MaterialError, MaterialStore
from app.retrieval_sources import RetrievalSources
from fastapi.testclient import TestClient
from app.api.main import app, get_learning_service, get_material_store


class FullSourceContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.materials = MaterialStore(self.root / "materials")
        self.service = build_gradient_demo_learning_service()
        self.goal = self.service.snapshot().goal_profile.id
        self.sources = RetrievalSources(self.service, self.materials)

    def tearDown(self):
        self.materials.close()
        self.temp.cleanup()

    def upload(self, name, text, owner=None):
        path = self.root / name
        path.write_text(text, encoding="utf-8")
        return self.materials.create(path, name, owner or self.goal, background=False)

    def read(self, **kwargs):
        return self.sources.full_context(self.goal, "current", 32_000, 32_000, **kwargs)

    def test_large_full_source_and_read_keep_tail_and_learning_truth(self):
        meta = self.upload("large-context.txt", "开头\n" + "完整资料" * 40_000 + "\n原文末尾")
        before = self.service.snapshot()
        result = self.sources.full_context(self.goal, "current", 867_232, 850_000, material_id=meta["id"])
        self.assertEqual(result["mode"], "full_context")
        self.assertGreater(result["estimated_tokens"], 128_000)
        self.assertTrue(result["sources"][0]["text"].endswith("原文末尾"))
        read = self.materials.read(meta["id"], self.goal, start=1, end=3, max_chars=40_000)
        self.assertGreater(read["estimated_tokens"], 2000)
        self.assertLessEqual(read["estimated_tokens"], 32_000)
        self.assertTrue(read["truncated"])
        self.assertEqual(before, self.service.snapshot())

    def test_more_than_rag_budget_is_complete_and_does_not_change_learning_state(self):
        meta = self.upload("whole.txt", "开始条件\n" + "完整上下文" * 1800 + "\n结束例外")
        before = self.service.snapshot()
        result = self.read(material_id=meta["id"])
        self.assertEqual(result["mode"], "full_context")
        row = result["sources"][0]
        self.assertGreater(row["estimated_tokens"], 6000)
        self.assertTrue(row["text"].endswith("结束例外"))
        self.assertFalse(row["truncated"])
        self.assertEqual(row["citation_ref"], f"material:{meta['id']}:line:1-3")
        self.assertEqual(before, self.service.snapshot())

    def test_threshold_and_context_space_fall_back_without_partial_sources(self):
        self.upload("small.txt", "小资料")
        big = self.upload("large.txt", "很长的资料" * 7000)
        result = self.read()
        self.assertEqual((result["mode"], result["reason"], result["sources"]), ("rag", "FULL_CONTEXT_LIMIT", []))
        self.materials.delete(big["id"], self.goal)
        result = self.sources.full_context(self.goal, "current", 32_000, 100)
        self.assertEqual((result["mode"], result["reason"], result["sources"]), ("rag", "CONTEXT_SPACE_LOW", []))

    def test_explicit_small_material_can_be_read_in_a_large_collection(self):
        small = self.upload("selected.txt", "仅指定文件\n完整内容")
        self.upload("unselected.txt", "不相关大资料" * 7000)
        result = self.read(material_id=small["id"])
        self.assertEqual(result["mode"], "full_context")
        self.assertEqual(len(result["sources"]), 1)
        self.assertNotIn("不相关", result["sources"][0]["text"])

    def test_reuse_rechecks_version_and_body_is_not_retransmitted(self):
        meta = self.upload("reuse.txt", "复用资料" * 2000)
        result = self.read()
        row = result["sources"][0]
        known = {"source_id": row["source"]["source_id"], "version": row["source"]["version"],
                 "scope": "current", "current_scope": self.goal}
        reused = self.sources.full_context(self.goal, "current", 32_000, 1000, [known])
        self.assertEqual(reused["mode"], "full_context")
        self.assertNotIn("text", reused["sources"][0])
        self.assertTrue(reused["sources"][0]["already_in_context"])
        self.assertEqual(self.sources.validate_full_context([known], self.goal)["valid_sources"], [known])
        (self.materials.root / meta["id"] / "source").write_text("被修改", encoding="utf-8")
        self.assertEqual(self.sources.validate_full_context([known], self.goal)["valid_sources"], [])
        self.assertEqual(self.read()["mode"], "rag")

    def test_drafts_and_wrong_goals_never_read_unauthorized_bodies(self):
        self.upload("secret.txt", "另一草稿秘密", "draft:other-session")
        own = self.upload("own.txt", "自己的草稿", "draft:my-session")
        original = self.sources._source
        def guarded(source_id, **options):
            self.assertEqual(source_id, "material:" + own["id"])
            return original(source_id, **options)
        with patch.object(self.sources, "_source", side_effect=guarded):
            result = self.sources.full_context("draft:my-session", "library", 32_000, 32_000)
        self.assertEqual(result["mode"], "full_context")
        self.assertNotIn("另一草稿", json.dumps(result, ensure_ascii=False))
        row = result["sources"][0]
        identity = {"source_id": row["source"]["source_id"], "version": row["source"]["version"],
                    "scope": "library", "current_scope": "draft:my-session"}
        self.assertEqual(self.sources.validate_full_context([identity], "draft:other-session")["valid_sources"], [])

    def test_processing_or_corrupt_cache_cannot_claim_full_read(self):
        meta = self.upload("pending.txt", "当前正文")
        directory = self.materials.root / meta["id"]
        with patch.object(self.materials, "_schedule"):
            (directory / "text.json").unlink()
            self.assertEqual(self.read()["mode"], "rag")
            result = self.read()
            self.assertEqual(result["reason"], "SOURCE_NOT_READY")
            self.assertEqual(result["sources"], [])
        with self.assertRaises(MaterialError):
            self.sources.full_context(self.goal, "current", 1_000_001, 32_000)

    def test_http_full_read_and_validate_keep_current_goal_and_request_limits(self):
        meta = self.upload("http.txt", "HTTP完整资料\n真实末尾")
        app.dependency_overrides[get_learning_service] = lambda: self.service
        app.dependency_overrides[get_material_store] = lambda: self.materials
        try:
            with TestClient(app) as client:
                url = "/api/learning/retrieval/full-context"
                payload = {"max_tokens": 32_000, "available_tokens": 32_000, "material_id": meta["id"]}
                response = client.post(url, json=payload, params={"expected_goal_id": self.goal})
                self.assertEqual(response.status_code, 200)
                row = response.json()["sources"][0]
                identity = {"source_id": row["source"]["source_id"], "version": row["source"]["version"],
                            "scope": "current", "current_scope": self.goal}
                valid = client.post(url + "/validate", json={"sources": [identity]})
                self.assertEqual(valid.json()["valid_sources"], [identity])
                self.assertEqual(client.post(url, json=payload, params={"expected_goal_id": "wrong"}).status_code, 409)
                self.assertEqual(client.post(url, json={**payload, "max_tokens": 64_000}).status_code, 200)
                self.assertEqual(client.post(url, json={**payload, "max_tokens": 1_000_001}).status_code, 422)
        finally:
            app.dependency_overrides.clear()
