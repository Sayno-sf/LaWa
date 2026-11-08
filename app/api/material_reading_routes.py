"""本地阅读资源协议。只管理机器工作，不接入用户回答或Kernel学习命令。"""
from typing import Callable, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from app.application import LearningService
from app.materials import MaterialStore
from app.material_reading import MaterialReadingStore
from app.material_planning import MaterialPlanningStore
from app.material_deletions import MaterialDeletions


class ReadingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class EnqueueReading(ReadingRequest):
    role: Literal["basis", "supplementary"] = "supplementary"


class ClaimReading(ReadingRequest):
    reader_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,128}$")
    max_chars: int = Field(default=256_000, ge=1, le=4_000_000)
    max_tokens: int = Field(default=128_000, ge=1, le=1_000_000)
    max_pages: int = Field(default=32, ge=1, le=256)
    max_images: int = Field(default=3, ge=1, le=3)
    pdf_input: Literal["native_pdf", "page_images"] = "page_images"
    ttl: int = Field(default=90, ge=15, le=300)
    consolidate_notes: bool = False


class ReadingLease(ReadingRequest):
    lease_id: str = Field(pattern=r"^[0-9a-f]{32}$")


class RenewReading(ReadingLease):
    ttl: int = Field(default=90, ge=15, le=300)


class ReadingNote(ReadingRequest):
    summary: str = Field(min_length=1, max_length=24_000)
    concepts: list[str] = Field(default_factory=list, max_length=100)
    facts: list[str] = Field(default_factory=list, max_length=100)
    dependencies: list[str] = Field(default_factory=list, max_length=100)
    uncertainties: list[str] = Field(default_factory=list, max_length=100)


class ReadingModel(ReadingRequest):
    provider: str = Field(min_length=1, max_length=200)
    id: str = Field(min_length=1, max_length=200)


class CommitReading(ReadingLease):
    note: ReadingNote
    model: ReadingModel
    sufficient: bool | None = None
    reading_blockers: list[str] | None = Field(default=None, max_length=100)


class ReleaseReading(ReadingLease):
    failed: bool = False
    error_code: str | None = Field(default=None, pattern=r"^[A-Z][A-Z0-9_]{0,79}$")


class FailIdleReading(ReadingRequest):
    expected_revision: int = Field(ge=0)
    error_code: str = Field(pattern=r"^[A-Z][A-Z0-9_]{0,79}$")


