"""成长资料与派生评价的不可变账本；不授予学习状态或掌握权限。"""
from dataclasses import dataclass
from hashlib import sha256
import json

DIMENSIONS = (
    ("mathematical_analysis", "数理分析"), ("technical_application", "技术应用"),
    ("language_expression", "语言表达"), ("humanistic_understanding", "人文理解"),
    ("artistic_creation", "艺术创造"), ("practical_living", "生活实践"),
)
DIRECTIONS = ("science", "technology", "humanities", "expression")
POLICY_VERSION = "growth-v2.0"
STATE_KEYS = ("supplements", "batches", "samples", "classifications", "evaluations", "jobs", "recommendations", "adoptions")


def fingerprint(value) -> str:
    return sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


@dataclass(frozen=True, slots=True)
class GrowthState:
    # 用不可变编码保存快照，避免调用方通过嵌套dict改动Kernel历史；每次读取返回独立副本。
    encoded: str = '{"supplements":{},"batches":{},"samples":{},"classifications":{},"evaluations":[],"jobs":{},"recommendations":null,"adoptions":{}}'

    def __post_init__(self):
        data = json.loads(self.encoded)
        if not isinstance(data, dict) or set(data) != set(STATE_KEYS):
            raise ValueError("Invalid growth ledger")
        for key in STATE_KEYS[:4] + ("jobs", "adoptions"):
            if not isinstance(data[key], dict):
                raise ValueError(f"Invalid growth {key}")
        if not isinstance(data["evaluations"], list):
            raise ValueError("Invalid growth evaluations")
        for key in ("supplements", "batches", "samples"):
            if any(not isinstance(v, dict) or v.get("id") != k for k, v in data[key].items()):
                raise ValueError(f"Invalid growth {key} identity")

    def to_json(self) -> dict:
        return json.loads(self.encoded)

    @classmethod
    def from_json(cls, value: dict | None) -> "GrowthState":
        return cls() if value is None else cls(json.dumps({"adoptions": {}, **value}, ensure_ascii=False, allow_nan=False))


def zero_dimensions() -> list[dict]:
    return [{"id": key, "score": 0.0, "rationale": "尚无相关信息。", "source_refs": [], "coverage": [], "missing": []}
            for key, _ in DIMENSIONS]
