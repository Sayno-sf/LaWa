"""旧版本地 OCR 缓存的只读兼容层。

产品已经停用本地 OCR。本模块不再加载推理库、模型或下载资源，只负责识别此前
生成的 ``rapidocr-3.10.0-ort-1.31.0-v1`` 缓存，并在回读时保留机器转录来源、
不确定项和原图核对提示。新资料的原页由有视觉能力的教学模型按需读取。
"""
from __future__ import annotations

from app.material_visuals import validate_analysis

# 这是旧缓存 JSON 的 schema 身份，不是当前运行时依赖版本。
OCR_VERSION = "rapidocr-3.10.0-ort-1.31.0-v1"


def summary(value: dict | None) -> dict | None:
    """公开旧缓存的有界摘要；绝不倾倒逐行识别数据或模型文件清单。"""
    if value is None:
        return None
    return {
        key: value[key]
        for key in (
            "version",
            "engine",
            "status",
            "candidate_pages",
            "attempted_pages",
            "completed_pages",
            "failed_pages",
            "skipped_pages",
            "warnings",
        )
    }


def project(units: list[str], value: dict | None) -> tuple[list[str], list[dict], list[dict]]:
    """把已验证的旧 OCR 缓存投影到原页，始终与原生文字分开标注。"""
    result, annotations, warnings = list(units), [], []
    if value is None:
        return result, annotations, warnings
    if value["version"] != OCR_VERSION:
        raise ValueError("LOCAL_OCR_CACHE_VERSION")
    for page in value["pages"]:
        unit = page["unit"]
        if not 1 <= unit <= len(units) or units[unit - 1].strip():
            raise ValueError("LOCAL_OCR_CACHE_PAGE")
        if page["status"] != "ready":
            warnings.append({"asset_id": page["asset_id"], "warnings": [page["error"]]})
            continue
        analysis = validate_analysis(page["analysis"])
        if len(analysis["blocks"]) != len(page["block_details"]):
            raise ValueError("LOCAL_OCR_CACHE_BLOCKS")
        for block, detail in zip(analysis["blocks"], page["block_details"]):
            label = "\n[旧版机器OCR转录·文字·" + (
                "不确定，需核对原图" if block["uncertain"] else "请核对原图"
            ) + "]\n"
            start = len(result[unit - 1]) + len(label)
            result[unit - 1] += label + block["content"] + "\n"
            annotations.append({
                "asset_id": page["asset_id"],
                "unit": unit,
                "kind": "text",
                "origin": "ocr_transcription",
                "bbox": block["bbox"],
                "bbox_origin": "ocr_detection",
                "confidence_kind": "ocr_engine_score_not_accuracy",
                "uncertain": block["uncertain"],
                **detail,
                "char_start": start,
                "char_end": start + len(block["content"]),
            })
        warnings.append({"asset_id": page["asset_id"], "warnings": analysis["warnings"]})
    return result, annotations, warnings
