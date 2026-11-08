"""A textual learning-evidence record and its provenance."""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum


class EvidenceType(str, Enum):
    EXPLAIN = "EXPLAIN"
    BUILD = "BUILD"
    DEBUG = "DEBUG"
    TRANSFER = "TRANSFER"


class AssistanceLevel(str, Enum):
    WITH_HELP = "WITH_HELP"
    WITH_HINT = "WITH_HINT"
    WITH_REFERENCE = "WITH_REFERENCE"
    INDEPENDENT = "INDEPENDENT"
    TRANSFERRED = "TRANSFERRED"


@dataclass(frozen=True, slots=True)
class Evidence:
    id: str
    skill_id: str
    evidence_type: EvidenceType
    description: str
    assistance_level: AssistanceLevel
    source: str
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def __post_init__(self) -> None:
        for name in ("id", "skill_id", "description", "source"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"Evidence {name} must be a non-empty string")
        if not isinstance(self.evidence_type, EvidenceType):
            raise ValueError("Evidence type must be an EvidenceType")
        if not isinstance(self.assistance_level, AssistanceLevel):
            raise ValueError("Evidence assistance_level must be an AssistanceLevel")
        if (
            not isinstance(self.created_at, datetime)
            or self.created_at.tzinfo is None
            or self.created_at.utcoffset() is None
        ):
            raise ValueError("Evidence created_at must be timezone-aware")