class RegisterPlanningReading(ReadingRequest):
    request_id: str = Field(pattern=r"^[0-9a-f]{64}$")
    user_entry_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,128}$")
    goal_id: str = Field(pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    goal_profile_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    material_ids: list[str] = Field(max_length=100)
    primary_material_id: str | None = None


class PlanningReadingContext(ReadingRequest):
    max_tokens: int = Field(ge=1, le=1_000_000)


def create_material_reading_router(get_service: Callable, get_materials: Callable, resolve_scope: Callable) -> APIRouter:
    router = APIRouter()

    def reading_store(materials: MaterialStore = Depends(get_materials)) -> MaterialReadingStore:
        return MaterialReadingStore(materials)

    def current_scope(expected_goal_id: str | None = None, draft_session_id: str | None = None,
                      service: LearningService = Depends(get_service)) -> str:
        # 原件读取仍沿用当前Goal/草稿；后台切到旧Goal时暂停，不静默激活目标。
        return resolve_scope(service, expected_goal_id, draft_session_id)

    @router.get("/api/learning/retrieval/material-deletions")
    def material_deletions(offset: int = 0, limit: int = 100, materials: MaterialStore = Depends(get_materials)) -> dict:
        return MaterialDeletions(materials).events(offset, limit)

    @router.post("/api/learning/retrieval/material-deletions/{material_id}/retry")
    def retry_material_deletion(material_id: str, materials: MaterialStore = Depends(get_materials)) -> dict:
        return MaterialDeletions(materials).clean_original(material_id)

    @router.post("/api/learning/material-planning/{session_id}/requirements")
    def register_planning(session_id: str, request: RegisterPlanningReading, owner: str = Depends(current_scope),
                          materials: MaterialStore = Depends(get_materials)) -> dict:
        return MaterialPlanningStore(materials).register(owner, session_id, **request.model_dump())

    @router.get("/api/learning/material-planning/{session_id}/requirements/{request_id}")
    def planning_status(session_id: str, request_id: str, owner: str = Depends(current_scope),
                        materials: MaterialStore = Depends(get_materials)) -> dict:
        return MaterialPlanningStore(materials).status(owner, session_id, request_id)

    @router.post("/api/learning/material-planning/{session_id}/requirements/{request_id}/context")
    def planning_context(session_id: str, request_id: str, request: PlanningReadingContext,
                         owner: str = Depends(current_scope), materials: MaterialStore = Depends(get_materials)) -> dict:
        return MaterialPlanningStore(materials).context(owner, session_id, request_id, request.max_tokens)

    @router.get("/api/learning/material-reading/jobs")
    def pending(offset: int = 0, limit: int = 100, service: LearningService = Depends(get_service),
                store: MaterialReadingStore = Depends(reading_store)) -> dict:
        snapshot = service.snapshot()
        goals = {project.goal_profile.id for project in snapshot.learning_history}
        if snapshot.goal_profile:
            goals.add(snapshot.goal_profile.id)
        return store.pending(goals, offset, limit)

    @router.post("/api/learning/materials/{material_id}/reading")
    def enqueue(material_id: str, request: EnqueueReading, owner: str = Depends(current_scope),
                store: MaterialReadingStore = Depends(reading_store)) -> dict:
        return store.enqueue(material_id, owner, request.role)

    @router.get("/api/learning/materials/{material_id}/reading")
    def get(material_id: str, owner: str = Depends(current_scope), store: MaterialReadingStore = Depends(reading_store)) -> dict:
        return store.get(material_id, owner)

    @router.post("/api/learning/materials/{material_id}/reading/claim")
    def claim(material_id: str, request: ClaimReading, owner: str = Depends(current_scope),
              store: MaterialReadingStore = Depends(reading_store)) -> dict:
        return store.claim(material_id, owner, **request.model_dump())

    @router.post("/api/learning/materials/{material_id}/reading/renew")
    def renew(material_id: str, request: RenewReading, owner: str = Depends(current_scope),
              store: MaterialReadingStore = Depends(reading_store)) -> dict:
        return store.renew(material_id, owner, request.lease_id, request.ttl)

    @router.post("/api/learning/materials/{material_id}/reading/commit")
    def commit(material_id: str, request: CommitReading, owner: str = Depends(current_scope),
               store: MaterialReadingStore = Depends(reading_store)) -> dict:
        return store.commit(material_id, owner, request.lease_id, request.note.model_dump(), request.model.model_dump(), request.sufficient, request.reading_blockers)

    @router.post("/api/learning/materials/{material_id}/reading/release")
    def release(material_id: str, request: ReleaseReading, owner: str = Depends(current_scope),
                store: MaterialReadingStore = Depends(reading_store)) -> dict:
        return store.release(material_id, owner, request.lease_id, failed=request.failed, error_code=request.error_code)

    @router.post("/api/learning/materials/{material_id}/reading/cancel")
    def cancel(material_id: str, owner: str = Depends(current_scope), store: MaterialReadingStore = Depends(reading_store)) -> dict:
        return store.cancel(material_id, owner)

    @router.post("/api/learning/materials/{material_id}/reading/fail-idle")
    def fail_idle(material_id: str, request: FailIdleReading, owner: str = Depends(current_scope),
                  store: MaterialReadingStore = Depends(reading_store)) -> dict:
        return store.fail_idle(material_id, owner, request.expected_revision, request.error_code)

    return router
