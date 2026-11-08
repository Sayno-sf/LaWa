"""可替换的纯检索边界：结构分块与词法排序，不拥有文件、Goal 或学习事实。"""
from __future__ import annotations

from bisect import bisect_right
from collections import Counter
import hashlib
import json
import math
import re

CHUNKER_VERSION = "structural-v2"
RANKER_VERSION = "bm25-phrase-v1"
TARGET_TOKENS = 800
MAX_CHUNK_TOKENS = 1200
MAX_CHUNK_CHARS = 4000
OVERLAP_TOKENS = 120
MAX_READ_TOKENS = 32_000
SMALL_SOURCE_CHARS = 4000
SMALL_SOURCE_TOKENS = 1000
SNIPPET_CHARS = 300
_CJK = re.compile(r"[\u3400-\u9fff]")
_TERMS = re.compile(r"[a-z0-9_]+(?:[.:-][a-z0-9_]+)*|[\u3400-\u9fff]+")
_HEADING = re.compile(r"^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$")
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")


def checksum(value: object) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def estimated_tokens(text: str) -> int:
    chinese = len(_CJK.findall(text))
    return chinese + math.ceil((len(text) - chinese) / 4)


def bounded_prefix(text: str, max_chars: int, max_tokens: int) -> str:
    high = min(len(text), max_chars)
    if estimated_tokens(text[:high]) <= max_tokens:
        return text[:high]
    low = 0
    while low < high:
        mid = (low + high + 1) // 2
        if estimated_tokens(text[:mid]) <= max_tokens:
            low = mid
        else:
            high = mid - 1
    return text[:low]


def source_text(units: list[str]) -> tuple[str, list[int]]:
    offsets, position = [], 0
    for unit in units:
        offsets.append(position)
        position += len(unit) + 1
    return "\n".join(units), offsets


def locator(offsets: list[int], start: int, end: int, kind: str) -> dict:
    return {"kind": kind, "start": bisect_right(offsets, start),
            "end": bisect_right(offsets, max(start, end - 1)),
            "char_start": start, "char_end": end}


def _blocks(text: str, units: list[str], offsets: list[int], fmt: str, headings: list | None = None,
            sections: list | None = None, tables: list | None = None):
    if fmt == "card":
        yield 0, len(text), headings[0] if headings else None, 0
        return
    # PDF 只相信提取器提供的页序号；字号与排版不能可靠推出标题。
    if fmt in ("pdf", "docx", "pptx"):
        for page, unit in enumerate(units):
            heading = headings[page] if fmt != "pdf" and headings and page < len(headings) else None
            group = sections[page] if fmt == "docx" and sections and page < len(sections) else (None if fmt == "docx" else page)
            if tables and page < len(tables) and tables[page] and unit.strip():
                yield offsets[page], offsets[page] + len(unit), heading, group
                continue
            for match in re.finditer(r"\S[\s\S]*?(?=\n\s*\n|\Z)", unit):
                # Word 的正文块是定位单位，同节短段可以合并；PDF/PPT 保持页边界。
                yield offsets[page] + match.start(), offsets[page] + match.end(), heading, group
        return
    lines = text.splitlines(keepends=True)
    pos, begin, heading, fence, section = 0, None, None, None, None
    path: list[tuple[int, str]] = []
    for i, line in enumerate(lines):
        value = line.rstrip("\r\n")
        marker = _FENCE.match(value) if fmt == "md" else None
        title = _HEADING.match(value) if fmt == "md" and fence is None else None
        setext = (fmt == "md" and fence is None and i + 1 < len(lines)
                  and value.strip() and re.fullmatch(r" {0,3}(=+|-+)\s*", lines[i + 1].rstrip()))
        if title or setext:
            if begin is not None:
                yield begin, pos, heading, section
            level = len(title.group(1)) if title else (1 if lines[i + 1].lstrip().startswith("=") else 2)
            path = [(depth, name) for depth, name in path if depth < level]
            path.append((level, title.group(2) if title else value.strip()))
            heading = " / ".join(name for _, name in path)
            section = pos
            begin = pos
        elif marker and fence is None:
            if begin is not None:
                yield begin, pos, heading, section
            begin, fence = pos, marker.group(1)
        elif marker and fence is not None and marker.group(1)[0] == fence[0] and len(marker.group(1)) >= len(fence):
            yield begin, pos + len(line), heading, section
            begin, fence = None, None
        elif not value.strip() and fence is None:
            if begin is not None:
                yield begin, pos, heading, section
                begin = None
        elif begin is None:
            begin = pos
        pos += len(line)
    if begin is not None:
        yield begin, len(text), heading, section


