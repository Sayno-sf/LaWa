"""User-confirmable revisions of the complete learning plan."""

from dataclasses import dataclass, field
from datetime import UTC, datetime

from .planning import CurriculumMilestone, FrontierPlan, GoalProfile
from .skill import SkillNode


def _now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True, slots=True)
class LearningPlanRevision:
    """A proposed atomic replacement of Goal, Spine, Skills and Frontier."""

    id: str
    goal_id: str
    base_revision: int
    revision: int
    base_signature: str
    goal_profile: GoalProfile
    curriculum_spine: tuple[CurriculumMilestone, ...]
    added_skills: tuple[SkillNode, ...]
    updated_skills: tuple[SkillNode, ...]
    remove_skill_ids: tuple[str, ...]
    frontier: FrontierPlan
    summary: str
    reason: str
    status: str = "PENDING"
    feedback: str = ""
    decision_request_id: str = ""
    created_at: datetime = field(default_factory=_now)
    decided_at: datetime | None = None

    def __post_init__(self) -> None:
        for key in ("id", "goal_id"):
            value = getattr(self, key)
            if not isinstance(value, str) or not value.strip() or len(value) > 200:
                raise ValueError(f"Plan revision {key} must be a bounded non-empty string")
        for key in ("base_revision", "revision"):
            value = getattr(self, key)
            if type(value) is not int or value < (0 if key == "base_revision" else 1):
                raise ValueError("Plan revision numbers are invalid")
        if self.revision != self.base_revision + 1:
            raise ValueError("Plan revision number must follow the base revision")
        if len(self.base_signature) != 64 or any(c not in "0123456789abcdef" for c in self.base_signature):
            raise ValueError("Plan revision must bind a SHA-256 base signature")
        if not isinstance(self.goal_profile, GoalProfile) or self.goal_profile.id != self.goal_id:
            raise ValueError("Plan revision profile must keep the current Goal identity")
        if not isinstance(self.frontier, FrontierPlan):
            raise TypeError("Plan revision requires a FrontierPlan")
        spine = tuple(self.curriculum_spine)
        if not 5 <= len(spine) <= 8 or any(not isinstance(item, CurriculumMilestone) for item in spine):
            raise ValueError("Plan revision Spine must contain 5-8 milestones")
        if len({item.id for item in spine}) != len(spine):
            raise ValueError("Plan revision milestone ids must be unique")
        added = tuple(self.added_skills)
        updated = tuple(self.updated_skills)
        removed = tuple(self.remove_skill_ids)
        if any(not isinstance(item, SkillNode) for item in (*added, *updated)):
            raise TypeError("Plan revision Skills must be SkillNode values")
        if any(not isinstance(item, str) or not item.strip() for item in removed):
            raise ValueError("Plan revision remove ids must be non-empty strings")
        skill_ids = [item.id for item in (*added, *updated)] + list(removed)
        if len(set(skill_ids)) != len(skill_ids):
            raise ValueError("A Skill cannot be added, updated and removed in one revision")
        for key, limit in (("summary", 1600), ("reason", 1200), ("feedback", 4000)):
            value = getattr(self, key)
            if not isinstance(value, str) or len(value) > limit:
                raise ValueError(f"Plan revision {key} is invalid")
        if not self.summary.strip() or not self.reason.strip():
            raise ValueError("Plan revision summary and reason cannot be empty")
        if self.status not in {"PENDING", "CONFIRMED", "REJECTED", "SUPERSEDED"}:
            raise ValueError("Invalid plan revision status")
        if not isinstance(self.created_at, datetime) or self.created_at.tzinfo is None:
            raise ValueError("Plan revision timestamp must be timezone-aware")
        if self.decided_at is not None and (
            not isinstance(self.decided_at, datetime) or self.decided_at.tzinfo is None
        ):
            raise ValueError("Plan revision decision timestamp must be timezone-aware")
        if self.status == "PENDING" and (self.feedback or self.decision_request_id or self.decided_at):
            raise ValueError("Pending plan revisions cannot contain a decision")
        if self.status in {"CONFIRMED", "REJECTED"} and (
            not self.decision_request_id or self.decided_at is None
        ):
            raise ValueError("Decided plan revisions require a request identity and timestamp")
        object.__setattr__(self, "curriculum_spine", spine)
        object.__setattr__(self, "added_skills", added)
        object.__setattr__(self, "updated_skills", updated)
        object.__setattr__(self, "remove_skill_ids", removed)
