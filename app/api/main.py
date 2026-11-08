"""HTTP adapter for the writable learning loop and local user actions."""

import logging
import asyncio
import re
import os
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Annotated
from pydantic import BaseModel, Field, model_validator
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse, Response

from app.application import LearningService
from app.bootstrap import build_learning_service
from app.persistence import JsonLearningStateStore
from app.domain.answer_assessment import AnswerAssessment, AssessmentCriterion, assessment_topic_id
from app.materials import MaterialError, MaterialStore, MAX_FILE_BYTES
from app.api.material_reading_routes import create_material_reading_router
from app.material_planning import MaterialPlanningStore
from app.retrieval_sources import RetrievalSources
from app.domain import (
    CardFeedbackStatus,
    CurriculumMilestone,
    Evidence,
    FrontierPlan,
    GoalProfile,
    KnowledgeCard,
    LearningPlan,
    LearningTask,
    SkillNode,
)

from .schemas import (
    AnswerAssessmentResponse,
    RecordAnswerAssessmentRequest,
    ApplyFrontierPlanRequest,
    CreateKnowledgeCardRequest,
    CreateLearningTaskRequest,
    DecidePlanRevisionRequest,
    FrontierPlanSchema,
    InitializeCurriculumRequest,
    KnowledgeCardResponse,
    LearningLibraryResponse,
    LearningPlanResponse,
    LearningPlanRevisionResponse,
    EvidenceResponse,
    LearningOverviewResponse,
    PreparePlanRevisionRequest,
    SetCardFeedbackRequest,
    SetCardNoteRequest,
    SetTeachingActivityRequest,
    UpdateKnowledgeCardRequest,
    SkillResponse,
    SubmitEvidenceRequest,
    TaskResponse,
)


logger = logging.getLogger("learning_api")
app = FastAPI(title="Learn Anything With Agent API", version="local-learning-ledger-v1")
_mutation_lock = asyncio.Lock()


@app.middleware("http")
async def serialize_learning_mutations(request: Request, call_next):
    # 同一进程中的人类回收、Agent 写入和视觉发布不能交错，防止回收后最后一笔迟到写入。
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        async with _mutation_lock:
            return await call_next(request)
    return await call_next(request)


@app.exception_handler(OSError)
async def _storage_os_error_handler(_request: Request, exc: OSError):
    # 磁盘满/文件占用等存储故障是"可重试的临时不可用"：返回 503 而非裸 500，
    # 让调用方按状态码区分"结果未知、应核验后重试"与"请求本身非法"。
    return JSONResponse(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        content={"detail": f"Storage temporarily unavailable: {exc}"},
    )


def _build_application_service() -> LearningService:
    bootstrap_mode = os.environ.get("LEARNING_BOOTSTRAP")
    configured_path = os.environ.get("LEARNING_STATE_PATH")
    if configured_path == ":memory:":
        return build_learning_service(bootstrap_mode)

    project_root = Path(__file__).resolve().parents[2]
    state_path = Path(configured_path) if configured_path else project_root / "data" / "learning-state.json"
    store = JsonLearningStateStore(state_path)
    # 默认产品现在从本地账本恢复。只有首次没有账本时才使用 bootstrap/空白入口；
    # 后续每次成功写入都会自动原子保存，API 重启不再清空学习进度。
    return store.load_or_create(lambda: build_learning_service(bootstrap_mode))


_learning_service = _build_application_service()
_material_store = MaterialStore(Path(os.environ.get("LEARNING_MATERIALS_DIR") or Path(__file__).resolve().parents[2] / "data" / "materials"),
                                parse_timeout_seconds=float(os.environ.get("LEARNING_MATERIAL_PARSE_TIMEOUT_SECONDS","120")),
                                scope_is_available=_learning_service.scope_is_available)


def get_learning_service() -> LearningService:
    return _learning_service


from .teaching_evolution import teaching_router
app.include_router(teaching_router(get_learning_service))
from .growth_routes import growth_router
app.include_router(growth_router(get_learning_service))
from app.api.learning_branch_routes import create_learning_branch_router
app.include_router(create_learning_branch_router(get_learning_service))


@app.post("/api/learning/answer-assessments", response_model=AnswerAssessmentResponse)
def record_answer_assessment(request: RecordAnswerAssessmentRequest,
                             service: Annotated[LearningService, Depends(get_learning_service)]) -> AnswerAssessmentResponse:
    try:
        topic = next((a for a in reversed(service.snapshot().answer_assessments)
                      if a.topic_id == request.topic_id and a.goal_id == request.goal_id), None) if request.topic_id else None
        if request.topic_id and topic is None:
            raise KeyError("Review topic is unavailable in this Goal")
        values = request.model_dump(exclude={"topic_id", "criteria", "topic_aliases"})
        if topic:
            values.update(skill_id=topic.skill_id)
        assessment = AnswerAssessment(**values,
            topic_id=topic.topic_id if topic else assessment_topic_id(request.goal_id, request.skill_id, request.topic),
            criteria=tuple(AssessmentCriterion(**c.model_dump()) for c in request.criteria))
        return AnswerAssessmentResponse.model_validate(service.record_answer_assessment(assessment, topic_aliases=request.topic_aliases))
    except KeyError as error:
        raise HTTPException(404, str(error)) from error
    except ValueError as error:
        raise HTTPException(409, str(error)) from error


@app.get("/api/learning/answer-assessments")
def list_answer_assessments(goal_id: str, service: Annotated[LearningService, Depends(get_learning_service)],
                            skill_id: str | None = None, offset: int = 0, limit: int = 20):
    try:
        records = service.list_answer_assessments(goal_id, skill_id=skill_id, offset=offset, limit=limit)
        return {"assessments": [AnswerAssessmentResponse.model_validate(a) for a in records],
                "next_offset": offset + limit if len(records) == limit else None}
    except KeyError as error:
        raise HTTPException(404, str(error)) from error
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


@app.get("/api/learning/answer-assessments/topics/{topic_id}")
def get_practice_topic(topic_id: str, goal_id: str, service: Annotated[LearningService, Depends(get_learning_service)]):
    overview = service.get_learning_overview()
    if not overview.goal_profile or overview.goal_profile.id != goal_id:
        raise HTTPException(404, "Review topic is outside the current Goal")
    topic = next((a for a in reversed(service.snapshot().answer_assessments) if a.topic_id == topic_id and a.goal_id == goal_id), None)
    if not topic:
        raise HTTPException(404, "Review topic is unavailable")
    return {"topic_id": topic.topic_id, "topic": topic.topic, "skill_id": topic.skill_id, "goal_id": goal_id}