def _split(text: str, start: int, end: int):
    # 只对超过硬预算的结构块做滑动切分；普通段落/代码块不重复。
    while start < end:
        prefix = bounded_prefix(text[start:min(end, start + MAX_CHUNK_CHARS)], MAX_CHUNK_CHARS, MAX_CHUNK_TOKENS)
        stop = start + len(prefix)
        if stop < end:
            boundary = max(prefix.rfind("\n"), prefix.rfind("。"), prefix.rfind(". "), prefix.rfind(" "))
            if boundary >= len(prefix) // 2:
                stop = start + boundary + 1
        yield start, stop
        if stop == end:
            break
        tail = text[start:stop]
        # 反向估算只决定窗口起点，不重写正文或生成不存在的页码。
        overlap = len(bounded_prefix(tail[::-1], MAX_CHUNK_CHARS, OVERLAP_TOKENS))
        start = max(start + 1, stop - overlap)


def _table_ranges(meta: dict, units: list[str], offsets: list[int]) -> list[tuple[int, int, int]]:
    """只识别解析器标注的表格或 GFM 表格，代码围栏里的管道符不是表格。"""
    ranges = []
    for index, tables in enumerate(meta.get("unit_tables", [])):
        for table in tables:
            ranges.append((offsets[index] + table["start"], offsets[index] + table["end"],
                           offsets[index] + table["header_end"]))
    if meta["format"] == "md":
        lines = "\n".join(units).splitlines(keepends=True)
        starts, pos, fence = [], 0, None
        for line in lines:
            starts.append(pos)
            pos += len(line)
        for index, line in enumerate(lines):
            marker = _FENCE.match(line)
            if marker:
                if fence is None:
                    fence = marker.group(1)
                elif marker.group(1)[0] == fence[0] and len(marker.group(1)) >= len(fence):
                    fence = None
                continue
            if fence or index == 0 or "|" not in line:
                continue
            cells = line.strip().strip("|").split("|")
            if not cells or not all(re.fullmatch(r"\s*:?-{3,}:?\s*", cell) for cell in cells):
                continue
            if "|" not in lines[index - 1]:
                continue
            end = index + 1
            while end < len(lines) and "|" in lines[end] and lines[end].strip():
                end += 1
            ranges.append((starts[index - 1], starts[end] if end < len(starts) else pos,
                           starts[index] + len(line)))
    return sorted(ranges)


def _split_rows(text: str, start: int, end: int):
    """长表格优先保持完整行；单行超过硬上限时才使用有重叠的普通切分。"""
    pending = start
    for match in re.finditer(r"[^\n]*(?:\n|$)", text[start:end]):
        a, b = start + match.start(), start + match.end()
        if a == b:
            continue
        if a > pending and (b - pending > MAX_CHUNK_CHARS or estimated_tokens(text[pending:b]) > MAX_CHUNK_TOKENS):
            yield pending, a
            pending = a
        if b - a > MAX_CHUNK_CHARS or estimated_tokens(text[a:b]) > MAX_CHUNK_TOKENS:
            yield from _split(text, a, b)
            pending = b
    if pending < end:
        yield pending, end


