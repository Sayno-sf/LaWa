"""教学要求、评价更正和个人策略；均不授予 Evidence 或 Mastery 权限。"""

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone

from app.domain.answer_assessment import AssessmentCriterion
from app.domain.assessment_topic import AssessmentTopic
from app.domain.task import TeachingActivity, TeachingActivityMethod


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def bounded(value: str, limit: int, name: str) -> None:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError(f"Invalid {name}")


@dataclass(frozen=True, slots=True)
class QuestionContract:
    id: str
    goal_id: str
    task_id: str
    skill_id: str
    session_id: str
    question: str
    criteria: tuple[tuple[str, int], ...]
    created_at: str = field(default_factory=now)
    review_topic_id: str | None = None
    activity_revision: int = 0
    teaching_activity: TeachingActivity | None = None

    def __post_init__(self):
        if type(self.activity_revision) is not int or self.activity_revision < 0:
            raise ValueError("Invalid question activity revision")
        if self.teaching_activity is not None and (not isinstance(self.teaching_activity, TeachingActivity) or self.activity_revision < 1):
            raise ValueError("Question activity snapshot needs a saved activity revision")
        for key in ("id", "goal_id", "task_id", "skill_id", "session_id"):
            bounded(getattr(self, key), 200, key)
        bounded(self.question, 2000, "question")
        if self.review_topic_id is not None:
            bounded(self.review_topic_id, 200, "review_topic_id")
        object.__setattr__(self, "criteria", tuple(tuple(c) for c in self.criteria))
        if not 1 <= len(self.criteria) <= 5 or len({c[0] for c in self.criteria}) != len(self.criteria):
            raise ValueError("Question requirements must be distinct")
        for label, possible in self.criteria:
            bounded(label, 100, "criterion")
            if type(possible) is not int or not 1 <= possible <= 10:
                raise ValueError("Invalid criterion points")
        if sum(c[1] for c in self.criteria) != 10:
            raise ValueError("Question requirements must total 10")


@dataclass(frozen=True, slots=True)
class AssessmentCorrection:
    id: str
    assessment_id: str
    expected_revision: int
    reason: str
    criteria: tuple[AssessmentCriterion, ...]
    summary: str
    strengths: tuple[str, ...]
    gaps: tuple[str, ...]
    created_at: str = field(default_factory=now)

    def __post_init__(self):
        for key in ("id", "assessment_id"):
            bounded(getattr(self, key), 200, key)
        bounded(self.reason, 600, "correction reason")
        if type(self.expected_revision) is not int or self.expected_revision < 0:
            raise ValueError("Invalid correction revision")
        for key in ("criteria", "strengths", "gaps"):
            object.__setattr__(self, key, tuple(getattr(self, key)))


@dataclass(frozen=True, slots=True)
class TeachingProposal:
    id: str
    goal_id: str | None
    kind: str
    text: str
    reason: str
    scope: str
    subject: str
    assessment_ids: tuple[str, ...]
    revision: int = 1
    status: str = "PENDING"
    feedback: str = ""
    created_at: str = field(default_factory=now)
    goal_signature: str = ""
    source_independent: bool = False

    def __post_init__(self):
        for key, limit in (("id", 200), ("text", 600)):
            bounded(getattr(self, key), limit, key)
        if not isinstance(self.reason, str) or not isinstance(self.feedback, str):
            raise ValueError("Invalid strategy reason or feedback")
        if type(self.source_independent) is not bool or self.source_independent and (self.scope != "USER" or self.kind != "STRATEGY"):
            raise ValueError("Only explicitly confirmed user-wide methods may be independent")
        detached = self.goal_id is None
        if detached:
            if not self.source_independent or self.status not in {"CONFIRMED", "WITHDRAWN", "REVISION_REQUESTED"} or self.reason or self.assessment_ids or self.goal_signature:
                raise ValueError("Independent arrangements keep only the confirmed method, not deleted source excerpts")
        else:
            bounded(self.goal_id, 200, "goal_id")
            bounded(self.reason, 600, "reason")
        if self.kind not in {"STRATEGY", "CLOSURE"} or self.scope not in {"GOAL", "SUBJECT", "USER"}:
            raise ValueError("Invalid proposal kind or scope")
        if self.scope == "SUBJECT":
            bounded(self.subject, 120, "subject")
        elif self.subject:
            raise ValueError("Only subject strategies may specify a subject")
        if self.kind == "CLOSURE" and self.scope != "GOAL":
            raise ValueError("Closure must belong to one Goal")
        if self.status not in {"PENDING", "CONFIRMED", "REJECTED", "REVISION_REQUESTED", "WITHDRAWN", "PAUSED"}:
            raise ValueError("Invalid proposal status")
        if type(self.revision) is not int or self.revision < 1 or len(self.feedback) > 4000:
            raise ValueError("Invalid proposal revision or feedback")
        if self.goal_signature and (len(self.goal_signature) != 64 or any(c not in "0123456789abcdef" for c in self.goal_signature)):
            raise ValueError("Invalid proposal Goal version")
        object.__setattr__(self, "assessment_ids", tuple(self.assessment_ids))
        if not detached and (not 1 <= len(self.assessment_ids) <= 6 or len(set(self.assessment_ids)) != len(self.assessment_ids)):
            raise ValueError("A proposal needs 1-6 actual assessment references")