@app.get("/api/learning/answer-assessments/{assessment_id}", response_model=AnswerAssessmentResponse)
def get_answer_assessment(assessment_id: str, goal_id: str,
                          service: Annotated[LearningService, Depends(get_learning_service)]):
    try:
        return AnswerAssessmentResponse.model_validate(service.get_answer_assessment(goal_id, assessment_id))
    except KeyError as error:
        raise HTTPException(404, str(error)) from error


def get_material_store(service: LearningService = Depends(get_learning_service)) -> MaterialStore:
    _material_store.scope_is_available = service.scope_is_available
    return _material_store


@app.exception_handler(MaterialError)
async def _material_error_handler(_request: Request, exc: MaterialError):
    return JSONResponse(status_code=exc.status, content={"detail": str(exc), "code": exc.code})


def _current_goal_id(service: LearningService, expected_goal_id: str | None = None) -> str:
    profile = service.get_learning_overview().goal_profile
    if profile is None:
        raise HTTPException(status_code=409, detail="Create or enter a Goal before using materials")
    if expected_goal_id is not None and profile.id != expected_goal_id:
        raise HTTPException(status_code=409, detail="当前目标已切换，请刷新资料列表后重试。")
    return profile.id


def _material_scope(service: LearningService, expected_goal_id: str | None,
                    draft_session_id: str | None) -> str:
    if draft_session_id is not None:
        if expected_goal_id is not None:
            raise HTTPException(status_code=422, detail="Choose either a Goal or a material draft")
        return MaterialStore.draft_scope(draft_session_id)
    return _current_goal_id(service, expected_goal_id)


app.include_router(create_material_reading_router(get_learning_service, get_material_store, _material_scope))


@app.get("/api/learning/skills/{skill_id}/context")
def get_skill_learning_context(skill_id: str, limit: int = 5,
                               service: LearningService = Depends(get_learning_service)) -> dict:
    try:
        return service.get_skill_learning_context(skill_id, limit)
    except KeyError as exc:
        raise _not_found(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/api/user/materials", status_code=201)
async def upload_learning_material(request: Request, filename: str, expected_goal_id: str | None = None,
                                   draft_session_id: str | None = None,
                                   purpose: str = "learning_material", conversation_id: str | None = None,
                                   service: LearningService = Depends(get_learning_service),
                                   materials: MaterialStore = Depends(get_material_store)) -> dict:
    if expected_goal_id is None and draft_session_id is None:
        raise HTTPException(status_code=422, detail="An explicit Goal or draft is required for upload")
    goal_id = _material_scope(service, expected_goal_id, draft_session_id)
    # Gateway 也限流，但 API 是独立边界：按实际收到的字节数拒绝超限上传。
    declared_length = request.headers.get("content-length")
    if declared_length:
        try:
            if int(declared_length) > MAX_FILE_BYTES:
                raise MaterialError("FILE_TOO_LARGE", "File exceeds 100 MiB", 413)
        except ValueError as exc:
            raise MaterialError("INVALID_UPLOAD", "Invalid Content-Length", 400) from exc
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".incoming-", dir=materials.root, delete=False) as output:
            temporary = Path(output.name)
            size = 0
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_FILE_BYTES:
                    raise MaterialError("FILE_TOO_LARGE", "File exceeds 100 MiB", 413)
                output.write(chunk)
        _material_scope(service, expected_goal_id, draft_session_id)
        # 大文件和 Office 解析先持久化原件/任务再返回；小文本无需模型可立即就绪。
        background = size > 256 * 1024 or Path(filename).suffix.lower() in (".pdf", ".docx", ".pptx")
        return materials.create(temporary, filename, goal_id, background=background,
                                purpose=purpose, conversation_id=conversation_id)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


@app.get("/api/learning/materials")
def list_learning_materials(limit: int = 20, offset: int = 0, expected_goal_id: str | None = None,
                            draft_session_id: str | None = None,
                            include_attachments: bool = False, conversation_id: str | None = None,
                            service: LearningService = Depends(get_learning_service),
                            materials: MaterialStore = Depends(get_material_store)) -> dict:
    return materials.list(_material_scope(service, expected_goal_id, draft_session_id), limit, offset,
                          include_attachments=include_attachments, conversation_id=conversation_id)


class MaterialPurposeRequest(BaseModel):
    purpose: str
    expected_revision: int
    conversation_id: str | None = None


@app.patch("/api/user/materials/{material_id}/purpose")
def update_material_purpose(material_id: str, request: MaterialPurposeRequest,
                            expected_goal_id: str | None = None, draft_session_id: str | None = None,
                            service: LearningService = Depends(get_learning_service),
                            materials: MaterialStore = Depends(get_material_store)) -> dict:
    return materials.set_purpose(material_id, _material_scope(service, expected_goal_id, draft_session_id),
                                 request.purpose, request.expected_revision, request.conversation_id)


@app.get("/api/learning/retrieval/catalog")
def retrieval_catalog(offset: int = 0, limit: int = 100,
                      service: LearningService = Depends(get_learning_service),
                      materials: MaterialStore = Depends(get_material_store)) -> dict:
    return RetrievalSources(service, materials).catalog(offset, limit)


@app.get("/api/learning/retrieval/chunks")
def retrieval_chunks(source_id: str, offset: int = 0, limit: int = 50,
                     service: LearningService = Depends(get_learning_service),
                     materials: MaterialStore = Depends(get_material_store)) -> dict:
    return RetrievalSources(service, materials).chunks(source_id, offset, limit)


@app.get("/api/learning/retrieval/context")
def retrieval_context(query: str, scope: str = "current", expected_goal_id: str | None = None,
                      draft_session_id: str | None = None,
                      service: LearningService = Depends(get_learning_service),
                      materials: MaterialStore = Depends(get_material_store)) -> dict:
    return RetrievalSources(service, materials).context(_material_scope(service, expected_goal_id, draft_session_id), scope, query)


class ValidateSourceRefs(BaseModel):
    refs: list[str]


class FullSourceIdentity(BaseModel):
    source_id: str
    version: str
    scope: str = "current"
    current_scope: str


class FullSourceRequest(BaseModel):
    max_tokens: int
    available_tokens: int
    known_sources: list[FullSourceIdentity] = []
    kinds: list[str] | None = None
    material_id: str | None = None


class ValidateFullSources(BaseModel):
    sources: list[FullSourceIdentity]