def build_chunks(meta: dict, units: list[str]) -> list[dict]:
    text, offsets = source_text(units)
    chunks, pending = [], None
    tables = _table_ranges(meta, units, offsets)
    table_starts = [row[0] for row in tables]
    blocks = list(_blocks(text, units, offsets, meta["format"], meta.get("unit_headings"), meta.get("unit_sections"), meta.get("unit_tables")))
    def emit(start: int, end: int, heading: str | None):
        value = text[start:end]
        if not value.strip():
            return
        content_hash = hashlib.sha256(value.encode()).hexdigest()
        ordinal = len(chunks)
        identity = [meta["id"], meta["sha256"], meta["parser_version"], CHUNKER_VERSION,
                    ordinal, start, end, content_hash]
        chunks.append({"chunk_id": "chk-" + checksum(identity)[:32], "material_id": meta["id"],
                       "ordinal": ordinal, "text": value, "heading": heading,
                       "locator": locator(offsets, start, end, meta["unit_kind"]),
                       "content_hash": content_hash, "source_hash": meta["sha256"],
                       "parser_version": meta["parser_version"], "chunker_version": CHUNKER_VERSION,
                       "estimated_tokens": estimated_tokens(value)})
    parts = []
    for start, end, heading, page in blocks:
        cursor = start
        table_index = max(0, bisect_right(table_starts, start) - 1)
        while table_index < len(tables):
            a, b, header_end = tables[table_index]
            table_index += 1
            if a >= end:
                break
            if b <= start or a >= end:
                continue
            if cursor < a:
                parts.append((cursor, a, heading, page, None))
            parts.append((max(start, a), min(end, b), heading, page, (a, header_end)))
            cursor = min(end, b)
        if cursor < end:
            parts.append((cursor, end, heading, page, None))
    for position, (start, end, heading, page, table) in enumerate(parts):
        structural_boundary = pending is not None and (heading != pending[2] or page != pending[3])
        # 空的父标题跟随子节正文，避免单独召回一个没有正文的标题。
        if structural_boundary and meta["format"] in ("md", "docx") and heading and pending[2] and heading.startswith(pending[2] + " / "):
            only_headings = (all(not line.strip() or _HEADING.match(line) for line in text[pending[0]:pending[1]].splitlines())
                             if meta["format"] == "md" else text[pending[0]:pending[1]].strip() == pending[2].split(" / ")[-1])
            if only_headings and end - pending[0] <= MAX_CHUNK_CHARS and estimated_tokens(text[pending[0]:end]) <= TARGET_TOKENS:
                pending = (pending[0], pending[1], heading, page)
                structural_boundary = False
        if pending is not None and (structural_boundary or
                estimated_tokens(text[pending[0]:end]) > TARGET_TOKENS or end - pending[0] > MAX_CHUNK_CHARS):
            emit(*pending[:3])
            pending = None
        if table:
            if pending is not None:
                emit(*pending[:3])
                pending = None
            first = len(chunks)
            for a, b in _split_rows(text, start, end):
                emit(a, b, heading)
                spans = [] if a <= table[0] else [{"char_start": table[0], "char_end": table[1], "role": "table_first_rows"}]
                chunks[-1]["context_spans"] = spans
            # 表格说明只来自同节紧邻正文；上下文另有小预算，不能侵占整次回读额度。
            for i, side in ((position - 1, "table_leading_text"), (position + 1, "table_trailing_text")):
                if 0 <= i < len(parts) and parts[i][2:4] == (heading, page) and parts[i][4] is None:
                    a, b = parts[i][:2]
                    target = chunks[first] if i < position else chunks[-1]
                    target.setdefault("context_spans", []).append({"char_start": a, "char_end": b, "role": side})
        elif estimated_tokens(text[start:end]) > MAX_CHUNK_TOKENS or end - start > MAX_CHUNK_CHARS:
            for a, b in _split(text, start, end):
                emit(a, b, heading)
                if meta["format"] == "card" and a >= len(units[0]):
                    chunks[-1]["context_spans"] = [{"char_start": 0, "char_end": len(units[0]), "role": "card_question"}]
        elif pending is None:
            pending = (start, end, heading, page)
        else:
            pending = (pending[0], end, heading, page)
    if pending is not None:
        emit(*pending[:3])
    return chunks


def chunk_context(text: str, offsets: list[int], chunks: list[dict], start: int, end: int, kind: str,
                  max_chars: int = 600, max_tokens: int = 160) -> list[dict]:
    """从原文坐标补读表格首行/说明，单独记录定位；不把复制的上下文伪装成连续正文。"""
    contexts, seen = [], set()
    for chunk in chunks:
        for span in chunk.get("context_spans", []):
            a, b = span["char_start"], span["char_end"]
            if (a, b) in seen or start <= a and b <= end:
                continue
            seen.add((a, b))
            value = bounded_prefix(text[a:b], max_chars, max_tokens)
            if value:
                contexts.append({"text": value, "role": span["role"], "locator": locator(offsets, a, a + len(value), kind),
                                 "truncated": len(value) < b - a})
                max_chars -= len(value)
                max_tokens -= estimated_tokens(value)
    return contexts


