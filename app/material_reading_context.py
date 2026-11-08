"""机器笔记的可追溯上下文投影；原始批次和旧整合节点均不被覆盖。"""
from __future__ import annotations

import json

from app import retrieval

NOTE_KEYS = ("summary", "concepts", "facts", "dependencies", "uncertainties")


def note_bytes(note: dict) -> int:
    """仅计笔记正文；模型身份/树结构不是可以靠删掉来声称压缩成功的内容。"""
    return len(json.dumps({key: note.get(key, [] if key != "summary" else "") for key in NOTE_KEYS},
                          ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def context_nodes(job: dict) -> list[dict]:
    """验证有向无环出处树，再取覆盖全部原始笔记的最外层节点，不选择TopK。"""
    nodes, folds = {}, job.get("folds", [])
    if not isinstance(folds, list) or len(folds) > 20_000:
        raise ValueError("Invalid reading folds")
    cover = {}
    for index, note in enumerate(job["notes"]):
        ref = note["lease_id"]
        if ref in nodes:
            raise ValueError("Duplicate reading receipt")
        node = {"ref": ref, "start": index, "end": index + 1, "level": 0,
                "note": {key: note.get(key, [] if key != "summary" else "") for key in NOTE_KEYS},
                "model": note["model"], "citation_refs": note["batch"]["citation_refs"]}
        nodes[ref] = node
    intervals = []
    for fold in folds:
        ref, refs = fold["lease_id"], fold["input_refs"]
        if ref in nodes or not isinstance(refs, list) or len(refs) < 2 or any(key not in nodes for key in refs):
            raise ValueError("Invalid reading fold references")
        children = [nodes[key] for key in refs]
        start, end = children[0]["start"], children[-1]["end"]
        if (any(a["end"] != b["start"] for a, b in zip(children, children[1:]))
                or type(fold["start"]) is not int or type(fold["end"]) is not int
                or fold["start"] != start or fold["end"] != end
                or fold["input_hash"] != retrieval.checksum(children)
                or type(fold["max_note_bytes"]) is not int or note_bytes(fold) > fold["max_note_bytes"]
                or not 0 < fold["max_note_bytes"] < sum(note_bytes(node["note"]) for node in children)):
            raise ValueError("Invalid reading fold coverage")
        node = {"ref": ref, "start": start, "end": end, "level": max(n["level"] for n in children) + 1,
                "note": {key: fold[key] for key in NOTE_KEYS}, "model": fold["model"], "citation_refs": []}
        nodes[ref] = node
        if start not in cover or end >= cover[start]["end"]:
            cover[start] = node
        intervals.append((start, end))
    # 允许包含关系，拒绝交叉覆盖；否则贪心投影可能悄悄遗漏一个节点的后半段。
    stack = []
    for start, end in sorted(intervals, key=lambda item: (item[0], -item[1])):
        while stack and start >= stack[-1]:
            stack.pop()
        if stack and end > stack[-1]:
            raise ValueError("Crossing reading folds")
        stack.append(end)
    projected, index = [], 0
    while index < len(job["notes"]):
        node = cover.get(index) or nodes[job["notes"][index]["lease_id"]]
        projected.append(node)
        index = node["end"]
    return projected


def prepare_fold(job: dict, max_tokens: int) -> dict:
    """锁外选择能完整装入本次窗口的连续节点；原始笔记索引范围由服务端确定。"""
    chosen, used = [], 0
    for node in context_nodes(job):
        cost = retrieval.estimated_tokens(json.dumps(node, ensure_ascii=False))
        if used + cost > max_tokens:
            break
        chosen.append(node)
        used += cost
    if len(chosen) < 2:
        raise ValueError("READING_CONSOLIDATION_BUDGET_TOO_SMALL")
    total = sum(note_bytes(node["note"]) for node in chosen)
    return {"kind": "consolidate", "start": chosen[0]["start"], "end": chosen[-1]["end"],
            "input_refs": [node["ref"] for node in chosen], "input_hash": retrieval.checksum(chosen),
            "max_note_bytes": min(total - 1, max(128, int(total * .65))), "citation_refs": [],
            "input_notes": chosen}