@dataclass(frozen=True, slots=True)
class ProposalDecision:
    request_id: str
    proposal_id: str
    expected_revision: int
    action: str
    feedback: str


@dataclass(frozen=True, slots=True)
class DeletedProposal:
    id: str
    goal_id: str | None
    fingerprints: tuple[str, ...]
    request_id: str
    expected_revision: int

    def __post_init__(self):
        for key in ("id", "request_id"):
            bounded(getattr(self, key), 200, key)
        if self.goal_id is not None:
            bounded(self.goal_id, 200, "goal_id")
        object.__setattr__(self, "fingerprints", tuple(self.fingerprints))
        if not self.fingerprints or any(len(v) != 64 or any(c not in "0123456789abcdef" for c in v) for v in self.fingerprints):
            raise ValueError("Invalid deleted strategy fingerprint")
        if type(self.expected_revision) is not int or self.expected_revision < 1:
            raise ValueError("Invalid deleted strategy revision")


@dataclass(frozen=True, slots=True)
class TeachingEvolutionState:
    contracts: tuple[QuestionContract, ...] = ()
    corrections: tuple[AssessmentCorrection, ...] = ()
    proposals: tuple[TeachingProposal, ...] = ()
    decisions: tuple[ProposalDecision, ...] = ()
    proposal_versions: tuple[TeachingProposal, ...] = ()
    deleted_proposals: tuple[DeletedProposal, ...] = ()
    topics: tuple[AssessmentTopic, ...] = ()

    def __post_init__(self):
        for key in ("contracts", "corrections", "proposals", "decisions", "proposal_versions", "deleted_proposals", "topics"):
            object.__setattr__(self, key, tuple(getattr(self, key)))
        for values, key in ((self.contracts, "id"), (self.corrections, "id"), (self.proposals, "id"), (self.decisions, "request_id"), (self.deleted_proposals, "id"), (self.topics, "id")):
            if len({getattr(v, key) for v in values}) != len(values):
                raise ValueError("Duplicate teaching record identity")

    def to_json(self) -> dict:
        value = asdict(self)
        # 旧题原样保留，不在下一次普通保存时追造活动快照。
        for contract in value["contracts"]:
            if contract["activity_revision"] == 0 and contract["teaching_activity"] is None:
                contract.pop("activity_revision")
                contract.pop("teaching_activity")
        return value

    @classmethod
    def from_json(cls, value: dict):
        if not isinstance(value, dict) or set(value) - {"contracts", "corrections", "proposals", "decisions", "proposal_versions", "deleted_proposals", "topics"}:
            raise ValueError("Invalid teaching state")
        return cls(
            contracts=tuple(QuestionContract(**{**v, "teaching_activity": TeachingActivity(**{
                **v["teaching_activity"], "method": TeachingActivityMethod(v["teaching_activity"]["method"]),
            }) if v.get("teaching_activity") is not None else None}) for v in value.get("contracts", ())),
            corrections=tuple(AssessmentCorrection(**{**v, "criteria": tuple(AssessmentCriterion(**c) for c in v["criteria"])}) for v in value.get("corrections", ())),
            proposals=tuple(TeachingProposal(**v) for v in value.get("proposals", ())),
            decisions=tuple(ProposalDecision(**v) for v in value.get("decisions", ())),
            proposal_versions=tuple(TeachingProposal(**v) for v in value.get("proposal_versions", ())),
            deleted_proposals=tuple(DeletedProposal(**v) for v in value.get("deleted_proposals", ())),
            topics=tuple(AssessmentTopic(**v) for v in value.get("topics", ())),
        )
