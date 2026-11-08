"""真实 Office/扫描页解析与派生发布边界；识别内容采用明确的测试注入。"""
import base64
import io
import json
import tempfile
from pathlib import Path
import unittest

from docx import Document
from docx.oxml import parse_xml
from PIL import Image
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches
from app.materials import MaterialStore, MaterialError
from app.material_visuals import validate_analysis
from app.document_structure import office_text


class MultimodalMaterialsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = MaterialStore(self.root / "materials")
        self.image = self.root / "original.png"
        Image.new("RGB", (300, 160), "white").save(self.image)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_docx_formula_table_and_original_embedded_image(self):
        doc = Document()
        doc.add_heading("方程", 1)
        p = doc.add_paragraph("系数 ")
        p._p.append(parse_xml('''<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
          <m:f><m:num><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:num>
          <m:den><m:rad><m:deg/><m:e><m:r><m:t>y</m:t></m:r></m:e></m:rad></m:den></m:f></m:oMath>'''))
        p.add_run(" 结束")
        table = doc.add_table(rows=2, cols=2)
        table.cell(0, 0).text = "参数"; table.cell(0, 1).text = "值"
        table.cell(1, 0).text = "速率"; table.cell(1, 1).text = "3"
        doc.add_picture(str(self.image))
        path = self.root / "formula.docx"; doc.save(path)
        meta = self.store.create(path, path.name, "goal-a")
        directory, loaded = self.store._load(meta["id"], "goal-a")
        units = self.store._text(directory, loaded)
        self.assertIn(r"\frac{{x}^{2}}{\sqrt{y}}", units[1])
        self.assertTrue(units[1].endswith(" 结束"))
        self.assertIn("参数 | 值", units[2])
        self.assertEqual(len(meta["visual_assets"]), 1)
        asset = self.store.visual_asset(meta["id"], meta["visual_assets"][0]["id"], "goal-a")
        with Image.open(io.BytesIO(base64.b64decode(asset["data"]))) as picture:
            self.assertEqual(picture.size, (300, 160))
        with self.assertRaises(MaterialError): self.store.visual_asset(meta["id"], asset["asset_id"], "goal-b")

    def test_pptx_native_table_chart_and_picture(self):
        deck = Presentation(); slide = deck.slides.add_slide(deck.slide_layouts[6])
        table = slide.shapes.add_table(2, 2, 0, 0, Inches(3), Inches(1)).table
        table.cell(0, 0).text = "类别"; table.cell(0, 1).text = "值"; table.cell(1, 0).text = "A"; table.cell(1, 1).text = "2"
        data = CategoryChartData(); data.categories = ["A", "B"]; data.add_series("销量", (2, 5))
        slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, 0, Inches(2), Inches(3), Inches(2), data)
        slide.shapes.add_picture(str(self.image), Inches(4), 0)
        path = self.root / "charts.pptx"; deck.save(path)
        meta = self.store.create(path, path.name, "goal-a")
        read = self.store.read(meta["id"], "goal-a")
        self.assertIn("A | 2", read["text"]); self.assertIn("[原生图表数据]", read["text"])
        self.assertIn("B | 5.0", read["text"]); self.assertEqual(len(read["assets"]), 1)
        self.assertTrue(meta["unit_tables"][0])

    def test_scan_render_publish_resume_cursor_and_stale_version(self):
        scan = self.root / "scan.pdf"
        with Image.open(self.image) as picture: picture.save(scan, "PDF")
        meta = self.store.create(scan, scan.name, "goal-a")
        mid = meta["id"]
        plan = self.store.visual_plan(mid, "vision-one")
        self.assertEqual((plan["total"], plan["completed"]), (1, 0))
        self.assertEqual(self.store.visual_asset(mid, "page-1")["mime"], "image/jpeg")
        with self.assertRaises(MaterialError): self.store.read(mid, "goal-a")
        self.assertEqual(self.store.preview(mid, "goal-a")["assets"][0]["id"], "page-1")
        with self.assertRaises(MaterialError): self.store.preview(mid, "goal-b")
        analysis = {"blocks": [
            {"kind": "table", "content": "| A | B |\n|---|---|\n| 1 | 2 |", "bbox": [0, 0, .5, .5]},
            {"kind": "formula", "content": r"E=mc^2", "uncertain": True},
            {"kind": "image", "content": "测试图像说明：两条曲线。"}], "warnings": []}
        self.store.publish_visual(mid, plan["source_hash"], plan["parser_version"], "vision-one", "page-1", analysis)
        read = self.store.read(mid, "goal-a", max_chars=30)
        self.assertTrue(read["truncated"]); cursor = read["next_cursor"]
        full = self.store.read(mid, "goal-a")
        self.assertIn("$$E=mc^2$$", full["text"])
        self.assertIn("机器图像说明", full["text"])
        self.assertEqual(full["visual_annotations"][1]["origin"], "model_transcription")
        self.assertTrue(full["visual_annotations"][1]["uncertain"])
        self.assertNotIn("visual_assets", full["material"])
        self.assertNotIn("unit_tables", full["material"])
        self.assertEqual(full["material"]["visual_count"], 1)
        self.assertEqual(self.store.visual_plan(mid, "vision-one")["assets"], [])
        again = self.store.publish_visual(mid, plan["source_hash"], plan["parser_version"], "vision-one", "page-1", analysis)
        self.assertEqual(again["revision"], full["material"]["visual_revision"])
        changed = {"blocks": [{"kind": "text", "content": "已修正的转录"}], "warnings": []}
        self.store.publish_visual(mid, plan["source_hash"], plan["parser_version"], "vision-two", "page-1", changed)
        with self.assertRaises(MaterialError): self.store.read(mid, "goal-a", cursor=cursor)
        with self.assertRaises(MaterialError): self.store.publish_visual(mid, "old-hash", plan["parser_version"], "x", "page-1", analysis)
        self.store.delete(mid, "goal-a")
        with self.assertRaises(MaterialError): self.store.visual_asset(mid, "page-1")

    def test_invalid_coordinates_and_machine_output_cannot_choose_source(self):
        unknown = parse_xml('<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:groupChr><m:e><m:r><m:t>x</m:t></m:r></m:e></m:groupChr></m:oMath>')
        warnings = set()
        self.assertIn("未完全识别", office_text(unknown, warnings))
        self.assertTrue(warnings)
        for value in [{"blocks": [{"kind": "formula", "content": "x", "bbox": [0, 0, 2, 1]}]},
                      {"blocks": [{"kind": "text", "content": "   "}]},
                      {"blocks": [], "goal_id": "other"},
                      {"blocks": [{"kind": "image", "content": "x", "path": "other.png"}]}]:
            with self.subTest(value=value), self.assertRaises(ValueError): validate_analysis(value)

    def test_corrupt_visual_cache_recovers_in_background(self):
        meta = self.store.create(self.image, "original.png", "goal-a"); mid = meta["id"]
        plan = self.store.visual_plan(mid, "v")
        self.store.publish_visual(mid, plan["source_hash"], plan["parser_version"], "v", "image-1",
                                  {"blocks": [{"kind": "text", "content": "转录"}]})
        (self.store.root / mid / "visual.json").write_text("{}", encoding="utf-8")
        with self.assertRaises(MaterialError): self.store.read(mid, "goal-a")
        self.store._parse_queue.join()
        self.assertEqual(self.store.visual_plan(mid, "v")["completed"], 0)

if __name__ == "__main__": unittest.main()
