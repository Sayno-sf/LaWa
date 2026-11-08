"""资料删除的持久失效记录；不保存正文，不删除历史学习事实。"""
from __future__ import annotations

import json
from pathlib import Path
import re
import shutil
from typing import TYPE_CHECKING

from app import retrieval

if TYPE_CHECKING:
    from app.materials import MaterialStore


class MaterialDeletions:
    def __init__(self, materials: MaterialStore):
        self.materials = materials
        self.root = materials.root / ".material-deletions"

    def path(self, material_id: str) -> Path:
        from app.materials import MaterialError
        if not re.fullmatch(r"mat-[0-9a-f]{32}", material_id):
            raise MaterialError("INVALID_MATERIAL_ID", "Invalid material id", 404)
        if self.root.is_symlink():
            raise MaterialError("DELETION_STORAGE_INVALID", "资料删除记录路径无法核验。", 503)
        return self.root / (material_id + ".json")

    def contains(self, material_id: str) -> bool:
        path = self.path(material_id)
        # 未知/损坏/符号链接记录同样保持失效，绝不能因解析失败重新开放原件。
        return path.exists() or path.is_symlink()

    def read(self, material_id: str) -> dict:
        from app.materials import MaterialError
        path = self.path(material_id)
        try:
            if path.is_symlink() or path.stat().st_size > 8192:
                raise ValueError()
            value = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(value, dict):
                raise ValueError()
            checksum = value.pop("checksum")
            if (set(value) != {"version", "id", "scope", "onboarding_session_id", "source_hash", "original_cleanup"}
                    or type(value["version"]) is not int or value["version"] != 1 or value["id"] != material_id
                    or not isinstance(value["scope"], str) or not 1 <= len(value["scope"]) <= 256
                    or value["onboarding_session_id"] is not None and (not isinstance(value["onboarding_session_id"], str)
                        or not 1 <= len(value["onboarding_session_id"]) <= 128)
                    or value["original_cleanup"] not in ("pending", "complete")
                    or not re.fullmatch(r"[0-9a-f]{64}", value["source_hash"])
                    or checksum != retrieval.checksum(value)):
                raise ValueError()
            return value
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise MaterialError("DELETION_STORAGE_INVALID", "资料删除记录无法核验，原记录已保留。", 503) from error

    def write(self, value: dict):
        path = self.path(value["id"])
        self.root.mkdir(exist_ok=True)
        self.materials._atomic_json(path, {**value, "checksum": retrieval.checksum(value)})

    def begin(self, material_id: str, owner: str, *, allow_unavailable: bool = False) -> dict:
        from app.materials import MaterialError
        with self.materials._write_lock:
            if self.contains(material_id):
                value = self.read(material_id)
                aliases = {value["scope"]}
                session = value.get("onboarding_session_id")
                if session:
                    draft, bound = self.materials.draft_scope(session), self.materials._bound_goal(session)
                    if value["scope"] in (draft, bound):
                        aliases.add(draft)
                    if value["scope"] == draft and bound:
                        aliases.add(bound)
                if owner not in aliases:
                    raise MaterialError("MATERIAL_NOT_FOUND", "Material is unavailable in this Goal", 404)
                return value
            _, meta = (self.materials._load(material_id, owner, allow_unavailable=True) if allow_unavailable
                       else self.materials._load(material_id, owner))
            value = {"version": 1, "id": material_id, "scope": meta.get("goal_id") or self.materials.draft_scope(meta["onboarding_session_id"]),
                     "onboarding_session_id": meta.get("onboarding_session_id"), "source_hash": meta["sha256"],
                     "original_cleanup": "pending"}
            # 先落盘失效，再做任何慢操作。读/解析/阅读提交统一由MaterialStore入口拒绝。
            self.write(value)
            return value

    def clean_original(self, material_id: str) -> dict:
        from app.materials import MaterialError
        with self.materials._write_lock:
            self.read(material_id)
            target = self.materials.root / material_id
            if target.is_symlink() or target.exists() and target.resolve() != target:
                raise MaterialError("DELETION_PATH_INVALID", "原件清理路径无法核验。", 503)
        try:
            # 慢清理在锁外；目录内包含原件、解析/视觉缓存、阅读任务及全部分层笔记。
            if target.exists():
                shutil.rmtree(target)
        except OSError:
            pass  # 文件占用/部分清理失败不撤销删除，后续按同一记录重试。
        complete = not target.exists() and not target.is_symlink()
        with self.materials._write_lock:
            value = self.read(material_id)
            value["original_cleanup"] = "complete" if complete else "pending"
            self.write(value)
            return value

    def events(self, offset: int = 0, limit: int = 100) -> dict:
        from app.materials import MaterialError
        if type(offset) is not int or type(limit) is not int or offset < 0 or not 1 <= limit <= 100:
            raise MaterialError("INVALID_DELETION_PAGE", "资料删除分页无效。", 422)
        self.path("mat-" + "0" * 32)  # 校验固定父目录，不接受任意扫描路径。
        files = sorted(p.name[:-5] for p in self.root.glob("mat-*.json")) if self.root.exists() else []
        ids = files[offset:offset + limit]
        with self.materials._write_lock:
            rows = [self.read(id) for id in ids]
        return {"version": 1, "deletions": rows, "next_offset": offset + limit if offset + limit < len(files) else None,
                "catalog_version": retrieval.checksum(files)}
