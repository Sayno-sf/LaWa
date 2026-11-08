"""Atomic local JSON persistence for the single-user Learning Kernel."""

from __future__ import annotations

import json
import os
import shutil
import threading
import uuid
from dataclasses import asdict, replace
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from app.application import LearningService
from app.domain.history import RecycledLearningProject
from app.domain.answer_assessment import AnswerAssessment, AssessmentCriterion
from app.domain.teaching_evolution import TeachingEvolutionState
from app.domain.hardware_feedback import HardwareFeedbackState
from app.domain.growth import GrowthState
from app.domain.learning_branch import LearningBranch
from app.domain import (
    ArchivedLearningProject,
    AssistanceLevel,
    CardFeedbackStatus,
    CurriculumMilestone,
    Evidence,
    EvidenceType,
    FrontierPlan,
    GoalProfile,
    KnowledgeCard,
    LearningDepth,
    LearningTask,
    LearningPlanRevision,
    SkillGraph,
    SkillNode,
    SkillState,
    TaskStatus,
    TeachingActivity,
    TeachingActivityMethod,
)


STATE_VERSION = 10


class JsonLearningStateStore:
    """Save one local learner's complete state after every successful mutation."""

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        # FastAPI 同步端点在线程池并发执行；写盘必须串行，否则多个请求会
        # 同时写同一个临时文件并互相 os.replace 移走它，造成"写入成功却返回 500"。
        self._write_lock = threading.Lock()

    def bind(self, service: LearningService) -> LearningService:
        # 自动保存挂在 Application Service 的“变更已成功”边界上；
        # Agent、Web 和 CLI 无论从哪个入口写入，都会走同一份账本。
        return service.enable_auto_save(self.save)

    def load_or_create(self, factory: Callable[[], LearningService]) -> LearningService:
        restored = self.load()
        return restored if restored is not None else self.bind(factory())

    def load(self) -> LearningService | None:
        if not self.path.exists():
            return None
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            service = self._decode(payload)
            if payload.get("version") in (1, 2, 3, 4, 5, 6, 7, 8, 9):
                # v9增加成长资料/派生评价；升级前保留原账本，旧硬件身份不重建。
                backup = self.path.with_name(f"{self.path.name}.v{payload['version']}.bak")
                if not backup.exists():
                    shutil.copy2(self.path, backup)
        except (OSError, TypeError, ValueError, KeyError, json.JSONDecodeError) as error:
            raise RuntimeError(
                f"Cannot load learning state from {self.path}: {error}"
            ) from error
        return self.bind(service)

    def save(self, service: LearningService) -> None:
        # 临界区：全量快照编码 + 落盘一次完成，并发变更在此排队。
        with service._assessment_lock, self._write_lock:
            payload = self._encode(service)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            # 唯一临时文件名：即使存在其他写者也不会撞名或互相移走文件。
            temporary = self.path.with_name(
                f".{self.path.stem}.{os.getpid()}.{threading.get_ident()}.{uuid.uuid4().hex[:8]}.tmp"
            )
            try:
                # 先完整写临时文件再原子替换，避免进程中断留下半份 JSON。
                with temporary.open("w", encoding="utf-8", newline="\n") as output:
                    output.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, self.path)
            finally:
                # 正常路径下 replace 已移走文件；写入/替换失败时清理残留临时文件。
                try:
                    temporary.unlink()
                except FileNotFoundError:
                    pass

    @staticmethod
    def _encode(service: LearningService) -> dict[str, Any]:
        snapshot = service.snapshot()
        return {
            "version": STATE_VERSION,
            "current_goal": snapshot.current_goal,
            "goal_profile": _goal_to_json(snapshot.goal_profile),
            "curriculum_spine": [_milestone_to_json(item) for item in snapshot.curriculum_spine],
            "frontier": _frontier_to_json(snapshot.frontier),
            "skills": [_skill_to_json(item) for item in snapshot.skills],
            "evidence": [_evidence_to_json(item) for item in snapshot.evidence],
            "tasks": [_task_to_json(item) for item in snapshot.tasks],
            "learning_history": [
                {
                    "goal_profile": _goal_to_json(item.goal_profile),
                    "curriculum_spine": [
                        _milestone_to_json(milestone)
                        for milestone in item.curriculum_spine
                    ],
                    "skill_ids": list(item.skill_ids),
                    "archived_at": item.archived_at.isoformat(),
                    "frontier": _frontier_to_json(item.frontier),
                }
                for item in snapshot.learning_history
            ],
            "current_goal_skill_ids": list(snapshot.current_goal_skill_ids),
            "knowledge_cards": [
                _knowledge_card_to_json(item) for item in snapshot.knowledge_cards
            ],
            "recycled_projects": [
                {"goal_profile": _goal_to_json(item.project.goal_profile),
                 "curriculum_spine": [_milestone_to_json(m) for m in item.project.curriculum_spine],
                 "skill_ids": list(item.project.skill_ids),
                 "archived_at": item.project.archived_at.isoformat(),
                 "frontier": _frontier_to_json(item.project.frontier),
                 "deleted_at": item.deleted_at.isoformat(),
                 "active_task_ids": list(item.active_task_ids), "purge_started": item.purge_started}
                for item in snapshot.recycled_projects
            ],
            "recycled_drafts": list(snapshot.recycled_drafts),
            "purged_goal_ids": list(snapshot.purged_goal_ids),
            "answer_assessments": [{**asdict(a), "created_at": a.created_at.isoformat()} for a in snapshot.answer_assessments],
            "teaching": snapshot.teaching.to_json(),
            "plan_revisions": [
                _plan_revision_to_json(item) for item in snapshot.plan_revisions
            ],
            "hardware_feedback": snapshot.hardware_feedback.to_json(),
            "growth": snapshot.growth.to_json(),
            "learning_branches": [asdict(b) for b in snapshot.learning_branches],
        }

    @staticmethod
    def _decode(payload: Any) -> LearningService:
        if not isinstance(payload, dict) or payload.get("version") not in (1, 2, 3, 4, 5, 6, 7, 8, 9, STATE_VERSION):
            raise ValueError(f"Unsupported learning state version: {payload!r}")
        if payload["version"] >= 8 and ("hardware_feedback" not in payload or any(
                "feedback_revision" not in card for card in payload.get("knowledge_cards", []))):
            raise ValueError("Version 8 requires durable hardware identity and feedback revisions")
        if payload["version"] >= 9 and not isinstance(payload.get("growth"), dict):
            raise ValueError("Version 9 requires growth ledger")
        graph = SkillGraph(_skill_from_json(item) for item in payload["skills"])
        service = LearningService(
            graph,
            current_goal=payload.get("current_goal"),
            goal_profile=_goal_from_json(payload.get("goal_profile")),
            curriculum_spine=tuple(
                _milestone_from_json(item) for item in payload["curriculum_spine"]
            ),
            frontier=_frontier_from_json(payload.get("frontier")),
            evidence=tuple(_evidence_from_json(item) for item in payload["evidence"]),
            tasks=tuple(_task_from_json(item) for item in payload["tasks"]),
            # Restore snapshot metadata verbatim; loading is not a new archive
            # or a reason to reorder projects or rewrite Evidence timestamps.
            learning_history=tuple(
                ArchivedLearningProject(
                    goal_profile=_goal_from_json(item["goal_profile"]),
                    curriculum_spine=tuple(
                        _milestone_from_json(value)
                        for value in item["curriculum_spine"]
                    ),
                    skill_ids=tuple(item["skill_ids"]),
                    archived_at=datetime.fromisoformat(item["archived_at"]),
                    frontier=_frontier_from_json(item.get("frontier")),
                )
                for item in payload.get("learning_history", [])
            ),
            current_goal_skill_ids=tuple(payload.get("current_goal_skill_ids", [])),
            # Backward compatible: snapshots written before Sprint 7 have no
            # knowledge_cards key; they must load normally with an empty set.
            knowledge_cards=tuple(
                _knowledge_card_from_json(item)
                for item in payload.get("knowledge_cards", [])
            ),
            recycled_projects=tuple(RecycledLearningProject(
                ArchivedLearningProject(
                    goal_profile=_goal_from_json(item["goal_profile"]),
                    curriculum_spine=tuple(_milestone_from_json(m) for m in item["curriculum_spine"]),
                    skill_ids=tuple(item["skill_ids"]),
                    archived_at=datetime.fromisoformat(item["archived_at"]),
                    frontier=_frontier_from_json(item.get("frontier"))),
                deleted_at=datetime.fromisoformat(item["deleted_at"]),
                active_task_ids=tuple(item["active_task_ids"]), purge_started=item.get("purge_started", False))
                for item in payload.get("recycled_projects", [])),
            recycled_drafts=tuple(payload.get("recycled_drafts", [])),
            purged_goal_ids=tuple(payload.get("purged_goal_ids", [])),
            answer_assessments=tuple(AnswerAssessment(**{**item,
                "criteria": tuple(AssessmentCriterion(**c) for c in item["criteria"]),
                "strengths": tuple(item["strengths"]), "gaps": tuple(item["gaps"]),
                "created_at": datetime.fromisoformat(item["created_at"])})
                for item in payload.get("answer_assessments", [])),
            teaching=TeachingEvolutionState.from_json(payload.get("teaching", {})),
            plan_revisions=tuple(
                _plan_revision_from_json(item)
                for item in payload.get("plan_revisions", [])
            ),
            hardware_feedback=HardwareFeedbackState.from_json(payload.get("hardware_feedback", {"owner_id": None, "receipts": []})),
            growth=GrowthState.from_json(payload.get("growth")),
            learning_branches=tuple(LearningBranch(**{**b, "frontier": _frontier_from_json(b.get("frontier"))})
                                    for b in payload.get("learning_branches", [])),
        )
        # 旧测试允许先构造一个带悬空 Evidence ID 的内存对象，以便在读取时暴露错误；
        # 持久化账本更严格，任何悬空引用都必须在启动恢复阶段立即拒绝。
        snapshot = service.snapshot()
        evidence_ids = {e.id for e in snapshot.evidence}
        for skill in snapshot.skills:
            if not set(skill.evidence_ids).issubset(evidence_ids):
                raise ValueError(f"Skill {skill.id} has missing Evidence")
        if payload.get("version") == 1 and service.snapshot().goal_profile:
            memberships: dict[str, set[str]] = {}
            profiles = [*service.snapshot().learning_history]
            profiles.append(ArchivedLearningProject(
                goal_profile=service.snapshot().goal_profile,
                curriculum_spine=service.snapshot().curriculum_spine,
                skill_ids=service.snapshot().current_goal_skill_ids,
                frontier=service.snapshot().frontier,
            ))
            for project in profiles:
                for skill_id in project.skill_ids:
                    memberships.setdefault(skill_id, set()).add(project.goal_profile.id)
            for task_id, task in tuple(service._tasks.items()):
                if task.goal_id is not None:
                    continue
                candidates = set.intersection(*(memberships.get(skill_id, set()) for skill_id in task.related_skill_ids))
                if len(candidates) == 1:
                    service._tasks[task_id] = replace(task, goal_id=next(iter(candidates)))
                elif task.status is TaskStatus.ACTIVE:
                    service._tasks[task_id] = replace(task, goal_id=service.snapshot().goal_profile.id)
        return service


