"""Durable records of earlier user-confirmed learning projects."""

from dataclasses import dataclass, field
from datetime import UTC, datetime

from .planning import CurriculumMilestone, FrontierPlan, GoalProfile


@dataclass(frozen=True, slots=True)
class ArchivedLearningProject:
    """A previous Goal and its learned Skill identities.

    Archiving does not manufacture mastery. The referenced SkillNode and
    Evidence records remain the authoritative facts about what the user did.

    archived_at dates this workspace snapshot, not the Goal's first archive or
    learning activity. Leaving the foreground creates a new snapshot (including
    Goal replacement or recycling the current Goal); restoring a recycled
    snapshot preserves its timestamp. First archive and last activation times
    are not separately recorded and cannot be inferred from this field.
    """

    goal_profile: GoalProfile
    curriculum_spine: tuple[CurriculumMilestone, ...]
    skill_ids: tuple[str, ...]
    archived_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    frontier: FrontierPlan | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.goal_profile, GoalProfile):
            raise TypeError("ArchivedLearningProject requires a GoalProfile")
        spine = tuple(self.curriculum_spine)
        skills = tuple(self.skill_ids)
        if any(not isinstance(item, CurriculumMilestone) for item in spine):
            raise TypeError("Archived project spine must contain milestones")
        if any(not isinstance(item, str) or not item.strip() for item in skills):
            raise ValueError("Archived project Skill ids must be non-empty strings")
        if len(skills) != len(set(skills)):
            raise ValueError("Archived project cannot repeat a Skill id")
        if (
            not isinstance(self.archived_at, datetime)
            or self.archived_at.tzinfo is None
            or self.archived_at.utcoffset() is None
        ):
            raise ValueError("Archived project timestamp must be timezone-aware")
        object.__setattr__(self, "curriculum_spine", spine)
        object.__setattr__(self, "skill_ids", skills)


@dataclass(frozen=True, slots=True)
class RecycledLearningProject:
    """用户回收的原工作区；事实仍引用同一账本，不能从聊天重造。"""

    project: ArchivedLearningProject
    deleted_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    active_task_ids: tuple[str, ...] = ()
    purge_started: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.project, ArchivedLearningProject):
            raise TypeError("Recycled project requires an archived workspace")
        if self.deleted_at.tzinfo is None:
            raise ValueError("Recycle timestamp must be timezone-aware")
        object.__setattr__(self, "active_task_ids", tuple(self.active_task_ids))
