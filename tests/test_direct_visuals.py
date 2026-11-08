"""老师直接读取PDF原页和Office图片，继承原件归属与版本，不依赖OCR或视觉索引。"""
import base64
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from docx import Document
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
from pptx import Presentation
from pptx.util import Inches
from pypdf import PdfWriter

from app.api.main import app, get_learning_service, get_material_store
from app.bootstrap import build_gradient_demo_learning_service
from app.materials import MaterialStore, MaterialError


class DirectVisualTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = MaterialStore(self.root / "materials")
        self.service = build_gradient_demo_learning_service()
        self.goal = self.service.snapshot().goal_profile.id
        self.picture = self.root / "formula.png"
        image = Image.new("RGB", (400, 200), "white")
        ImageDraw.Draw(image).text((30, 50), "q = 3v + 4", fill="black")
        image.save(self.picture)

    def tearDown(self):
        app.dependency_overrides.clear()
        self.store.close()
        self.tmp.cleanup()

    def upload(self, path):
        return self.store.create(path, path.name, self.goal, purpose="conversation_attachment", conversation_id="source-conversation")

    def pdf(self, pages=23):
        path = self.root / "scan.pdf"
        writer = PdfWriter()
        for _ in range(pages):
            writer.add_blank_page(width=400, height=600)
        writer.write(path)
        return self.upload(path)

    def test_pdf_manifest_and_original_page_ignore_failed_text_state_and_do_not_run_ocr(self):
        row = self.pdf()
        path = self.store.root / row["id"] / "metadata.json"
        meta = json.loads(path.read_text(encoding="utf-8"))
        meta.update(parse_status="failed", unit_count=0, visual_assets=[])
        path.write_text(json.dumps(meta), encoding="utf-8")
        before = self.service.snapshot()
        with patch.object(self.store, "_text", side_effect=AssertionError("Original reads must not depend on extracted text")):
            first = self.store.visual_manifest(row["id"], self.goal)
            last = self.store.visual_manifest(row["id"], self.goal, offset=20)
            image = self.store.visual_asset(row["id"], "page-23", self.goal)
        self.assertEqual(first["unit_count"], 23)
        self.assertEqual(first["next_offset"], 20)
        self.assertEqual(len(last["assets"]), 3)
        self.assertEqual(last["assets"][-1]["id"], "page-23")
        self.assertIsNone(last["next_offset"])
        with Image.open(io.BytesIO(base64.b64decode(image["data"]))) as rendered:
            self.assertEqual(rendered.format, "JPEG")
        self.assertEqual(image["unit"], 23)
        self.assertEqual(image["source_hash"], row["sha256"])
        self.assertEqual(self.service.snapshot(), before)

    def test_office_text_table_and_embedded_original_have_distinct_real_locators(self):
        doc = Document()
        doc.add_paragraph("Native introduction")
        table = doc.add_table(rows=1, cols=2)
        table.cell(0, 0).text = "Cedar"
        table.cell(0, 1).text = "17"
        doc.add_picture(str(self.picture))
        path = self.root / "mixed.docx"
        doc.save(path)
        row = self.upload(path)
        manifest = self.store.visual_manifest(row["id"], self.goal)
        self.assertEqual(manifest["unit_kind"], "block")
        self.assertEqual(manifest["total"], 1)
        image = self.store.visual_asset(row["id"], manifest["assets"][0]["id"], self.goal)
        self.assertEqual(image["unit"], 3)
        self.assertIn("Word 正文块 3", image["citation"])
        read = self.store.read(row["id"], self.goal, 1, 3)
        text = read["text"]
        self.assertIn("Native introduction", text)
        self.assertIn("Cedar", text)
        self.assertIn("17", text)
        # 文字范围的尾部空块不会伪装成已读图像；图片定位来自独立目录。
        self.assertEqual(manifest["assets"][0]["unit"], 3)
        self.assertEqual(manifest["assets"][0]["id"], image["asset_id"])
        self.assertEqual(image["mime"], "image/jpeg")

        deck = Presentation()
        slide = deck.slides.add_slide(deck.slide_layouts[6])
        slide.shapes.add_textbox(Inches(1), Inches(1), Inches(4), Inches(1)).text = "Native slide text"
        slide.shapes.add_picture(str(self.picture), Inches(1), Inches(2))
        path = self.root / "mixed.pptx"
        deck.save(path)
        row = self.upload(path)
        manifest = self.store.visual_manifest(row["id"], self.goal)
        self.assertEqual(manifest["unit_kind"], "slide")
        self.assertEqual(manifest["assets"][0]["unit"], 1)
        image = self.store.visual_asset(row["id"], manifest["assets"][0]["id"], self.goal)
        self.assertIn("幻灯片 1", image["citation"])
        self.assertIn("Native slide text", self.store.read(row["id"], self.goal)["text"])

    def test_late_render_after_purpose_change_or_delete_is_rejected(self):
        actual = subprocess.run
        for action in ["purpose", "delete"]:
            with self.subTest(action=action):
                row = self.pdf(1)

                def render_then_change(*args, **kwargs):
                    result = actual(*args, **kwargs)
                    if action == "purpose":
                        self.store.set_purpose(row["id"], self.goal, "learning_material", 0)
                    else:
                        self.store.delete(row["id"], self.goal)
                    return result

                with patch("app.materials.subprocess.run", side_effect=render_then_change):
                    with self.assertRaises(MaterialError):
                        self.store.visual_asset(row["id"], "page-1", self.goal)

    def test_http_visuals_are_scoped_and_expose_no_paths_or_external_urls(self):
        row = self.upload(self.picture)
        app.dependency_overrides[get_learning_service] = lambda: self.service
        app.dependency_overrides[get_material_store] = lambda: self.store
        with TestClient(app) as client:
            path = f"/api/learning/materials/{row['id']}"
            manifest = client.get(path + "/visuals", params={"expected_goal_id": self.goal})
            self.assertEqual(manifest.status_code, 200)
            self.assertEqual(manifest.json()["assets"][0]["id"], "image-1")
            image = client.get(path + "/visual-packet/image-1", params={"expected_goal_id": self.goal})
            self.assertEqual(image.status_code, 200)
            self.assertEqual(image.json()["scope"], self.goal)
            self.assertNotIn(str(self.store.root), image.text)
            self.assertNotEqual(client.get(path + "/visuals", params={"expected_goal_id": "wrong"}).status_code, 200)
            self.assertEqual(client.get(path + "/visuals", params={"offset": -1}).status_code, 422)
