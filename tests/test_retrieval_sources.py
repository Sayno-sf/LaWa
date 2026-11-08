"""真实 Office 解析和 Kernel 来源权限；模型请求另由 Node 隔离验收。"""
import io
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from docx import Document
from pptx import Presentation
from pptx.util import Inches
from app.bootstrap import build_gradient_demo_learning_service
from app.materials import MaterialError, MaterialStore
from app.retrieval_sources import RetrievalSources
from app.domain import KnowledgeCard


class RetrievalSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.materials = MaterialStore(self.root / "materials")
        self.service = build_gradient_demo_learning_service()
        self.goal = self.service.get_learning_overview().goal_profile.id
        self.sources = RetrievalSources(self.service, self.materials)

    def tearDown(self):
        self.materials.close()
        self.temp.cleanup()

    def upload(self, name, data, goal=None, background=True):
        path = self.root / name
        path.write_bytes(data)
        meta = self.materials.create(path, name, goal or self.goal, background=background)
        self.materials._parse_queue.join()
        return meta

    def test_docx_paragraph_table_order_headings_and_real_block_citation(self):
        before = self.service.snapshot()
        doc = Document()
        doc.add_heading("异步请求", level=1)
        doc.add_paragraph("HTTP 客户端发出请求，await 等待返回。")
        table = doc.add_table(rows=1, cols=2)
        table.cell(0, 0).text = "超时参数"
        table.cell(0, 1).text = "timeout=30"
        doc.add_paragraph("最后一个正文块。")
        binary = io.BytesIO()
        doc.save(binary)
        meta = self.upload("client.docx", binary.getvalue())
        projection = self.sources.chunks("material:" + meta["id"])
        self.assertEqual(projection["source"]["parse_status"], "ready")
        body = "\n".join(row["text"] for row in projection["chunks"])
        self.assertLess(body.index("await"), body.index("timeout=30"))
        self.assertLess(body.index("timeout=30"), body.index("最后"))
        read = self.sources.read(projection["chunks"][0]["source_ref"], self.goal, "current")
        self.assertEqual(read["locator"]["kind"], "block")
        self.assertIn(":block:", read["citation_ref"])
        self.assertEqual(before, self.service.snapshot())

    def test_pptx_slide_and_speaker_notes_have_slide_locator(self):
        deck = Presentation()
        for number in (1, 2):
            slide = deck.slides.add_slide(deck.slide_layouts[6])
            box = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(6), Inches(2))
            box.text_frame.text = f"幻灯片 {number}：语义检索需要向量。"
            slide.notes_slide.notes_text_frame.text = f"补充说明 {number}：索引保存在本地。"
        binary = io.BytesIO()
        deck.save(binary)
        meta = self.upload("rag.pptx", binary.getvalue())
        projection = self.sources.chunks("material:" + meta["id"])
        self.assertEqual(projection["source"]["parse_status"], "ready")
        self.assertEqual(len(projection["chunks"]), 2)
        read = self.sources.read(projection["chunks"][1]["source_ref"], self.goal, "current")
        self.assertIn("补充说明 2", read["text"])
        self.assertEqual(read["locator"]["kind"], "slide")
        self.assertEqual(read["locator"]["start"], 2)

    def test_draft_refs_cannot_expand_into_another_unbound_draft(self):
        meta = self.upload("draft.txt", b"HTTP client", "draft:first", False)
        ref = self.sources.chunks("material:" + meta["id"])["chunks"][0]["source_ref"]
        self.assertEqual(self.sources.validate([ref], "draft:second", "library")["valid_refs"], [])
        with patch.object(self.sources, "_source", side_effect=AssertionError("must not read unauthorized source")):
            with self.assertRaises(MaterialError) as error:
                self.sources.read(ref, "draft:second", "library")
            self.assertEqual(error.exception.status, 404)
        self.assertIn(ref, self.sources.validate([ref], "draft:first", "current")["valid_refs"])

    def test_deleted_changed_original_and_corrupt_ref_are_rejected(self):
        meta = self.upload("client.txt", b"HTTP client", background=False)
        ref = self.sources.chunks("material:" + meta["id"])["chunks"][0]["source_ref"]
        path = self.materials.root / meta["id"] / "source"
        path.write_bytes(b"changed")
        self.assertEqual(self.sources.validate([ref], self.goal, "current")["valid_refs"], [])
        with self.assertRaises(MaterialError):
            self.sources.read(ref, self.goal, "current")
        with self.assertRaises(MaterialError):
            self.sources.decode_ref("broken")

    def test_catalog_visual_counts_are_cheap_and_trash_is_not_a_source(self):
        meta = self.upload("plain.txt", b"HTTP client", background=False)
        source_id = "material:" + meta["id"]
        descriptor = self.sources.descriptor(source_id)
        self.assertEqual(descriptor["visual_count"], 0)
        trash = self.materials.root / ".trash"
        trash.mkdir()
        (trash / "old-chat.jsonl").write_text(json.dumps({"material_id": meta["id"]}))
        with patch.object(self.materials, "_text", side_effect=AssertionError("catalog must not read full text")):
            rows = self.sources.catalog()["sources"]
        self.assertEqual(next(row for row in rows if row["source_id"] == source_id)["visual_count"], 0)
        self.materials.delete(meta["id"], self.goal)
        self.assertNotIn(source_id, [row["source_id"] for row in self.sources.catalog()["sources"]])

    def test_cache_recovery_happens_in_background_and_original_is_preserved(self):
        meta = self.upload("source.txt", b"HTTP client", background=False)
        ref = self.sources.chunks("material:" + meta["id"])["chunks"][0]["source_ref"]
        directory = self.materials.root / meta["id"]
        original = (directory / "source").read_bytes()
        (directory / "text.json").unlink()
        with self.assertRaises(MaterialError) as error:
            self.sources.read(ref, self.goal, "current")
        self.assertEqual(error.exception.code, "MATERIAL_PROCESSING")
        self.materials._parse_queue.join()
        self.assertIn("HTTP", self.sources.read(ref, self.goal, "current")["text"])
        self.assertEqual(original, (directory / "source").read_bytes())

    def test_restart_recovers_persisted_processing_task(self):
        meta = self.upload("recover.txt", b"HTTP client", background=False)
        path = self.materials.root / meta["id"] / "metadata.json"
        saved = json.loads(path.read_text())
        saved["parse_status"] = "processing"
        path.write_text(json.dumps(saved))
        self.materials.close()
        self.materials = MaterialStore(self.materials.root)
        self.sources = RetrievalSources(self.service, self.materials)
        self.materials._parse_queue.join()
        self.assertEqual(self.sources.descriptor("material:" + meta["id"])["parse_status"], "ready")

    def test_parse_retry_retains_original_and_rechecks_bound_draft_owner(self):
        with patch.object(self.materials, "_extract", side_effect=MaterialError("TEMPORARY", "retry fixture")):
            meta = self.upload("retry.txt", b"HTTP client", goal="draft:retry-session")
        self.materials.bind_draft("retry-session", self.goal)
        with self.assertRaises(MaterialError):
            self.materials.retry(meta["id"], "draft:other-session")
        result = self.materials.retry(meta["id"], self.goal)
        self.assertEqual(result["goal_id"], self.goal)
        self.materials._parse_queue.join()
        directory = self.materials.root / meta["id"]
        self.assertEqual((directory / "source").read_bytes(), b"HTTP client")
        saved = json.loads((directory / "metadata.json").read_text())
        self.assertEqual(saved["goal_id"], self.goal)
        self.assertEqual(saved["parse_status"], "ready")

    def test_cards_notes_keep_separate_identity_and_do_not_change_learning_facts(self):
        skill_id = self.service.snapshot().current_goal_skill_ids[0]
        self.service.create_knowledge_card(KnowledgeCard("card-fixture", skill_id, "什么是 HTTP？",
                                                       "一种请求与响应协议。", datetime.now(timezone.utc)))
        self.service.set_card_note_by_user("card-fixture", "我需要复习超时参数。")
        before = self.service.snapshot()
        entries = self.sources.descriptors()
        cards = [row for row in entries if row["kind"] == "card"]
        self.assertTrue(cards)
        self.assertIn("note:card-fixture", [row["source_id"] for row in entries])
        result = self.sources.chunks(cards[0]["source_id"])
        ref = result["chunks"][0]["source_ref"]
        body = self.sources.read(ref, self.goal, "current")
        self.assertEqual(result["total"], 1)
        self.assertIn("问题：", body["text"])
        self.assertIn("一种请求与响应协议", body["text"])
        self.assertIn("不是 Evidence", body["notice"])
        self.assertEqual(before, self.service.snapshot())
        self.service.update_knowledge_card_by_user("card-fixture", question="什么是 HTTP？", answer="更新的答案。")
        self.assertEqual(self.sources.validate([ref], self.goal, "current")["valid_refs"], [])
        # 修改是用户显式的卡片操作；单独比较检索前的快照，不把检索当成学习写入。

    def test_docx_merges_same_section_and_preserves_nested_heading_paths(self):
        doc = Document()
        doc.add_heading("网络", level=1)
        doc.add_heading("超时", level=2)
        doc.add_paragraph("只在测试环境设置。")
        doc.add_paragraph("不得关闭超时。")
        doc.add_heading("超时", level=2)
        doc.add_paragraph("另一节的独立条件。")
        binary = io.BytesIO()
        doc.save(binary)
        meta = self.upload("sections.docx", binary.getvalue())
        result = self.sources.chunks("material:" + meta["id"])
        self.assertEqual(result["total"], 2)
        self.assertEqual(result["chunks"][0]["heading"], "网络 / 超时")
        self.assertIn("不得关闭", result["chunks"][0]["text"])
        self.assertNotIn("另一节", result["chunks"][0]["text"])
        self.assertEqual(result["chunks"][0]["locator"]["start"], 1)
        self.assertEqual(result["chunks"][0]["locator"]["end"], 4)

    def test_docx_long_table_projection_and_read_share_real_first_row(self):
        doc = Document()
        doc.add_heading("参数限制", level=1)
        doc.add_paragraph("适用于本地模式。")
        table = doc.add_table(rows=31, cols=2)
        table.cell(0, 0).text, table.cell(0, 1).text = "参数名", "生效条件"
        for i in range(1, 31):
            table.cell(i, 0).text = f"timeout{i}"
            table.cell(i, 1).text = "仅本地测试\n不得用于生产。" * 20
        doc.add_paragraph("生产环境使用默认限制。")
        binary = io.BytesIO()
        doc.save(binary)
        meta = self.upload("table.docx", binary.getvalue())
        result = self.sources.chunks("material:" + meta["id"])
        row = next(row for row in result["chunks"] if row.get("context_spans") and row["context_spans"][0]["role"] == "table_first_rows")
        self.assertIn("参数名", row["embedding_text"])
        self.assertIn("生效条件", row["retrieval_text"])
        read = self.sources.read(row["source_ref"], self.goal, "current")
        self.assertIn("参数名", read["context"][0]["text"])
        self.assertEqual(read["context"][0]["locator"]["start"], 3)
        self.assertEqual(read["locator"]["start"], 3)
        self.assertLessEqual(read["estimated_tokens"], 2000)

    def test_long_card_retains_question_context_for_answer_only_chunk(self):
        skill_id = self.service.snapshot().current_goal_skill_ids[0]
        self.service.create_knowledge_card(KnowledgeCard("long-card", skill_id, "什么时候不能关闭超时？",
                                                       "生产环境不得关闭超时。" * 400, datetime.now(timezone.utc)))
        result = self.sources.chunks("card:long-card")
        row = next(row for row in result["chunks"] if row.get("context_spans"))
        read = self.sources.read(row["source_ref"], self.goal, "current")
        self.assertIn("什么时候不能关闭超时", read["context"][0]["text"])
        self.assertIn("不得关闭", read["text"])
        self.assertLessEqual(read["estimated_tokens"], 2000)