def _goal_to_json(value: GoalProfile | None) -> dict[str, Any] | None:
    if value is None:
        return None
    return {
        "id": value.id,
        "goal_description": value.goal_description,
        "background_summary": value.background_summary,
        "desired_outcome": value.desired_outcome,
        "learning_preferences": list(value.learning_preferences),
        "time_constraint": value.time_constraint,
        "prior_knowledge_claims": list(value.prior_knowledge_claims),
        "created_at": value.created_at.isoformat(),
        **({"learning_domain": value.learning_domain} if value.learning_domain else {}),
    }


def _goal_from_json(value: Any) -> GoalProfile | None:
    if value is None:
        return None
    return GoalProfile(
        id=value["id"],
        goal_description=value["goal_description"],
        background_summary=value["background_summary"],
        desired_outcome=value["desired_outcome"],
        learning_preferences=tuple(value.get("learning_preferences", [])),
        time_constraint=value.get("time_constraint", ""),
        prior_knowledge_claims=tuple(value.get("prior_knowledge_claims", [])),
        learning_domain=value.get("learning_domain", ""),
        created_at=datetime.fromisoformat(value["created_at"]),
    )


def _milestone_to_json(value: CurriculumMilestone) -> dict[str, Any]:
    return {
        "id": value.id,
        "name": value.name,
        "description": value.description,
        "target_depth": value.target_depth.value,
        "skill_ids": list(value.skill_ids),
    }


