"""Goal and curriculum planning concepts, independent of LLM and HTTP adapters."""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
import re
import unicodedata


def normalize_learning_domain(value: str) -> str:
    """领域是已确认目标的范围标签；不从目标文字猜测，也不合并语义近似标签。"""
    if not isinstance(value, str):
        raise ValueError("GoalProfile learning_domain must be a string")
    normalized = re.sub(r"[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+", " ", unicodedata.normalize("NFKC", value)).strip(" ").lower()
    if len(normalized) > 80 or normalized in {"general", "generic", "other", "unknown", "通用", "其他", "其它", "未知", "不确定", "全领域", "全部"}:
        raise ValueError("Learning domain must name a specific field, not a generic fallback")
    return normalized


class LearningDepth(str, Enum):
    """目标学习深度；它与表示当前进度的 SkillState 完全独立。"""

    OVERVIEW = "OVERVIEW"
    PRACTICAL = "PRACTICAL"
    DEEP = "DEEP"


@dataclass(frozen=True, slots=True)
class GoalProfile:
    """用户确认过的目标理解，而不是由系统推断出的永久用户画像。"""

    id: str
    goal_description: str
    background_summary: str
    desired_outcome: str
    learning_preferences: tuple[str, ...] = ()
    time_constraint: str = ""
    prior_knowledge_claims: tuple[str, ...] = ()
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    learning_domain: str = ""

    def __post_init__(self) -> None:
        for field_name in (
            "id",
            "goal_description",
            "background_summary",
            "desired_outcome",
        ):
            value = getattr(self, field_name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"GoalProfile {field_name} must be a non-empty string")
        if not isinstance(self.time_constraint, str):
            raise ValueError("GoalProfile time_constraint must be a string")
        object.__setattr__(self, "learning_domain", normalize_learning_domain(self.learning_domain))
        object.__setattr__(self, "learning_preferences", tuple(self.learning_preferences))
        object.__setattr__(self, "prior_knowledge_claims", tuple(self.prior_knowledge_claims))
        for values, label in (
            (self.learning_preferences, "learning preference"),
            (self.prior_knowledge_claims, "prior knowledge claim"),
        ):
            if any(not isinstance(item, str) or not item.strip() for item in values):
                raise ValueError(f"Every {label} must be a non-empty string")


@dataclass(frozen=True, slots=True)
class CurriculumMilestone:
    """Spine 中的粗粒度阶段；它不是可直接激活的 LearningTask。"""

    id: str
    name: str
    description: str
    target_depth: LearningDepth
    skill_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        for field_name in ("id", "name", "description"):
            value = getattr(self, field_name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"CurriculumMilestone {field_name} must be non-empty")
        if not isinstance(self.target_depth, LearningDepth):
            raise ValueError("CurriculumMilestone target_depth must be a LearningDepth")
        skill_ids = tuple(self.skill_ids)
        if any(not isinstance(item, str) or not item.strip() for item in skill_ids):
            raise ValueError("CurriculumMilestone Skill ids must be non-empty strings")
        if len(skill_ids) != len(set(skill_ids)):
            raise ValueError("CurriculumMilestone Skill ids must be unique")
        # 阶段归属由当前Goal的路线持有，不修改可被其他Goal复用的Skill身份或学习状态。
        object.__setattr__(self, "skill_ids", skill_ids)


@dataclass(frozen=True, slots=True)
class FrontierPlan:
    """当前只展开的近期学习区域；远期 Spine 不在这里细化。"""

    focus_skill_id: str
    reason: str
    target_depth: LearningDepth
    suggested_learning_mode: str
    next_action: str
    supporting_skill_ids: tuple[str, ...] = ()
    teaching_preferences_revision: str | None = None

    def __post_init__(self) -> None:
        if self.teaching_preferences_revision is not None and (not isinstance(self.teaching_preferences_revision, str) or len(self.teaching_preferences_revision) != 64 or any(c not in "0123456789abcdef" for c in self.teaching_preferences_revision)):
            raise ValueError("Invalid teaching preferences revision")
        for field_name in (
            "focus_skill_id",
            "reason",
            "suggested_learning_mode",
            "next_action",
        ):
            value = getattr(self, field_name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"FrontierPlan {field_name} must be non-empty")
        if not isinstance(self.target_depth, LearningDepth):
            raise ValueError("FrontierPlan target_depth must be a LearningDepth")
        supporting = tuple(self.supporting_skill_ids)
        if any(not isinstance(item, str) or not item.strip() for item in supporting):
            raise ValueError("Every supporting Skill id must be non-empty")
        if len(supporting) != len(set(supporting)):
            raise ValueError("Duplicate supporting Skill id")
        if self.focus_skill_id in supporting:
            raise ValueError("Frontier focus cannot also be a supporting Skill")
        object.__setattr__(self, "supporting_skill_ids", supporting)


@dataclass(frozen=True, slots=True)
class LearningPlan:
    """当前 Goal 的工作计划；Spine 相对稳定，Frontier 可随 Evidence 调整。"""

    goal_profile: GoalProfile
    curriculum_spine: tuple[CurriculumMilestone, ...]
    frontier: FrontierPlan

    def __post_init__(self) -> None:
        spine = tuple(self.curriculum_spine)
        if not 5 <= len(spine) <= 8:
            raise ValueError("Initial Curriculum Spine must contain 5 to 8 milestones")
        ids = tuple(item.id for item in spine)
        if len(ids) != len(set(ids)):
            raise ValueError("Curriculum Spine milestone ids must be unique")
        object.__setattr__(self, "curriculum_spine", spine)