@app.post("/api/learning/retrieval/full-context")
def read_full_sources(request: FullSourceRequest, scope: str = "current",
                      expected_goal_id: str | None = None, draft_session_id: str | None = None,
                      service: LearningService = Depends(get_learning_service),
                      materials: MaterialStore = Depends(get_material_store)) -> dict:
    """runtime固定当前Goal/草稿；全文只读，不扩大原检索权限或写学习事实。"""
    return RetrievalSources(service, materials).full_context(
        _material_scope(service, expected_goal_id, draft_session_id), scope,
        request.max_tokens, request.available_tokens, [r.model_dump() for r in request.known_sources],
        request.material_id, request.kinds)


@app.post("/api/learning/retrieval/full-context/validate")
def validate_full_sources(request: ValidateFullSources,
                          expected_goal_id: str | None = None, draft_session_id: str | None = None,
                          service: LearningService = Depends(get_learning_service),
                          materials: MaterialStore = Depends(get_material_store)) -> dict:
    """模型请求前校验已读身份，原件和版本验证失败时不继续提供旧正文。"""
    return RetrievalSources(service, materials).validate_full_context(
        [r.model_dump() for r in request.sources], _material_scope(service, expected_goal_id, draft_session_id))


# 仅本地派生索引服务使用，不注册为教师工具，也不修改任何学习事实。
@app.get("/api/learning/retrieval/visual-plan")
def retrieval_visual_plan(material_id: str, fingerprint: str,
                          materials: MaterialStore = Depends(get_material_store)) -> dict:
    return materials.visual_plan(material_id, fingerprint)


@app.get("/api/learning/retrieval/visual-asset")
def retrieval_visual_asset(material_id: str, asset_id: str,
                           materials: MaterialStore = Depends(get_material_store)) -> dict:
    return materials.visual_asset(material_id, asset_id)


class VisualResult(BaseModel):
    material_id: str
    source_hash: str
    parser_version: str
    fingerprint: str
    asset_id: str
    analysis: dict


@app.post("/api/learning/retrieval/visual-result")
def retrieval_visual_result(request: VisualResult, materials: MaterialStore = Depends(get_material_store)) -> dict:
    return materials.publish_visual(**request.model_dump())


@app.get("/api/learning/materials/{material_id}/visual/{asset_id}")
def material_visual_original(material_id: str, asset_id: str, expected_goal_id: str | None = None,
                             draft_session_id: str | None = None,
                             service: LearningService = Depends(get_learning_service),
                             materials: MaterialStore = Depends(get_material_store)) -> Response:
    import base64
    value = materials.visual_asset(material_id, asset_id, _material_scope(service, expected_goal_id, draft_session_id))
    return Response(base64.b64decode(value["data"]), media_type=value["mime"], headers={"Cache-Control": "private, no-store"})


@app.post("/api/learning/retrieval/validate")
def validate_source_refs(request: ValidateSourceRefs, scope: str = "current",
                         expected_goal_id: str | None = None, draft_session_id: str | None = None,
                         service: LearningService = Depends(get_learning_service),
                         materials: MaterialStore = Depends(get_material_store)) -> dict:
    if len(request.refs) > 100:
        raise HTTPException(status_code=422, detail="At most 100 references")
    return RetrievalSources(service, materials).validate(request.refs, _material_scope(service, expected_goal_id, draft_session_id), scope)


@app.get("/api/learning/retrieval/read")
def read_retrieval_source(source_ref: str, scope: str = "current", max_chars: int = 4000,
                          cursor: str | None = None, before: int = 0, after: int = 0,
                          expected_goal_id: str | None = None, draft_session_id: str | None = None,
                          service: LearningService = Depends(get_learning_service),
                          materials: MaterialStore = Depends(get_material_store)) -> dict:
    return RetrievalSources(service, materials).read(source_ref, _material_scope(service, expected_goal_id, draft_session_id),
                                                   scope, max_chars, cursor, before, after)


@app.post("/api/user/materials/{material_id}/retry")
def retry_material_parse(material_id: str, expected_goal_id: str | None = None,
                         draft_session_id: str | None = None,
                         service: LearningService = Depends(get_learning_service),
                         materials: MaterialStore = Depends(get_material_store)) -> dict:
    return materials.retry(material_id, _material_scope(service, expected_goal_id, draft_session_id))


@app.get("/api/learning/materials/search")
def search_goal_materials(query: str, limit: int = 5, expected_goal_id: str | None = None,
                          draft_session_id: str | None = None,
                          service: LearningService = Depends(get_learning_service),
                          materials: MaterialStore = Depends(get_material_store)) -> dict:
    # 静态路由先注册，避免 search 被当成 material_id；作用域来自运行时前台 Goal/草稿。
    return materials.search(None, _material_scope(service, expected_goal_id, draft_session_id), query, limit)


def _conversation_attachment_scope(material_id: str, reference_session_id: str, reference_goal_id: str | None,
                                   service: LearningService, materials: MaterialStore) -> str:
    # Gateway先核实实际Pi用户entry；此处再核实本账号仍有的来源，不能用历史附件激活Goal。
    snapshot = service.snapshot()
    goals = {project.goal_profile.id for project in snapshot.learning_history}
    if snapshot.goal_profile:
        goals.add(snapshot.goal_profile.id)
    return materials.conversation_reference_scope(material_id, reference_session_id, reference_goal_id, goals)


@app.get("/api/learning/conversation-attachments/{material_id}/metadata")
def conversation_attachment_metadata(material_id: str, reference_session_id: str, reference_goal_id: str | None = None,
                                     service: LearningService = Depends(get_learning_service),
                                     materials: MaterialStore = Depends(get_material_store)) -> dict:
    owner = _conversation_attachment_scope(material_id, reference_session_id, reference_goal_id, service, materials)
    result = materials.metadata(material_id, owner)
    if result["format"] == "pdf":
        result["unit_count"] = materials.visual_manifest(material_id, owner, limit=1)["unit_count"]
    return result


@app.get("/api/learning/conversation-attachments/{material_id}/visual/{asset_id}")
def conversation_attachment_visual(material_id: str, asset_id: str, reference_session_id: str,
                                   reference_goal_id: str | None = None,
                                   service: LearningService = Depends(get_learning_service),
                                   materials: MaterialStore = Depends(get_material_store)) -> Response:
    owner = _conversation_attachment_scope(material_id, reference_session_id, reference_goal_id, service, materials)
    packet = materials.visual_asset(material_id, asset_id, owner)
    import base64
    return Response(base64.b64decode(packet["data"]), media_type="image/jpeg",
                    headers={"Cache-Control": "private, no-store"})


@app.get("/api/learning/conversation-attachments/{material_id}/visuals")
def conversation_attachment_visuals(material_id: str, reference_session_id: str, reference_goal_id: str | None = None,
                                    offset: int = 0, limit: int = 20,
                                    service: LearningService = Depends(get_learning_service),
                                    materials: MaterialStore = Depends(get_material_store)) -> dict:
    owner = _conversation_attachment_scope(material_id, reference_session_id, reference_goal_id, service, materials)
    return materials.visual_manifest(material_id, owner, offset, limit)


