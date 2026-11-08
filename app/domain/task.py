"""A concrete next learning action, not a measure of mastery."""

from dataclasses import dataclass, replace
from enum import Enum
import re

from .evidence import EvidenceType


class TaskStatus(str, Enum):
    TODO = "TODO"
    ACTIVE = "ACTIVE"
    PAUSED = "PAUSED"
    DONE = "DONE"
    SKIPPED = "SKIPPED"


class TeachingActivityMethod(str, Enum):
    COMPARE = "COMPARE"
    RECALL = "RECALL"
    APPLY = "APPLY"
    DIALOGUE = "DIALOGUE"
    REASON = "REASON"


@dataclass(frozen=True, slots=True)
class TeachingActivity:
    """当前任务的可执行教法安排，不是已观察到的学习表现。"""

    method: TeachingActivityMethod
    purpose: str
    learner_action: str
    observable_output: str
    evaluation_focus: tuple[str, ...]
    observation_limits: str
    teaching_preferences_revision: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.method, TeachingActivityMethod):
            raise ValueError("TeachingActivity method must be a TeachingActivityMethod")
        if self.teaching_preferences_revision is not None and (
            not isinstance(self.teaching_preferences_revision, str)
            or re.fullmatch(r"[0-9a-f]{64}", self.teaching_preferences_revision) is None
        ):
            raise ValueError("TeachingActivity preferences revision must be a SHA-256 digest")
        for name, maximum in (("purpose", 300), ("learner_action", 500),
                              ("observable_output", 300), ("observation_limits", 400)):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip() or len(value) > maximum:
                raise ValueError(f"TeachingActivity {name} must contain 1-{maximum} characters")
            object.__setattr__(self, name, value.strip())
        if not isinstance(self.evaluation_focus, (tuple, list)):
            raise ValueError("TeachingActivity evaluation_focus must be a list of labels")
        if not 1 <= len(self.evaluation_focus) <= 5 or any(
            not isinstance(label, str) or not label.strip() or len(label) > 100
            for label in self.evaluation_focus
        ):
            raise ValueError("TeachingActivity needs 1-5 evaluation labels of at most 100 characters")
        labels = tuple(label.strip() for label in self.evaluation_focus)
        if len(set(labels)) != len(labels):
            raise ValueError("TeachingActivity evaluation labels must be distinct")
        object.__setattr__(self, "evaluation_focus", labels)


@dataclass(frozen=True, slots=True)
class LearningTask:
    id: str
    title: str
    description: str
    related_skill_ids: tuple[str, ...]
    expected_evidence_types: tuple[EvidenceType, ...]
    status: TaskStatus = TaskStatus.TODO
    goal_id: str | None = None
    review_parent_task_id: str | None = None
    teaching_activity: TeachingActivity | None = None
    activity_revision: int = 0
    branch_id: str | None = None

    def __post_init__(self) -> None:
        for name in ("id", "title", "description"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"LearningTask {name} must be a non-empty string")
        skill_ids = tuple(self.related_skill_ids)
        evidence_types = tuple(self.expected_evidence_types)
        if not skill_ids or any(
            not isinstance(skill_id, str) or not skill_id.strip() for skill_id in skill_ids
        ):
            raise ValueError("LearningTask needs at least one valid Skill id")
        if len(skill_ids) != len(set(skill_ids)):
            raise ValueError("LearningTask cannot repeat a Skill id")
        if any(not isinstance(kind, EvidenceType) for kind in evidence_types):
            raise ValueError("LearningTask expected evidence types must be EvidenceType values")
        if len(evidence_types) != len(set(evidence_types)):
            raise ValueError("LearningTask cannot repeat an EvidenceType")
        if not isinstance(self.status, TaskStatus):
            raise ValueError("LearningTask status must be a TaskStatus")
        if self.goal_id is not None and (not isinstance(self.goal_id, str) or not self.goal_id.strip()):
            raise ValueError("LearningTask goal_id must be a non-empty string")
        if self.branch_id is not None and (not isinstance(self.branch_id, str) or not self.branch_id.strip() or not self.goal_id):
            raise ValueError("LearningTask branch_id requires a non-empty identity and owning Goal")
        if self.branch_id and self.review_parent_task_id:
            raise ValueError("A route Task cannot also be a separate review Task")
        if type(self.activity_revision) is not int or self.activity_revision < 0:
            raise ValueError("LearningTask activity_revision must be a non-negative integer")
        if self.teaching_activity is None:
            if self.activity_revision != 0:
                raise ValueError("LearningTask without an activity must have revision 0")
        elif not isinstance(self.teaching_activity, TeachingActivity) or self.activity_revision < 1:
            raise ValueError("LearningTask activity must have a positive revision")
        object.__setattr__(self, "related_skill_ids", skill_ids)
        object.__setattr__(self, "expected_evidence_types", evidence_types)

    def activate(self) -> "LearningTask":
        if self.status not in (TaskStatus.TODO, TaskStatus.PAUSED):
            raise ValueError("Only a TODO or PAUSED LearningTask can become ACTIVE")
        return replace(self, status=TaskStatus.ACTIVE)

    def pause(self) -> "LearningTask":
        if self.status is not TaskStatus.ACTIVE:
            raise ValueError("Only an ACTIVE LearningTask can be paused")
        return replace(self, status=TaskStatus.PAUSED)

    def complete(self) -> "LearningTask":
        if self.status is not TaskStatus.ACTIVE:
            raise ValueError("Only an ACTIVE LearningTask can be completed")
        return replace(self, status=TaskStatus.DONE)

    def skip(self) -> "LearningTask":
        if self.status not in (TaskStatus.TODO, TaskStatus.ACTIVE):
            raise ValueError("Only a TODO or ACTIVE LearningTask can be skipped")
        return replace(self, status=TaskStatus.SKIPPED)