def _milestone_from_json(value: Any) -> CurriculumMilestone:
    return CurriculumMilestone(
        id=value["id"],
        name=value["name"],
        description=value["description"],
        target_depth=LearningDepth(value["target_depth"]),
        skill_ids=tuple(value.get("skill_ids", [])),
    )


def _frontier_to_json(value: FrontierPlan | None) -> dict[str, Any] | None:
    if value is None:
        return None
    return {
        "focus_skill_id": value.focus_skill_id,
        "supporting_skill_ids": list(value.supporting_skill_ids),
        "reason": value.reason,
        "target_depth": value.target_depth.value,
        "suggested_learning_mode": value.suggested_learning_mode,
        "next_action": value.next_action,
        "teaching_preferences_revision": value.teaching_preferences_revision,
    }


def _frontier_from_json(value: Any) -> FrontierPlan | None:
    if value is None:
        return None
    return FrontierPlan(
        focus_skill_id=value["focus_skill_id"],
        supporting_skill_ids=tuple(value.get("supporting_skill_ids", [])),
        reason=value["reason"],
        target_depth=LearningDepth(value["target_depth"]),
        suggested_learning_mode=value["suggested_learning_mode"],
        next_action=value["next_action"],
        teaching_preferences_revision=value.get("teaching_preferences_revision"),
    )


