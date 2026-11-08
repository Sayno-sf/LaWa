"""隔离的资料解析进程；仅接收文件/输出路径/格式，不继承模型密钥或访问账本。"""

import json
import re
import sys

from pypdf import PdfReader
from pathlib import Path
import zipfile
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.document_structure import office_text, image_relations, slide_shapes

MAX_UNITS = 2000
MAX_EXTRACTED_CHARS = 20_000_000


def extract(source: str, fmt: str, *, enable_ocr: bool = False, ocr_budget_seconds: float = 0) -> dict:
    """保留真实单元、原生公式和图表结构；原页视觉理解交给教学模型。

    ``enable_ocr`` 和 ``ocr_budget_seconds`` 仅为旧评估脚本的调用兼容保留；
    本地 OCR 已停用，传入任何值都不会启动推理。
    """
    units: list[str] = []
    warnings: list[str] = []
    headings: list[str | None] = []
    tables_by_unit: list[list[dict]] = []
    sections: list[int] = []
    assets: list[dict] = []
    structure_warnings: set[str] = set()
    if fmt == "pdf":
        reader = PdfReader(source, strict=True)
        if reader.is_encrypted:
            raise ValueError("ENCRYPTED_PDF")
        if len(reader.pages) > MAX_UNITS:
            raise ValueError("PDF_PAGE_LIMIT")
        for index, page in enumerate(reader.pages, 1):
            try:
                value = page.extract_text() or ""
            except Exception:
                value = ""
                warnings.append(f"PAGE_{index}_EXTRACTION_FAILED")
            if not value.strip():
                warnings.append(f"PAGE_{index}_NO_TEXT")
            units.append(value)
            assets.append({"id": f"page-{index}", "unit": index, "kind": "page", "label": f"原 PDF 第 {index} 页"})
        warnings.append("PDF_LAYOUT_AND_IMAGE_CONTENT_NOT_VERIFIED")
        kind = "page"
    elif fmt in ("docx", "pptx"):
        # Office 文件是 ZIP；先检查解压后尺寸，避免小压缩包耗尽解析资源。
        with zipfile.ZipFile(source) as archive:
            if sum(item.file_size for item in archive.infolist()) > 512 * 1024 * 1024:
                raise ValueError("OFFICE_EXPANDED_LIMIT")
        if fmt == "docx":
            from docx import Document
            from docx.table import Table
            document = Document(source)
            heading = None
            heading_path: list[tuple[int, str]] = []
            section_id = 0
            for block in document.iter_inner_content():
                tables = []
                if isinstance(block, Table):
                    rows = [" | ".join(" ".join(office_text(p._p, structure_warnings) for p in cell.paragraphs).replace("\n", " ") for cell in row.cells) for row in block.rows]
                    value = "\n".join(rows)
                    if rows:
                        tables = [{"start": 0, "end": len(value), "header_end": len(rows[0])}]
                else:
                    value = office_text(block._p, structure_warnings)
                    if block.style and block.style.name.startswith(("Heading", "标题")):
                        section_id += 1
                        match = re.search(r"(\d+)$", block.style.name)
                        level = int(match.group(1)) if match else 1
                        heading_path = [(depth, title) for depth, title in heading_path if depth < level]
                        heading_path.append((level, value.strip()))
                        heading = " / ".join(title for _, title in heading_path)
                units.append(value)
                headings.append(heading)
                tables_by_unit.append(tables)
                sections.append(section_id)
                for image_index, rid in enumerate(image_relations(block._element), 1):
                    assets.append({"id": f"image-{len(units)}-{image_index}", "unit": len(units), "kind": "image", "rid": rid,
                                   "label": f"Word 正文块 {len(units)} 的图片 {image_index}"})
            warnings.append("DOCX_REVISIONS_FLOATING_AND_OLE_CONTENT_NOT_VERIFIED")
            kind = "block"
        else:
            from pptx import Presentation
            from pptx.enum.shapes import MSO_SHAPE_TYPE
            presentation = Presentation(source)
            if len(presentation.slides) > MAX_UNITS:
                raise ValueError("SLIDE_LIMIT")

            for slide_number, slide in enumerate(presentation.slides, 1):
                value, tables = "", []
                for shape in sorted(slide_shapes(slide.shapes), key=lambda s: (s.top, s.left)):
                    text = ""
                    if shape.has_table:
                        rows = [" | ".join(" ".join(office_text(p._p, structure_warnings) for p in cell.text_frame.paragraphs).replace("\n", " ") for cell in row.cells) for row in shape.table.rows]
                        text = "\n".join(rows)
                        start = len(value) + (2 if value else 0)
                        if rows:
                            tables.append({"start": start, "end": start + len(text), "header_end": start + len(rows[0])})
                    elif shape.has_text_frame:
                        text = "\n".join(office_text(p._p, structure_warnings) for p in shape.text_frame.paragraphs)
                    elif shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
                        assets.append({"id": f"pic-{slide_number}-{shape.shape_id}", "unit": slide_number, "kind": "image", "shape_id": shape.shape_id,
                                       "label": f"幻灯片 {slide_number} 图片 {shape.shape_id}"})
                    elif shape.has_chart:
                        chart = shape.chart
                        try:
                            categories = [str(category.label) for category in chart.plots[0].categories]
                            series = list(chart.series)
                            rows = ["类别 | " + " | ".join(str(s.name) for s in series)]
                            rows += [name + " | " + " | ".join(str(s.values[i]) if i < len(s.values) else "" for s in series) for i, name in enumerate(categories)]
                            text = "[原生图表数据]\n" + "\n".join(rows)
                        except (AttributeError, ValueError, IndexError):
                            structure_warnings.add("PPTX_CHART_DATA_UNAVAILABLE")
                    if text.strip():
                        value += ("\n\n" if value else "") + text
                if slide.has_notes_slide:
                    note = slide.notes_slide.notes_text_frame
                    if note and note.text.strip():
                        value += "\n\n[演讲者备注]\n" + "\n".join(office_text(p._p, structure_warnings) for p in note.paragraphs)
                units.append(value)
                headings.append(slide.shapes.title.text if slide.shapes.title else None)
                tables_by_unit.append(tables)
            warnings.append("PPTX_VECTOR_DIAGRAMS_SMARTART_AND_READING_ORDER_NOT_VERIFIED")
            kind = "slide"
    elif fmt in ("png", "jpg", "jpeg", "webp", "tiff"):
        from PIL import Image
        with Image.open(source) as image:
            if image.width * image.height > 40_000_000:
                raise ValueError("IMAGE_PIXEL_LIMIT")
            if getattr(image, "n_frames", 1) > 1:
                warnings.append("IMAGE_MULTIFRAME_FIRST_FRAME_ONLY")
        units = [""]
        assets = [{"id": "image-1", "unit": 1, "kind": "image", "label": "原始图片"}]
        kind = "page"
    else:
        raise ValueError("UNSUPPORTED_FORMAT")
    if sum(map(len, units)) > MAX_EXTRACTED_CHARS:
        raise ValueError("EXTRACTED_TEXT_LIMIT")
    if not any(unit.strip() for unit in units):
        warnings.append("NO_EXTRACTABLE_TEXT")
    warnings.extend(sorted(structure_warnings))
    if assets:
        warnings.append("VISUAL_RECOGNITION_PENDING")
    result = {"units": units, "headings": headings, "tables": tables_by_unit, "sections": sections, "visual_assets": assets, "unit_kind": kind, "warnings": warnings}
    result["ocr_disabled"] = True
    return result


def main() -> None:
    source, target = sys.argv[1:3]
    fmt = sys.argv[3] if len(sys.argv) > 3 else "pdf"
    Path(target).write_text(json.dumps(extract(source, fmt), ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc)[:300], file=sys.stderr)
        raise SystemExit(2)