@app.get("/api/learning/conversation-attachments/{material_id}")
def conversation_attachment_preview(material_id: str, reference_session_id: str, reference_goal_id: str | None = None,
                                    start: int = 1, max_chars: int = 3000,
                                    service: LearningService = Depends(get_learning_service),
                                    materials: MaterialStore = Depends(get_material_store)) -> dict:
    owner = _conversation_attachment_scope(material_id, reference_session_id, reference_goal_id, service, materials)
    return materials.preview(material_id, owner, start=start, max_chars=max_chars)


@app.delete("/api/user/conversation-attachments/{material_id}", status_code=204)
def delete_conversation_attachment(material_id: str, reference_session_id: str, reference_goal_id: str | None = None,
                                    service: LearningService = Depends(get_learning_service),
                                    materials: MaterialStore = Depends(get_material_store)) -> None:
    owner = _conversation_attachment_scope(material_id, reference_session_id, reference_goal_id, service, materials)
    materials.delete(material_id, owner)


@app.get("/api/learning/materials/{material_id}/visuals")
def learning_visual_manifest(material_id: str, offset: int = 0, limit: int = 20,
                             expected_goal_id: str | None = None, draft_session_id: str | None = None,
                             service: LearningService = Depends(get_learning_service),
                             materials: MaterialStore = Depends(get_material_store)) -> dict:
    return materials.visual_manifest(material_id, _material_scope(service, expected_goal_id, draft_session_id), offset, limit)


@app.get("/api/learning/materials/{material_id}/visual-packet/{asset_id}")
def learning_visual_packet(material_id: str, asset_id: str,
                           expected_goal_id: str | None = None, draft_session_id: str | None = None,
                           service: LearningService = Depends(get_learning_service),
                           materials: MaterialStore = Depends(get_material_store)) -> dict:
    return materials.visual_asset(material_id, asset_id, _material_scope(service, expected_goal_id, draft_session_id))


@app.get("/api/learning/materials/{material_id}/document-batch")
def learning_document_batch(material_id: str, start: int = 1, end: int | None = None,
                            expected_goal_id: str | None = None, draft_session_id: str | None = None,
                            service: LearningService = Depends(get_learning_service),
                            materials: MaterialStore = Depends(get_material_store)) -> dict:
    return materials.document_batch(material_id, _material_scope(service, expected_goal_id, draft_session_id), start, end)


@app.get("/api/learning/materials/{material_id}/metadata")
def learning_material_metadata(material_id: str, expected_goal_id: str | None = None,
                               draft_session_id: str | None = None,
                               service: LearningService = Depends(get_learning_service),
                               materials: MaterialStore = Depends(get_material_store)) -> dict:
    return materials.metadata(material_id, _material_scope(service, expected_goal_id, draft_session_id))


@app.get("/api/learning/materials/{material_id}")
def read_learning_material(material_id: str, start: int = 1, end: int | None = None,
                           max_chars: int = 4000, cursor: str | None = None,
                           chunk_id: str | None = None, before: int = 0, after: int = 0, preview: bool = False,
                           expected_goal_id: str | None = None,
                           draft_session_id: str | None = None,
                           service: LearningService = Depends(get_learning_service),
                           materials: MaterialStore = Depends(get_material_store)) -> dict:
    options = dict(start=start, end=end, max_chars=max_chars, cursor=cursor, chunk_id=chunk_id, before=before, after=after)
    read = materials.preview if preview else materials.read
    return read(material_id, _material_scope(service, expected_goal_id, draft_session_id), **options)


@app.get("/api/learning/materials/{material_id}/search")
def search_learning_material(material_id: str, query: str, limit: int = 5,
                             expected_goal_id: str | None = None,
                             draft_session_id: str | None = None,
                             service: LearningService = Depends(get_learning_service),
                             materials: MaterialStore = Depends(get_material_store)) -> dict:
    return materials.search(material_id, _material_scope(service, expected_goal_id, draft_session_id), query, limit)


@app.delete("/api/user/materials/{material_id}", status_code=204)
def delete_learning_material(material_id: str,
                             expected_goal_id: str | None = None,
                             draft_session_id: str | None = None,
                             service: LearningService = Depends(get_learning_service),
                             materials: MaterialStore = Depends(get_material_store)) -> None:
    materials.delete(material_id, _material_scope(service, expected_goal_id, draft_session_id))


