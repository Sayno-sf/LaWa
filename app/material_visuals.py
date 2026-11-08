"""视觉原件投影和识别结果校验；派生文本有明确性质，永不写学习账本。"""
from __future__ import annotations
import io
from PIL import Image, ImageOps
from app.document_structure import slide_shapes

MAX_VISUAL_BYTES = 3 * 1024 * 1024
VISUAL_OVERLAY_VERSION = "visual-structure-v1"


def render(source, fmt: str, asset: dict) -> bytes:
    """按解析器生成的固定 asset 读取原页/图片；输出有界 JPEG，不接受任意路径。"""
    if fmt == "pdf":
        import pypdfium2 as pdfium
        with pdfium.PdfDocument(str(source)) as document:
            page = document[asset["unit"] - 1]
            try:
                width, height = page.get_size()
                if width <= 0 or height <= 0 or width * height > 100_000_000:
                    raise ValueError("INVALID_PAGE_SIZE")
                bitmap = page.render(scale=min(2.0, 2048 / max(width, height)))
                try:
                    picture = bitmap.to_pil().copy()
                finally:
                    bitmap.close()
            finally:
                page.close()
    elif fmt == "docx":
        from docx import Document
        document = Document(str(source))
        picture = Image.open(io.BytesIO(document.part.related_parts[asset["rid"]].blob))
    elif fmt == "pptx":
        from pptx import Presentation
        deck = Presentation(str(source))
        shape = next(shape for shape in slide_shapes(deck.slides[asset["unit"] - 1].shapes) if shape.shape_id == asset["shape_id"])
        picture = Image.open(io.BytesIO(shape.image.blob))
    elif fmt in ("png", "jpg", "jpeg", "webp", "tiff"):
        picture = Image.open(source)
    else:
        raise ValueError("VISUAL_FORMAT_UNSUPPORTED")
    with picture:
        if picture.width * picture.height > 40_000_000:
            raise ValueError("IMAGE_PIXEL_LIMIT")
        image = ImageOps.exif_transpose(picture).convert("RGB")
        image.thumbnail((2048, 2048))
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=92)
        data = output.getvalue()
    if len(data) > MAX_VISUAL_BYTES:
        raise ValueError("VISUAL_SIZE_LIMIT")
    return data


def validate_analysis(value: dict) -> dict:
    if not isinstance(value, dict) or set(value) - {"blocks", "warnings"}:
        raise ValueError("INVALID_VISUAL_ANALYSIS")
    blocks, warnings = value.get("blocks"), value.get("warnings", [])
    if not isinstance(blocks, list) or len(blocks) > 32 or not isinstance(warnings, list) or len(warnings) > 16:
        raise ValueError("INVALID_VISUAL_ANALYSIS")
    if any(not isinstance(w, str) or len(w) > 300 for w in warnings):
        raise ValueError("INVALID_VISUAL_ANALYSIS")
    result = []
    for block in blocks:
        if not isinstance(block, dict) or set(block) - {"kind", "content", "bbox", "uncertain"}:
            raise ValueError("INVALID_VISUAL_ANALYSIS")
        if block.get("kind") not in ("text", "table", "formula", "image") or not isinstance(block.get("content"), str) or not block["content"].strip() or not 1 <= len(block["content"]) <= 8000:
            raise ValueError("INVALID_VISUAL_ANALYSIS")
        if type(block.get("uncertain", False)) is not bool:
            raise ValueError("INVALID_VISUAL_ANALYSIS")
        bbox = block.get("bbox")
        if bbox is not None and (not isinstance(bbox, list) or len(bbox) != 4 or any(type(x) not in (float, int) or not 0 <= x <= 1 for x in bbox) or bbox[0] >= bbox[2] or bbox[1] >= bbox[3]):
            raise ValueError("INVALID_VISUAL_ANALYSIS")
        result.append({"kind": block["kind"], "content": block["content"].strip(), "uncertain": block.get("uncertain", False), "bbox": bbox})
    if sum(len(b["content"]) for b in result) > 24_000:
        raise ValueError("VISUAL_TEXT_LIMIT")
    return {"blocks": result, "warnings": warnings}


def overlay(units: list[str], meta: dict, cache: dict, *, base_annotations: list[dict] | None = None,
            base_warnings: list[dict] | None = None) -> list[str]:
    """正文和机器识别分开标注；表格新增坐标落在同一真实页/块/幻灯片。"""
    result = list(units)
    tables = [list(rows) for rows in meta.get("unit_tables", [])]
    tables.extend([] for _ in range(len(units) - len(tables)))
    annotations = list(base_annotations or [])
    for asset in meta.get("visual_assets", []):
        record = cache.get("results", {}).get(asset["id"])
        if not record:
            continue
        index = asset["unit"] - 1
        for block in record["analysis"]["blocks"]:
            text = block["content"]
            if block["kind"] == "text" and text in result[index]:
                continue
            nature = "图像说明" if block["kind"] == "image" else "视觉转录"
            kind_label = {"text": "文字", "table": "表格", "formula": "公式", "image": "图片"}[block["kind"]]
            label = f"\n[机器{nature}·{kind_label}·{'不确定，需核对' if block['uncertain'] else '请核对原图'}]\n"
            if block["kind"] == "formula":
                text = "$$" + text.strip("$") + "$$"
            start = len(result[index]) + len(label)
            result[index] += label + text + "\n"
            if block["kind"] == "table":
                lines = text.splitlines(keepends=True)
                header = sum(map(len, lines[:2]))
                tables[index].append({"start": start, "end": start + len(text), "header_end": start + min(header, len(text))})
            annotations.append({"asset_id": asset["id"], "unit": asset["unit"], "kind": block["kind"],
                                "origin": "model_description" if block["kind"] == "image" else "model_transcription",
                                "bbox": block.get("bbox"), "bbox_origin": "model_estimate", "uncertain": block["uncertain"],
                                "char_start": start, "char_end": start + len(text)})
    if sum(map(len, result)) > 20_000_000:
        raise ValueError("EXTRACTED_TEXT_LIMIT")
    meta["unit_tables"] = tables
    meta["visual_annotations"] = annotations
    meta["visual_warnings"] = list(base_warnings or []) + [{"asset_id": asset_id, "warnings": record["analysis"]["warnings"]}
                              for asset_id, record in cache.get("results", {}).items() if record["analysis"]["warnings"]]
    return result
