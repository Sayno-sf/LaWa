"""正式路线的原件阅读要求；属于机器资源，不能授予用户确认或学习能力。"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import re

from app import retrieval
from app.materials import MaterialError, MaterialStore
from app.material_reading import MaterialReadingStore
from app.material_reading_context import context_nodes


def _fail(code: str, message: str):
    raise MaterialError(code, message, 409)


class MaterialPlanningStore:
    """与原件共用短写锁；定稿检查及Kernel写入在调用方同一锁边界内串行化。"""
    def __init__(self, materials: MaterialStore):
        self.materials = materials

    def _path(self, session_id: str):
        self.materials.draft_scope(session_id)
        return self.materials.root / (".planning-reading-" + hashlib.sha256(session_id.encode()).hexdigest() + ".json")

    def _goal_path(self, goal_id: str):
        return self.materials.root / (".planning-goal-" + hashlib.sha256(goal_id.encode()).hexdigest() + ".json")

    @staticmethod
    def _read(path) -> dict:
        try:
            if path.is_symlink() or path.stat().st_size > 1024 * 1024:
                raise ValueError()
            value = json.loads(path.read_text(encoding="utf-8"))
            checksum = value.pop("checksum")
            if value["version"] != 1 or checksum != retrieval.checksum(value):
                raise ValueError()
            if (not isinstance(value.get("session_id"), str) or not isinstance(value.get("request_id"), str)
                    or not re.fullmatch(r"[0-9a-f]{64}", value["request_id"])):
                raise ValueError()
            if "scope" in value:
                if (value["scope"] != "draft:" + value["session_id"] or value.get("state") not in ("OPEN", "COMPLETED")
                        or not isinstance(value.get("sources"), list) or len(value["sources"]) > 100
                        or not isinstance(value.get("goal_id"), str) or not isinstance(value.get("user_entry_id"), str)
                        or not isinstance(value.get("goal_profile_hash"), str)
                        or not re.fullmatch(r"[0-9a-f]{64}", value["goal_profile_hash"])
                        or any(not isinstance(source, dict) or not isinstance(source.get("material_id"), str)
                               or source.get("scope") != value["scope"] for source in value["sources"])
                        or value["state"] == "COMPLETED" and (not isinstance(value.get("result"), dict)
                               or not isinstance(value.get("payload_hash"), str))):
                    raise ValueError()
            elif set(value) != {"version", "session_id", "request_id"}:
                raise ValueError()
            return value
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise MaterialError("PLANNING_READING_STORAGE_INVALID", "规划阅读要求无法核验，原记录已保留。", 503) from error

    def _write(self, path, value: dict):
        if path.is_symlink():
            _fail("PLANNING_READING_STORAGE_INVALID", "规划阅读要求路径无效，原记录已保留。")
        if len(json.dumps(value, ensure_ascii=False).encode()) > 1024 * 1024:
            _fail("PLANNING_READING_LIMIT", "规划阅读要求超出资源上限，原记录已保留。")
        self.materials._atomic_json(path, {**value, "checksum": retrieval.checksum(value)})

    def register(self, owner: str, session_id: str, request_id: str, user_entry_id: str,
                 goal_id: str, goal_profile_hash: str, material_ids: list[str], primary_material_id: str | None = None) -> dict:
        if (owner != self.materials.draft_scope(session_id) or not re.fullmatch(r"[0-9a-f]{64}", request_id)
                or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", user_entry_id)
                or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", goal_id)
                or not re.fullmatch(r"[0-9a-f]{64}", goal_profile_hash)
                or not isinstance(material_ids, list) or not 0 <= len(material_ids) <= 100
                or len(set(material_ids)) != len(material_ids) or primary_material_id is not None and primary_material_id not in material_ids):
            _fail("INVALID_PLANNING_READING", "规划资料须来自本次真实草稿请求。")
        with self.materials._write_lock:
            path, goal_path = self._path(session_id), self._goal_path(goal_id)
            # 两处均先验证再写，不覆盖未知版本/损坏的旧要求。
            previous = self._read(path) if path.exists() or path.is_symlink() else None
            if previous and previous["sources"] and not material_ids and previous["user_entry_id"] == user_entry_id:
                _fail("PLANNING_READING_CLEAR_REQUIRES_USER", "不能在同一用户请求内删去已声明的主要资料来绕过阅读。")
            if goal_path.exists() or goal_path.is_symlink():
                self._read(goal_path)
            sources = [MaterialReadingStore.identity(self.materials._load(id, owner)[1]) for id in material_ids]
            if any(source["scope"] != owner for source in sources):
                _fail("PLANNING_READING_SCOPE_CHANGED", "这份资料已不属于当前新目标草稿。")
            value = {"version": 1, "request_id": request_id, "scope": owner, "session_id": session_id,
                     "user_entry_id": user_entry_id, "goal_id": goal_id, "goal_profile_hash": goal_profile_hash,
                     "sources": sources, "primary_material_id": primary_material_id, "state": "OPEN"}
            if previous and previous["request_id"] == request_id:
                if any(previous.get(key) != item for key, item in value.items() if key != "state"):
                    _fail("PLANNING_READING_CONFLICT", "同一规划请求不能改换资料或原件版本。")
                value = previous
            self._write(path, value)
            self._write(goal_path, {"version": 1, "session_id": session_id, "request_id": request_id})
            return deepcopy(value)

    def get(self, owner: str, session_id: str, request_id: str) -> dict:
        with self.materials._write_lock:
            value = self._read(self._path(session_id))
            if value.get("scope") != owner or value.get("request_id") != request_id or value.get("session_id") != session_id:
                _fail("PLANNING_READING_STALE", "原规划请求已更换，不能复用旧资料完成事件。")
            return value

    def status(self, owner: str, session_id: str, request_id: str) -> dict:
        with self.materials._write_lock:
            value = self.get(owner, session_id, request_id)
            results = []
            if value["state"] == "COMPLETED":
                return {"request_id": request_id, "state": "COMPLETED", "sources": [], "recovery_protocol": 1}
            for source in value["sources"]:
                try:
                    actual = MaterialReadingStore.identity(self.materials._load(source["material_id"], owner)[1])
                    if actual != source:
                        _fail("PLANNING_READING_SOURCE_CHANGED", "规划依据的原件或用途版本已变化。")
                    try:
                        job = MaterialReadingStore(self.materials).get(source["material_id"], owner)
                        state = job["state"]
                    except MaterialError as error:
                        if error.code != "READING_NOT_FOUND":
                            raise
                        state = "QUEUED"
                    results.append({"material_id": source["material_id"], "state": state})
                except MaterialError as error:
                    results.append({"material_id": source["material_id"], "state": "BLOCKED", "code": error.code})
            state = "READY" if all(row["state"] == "READY" for row in results) else "WAITING"
            if any(row["state"] in ("BLOCKED", "FAILED", "CANCELED", "NEEDS_REVIEW") for row in results):
                state = "BLOCKED"
            return {"request_id": request_id, "state": state, "sources": results, "recovery_protocol": 1}

    def context(self, owner: str, session_id: str, request_id: str, max_tokens: int) -> dict:
        """交付所有主要资料的完整整合结论；原文准备锁外，交付前重新核验版本。"""
        if type(max_tokens) is not int or not 1 <= max_tokens <= 1_000_000:
            _fail("PLANNING_CONTEXT_LIMIT", "资料输入预算无效。")

        def snapshot():
            value = self.get(self.materials.draft_scope(session_id), session_id, request_id)
            bound = self.materials._bound_goal(session_id)
            if owner != value["scope"] and not (value["state"] == "COMPLETED" and owner == bound == value["goal_id"]):
                _fail("PLANNING_READING_STALE", "资料输入不属于当前规划或学习目标。")
            jobs = []
            for pin in value["sources"]:
                actual = MaterialReadingStore.identity(self.materials._load(pin["material_id"], owner)[1])
                expected = {**pin, "scope": bound} if bound == value["goal_id"] else pin
                if actual != expected:
                    _fail("PLANNING_READING_SOURCE_CHANGED", "规划依据的原件或用途版本已变化。")
                try:
                    job = MaterialReadingStore(self.materials).get(pin["material_id"], owner)
                except MaterialError as error:
                    if error.code != "READING_NOT_FOUND":
                        raise
                    _fail("PLANNING_READING_WAITING", "主要资料尚未完成阅读。")
                if job["state"] != "READY" or not (job.get("synthesis") or {}).get("sufficient"):
                    _fail("PLANNING_READING_WAITING", "主要资料尚未完成有效阅读。")
                jobs.append(job)
            return value, jobs

        with self.materials._write_lock:
            value, jobs = snapshot()
        packet = {"version": 1, "request_id": request_id, "goal_profile_hash": value["goal_profile_hash"],
                  "primary_material_id": value["primary_material_id"], "sources": []}
        for job in jobs:
            _, meta = self.materials._load(job["source"]["material_id"], owner)
            packet["sources"].append({"source": job["source"], "name": meta["name"],
                "rules_version": job["rules_version"], "reading_revision": job["revision"],
                "synthesis": job["synthesis"], "layout": job["layout"],
                "native_text": None, "native_text_complete": False, "reading_nodes": None})

        # 与Node共用保守估算口径，计入JSON转义；每份资料的结论均不可用TopK省略。
        def cost():
            text = json.dumps(packet, ensure_ascii=False, separators=(",", ":"))
            text = json.dumps("\n\n[LaWa只读规划资料]\n" + text + "\n[/LaWa只读规划资料]", ensure_ascii=False)
            cjk = len(re.findall(r"[\u3400-\u9fff\uf900-\ufaff]", text))
            units = len(text.encode("utf-16-le")) // 2
            return cjk + (units - cjk + 2) // 3 + 512

        if cost() > max_tokens:
            _fail("PLANNING_CONTEXT_TOO_LARGE", "当前对话放不下全部资料的阅读结论，暂不能据此定稿；已读进度保留。")
        order = sorted(range(len(jobs)), key=lambda i: jobs[i]["source"]["material_id"] != value["primary_material_id"])
        for i in order:
            row = packet["sources"][i]
            if jobs[i]["mode"] == "native_and_images":
                raw = self.materials.reading_source(jobs[i]["source"]["material_id"], owner)
                row.update(native_text=raw["native"], native_text_complete=True)
                if cost() > max_tokens:
                    row.update(native_text=None, native_text_complete=False)
        # 先给所有原文分配空间，再加入整组连续笔记，不能让第一本书的笔记挤掉第二本可容纳的原文。
        for i in order:
            row = packet["sources"][i]
            row["reading_nodes"] = context_nodes(jobs[i])
            if cost() > max_tokens:
                row["reading_nodes"] = None
        with self.materials._write_lock:
            latest, current = snapshot()
            if (latest != value or [(j["source"], j["revision"]) for j in current]
                    != [(j["source"], j["revision"]) for j in jobs]):
                _fail("PLANNING_READING_SOURCE_CHANGED", "资料输入准备期间原请求或阅读版本已变化。")
        return packet

    def guard(self, session_id: str | None, request_id: str | None, profile: dict, payload: dict,
              committed: dict | None = None) -> dict | None:
        """调用方必须持有资料写锁直到Kernel保存/草稿绑定结束，删除不能夹在检查和定稿之间。"""
        index_path = self._goal_path(profile["id"])
        index = self._read(index_path) if index_path.exists() or index_path.is_symlink() else None
        if not session_id:
            if request_id or index:
                _fail("PLANNING_READING_REQUIRED", "这份正式路线已绑定规划资料，不能省略原请求。")
            return None
        path = self._path(session_id)
        if not path.exists() and not path.is_symlink():
            if request_id or index:
                _fail("PLANNING_READING_REQUIRED", "缺少本次规划的资料阅读要求。")
            return None
        owner = self.materials.draft_scope(session_id)
        value = self.get(owner, session_id, request_id or "")
        if (not index or index.get("session_id") != session_id or index.get("request_id") != request_id
                or value["goal_id"] != profile["id"] or value["goal_profile_hash"] != retrieval.checksum(profile)):
            _fail("PLANNING_READING_STALE", "规划理解或资料依据已变化，请处理当前请求。")
        if value["state"] == "COMPLETED":
            if value.get("payload_hash") != retrieval.checksum(payload):
                _fail("PLANNING_RECEIPT_CONFLICT", "同一正式规划提交不能改换路线内容。")
            return deepcopy(value["result"])
        if committed is not None and value.get("prepared_payload_hash") == retrieval.checksum(payload):
            # 崩溃可能发生在Kernel保存之后、资源回执之前；只承认调用方核验的同一真实路线，不重新初始化。
            return deepcopy(committed)
        readiness = self.status(owner, session_id, request_id)
        if readiness["state"] != "READY":
            _fail("PLANNING_READING_" + readiness["state"], "主要资料尚未完成有效阅读，暂不能定稿；保留当前学习与规划请求。")
        return None

    def prepare_finalize(self, session_id: str | None, request_id: str | None, payload: dict):
        if session_id and request_id:
            value = self.get(self.materials.draft_scope(session_id), session_id, request_id)
            value["prepared_payload_hash"] = retrieval.checksum(payload)
            self._write(self._path(session_id), value)

    def complete(self, session_id: str | None, request_id: str | None, payload: dict, result: dict):
        if not session_id or not request_id:
            return
        path = self._path(session_id)
        value = self.get(self.materials.draft_scope(session_id), session_id, request_id)
        value.update(state="COMPLETED", payload_hash=retrieval.checksum(payload), result=result)
        self._write(path, value)
