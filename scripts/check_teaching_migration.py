"""只读捕获单份真实账本，在临时目录演练升级/恢复；不代替停写后的完整备份。"""

import argparse
from hashlib import sha256
import json
from pathlib import Path
import sys
import time
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.persistence import JsonLearningStateStore, STATE_VERSION


def check(path: Path):
    # Kernel以原子替换写单文件，因此一次read_bytes可捕获完整账本；其他文件不作一致承诺。
    captured = path.read_bytes()
    original = json.loads(captured)
    # 旧账本初次恢复会建立成长评估队列；两次演练用同一时钟，仍逐字段核对，
    # 避免把新的排队时间误报为学习资料变化。此替身只存在于隔离演练进程。
    with TemporaryDirectory(prefix="lawa-migration-check-") as directory, patch(
        "app.application.growth.time.time", return_value=time.time()
    ):
        isolated = Path(directory) / "state.json"
        isolated.write_bytes(captured)
        store = JsonLearningStateStore(isolated)
        service = store.load()
        if service is None:
            raise ValueError("Missing captured state")
        before = JsonLearningStateStore._encode(service)
        normalized = json.loads(json.dumps(before))
        if original["version"] != STATE_VERSION:
            assert isolated.with_name(f"state.json.v{original['version']}.bak").read_bytes() == captured
        store.save(service)
        upgraded = json.loads(isolated.read_bytes())
        assert upgraded["version"] == STATE_VERSION
        assert JsonLearningStateStore._encode(store.load()) == before
        # 老资料引用、评分、Evidence与任务身份均不得在新格式保存中丢失。
        for key in ("skills", "evidence", "tasks", "answer_assessments", "knowledge_cards", "teaching", "plan_revisions"):
            assert upgraded[key] == normalized[key], key
        isolated.write_bytes(captured)
        assert isolated.read_bytes() == captured
        assert JsonLearningStateStore._encode(store.load()) == before
    return {"passed": True, "sourceVersion": original["version"], "targetVersion": STATE_VERSION,
            "capturedSha256": sha256(captured).hexdigest(), "restoreByteExact": True,
            "sourceStillMatchesCapture": sha256(path.read_bytes()).digest() == sha256(captured).digest(),
            "counts": {key: len(before[key]) for key in ("skills", "tasks", "evidence", "answer_assessments", "plan_revisions")},
            "scope": "single-ledger-copy-only; no live writes or complete deployment backup"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("state", type=Path)
    args = parser.parse_args()
    print(json.dumps(check(args.state), ensure_ascii=False, indent=2))
