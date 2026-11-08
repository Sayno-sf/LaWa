"""目标/新目标草稿作用域内的本地资料；原文件与文本不进入学习账本。"""

from __future__ import annotations

import base64
import binascii
import hashlib
import math
import json
from functools import wraps
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from threading import RLock, Thread
from queue import Queue
import time
from datetime import datetime, timezone
from uuid import uuid4
from collections.abc import Callable

from app import retrieval
from app import material_ocr
from app.material_visuals import overlay, validate_analysis, MAX_VISUAL_BYTES, VISUAL_OVERLAY_VERSION


MAX_FILE_BYTES = 100 * 1024 * 1024
MAX_TEXT_CHARS = 128_000
PARSER_VERSION = "pypdf-6.19.0-native-v1"
PARSER_VERSIONS = {"pdf": PARSER_VERSION, "md": "utf8-v1", "txt": "utf8-v1",
                    "docx": "python-docx-1.2.0-v3", "pptx": "python-pptx-1.0.2-v2",
                    **{fmt: "pillow-12.3.0-v1" for fmt in ("png", "jpg", "jpeg", "webp", "tiff")}}
UNIT_LABELS = {"page": "页", "line": "行", "block": "正文块", "slide": "幻灯片"}


def parser_version(fmt: str, value: dict | None = None) -> str:
    # 旧版原生/OCR缓存仍是可读历史事实。保留其精确版本，避免升级到 native-v1
    # 时批量重解析并丢掉已有OCR文字；只有新提取才写入当前版本。
    if fmt == "pdf" and value:
        existing = value.get("parser_version")
        if isinstance(existing, str) and existing.startswith("pypdf-6.19.0-v3+"):
            return existing
        if existing == "pypdf-6.19.0-v3" and PARSER_VERSION == "pypdf-6.19.0-native-v1":
            return existing
    if fmt == "pdf":
        return PARSER_VERSION
    return PARSER_VERSIONS[fmt]
_ID = re.compile(r"^mat-[0-9a-f]{32}$")
_SESSION = re.compile(r"^[a-zA-Z0-9_-]{1,128}$")
MATERIAL_PURPOSES = frozenset(("conversation_attachment", "learning_material"))


def material_purpose(meta: dict) -> str:
    """旧资料保持既有入库身份；未知新用途不自动进入长期检索。"""
    value = meta.get("purpose", "learning_material")
    return value if isinstance(value, str) else "invalid"


class MaterialError(Exception):
    def __init__(self, code: str, message: str, status: int = 422):
        super().__init__(message)
        self.code = code
        self.status = status


def _digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def _current_material_result(function):
    """慢读取锁外，返回前的短边界拒绝已经删除的原件；不让迟到正文重新作为当前资料交付。"""
    @wraps(function)
    def guarded(self, material_id, goal_id, *args, **kwargs):
        value = function(self, material_id, goal_id, *args, **kwargs)
        with self._write_lock:
            if material_id is not None:
                self._directory(material_id)
            else:
                from app.material_deletions import MaterialDeletions
                value["matches"] = [row for row in value["matches"] if not MaterialDeletions(self).contains(row["material_id"])]
                value["status"] = "matches" if value["matches"] else "no_relevant_match"
            return value
    return guarded