@app.get("/api/learning/overview", response_model=LearningOverviewResponse)
def get_learning_overview(
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> LearningOverviewResponse:
    logger.info("learning_overview_requested")
    overview = service.get_learning_overview()
    response = LearningOverviewResponse.from_application(overview)
    response.imported_goal_needs_route = bool(overview.goal_profile and service.growth_needs_route(overview.goal_profile.id))
    response.imported_learning = service.growth_learning_summary(overview.goal_profile.id if overview.goal_profile else None)
    if response.imported_learning:
        context = service.growth_goal_context(overview.goal_profile.id)
        response.imported_topics = {"goal_id": overview.goal_profile.id, "groups": context["topics"]}
    return response


@app.get("/api/learning/library", response_model=LearningLibraryResponse)
def get_learning_library(
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> LearningLibraryResponse:
    logger.info("learning_library_requested")
    return LearningLibraryResponse.from_application(service.get_learning_library())


class StartReviewRequest(BaseModel):
    operation_id: str


@app.get("/api/user/recycle")
def list_recycled_goals(service: LearningService = Depends(get_learning_service)) -> dict:
    snapshot = service.snapshot()
    return {"goals": [{"goal_id": p.project.goal_profile.id,
                       "name": p.project.goal_profile.goal_description,
                       "deleted_at": p.deleted_at.isoformat(),
                       "purge_started": p.purge_started,
                       "skill_count": len(p.project.skill_ids),
                       "evidence_count": sum(e.skill_id in p.project.skill_ids for e in snapshot.evidence)}
                      for p in reversed(snapshot.recycled_projects)],
            "drafts": list(snapshot.recycled_drafts)}


@app.delete("/api/user/goals/{goal_id}")
def recycle_goal_by_user(goal_id: str, service: LearningService = Depends(get_learning_service)) -> dict:
    try:
        service.recycle_goal_by_user(goal_id)
        return {"goal_id": goal_id}
    except KeyError as error:
        raise _not_found(error) from error


@app.post("/api/user/recycle/goals/{goal_id}/restore")
def restore_recycled_goal(goal_id: str, service: LearningService = Depends(get_learning_service),
                          materials: MaterialStore = Depends(get_material_store)) -> dict:
    try:
        service.restore_goal_by_user(goal_id)
        materials.scope_is_available = service.scope_is_available
        materials.resume_scope(goal_id)
        return {"goal_id": goal_id}
    except KeyError as error:
        raise _not_found(error) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


class PurgeGoalRequest(BaseModel):
    material_references: dict[str, str] = {}


@app.delete("/api/user/recycle/goals/{goal_id}")
def purge_recycled_goal(goal_id: str, request: PurgeGoalRequest | None = None, service: LearningService = Depends(get_learning_service),
                        materials: MaterialStore = Depends(get_material_store)) -> dict:
    try:
        # 未知/已经整合的旧身份应走404幂等重放；scope可用并不代表Goal存在。
        if any(p.goal_profile.id == goal_id for p in service.get_learning_library().projects):
            raise HTTPException(status_code=409, detail="请先把目标移入回收区。")
        service.begin_goal_purge_by_user(goal_id)
        # 原件失败时保留 Kernel 回收项；重试可以继续处理剩余文件。
        materials.scope_is_available = service.scope_is_available
        snapshot = service.snapshot()
        projects = [(p.goal_profile.id, p.skill_ids) for p in snapshot.learning_history]
        projects += [(p.project.goal_profile.id, p.project.skill_ids) for p in snapshot.recycled_projects
                     if p.project.goal_profile.id != goal_id]
        if snapshot.goal_profile:
            projects.append((snapshot.goal_profile.id, snapshot.current_goal_skill_ids))
        known = {identity for identity, _ in projects}
        references = {mid: owner for mid, owner in (request.material_references if request else {}).items()
                      if owner in known and owner != goal_id and re.fullmatch(r"mat-[a-f0-9]{32}", mid)}
        for owner, skill_ids in projects:
            for card in snapshot.knowledge_cards:
                if card.skill_id in skill_ids:
                    for mid in re.findall(r"mat-[a-f0-9]{32}", card.question + card.answer + (card.learner_note or "")):
                        references.setdefault(mid, owner)
            for evidence in snapshot.evidence:
                if evidence.skill_id in skill_ids:
                    for mid in re.findall(r"mat-[a-f0-9]{32}", evidence.source + evidence.description):
                        references.setdefault(mid, owner)
        materials.purge_scope(goal_id, references)
        service.purge_goal_by_user(goal_id)
        return {"goal_id": goal_id}
    except KeyError as error:
        raise _not_found(error) from error


@app.post("/api/user/recycle/drafts/{session_id}/{action}")
def recycle_draft(session_id: str, action: str, service: LearningService = Depends(get_learning_service),
                  materials: MaterialStore = Depends(get_material_store)) -> dict:
    scope = MaterialStore.draft_scope(session_id)
    materials.scope_is_available = service.scope_is_available
    if action == "delete":
        service.recycle_draft_by_user(scope)
    elif action == "restore":
        service.recycle_draft_by_user(scope, restore=True)
        materials.resume_scope(scope)
    elif action == "purge":
        materials.purge_scope(scope)
        # 永久删除草稿仍保留不可访问标记，旧 Session ID 不能重新上传到已销毁的草稿。
    else:
        raise HTTPException(status_code=404, detail="Unknown recycle action")
    return {"scope": scope}


@app.post("/api/user/goals/{goal_id}/activate", response_model=LearningOverviewResponse)
def activate_goal_by_user(
    goal_id: str,
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> LearningOverviewResponse:
    try:
        return LearningOverviewResponse.from_application(service.switch_goal_by_user(goal_id))
    except KeyError as error:
        raise _not_found(error) from error


@app.post("/api/user/skills/{skill_id}/start-review", response_model=TaskResponse)
def start_skill_review_by_user(
    skill_id: str,
    request: StartReviewRequest,
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> TaskResponse:
    try:
        if not request.operation_id.strip():
            raise ValueError("operation_id is required")
        return TaskResponse.model_validate(service.start_review_by_user(skill_id, request.operation_id))
    except KeyError as error:
        raise _not_found(error) from error
    except (TypeError, ValueError) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.post("/api/user/tasks/{task_id}/finish-review", response_model=LearningOverviewResponse)
def finish_skill_review_by_user(
    task_id: str,
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> LearningOverviewResponse:
    try:
        service.finish_review_by_user(task_id)
        return LearningOverviewResponse.from_application(service.get_learning_overview())
    except KeyError as error:
        raise _not_found(error) from error
    except (TypeError, ValueError) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.get("/api/learning/tasks/{task_id}", response_model=TaskResponse)
def get_learning_task(
    task_id: str,
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> TaskResponse:
    """按 ID 核对真实 Task 终态，供复习恢复使用；不从 Pi 标记猜测状态。"""
    try:
        return TaskResponse.model_validate(service.get_task(task_id))
    except KeyError as error:
        raise _not_found(error) from error


def _not_found(error: KeyError) -> HTTPException:
    message = str(error.args[0]) if error.args else str(error)
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=message)


@app.post(
    "/api/learning/curriculum/initialize",
    response_model=LearningPlanResponse,
    status_code=status.HTTP_201_CREATED,
)
def initialize_curriculum(
    request: InitializeCurriculumRequest,
    service: Annotated[LearningService, Depends(get_learning_service)],
    materials: Annotated[MaterialStore, Depends(get_material_store)],
) -> LearningPlanResponse:
    # 阅读检查、Kernel定稿和草稿绑定共用原件短锁，删除/用途变更不能夹在检查与写入之间。
    # 这里没有模型调用；不把整个阅读过程放进课堂或资料写锁。
    with materials._write_lock:
        planning = MaterialPlanningStore(materials)
        payload = request.model_dump(mode="json", exclude={"recover_only"})
        # 空领域与旧版未携带字段等价，不能让升级打断已确认资料阅读的初始化回执。
        if not payload["goal_profile"].get("learning_domain"):
            payload["goal_profile"].pop("learning_domain", None)
        # 偏好版本由运行时注入，不属于用户确认的路线身份；崩溃恢复会重放未注入的原工具参数。
        # 这里只规范幂等比较，实际Frontier仍从request构建并保存原版本。
        payload["frontier"].pop("teaching_preferences_revision", None)
        # 空归属与升级前省略字段等价，保留已保存初始化请求/回执的身份。
        for milestone in payload["curriculum_spine"]:
            if not milestone.get("skill_ids"):
                milestone.pop("skill_ids", None)
        committed = None
        snapshot = service.snapshot()
        if snapshot.goal_profile and snapshot.frontier and snapshot.goal_profile.id == request.goal_profile.id:
            candidate = LearningPlanResponse.from_domain(LearningPlan(snapshot.goal_profile, snapshot.curriculum_spine, snapshot.frontier))
            candidate_profile = candidate.goal_profile.model_dump(mode="json", exclude={"created_at"})
            if not candidate_profile.get("learning_domain"):
                candidate_profile.pop("learning_domain", None)
            candidate_spine = candidate.model_dump(mode="json")["curriculum_spine"]
            candidate_frontier = candidate.frontier.model_dump(mode="json")
            candidate_frontier.pop("teaching_preferences_revision", None)
            for milestone in candidate_spine:
                if not milestone.get("skill_ids"):
                    milestone.pop("skill_ids", None)
            actual_skills = {skill.id: skill for skill in snapshot.skills}
            if (candidate_profile == payload["goal_profile"]
                    and candidate_spine == payload["curriculum_spine"]
                    and candidate_frontier == payload["frontier"]
                    and (snapshot.current_goal_skill_ids == tuple(skill.id for skill in request.frontier_skills)
                         or service.growth_imported_goal(request.goal_profile.id) and set(s.id for s in request.frontier_skills).issubset(snapshot.current_goal_skill_ids))
                    and all(skill.id in actual_skills and all(getattr(actual_skills[skill.id], key) == getattr(skill, key)
                            for key in ("name", "description", "prerequisites", "target_depth")) for skill in request.frontier_skills)):
                committed = candidate.model_dump(mode="json")
        cached = planning.guard(request.onboarding_session_id, request.reading_requirement_id,
                                payload["goal_profile"], payload, committed)
        if cached is not None:
            if (request.onboarding_session_id and request.reading_requirement_id
                    and planning.get(materials.draft_scope(request.onboarding_session_id), request.onboarding_session_id,
                                     request.reading_requirement_id)["state"] != "COMPLETED"):
                # 内存可能来自一次保存失败；恢复回执前必须让原持久化器再次确认，不能仅凭内存返回成功。
                service.ensure_state_saved()
                materials.bind_draft(request.onboarding_session_id, request.goal_profile.id)
                planning.complete(request.onboarding_session_id, request.reading_requirement_id, payload, cached)
            return LearningPlanResponse.model_validate(cached)
        if request.recover_only and not request.reading_requirement_id and request.onboarding_session_id:
            # 无资料规划复用同一个Kernel投影核验，不能把内存中的“像是成功”或模型文字当保存回执。
            if committed is not None and materials._bound_goal(request.onboarding_session_id) == request.goal_profile.id:
                materials.validate_draft_binding(request.onboarding_session_id, request.goal_profile.id)
                service.ensure_state_saved()
                materials.bind_draft(request.onboarding_session_id, request.goal_profile.id)
                return LearningPlanResponse.model_validate(committed)
            existing_ids = {project.goal_profile.id for project in snapshot.learning_history}
            if snapshot.goal_profile:
                existing_ids.add(snapshot.goal_profile.id)
            if request.goal_profile.id in existing_ids and not service.growth_needs_route(request.goal_profile.id):
                raise MaterialError("PLANNING_RECOVERY_REQUIRED", "目标已存在但与原提交不一致；请恢复原工作区核对，不重复创建。", 409)
            raise MaterialError("PLANNING_RESULT_NOT_FOUND", "原提交尚未形成已保存路线，草案保留，可继续原提交。", 404)
        if request.recover_only or request.reading_requirement_id and snapshot.goal_profile and snapshot.goal_profile.id == request.goal_profile.id and not service.growth_needs_route(request.goal_profile.id):
            raise MaterialError("PLANNING_RECOVERY_REQUIRED", "目标已有真实路线，须核验原提交回执，不能重复初始化。", 409)
        if request.onboarding_session_id is not None:
            materials.validate_draft_binding(request.onboarding_session_id, request.goal_profile.id)
        planning.prepare_finalize(request.onboarding_session_id, request.reading_requirement_id, payload)
        try:
            profile = GoalProfile(**request.goal_profile.model_dump())
            milestones = tuple(CurriculumMilestone(**item.model_dump()) for item in request.curriculum_spine)
            skills = tuple(SkillNode(**item.model_dump()) for item in request.frontier_skills)
            frontier = FrontierPlan(**request.frontier.model_dump())
            plan = service.initialize_curriculum(profile, milestones, skills, frontier, replace_existing=request.replace_existing)
        except (TypeError, ValueError) as error:
            status_code = (status.HTTP_409_CONFLICT if "already exists" in str(error) or "ACTIVE" in str(error)
                           else status.HTTP_422_UNPROCESSABLE_ENTITY)
            raise HTTPException(status_code=status_code, detail=str(error)) from error
        except KeyError as error:
            raise _not_found(error) from error
        logger.info("learning_curriculum_initialized", extra={"goal_id": profile.id})
        if request.onboarding_session_id is not None:
            materials.bind_draft(request.onboarding_session_id, profile.id)
        result = LearningPlanResponse.from_domain(plan)
        planning.complete(request.onboarding_session_id, request.reading_requirement_id, payload, result.model_dump(mode="json"))
        return result


@app.post(
    "/api/learning/frontier/apply",
    response_model=FrontierPlanSchema,
)
def apply_frontier_plan(
    request: ApplyFrontierPlanRequest,
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> FrontierPlanSchema:
    """Apply a structured planner decision without activating a task."""
    try:
        frontier = service.apply_frontier_plan(
            FrontierPlan(**request.frontier.model_dump()),
            added_skills=tuple(
                SkillNode(**item.model_dump()) for item in request.added_skills
            ),
            depth_changes=tuple(
                (item.skill_id, item.target_depth) for item in request.depth_changes
            ),
            prerequisite_additions=tuple(
                (item.skill_id, item.prerequisite_id)
                for item in request.prerequisite_additions
            ),
            remove_skill_ids=request.remove_skill_ids,
            milestone_assignments=tuple(
                (item.skill_id, item.milestone_id) for item in request.milestone_assignments
            ),
        )
    except KeyError as error:
        raise _not_found(error) from error
    except (TypeError, ValueError) as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(error),
        ) from error
    logger.info(
        "learning_frontier_applied",
        extra={"focus_skill_id": frontier.focus_skill_id},
    )
    return FrontierPlanSchema.model_validate(frontier)


@app.post(
    "/api/learning/plan-revisions",
    response_model=LearningPlanRevisionResponse,
    status_code=status.HTTP_201_CREATED,
)
def prepare_plan_revision(
    request: PreparePlanRevisionRequest,
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> LearningPlanRevisionResponse:
    """Persist a complete candidate plan without changing current learning truth."""
    try:
        revision = service.prepare_plan_revision(
            revision_id=request.id,
            goal_profile=GoalProfile(**request.goal_profile.model_dump()),
            curriculum_spine=tuple(
                CurriculumMilestone(**item.model_dump())
                for item in request.curriculum_spine
            ),
            added_skills=tuple(
                SkillNode(**item.model_dump()) for item in request.added_skills
            ),
            updated_skills=tuple(
                SkillNode(**item.model_dump()) for item in request.updated_skills
            ),
            remove_skill_ids=request.remove_skill_ids,
            frontier=FrontierPlan(**request.frontier.model_dump()),
            reason=request.reason,
        )
    except KeyError as error:
        raise _not_found(error) from error
    except (TypeError, ValueError) as error:
        raise HTTPException(status.HTTP_409_CONFLICT, str(error)) from error
    return LearningPlanRevisionResponse.from_domain(revision)


@app.get(
    "/api/learning/plan-revisions/{revision_id}",
    response_model=LearningPlanRevisionResponse,
)
def get_plan_revision(
    revision_id: str,
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> LearningPlanRevisionResponse:
    try:
        revision = service.get_plan_revision(revision_id)
    except KeyError as error:
        raise _not_found(error) from error
    return LearningPlanRevisionResponse.from_domain(revision)


@app.post(
    "/api/learning/plan-revisions/{revision_id}/decision",
    response_model=LearningPlanRevisionResponse,
)
def decide_plan_revision(
    revision_id: str,
    request: DecidePlanRevisionRequest,
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> LearningPlanRevisionResponse:
    try:
        revision = service.decide_plan_revision(
            revision_id,
            action=request.action,
            feedback=request.feedback,
            request_id=request.request_id,
        )
    except KeyError as error:
        raise _not_found(error) from error
    except (TypeError, ValueError) as error:
        raise HTTPException(status.HTTP_409_CONFLICT, str(error)) from error
    return LearningPlanRevisionResponse.from_domain(revision)


@app.post(
    "/api/learning/tasks",
    response_model=TaskResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_learning_task(
    request: CreateLearningTaskRequest,
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> TaskResponse:
    try:
        task = LearningTask(
            id=f"task-{uuid4().hex}",
            title=request.title,
            description=request.description,
            related_skill_ids=request.related_skill_ids,
            expected_evidence_types=request.expected_evidence_types,
            teaching_activity=request.teaching_activity.to_domain() if request.teaching_activity else None,
            activity_revision=1 if request.teaching_activity else 0,
        )
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error
    try:
        created = service.create_task(task)
    except KeyError as error:
        raise _not_found(error) from error
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    logger.info("learning_task_created", extra={"task_id": created.id})
    return TaskResponse.model_validate(created)


@app.post("/api/learning/tasks/{task_id}/teaching-activity", response_model=TaskResponse)
def set_task_teaching_activity(
    task_id: str,
    request: SetTeachingActivityRequest,
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> TaskResponse:
    try:
        activity = request.teaching_activity.to_domain()
    except ValueError as error:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(error)) from error
    try:
        updated = service.set_teaching_activity(
            task_id, expected_goal_id=request.expected_goal_id,
            expected_revision=request.expected_revision, teaching_activity=activity,
        )
    except KeyError as error:
        raise _not_found(error) from error
    except (TypeError, ValueError) as error:
        raise HTTPException(status.HTTP_409_CONFLICT, str(error)) from error
    return TaskResponse.model_validate(updated)


@app.post(
    "/api/learning/tasks/{task_id}/activate",
    response_model=TaskResponse,
)
def activate_learning_task(
    task_id: str,
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> TaskResponse:
    try:
        activated = service.activate_task(task_id)
    except KeyError as error:
        raise _not_found(error) from error
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(error),
        ) from error
    logger.info("learning_task_activated", extra={"task_id": activated.id})
    return TaskResponse.model_validate(activated)


@app.post(
    "/api/learning/tasks/{task_id}/complete",
    response_model=TaskResponse,
)
def complete_learning_task(
    task_id: str,
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> TaskResponse:
    try:
        completed = service.complete_task(task_id)
    except KeyError as error:
        raise _not_found(error) from error
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    logger.info("learning_task_completed", extra={"task_id": completed.id})
    return TaskResponse.model_validate(completed)


@app.post(
    "/api/user/tasks/{task_id}/abandon",
    response_model=TaskResponse,
)
def abandon_learning_task_by_user(
    task_id: str,
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> TaskResponse:
    # 放弃任务会改变权威 Task 状态，只能由本地用户入口触发；
    # 该操作故意不注册为 Agent Tool，避免模型替用户终止学习活动。
    try:
        abandoned = service.skip_task(task_id)
    except KeyError as error:
        raise _not_found(error) from error
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(error),
        ) from error
    logger.info("learning_task_abandoned_by_user", extra={"task_id": abandoned.id})
    return TaskResponse.model_validate(abandoned)


@app.post(
    "/api/learning/evidence",
    response_model=EvidenceResponse,
    status_code=status.HTTP_201_CREATED,
)
def submit_evidence(
    request: SubmitEvidenceRequest,
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> EvidenceResponse:
    try:
        evidence = Evidence(
            id=f"evidence-{uuid4().hex}",
            skill_id=request.skill_id,
            evidence_type=request.evidence_type,
            description=request.description,
            assistance_level=request.assistance_level,
            source=request.source,
        )
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error
    try:
        service.submit_evidence(evidence)
    except KeyError as error:
        raise _not_found(error) from error
    except ValueError as error:
        # Task/Skill 归属冲突是教学状态冲突，不是可忽略的模型写入结果。
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    logger.info("learning_evidence_submitted", extra={"evidence_id": evidence.id})
    return EvidenceResponse.model_validate(evidence)


# ── Knowledge Cards (Agent-authorized) ────────────────────────────
# Agent may create and read cards.  It may NOT set feedback or notes.
# Those are user-owned actions below under /api/user/*.

@app.post(
    "/api/learning/cards",
    response_model=KnowledgeCardResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_knowledge_card(
    request: CreateKnowledgeCardRequest,
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> KnowledgeCardResponse:
    try:
        card = KnowledgeCard(
            id=f"card-{uuid4().hex}",
            skill_id=request.skill_id,
            question=request.question,
            answer=request.answer,
            created_at=datetime.now(),
            source_conversation_id=request.source_conversation_id,
        )
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error
    try:
        created = service.create_knowledge_card(card)
    except KeyError as error:
        raise _not_found(error) from error
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    logger.info("knowledge_card_created", extra={"card_id": created.id, "skill_id": created.skill_id})
    return KnowledgeCardResponse.from_domain(created)


@app.get(
    "/api/learning/cards",
    response_model=tuple[KnowledgeCardResponse, ...],
)
def list_knowledge_cards(
    service: Annotated[LearningService, Depends(get_learning_service)],
    skill_id: str | None = None,
) -> list[KnowledgeCardResponse]:
    if skill_id is not None:
        try:
            cards = service.get_knowledge_cards_for_skill(skill_id)
        except KeyError as error:
            raise _not_found(error) from error
    else:
        cards = service.get_all_knowledge_cards()
    return [KnowledgeCardResponse.from_domain(card) for card in cards]


@app.get(
    "/api/learning/cards/{card_id}",
    response_model=KnowledgeCardResponse,
)
def get_knowledge_card(
    card_id: str,
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> KnowledgeCardResponse:
    try:
        card = service.get_knowledge_card(card_id)
    except KeyError as error:
        raise _not_found(error) from error
    return KnowledgeCardResponse.from_domain(card)


# ── Knowledge Cards (User-owned) ───────────────────────────────────
# Feedback and notes are direct user actions.  They never create Evidence,
# change SkillState, or trigger Mastery.  These routes are intentionally
# NOT registered as Agent tools.

@app.post(
    "/api/user/cards/{card_id}/feedback",
    response_model=KnowledgeCardResponse,
)
def set_card_feedback_by_user(
    card_id: str,
    request: SetCardFeedbackRequest,
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> KnowledgeCardResponse:
    try:
        # 硬件确认与用户编辑可能交错。利用已有 mutation middleware，在写入同一临界区
        # 核对用户实际复习过的内容；旧版本自评不能落到刚修改的卡片上。
        if request.expected_content is not None:
            current = service.get_knowledge_card(card_id)
            expected = request.expected_content
            if (current.skill_id, current.question, current.answer) != (expected.skill_id, expected.question, expected.answer):
                raise HTTPException(status_code=409, detail="Card changed after review; feedback was not saved.")
        card = service.set_card_feedback_by_user(card_id, request.status)
    except KeyError as error:
        raise _not_found(error) from error
    except (TypeError, ValueError) as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error
    logger.info("card_feedback_set_by_user", extra={"card_id": card_id, "status": request.status.value})
    return KnowledgeCardResponse.from_domain(card)


@app.put(
    "/api/user/cards/{card_id}/note",
    response_model=KnowledgeCardResponse,
)
def set_card_note_by_user(
    card_id: str,
    request: SetCardNoteRequest,
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> KnowledgeCardResponse:
    try:
        card = service.set_card_note_by_user(card_id, request.note)
    except KeyError as error:
        raise _not_found(error) from error
    except (TypeError, ValueError) as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error
    logger.info("card_note_set_by_user", extra={"card_id": card_id})
    return KnowledgeCardResponse.from_domain(card)


@app.delete(
    "/api/user/cards/{card_id}/note",
    response_model=KnowledgeCardResponse,
)
def clear_card_note_by_user(
    card_id: str,
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> KnowledgeCardResponse:
    try:
        card = service.clear_card_note_by_user(card_id)
    except KeyError as error:
        raise _not_found(error) from error
    logger.info("card_note_cleared_by_user", extra={"card_id": card_id})
    return KnowledgeCardResponse.from_domain(card)


@app.delete(
    "/api/user/cards/{card_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_knowledge_card_by_user(
    card_id: str,
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> None:
    """Delete a KnowledgeCard. User-owned action; Agent Tool Registry has no equivalent."""
    try:
        service.delete_knowledge_card_by_user(card_id)
    except KeyError as error:
        raise _not_found(error) from error
    logger.info("knowledge_card_deleted_by_user", extra={"card_id": card_id})


@app.put(
    "/api/user/cards/{card_id}",
    response_model=KnowledgeCardResponse,
)
def update_knowledge_card_by_user(
    card_id: str,
    request: UpdateKnowledgeCardRequest,
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> KnowledgeCardResponse:
    """Update card question/answer. User-owned action; Agent may not modify cards."""
    try:
        card = service.update_knowledge_card_by_user(
            card_id, request.question, request.answer
        )
    except KeyError as error:
        raise _not_found(error) from error
    except (TypeError, ValueError) as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error
    logger.info("knowledge_card_updated_by_user", extra={"card_id": card_id})
    return KnowledgeCardResponse.from_domain(card)


class ConfirmMasteryScopeRequest(BaseModel):
    expected_goal_id: str | None = Field(default=None, strict=True, min_length=1, max_length=256)
    expected_task_id: str | None = Field(default=None, strict=True, min_length=1, max_length=256)

    @model_validator(mode="after")
    def paired_scope(self):
        if (self.expected_goal_id is None) != (self.expected_task_id is None):
            raise ValueError("Mastery confirmation requires both expected Goal and Task")
        return self


@app.post("/api/user/skills/{skill_id}/confirm-mastery", response_model=SkillResponse)
def confirm_skill_mastery_by_user(
    skill_id: str,
    service: Annotated[LearningService, Depends(get_learning_service)],
    request: ConfirmMasteryScopeRequest | None = None,
) -> SkillResponse:
    try:
        # API统一写锁覆盖锚点检查与Mastery写入；保留无请求体的原手动确认入口。
        skill = service.confirm_mastery_by_user(skill_id,
            expected_goal_id=request.expected_goal_id if request else None,
            expected_task_id=request.expected_task_id if request else None)
    except KeyError as error:
        raise _not_found(error) from error
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(error),
        ) from error
    logger.info("skill_mastery_confirmed_by_user", extra={"skill_id": skill.id})
    return SkillResponse.model_validate(skill)


@app.post(
    "/api/user/skills/{skill_id}/reopen",
    response_model=SkillResponse,
)
def reopen_skill_by_user(
    skill_id: str,
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> SkillResponse:
    try:
        skill = service.reopen_skill_by_user(skill_id)
    except KeyError as error:
        raise _not_found(error) from error
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(error),
        ) from error
    logger.info("skill_reopened_by_user", extra={"skill_id": skill.id})
    return SkillResponse.model_validate(skill)


@app.post(
    "/api/user/skills/{skill_id}/start-practicing",
    response_model=SkillResponse,
)
def start_practicing_by_user(
    skill_id: str,
    service: Annotated[LearningService, Depends(get_learning_service)],
) -> SkillResponse:
    try:
        skill = service.start_practicing_by_user(skill_id)
    except KeyError as error:
        raise _not_found(error) from error
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(error),
        ) from error
    logger.info("skill_practice_started_by_user", extra={"skill_id": skill.id})
    return SkillResponse.model_validate(skill)
