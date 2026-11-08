import unittest

from app import material_ocr
from app.materials import PARSER_VERSION, parser_version


class LegacyOcrProjectionTests(unittest.TestCase):
    def legacy_cache(self) -> dict:
        return {
            "version": material_ocr.OCR_VERSION,
            "engine": "RapidOCR",
            "status": "complete",
            "candidate_pages": 1,
            "attempted_pages": 1,
            "completed_pages": 1,
            "failed_pages": 0,
            "skipped_pages": 0,
            "warnings": [],
            "pages": [{
                "asset_id": "page-1",
                "unit": 1,
                "status": "ready",
                "lines": [{"text": "旧缓存正文", "confidence": 0.97, "bbox": [0.1, 0.1, 0.9, 0.2]}],
                "analysis": {
                    "blocks": [{
                        "kind": "text",
                        "content": "旧缓存正文",
                        "bbox": [0.1, 0.1, 0.9, 0.2],
                        "uncertain": False,
                    }],
                    "warnings": ["OCR_UNVERIFIED_CHECK_ORIGINAL"],
                },
                "block_details": [{
                    "line_start": 0,
                    "line_end": 1,
                    "confidence_min": 0.97,
                    "confidence_mean": 0.97,
                }],
            }],
        }

    def test_old_cache_projects_as_machine_transcription_without_inference(self) -> None:
        units, annotations, warnings = material_ocr.project([""], self.legacy_cache())
        self.assertIn("旧版机器OCR转录", units[0])
        self.assertIn("旧缓存正文", units[0])
        self.assertEqual(annotations[0]["origin"], "ocr_transcription")
        self.assertEqual(annotations[0]["bbox_origin"], "ocr_detection")
        self.assertEqual(warnings[0]["warnings"], ["OCR_UNVERIFIED_CHECK_ORIGINAL"])

    def test_summary_remains_bounded_without_lines_or_model_paths(self) -> None:
        value = material_ocr.summary(self.legacy_cache())
        self.assertIsNotNone(value)
        self.assertNotIn("pages", value)
        self.assertNotIn("models", value)
        self.assertEqual(value["engine"], "RapidOCR")

    def test_old_parser_identity_stays_readable_while_new_pdf_uses_native_version(self) -> None:
        legacy = "pypdf-6.19.0-v3+" + material_ocr.OCR_VERSION
        self.assertEqual(parser_version("pdf", {"parser_version": legacy}), legacy)
        self.assertEqual(parser_version("pdf", {"parser_version": "pypdf-6.19.0-v3"}), "pypdf-6.19.0-v3")
        self.assertEqual(parser_version("pdf", {}), PARSER_VERSION)


if __name__ == "__main__":
    unittest.main()
