"""A skill and its small, explicit learning-state lifecycle."""

from dataclasses import dataclass, replace
from enum import Enum
from typing import TYPE_CHECKING

from .planning import LearningDepth

if TYPE_CHECKING:
    from .evidence import Evidence


class SkillState(str, Enum):
    NOT_STARTED = "NOT_STARTED"
    LEARNING = "LEARNING"
    PRACTICING = "PRACTICING"
    MASTERED_BY_USER = "MASTERED_BY_USER"


@dataclass(frozen=True, slots=True)
class SkillNode:
    id: str
    name: str
    description: str = ""
    prerequisites: tuple[str, ...] = ()
    status: SkillState = SkillState.NOT_STARTED
    evidence_ids: tuple[str, ...] = ()
    target_depth: LearningDepth = LearningDepth.PRACTICAL

    def __post_init__(self) -> None:
        if not isinstance(self.id, str) or not self.id.strip():
            raise ValueError("Skill id must be a non-empty string")
        if not isinstance(self.name, str) or not self.name.strip():
            raise ValueError("Skill name must be a non-empty string")
        if not isinstance(self.description, str):
            raise ValueError("Skill description must be a string")
        if not isinstance(self.status, SkillState):
            raise ValueError("Skill status must be a SkillState")
        if not isinstance(self.target_depth, LearningDepth):
            raise ValueError("Skill target_depth must be a LearningDepth")

        prerequisites = tuple(self.prerequisites)
        evidence_ids = tuple(self.evidence_ids)
        self._validate_ids(prerequisites, "prerequisite")
        self._validate_ids(evidence_ids, "evidence")
        if self.id in prerequisites:
            raise ValueError("A Skill cannot depend on itself")
        object.__setattr__(self, "prerequisites", prerequisites)
        object.__setattr__(self, "evidence_ids", evidence_ids)

    @staticmethod
    def _validate_ids(values: tuple[str, ...], label: str) -> None:
        if any(not isinstance(value, str) or not value.strip() for value in values):
            raise ValueError(f"Every {label} id must be a non-empty string")
        if len(values) != len(set(values)):
            raise ValueError(f"Duplicate {label} id")

    def start_learning(self) -> "SkillNode":
        if self.status is not SkillState.NOT_STARTED:
            raise ValueError("Only a not-started Skill can begin learning")
        return replace(self, status=SkillState.LEARNING)

    def start_practicing(self) -> "SkillNode":
        if self.status is not SkillState.LEARNING:
            raise ValueError("Only a learning Skill can begin practicing")
        return replace(self, status=SkillState.PRACTICING)

    def return_to_learning(self) -> "SkillNode":
        if self.status is not SkillState.PRACTICING:
            raise ValueError("Only a practicing Skill can return to learning")
        return replace(self, status=SkillState.LEARNING)

    def confirm_mastery_by_user(self) -> "SkillNode":
        """Domain transition for a future user-only application entry point.

        Phase 1 has no Agent Tool Registry or user authentication. The later
        Application Service must expose this only through a user-owned path.
        """
        if self.status is not SkillState.PRACTICING:
            raise ValueError("Only a practicing Skill can be user-confirmed")
        return replace(self, status=SkillState.MASTERED_BY_USER)

    def reopen_by_user(self) -> "SkillNode":
        if self.status is not SkillState.MASTERED_BY_USER:
            raise ValueError("Only a user-mastered Skill can be reopened")
        return replace(self, status=SkillState.PRACTICING)

    def record_evidence(self, evidence: "Evidence") -> "SkillNode":
        from .evidence import Evidence

        if not isinstance(evidence, Evidence):
            raise TypeError("Expected an Evidence object")
        if evidence.skill_id != self.id:
            raise ValueError("Evidence belongs to a different Skill")
        if evidence.id in self.evidence_ids:
            raise ValueError("Evidence is already linked to this Skill")
        return replace(self, evidence_ids=(*self.evidence_ids, evidence.id))
