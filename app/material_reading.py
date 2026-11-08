"""原件版本绑定的机器阅读工作。模型调用不在本模块执行，也不拥有学习事实权限。"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import re
import time
from typing import Callable
from uuid import uuid4

from app import retrieval
from app.materials import MaterialError, MaterialStore, material_purpose
from app.material_reading_context import context_nodes, note_bytes, prepare_fold

READING_RULES_VERSION = "original-reading-v1"
FOLDED_READING_RULES_VERSION = "original-reading-v2"
_STATES = {"QUEUED", "READING", "INTEGRATING", "READY", "NEEDS_REVIEW", "FAILED", "CANCELED"}
_IMAGE_FORMATS = {"png", "jpg", "jpeg", "webp", "tiff"}


def _fail(code: str, message: str, status: int = 409):
    raise MaterialError(code, message, status)


class MaterialReadingStore:
    """共享MaterialStore短写锁；批次准备与模型工作锁外执行，成功后CAS提交一次。"""
    def __init__(self, materials: MaterialStore, clock: Callable[[], float] = time.time):
        self.materials, self.clock = materials, clock

    @staticmethod
    def identity(meta: dict) -> dict:
        fmt = meta["format"]
        return {"material_id": meta["id"], "source_hash": meta["sha256"], "format": fmt,
                "scope": meta.get("goal_id") or MaterialStore.draft_scope(meta["onboarding_session_id"]),
                "purpose": material_purpose(meta), "purpose_revision": meta.get("purpose_revision", 0),
                # PDF/图片阅读原件而非解析缓存，不因后台OCR升级重复读相同原页。
                "parser_version": meta["parser_version"] if fmt not in _IMAGE_FORMATS | {"pdf"} else None}

    @staticmethod
    def mode(meta: dict) -> str:
        return "document_pages" if meta["format"] == "pdf" else "original_image" if meta["format"] in _IMAGE_FORMATS else "native_and_images"

    def _path(self, material_id: str, owner: str):
        directory, meta = self.materials._load(material_id, owner)
        path = directory / "reading-v1.json"
        if path.is_symlink():
            _fail("READING_STORAGE_INVALID", "阅读记录路径无法核验。", 503)
        return path, self.identity(meta)

    def _load(self, path) -> dict:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            checksum = value.pop("checksum")
            if (value["version"] != 1 or value["rules_version"] not in (READING_RULES_VERSION, FOLDED_READING_RULES_VERSION)
                    or value["state"] not in _STATES or type(value["revision"]) is not int
                    or type(value["epoch"]) is not int or not isinstance(value["notes"], list)
                    or len(value["notes"]) > 20_000 or not isinstance(value["source"], dict)
                    or not isinstance(value.get("folds", []), list) or len(value.get("folds", [])) > 20_000
                    or not isinstance(value["cursors"], dict)
                    or any(type(value["cursors"].get(key)) is not int or value["cursors"][key] < 0 for key in ("native", "pages", "images"))
                    or retrieval.checksum(value) != checksum):
                raise ValueError()
            if value.get("folds"):
                if value["rules_version"] != FOLDED_READING_RULES_VERSION:
                    raise ValueError()
                context_nodes(value)
            return value
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise MaterialError("READING_STORAGE_INVALID", "阅读记录无法核验，原文件已保留。", 503) from exc

    def _write(self, path, value: dict) -> dict:
        value["revision"] += 1
        value["updated_at"] = self.clock()
        if (len(value["notes"]) > 20_000 or len(value.get("folds", [])) > 20_000
                or len(json.dumps(value, ensure_ascii=False).encode()) > 64 * 1024 * 1024):
            _fail("READING_NOTES_LIMIT", "阅读笔记超过资源上限，原进度已保留。", 422)
        self.materials._atomic_json(path, {**value, "checksum": retrieval.checksum(value)})
        return deepcopy(value)

    def _current(self, material_id: str, owner: str):
        path, identity = self._path(material_id, owner)
        if not path.exists():
            _fail("READING_NOT_FOUND", "尚未创建这份资料的完整阅读任务。", 404)
        job = self._load(path)
        if job["source"] != identity:
            old = job["source"]
            prior_scope = old.get("scope", "")
            if (job["state"] == "READY" and prior_scope.startswith("draft:")
                    and self.materials._bound_goal(prior_scope[6:]) == identity["scope"]
                    and {**old, "scope": identity["scope"]} == identity):
                # Kernel已把同一真实草稿绑定到新Goal；只迁移阅读权限，不伪称重读或丢掉有效结论。
                job.update(source=identity, lease=None, epoch=job["epoch"] + 1)
                self._write(path, job)
            else:
                _fail("READING_SOURCE_CHANGED", "资料归属或版本已变化，请重新确认阅读用途。")
        return path, job

    def enqueue(self, material_id: str, owner: str, role: str = "supplementary") -> dict:
        if role not in ("basis", "supplementary"):
            _fail("INVALID_READING_ROLE", "阅读用途无效。", 422)
        with self.materials._write_lock:
            path, identity = self._path(material_id, owner)
            if path.exists():
                job = self._load(path)
                same_content = all(job["source"].get(key) == identity[key] for key in ("material_id", "source_hash", "format", "parser_version"))
                if same_content:
                    changed_authority = job["source"] != identity
                    if changed_authority or job["state"] in ("CANCELED", "FAILED", "NEEDS_REVIEW"):
                        job.update(source=identity, lease=None, epoch=job["epoch"] + 1, state="QUEUED", error_code=None)
                    if role == "basis":
                        job["role"] = role
                    # 已完成结论不因模型/Provider切换而冒充重读；每份笔记记录实际模型来源。
                    return self._write(path, job)
            seed = json.dumps([material_id, identity["source_hash"], identity["parser_version"], READING_RULES_VERSION])
            job = {"version": 1, "rules_version": READING_RULES_VERSION,
                   "id": "reading-" + hashlib.sha256(seed.encode()).hexdigest()[:32], "source": identity,
                   "mode": self.mode({"format": identity["format"]}), "role": role, "state": "QUEUED",
                   "epoch": 0, "revision": 0, "cursors": {"native": 0, "pages": 0, "images": 0},
                   "layout": None, "notes": [], "synthesis": None, "lease": None, "error_code": None,
                   "created_at": self.clock()}
            return self._write(path, job)

    def get(self, material_id: str, owner: str) -> dict:
        with self.materials._write_lock:
            return deepcopy(self._current(material_id, owner)[1])

    def pending(self, available_goals: set[str], offset: int = 0, limit: int = 100) -> dict:
        """实例启动发现已有资源任务；仅给身份和状态，不授予后台越过当前Goal读取正文的权限。"""
        if type(offset) is not int or type(limit) is not int or offset < 0 or not 1 <= limit <= 100:
            _fail("INVALID_READING_PAGE", "阅读任务分页无效。", 422)
        directories = sorted((item for item in self.materials.root.iterdir()
                              if re.fullmatch(r"mat-[0-9a-f]{32}", item.name) and item.is_dir() and not item.is_symlink()), key=lambda item: item.name)
        jobs, errors = [], []
        for directory in directories[offset:offset + limit]:
            path = directory / "reading-v1.json"
            if not path.exists():
                continue
            try:
                if path.is_symlink():
                    raise ValueError()
                job = self._load(path)
                owner = job["source"]["scope"]
                if not isinstance(owner, str):
                    raise ValueError()
                if owner not in available_goals and not owner.startswith("draft:"):
                    continue
                current = self.get(directory.name, owner)
                if current["state"] in ("QUEUED", "READING", "INTEGRATING"):
                    jobs.append({key: current[key] for key in ("id", "source", "state", "revision", "role")})
            except (MaterialError, ValueError, KeyError, TypeError):
                errors.append({"material_id": directory.name, "code": "READING_REQUIRES_RECHECK"})
        return {"jobs": jobs, "errors": errors, "next_offset": offset + limit if offset + limit < len(directories) else None}

    @staticmethod
    def _layout(snapshot: dict) -> dict:
        return {"native_chars": len(snapshot["native"]), "pages": snapshot["pages"],
                "images": snapshot["assets"], "unit_kind": snapshot["material"]["unit_kind"],
                "warnings": snapshot["material"].get("warnings", []),
                "unread_content": snapshot["material"].get("unread_content", [])}

    def claim(self, material_id: str, owner: str, reader_id: str, *, max_chars: int = 256_000,
              max_tokens: int = 128_000, max_pages: int = 32, max_images: int = 3,
              pdf_input: str = "page_images", ttl: int = 90, consolidate_notes: bool = False) -> dict:
        if (not isinstance(reader_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", reader_id)
                or any(type(v) is not int for v in (max_chars, max_tokens, max_pages, max_images, ttl))
                or not 1 <= max_chars <= 4_000_000 or not 1 <= max_tokens <= 1_000_000
                or not 1 <= max_pages <= 256 or not 1 <= max_images <= 3 or not 15 <= ttl <= 300
                or pdf_input not in ("native_pdf", "page_images") or type(consolidate_notes) is not bool):
            _fail("INVALID_READING_BATCH", "阅读批次预算或租约无效。", 422)
        initial = self.get(material_id, owner)
        if initial["state"] not in ("QUEUED", "READING", "INTEGRATING"):
            _fail("READING_NOT_RUNNABLE", "此阅读任务不处于可执行状态。")
        # 耗时原件检查/页数读取/原生快照不持有课堂或资料写锁。
        if consolidate_notes:
            try:
                folded = prepare_fold(initial, max_tokens)
            except ValueError:
                _fail("READING_CONSOLIDATION_BUDGET_TOO_SMALL", "当前窗口不足以整合相邻笔记，原笔记与进度已保留。", 413)
            layout = initial["layout"]
        else:
            snapshot = self.materials.reading_source(material_id, owner)
            layout = self._layout(snapshot)
        if initial["layout"] is not None and any(initial["layout"][key] != layout[key]
                for key in ("native_chars", "pages", "images", "unit_kind", "unread_content")):
            _fail("READING_LAYOUT_CHANGED", "原件内容布局已变化，不能接着旧进度阅读。")
        cursors = initial["cursors"]
        if consolidate_notes:
            batch = {key: value for key, value in folded.items() if key != "input_notes"}
            payload = {"input_notes": folded["input_notes"]}
        elif cursors["native"] < layout["native_chars"]:
            start = cursors["native"]
            text = retrieval.bounded_prefix(snapshot["native"][start:start + max_chars], max_chars, max_tokens)
            if not text:
                _fail("READING_BUDGET_TOO_SMALL", "当前上下文不足以读取下一段原文。", 422)
            end = start + len(text)
            locator = retrieval.locator(snapshot["offsets"], start, end, layout["unit_kind"])
            batch = {"kind": "native_text", "start": start, "end": end, "locator": locator,
                     "citation_refs": [f"material:{material_id}:{layout['unit_kind']}:{locator['start']}-{locator['end']}"],
                     "content_hash": hashlib.sha256(text.encode()).hexdigest()}
            payload = {"text": text}
        elif cursors["pages"] < layout["pages"]:
            start = cursors["pages"] + 1
            end = min(layout["pages"], start + (max_pages if pdf_input == "native_pdf" else min(max_pages, max_images)) - 1)
            batch = {"kind": pdf_input, "start": start, "end": end,
                     "citation_refs": [f"material:{material_id}:page:{start}-{end}"]}
            payload = {}
        elif cursors["images"] < len(layout["images"]):
            start = cursors["images"]
            end = min(len(layout["images"]), start + max_images)
            batch = {"kind": "original_images", "start": start, "end": end,
                     "assets": layout["images"][start:end],
                     "citation_refs": [f"material:{material_id}:asset:{asset['id']}" for asset in layout["images"][start:end]]}
            payload = {}
        else:
            batch = {"kind": "integrate", "citation_refs": []}
            # 空间足够时整合仍提供完整有效原文；不能把持久笔记当作永久替代原件。
            fits = len(snapshot["native"]) <= max_chars and retrieval.estimated_tokens(snapshot["native"]) <= max_tokens
            payload = {"original_text_complete": fits, "original_text": snapshot["native"] if fits else None}
        with self.materials._write_lock:
            path, job = self._current(material_id, owner)
            if job["revision"] != initial["revision"] or job["epoch"] != initial["epoch"]:
                _fail("READING_CHANGED", "阅读现场已变化，请重新领取。")
            lease = job.get("lease")
            if lease and lease["expires_at"] > self.clock():
                _fail("READING_LEASE_BUSY", "本批阅读已被领取。")
            job["layout"] = layout
            if consolidate_notes:
                # 新规则仅在确实使用分层笔记时提升；旧reader须拒绝v2，不能把整合批次当原图进度。
                job["rules_version"] = FOLDED_READING_RULES_VERSION
            job["lease"] = {"id": uuid4().hex, "reader_id": reader_id, "epoch": job["epoch"],
                            "expires_at": self.clock() + ttl, "batch": batch}
            job["state"] = "INTEGRATING" if batch["kind"] == "integrate" else "READING"
            saved = self._write(path, job)
            return {"job": saved, "batch": {**batch, **payload}}

    def _leased(self, material_id: str, owner: str, lease_id: str):
        path, job = self._current(material_id, owner)
        lease = job.get("lease")
        if (not lease or lease["id"] != lease_id or lease["epoch"] != job["epoch"]
                or lease["expires_at"] <= self.clock() or job["state"] not in ("READING", "INTEGRATING")):
            _fail("READING_LEASE_STALE", "本批阅读已停止、过期或更换，结果不能落盘。")
        return path, job, lease

    def renew(self, material_id: str, owner: str, lease_id: str, ttl: int = 90) -> dict:
        if type(ttl) is not int or not 15 <= ttl <= 300:
            _fail("INVALID_READING_LEASE", "阅读租约无效。", 422)
        with self.materials._write_lock:
            path, job, lease = self._leased(material_id, owner, lease_id)
            lease["expires_at"] = self.clock() + ttl
            return self._write(path, job)

    @staticmethod
    def _note(note: dict, model: dict) -> dict:
        if (not isinstance(note, dict) or not isinstance(model, dict)
                or any(not isinstance(model.get(key), str) or not 1 <= len(model[key]) <= 200 for key in ("provider", "id"))
                or not isinstance(note.get("summary"), str) or not 1 <= len(note["summary"].strip()) <= 24_000):
            _fail("INVALID_READING_NOTE", "阅读笔记或模型来源无效。", 422)
        result = {"summary": note["summary"].strip()}
        for key in ("concepts", "facts", "dependencies", "uncertainties"):
            rows = note.get(key, [])
            if not isinstance(rows, list) or len(rows) > 100 or any(not isinstance(row, str) or not 1 <= len(row.strip()) <= 2000 for row in rows):
                _fail("INVALID_READING_NOTE", "阅读笔记超出允许范围。", 422)
            result[key] = [row.strip() for row in rows]
        return {**result, "model": {key: model[key] for key in ("provider", "id")}}

    def commit(self, material_id: str, owner: str, lease_id: str, note: dict, model: dict,
               sufficient: bool | None = None, reading_blockers: list[str] | None = None) -> dict:
        normalized = self._note(note, model)
        if reading_blockers is not None and (not isinstance(reading_blockers, list) or len(reading_blockers) > 100
                or any(not isinstance(value, str) or not 1 <= len(value.strip()) <= 2000 for value in reading_blockers)):
            _fail("INVALID_READING_NOTE", "原件阅读障碍无效。", 422)
        # 兼容旧调用：未区分障碍字段时保守沿用uncertainties；新调用必须明确分离内容疑问。
        blockers = normalized["uncertainties"] if reading_blockers is None else [value.strip() for value in reading_blockers]
        with self.materials._write_lock:
            path, current = self._current(material_id, owner)
            receipt = next((item for item in current["notes"] + current.get("folds", []) if item["lease_id"] == lease_id), None)
            synthesis = current.get("synthesis")
            saved = receipt or (synthesis if synthesis and synthesis["lease_id"] == lease_id else None)
            if saved:
                if (any(saved[key] != value for key, value in normalized.items())
                        or saved is synthesis and (sufficient != saved["sufficient"] or blockers != saved.get("reading_blockers", saved["uncertainties"]))
                        or receipt is not None and (sufficient is not None or reading_blockers is not None)):
                    _fail("READING_RECEIPT_CONFLICT", "同一阅读提交的内容不一致。")
                return deepcopy(current)
            path, job, lease = self._leased(material_id, owner, lease_id)
            batch = lease["batch"]
            if batch["kind"] == "consolidate":
                if sufficient is not None or reading_blockers is not None:
                    _fail("READING_PREMATURE_COMPLETION", "笔记整合不是原件读完，不能声明完成。", 422)
                if note_bytes(normalized) > batch["max_note_bytes"]:
                    _fail("READING_CONSOLIDATION_NOT_SMALLER", "整合笔记未缩至本批预算，原笔记已保留。", 422)
                job.setdefault("folds", []).append({**normalized, **batch, "lease_id": lease_id, "at": self.clock()})
                context_nodes(job)
                job["state"] = "QUEUED"
            elif batch["kind"] == "integrate":
                if type(sufficient) is not bool:
                    _fail("READING_DECISION_REQUIRED", "整合阶段须明确判断原件阅读是否充分。", 422)
                job["synthesis"] = {**normalized, "lease_id": lease_id, "at": self.clock(), "sufficient": sufficient, "reading_blockers": blockers}
                job["state"] = "READY" if sufficient and not blockers and not job["layout"]["unread_content"] else "NEEDS_REVIEW"
            else:
                if sufficient is not None or reading_blockers is not None:
                    _fail("READING_PREMATURE_COMPLETION", "单批笔记不能声明整份资料已读完。", 422)
                job["notes"].append({**normalized, "batch": batch, "lease_id": lease_id, "at": self.clock()})
                cursor = "native" if batch["kind"] == "native_text" else "pages" if batch["kind"] in ("native_pdf", "page_images") else "images"
                job["cursors"][cursor] = batch["end"]
                job["state"] = "QUEUED"
            job["lease"] = None
            job["error_code"] = None
            return self._write(path, job)

    def release(self, material_id: str, owner: str, lease_id: str, *, failed: bool = False,
                error_code: str | None = None) -> dict:
        if type(failed) is not bool or error_code is not None and (not isinstance(error_code, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", error_code)):
            _fail("INVALID_READING_ERROR", "阅读错误代码无效。", 422)
        with self.materials._write_lock:
            path, job, _ = self._leased(material_id, owner, lease_id)
            job.update(lease=None, state="FAILED" if failed else "QUEUED", error_code=error_code)
            return self._write(path, job)

    def cancel(self, material_id: str, owner: str) -> dict:
        with self.materials._write_lock:
            path, job = self._current(material_id, owner)
            job.update(lease=None, epoch=job["epoch"] + 1, state="CANCELED", error_code=None)
            return self._write(path, job)

    def fail_idle(self, material_id: str, owner: str, expected_revision: int, error_code: str) -> dict:
        """模型/上下文等领取前确定失败须可见；CAS不能覆盖另一个正在读取的批次。"""
        if (type(expected_revision) is not int or not isinstance(error_code, str)
                or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", error_code)):
            _fail("INVALID_READING_ERROR", "阅读错误代码或修订无效。", 422)
        with self.materials._write_lock:
            path, job = self._current(material_id, owner)
            if (job["revision"] != expected_revision or job["state"] not in ("QUEUED", "READING", "INTEGRATING")
                    or job["lease"] and job["lease"]["expires_at"] > self.clock()):
                _fail("READING_CHANGED", "阅读正在进行或现场已变化，不能覆盖当前批次。")
            job.update(lease=None, state="FAILED", error_code=error_code)
            return self._write(path, job)