class MaterialStore:
    def __init__(self, root: Path, *, pdf_worker_path: Path | None = None,
                 parse_timeout_seconds: float = 120,
                 scope_is_available: Callable[[str], bool] = lambda _scope: True):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._pdf_worker_path = pdf_worker_path or Path(__file__).with_name("material_worker.py")
        if not math.isfinite(parse_timeout_seconds) or not .01 <= parse_timeout_seconds <= 1800:
            raise ValueError("Material parser timeout must be 0.01..1800 seconds")
        self._parse_timeout_seconds = parse_timeout_seconds
        self.scope_is_available = scope_is_available
        self._write_lock = RLock()
        self._hash_cache: dict[str, tuple[tuple[int, int, int], str]] = {}
        self._parse_queue: Queue[str | None] = Queue()
        self._queued: set[str] = set()
        self._worker: Thread | None = None
        # 元数据就是持久解析任务。重启重新排入未完成任务，不恢复旧内存 Future。
        for directory in self.root.iterdir():
            if directory.is_dir() and not directory.is_symlink() and _ID.fullmatch(directory.name):
                try:
                    meta = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
                    if not self.metadata_is_available(meta):
                        continue
                    if meta.get("parse_status") in ("queued", "processing") or (
                            meta.get("parse_status", "ready") == "ready"
                            and meta.get("parser_version") != parser_version(meta["format"], meta)):
                        meta.update(parse_status="queued", parse_error=None)
                        self._atomic_json(directory / "metadata.json", meta)
                        self._schedule(directory.name)
                except (OSError, ValueError):
                    pass

    def _schedule(self, material_id: str) -> None:
        with self._write_lock:
            if material_id not in self._queued:
                self._queued.add(material_id)
                self._parse_queue.put(material_id)
            if self._worker is None or not self._worker.is_alive():
                self._worker = Thread(target=self._parse_loop, daemon=True, name="material-parser")
                self._worker.start()

    def _parse_loop(self) -> None:
        while True:
            material_id = self._parse_queue.get()
            if material_id is None:
                self._parse_queue.task_done()
                return
            try:
                self._process(material_id)
            except Exception:
                # 单份资料故障已在 _process 留下状态；不能杀死后续资料的 worker。
                pass
            finally:
                with self._write_lock:
                    self._queued.discard(material_id)
                    path = self.root / material_id / "metadata.json"
                    if path.is_file() and not path.is_symlink():
                        meta = json.loads(path.read_text(encoding="utf-8"))
                        if meta.get("parse_status") == "queued" and self.metadata_is_available(meta):
                            self._schedule(material_id)
                self._parse_queue.task_done()

    def _process(self, material_id: str) -> None:
        from app.material_deletions import MaterialDeletions
        directory = self._directory(material_id)
        staging = directory / (".text-" + uuid4().hex + ".json")
        with self._write_lock:
            if MaterialDeletions(self).contains(material_id):
                return
            meta = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
            if not self.metadata_is_available(meta):
                return
            meta.update(parse_status="processing", parse_error=None)
            self._atomic_json(directory / "metadata.json", meta)
        try:
            owner = meta.get("goal_id") or "draft:" + str(meta.get("onboarding_session_id", ""))
            extracted = self._extract(directory / "source", meta["format"], staging, owner=owner)
            version = parser_version(meta["format"], extracted)
            extracted.update(source_hash=meta["sha256"], parser_version=version,
                             checksum=retrieval.checksum(extracted["units"]))
            self._atomic_json(staging, extracted)
            with self._write_lock:
                # 发布时重读归属，避免后台完成覆盖期间发生的草稿绑定或删除。
                if MaterialDeletions(self).contains(material_id):
                    return
                latest = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
                if not self.metadata_is_available(latest):
                    latest.update(parse_status="queued", parse_error=None)
                    self._atomic_json(directory / "metadata.json", latest)
                    return
                if latest["sha256"] != meta["sha256"] or self._verified_hash(directory / "source") != meta["sha256"]:
                    raise MaterialError("MATERIAL_CHANGED", "原件已变化，丢弃后台转录。", 409)
                # OCR 不改原生提取；身份一致才迁移旧视觉结构，避免无谓重发整份资料。
                visual = self._reusable_visual(directory, latest, extracted, version)
                os.replace(staging, directory / "text.json")
                if visual:
                    self._atomic_json(directory / "visual.json", visual)
                latest.update(parse_status="ready", parse_error=None, parser_version=version,
                              ocr_disabled=extracted.get("ocr_disabled", False),
                              unit_count=len(extracted["units"]), unit_kind=extracted.get("unit_kind", "line"),
                              unit_headings=extracted.get("headings", []),
                              unit_tables=extracted.get("tables", []),
                              unit_sections=extracted.get("sections", []),
                              visual_assets=extracted.get("visual_assets", []),
                              visual_revision=retrieval.checksum(visual) if visual else "",
                              visual_completed=len(visual.get("results", {})),
                              ocr=material_ocr.summary(extracted.get("ocr")),
                              ocr_revision=retrieval.checksum(extracted["ocr"]) if extracted.get("ocr") is not None else "",
                              warnings=extracted["warnings"])
                if visual.get("results"):
                    if len(visual["results"]) == len(latest["visual_assets"]):
                        latest["warnings"] = [w for w in latest["warnings"] if w != "VISUAL_RECOGNITION_PENDING"]
                    if "MACHINE_TRANSCRIPTION_REQUIRES_CHECK" not in latest["warnings"]:
                        latest["warnings"].insert(0, "MACHINE_TRANSCRIPTION_REQUIRES_CHECK")
                latest["readable"] = any(u.strip() for u in self._project(directory, dict(latest), extracted, visual))
                self._atomic_json(directory / "metadata.json", latest)
        except Exception as exc:
            with self._write_lock:
                # 删除已经提交，解析器的退出处理不得再写queued元数据，把正在清空的目录重新填满。
                if MaterialDeletions(self).contains(material_id):
                    return
                if directory.is_dir() and not directory.is_symlink():
                    latest = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
                    if not self.metadata_is_available(latest) or getattr(exc, "code", "") == "GOAL_RECYCLED":
                        latest.update(parse_status="queued", parse_error=None)
                    else:
                        latest.update(parse_status="failed", readable=False,
                                      parse_error={"code": getattr(exc, "code", "PARSE_FAILED"), "message": str(exc)[:300]})
                    self._atomic_json(directory / "metadata.json", latest)
            raise
        finally:
            staging.unlink(missing_ok=True)

    def retry(self, material_id: str, goal_id: str) -> dict:
        """用户重试只重排失败任务；归属核对和元数据发布与草稿绑定共用锁。"""
        with self._write_lock:
            directory, meta = self._load(material_id, goal_id)
            ocr = meta.get("ocr") or {}
            if meta.get("parse_status") == "failed" or ocr.get("status") == "unavailable" or ocr.get("failed_pages", 0):
                meta.update(parse_status="queued", parse_error=None)
                self._atomic_json(directory / "metadata.json", meta)
                self._schedule(material_id)
            return meta

    def close(self) -> None:
        """关闭前等已接收解析任务结束，释放原件句柄；测试清理/正常退出使用。"""
        self._parse_queue.join()
        if self._worker and self._worker.is_alive():
            self._parse_queue.put(None)
            self._worker.join(timeout=2)

    def _verified_hash(self, source: Path) -> str:
        stat = source.stat()
        stamp = (stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
        cached = self._hash_cache.get(str(source))
        if cached and cached[0] == stamp:
            return cached[1]
        value = _digest(source)
        self._hash_cache[str(source)] = (stamp, value)
        return value

    def _reusable_visual(self, directory: Path, meta: dict, extracted: dict, version: str) -> dict:
        """只允许原生解析相同的 OCR 升级/重试复用；不猜测损坏或改版缓存的身份。"""
        if not meta.get("visual_revision") or meta["parser_version"] not in (PARSER_VERSION, version):
            return {}
        try:
            text_path, visual_path = directory / "text.json", directory / "visual.json"
            if text_path.is_symlink() or visual_path.is_symlink():
                return {}
            old = json.loads(text_path.read_text(encoding="utf-8"))
            visual = json.loads(visual_path.read_text(encoding="utf-8"))
            if (old.get("source_hash") != meta["sha256"] or old.get("parser_version") != meta["parser_version"]
                    or old.get("checksum") != retrieval.checksum(old["units"]) or old["units"] != extracted["units"]
                    or meta.get("visual_assets", []) != extracted.get("visual_assets", [])
                    or visual.get("source_hash") != meta["sha256"] or visual.get("parser_version") != meta["parser_version"]
                    or retrieval.checksum(visual) != meta["visual_revision"]):
                return {}
            return {**visual, "parser_version": version}
        except (OSError, ValueError, KeyError, TypeError):
            return {}

    def _project(self, directory: Path, meta: dict, extracted: dict, visual: dict | None = None) -> list[str]:
        """合并旧版 OCR 只读兼容缓存与视觉结果，不把它们写成原生文字。"""
        ocr = extracted.get("ocr")
        revision = retrieval.checksum(ocr) if ocr is not None else ""
        if meta.get("ocr_revision", "") != revision:
            raise ValueError("Invalid OCR cache")
        units, annotations, warnings = material_ocr.project(extracted["units"], ocr)
        return overlay(units, meta, self._visual_cache(directory, meta) if visual is None else visual,
                       base_annotations=annotations, base_warnings=warnings)

    @staticmethod
    def draft_scope(session_id: str) -> str:
        if not _SESSION.fullmatch(session_id):
            raise MaterialError("INVALID_DRAFT", "Invalid material draft", 422)
        return "draft:" + session_id

    def _binding_path(self, session_id: str) -> Path:
        self.draft_scope(session_id)
        return self.root / (".draft-binding-" + session_id + ".json")

    def _bound_goal(self, session_id: str) -> str | None:
        path = self._binding_path(session_id)
        if path.is_symlink():
            raise MaterialError("INVALID_DRAFT", "Invalid material draft binding", 409)
        if not path.exists():
            return None
        try:
            goal_id = json.loads(path.read_text(encoding="utf-8"))["goal_id"]
            if not isinstance(goal_id, str) or not goal_id or goal_id.startswith("draft:"):
                raise ValueError("Invalid Goal binding")
            return goal_id
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise MaterialError("INVALID_DRAFT", "Material draft binding is unavailable", 409) from exc

    def _belongs(self, metadata: dict, scope: str) -> bool:
        if scope.startswith("draft:"):
            session_id = scope[6:]
            return (metadata.get("onboarding_session_id") == session_id and
                    metadata.get("goal_id") in (None, self._bound_goal(session_id)))
        return metadata.get("goal_id") == scope

    def bind_draft(self, session_id: str, goal_id: str) -> None:
        """初始化成功后绑定当前草稿；原 ID/hash/引用保持不变，可幂等恢复部分写入。"""
        with self._write_lock:
            self.validate_draft_binding(session_id, goal_id)
            # 先保存唯一目标；并发或迟到上传也读取这一绑定，不能掉回旧前台目标。
            path = self._binding_path(session_id)
            temporary = path.with_name(path.name + "." + uuid4().hex + ".tmp")
            try:
                temporary.write_text(json.dumps({"goal_id": goal_id}), encoding="utf-8")
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)
            for item in self.list(self.draft_scope(session_id), limit=20, include_attachments=True)["materials"]:
                self._bind_item(item, goal_id)
            # 列表分页有界，但绑定属于内部生命周期操作，处理所有草稿文件。
            offset = 20
            while True:
                items = self.list(self.draft_scope(session_id), limit=20, offset=offset, include_attachments=True)["materials"]
                if not items:
                    break
                for item in items:
                    self._bind_item(item, goal_id)
                offset += 20

    def validate_draft_binding(self, session_id: str, goal_id: str) -> None:
        previous = self._bound_goal(session_id)
        if previous is not None and previous != goal_id:
            raise MaterialError("DRAFT_ALREADY_BOUND", "Draft already belongs to another Goal", 409)
        offset = 0
        while True:
            items = self.list(self.draft_scope(session_id), limit=20, offset=offset, include_attachments=True)["materials"]
            if not items:
                return
            for item in items:
                self._load(item["id"], self.draft_scope(session_id))
            offset += 20

    def _bind_item(self, item: dict, goal_id: str) -> None:
        directory, metadata = self._load(item["id"], self.draft_scope(item["onboarding_session_id"]))
        metadata["goal_id"] = goal_id
        temporary = directory / (".metadata-" + uuid4().hex + ".json")
        try:
            temporary.write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
            os.replace(temporary, directory / "metadata.json")
        finally:
            temporary.unlink(missing_ok=True)

    def _directory(self, material_id: str) -> Path:
        if not _ID.fullmatch(material_id):
            raise MaterialError("INVALID_MATERIAL_ID", "Invalid material id", 404)
        from app.material_deletions import MaterialDeletions
        if MaterialDeletions(self).contains(material_id):
            raise MaterialError("MATERIAL_NOT_FOUND", "资料已删除，不能继续作为当前来源。", 404)
        directory = self.root / material_id
        if directory.is_symlink() or not directory.is_dir() or directory.resolve() != directory:
            raise MaterialError("MATERIAL_NOT_FOUND", "Material is unavailable", 404)
        return directory

    def _load(self, material_id: str, goal_id: str, *, allow_unavailable: bool = False) -> tuple[Path, dict]:
        directory = self._directory(material_id)
        if (directory / "metadata.json").is_symlink():
            raise MaterialError("MATERIAL_CHANGED", "Material metadata is invalid", 409)
        try:
            metadata = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise MaterialError("MATERIAL_UNAVAILABLE", "Material metadata is unavailable", 404) from exc
        if metadata.get("id") != material_id:
            raise MaterialError("MATERIAL_CHANGED", "Material metadata is invalid", 409)
        if material_purpose(metadata) not in MATERIAL_PURPOSES:
            raise MaterialError("INVALID_PURPOSE", "Material purpose requires a compatible reader", 409)
        if not allow_unavailable and not self.metadata_is_available(metadata):
            raise MaterialError("MATERIAL_NOT_FOUND", "Learning goal is in the recycle bin", 404)
        if not self._belongs(metadata, goal_id):
            raise MaterialError("MATERIAL_NOT_FOUND", "Material is unavailable in this Goal", 404)
        source = directory / "source"
        if source.is_symlink() or not source.is_file() or self._verified_hash(source) != metadata.get("sha256"):
            raise MaterialError("MATERIAL_CHANGED", "Material content changed; upload again", 409)
        return directory, metadata

    def _extract(self, source: Path, fmt: str, target: Path, *, owner: str | None = None) -> dict:
        if fmt in ("md", "txt"):
            try:
                units = source.read_text(encoding="utf-8-sig").splitlines()
            except UnicodeError as exc:
                raise MaterialError("INVALID_UTF8", "Text must be UTF-8") from exc
            if sum(map(len, units)) > 20_000_000:
                raise MaterialError("EXTRACTED_TEXT_LIMIT", "Extracted text exceeds 20 million characters")
            warnings = ["MARKDOWN_IMAGE_REFERENCES_NOT_FETCHED"] if fmt == "md" and re.search(r"!\[[^\]]*\]", "\n".join(units)) else []
            extracted = {"units": units, "warnings": warnings, "unit_kind": "line"}
            target.write_text(json.dumps(extracted, ensure_ascii=False), encoding="utf-8")
            return extracted
        # 回收目标后中止正在解析的大文件；只传最小环境，绝不继承模型密钥。
        env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "WINDIR", "TMP", "TEMP") if key in os.environ}
        try:
            # 调用方传入已核实的归属，元数据在进程启动前被永久删除也能及时取消。
            if owner and not self.scope_is_available(owner):
                raise MaterialError("GOAL_RECYCLED", "Goal parsing paused", 409)
            command = [sys.executable, "-I", str(self._pdf_worker_path), str(source), str(target), fmt]
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
            )
            deadline = time.monotonic() + self._parse_timeout_seconds
            while True:
                from app.material_deletions import MaterialDeletions
                if _ID.fullmatch(source.parent.name) and MaterialDeletions(self).contains(source.parent.name):
                    raise MaterialError("MATERIAL_REMOVED", "资料已删除，停止后台解析。", 404)
                if not source.is_file() or source.is_symlink():
                    raise MaterialError("MATERIAL_REMOVED", "资料已删除，停止后台解析。", 404)
                if (source.parent / "metadata.json").exists():
                    meta = json.loads((source.parent / "metadata.json").read_text(encoding="utf-8"))
                    owner = meta.get("goal_id") or "draft:" + str(meta.get("onboarding_session_id", ""))
                # 永久删除可能先移走元数据，仍按最后核实的归属终止子进程。
                if owner and not self.scope_is_available(owner):
                    raise MaterialError("GOAL_RECYCLED", "Goal parsing paused", 409)
                if time.monotonic() >= deadline:
                    raise MaterialError("PARSE_TIMEOUT", "Material parsing exceeded the configured time limit", 422)
                try:
                    _, stderr = process.communicate(timeout=min(.2, max(.01, deadline - time.monotonic())))
                    break
                except subprocess.TimeoutExpired:
                    continue
        finally:
            if "process" in locals() and process.poll() is None:
                process.kill()
                process.communicate()
        if process.returncode:
            detail = stderr.strip().splitlines()[0:1]
            code = detail[0] if detail and detail[0] in ("ENCRYPTED_PDF", "PDF_PAGE_LIMIT", "SLIDE_LIMIT",
                                                       "OFFICE_EXPANDED_LIMIT", "EXTRACTED_TEXT_LIMIT") else "INVALID_" + fmt.upper()
            raise MaterialError(code, "Material cannot be extracted: " + (detail[0] if detail else code))
        return json.loads(target.read_text(encoding="utf-8"))

    def create(self, temporary_upload: Path, filename: str, goal_id: str, *, background: bool = False,
               purpose: str = "learning_material", conversation_id: str | None = None) -> dict:
        self._validate_purpose(purpose, conversation_id)
        if not self.scope_is_available(goal_id):
            raise MaterialError("GOAL_RECYCLED", "Goal is in the recycle bin", 409)
        name = Path(filename.replace("\\", "/")).name.strip()
        fmt = Path(name).suffix.lower().lstrip(".")
        if not name or name != filename.strip() or fmt not in PARSER_VERSIONS or len(name) > 255:
            raise MaterialError("UNSUPPORTED_FORMAT", "Choose PDF, MD, TXT, DOCX, PPTX, PNG, JPG, WEBP or TIFF")
        if temporary_upload.stat().st_size > MAX_FILE_BYTES:
            raise MaterialError("FILE_TOO_LARGE", "File exceeds 100 MiB", 413)
        if fmt == "pdf":
            with temporary_upload.open("rb") as source:
                if not source.read(5).startswith(b"%PDF-"):
                    raise MaterialError("INVALID_PDF", "File content is not a PDF")
        material_id = "mat-" + uuid4().hex
        staging = Path(tempfile.mkdtemp(prefix=".upload-", dir=self.root))
        try:
            source = staging / "source"
            shutil.copyfile(temporary_upload, source)
            extracted = ({"units": [], "warnings": [], "unit_kind": {"pdf": "page", "docx": "block", "pptx": "slide"}.get(fmt, "line")}
                         if background else self._extract(source, fmt, staging / "text.json"))
            units = extracted["units"]
            metadata = {
                "id": material_id, "name": name, "format": fmt, "goal_id": goal_id,
                "purpose": purpose, "purpose_revision": 0, "conversation_id": conversation_id,
                "ocr_disabled": True,
                "sha256": _digest(source), "parser_version": parser_version(fmt, extracted),
                "created_at": datetime.now(timezone.utc).isoformat(),
                "unit_count": len(units), "unit_kind": extracted.get("unit_kind", "line"),
                "unit_headings": extracted.get("headings", []),
                "unit_tables": extracted.get("tables", []),
                "unit_sections": extracted.get("sections", []),
                "visual_assets": extracted.get("visual_assets", []), "visual_revision": "",
                "ocr": material_ocr.summary(extracted.get("ocr")),
                "ocr_revision": retrieval.checksum(extracted["ocr"]) if extracted.get("ocr") is not None else "",
                "parse_status": "queued" if background else "ready", "parse_error": None,
                "size_bytes": source.stat().st_size,
                "readable": any(unit.strip() for unit in units),
                "warnings": extracted["warnings"],
            }
            extracted.update(source_hash=metadata["sha256"], parser_version=metadata["parser_version"],
                             checksum=retrieval.checksum(units))
            metadata["readable"] = any(u.strip() for u in self._project(staging, dict(metadata), extracted, {}))
            (staging / "text.json").write_text(json.dumps(extracted, ensure_ascii=False), encoding="utf-8")
            with self._write_lock:
                if goal_id.startswith("draft:"):
                    session_id = goal_id[6:]
                    metadata["goal_id"] = self._bound_goal(session_id)
                    metadata["onboarding_session_id"] = session_id
                (staging / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
                os.replace(staging, self.root / material_id)
            if background:
                self._schedule(material_id)
            return metadata
        finally:
            if staging.exists():
                shutil.rmtree(staging)

    @staticmethod
    def _validate_purpose(purpose: str, conversation_id: str | None) -> None:
        if not isinstance(purpose, str) or purpose not in MATERIAL_PURPOSES:
            raise MaterialError("INVALID_PURPOSE", "Unknown material purpose")
        if conversation_id is not None and not _SESSION.fullmatch(conversation_id):
            raise MaterialError("INVALID_CONVERSATION", "Invalid attachment conversation")
        if purpose == "conversation_attachment" and not conversation_id:
            raise MaterialError("INVALID_CONVERSATION", "Attachments require their originating conversation")

    def metadata(self, material_id: str, goal_id: str) -> dict:
        """读取原件身份，不因扫描件无文字或解析尚未完成而无法选择用途。"""
        _, meta = self._load(material_id, goal_id)
        return self._public_metadata(meta)

    def conversation_reference_scope(self, material_id: str, session_id: str, goal_id: str | None,
                                     available_goals: set[str]) -> str:
        """原消息回看只解析已有归属；不激活历史Goal，也不凭浏览器给定ID跨目标读取。"""
        draft = self.draft_scope(session_id)
        bound = self._bound_goal(session_id)
        candidates = [(goal_id, False), (bound, True), (draft if not bound else None, True)]
        for owner, require_origin in candidates:
            if not owner or (not owner.startswith("draft:") and owner not in available_goals):
                continue
            try:
                _, meta = self._load(material_id, owner)
            except MaterialError as exc:
                if exc.status == 404:
                    continue
                raise
            if require_origin and session_id not in (meta.get("conversation_id"), meta.get("onboarding_session_id")):
                continue
            return owner
        raise MaterialError("MATERIAL_NOT_FOUND", "附件已删除或不属于原对话。", 404)

    def reading_source(self, material_id: str, owner: str) -> dict:
        """完整阅读的原件快照；不调用OCR/视觉转录，也不把旧机器说明混进原生正文。"""
        directory, meta = self._load(material_id, owner)
        original_identity = (meta["sha256"], meta["parser_version"], meta.get("purpose_revision", 0))
        fmt = meta["format"]
        native, offsets, assets, pages = "", [], [], 0
        if fmt == "pdf":
            pages = self.visual_manifest(material_id, owner, limit=1)["unit_count"]
        elif fmt in ("png", "jpg", "jpeg", "webp", "tiff"):
            assets = [{"id": "image-1", "unit": 1, "label": "原始图片"}]
        else:
            if meta.get("parse_status") in ("queued", "processing"):
                raise MaterialError("MATERIAL_PROCESSING", "资料原生内容仍在准备。", 425)
            if meta.get("parse_status") == "failed":
                raise MaterialError("READING_NATIVE_UNAVAILABLE", "资料原生内容无法读取，不能完成整份阅读。", 422)
            cache = directory / "text.json"
            try:
                if cache.is_symlink():
                    raise ValueError()
                value = json.loads(cache.read_text(encoding="utf-8"))
                units = value["units"]
                if (not isinstance(units, list) or len(units) != meta["unit_count"]
                        or any(not isinstance(unit, str) for unit in units)
                        or value.get("source_hash") != meta["sha256"]
                        or value.get("parser_version") != meta["parser_version"]
                        or value.get("checksum") != retrieval.checksum(units)):
                    raise ValueError()
                native, offsets = retrieval.source_text(units)
                assets = [{"id": item["id"], "unit": item["unit"], "label": item["label"]}
                          for item in meta.get("visual_assets", [])]
                if (len({item["id"] for item in assets}) != len(assets)
                        or any(not isinstance(item["id"], str) or not re.fullmatch(r"[A-Za-z0-9-]{1,100}", item["id"])
                               or type(item["unit"]) is not int or not 1 <= item["unit"] <= len(units)
                               or not isinstance(item["label"], str) for item in assets)):
                    raise ValueError()
            except (OSError, ValueError, KeyError, TypeError) as exc:
                raise MaterialError("READING_NATIVE_CHANGED", "原生资料缓存无法核验，请重新准备原件。", 409) from exc
        _, latest = self._load(material_id, owner)
        if original_identity != (latest["sha256"], latest["parser_version"], latest.get("purpose_revision", 0)):
            raise MaterialError("READING_SOURCE_CHANGED", "阅读准备期间资料版本已变化。", 409)
        return {"material": self._public_metadata(latest), "native": native, "offsets": offsets,
                "assets": assets, "pages": pages}

    def document_batch(self, material_id: str, goal_id: str, start: int = 1, end: int | None = None) -> dict:
        """交付原PDF页，独立于正文解析状态；切页锁外执行，发布前再次核对用途与原件。"""
        end = start if end is None else end
        if type(start) is not int or type(end) is not int or not 1 <= start <= end or end - start + 1 > 256:
            raise MaterialError("INVALID_DOCUMENT_RANGE", "原PDF批次最多256页，仍须满足上下文与文件体积限制。")
        with self._write_lock:
            directory, meta = self._load(material_id, goal_id)
            if meta["format"] != "pdf":
                raise MaterialError("UNSUPPORTED_DOCUMENT", "此入口只接受PDF，其他格式请使用原有文字或原图读取。")
            identity = (meta["sha256"], material_purpose(meta), meta.get("purpose_revision", 0), meta.get("conversation_id"))
        env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "WINDIR", "TMP", "TEMP") if key in os.environ}
        with tempfile.TemporaryDirectory(prefix="document-batch-") as temporary:
            target = Path(temporary) / "batch.json"
            try:
                command = [sys.executable, "-I", str(Path(__file__).with_name("document_batch_worker.py")),
                           str(directory / "source"), str(target), meta["sha256"], str(start), str(end)]
                process = subprocess.run(command, capture_output=True, text=True, env=env, timeout=30)
                if process.returncode:
                    code = process.stderr.strip()
                    allowed = {"INVALID_DOCUMENT_RANGE", "DOCUMENT_SIZE_LIMIT", "MATERIAL_CHANGED", "ENCRYPTED_PDF", "DOCUMENT_BATCH_SIZE_LIMIT"}
                    raise MaterialError(code if code in allowed else "INVALID_DOCUMENT", "原PDF本批页面无法读取，请核对页码或减少本批页数。")
                if target.stat().st_size > 12 * 1024 * 1024:
                    raise ValueError()
                packet = json.loads(target.read_text(encoding="utf-8"))
                data = base64.b64decode(packet["data"], validate=True)
                if (not data.startswith(b"%PDF-") or len(data) > 8 * 1024 * 1024
                        or hashlib.sha256(data).hexdigest() != packet["content_hash"]
                        or packet["source_hash"] != meta["sha256"] or packet["start"] != start or packet["end"] != end):
                    raise ValueError()
            except (subprocess.TimeoutExpired, ValueError, KeyError, OSError) as exc:
                raise MaterialError("DOCUMENT_BATCH_FAILED", "原PDF本批页面读取失败或超时，请减少本批页数后重试。") from exc
        with self._write_lock:
            _, current = self._load(material_id, goal_id)
            if identity != (current["sha256"], material_purpose(current), current.get("purpose_revision", 0), current.get("conversation_id")):
                raise MaterialError("MATERIAL_CHANGED", "资料用途或版本已变化，请重新读取。", 409)
        return {**packet, "material_id": material_id, "name": meta["name"],
                "purpose_revision": meta.get("purpose_revision", 0), "scope": goal_id,
                "citation": f"{meta['name']}，第 {start}-{end} 页", "machine_reading": True}

    def set_purpose(self, material_id: str, goal_id: str, purpose: str, expected_revision: int,
                    conversation_id: str | None = None) -> dict:
        # 只改变资料用途，不移动原件或改写学习事实；版本冲突拒绝，不能覆盖并发用户决定。
        with self._write_lock:
            directory, meta = self._load(material_id, goal_id)
            origin = meta.get("conversation_id") or conversation_id
            self._validate_purpose(purpose, origin)
            revision = meta.get("purpose_revision", 0)
            if type(expected_revision) is not int or expected_revision != revision:
                raise MaterialError("PURPOSE_CONFLICT", "Material purpose changed; reload first", 409)
            if meta.get("conversation_id") and conversation_id and conversation_id != meta["conversation_id"]:
                raise MaterialError("PURPOSE_CONFLICT", "Attachment origin cannot be changed", 409)
            if material_purpose(meta) != purpose:
                meta.update(purpose=purpose, purpose_revision=revision + 1, conversation_id=origin)
                self._atomic_json(directory / "metadata.json", meta)
            return self._public_metadata(meta)

    def list(self, goal_id: str, limit: int = 20, offset: int = 0, *,
             include_attachments: bool = False, conversation_id: str | None = None) -> dict:
        if not 1 <= limit <= 20 or offset < 0:
            raise MaterialError("INVALID_RANGE", "Invalid list range")
        items = []
        for directory in self.root.iterdir():
            if directory.is_symlink() or not _ID.fullmatch(directory.name):
                continue
            try:
                if (directory / "metadata.json").is_symlink():
                    continue
                meta = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
                if not self.metadata_is_available(meta):
                    continue
                eligible = material_purpose(meta) == "learning_material" or include_attachments
                if (meta.get("id") == directory.name and self._belongs(meta, goal_id) and eligible
                        and (conversation_id is None or meta.get("conversation_id") == conversation_id)):
                    items.append(meta)
            except (OSError, ValueError):
                continue
        items.sort(key=lambda item: (item["created_at"], item["id"]), reverse=True)
        return {"goal_id": self._bound_goal(goal_id[6:]) if goal_id.startswith("draft:") else goal_id,
                "onboarding_session_id": goal_id[6:] if goal_id.startswith("draft:") else None,
                "materials": [self._public_metadata(item) for item in items[offset:offset + limit]],
                "next_offset": offset + limit if offset + limit < len(items) else None,
                "total": len(items)}

    def _text(self, directory: Path, metadata: dict, *, allow_rebuild: bool = True) -> list[str]:
        if metadata.get("parse_status") in ("queued", "processing"):
            until = time.monotonic() + 2
            while metadata.get("parse_status") in ("queued", "processing") and time.monotonic() < until:
                time.sleep(.02)
                metadata.update(json.loads((directory / "metadata.json").read_text(encoding="utf-8")))
            if metadata.get("parse_status") in ("queued", "processing"):
                raise MaterialError("MATERIAL_PROCESSING", "资料正在后台解析，请稍后重试。", 425)
        if metadata.get("parse_status") == "failed":
            error = metadata.get("parse_error") or {}
            raise MaterialError(error.get("code", "PARSE_FAILED"), error.get("message", "资料解析失败。"), 422)
        path = directory / "text.json"
        if path.is_symlink():
            raise MaterialError("MATERIAL_CHANGED", "Text cache is invalid", 409)
        try:
            cached = json.loads(path.read_text(encoding="utf-8"))
            units = cached["units"]
            version = parser_version(metadata["format"], metadata)
            if (not isinstance(units, list) or len(units) != metadata["unit_count"]
                    or any(not isinstance(unit, str) for unit in units)
                    or metadata["parser_version"] != version
                    or cached.get("parser_version") != version
                    or cached.get("source_hash") != metadata["sha256"]
                    or cached.get("checksum") != retrieval.checksum(units)):
                raise ValueError("Invalid text cache")
            return self._project(directory, metadata, cached)
        except (OSError, UnicodeError, ValueError, KeyError, TypeError):
            if not allow_rebuild or metadata["format"] == "pdf":
                # 查询回读不能同步解析长文件；持久化修复任务，让后台恢复后再重新检索。
                with self._write_lock:
                    latest = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
                    latest.update(parse_status="queued", parse_error=None)
                    self._atomic_json(directory / "metadata.json", latest)
                self._schedule(metadata["id"])
                raise MaterialError("MATERIAL_PROCESSING", "资料缓存正在后台恢复，请稍后重新检索。", 425)
            # 派生缓存损坏或丢失时从已校验 hash 的原文件重新提取；原文件与归属不变。
            staging = directory / (".text-" + uuid4().hex + ".json")
            try:
                extracted = self._extract(directory / "source", metadata["format"], staging)
                version = parser_version(metadata["format"], extracted)
                extracted.update(source_hash=metadata["sha256"], parser_version=version,
                                 checksum=retrieval.checksum(extracted["units"]))
                staging.write_text(json.dumps(extracted, ensure_ascii=False), encoding="utf-8")
                os.replace(staging, path)
                if metadata["parser_version"] != version:
                    # 解析器升级只刷新材料元数据；归属字段重新读取以免覆盖并发草稿绑定。
                    with self._write_lock:
                        latest = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
                        changes = {"parser_version": version, "unit_count": len(extracted["units"]),
                                   "readable": any(u.strip() for u in extracted["units"]), "warnings": extracted["warnings"],
                                   "unit_kind": extracted.get("unit_kind", metadata["unit_kind"]),
                                   "unit_headings": extracted.get("headings", []), "unit_tables": extracted.get("tables", []),
                                   "unit_sections": extracted.get("sections", [])}
                        changes.update(visual_assets=extracted.get("visual_assets", []), visual_revision="", visual_completed=0)
                        latest.update(changes)
                        self._atomic_json(directory / "metadata.json", latest)
                        metadata.update(changes)
                return self._project(directory, metadata, extracted)
            finally:
                staging.unlink(missing_ok=True)

    @staticmethod
    def _atomic_json(path: Path, value: dict) -> None:
        if path.is_symlink():
            raise MaterialError("MATERIAL_CHANGED", "Cache path is invalid", 409)
        temporary = path.with_name("." + path.name + "." + uuid4().hex)
        try:
            temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def _visual_cache(self, directory: Path, meta: dict) -> dict:
        """识别结果属于原件/解析版本；损坏时拒绝旧引用，不能静默返回不同正文。"""
        if not meta.get("visual_revision"):
            return {}
        path = directory / "visual.json"
        try:
            if path.is_symlink():
                raise ValueError()
            value = json.loads(path.read_text(encoding="utf-8"))
            if (value["source_hash"] != meta["sha256"] or value["parser_version"] != meta["parser_version"]
                    or retrieval.checksum(value) != meta["visual_revision"]):
                raise ValueError()
            return value
        except (OSError, ValueError, KeyError, TypeError) as exc:
            with self._write_lock:
                latest = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
                latest.update(parse_status="queued", parse_error=None)
                self._atomic_json(directory / "metadata.json", latest)
            self._schedule(meta["id"])
            raise MaterialError("VISUAL_CACHE_CHANGED", "视觉缓存正在后台恢复，请重新检索。", 409) from exc

    def _visual_owner(self, material_id: str) -> str:
        directory = self._directory(material_id)
        meta = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
        return meta.get("goal_id") or self.draft_scope(meta["onboarding_session_id"])

    def visual_plan(self, material_id: str, fingerprint: str) -> dict:
        """后台派生服务读取计划；不接受模型给出的路径、归属或单元位置。"""
        directory, meta = self._load(material_id, self._visual_owner(material_id))
        self._text(directory, meta, allow_rebuild=False)
        native = json.loads((directory / "text.json").read_text(encoding="utf-8"))["units"]
        cache = self._visual_cache(directory, meta)
        records = cache.get("results", {}) if cache.get("fingerprint") == fingerprint else {}
        assets = meta.get("visual_assets", [])
        return {"source_hash": meta["sha256"], "parser_version": meta["parser_version"],
                "total": len(assets), "completed": len(records),
                "assets": [{"id": a["id"], "unit": a["unit"], "label": a["label"],
                            "context": native[a["unit"] - 1][:2000]} for a in assets if a["id"] not in records][:3]}

    def visual_manifest(self, material_id: str, owner: str, offset: int = 0, limit: int = 20) -> dict:
        """分页原图目录只返回可追溯定位；不触发云端转录、索引或学习写入。"""
        if type(offset) is not int or type(limit) is not int or offset < 0 or not 1 <= limit <= 20:
            raise MaterialError("INVALID_RANGE", "原图目录分页无效。")
        directory, meta = self._load(material_id, owner)
        identity = (meta["sha256"], material_purpose(meta), meta.get("purpose_revision", 0))
        if meta["format"] == "pdf":
            env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "WINDIR", "TMP", "TEMP") if key in os.environ}
            with tempfile.TemporaryDirectory(prefix="visual-manifest-") as temporary:
                target = Path(temporary) / "manifest.json"
                try:
                    result = subprocess.run([sys.executable, "-I", str(Path(__file__).with_name("document_batch_worker.py")),
                                             str(directory / "source"), str(target), meta["sha256"], "manifest", "manifest"],
                                            capture_output=True, text=True, env=env, timeout=30)
                    if result.returncode or target.stat().st_size > 2048:
                        raise ValueError()
                    value = json.loads(target.read_text(encoding="utf-8"))
                    total = value["total_units"]
                    if type(total) is not int or not 1 <= total <= 2000 or value["source_hash"] != meta["sha256"]:
                        raise ValueError()
                except (subprocess.TimeoutExpired, ValueError, KeyError, OSError) as exc:
                    raise MaterialError("VISUAL_MANIFEST_FAILED", "原PDF页数无法读取，请核对文件是否损坏或加密。") from exc
            assets = [{"id": f"page-{page}", "unit": page, "kind": "page", "label": f"原 PDF 第 {page} 页"}
                      for page in range(offset + 1, min(offset + limit, total) + 1)]
            unit_count = total
        elif meta["format"] in ("png", "jpg", "jpeg", "webp", "tiff"):
            total = unit_count = 1
            assets = [] if offset else [{"id": "image-1", "unit": 1, "kind": "image", "label": "原始图片"}]
        else:
            self._text(directory, meta, allow_rebuild=False)
            source_assets = meta.get("visual_assets", [])
            total, unit_count = len(source_assets), meta["unit_count"]
            assets = [{key: asset[key] for key in ("id", "unit", "kind", "label")}
                      for asset in source_assets[offset:offset + limit]]
        _, current = self._load(material_id, owner)
        if identity != (current["sha256"], material_purpose(current), current.get("purpose_revision", 0)):
            raise MaterialError("MATERIAL_CHANGED", "原件用途或版本已变化，请重新读取。", 409)
        return {"material_id": material_id, "name": meta["name"], "scope": owner, "source_hash": meta["sha256"],
                "purpose_revision": meta.get("purpose_revision", 0), "parser_version": meta["parser_version"],
                "unit_kind": "page" if meta["format"] in ("pdf", "png", "jpg", "jpeg", "webp", "tiff") else meta["unit_kind"], "unit_count": unit_count, "assets": assets, "total": total,
                "next_offset": offset + limit if offset + limit < total else None,
                "warnings": meta.get("warnings", [])[:32]}

    def visual_asset(self, material_id: str, asset_id: str, owner: str | None = None) -> dict:
        owner = owner or self._visual_owner(material_id)
        directory, meta = self._load(material_id, owner)
        if meta["format"] == "pdf" and re.fullmatch(r"page-[1-9][0-9]{0,3}", asset_id) and int(asset_id[5:]) <= 2000:
            # 原PDF渲染不依赖文字/OCR解析；页是否存在由固定原件渲染器校验。
            asset = {"id": asset_id, "unit": int(asset_id[5:]), "kind": "page", "label": f"原 PDF 第 {asset_id[5:]} 页"}
        elif meta["format"] in ("png", "jpg", "jpeg", "webp", "tiff") and asset_id == "image-1":
            asset = {"id": asset_id, "unit": 1, "kind": "image", "label": "原始图片"}
        else:
            self._text(directory, meta, allow_rebuild=False)
            asset = next((a for a in meta.get("visual_assets", []) if a["id"] == asset_id), None)
        if asset is None:
            raise MaterialError("VISUAL_NOT_FOUND", "原图不可用。", 404)
        identity = (meta["sha256"], material_purpose(meta), meta.get("purpose_revision", 0), meta["parser_version"])
        env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "WINDIR", "TMP", "TEMP") if key in os.environ}
        with tempfile.TemporaryDirectory(prefix="visual-") as temporary:
            target = Path(temporary) / "image.json"
            try:
                result = subprocess.run([sys.executable, "-I", str(Path(__file__).with_name("visual_worker.py")),
                                         str(directory / "source"), meta["format"], json.dumps(asset), str(target)],
                                        capture_output=True, text=True, env=env, timeout=30)
                if result.returncode:
                    raise ValueError()
                value = json.loads(target.read_text(encoding="utf-8"))
                if value.get("mime") != "image/jpeg" or len(base64.b64decode(value["data"], validate=True)) > MAX_VISUAL_BYTES:
                    raise ValueError()
                _, current = self._load(material_id, owner)
                if identity != (current["sha256"], material_purpose(current), current.get("purpose_revision", 0), current["parser_version"]):
                    raise MaterialError("MATERIAL_CHANGED", "原图所属资料已变化，请重新读取。", 409)
                return {**value, "material_id": material_id, "scope": owner, "source_hash": meta["sha256"],
                        "purpose_revision": meta.get("purpose_revision", 0), "parser_version": meta["parser_version"],
                        "name": meta["name"], "asset_id": asset_id, "unit": asset["unit"], "label": asset["label"],
                        "citation": f"{meta['name']}，{asset['label']}"}
            except (subprocess.TimeoutExpired, ValueError, KeyError, OSError) as exc:
                raise MaterialError("VISUAL_RENDER_FAILED", "原图转换失败或超时。", 422) from exc

    def publish_visual(self, material_id: str, source_hash: str, parser_version: str,
                       fingerprint: str, asset_id: str, analysis: dict) -> dict:
        try:
            analysis = validate_analysis(analysis)
        except ValueError as exc:
            raise MaterialError("INVALID_VISUAL_ANALYSIS", "视觉识别结果格式无效。") from exc
        if not isinstance(fingerprint, str) or not 1 <= len(fingerprint) <= 128:
            raise MaterialError("INVALID_VISUAL_ANALYSIS", "识别版本无效。")
        with self._write_lock:
            directory, meta = self._load(material_id, self._visual_owner(material_id))
            if meta["sha256"] != source_hash or meta["parser_version"] != parser_version or meta.get("parse_status") != "ready":
                raise MaterialError("MATERIAL_CHANGED", "资料版本已变化，丢弃识别结果。", 409)
            assets = meta.get("visual_assets", [])
            if not any(a["id"] == asset_id for a in assets):
                raise MaterialError("VISUAL_NOT_FOUND", "原图不可用。", 404)
            cache = self._visual_cache(directory, meta)
            if cache.get("fingerprint") != fingerprint:
                cache = {"source_hash": source_hash, "parser_version": parser_version, "fingerprint": fingerprint, "results": {}}
            cache["results"][asset_id] = {"analysis": analysis}
            try:
                projected = self._project(directory, dict(meta), json.loads((directory / "text.json").read_text(encoding="utf-8")), cache)
            except ValueError as exc:
                raise MaterialError("EXTRACTED_TEXT_LIMIT", "识别后的文字超过资料容量限制。") from exc
            self._atomic_json(directory / "visual.json", cache)
            meta.update(visual_revision=retrieval.checksum(cache), visual_completed=len(cache["results"]),
                        readable=any(unit.strip() for unit in projected))
            meta["warnings"] = [w for w in meta["warnings"] if w != "VISUAL_RECOGNITION_PENDING"]
            if len(cache["results"]) < len(assets):
                meta["warnings"].append("VISUAL_RECOGNITION_PENDING")
            if "MACHINE_TRANSCRIPTION_REQUIRES_CHECK" not in meta["warnings"]:
                meta["warnings"].append("MACHINE_TRANSCRIPTION_REQUIRES_CHECK")
            self._atomic_json(directory / "metadata.json", meta)
            return {"completed": len(cache["results"]), "total": len(assets), "revision": meta["visual_revision"]}

    @staticmethod
    def _public_metadata(meta: dict) -> dict:
        # 大文档的每单元结构/全部视觉锚点只属于入库层；Read/List 不倾倒整份结构进入教师上下文。
        hidden = {"unit_headings", "unit_tables", "unit_sections", "visual_assets", "visual_annotations", "visual_warnings"}
        value = {key: item for key, item in meta.items() if key not in hidden}
        value["purpose"] = material_purpose(meta)
        value["purpose_revision"] = meta.get("purpose_revision", 0)
        value["visual_count"] = len(meta.get("visual_assets", []))
        value["warnings"] = meta.get("warnings", [])[:32]
        value["warning_count"] = len(meta.get("warnings", []))
        return value

    @staticmethod
    def _visual_metadata(meta: dict, start: int, end: int) -> dict:
        annotations = [a for a in meta.get("visual_annotations", []) if start <= a["unit"] <= end]
        return {"assets": [{"id": a["id"], "unit": a["unit"], "label": a["label"]}
                           for a in meta.get("visual_assets", []) if start <= a["unit"] <= end][:3],
                "visual_annotations": annotations[:32], "visual_annotations_truncated": len(annotations) > 32,
                "visual_warnings": [{"asset_id": w["asset_id"], "warnings": [s[:120] for s in w["warnings"][:2]]}
                                    for w in meta.get("visual_warnings", []) if any(a["id"] == w["asset_id"] and start <= a["unit"] <= end for a in meta.get("visual_assets", []))][:3]}

    def _index(self, directory: Path, meta: dict, units: list[str]) -> dict:
        # 索引没有独立权威：完整指纹或校验和不同就重建，绝不反写 Kernel 学习事实。
        path = directory / "retrieval.json"
        if path.is_symlink():
            raise MaterialError("MATERIAL_CHANGED", "Retrieval cache path is invalid", 409)
        fingerprint = {"source_hash": meta["sha256"], "parser_version": meta["parser_version"],
                       "chunker_version": retrieval.CHUNKER_VERSION, "ranker_version": retrieval.RANKER_VERSION,
                       "text_hash": retrieval.checksum(units)}
        try:
            cached = json.loads(path.read_text(encoding="utf-8"))
            index = cached["index"]
            if (cached["fingerprint"] != fingerprint or cached["checksum"] != retrieval.checksum(index)
                    or not isinstance(index["chunks"], list) or len(index["chunks"]) != len(index["frequencies"])):
                raise ValueError("Invalid retrieval cache")
            return index
        except (OSError, UnicodeError, ValueError, KeyError, TypeError):
            index = retrieval.build_index(retrieval.build_chunks(meta, units))
            self._atomic_json(path, {"fingerprint": fingerprint, "index": index, "checksum": retrieval.checksum(index)})
            return index

    def _read_chunk(self, directory: Path, meta: dict, units: list[str], chunk_id: str,
                    before: int, after: int, max_chars: int, cursor: str | None) -> dict:
        if before not in (0, 1) or after not in (0, 1):
            raise MaterialError("INVALID_RANGE", "Neighbors must be 0 or 1")
        chunks = self._index(directory, meta, units)["chunks"]
        chunk = next((c for c in chunks if c["chunk_id"] == chunk_id), None)
        if chunk is None:
            raise MaterialError("STALE_CHUNK", "Chunk is unavailable; search again", 409)
        ordinal = chunk["ordinal"]
        selected = chunks[max(0, ordinal - before):ordinal + after + 1]
        start, end = selected[0]["locator"]["char_start"], selected[-1]["locator"]["char_end"]
        offset = 0
        if cursor:
            payload = self._decode_cursor(cursor, meta)
            if (payload.get("chunk_id") != chunk_id or payload.get("before") != before
                    or payload.get("after") != after):
                raise MaterialError("INVALID_CURSOR", "Chunk cursor is stale", 409)
            offset = payload.get("offset")
        text, offsets = retrieval.source_text(units)
        window = text[start:end]
        if not isinstance(offset, int) or not 0 <= offset < max(1, len(window)):
            raise MaterialError("INVALID_CURSOR", "Chunk cursor is stale", 409)
        contexts = retrieval.chunk_context(text, offsets, selected, start + offset, end, meta["unit_kind"],
                                           min(600, max_chars // 4), 160)
        context_chars = sum(len(row["text"]) for row in contexts)
        context_tokens = sum(retrieval.estimated_tokens(row["text"]) for row in contexts)
        value = retrieval.bounded_prefix(window[offset:], max_chars - context_chars, retrieval.MAX_READ_TOKENS - context_tokens)
        stop = offset + len(value)
        actual = retrieval.locator(offsets, start + offset, start + stop, meta["unit_kind"])
        next_cursor = self._encode_cursor({"id": meta["id"], "hash": meta["sha256"], "chunk_id": chunk_id,
                                          "overlay_version": VISUAL_OVERLAY_VERSION,
                                          "visual_revision": meta.get("visual_revision", ""), "ocr_revision": meta.get("ocr_revision", ""),
                                          "before": before, "after": after, "offset": stop}) if stop < len(window) else None
        kind = meta["unit_kind"]
        for row in contexts:
            loc = row["locator"]
            row["citation"] = f"{meta['name']}，第 {loc['start']}-{loc['end']} {UNIT_LABELS[kind]}"
            row["citation_ref"] = f"material:{meta['id']}:{kind}:{loc['start']}-{loc['end']}"
        return {"material": self._public_metadata(meta), "chunk_id": chunk_id, "chunk_ids": [c["chunk_id"] for c in selected],
                "start": actual["start"], "end": actual["end"], "locator": actual,
                "heading": chunk["heading"], "text": value,
                "context": contexts, "estimated_tokens": retrieval.estimated_tokens(value) + context_tokens, "truncated": next_cursor is not None,
                "next_cursor": next_cursor,
                "previous_chunk_id": chunks[ordinal - 1]["chunk_id"] if ordinal > 0 else None,
                "next_chunk_id": chunks[ordinal + 1]["chunk_id"] if ordinal + 1 < len(chunks) else None,
                "citation_ref": f"material:{meta['id']}:{kind}:{actual['start']}-{actual['end']}",
                "citation": f"{meta['name']}，第 {actual['start']}-{actual['end']} {UNIT_LABELS[kind]}",
                "warnings": meta["warnings"][:32], **self._visual_metadata(meta, actual["start"], actual["end"])}

    @staticmethod
    def _encode_cursor(value: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    @staticmethod
    def _decode_cursor(cursor: str, meta: dict) -> dict:
        try:
            if not 1 <= len(cursor) <= 1024:
                raise ValueError()
            payload = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
            if payload["id"] != meta["id"] or payload["hash"] != meta["sha256"]:
                raise ValueError()
            if payload.get("parser_version", meta["parser_version"]) != meta["parser_version"]:
                raise ValueError()
            if payload.get("visual_revision", "") != meta.get("visual_revision", ""):
                raise ValueError()
            if payload.get("ocr_revision", "") != meta.get("ocr_revision", ""):
                raise ValueError()
            if payload.get("overlay_version", "" if meta.get("visual_revision") else VISUAL_OVERLAY_VERSION) != VISUAL_OVERLAY_VERSION:
                raise ValueError()
            if "chunk_id" in payload and (not isinstance(payload["chunk_id"], str)
                    or payload.get("before") not in (0, 1) or payload.get("after") not in (0, 1)):
                raise ValueError()
            if not isinstance(payload.get("offset"), int) or payload["offset"] < 0:
                raise ValueError()
            return payload
        except (ValueError, KeyError, TypeError, binascii.Error) as exc:
            raise MaterialError("INVALID_CURSOR", "Reading cursor is invalid", 409) from exc

    @_current_material_result
    def read(self, material_id: str, goal_id: str, start: int = 1, end: int | None = None,
             max_chars: int = 4000, cursor: str | None = None, *, chunk_id: str | None = None,
             before: int = 0, after: int = 0) -> dict:
        directory, meta = self._load(material_id, goal_id)
        units = self._text(directory, meta, allow_rebuild=False)
        if not isinstance(max_chars, int) or not 1 <= max_chars <= MAX_TEXT_CHARS:
            raise MaterialError("INVALID_RANGE", "max_chars must be 1..128000")
        if cursor and not chunk_id:
            payload = self._decode_cursor(cursor, meta)
            if "chunk_id" in payload:
                chunk_id, before, after = payload["chunk_id"], payload["before"], payload["after"]
        if chunk_id:
            return self._read_chunk(directory, meta, units, chunk_id, before, after, max_chars, cursor)
        if before or after:
            raise MaterialError("INVALID_RANGE", "Neighbors require chunk_id")
        span = 5 if meta["format"] in ("pdf", "pptx") else 200
        if cursor is not None:
            try:
                payload = self._decode_cursor(cursor, meta)
                start, end, offset = payload["start"], payload["end"], payload["offset"]
            except (ValueError, KeyError, TypeError, binascii.Error) as exc:
                raise MaterialError("INVALID_CURSOR", "Reading cursor is invalid", 409) from exc
        else:
            offset = 0
            end = start if end is None else end
        if not isinstance(start, int) or not isinstance(end, int) or not 1 <= start <= end <= len(units) or end - start + 1 > span:
            raise MaterialError("INVALID_RANGE", "Requested page or line range is invalid")
        joined = "\n".join(units[start - 1:end])
        if not isinstance(offset, int) or not 0 <= offset < max(1, len(joined)):
            raise MaterialError("INVALID_CURSOR", "Reading cursor is stale", 409)
        if not joined.strip():
            raise MaterialError("TEXT_EXTRACTION_UNAVAILABLE", "No extractable text in this range; read the original with a vision-capable model", 422)
        text = retrieval.bounded_prefix(joined[offset:offset + max_chars], max_chars, retrieval.MAX_READ_TOKENS)
        next_offset = offset + len(text)
        truncated = next_offset < len(joined)
        def unit_at(char_index: int) -> int:
            boundary = 0
            for unit_index, unit in enumerate(units[start - 1:end], start):
                boundary += len(unit)
                if char_index <= boundary:
                    return unit_index
                boundary += 1
            return end

        actual_start = unit_at(offset)
        actual_end = unit_at(next_offset - 1)
        next_cursor = None
        if truncated:
            value = {"id": material_id, "hash": meta["sha256"], "parser_version": meta["parser_version"],
                     "overlay_version": VISUAL_OVERLAY_VERSION,
                     "visual_revision": meta.get("visual_revision", ""), "ocr_revision": meta.get("ocr_revision", ""),
                     "start": start, "end": end, "offset": next_offset}
            next_cursor = base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")
        kind = meta["unit_kind"]
        return {"material": self._public_metadata(meta), "start": actual_start, "end": actual_end,
                "locator": {"kind": kind, "start": actual_start, "end": actual_end},
                "requested_locator": {"start": start, "end": end}, "text": text,
                "citation_ref": f"material:{material_id}:{kind}:{actual_start}-{actual_end}",
                "citation": f"{meta['name']}，第 {actual_start}-{actual_end} {UNIT_LABELS[kind]}",
                "estimated_tokens": retrieval.estimated_tokens(text),
                "truncated": truncated, "next_cursor": next_cursor, "warnings": meta["warnings"][:32],
                **self._visual_metadata(meta, actual_start, actual_end)}

    @_current_material_result
    def search(self, material_id: str | None, goal_id: str, query: str, limit: int = 5) -> dict:
        if not isinstance(query, str) or not 1 <= len(query.strip()) <= 100 or not 1 <= limit <= 10:
            raise MaterialError("INVALID_QUERY", "Query must be 1..100 characters and limit 1..10")
        ids = [material_id] if material_id else []
        if material_id is None:
            offset = 0
            while True:
                page = self.list(goal_id, offset=offset)
                ids.extend(m["id"] for m in page["materials"])
                if page["next_offset"] is None:
                    break
                offset = page["next_offset"]
        indexes, sources, warnings = [], {}, []
        for item_id in ids:
            directory, meta = self._load(item_id, goal_id)
            try:
                units = self._text(directory, meta)
            except MaterialError as exc:
                if material_id:
                    raise
                warnings.append({"material_id": item_id, "code": exc.code})
                continue
            if not meta["readable"]:
                if material_id:
                    raise MaterialError("TEXT_EXTRACTION_UNAVAILABLE", "Material has no extractable text; read the original with a vision-capable model", 422)
                warnings.append({"material_id": item_id, "code": "TEXT_EXTRACTION_UNAVAILABLE"})
                continue
            indexes.append(self._index(directory, meta, units))
            sources[item_id] = (meta, units)
        rows, truncated = retrieval.rank(indexes, query.strip(), limit)
        matches = []
        for row in rows:
            chunk = row["chunk"]
            meta, units = sources[chunk["material_id"]]
            loc = chunk["locator"]
            _, offsets = retrieval.source_text(units)
            hit = loc["char_start"] + row["match_offset"]
            position = retrieval.locator(offsets, hit, hit + 1, meta["unit_kind"])["start"]
            left = max(0, hit - offsets[position - 1] - 120)
            # 兼容已有按页/行回读的调用者；新流程使用稳定 chunk_id。
            cursor_value = {"id": meta["id"], "hash": meta["sha256"],
                            "overlay_version": VISUAL_OVERLAY_VERSION,
                            "parser_version": meta["parser_version"],
                            "visual_revision": meta.get("visual_revision", ""), "ocr_revision": meta.get("ocr_revision", ""),
                            "start": position, "end": position, "offset": left}
            snippet_start = max(0, row["match_offset"] - 120)
            snippet = chunk["text"][snippet_start:snippet_start + retrieval.SNIPPET_CHARS]
            matches.append({"material_id": meta["id"], "material_name": meta["name"],
                            "chunk_id": chunk["chunk_id"], "ordinal": chunk["ordinal"],
                            "score": row["score"], "score_parts": row["score_parts"],
                            "heading": chunk["heading"], "position": position, "snippet": snippet,
                            "matched": query.strip(), "locator": loc,
                            "read_locator": {"material_id": meta["id"], "chunk_id": chunk["chunk_id"]},
                            "read_cursor": self._encode_cursor(cursor_value),
                            "citation_ref": f"material:{meta['id']}:{meta['unit_kind']}:{loc['start']}-{loc['end']}",
                            "citation": f"{meta['name']}，第 {loc['start']}-{loc['end']} {UNIT_LABELS[meta['unit_kind']]}",
                            "truncated": len(snippet) < len(chunk["text"])})
        return {"material_id": material_id, "scope": "material" if material_id else "current_goal",
                "query": query.strip(), "matches": matches, "truncated": truncated,
                "status": "matches" if matches else "no_relevant_match", "warnings": warnings,
                "searched_material_count": len(sources)}

    def preview(self, material_id: str, goal_id: str, **options) -> dict:
        """用户预览可先看原图；教师 Read 仍拒绝空文字，不能假装已经阅读。"""
        try:
            return self.read(material_id, goal_id, **options)
        except MaterialError as exc:
            if exc.code != "TEXT_EXTRACTION_UNAVAILABLE":
                raise
        directory, meta = self._load(material_id, goal_id)
        units = self._text(directory, meta, allow_rebuild=False)
        start = options.get("start", 1); end = options.get("end") or start
        if not 1 <= start <= end <= len(units):
            raise MaterialError("INVALID_RANGE", "预览范围已变化。", 409)
        visuals = self._visual_metadata(meta, start, end)
        if not visuals["assets"]:
            raise MaterialError("TEXT_EXTRACTION_UNAVAILABLE", "没有可预览内容。")
        return {"material": self._public_metadata(meta), "text": "尚无可检索文字，请先核对原图。", "estimated_tokens": 0,
                "citation": f"{meta['name']}，第 {start}-{end} {UNIT_LABELS[meta['unit_kind']]}", "truncated": False,
                "next_cursor": None, "warnings": meta["warnings"][:32], **visuals}

    def delete(self, material_id: str, goal_id: str) -> None:
        from app.material_deletions import MaterialDeletions
        deletion = MaterialDeletions(self)
        deletion.begin(material_id, goal_id)
        deletion.clean_original(material_id)

    def metadata_is_available(self, metadata: dict) -> bool:
        from app.material_deletions import MaterialDeletions
        if not isinstance(metadata.get("id"), str) or not _ID.fullmatch(metadata["id"]):
            return False
        if MaterialDeletions(self).contains(metadata["id"]):
            return False
        owner = metadata.get("goal_id") or "draft:" + str(metadata.get("onboarding_session_id", ""))
        return self.scope_is_available(owner)

    def resume_scope(self, scope: str) -> None:
        for directory, meta in self._scope_files(scope):
            if meta.get("parse_status") in ("queued", "processing"):
                self._schedule(directory.name)

    def _scope_files(self, scope: str):
        from app.material_deletions import MaterialDeletions
        # 只处理枚举到的资料目录；Goal ID 永不拼成文件路径。符号链接不递归。
        for directory in self.root.iterdir():
            if not _ID.fullmatch(directory.name) or directory.is_symlink() or not directory.is_dir():
                continue
            if MaterialDeletions(self).contains(directory.name):
                continue
            path = directory / "metadata.json"
            if path.is_symlink():
                continue
            meta = json.loads(path.read_text(encoding="utf-8"))
            # 已绑定资料归 Goal，不能因删旧草稿而误删它。
            owner = meta.get("goal_id") or "draft:" + str(meta.get("onboarding_session_id", ""))
            if owner == scope:
                yield directory, meta

    def purge_scope(self, scope: str, material_references: dict[str, str] | None = None) -> None:
        if self.scope_is_available(scope):
            raise MaterialError("SCOPE_NOT_RECYCLED", "Only recycled files may be purged", 409)
        from app.material_deletions import MaterialDeletions
        deletion, cleanup = MaterialDeletions(self), []
        offset = 0
        while True:
            page = deletion.events(offset)
            cleanup.extend(row["id"] for row in page["deletions"] if row["scope"] == scope or (
                row["scope"].startswith("draft:") and self._bound_goal(row["scope"][6:]) == scope))
            if page["next_offset"] is None:
                break
            offset = page["next_offset"]
        with self._write_lock:
            for directory, meta in self._scope_files(scope):
                if directory.resolve().parent != self.root:
                    raise MaterialError("INVALID_MATERIAL_ID", "Invalid material path", 409)
                new_owner = (material_references or {}).get(directory.name)
                if new_owner and new_owner != scope and not deletion.contains(directory.name):
                    # 保留相同 Material ID/原件，转给仍引用它的既有目标；不复制/改写内容。
                    meta["goal_id"] = new_owner
                    meta.pop("onboarding_session_id", None)
                    self._atomic_json(directory / "metadata.json", meta)
                else:
                    deletion.begin(directory.name, scope, allow_unavailable=True)
                    cleanup.append(directory.name)
        for material_id in cleanup:
            result = deletion.clean_original(material_id)
            if result["original_cleanup"] != "complete":
                raise MaterialError("MATERIAL_CLEANUP_PENDING", "资料已失效，原件清理尚未完成，可重试。", 503)
