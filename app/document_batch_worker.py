"""在最小环境子进程内切分PDF；不执行OCR，不访问学习账本或模型凭据。"""
import base64
import hashlib
import io
import json
from pathlib import Path
import sys

from pypdf import PdfReader, PdfWriter

MAX_SOURCE_BYTES = 100 * 1024 * 1024
MAX_BATCH_BYTES = 8 * 1024 * 1024
MAX_BATCH_PAGES = 256


def pdf_reader(source: Path, expected_hash: str) -> PdfReader:
    with source.open("rb") as stream:
        original = stream.read(MAX_SOURCE_BYTES + 1)
    if len(original) > MAX_SOURCE_BYTES:
        raise ValueError("DOCUMENT_SIZE_LIMIT")
    # 解析固定字节副本，原件在校验和切页之间被替换也不能混入另一份内容。
    if hashlib.sha256(original).hexdigest() != expected_hash:
        raise ValueError("MATERIAL_CHANGED")
    reader = PdfReader(io.BytesIO(original), strict=True)
    if reader.is_encrypted:
        raise ValueError("ENCRYPTED_PDF")
    total = len(reader.pages)
    if not 1 <= total <= 2000:
        raise ValueError("INVALID_DOCUMENT_RANGE")
    return reader


def pdf_batch(source: Path, expected_hash: str, start: int, end: int) -> dict:
    if not 1 <= start <= end or end - start + 1 > MAX_BATCH_PAGES:
        raise ValueError("INVALID_DOCUMENT_RANGE")
    reader = pdf_reader(source, expected_hash)
    total = len(reader.pages)
    if end > total:
        raise ValueError("INVALID_DOCUMENT_RANGE")
    writer = PdfWriter()
    for index in range(start - 1, end):
        writer.add_page(reader.pages[index])
    target = io.BytesIO()
    writer.write(target)
    data = target.getvalue()
    if len(data) > MAX_BATCH_BYTES:
        raise ValueError("DOCUMENT_BATCH_SIZE_LIMIT")
    return {"mime": "application/pdf", "data": base64.b64encode(data).decode("ascii"),
            "content_hash": hashlib.sha256(data).hexdigest(), "source_hash": expected_hash,
            "start": start, "end": end, "total_units": total, "unit_kind": "page", "size_bytes": len(data)}


if __name__ == "__main__":
    try:
        source, target, expected_hash, start, end = sys.argv[1:]
        result = ({"total_units": len(pdf_reader(Path(source), expected_hash).pages), "source_hash": expected_hash}
                  if start == end == "manifest" else pdf_batch(Path(source), expected_hash, int(start), int(end)))
        Path(target).write_text(json.dumps(result), encoding="utf-8")
    except Exception as exc:
        code = str(exc)
        allowed = {"INVALID_DOCUMENT_RANGE", "DOCUMENT_SIZE_LIMIT", "MATERIAL_CHANGED", "ENCRYPTED_PDF", "DOCUMENT_BATCH_SIZE_LIMIT"}
        print(code if code in allowed else "INVALID_DOCUMENT", file=sys.stderr)
        raise SystemExit(2)
