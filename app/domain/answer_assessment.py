"""单次作答的形成性评价；评分与正式 Evidence / Mastery 分开。"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from hashlib import sha256
import re


@dataclass(frozen=True, slots=True)
class AssessmentCriterion:
    label: str
    earned: int
    possible: int
    feedback: str

    def __post_init__(self) -> None:
        for key, limit in (("label", 100), ("feedback", 400)):
            value = getattr(self, key)
            if not isinstance(value, str) or not value.strip() or len(value) > limit:
                raise ValueError(f"Assessment criterion {key} is invalid")
        if type(self.earned) is not int or type(self.possible) is not int or not 0 <= self.earned <= self.possible <= 10 or self.possible == 0:
            raise ValueError("Assessment criterion points must satisfy 0 <= earned <= possible <= 10")


def assessment_topic_id(goal_id: str, skill_id: str, topic: str) -> str:
    normalized = re.sub(r"\s+", " ", topic.strip()).casefold()
    return "topic-" + sha256(f"{goal_id}\0{skill_id}\0{normalized}".encode()).hexdigest()[:24]


@dataclass(frozen=True, slots=True)
class AnswerAssessment:
    id: str
    goal_id: str
    skill_id: str
    topic_id: str
    topic: str
    source_task_id: str
    source_session_id: str
    source_turn_id: str
    question_entry_id: str
    question: str
    answer_excerpt: str
    answer_sha256: str
    answer_truncated: bool
    criteria: tuple[AssessmentCriterion, ...]
    summary: str
    strengths: tuple[str, ...]
    gaps: tuple[str, ...]
    assistance_level: str
    contract_id: str | None = None
    correction_reason: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def __post_init__(self) -> None:
        for key in ("criteria", "strengths", "gaps"):
            object.__setattr__(self, key, tuple(getattr(self, key)))
        for key in ("id", "goal_id", "skill_id", "topic_id", "source_task_id", "source_session_id", "source_turn_id", "question_entry_id"):
            value = getattr(self, key)
            if not isinstance(value, str) or not value.strip() or len(value) > 200:
                raise ValueError(f"Assessment {key} is invalid")
        for key, limit in (("topic", 160), ("question", 2000), ("answer_excerpt", 8000), ("summary", 600)):
            value = getattr(self, key)
            if not isinstance(value, str) or not value.strip() or len(value) > limit:
                raise ValueError(f"Assessment {key} is invalid")
        if not re.fullmatch(r"[a-f0-9]{64}", self.answer_sha256) or type(self.answer_truncated) is not bool:
            raise ValueError("Assessment answer provenance is invalid")
        if not self.answer_truncated and sha256(self.answer_excerpt.encode()).hexdigest() != self.answer_sha256:
            raise ValueError("Assessment answer hash does not match the actual answer")
        if not 1 <= len(self.criteria) <= 5 or any(not isinstance(c, AssessmentCriterion) for c in self.criteria) or sum(c.possible for c in self.criteria) != 10:
            raise ValueError("Assessment rubric must contain 1-5 criteria totaling 10 points")
        if len({c.label.strip() for c in self.criteria}) != len(self.criteria):
            raise ValueError("Assessment criterion labels must be distinct")
        for items in (self.strengths, self.gaps):
            if len(items) > 4 or any(not isinstance(v, str) or not v.strip() or len(v) > 240 for v in items):
                raise ValueError("Assessment strengths and gaps must be bounded concrete observations")
        if self.score < 8 and not self.gaps:
            raise ValueError("A score below 8 must explain a concrete gap")
        if self.assistance_level not in {"INDEPENDENT", "TRANSFERRED", "WITH_HINT", "WITH_REFERENCE", "WITH_HELP", "UNKNOWN"}:
            raise ValueError("Assessment assistance level is invalid")
        if not isinstance(self.created_at, datetime) or self.created_at.tzinfo is None or self.created_at.utcoffset() is None:
            raise ValueError("Assessment created_at must be timezone-aware")

    @property
    def score(self) -> int:
        return sum(c.earned for c in self.criteria)

    @property
    def max_score(self) -> int:
        return 10

    @property
    def follow_up(self) -> str:
        # 高分只免去同一知识点的例行重讲；有帮助的高分仍保留独立验证机会。
        return "SECURE" if self.score >= 8 and not self.gaps and self.assistance_level in {"INDEPENDENT", "TRANSFERRED"} else "RECHECK" if self.score >= 8 else "REINFORCE"

    @property
    def review_after(self) -> int | None:
        return None  # 后续实际应用提供验证机会，不按回答次数强制排题。


def project_practice(records: tuple[AnswerAssessment, ...], goal_id: str | None,
                     focus_skill_ids: tuple[str, ...] = ()) -> dict:
    """从真实评分历史派生队列；不复制Task状态、不以时间或分数强制推进。"""
    selected = tuple(r for r in records if r.goal_id == goal_id)
    latest = {r.topic_id: r for r in selected}
    topics = []
    for record in latest.values():
        remaining = None
        topics.append({"topic_id": record.topic_id, "topic": record.topic, "skill_id": record.skill_id,
                       "score": record.score, "assistance_level": record.assistance_level,
                       "follow_up": record.follow_up, "remaining_answers": remaining,
                       "due": False, "retention": "NOT_YET_OBSERVED", "summary": record.summary[:240], "gaps": list(record.gaps),
                       "assessment_id": record.id, "created_at": record.created_at.isoformat()})
    due = [t for t in topics if t["due"]]
    focus = [t for t in reversed(topics) if t["skill_id"] in focus_skill_ids]
    combined = {t["topic_id"]: t for t in [*due[:3], *focus, *reversed(topics)]}
    return {"due_reviews": due[:3], "topics": list(combined.values())[:8],
            "topic_count": len(topics), "assessment_count": len(selected),
            "notice": "Use later natural applications to observe these topics. No fixed answer-count schedule; a high score does not prove long-term retention. Never block Task progression or change Mastery."}
