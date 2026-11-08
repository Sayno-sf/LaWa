"""完整阅读的机器进度：连续交付、取消/重启、来源失效及锁外准备。"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
from pathlib import Path
import tempfile
from threading import Event
import unittest
from unittest.mock import patch

from docx import Document
from PIL import Image
from pypdf import PdfWriter
from fastapi.testclient import TestClient

from app.materials import MaterialStore, MaterialError
from app.material_reading import MaterialReadingStore
from app.material_reading_context import context_nodes, note_bytes
from app import retrieval
from app.api.main import app, get_learning_service, get_material_store
from app.bootstrap import build_gradient_demo_learning_service


MODEL = {"provider": "fixture-vision", "id": "original-model"}
NOTE = {"summary": "实际原文概念和关系；不是学生能力判断。", "facts": ["仅保存已交付内容中的事实。"]}


class MaterialReadingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.materials = MaterialStore(self.root / "materials")
        self.now = [1000.0]
        self.reading = MaterialReadingStore(self.materials, lambda: self.now[0])
        self.owner = "goal-one"

    def tearDown(self):
        app.dependency_overrides.clear()
        self.materials.close()
        self.tmp.cleanup()

    def upload(self, text="HEAD\n" + "原文有前后联系。" * 400 + "\nTAIL"):
        source = self.root / "source.txt"
        source.write_text(text, encoding="utf-8")
        return self.materials.create(source, source.name, self.owner, purpose="conversation_attachment", conversation_id="conversation-one")["id"]

    def claim(self, id, **options):
        return self.reading.claim(id, self.owner, "reader-a", **options)

    def commit(self, id, claimed, note=None, sufficient=None, model=None):
        return self.reading.commit(id, self.owner, claimed["job"]["lease"]["id"], note or NOTE, model or MODEL, sufficient)

    def test_large_single_line_is_contiguous_and_restart_reuses_committed_batches(self):
        text = "HEAD" + "未经摘要截断的原文" * 20_000 + "TAIL"
        id = self.upload(text)
        queued = self.reading.enqueue(id, self.owner, "basis")
        self.assertEqual(queued["state"], "QUEUED")
        delivered = []
        first = self.claim(id, max_chars=150_000, max_tokens=200_000)
        self.assertEqual(first["batch"]["start"], 0)
        self.assertGreater(len(first["batch"]["text"]), 128_000, "no inherited short snippet cap")
        delivered.append(first["batch"]["text"])
        committed = self.commit(id, first)
        self.assertNotIn("text", committed["notes"][0]["batch"], "raw originals remain in source, not another permanent message ledger")
        self.reading = MaterialReadingStore(self.materials, lambda: self.now[0])
        second = self.claim(id, max_chars=150_000, max_tokens=200_000)
        self.assertEqual(second["batch"]["start"], first["batch"]["end"])
        delivered.append(second["batch"]["text"])
        self.commit(id, second, model={**MODEL, "id": "switched-model"})
        self.assertEqual("".join(delivered), text)
        integrate = self.claim(id, max_tokens=1_000_000)
        self.assertEqual(integrate["batch"]["kind"], "integrate")
        self.assertTrue(integrate["batch"]["original_text_complete"])
        self.assertEqual(integrate["batch"]["original_text"], text)
        result = self.commit(id, integrate, sufficient=True)
        self.assertEqual(result["state"], "READY")
        self.assertEqual([note["model"]["id"] for note in result["notes"]], ["original-model", "switched-model"])
        self.assertEqual(self.reading.enqueue(id, self.owner)["state"], "READY")

    def test_partial_batch_cannot_finalize_and_receipt_retry_is_exactly_idempotent(self):
        id = self.upload()
        self.reading.enqueue(id, self.owner)
        batch = self.claim(id, max_chars=100)
        with self.assertRaisesRegex(MaterialError, "单批"):
            self.commit(id, batch, sufficient=True)
        saved = self.commit(id, batch)
        repeated = self.commit(id, batch)
        self.assertEqual(saved, repeated)
        with self.assertRaisesRegex(MaterialError, "不一致"):
            self.commit(id, batch, {"summary": "另一个答案"})
        with self.assertRaises(MaterialError):
            self.commit(id, batch, sufficient=True)
        self.assertEqual(len(self.reading.get(id, self.owner)["notes"]), 1)

    def test_cancellation_and_expiry_refuse_late_completion_without_losing_valid_notes(self):
        id = self.upload()
        self.reading.enqueue(id, self.owner)
        first = self.claim(id, max_chars=100)
        self.commit(id, first)
        late = self.claim(id, max_chars=100)
        self.reading.cancel(id, self.owner)
        with self.assertRaisesRegex(MaterialError, "停止"):
            self.commit(id, late)
        self.reading.enqueue(id, self.owner)
        active = self.claim(id, max_chars=100, ttl=15)
        self.assertEqual(active["batch"]["start"], 100)
        self.now[0] += 16
        replacement = self.claim(id, max_chars=200, ttl=15)
        self.assertEqual(replacement["batch"]["start"], 100)
        with self.assertRaises(MaterialError):
            self.commit(id, active)
        self.commit(id, replacement)
        self.assertEqual(self.reading.get(id, self.owner)["cursors"]["native"], 300)

    def test_prepare_is_outside_write_lock_and_cancel_wins_concurrent_prepare(self):
        id = self.upload()
        self.reading.enqueue(id, self.owner)
        entered, release = Event(), Event()
        original = self.materials.reading_source
        def slow(*args):
            entered.set()
            self.assertTrue(release.wait(5))
            return original(*args)
        with ThreadPoolExecutor(max_workers=2) as pool, patch.object(self.materials, "reading_source", side_effect=slow):
            pending = pool.submit(self.claim, id)
            self.assertTrue(entered.wait(3))
            canceled = pool.submit(self.reading.cancel, id, self.owner).result(timeout=1)
            self.assertEqual(canceled["state"], "CANCELED")
            release.set()
            with self.assertRaisesRegex(MaterialError, "变化"):
                pending.result(timeout=3)
        self.assertEqual(self.reading.get(id, self.owner)["notes"], [])

    def test_only_one_concurrent_claim_wins_and_heartbeat_keeps_lease(self):
        id = self.upload()
        self.reading.enqueue(id, self.owner)
        def attempt():
            try:
                return self.claim(id)
            except MaterialError:
                return None
        with ThreadPoolExecutor(max_workers=4) as pool:
            attempts = list(pool.map(lambda _: attempt(), range(4)))
        winners = [result for result in attempts if result]
        self.assertEqual(len(winners), 1)
        self.now[0] += 50
        self.reading.renew(id, self.owner, winners[0]["job"]["lease"]["id"], ttl=90)
        self.now[0] += 50
        self.commit(id, winners[0])

    def test_deleted_and_repurposed_source_rejects_old_lease(self):
        id = self.upload()
        self.reading.enqueue(id, self.owner)
        batch = self.claim(id, max_chars=100)
        self.commit(id, batch)
        late = self.claim(id, max_chars=100)
        self.materials.set_purpose(id, self.owner, "learning_material", 0, "conversation-one")
        with self.assertRaisesRegex(MaterialError, "版本"):
            self.commit(id, late)
        self.assertEqual(self.reading.enqueue(id, self.owner)["cursors"]["native"], 100)
        again = self.claim(id)
        self.materials.delete(id, self.owner)
        with self.assertRaises(MaterialError):
            self.commit(id, again)
        self.assertFalse((self.materials.root / id).exists(), "late result cannot recreate deleted material")

    def test_pdf_delivery_mode_can_change_without_repeating_committed_pages(self):
        source = self.root / "book.pdf"
        writer = PdfWriter()
        for _ in range(260):
            writer.add_blank_page(width=300, height=400)
        writer.write(source)
        id = self.materials.create(source, source.name, self.owner, purpose="conversation_attachment", conversation_id="conversation-one")["id"]
        self.reading.enqueue(id, self.owner, "basis")
        first = self.claim(id, pdf_input="native_pdf", max_pages=256)
        self.assertEqual((first["batch"]["start"], first["batch"]["end"]), (1, 256))
        self.commit(id, first)
        second = self.claim(id, pdf_input="page_images", max_pages=256)
        self.assertEqual((second["batch"]["start"], second["batch"]["end"]), (257, 259))
        self.commit(id, second)
        last = self.claim(id, pdf_input="page_images")
        self.assertEqual((last["batch"]["start"], last["batch"]["end"]), (260, 260))
        self.commit(id, last)
        final = self.claim(id)
        self.assertEqual(self.commit(id, final, {**NOTE, "uncertainties": ["这一处仍需要核对原文。"]}, sufficient=True)["state"], "NEEDS_REVIEW")

    def test_office_native_and_embedded_images_are_separate_required_batches(self):
        picture = self.root / "original.png"
        Image.new("RGB", (200, 120), "white").save(picture)
        source = self.root / "mixed.docx"
        doc = Document()
        doc.add_paragraph("ORIGINAL_HEAD")
        doc.add_picture(str(picture))
        doc.add_paragraph("ORIGINAL_TAIL")
        doc.save(source)
        id = self.materials.create(source, source.name, self.owner)["id"]
        self.reading.enqueue(id, self.owner)
        native = self.claim(id)
        self.assertIn("ORIGINAL_TAIL", native["batch"]["text"])
        self.commit(id, native)
        images = self.claim(id)
        self.assertEqual(images["batch"]["kind"], "original_images")
        self.assertEqual(len(images["batch"]["assets"]), 1)
        self.commit(id, images)
        integrate = self.claim(id)
        self.assertEqual(self.commit(id, integrate, sufficient=True)["state"], "READY")

    def test_unknown_or_corrupt_storage_is_preserved_and_never_overwritten(self):
        id = self.upload()
        self.reading.enqueue(id, self.owner)
        path = self.materials.root / id / "reading-v1.json"
        value = json.loads(path.read_text(encoding="utf-8"))
        value["version"] = 99
        path.write_text(json.dumps(value), encoding="utf-8")
        before = path.read_bytes()
        with self.assertRaisesRegex(MaterialError, "保留"):
            self.reading.enqueue(id, self.owner)
        self.assertEqual(path.read_bytes(), before)

    def test_actual_resource_http_rejects_foreign_goal_forged_fields_and_late_cancel(self):
        service = build_gradient_demo_learning_service()
        self.owner = service.snapshot().goal_profile.id
        before = deepcopy(service.snapshot())
        id = self.upload()
        app.dependency_overrides[get_learning_service] = lambda: service
        app.dependency_overrides[get_material_store] = lambda: self.materials
        client = TestClient(app)
        path = f"/api/learning/materials/{id}/reading"
        scope = {"expected_goal_id": self.owner}
        queued = client.post(path, params=scope, json={"role": "basis"})
        self.assertEqual(queued.status_code, 200)
        discovered = client.get("/api/learning/material-reading/jobs").json()
        self.assertEqual(discovered["jobs"][0]["source"]["material_id"], id)
        self.assertNotIn("notes", discovered["jobs"][0])
        self.assertEqual(client.post(path + "/claim", params=scope,
                                    json={"reader_id": "worker", "max_chars": True}).status_code, 422)
        self.assertEqual(client.post(path + "/claim", params=scope,
                                    json={"reader_id": "worker", "source_hash": "forged"}).status_code, 422)
        claimed = client.post(path + "/claim", params=scope, json={"reader_id": "worker", "max_chars": 100}).json()
        lease = claimed["job"]["lease"]["id"]
        self.assertEqual(client.get(path, params={"expected_goal_id": "foreign"}).status_code, 409)
        self.assertEqual(client.post(path + "/cancel", params=scope).status_code, 200)
        late = client.post(path + "/commit", params=scope, json={"lease_id": lease, "note": NOTE, "model": MODEL})
        self.assertEqual(late.status_code, 409)
        self.assertEqual(client.get(path, params=scope).json()["notes"], [])
        self.assertEqual(service.snapshot(), before)

    def test_native_snapshot_ignores_old_visual_transcription_and_pending_source_stays_queued(self):
        id = self.upload("真实原文与末尾。")
        self.reading.enqueue(id, self.owner)
        with patch.object(self.materials, "_project", side_effect=AssertionError("must not read machine overlay")):
            batch = self.claim(id)
        self.assertEqual(batch["batch"]["text"], "真实原文与末尾。")
        self.reading.release(id, self.owner, batch["job"]["lease"]["id"])
        with patch.object(self.materials, "reading_source", side_effect=MaterialError("MATERIAL_PROCESSING", "preparing", 425)):
            with self.assertRaises(MaterialError):
                self.claim(id)
        self.assertEqual(self.reading.get(id, self.owner)["state"], "QUEUED")

    def test_preclaim_failure_is_visible_but_cannot_override_an_active_or_newer_batch(self):
        id = self.upload()
        queued = self.reading.enqueue(id, self.owner)
        failed = self.reading.fail_idle(id, self.owner, queued["revision"], "READING_VISION_REQUIRED")
        self.assertEqual(failed["state"], "FAILED")
        self.reading.enqueue(id, self.owner)
        active = self.claim(id)
        with self.assertRaises(MaterialError):
            self.reading.fail_idle(id, self.owner, active["job"]["revision"], "READING_MODEL_UNAVAILABLE")
        self.assertEqual(self.reading.get(id, self.owner)["state"], "READING")

    def test_content_questions_are_not_unread_source_but_real_reading_blockers_prevent_ready(self):
        id = self.upload("q=3v+4。原文未给变量单位。")
        self.reading.enqueue(id, self.owner)
        self.commit(id, self.claim(id))
        integrate = self.claim(id)
        note = {**NOTE, "uncertainties": ["原文未说明变量单位，后续教学需解释。"]}
        result = self.reading.commit(id, self.owner, integrate["job"]["lease"]["id"], note, MODEL, True, [])
        self.assertEqual(result["state"], "READY")
        self.assertEqual(result["synthesis"]["uncertainties"], note["uncertainties"])
        other = self.upload("另一份资料。")
        self.reading.enqueue(other, self.owner)
        self.commit(other, self.claim(other))
        final = self.claim(other)
        result = self.reading.commit(other, self.owner, final["job"]["lease"]["id"], NOTE, MODEL, True, ["附件中的外部图像尚未提供。"])
        self.assertEqual(result["state"], "NEEDS_REVIEW")

    def seed_notes(self, id, count=6):
        self.reading.enqueue(id, self.owner)
        for number in range(count):
            self.commit(id, self.claim(id, max_chars=10), {"summary": f"第{number}批已交付原文。" * 80,
                "facts": [f"事实{number}；原文出处见本批定位。"], "dependencies": ["后章依赖前章定义。"],
                "uncertainties": ["保留原文未定义的单位疑问。"]})

    def test_hierarchical_notes_preserve_originals_cursors_receipts_and_coverage_across_restart(self):
        id = self.upload()
        self.seed_notes(id)
        original = self.reading.get(id, self.owner)
        nodes = context_nodes(original)
        budget = sum(retrieval.estimated_tokens(json.dumps(node, ensure_ascii=False)) for node in nodes[:2])
        folded = self.claim(id, consolidate_notes=True, max_tokens=budget)
        self.assertEqual(folded["batch"]["kind"], "consolidate")
        self.assertEqual((folded["batch"]["start"], folded["batch"]["end"]), (0, 2))
        self.assertEqual(len(folded["batch"]["input_notes"]), 2)
        self.assertNotIn("input_notes", folded["job"]["lease"]["batch"], "no duplicated large context in resource ledger")
        compact = {"summary": "前两批的概念和事实关系。", "facts": ["事实0、事实1；保留原始出处。"],
                   "dependencies": ["后章依赖前章定义。"], "uncertainties": ["原文未定义单位。"]}
        saved = self.commit(id, folded, compact)
        self.assertEqual(saved, self.commit(id, folded, compact), "fold receipt is also exactly idempotent")
        self.assertEqual(saved["notes"], original["notes"])
        self.assertEqual(saved["cursors"], original["cursors"])
        self.assertEqual(saved["rules_version"], "original-reading-v2")
        self.assertEqual([(n["start"], n["end"]) for n in context_nodes(saved)], [(0, 2), (2, 3), (3, 4), (4, 5), (5, 6)])
        self.reading = MaterialReadingStore(self.materials, lambda: self.now[0])
        second = self.claim(id, consolidate_notes=True)
        self.assertEqual(second["batch"]["input_notes"][0]["ref"], saved["folds"][0]["lease_id"])
        result = self.commit(id, second, {"summary": "六批事实0至5及前后依赖，原文单位仍待解释。"})
        view = context_nodes(result)
        self.assertEqual([(n["start"], n["end"], n["level"]) for n in view], [(0, 6, 2)])
        self.assertEqual(result["notes"], original["notes"])
        self.assertEqual(len(result["folds"]), 2, "intermediate machine conclusion remains auditable")
        following = self.claim(id, max_chars=10)
        self.assertEqual(following["batch"]["start"], original["cursors"]["native"])
        self.assertNotEqual(following["batch"]["kind"], "integrate", "folding is not finishing the source")

    def test_note_fold_budget_stop_and_invalid_graph_do_not_erase_or_advance_originals(self):
        id = self.upload()
        self.seed_notes(id, 3)
        before = self.reading.get(id, self.owner)
        with self.assertRaisesRegex(MaterialError, "窗口不足"):
            self.claim(id, consolidate_notes=True, max_tokens=1)
        self.assertEqual(self.reading.get(id, self.owner), before)
        active = self.claim(id, consolidate_notes=True)
        with self.assertRaisesRegex(MaterialError, "未缩至"):
            self.commit(id, active, {"summary": "过度重复。" * 3000})
        self.assertEqual(self.reading.get(id, self.owner)["cursors"], before["cursors"])
        self.assertNotIn("folds", self.reading.get(id, self.owner))
        with self.assertRaisesRegex(MaterialError, "声明完成"):
            self.commit(id, active, sufficient=True)
        self.reading.cancel(id, self.owner)
        with self.assertRaises(MaterialError):
            self.commit(id, active, {"summary": "迟到整合"})
        self.reading.enqueue(id, self.owner)
        result = self.commit(id, self.claim(id, consolidate_notes=True), {"summary": "简明的三批关系。"})
        self.assertLessEqual(note_bytes(result["folds"][0]), result["folds"][0]["max_note_bytes"])
        path = self.materials.root / id / "reading-v1.json"
        invalid = json.loads(path.read_text(encoding="utf-8"))
        invalid.pop("checksum")
        invalid["folds"][0]["input_refs"] = ["not-a-real-note", "not-another-note"]
        invalid["checksum"] = retrieval.checksum(invalid)
        path.write_text(json.dumps(invalid, ensure_ascii=False), encoding="utf-8")
        raw = path.read_bytes()
        with self.assertRaisesRegex(MaterialError, "保留"):
            self.reading.enqueue(id, self.owner)
        self.assertEqual(path.read_bytes(), raw)

    def test_note_consolidation_prepare_is_outside_write_lock_and_cancel_wins(self):
        id = self.upload()
        self.seed_notes(id, 3)
        from app.material_reading_context import prepare_fold
        entered, release = Event(), Event()
        def slow(*args):
            entered.set()
            self.assertTrue(release.wait(5))
            return prepare_fold(*args)
        with ThreadPoolExecutor(max_workers=2) as pool, patch("app.material_reading.prepare_fold", side_effect=slow):
            pending = pool.submit(self.claim, id, consolidate_notes=True)
            self.assertTrue(entered.wait(3))
            canceled = pool.submit(self.reading.cancel, id, self.owner).result(timeout=1)
            self.assertEqual(canceled["state"], "CANCELED")
            release.set()
            with self.assertRaisesRegex(MaterialError, "变化"):
                pending.result(timeout=3)
        actual = self.reading.get(id, self.owner)
        self.assertEqual(actual["cursors"]["native"], 30)
        self.assertNotIn("folds", actual)
