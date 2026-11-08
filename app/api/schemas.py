"""HTTP response models; Domain objects stay independent of JSON concerns."""

from datetime import datetime
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator
from app.domain.planning import normalize_learning_domain

from app.application import LearningLibrary, LearningLibraryProject, LearningOverview
from app.domain import (
    ArchivedLearningProject,
    AssistanceLevel,
    CardFeedbackStatus,
    EvidenceType,
    KnowledgeCard,
    LearningDepth,
    LearningPlan,
    LearningPlanRevision,
    TeachingActivity,
    TeachingActivityMethod,
)


class AssessmentCriterionSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="forbid")
    label: str = Field(min_length=1, max_length=100)
    earned: int = Field(ge=0, le=10, strict=True)
    possible: int = Field(ge=1, le=10, strict=True)
    feedback: str = Field(min_length=1, max_length=400)


class RecordAnswerAssessmentRequest(BaseModel):
    topic_aliases: tuple[str, ...] = Field(default=(), max_length=6)
    correction_reason: None = None
    contract_id: str | None = Field(default=None, max_length=200)
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=200)
    goal_id: str = Field(min_length=1, max_length=200)
    skill_id: str = Field(min_length=1, max_length=200)
    topic_id: str | None = Field(default=None, max_length=200)
    topic: str = Field(min_length=1, max_length=160)
    source_task_id: str = Field(min_length=1, max_length=200)
    source_session_id: str = Field(min_length=1, max_length=200)
    source_turn_id: str = Field(min_length=1, max_length=200)
    question_entry_id: str = Field(min_length=1, max_length=200)
    question: str = Field(min_length=1, max_length=2000)
    answer_excerpt: str = Field(min_length=1, max_length=8000)
    answer_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    answer_truncated: bool
    criteria: tuple[AssessmentCriterionSchema, ...] = Field(min_length=1, max_length=5)
    summary: str = Field(min_length=1, max_length=600)
    strengths: tuple[str, ...] = Field(max_length=4)
    gaps: tuple[str, ...] = Field(max_length=4)
    assistance_level: str


class AnswerAssessmentResponse(RecordAnswerAssessmentRequest):
    correction_reason: str | None = None
    model_config = ConfigDict(from_attributes=True)
    topic_id: str
    score: int
    max_score: int
    follow_up: str
    review_after: int | None
    created_at: datetime


class AnswerAssessmentCardResponse(BaseModel):
    correction_reason: str | None = None
    """学习库保留全部评分卡，但不重复发送已经在Pi保存的完整答案摘录。"""
    model_config = ConfigDict(from_attributes=True)
    id: str
    goal_id: str
    skill_id: str
    topic_id: str
    topic: str
    question: str
    criteria: tuple[AssessmentCriterionSchema, ...]
    summary: str
    strengths: tuple[str, ...]
    gaps: tuple[str, ...]
    assistance_level: str
    score: int
    max_score: int
    follow_up: str
    review_after: int | None
    created_at: datetime


class GoalProfileRequest(BaseModel):
    id: str
    goal_description: str
    background_summary: str
    desired_outcome: str
    learning_preferences: tuple[str, ...] = ()
    time_constraint: str = ""
    prior_knowledge_claims: tuple[str, ...] = ()
    learning_domain: str = ""

    @field_validator("learning_domain")
    @classmethod
    def normalize_domain(cls, value: str) -> str:
        return normalize_learning_domain(value)


class GoalProfileResponse(GoalProfileRequest):
    model_config = ConfigDict(from_attributes=True)

    created_at: datetime


class CurriculumMilestoneSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    description: str
    target_depth: LearningDepth
    skill_ids: tuple[str, ...] = ()