def _skill_to_json(value: SkillNode) -> dict[str, Any]:
    return {
        "id": value.id,
        "name": value.name,
        "description": value.description,
        "prerequisites": list(value.prerequisites),
        "status": value.status.value,
        "evidence_ids": list(value.evidence_ids),
        "target_depth": value.target_depth.value,
    }


def _skill_from_json(value: Any) -> SkillNode:
    return SkillNode(
        id=value["id"],
        name=value["name"],
        description=value.get("description", ""),
        prerequisites=tuple(value.get("prerequisites", [])),
        status=SkillState(value["status"]),
        evidence_ids=tuple(value.get("evidence_ids", [])),
        target_depth=LearningDepth(value["target_depth"]),
    )


def _plan_revision_to_json(value: LearningPlanRevision) -> dict[str, Any]:
    return {
        "id": value.id,
        "goal_id": value.goal_id,
        "base_revision": value.base_revision,
        "revision": value.revision,
        "base_signature": value.base_signature,
        "goal_profile": _goal_to_json(value.goal_profile),
        "curriculum_spine": [_milestone_to_json(item) for item in value.curriculum_spine],
        "added_skills": [_skill_to_json(item) for item in value.added_skills],
        "updated_skills": [_skill_to_json(item) for item in value.updated_skills],
        "remove_skill_ids": list(value.remove_skill_ids),
        "frontier": _frontier_to_json(value.frontier),
        "summary": value.summary,
        "reason": value.reason,
        "status": value.status,
        "feedback": value.feedback,
        "decision_request_id": value.decision_request_id,
        "created_at": value.created_at.isoformat(),
        "decided_at": value.decided_at.isoformat() if value.decided_at else None,
    }


def _plan_revision_from_json(value: Any) -> LearningPlanRevision:
    goal_profile = _goal_from_json(value["goal_profile"])
    frontier = _frontier_from_json(value["frontier"])
    if goal_profile is None or frontier is None:
        raise ValueError("Plan revision requires a Goal Profile and Frontier")
    return LearningPlanRevision(
        id=value["id"],
        goal_id=value["goal_id"],
        base_revision=value["base_revision"],
        revision=value["revision"],
        base_signature=value["base_signature"],
        goal_profile=goal_profile,
        curriculum_spine=tuple(
            _milestone_from_json(item) for item in value["curriculum_spine"]
        ),
        added_skills=tuple(_skill_from_json(item) for item in value.get("added_skills", [])),
        updated_skills=tuple(_skill_from_json(item) for item in value.get("updated_skills", [])),
        remove_skill_ids=tuple(value.get("remove_skill_ids", [])),
        frontier=frontier,
        summary=value["summary"],
        reason=value["reason"],
        status=value.get("status", "PENDING"),
        feedback=value.get("feedback", ""),
        decision_request_id=value.get("decision_request_id", ""),
        created_at=datetime.fromisoformat(value["created_at"]),
        decided_at=(
            datetime.fromisoformat(value["decided_at"])
            if value.get("decided_at") is not None
            else None
        ),
    )


