"""A one-level curriculum detour inside a Goal, never a chat/session branch."""

from dataclasses import dataclass

from .planning import FrontierPlan


@dataclass(frozen=True, slots=True)
class LearningBranch:
    id: str
    goal_id: str
    anchor_kind: str
    anchor_id: str
    purpose: str
    title: str
    reason: str
    scope: str
    return_condition: str
    source_ids: tuple[str, ...] = ()
    source_goal_ids: tuple[str, ...] = ()
    skill_ids: tuple[str, ...] = ()
    exclusive_skill_ids: tuple[str, ...] = ()
    task_ids: tuple[str, ...] = ()
    status: str = "PROPOSED"
    revision: int = 0
    frontier: FrontierPlan | None = None
    return_task_id: str | None = None
    last_operation_id: str | None = None
    last_action: str | None = None
    handoff: str = ""
    assistance_provided: bool = False

    def __post_init__(self):
        for name in ("id", "goal_id", "anchor_id", "title", "reason", "scope", "return_condition"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip() or len(value) > 1600:
                raise ValueError(f"Branch {name} must contain 1-1600 characters")
        if self.anchor_kind not in ("skill", "milestone"):
            raise ValueError("Branches attach only to a main Skill or milestone; child branches are not supported")
        if self.purpose not in ("prerequisite", "extension"):
            raise ValueError("Unknown learning branch purpose")
        if self.status not in ("PROPOSED", "READY", "ACTIVE", "PAUSED", "COMPLETED"):
            raise ValueError("Unknown learning branch status")
        if type(self.revision) is not int or self.revision < 0:
            raise ValueError("Invalid branch revision")
        for name in ("source_ids", "source_goal_ids", "skill_ids", "exclusive_skill_ids", "task_ids"):
            raw = getattr(self, name)
            if not isinstance(raw, (tuple, list)):
                raise ValueError(f"Invalid branch {name}")
            values = tuple(raw)
            if len(values) != len(set(values)) or any(not isinstance(v, str) or not v for v in values):
                raise ValueError(f"Invalid branch {name}")
            object.__setattr__(self, name, values)
        if not set(self.exclusive_skill_ids).issubset(self.skill_ids):
            raise ValueError("Branch exclusive skills must belong to its scope")
        if len(self.source_goal_ids) > 6:
            raise ValueError("A branch may reference at most six source Goals")