class PlannedSkillRequest(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    description: str = ""
    prerequisites: tuple[str, ...] = ()
    target_depth: LearningDepth = LearningDepth.PRACTICAL


class FrontierPlanSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    focus_skill_id: str
    supporting_skill_ids: tuple[str, ...] = ()
    reason: str
    target_depth: LearningDepth
    suggested_learning_mode: str
    next_action: str
    teaching_preferences_revision: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


class InitializeCurriculumRequest(BaseModel):
    goal_profile: GoalProfileRequest
    curriculum_spine: tuple[CurriculumMilestoneSchema, ...]
    frontier_skills: tuple[PlannedSkillRequest, ...]
    frontier: FrontierPlanSchema
    replace_existing: bool = False
    onboarding_session_id: str | None = None
    reading_requirement_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    recover_only: bool = False


class SkillDepthChangeSchema(BaseModel):
    skill_id: str
    target_depth: LearningDepth


class PrerequisiteAdditionSchema(BaseModel):
    skill_id: str
    prerequisite_id: str


class MilestoneAssignmentSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")

    skill_id: str = Field(min_length=1)
    milestone_id: str = Field(min_length=1)


class ApplyFrontierPlanRequest(BaseModel):
    frontier: FrontierPlanSchema
    added_skills: tuple[PlannedSkillRequest, ...] = ()
    depth_changes: tuple[SkillDepthChangeSchema, ...] = ()
    prerequisite_additions: tuple[PrerequisiteAdditionSchema, ...] = ()
    remove_skill_ids: tuple[str, ...] = ()
    milestone_assignments: tuple[MilestoneAssignmentSchema, ...] = ()


class PreparePlanRevisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=200)
    goal_profile: GoalProfileRequest
    curriculum_spine: tuple[CurriculumMilestoneSchema, ...] = Field(min_length=5, max_length=8)
    added_skills: tuple[PlannedSkillRequest, ...] = Field(default=(), max_length=50)
    updated_skills: tuple[PlannedSkillRequest, ...] = Field(default=(), max_length=50)
    remove_skill_ids: tuple[str, ...] = Field(default=(), max_length=50)
    frontier: FrontierPlanSchema
    reason: str = Field(min_length=1, max_length=1200)


class DecidePlanRevisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["CONFIRM", "REJECT"]
    feedback: str = Field(default="", max_length=4000)
    request_id: str = Field(min_length=1, max_length=200)


class LearningPlanRevisionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    goal_id: str
    base_revision: int
    revision: int
    base_signature: str
    goal_profile: GoalProfileResponse
    curriculum_spine: tuple[CurriculumMilestoneSchema, ...]
    added_skills: tuple[PlannedSkillRequest, ...]
    updated_skills: tuple[PlannedSkillRequest, ...]
    remove_skill_ids: tuple[str, ...]
    frontier: FrontierPlanSchema
    summary: str
    reason: str
    status: str
    feedback: str
    decision_request_id: str
    created_at: datetime
    decided_at: datetime | None

    @classmethod
    def from_domain(cls, revision: LearningPlanRevision) -> Self:
        return cls.model_validate(revision)


class LearningPlanResponse(BaseModel):
    goal_profile: GoalProfileResponse
    curriculum_spine: tuple[CurriculumMilestoneSchema, ...]
    frontier: FrontierPlanSchema

    @classmethod
    def from_domain(cls, plan: LearningPlan) -> Self:
        return cls(
            goal_profile=GoalProfileResponse.model_validate(plan.goal_profile),
            curriculum_spine=tuple(
                CurriculumMilestoneSchema.model_validate(item)
                for item in plan.curriculum_spine
            ),
            frontier=FrontierPlanSchema.model_validate(plan.frontier),
        )


class TeachingActivitySchema(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="forbid")

    method: TeachingActivityMethod
    purpose: str = Field(min_length=1, max_length=300)
    learner_action: str = Field(min_length=1, max_length=500)
    observable_output: str = Field(min_length=1, max_length=300)
    evaluation_focus: tuple[str, ...] = Field(min_length=1, max_length=5)
    observation_limits: str = Field(min_length=1, max_length=400)
    teaching_preferences_revision: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")

    def to_domain(self) -> TeachingActivity:
        return TeachingActivity(**self.model_dump())


class SetTeachingActivityRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_goal_id: str = Field(min_length=1, max_length=200)
    expected_revision: int = Field(ge=0, strict=True)
    teaching_activity: TeachingActivitySchema


