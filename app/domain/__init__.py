"""Pure Python learning-domain models; no Agent or persistence dependencies."""

from .evidence import AssistanceLevel, Evidence, EvidenceType
from .graph import SkillGraph
from .history import ArchivedLearningProject
from .knowledge_card import CardFeedbackStatus, KnowledgeCard
from .planning import (
    CurriculumMilestone,
    FrontierPlan,
    GoalProfile,
    LearningDepth,
    LearningPlan,
)
from .planning_revision import LearningPlanRevision
from .skill import SkillNode, SkillState
from .task import LearningTask, TaskStatus, TeachingActivity, TeachingActivityMethod

__all__ = [
    "AssistanceLevel",
    "ArchivedLearningProject",
    "CardFeedbackStatus",
    "Evidence",
    "EvidenceType",
    "KnowledgeCard",
    "LearningTask",
    "SkillGraph",
    "CurriculumMilestone",
    "FrontierPlan",
    "GoalProfile",
    "LearningDepth",
    "LearningPlan",
    "LearningPlanRevision",
    "SkillNode",
    "SkillState",
    "TaskStatus",
    "TeachingActivity",
    "TeachingActivityMethod",
]
