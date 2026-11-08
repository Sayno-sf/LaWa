"""教学扩展的HTTP适配；用户决策入口与模型提案入口明确分开。"""

from dataclasses import asdict
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.domain.teaching_evolution import QuestionContract, TeachingProposal, AssessmentCorrection
from app.domain.answer_assessment import AssessmentCriterion


class StrictInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ContractInput(StrictInput):
    id: str = Field(min_length=1, max_length=200)
    goal_id: str
    task_id: str
    skill_id: str
    session_id: str
    question: str = Field(min_length=1, max_length=2000)
    criteria: list[tuple[str, int]] = Field(min_length=1, max_length=5)
    review_topic_id: str | None = Field(default=None, max_length=200)
    activity_revision: int = Field(default=0, ge=0, strict=True)


class ProposalInput(StrictInput):
    id: str = Field(min_length=1, max_length=200)
    goal_id: str
    kind: Literal["STRATEGY", "CLOSURE"]
    text: str = Field(min_length=1, max_length=600)
    reason: str = Field(min_length=1, max_length=600)
    scope: Literal["GOAL", "SUBJECT", "USER"] = "GOAL"
    subject: str = Field(default="", max_length=120)
    assessment_ids: list[str] = Field(min_length=1, max_length=6)
    revision: int = Field(default=1, ge=1)
    expected_revision: int = Field(default=0, ge=0)
    source_independent: bool = Field(default=False, strict=True)


class DecisionInput(StrictInput):
    expected_revision: int = Field(ge=1)
    action: Literal["CONFIRM", "REJECT", "SUPPLEMENT", "WITHDRAW", "RESTORE", "PAUSE", "DELETE"]
    feedback: str = Field(default="", max_length=4000)
    request_id: str = Field(min_length=1, max_length=200)


class CorrectionInput(StrictInput):
    id: str
    assessment_id: str
    expected_revision: int = Field(ge=0)
    reason: str
    criteria: list[dict]
    summary: str
    strengths: list[str]
    gaps: list[str]


def teaching_router(get_service):
    router = APIRouter()
    dependency = Depends(get_service)

    def invoke(fn):
        try:
            return fn()
        except KeyError as error:
            raise HTTPException(404, str(error)) from error
        except (ValueError, TypeError) as error:
            raise HTTPException(409, str(error)) from error

    @router.get("/api/learning/teaching")
    def context(subject: str = "", proposal_id: str | None = None, service=dependency):
        if proposal_id is not None:
            return invoke(lambda: {"proposal_reference": service.teaching_proposal_reference(proposal_id)})
        result = service.teaching_context(subject[:120])
        if service._goal_profile:
            records = service.list_answer_assessments(service._goal_profile.id, limit=6)
            result["observations"] = [{"id": a.id, "topic": a.topic, "summary": service.effective_assessment(a).summary,
                                       "assistance_level": a.assistance_level} for a in records]
        return result

    @router.get("/api/user/teaching")
    def user_context(service=dependency):
        # 独立设置区允许用户查看/撤回跨Goal的已确认策略；不授予模型决策工具。
        return {"current_goal_id": service._goal_profile.id if service._goal_profile else None,
                "proposals": [asdict(v) for v in service.teaching_proposals()],
                "closure_progress": service.goal_closure_progress()}

    @router.get("/api/learning/teaching/topics")
    def topics(query: str = "", service=dependency):
        return invoke(lambda: {"topics": service.list_assessment_topics(query),
            "notice": "EXACT means a saved name or alias; POSSIBLE is only a hint. Reuse the correct original ID; never silently merge historical identities."})

    @router.post("/api/learning/question-contracts")
    def contract(request: ContractInput, service=dependency):
        return invoke(lambda: asdict(service.record_question_contract(QuestionContract(**request.model_dump()))))

    @router.post("/api/learning/teaching/proposals")
    def proposal(request: ProposalInput, service=dependency):
        def save():
            saved = service.propose_teaching(TeachingProposal(**request.model_dump(exclude={"expected_revision"})), request.expected_revision)
            return {**asdict(saved), **({"closure_progress": service.goal_closure_progress()} if saved.kind == "CLOSURE" else {})}
        return invoke(save)

    @router.post("/api/user/teaching/proposals/{identity}/decision")
    def decide(identity: str, request: DecisionInput, service=dependency):
        def save():
            saved = service.decide_teaching(identity, **request.model_dump())
            return {**asdict(saved), **({"closure_progress": service.goal_closure_progress()} if getattr(saved, "kind", None) == "CLOSURE" else {})}
        return invoke(save)

    @router.get("/api/learning/teaching/assessments/{identity}")
    def read_assessment(identity: str, service=dependency):
        def read():
            source = next((a for a in service._answer_assessments if a.id == identity), None)
            if source is None:
                raise KeyError("Assessment not found")
            service._teaching_goal(source.goal_id)
            return {"original": asdict(source), "effective": asdict(service.effective_assessment(source)),
                    "corrections": [asdict(c) for c in service._teaching.corrections if c.assessment_id == identity]}
        return invoke(read)

    @router.post("/api/learning/teaching/corrections")
    def correction(request: CorrectionInput, service=dependency):
        return invoke(lambda: asdict(service.correct_assessment(AssessmentCorrection(**{
            **request.model_dump(), "criteria": tuple(AssessmentCriterion(**v) for v in request.criteria)}))))

    return router
