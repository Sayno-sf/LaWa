"""真实 HTTP + pypdf 解析器的隔离材料验收，不触碰用户账本。"""

import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from app.api.main import app, get_learning_service, get_material_store
from app.bootstrap import build_gradient_demo_learning_service
from app.bootstrap import build_empty_learning_service
from app.materials import MAX_FILE_BYTES, MaterialError, MaterialStore
from app.application import LearningService
from app.domain import CardFeedbackStatus, GoalProfile, KnowledgeCard, SkillGraph


def make_pdf() -> bytes:
    writer = PdfWriter()
    for word in ("First page", "Gradient descent and learning rate"):
        page = writer.add_blank_page(width=612, height=792)
        font = DictionaryObject({NameObject("/Type"): NameObject("/Font"),
                                 NameObject("/Subtype"): NameObject("/Type1"),
                                 NameObject("/BaseFont"): NameObject("/Helvetica")})
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
        stream = DecodedStreamObject()
        stream.set_data(f"BT /F1 12 Tf 72 720 Td ({word}) Tj ET".encode("ascii"))
        page[NameObject("/Contents")] = writer._add_object(stream)
    with tempfile.TemporaryFile() as output:
        writer.write(output)
        output.seek(0)
        return output.read()


class LearningMaterialApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.store = MaterialStore(Path(self.temp.name) / "materials")
        self.service = build_gradient_demo_learning_service()
        app.dependency_overrides[get_learning_service] = lambda: self.service
        app.dependency_overrides[get_material_store] = lambda: self.store
        self.client = TestClient(app)

    def tearDown(self) -> None:
        self.client.close()
        app.dependency_overrides.clear()
        self.store.close()
        self.temp.cleanup()

    def upload(self, name: str, data: bytes):
        return self.client.post("/api/user/materials", params={
            "filename": name, "expected_goal_id": self.service.get_learning_overview().goal_profile.id,
        }, content=data)

    def wait_parsed(self, material_id: str):
        # 上传只承诺原件已保存；后台解析的就绪/失败要从实际持久状态验证。
        self.store._parse_queue.join()
        return self.store.list(self.service.get_learning_overview().goal_profile.id)["materials"][
            next(i for i, row in enumerate(self.store.list(self.service.get_learning_overview().goal_profile.id)["materials"])
                 if row["id"] == material_id)]

    def test_stale_upload_target_rejected_without_publishing(self) -> None:
        response = self.client.post("/api/user/materials", params={
            "filename": "handbook.txt", "expected_goal_id": "new-goal-not-yet-active",
        }, content=b"handbook")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(list(self.store.root.iterdir()), [])
        self.assertEqual(self.client.post("/api/user/materials", params={"filename": "a.txt"}, content=b"a").status_code, 422)

    def test_upload_first_draft_isolated_restart_and_goal_initialization_binding(self) -> None:
        before = self.service.snapshot()
        draft = "new-conversation"
        upload = self.client.post("/api/user/materials", params={"filename": "handbook.txt", "draft_session_id": draft}, content=b"Handbook for recitation\nSecond line")
        self.assertEqual(upload.status_code, 201, upload.text)
        item = upload.json()
        self.assertIsNone(item["goal_id"])
        self.assertEqual(before, self.service.snapshot())
        self.assertEqual(self.client.get("/api/learning/materials").json()["total"], 0)
        path = f"/api/learning/materials/{item['id']}"
        self.assertEqual(self.client.get(path).status_code, 404)
        self.assertEqual(self.client.get(path, params={"draft_session_id": "another-conversation"}).status_code, 404)
        self.assertIn("recitation", self.client.get(path, params={"draft_session_id": draft}).json()["text"])
        self.assertEqual(self.client.get(path + "/search", params={"draft_session_id": draft, "query": "recitation"}).status_code, 200)
        app.dependency_overrides[get_material_store] = lambda: MaterialStore(self.store.root)
        self.assertEqual(self.client.get("/api/learning/materials", params={"draft_session_id": draft}).json()["total"], 1)
        plan = {
            "goal_profile": {"id": "new-handbook", "goal_description": "Learn recitation", "background_summary": "New learner", "desired_outcome": "Explain and apply", "learning_preferences": [], "time_constraint": "Flexible", "prior_knowledge_claims": []},
            "curriculum_spine": [{"id": f"handbook-stage-{i}", "name": f"Stage {i}", "description": "Read and practice", "target_depth": "PRACTICAL"} for i in range(5)],
            "frontier_skills": [{"id": "handbook-basics", "name": "Basics", "description": "Understand basics", "prerequisites": [], "target_depth": "PRACTICAL"}],
            "frontier": {"focus_skill_id": "handbook-basics", "supporting_skill_ids": [], "reason": "Start here", "target_depth": "PRACTICAL", "suggested_learning_mode": "EXPLAIN", "next_action": "Read first section"},
            "replace_existing": False, "onboarding_session_id": draft,
        }
        failed = self.client.post("/api/learning/curriculum/initialize", json=plan)
        self.assertEqual(failed.status_code, 409)
        self.assertIsNone(self.client.get(path, params={"draft_session_id": draft}).json()["material"]["goal_id"])
        plan["replace_existing"] = True
        initialized = self.client.post("/api/learning/curriculum/initialize", json=plan)
        self.assertEqual(initialized.status_code, 201, initialized.text)
        bound = self.client.get(path).json()["material"]
        self.assertEqual(bound["goal_id"], "new-handbook")
        self.assertEqual(bound["sha256"], item["sha256"])
        self.assertEqual(bound["id"], item["id"])
        self.assertEqual(self.client.get("/api/learning/materials").json()["total"], 1)
        late = self.client.post("/api/user/materials", params={"filename": "late.txt", "draft_session_id": draft}, content=b"late upload")
        self.assertEqual(late.json()["goal_id"], "new-handbook")
        self.store.bind_draft(draft, "new-handbook")
        with self.assertRaises(MaterialError):
            self.store.bind_draft(draft, "unrelated-goal")

    def test_material_draft_works_before_any_goal_exists(self) -> None:
        app.dependency_overrides[get_learning_service] = build_empty_learning_service
        result = self.client.post("/api/user/materials", params={"filename": "first.txt", "draft_session_id": "first-conversation"}, content=b"Plan from this file")
        self.assertEqual(result.status_code, 201, result.text)
        self.assertEqual(self.client.get(f"/api/learning/materials/{result.json()['id']}", params={"draft_session_id": "first-conversation"}).status_code, 200)

    def test_text_upload_read_continue_search_restart_and_delete(self) -> None:
        before = self.service.snapshot()
        content = "学习率决定步长\nalpha_var is code\n" + "Long Line " + "".join(f"{i:04d} " for i in range(2000)) + "TAIL_MARKER"
        response = self.upload("lesson.md", content.encode())
        self.assertEqual(response.status_code, 201, response.text)
        item = response.json()
        material_id = item["id"]
        self.assertEqual(item["unit_count"], 3)
        self.assertEqual(before, self.service.snapshot())
        listing = self.client.get("/api/learning/materials").json()
        self.assertEqual(listing["materials"][0]["id"], material_id)
        self.assertEqual(self.client.get("/api/learning/materials", params={"limit": 0}).status_code, 422)
        first = self.client.get(f"/api/learning/materials/{material_id}", params={"start": 3, "max_chars": 100}).json()
        self.assertTrue(first["truncated"])
        second = self.client.get(f"/api/learning/materials/{material_id}", params={"cursor": first["next_cursor"], "max_chars": 100}).json()
        self.assertNotEqual(first["text"], second["text"])
        for query, line in (("学习率", 1), ("ALPHA_VAR", 2), ("Long Line", 3)):
            found = self.client.get(f"/api/learning/materials/{material_id}/search", params={"query": query}).json()
            self.assertEqual(found["matches"][0]["position"], line)
            self.assertEqual(self.client.get(f"/api/learning/materials/{material_id}", params=found["matches"][0]["locator"]).status_code, 200)
        tail = self.client.get(f"/api/learning/materials/{material_id}/search", params={"query": "TAIL_MARKER"}).json()["matches"][0]
        self.assertIn("TAIL_MARKER", self.client.get(f"/api/learning/materials/{material_id}", params={"cursor": tail["read_cursor"]}).json()["text"])
        self.assertEqual(self.client.get(f"/api/learning/materials/{material_id}/search", params={"query": "never-present"}).json()["matches"], [])
        restarted = MaterialStore(self.store.root)
        self.assertEqual(restarted.list(item["goal_id"])["total"], 1)
        (self.store.root / material_id / "text.json").unlink()
        self.assertEqual(restarted.search(material_id, item["goal_id"], "alpha_var")["matches"][0]["position"], 2)
        (self.store.root / material_id / "text.json").write_text("broken", encoding="utf-8")
        self.assertEqual(restarted.search(material_id, item["goal_id"], "alpha_var")["matches"][0]["position"], 2)
        self.assertEqual(self.client.get(f"/api/learning/materials/{material_id}", params={"cursor": "bad!"}).status_code, 409)
        self.assertEqual(self.client.delete(f"/api/user/materials/{material_id}").status_code, 204)
        self.assertEqual(self.client.get(f"/api/learning/materials/{material_id}", params={"cursor": first["next_cursor"]}).status_code, 404)
        self.assertEqual(before, self.service.snapshot())

    def test_pdf_real_parser_and_invalid_inputs(self) -> None:
        response = self.upload("lesson.pdf", make_pdf())
        self.assertEqual(response.status_code, 201, response.text)
        item = self.wait_parsed(response.json()["id"])
        self.assertEqual(item["unit_count"], 2)
        read = self.client.get(f"/api/learning/materials/{item['id']}", params={"start": 2}).json()
        self.assertIn("Gradient descent", read["text"])
        self.assertIn("第 2-2 页", read["citation"])
        bounded = self.client.get(f"/api/learning/materials/{item['id']}", params={"start": 1, "end": 2, "max_chars": 5}).json()
        self.assertEqual((bounded["start"], bounded["end"]), (1, 1))
        self.assertTrue(bounded["truncated"])
        self.assertEqual(self.client.get(f"/api/learning/materials/{item['id']}", params={"start": 3}).status_code, 422)
        self.assertEqual(self.upload("fake.pdf", b"not a pdf").json()["code"], "INVALID_PDF")
        broken = self.wait_parsed(self.upload("broken.pdf", b"%PDF-broken").json()["id"])
        self.assertEqual(broken["parse_error"]["code"], "INVALID_PDF")
        encrypted = PdfWriter()
        encrypted.add_blank_page(width=200, height=200)
        encrypted.encrypt("secret")
        with tempfile.TemporaryFile() as output:
            encrypted.write(output)
            output.seek(0)
            locked = self.wait_parsed(self.upload("locked.pdf", output.read()).json()["id"])
            self.assertEqual(locked["parse_error"]["code"], "ENCRYPTED_PDF")
        oversized_pages = PdfWriter()
        for _ in range(2001):
            oversized_pages.add_blank_page(width=200, height=200)
        with tempfile.TemporaryFile() as output:
            oversized_pages.write(output)
            output.seek(0)
            oversized = self.wait_parsed(self.upload("2001.pdf", output.read()).json()["id"])
            self.assertEqual(oversized["parse_error"]["code"], "PDF_PAGE_LIMIT")
        self.assertEqual(self.upload("unknown.exe", b"data").json()["code"], "UNSUPPORTED_FORMAT")
        self.assertEqual(self.upload("../escape.txt", b"data").json()["code"], "UNSUPPORTED_FORMAT")
        self.assertEqual(self.client.get("/api/learning/materials/../../learning-state.json").status_code, 404)

    def test_empty_pdf_and_goal_boundaries(self) -> None:
        writer = PdfWriter()
        writer.add_blank_page(width=200, height=200)
        with tempfile.TemporaryFile() as output:
            writer.write(output)
            output.seek(0)
            response = self.upload("scan.pdf", output.read())
        self.assertEqual(response.status_code, 201)
        item = self.wait_parsed(response.json()["id"])
        self.assertFalse(item["readable"])
        self.assertIn("NO_EXTRACTABLE_TEXT", item["warnings"])
        self.assertNotIn("OCR_REQUIRED", item["warnings"])
        self.assertTrue(item["ocr_disabled"])
        self.assertIsNone(item["ocr"])
        self.assertEqual(self.client.get(f"/api/learning/materials/{item['id']}").json()["code"], "TEXT_EXTRACTION_UNAVAILABLE")
        self.assertEqual(self.client.get(f"/api/learning/materials/{item['id']}/search", params={"query": "word"}).json()["code"], "TEXT_EXTRACTION_UNAVAILABLE")
        app.dependency_overrides[get_learning_service] = build_empty_learning_service
        self.assertEqual(self.client.get("/api/learning/materials").status_code, 409)
        self.assertEqual(self.client.get(f"/api/learning/materials/{item['id']}").status_code, 409)
        self.assertEqual(self.client.delete(f"/api/user/materials/{item['id']}").status_code, 409)
        self.assertEqual(self.upload("a.txt", b"a").status_code, 409)
        other = LearningService(SkillGraph([]), current_goal="Other goal", goal_profile=GoalProfile(
            id="other-goal", goal_description="Other goal", background_summary="none", desired_outcome="learn something"))
        app.dependency_overrides[get_learning_service] = lambda: other
        self.assertEqual(self.client.get("/api/learning/materials").json()["materials"], [])
        self.assertEqual(self.client.get(f"/api/learning/materials/{item['id']}").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/user/materials/{item['id']}").status_code, 404)

    def test_pdf_timeout_does_not_publish_a_material(self) -> None:
        worker = Path(self.temp.name) / "slow_worker.py"
        worker.write_text("import time\ntime.sleep(5)\n", encoding="utf-8")
        slow = MaterialStore(Path(self.temp.name) / "slow", pdf_worker_path=worker, parse_timeout_seconds=0.1)
        source = Path(self.temp.name) / "slow.pdf"
        source.write_bytes(make_pdf())
        goal = self.service.get_learning_overview().goal_profile.id
        with self.assertRaises(MaterialError) as raised:
            slow.create(source, "slow.pdf", goal)
        self.assertEqual(raised.exception.code, "PARSE_TIMEOUT")
        self.assertEqual(slow.list(goal)["total"], 0)
        self.assertEqual(list(slow.root.iterdir()), [])

    def test_actual_file_size_limit(self) -> None:
        source = Path(self.temp.name) / "large.txt"
        with source.open("wb") as output:
            output.seek(MAX_FILE_BYTES)
            output.write(b"x")
        goal = self.service.get_learning_overview().goal_profile.id
        with self.assertRaises(MaterialError) as raised:
            self.store.create(source, "large.txt", goal)
        self.assertEqual(raised.exception.code, "FILE_TOO_LARGE")

    def test_skill_context_is_current_goal_only(self) -> None:
        overview = self.service.get_learning_overview()
        skill_id = overview.skills[0].id
        self.service.create_knowledge_card(KnowledgeCard(
            id="card-test", skill_id=skill_id, question="What changed?", answer="The weight.",
            created_at=datetime.now(timezone.utc)))
        self.service.set_card_feedback_by_user("card-test", CardFeedbackStatus.UNSURE)
        self.service.set_card_note_by_user("card-test", "Need another example")
        response = self.client.get(f"/api/learning/skills/{skill_id}/context")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["goal_id"], overview.goal_profile.id)
        self.assertIn("evidence_truncated", response.json())
        self.assertEqual(response.json()["cards"][0]["self_report"], "UNSURE")
        self.assertEqual(response.json()["cards"][0]["learner_note"], "Need another example")
        self.assertEqual(response.json()["cards"][0]["source_conversation_id"], "unavailable")
        self.assertEqual(response.json()["answer_anchor"], "unavailable")
        self.assertEqual(self.client.get("/api/learning/skills/no-such-skill/context").status_code, 404)


if __name__ == "__main__":
    unittest.main()