class CreateLearningTaskRequest(BaseModel):
    title: str
    description: str
    related_skill_ids: tuple[str, ...] = Field(min_length=1, max_length=1)
    expected_evidence_types: tuple[EvidenceType, ...] = ()
    teaching_activity: TeachingActivitySchema | None = None


class SubmitEvidenceRequest(BaseModel):
    skill_id: str
    evidence_type: EvidenceType
    description: str
    assistance_level: AssistanceLevel
    source: str


class CreateKnowledgeCardRequest(BaseModel):
    """Agent-authorized card creation. Feedback and note are NOT accepted here."""

    skill_id: str
    question: str
    answer: str
    source_conversation_id: str | None = None


class ExpectedCardContent(BaseModel):
    skill_id: str
    question: str
    answer: str


class SetCardFeedbackRequest(BaseModel):
    """User self-report. Only accepted through /api/user/*."""

    status: CardFeedbackStatus
    expected_content: ExpectedCardContent | None = None


class SetCardNoteRequest(BaseModel):
    """User-owned note content. Only accepted through /api/user/*."""

    note: str


class UpdateKnowledgeCardRequest(BaseModel):
    """User-owned card content edit. Only accepted through /api/user/*."""

    question: str
    answer: str


class KnowledgeCardResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    skill_id: str
    question: str
    answer: str
    created_at: datetime
    source_conversation_id: str | None
    feedback: str | None
    feedback_updated_at: datetime | None
    feedback_revision: int = 0
    learner_note: str | None
    note_updated_at: datetime | None

    @classmethod
    def from_domain(cls, card: KnowledgeCard) -> Self:
        return cls(
            id=card.id,
            skill_id=card.skill_id,
            question=card.question,
            answer=card.answer,
            created_at=card.created_at,
            source_conversation_id=card.source_conversation_id,
            feedback=card.feedback.value if card.feedback is not None else None,
            feedback_updated_at=card.feedback_updated_at,
            feedback_revision=card.feedback_revision,
            learner_note=card.learner_note,
            note_updated_at=card.note_updated_at,
        )


class SkillResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    description: str
    prerequisites: tuple[str, ...]
    status: str
    evidence_ids: tuple[str, ...]
    target_depth: LearningDepth


class EvidenceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    skill_id: str
    evidence_type: str
    description: str
    assistance_level: str
    source: str
    created_at: datetime


class TaskResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    description: str
    related_skill_ids: tuple[str, ...]
    expected_evidence_types: tuple[str, ...]
    status: str
    goal_id: str | None = None
    review_parent_task_id: str | None = None
    teaching_activity: TeachingActivitySchema | None = None
    activity_revision: int = 0
    branch_id: str | None = None


class ArchivedLearningProjectResponse(BaseModel):
    goal_profile: GoalProfileResponse
    curriculum_spine: tuple[CurriculumMilestoneSchema, ...]
    skill_ids: tuple[str, ...]
    archived_at: datetime = Field(description=(
        "Creation time of this archived workspace snapshot, refreshed when the Goal "
        "leaves the foreground; preserved on recycle restore. Not first archive, "
        "last activation, completion, or learning time."
    ))
    frontier: FrontierPlanSchema | None = None

    @classmethod
    def from_domain(cls, project: ArchivedLearningProject) -> Self:
        return cls(
            goal_profile=GoalProfileResponse.model_validate(project.goal_profile),
            curriculum_spine=tuple(
                CurriculumMilestoneSchema.model_validate(item)
                for item in project.curriculum_spine
            ),
            skill_ids=project.skill_ids,
            archived_at=project.archived_at,
            frontier=(FrontierPlanSchema.model_validate(project.frontier) if project.frontier else None),
        )