def terms(text: str) -> list[str]:
    result = []
    for match in _TERMS.finditer(text.casefold()):
        value = match.group()
        if _CJK.match(value):
            result.extend(value[i:i + 2] for i in range(max(1, len(value) - 1)))
        else:
            result.append(value)
    return result


def build_index(chunks: list[dict]) -> dict:
    return {"chunks": chunks, "frequencies": [dict(Counter(terms(c["text"]))) for c in chunks]}


def rank(indexes: list[dict], query: str, limit: int = 5) -> tuple[list[dict], bool]:
    """同一候选契约的词法实现；将来可替换排序，Teacher 的 Search→Read 不变。"""
    rows = [(c, tf) for index in indexes for c, tf in zip(index["chunks"], index["frequencies"])]
    if not rows:
        return [], False
    qterms = sorted(set(terms(query)))
    df = Counter(t for _, tf in rows for t in qterms if t in tf)
    lengths = [sum(tf.values()) or 1 for _, tf in rows]
    average = sum(lengths) / len(rows)
    ranked = []
    needle = query.strip().casefold()
    for (chunk, tf), length in zip(rows, lengths):
        matched = [t for t in qterms if t in tf]
        folded = chunk["text"].casefold()
        phrase_pattern = ((r"(?<![a-z0-9_])" if needle[:1].isascii() and needle[:1].isalnum() else "")
                          + re.escape(needle)
                          + (r"(?![a-z0-9_])" if needle[-1:].isascii() and needle[-1:].isalnum() else ""))
        exact = re.search(phrase_pattern, folded) is not None
        if not matched and not exact:
            continue
        bm25 = sum(math.log(1 + (len(rows) - df[t] + .5) / (df[t] + .5)) *
                   (tf[t] * 2.2 / (tf[t] + 1.2 * (.25 + .75 * length / average))) for t in matched)
        # 结构奖励有上限；正文 TF/长度归一仍参与排序，没有隐式模型调用。
        phrase = 3.0 if exact else 0.0
        heading = chunk["heading"] or ""
        heading_boost = (2.0 if needle in heading.casefold() else
                         min(1.0, len(set(terms(heading)) & set(qterms)) / max(1, len(qterms))))
        identifier = 1.0 if len(qterms) == 1 and qterms[0] in tf and re.search(r"[_A-Z.:]", query) else 0.0
        score = round(bm25 + phrase + heading_boost + identifier, 6)
        location = folded.find(needle) if exact else -1
        if location < 0:
            positions = [folded.find(t) for t in matched if folded.find(t) >= 0]
            location = min(positions, default=0)
        if len(folded) != len(chunk["text"]):
            # casefold 可能把 ß 展开成 ss；候选位置必须映射回真实原文字符坐标。
            folded_position = 0
            for original_position, char in enumerate(chunk["text"]):
                folded_position += len(char.casefold())
                if location < folded_position:
                    location = original_position
                    break
        ranked.append({"chunk": chunk, "score": score,
                       "score_parts": {"bm25": round(bm25, 6), "phrase": phrase,
                                       "heading": heading_boost, "identifier": identifier,
                                       "matched_terms": matched[:20]},
                       "match_offset": location})
    ranked.sort(key=lambda row: (-row["score"], row["chunk"]["material_id"], row["chunk"]["ordinal"]))
    selected = []
    for row in ranked:
        chunk = row["chunk"]
        duplicate = False
        for earlier in selected:
            prev = earlier["chunk"]
            if prev["material_id"] != chunk["material_id"]:
                continue
            a, b = chunk["locator"], prev["locator"]
            overlap = max(0, min(a["char_end"], b["char_end"]) - max(a["char_start"], b["char_start"]))
            # 命中点落在同一 overlap，或正文高度重叠时只保留分数最高者。
            same_hit = (a["char_start"] + row["match_offset"] == b["char_start"] + earlier["match_offset"])
            if same_hit or overlap / max(1, min(len(chunk["text"]), len(prev["text"]))) >= .5:
                duplicate = True
                break
        if not duplicate:
            selected.append(row)
    return selected[:limit], len(selected) > limit
