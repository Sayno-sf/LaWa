"""用户资料命令与本机后台协议分离；Gateway不转发任何后台提交接口。"""
import os
from pathlib import Path
from secrets import compare_digest
from typing import Callable
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from app.domain.growth import POLICY_VERSION
from app.growth_protocol import LearningImport


class GrowthRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class SupplementRequest(GrowthRequest):
    text: str = Field(min_length=1, max_length=16000)


class ImportPreviewRequest(GrowthRequest):
    payload: dict


class ImportCommitRequest(ImportPreviewRequest):
    preview_hash: str = Field(pattern="^[0-9a-f]{64}$")
    selected_refs: list[str] = Field(min_length=1, max_length=20)
    merge_targets: dict[str, str] = Field(default_factory=dict)
    group_title: str | None = Field(default=None, min_length=1, max_length=200)


class GroupImportRequest(GrowthRequest):
    preview_hash: str = Field(pattern="^[0-9a-f]{64}$")
    title: str = Field(min_length=1, max_length=200)


class TopicAssignmentRequest(GrowthRequest):
    skill_ids: list[str] = Field(min_length=1, max_length=200)
    target_kind: str = Field(pattern="^(topic|milestone)$")
    target: str = Field(min_length=1, max_length=200)
    expected_revision: str = Field(pattern="^[0-9a-f]{64}$")


class ClassificationRequest(GrowthRequest):
    weights: dict[str, int]


class RetryRequest(GrowthRequest):
    key: str | None = Field(default=None, max_length=300)


class ClaimRequest(GrowthRequest):
    model_id: str = Field(min_length=1, max_length=300)
    policy_version: str = POLICY_VERSION


class LeaseRequest(GrowthRequest):
    key: str = Field(min_length=1, max_length=300)
    lease: str = Field(pattern="^[0-9a-f]{32}$")


class CompleteRequest(LeaseRequest):
    result: dict


class CheckpointRequest(LeaseRequest):
    summary: dict


class ReleaseRequest(LeaseRequest):
    failed: bool = False
    error_code: str | None = Field(default=None, max_length=100)


def growth_router(get_service: Callable):
    router = APIRouter()

    def invoke(method, *args, **kwargs):
        try:
            return method(*args, **kwargs)
        except KeyError as error:
            raise HTTPException(404, str(error)) from error
        except ValueError as error:
            raise HTTPException(409 if "过期" in str(error) or "变化" in str(error) else 422, str(error)) from error

    def worker(request: Request):
        configured = os.environ.get("GROWTH_WORKER_TOKEN")
        token_ok = configured and compare_digest(request.headers.get("x-lawa-growth-token", ""), configured)
        local = request.client and request.client.host in ("127.0.0.1", "::1")
        if request.headers.get("origin") or request.headers.get("x-lawa-worker") != "growth-v1" or not (token_ok if configured else local):
            raise HTTPException(403, "后台协议只供同实例工作进程使用")

    @router.get("/api/learning/growth")
    def atlas(service=Depends(get_service)):
        return service.growth_atlas()

    @router.post("/api/user/growth/recommendations/{identity}/adopt")
    def adopt(identity: str, service=Depends(get_service)):
        return invoke(service.growth_adopt_recommendation, identity)

    @router.get("/api/learning/growth/sources/{source_id}")
    def source(source_id: str, service=Depends(get_service)):
        return invoke(service.growth_source, source_id)

    @router.get("/api/learning/growth/goals/{goal_id}")
    def goal_context(goal_id: str, service=Depends(get_service)):
        return invoke(service.growth_goal_context, goal_id)

    @router.get("/api/learning/growth/import-schema")
    def schema():
        return LearningImport.model_json_schema()

    @router.get("/api/learning/growth/current-context")
    def current_context(offset: int = 0, limit: int = 5, skill_id: str | None = None, service=Depends(get_service)):
        return invoke(service.growth_learning_context, offset, limit, skill_id)

    @router.get("/api/learning/growth/export-prompt")
    def export_prompt():
        return {"text": (Path(__file__).resolve().parents[2] / "resources/growth/export-prompt.md").read_text(encoding="utf-8")}

    @router.post("/api/user/growth/supplements")
    def supplement(body: SupplementRequest, service=Depends(get_service)):
        return invoke(service.growth_supplement, body.text)

    @router.patch("/api/user/growth/supplements/{identity}")
    def edit_supplement(identity: str, body: SupplementRequest, service=Depends(get_service)):
        return invoke(service.growth_supplement, body.text, identity)

    @router.delete("/api/user/growth/supplements/{identity}")
    def withdraw_supplement(identity: str, service=Depends(get_service)):
        return invoke(service.growth_withdraw_supplement, identity)

    @router.put("/api/user/growth/classifications/{goal_id}")
    def classify(goal_id: str, body: ClassificationRequest, service=Depends(get_service)):
        return invoke(service.growth_set_classification, goal_id, body.weights)

    @router.post("/api/user/growth/imports/preview")
    def preview(body: ImportPreviewRequest, service=Depends(get_service)):
        return invoke(service.growth_preview_import, body.payload)

    @router.post("/api/user/growth/imports/commit")
    def commit(body: ImportCommitRequest, service=Depends(get_service)):
        return invoke(service.growth_commit_import, **body.model_dump())

    @router.post("/api/user/growth/imports/{identity}/withdraw")
    def withdraw(identity: str, service=Depends(get_service)):
        return invoke(service.growth_withdraw_import, identity)

    @router.get("/api/learning/growth/imports/{identity}/group-preview")
    def group_preview(identity: str, service=Depends(get_service)):
        return invoke(service.growth_group_preview, identity)

    @router.post("/api/user/growth/imports/{identity}/group")
    def group_import(identity: str, body: GroupImportRequest, service=Depends(get_service)):
        return invoke(service.growth_group_import, identity, **body.model_dump())

    @router.post("/api/user/growth/retry")
    def retry(body: RetryRequest, service=Depends(get_service)):
        return invoke(service.growth_retry, body.key)

    @router.put("/api/user/growth/goals/{identity}/topic-assignment")
    def assign_topic(identity: str, body: TopicAssignmentRequest, service=Depends(get_service)):
        return invoke(service.growth_assign_topic, identity, **body.model_dump())

    @router.post("/api/internal/growth/claim", dependencies=[Depends(worker)])
    def claim(body: ClaimRequest, service=Depends(get_service)):
        return {"job": invoke(service.growth_claim, **body.model_dump())}

    @router.post("/api/internal/growth/complete", dependencies=[Depends(worker)])
    def complete(body: CompleteRequest, service=Depends(get_service)):
        return invoke(service.growth_complete, **body.model_dump())

    @router.post("/api/internal/growth/checkpoint", dependencies=[Depends(worker)])
    def checkpoint(body: CheckpointRequest, service=Depends(get_service)):
        return invoke(service.growth_checkpoint, **body.model_dump())

    @router.post("/api/internal/growth/renew", dependencies=[Depends(worker)])
    def renew(body: LeaseRequest, service=Depends(get_service)):
        return invoke(service.growth_renew, **body.model_dump())

    @router.post("/api/internal/growth/release", dependencies=[Depends(worker)])
    def release(body: ReleaseRequest, service=Depends(get_service)):
        return invoke(service.growth_release, **body.model_dump())

    return router