class LearningLibraryProjectResponse(BaseModel):
    status: str
    goal_profile: GoalProfileResponse
    curriculum_spine: tuple[CurriculumMilestoneSchema, ...]
    skills: tuple[SkillResponse, ...]
    evidence: tuple[EvidenceResponse, ...]
    knowledge_cards: tuple[KnowledgeCardResponse, ...]
    archived_at: datetime | None = Field(description=(
        "Archived workspace snapshot creation time, not first archive or learning "
        "time; null for the current Goal. Recycle restore preserves the old value."
    ))
    answer_assessments: tuple[AnswerAssessmentCardResponse, ...] = ()
    assessment_count: int = 0

    @classmethod
    def from_application(cls, project: LearningLibraryProject) -> Self:
        return cls(
            status=project.status,
            goal_profile=GoalProfileResponse.model_validate(project.goal_profile),
            curriculum_spine=tuple(
                CurriculumMilestoneSchema.model_validate(item)
                for item in project.curriculum_spine
            ),
            skills=tuple(SkillResponse.model_validate(item) for item in project.skills),
            evidence=tuple(
                EvidenceResponse.model_validate(item) for item in project.evidence
            ),
            knowledge_cards=tuple(
                KnowledgeCardResponse.from_domain(item) for item in project.knowledge_cards
            ),
            archived_at=project.archived_at,
            answer_assessments=tuple(AnswerAssessmentCardResponse.model_validate(a) for a in project.answer_assessments),
            assessment_count=project.assessment_count,
        )


class LearningLibraryResponse(BaseModel):
    projects: tuple[LearningLibraryProjectResponse, ...] = Field(description=(
        "Current Goal first, then reverse history insertion order (including recycle "
        "restore); not sorted by archived_at or learning activity time."
    ))

    @classmethod
    def from_application(cls, library: LearningLibrary) -> Self:
        return cls(
            projects=tuple(
                LearningLibraryProjectResponse.from_application(item)
                for item in library.projects
            )
        )


class LearningOverviewResponse(BaseModel):
    learning_paths: dict = Field(default_factory=dict)
    imported_goal_needs_route: bool = False
    imported_learning: dict | None = None
    imported_topics: dict | None = None
    practice_context: dict = Field(default_factory=dict)
    plan_revision: int = 0
    recycled_goal_ids: tuple[str, ...] = ()
    current_goal: str | None
    goal_profile: GoalProfileResponse | None
    curriculum_spine: tuple[CurriculumMilestoneSchema, ...]
    current_frontier: FrontierPlanSchema | None
    current_focus: TaskResponse | None
    skills: tuple[SkillResponse, ...]
    recent_evidence: tuple[EvidenceResponse, ...]
    active_task: TaskResponse | None
    learning_history: tuple[ArchivedLearningProjectResponse, ...]
    current_goal_skill_ids: tuple[str, ...]
    knowledge_cards: tuple[KnowledgeCardResponse, ...]

    @classmethod
    def from_application(cls, overview: LearningOverview) -> Self:
        task = (
            TaskResponse.model_validate(overview.active_task)
            if overview.active_task is not None
            else None
        )
        return cls(
            recycled_goal_ids=overview.recycled_goal_ids,
            learning_paths=overview.learning_paths,
            practice_context=overview.practice_context,
            plan_revision=overview.plan_revision,
            current_goal=overview.current_goal,
            goal_profile=(
                GoalProfileResponse.model_validate(overview.goal_profile)
                if overview.goal_profile is not None
                else None
            ),
            curriculum_spine=tuple(
                CurriculumMilestoneSchema.model_validate(item)
                for item in overview.curriculum_spine
            ),
            current_frontier=(
                FrontierPlanSchema.model_validate(overview.current_frontier)
                if overview.current_frontier is not None
                else None
            ),
            current_focus=task,
            skills=tuple(SkillResponse.model_validate(item) for item in overview.skills),
            recent_evidence=tuple(
                EvidenceResponse.model_validate(item) for item in overview.recent_evidence
            ),
            active_task=task,
            learning_history=tuple(
                ArchivedLearningProjectResponse.from_domain(item)
                for item in overview.learning_history
            ),
            current_goal_skill_ids=overview.current_goal_skill_ids,
            knowledge_cards=tuple(
                KnowledgeCardResponse.from_domain(item)
                for item in overview.knowledge_cards
            ),
        )