def _evidence_to_json(value: Evidence) -> dict[str, Any]:
    return {
        "id": value.id,
        "skill_id": value.skill_id,
        "evidence_type": value.evidence_type.value,
        "description": value.description,
        "assistance_level": value.assistance_level.value,
        "source": value.source,
        "created_at": value.created_at.isoformat(),
    }


def _evidence_from_json(value: Any) -> Evidence:
    return Evidence(
        id=value["id"],
        skill_id=value["skill_id"],
        evidence_type=EvidenceType(value["evidence_type"]),
        description=value["description"],
        assistance_level=AssistanceLevel(value["assistance_level"]),
        source=value["source"],
        created_at=datetime.fromisoformat(value["created_at"]),
    )


def _task_to_json(value: LearningTask) -> dict[str, Any]:
    return {
        "id": value.id,
        "title": value.title,
        "description": value.description,
        "related_skill_ids": list(value.related_skill_ids),
        "expected_evidence_types": [item.value for item in value.expected_evidence_types],
        "status": value.status.value,
        "goal_id": value.goal_id,
        "review_parent_task_id": value.review_parent_task_id,
        "branch_id": value.branch_id,
        # 空活动保持旧任务表示；加载或无关保存不会替历史任务虚构教法。
        **({"teaching_activity": asdict(value.teaching_activity),
            "activity_revision": value.activity_revision} if value.teaching_activity is not None else {}),
    }


def _task_from_json(value: Any) -> LearningTask:
    return LearningTask(
        id=value["id"],
        title=value["title"],
        description=value["description"],
        related_skill_ids=tuple(value["related_skill_ids"]),
        expected_evidence_types=tuple(
            EvidenceType(item) for item in value.get("expected_evidence_types", [])
        ),
        status=TaskStatus(value["status"]),
        goal_id=value.get("goal_id"),
        review_parent_task_id=value.get("review_parent_task_id"),
        branch_id=value.get("branch_id"),
        teaching_activity=(TeachingActivity(
            **{**value["teaching_activity"], "method": TeachingActivityMethod(value["teaching_activity"]["method"])}
        ) if value.get("teaching_activity") is not None else None),
        activity_revision=value.get("activity_revision", 0),
    )


def _knowledge_card_to_json(value: KnowledgeCard) -> dict[str, Any]:
    return {
        "id": value.id,
        "skill_id": value.skill_id,
        "question": value.question,
        "answer": value.answer,
        "created_at": value.created_at.isoformat(),
        "source_conversation_id": value.source_conversation_id,
        "feedback": value.feedback.value if value.feedback is not None else None,
        "feedback_updated_at": (
            value.feedback_updated_at.isoformat()
            if value.feedback_updated_at is not None
            else None
        ),
        "feedback_revision": value.feedback_revision,
        "learner_note": value.learner_note,
        "note_updated_at": (
            value.note_updated_at.isoformat()
            if value.note_updated_at is not None
            else None
        ),
    }


def _knowledge_card_from_json(value: Any) -> KnowledgeCard:
    return KnowledgeCard(
        id=value["id"],
        skill_id=value["skill_id"],
        question=value["question"],
        answer=value["answer"],
        created_at=datetime.fromisoformat(value["created_at"]),
        source_conversation_id=value.get("source_conversation_id"),
        feedback=(
            CardFeedbackStatus(value["feedback"])
            if value.get("feedback") is not None
            else None
        ),
        feedback_updated_at=(
            datetime.fromisoformat(value["feedback_updated_at"])
            if value.get("feedback_updated_at") is not None
            else None
        ),
        feedback_revision=value.get("feedback_revision", 0),
        learner_note=value.get("learner_note"),
        note_updated_at=(
            datetime.fromisoformat(value["note_updated_at"])
            if value.get("note_updated_at") is not None
            else None
        ),
    )
