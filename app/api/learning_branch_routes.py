"""Curriculum branch proposals and user-only lifecycle commands."""
from dataclasses import asdict
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from app.domain.learning_branch import LearningBranch


class BranchProposal(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(min_length=1, max_length=120)
    goal_id: str
    anchor_kind: Literal["skill", "milestone"]
    anchor_id: str
    purpose: Literal["prerequisite", "extension"]
    title: str = Field(min_length=1, max_length=200)
    reason: str = Field(min_length=1, max_length=1600)
    scope: str = Field(min_length=1, max_length=1600)
    return_condition: str = Field(min_length=1, max_length=1600)
    source_ids: list[str] = Field(default_factory=list, max_length=30)
    source_goal_ids: list[str] = Field(default_factory=list, max_length=6)
    skill_ids: list[str] = Field(default_factory=list, max_length=12)
    expected_plan_revision: int = Field(ge=0)


class BranchTransition(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    action: Literal["accept", "enter", "return", "complete"]
    operation_id: str = Field(min_length=8, max_length=100)
    expected_revision: int = Field(ge=0)
    expected_goal_id: str
    expected_task_id: str | None
    expected_task_revision: int = Field(default=0, ge=0)
    handoff: str = Field(default="", max_length=6000)
    assistance_provided: bool = False


def create_learning_branch_router(get_service):
    router = APIRouter()

    @router.get("/api/learning/branches/{branch_id}/context")
    def context(branch_id: str, service=Depends(get_service)):
        try:
            return service.learning_branch_context(branch_id)
        except (ValueError, KeyError) as error:
            raise HTTPException(409, str(error)) from error

    @router.post("/api/learning/branches/propose")
    def propose(body: BranchProposal, service=Depends(get_service)):
        try:
            values = body.model_dump()
            revision = values.pop("expected_plan_revision")
            return asdict(service.propose_learning_branch(LearningBranch(**values), revision))
        except (ValueError, KeyError) as error:
            raise HTTPException(409, str(error)) from error

    @router.post("/api/user/learning-branches/{branch_id}/transition")
    def transition(branch_id: str, body: BranchTransition, service=Depends(get_service)):
        try:
            return asdict(service.transition_learning_branch_by_user(branch_id, **body.model_dump()))
        except (ValueError, KeyError) as error:
            raise HTTPException(409, str(error)) from error

    return router
