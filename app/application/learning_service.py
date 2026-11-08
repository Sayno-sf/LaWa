"""Learning Kernel use cases; persistence is attached through an outer callback."""

from collections.abc import Callable
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
import json
from hashlib import sha256
from threading import RLock
from app.application.teaching_evolution import TeachingEvolution
from app.application.growth import Growth
from app.application.learning_branches import LearningBranches
from app.domain.learning_branch import LearningBranch
from app.application.kernel_lock import synchronized_kernel
from app.domain.growth import GrowthState
from app.domain.hardware_feedback import HardwareFeedbackState
from app.domain.teaching_evolution import TeachingEvolutionState
from app.domain.history import RecycledLearningProject
from app.domain.answer_assessment import AnswerAssessment, assessment_topic_id, project_practice

from app.domain import (
    CardFeedbackStatus,
    Evidence,
    ArchivedLearningProject,
    CurriculumMilestone,
    FrontierPlan,
    GoalProfile,
    KnowledgeCard,
    LearningDepth,
    LearningPlan,
    LearningPlanRevision,
    LearningTask,
    SkillGraph,
    SkillNode,
    SkillState,
    TaskStatus,
    TeachingActivity,
)


@dataclass(frozen=True, slots=True)
class LearningOverview:
    current_goal: str | None
    goal_profile: GoalProfile | None
    curriculum_spine: tuple[CurriculumMilestone, ...]
    current_frontier: FrontierPlan | None
    current_focus: LearningTask | None
    skills: tuple[SkillNode, ...]
    recent_evidence: tuple[Evidence, ...]
    active_task: LearningTask | None
    learning_history: tuple[ArchivedLearningProject, ...]
    current_goal_skill_ids: tuple[str, ...]
    knowledge_cards: tuple[KnowledgeCard, ...]
    recycled_goal_ids: tuple[str, ...] = ()
    practice_context: dict = field(default_factory=dict)
    plan_revision: int = 0
    learning_paths: dict = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class LearningLibraryProject:
    """Read-only projection of one current or archived learning project."""

    status: str
    goal_profile: GoalProfile
    curriculum_spine: tuple[CurriculumMilestone, ...]
    skills: tuple[SkillNode, ...]
    evidence: tuple[Evidence, ...]
    knowledge_cards: tuple[KnowledgeCard, ...]
    archived_at: datetime | None = None
    answer_assessments: tuple[AnswerAssessment, ...] = ()
    assessment_count: int = 0


@dataclass(frozen=True, slots=True)
class LearningLibrary:
    """All durable learning projects, derived only from Kernel facts."""

    projects: tuple[LearningLibraryProject, ...]


@dataclass(frozen=True, slots=True)
class LearningServiceSnapshot:
    """Complete state used by the local persistence adapter, not a second model."""

    current_goal: str | None
    goal_profile: GoalProfile | None
    curriculum_spine: tuple[CurriculumMilestone, ...]
    frontier: FrontierPlan | None
    skills: tuple[SkillNode, ...]
    evidence: tuple[Evidence, ...]
    tasks: tuple[LearningTask, ...]
    learning_history: tuple[ArchivedLearningProject, ...]
    current_goal_skill_ids: tuple[str, ...]
    knowledge_cards: tuple[KnowledgeCard, ...]
    recycled_projects: tuple[RecycledLearningProject, ...] = ()
    recycled_drafts: tuple[str, ...] = ()
    purged_goal_ids: tuple[str, ...] = ()
    answer_assessments: tuple[AnswerAssessment, ...] = ()
    teaching: TeachingEvolutionState = field(default_factory=TeachingEvolutionState)
    plan_revisions: tuple[LearningPlanRevision, ...] = ()
    hardware_feedback: HardwareFeedbackState = field(default_factory=HardwareFeedbackState)
    growth: GrowthState = field(default_factory=GrowthState)
    learning_branches: tuple[LearningBranch, ...] = ()


@synchronized_kernel
class LearningService(TeachingEvolution, Growth, LearningBranches):
    """Coordinate a graph, evidence records and tasks for one learning context.

    Callers receive immutable Domain objects, never the mutable collections
    held here. A local adapter may register a callback to persist each
    successful mutation without moving storage concerns into Domain objects.
    """

    def __init__(
        self,
        graph: SkillGraph,
        current_goal: str | None = "Deep Learning",
        *,
        goal_profile: GoalProfile | None = None,
        curriculum_spine: tuple[CurriculumMilestone, ...] = (),
        frontier: FrontierPlan | None = None,
        evidence: tuple[Evidence, ...] = (),
        tasks: tuple[LearningTask, ...] = (),
        learning_history: tuple[ArchivedLearningProject, ...] = (),
        current_goal_skill_ids: tuple[str, ...] = (),
        knowledge_cards: tuple[KnowledgeCard, ...] = (),
        recycled_projects: tuple[RecycledLearningProject, ...] = (),
        recycled_drafts: tuple[str, ...] = (),
        purged_goal_ids: tuple[str, ...] = (),
        answer_assessments: tuple[AnswerAssessment, ...] = (),
        teaching: TeachingEvolutionState | None = None,
        plan_revisions: tuple[LearningPlanRevision, ...] = (),
        hardware_feedback: HardwareFeedbackState | None = None,
        growth: GrowthState | None = None,
        learning_branches: tuple[LearningBranch, ...] = (),
        on_state_change: Callable[["LearningService"], None] | None = None,
    ) -> None:
        if not isinstance(graph, SkillGraph):
            raise TypeError("LearningService requires a SkillGraph")
        if current_goal is not None and (
            not isinstance(current_goal, str) or not current_goal.strip()
        ):
            raise ValueError("LearningService current_goal must be None or a non-empty string")
        if goal_profile is not None and not isinstance(goal_profile, GoalProfile):
            raise TypeError("goal_profile must be a GoalProfile")
        self._graph = graph
        self._current_goal = current_goal.strip() if current_goal is not None else None
        self._goal_profile = goal_profile
        self._curriculum_spine = tuple(curriculum_spine)
        self._frontier = frontier
        self._evidence = self._validate_evidence(evidence)
        self._tasks = self._validate_tasks(tasks)
        self._knowledge_cards = self._validate_knowledge_cards(knowledge_cards)
        self._learning_history = tuple(learning_history)
        if any(not isinstance(item, ArchivedLearningProject) for item in self._learning_history):
            raise TypeError("learning_history must contain ArchivedLearningProject values")
        goal_skill_ids = tuple(current_goal_skill_ids)
        if not goal_skill_ids and goal_profile is not None:
            goal_skill_ids = tuple(skill.id for skill in graph.skills)
        for skill_id in goal_skill_ids:
            graph.get_skill(skill_id)
        self._current_goal_skill_ids = goal_skill_ids
        self._on_state_change = on_state_change
        self._recycled_projects = tuple(recycled_projects)
        self._recycled_drafts = tuple(recycled_drafts)
        self._purged_goal_ids = tuple(purged_goal_ids)
        self._answer_assessments = tuple(answer_assessments)
        self._assessment_lock = RLock()
        self._growth = growth or GrowthState()
        self._learning_branches = tuple(learning_branches)
        self._hardware_feedback = HardwareFeedbackState() if hardware_feedback is None else hardware_feedback
        if not isinstance(self._hardware_feedback, HardwareFeedbackState):
            raise TypeError("hardware_feedback must be a HardwareFeedbackState")
        self._teaching = teaching or TeachingEvolutionState()
        self._plan_revisions = tuple(plan_revisions)
        if any(not isinstance(item, LearningPlanRevision) for item in self._plan_revisions):
            raise TypeError("plan_revisions must contain LearningPlanRevision values")
        if len({item.id for item in self._plan_revisions}) != len(self._plan_revisions):
            raise ValueError("Plan revision ids must be unique")
        memberships = {p.goal_profile.id: p.skill_ids for p in self._learning_history}
        memberships.update({p.project.goal_profile.id: p.project.skill_ids for p in self._recycled_projects})
        if self._goal_profile:
            memberships[self._goal_profile.id] = self._current_goal_skill_ids
            self._validate_milestone_memberships(self._curriculum_spine, self._current_goal_skill_ids)
        for project in (*self._learning_history, *(item.project for item in self._recycled_projects)):
            self._validate_milestone_memberships(project.curriculum_spine, project.skill_ids)
        seen_assessments, seen_turns, seen_topics = set(), set(), {}
        for assessment in self._answer_assessments:
            if not isinstance(assessment, AnswerAssessment) or assessment.id in seen_assessments or (assessment.source_session_id, assessment.source_turn_id) in seen_turns:
                raise ValueError("Answer assessments must have unique IDs and actual answer turns")
            if assessment.skill_id not in memberships.get(assessment.goal_id, ()) or assessment.source_task_id not in self._tasks:
                raise ValueError("Answer assessment has an unavailable Goal, Skill or source Task")
            identity = (assessment.goal_id, assessment.skill_id, assessment.topic)
            if assessment.topic_id in seen_topics and seen_topics[assessment.topic_id] != identity:
                raise ValueError("Answer assessment topic identity is inconsistent")
            source_task = self._tasks[assessment.source_task_id]
            if source_task.goal_id not in (None, assessment.goal_id):
                raise ValueError("Answer assessment source Task belongs to another Goal")
            seen_topics[assessment.topic_id] = identity
            seen_assessments.add(assessment.id)
            seen_turns.add((assessment.source_session_id, assessment.source_turn_id))
        live_ids = {p.goal_profile.id for p in self._learning_history}
        if goal_profile:
            live_ids.add(goal_profile.id)
        deleted_ids = [p.project.goal_profile.id for p in self._recycled_projects]
        if len(deleted_ids) != len(set(deleted_ids)) or live_ids.intersection(deleted_ids) or (
            set(self._purged_goal_ids).intersection(live_ids | set(deleted_ids))):
            raise ValueError("Recycled and available Goal identities must be distinct")
        for item in self._recycled_projects:
            for skill_id in item.project.skill_ids:
                graph.get_skill(skill_id)
            for task_id in item.active_task_ids:
                task = self._tasks.get(task_id)
                if task is None or task.goal_id != item.project.goal_profile.id or task.status is not TaskStatus.PAUSED:
                    raise ValueError("Recycled task recovery must reference the original paused Goal task")
        if len(goal_skill_ids) != len(set(goal_skill_ids)):
            raise ValueError("current_goal_skill_ids cannot contain duplicates")
        self._validate_teaching()
        self._validate_learning_branches()
        self._growth_refresh()

    def _validate_evidence(self, evidence: tuple[Evidence, ...]) -> dict[str, Evidence]:
        records: dict[str, Evidence] = {}
        for item in evidence:
            if not isinstance(item, Evidence):
                raise TypeError("evidence must contain Evidence values")
            if item.id in records:
                raise ValueError(f"Duplicate Evidence id: {item.id}")
            skill = self._graph.get_skill(item.skill_id)
            if item.id not in skill.evidence_ids:
                raise ValueError(f"Evidence {item.id} is not linked by Skill {item.skill_id}")
            records[item.id] = item
        return records

    def _validate_tasks(self, tasks: tuple[LearningTask, ...]) -> dict[str, LearningTask]:
        records: dict[str, LearningTask] = {}
        active_goals: set[str | None] = set()
        for item in tasks:
            if not isinstance(item, LearningTask):
                raise TypeError("tasks must contain LearningTask values")
            if item.id in records:
                raise ValueError(f"Duplicate LearningTask id: {item.id}")
            for skill_id in item.related_skill_ids:
                self._graph.get_skill(skill_id)
            if item.status is TaskStatus.ACTIVE:
                if item.goal_id in active_goals:
                    raise ValueError("Only one LearningTask may be ACTIVE per Goal")
                active_goals.add(item.goal_id)
            records[item.id] = item
        return records

    def _task_belongs_to_current_goal(self, task: LearningTask) -> bool:
        current_id = self._goal_profile.id if self._goal_profile else None
        # 迁移时无法可靠归属的旧 Task 不能因切换前台 Goal 而获得写入权限。
        return task.goal_id == current_id

    def _require_current_skill(self, skill_id: str) -> None:
        self.get_skill(skill_id)
        if self._goal_profile is not None and skill_id not in self._current_goal_skill_ids:
            raise ValueError(f"Skill {skill_id} does not belong to current Goal")

    def _require_current_task(self, task: LearningTask) -> None:
        if not self._task_belongs_to_current_goal(task):
            raise ValueError(f"LearningTask {task.id} does not belong to current Goal")
        branch = self.active_learning_branch()
        if task.branch_id != (branch.id if branch else None):
            raise ValueError("Task belongs to another learning path")

    def _validate_knowledge_cards(
        self, cards: tuple[KnowledgeCard, ...]
    ) -> dict[str, KnowledgeCard]:
        records: dict[str, KnowledgeCard] = {}
        for item in cards:
            if not isinstance(item, KnowledgeCard):
                raise TypeError("knowledge_cards must contain KnowledgeCard values")
            if item.id in records:
                raise ValueError(f"Duplicate KnowledgeCard id: {item.id}")
            # Card must reference an existing Skill; archived Skills remain valid.
            self._graph.get_skill(item.skill_id)
            records[item.id] = item
        return records

    def enable_auto_save(
        self,
        callback: Callable[["LearningService"], None],
    ) -> "LearningService":
        if not callable(callback):
            raise TypeError("auto-save callback must be callable")
        self._on_state_change = callback
        return self

    def _state_changed(self) -> None:
        # Kernel 只报告“成功发生了一次权威变更”。写到哪里、如何原子替换文件，
        # 由外层 persistence adapter 决定，Domain 不依赖 JSON 或文件系统。
        before_growth = self._growth
        self._growth_refresh()
        try:
            if self._on_state_change is not None:
                self._on_state_change(self)
        except Exception:
            self._growth = before_growth
            raise

    def ensure_state_saved(self) -> None:
        """确认当前权威快照已交给原持久化器；用于恢复跨文件回执，不产生新的学习事实。"""
        self._state_changed()

    def snapshot(self) -> LearningServiceSnapshot:
        return LearningServiceSnapshot(
            current_goal=self._current_goal,
            goal_profile=self._goal_profile,
            curriculum_spine=self._curriculum_spine,
            frontier=self._frontier,
            skills=self._graph.skills,
            evidence=tuple(self._evidence.values()),
            tasks=tuple(self._tasks.values()),
            learning_history=self._learning_history,
            current_goal_skill_ids=self._current_goal_skill_ids,
            knowledge_cards=tuple(self._knowledge_cards.values()),
            recycled_projects=self._recycled_projects,
            recycled_drafts=self._recycled_drafts,
            purged_goal_ids=self._purged_goal_ids,
            answer_assessments=self._answer_assessments,
            teaching=self._teaching,
            plan_revisions=self._plan_revisions,
            hardware_feedback=self._hardware_feedback,
            growth=self._growth,
            learning_branches=self._learning_branches,
        )

    def get_learning_overview(self, recent_evidence_limit: int = 5) -> LearningOverview:
        if not isinstance(recent_evidence_limit, int) or recent_evidence_limit < 0:
            raise ValueError("recent_evidence_limit must be a non-negative integer")
        active_task = self.get_active_task()
        current_ids = set(self._current_goal_skill_ids) if self._goal_profile else (
            {skill.id for skill in self._graph.skills if not self._skill_is_recycled(skill.id)}
            if self._current_goal is not None else set())
        evidence = tuple(item for item in self._evidence.values() if item.skill_id in current_ids)
        recent_evidence = (
            tuple(reversed(evidence[-recent_evidence_limit:]))
            if recent_evidence_limit
            else ()
        )
        return LearningOverview(
            current_goal=self._current_goal,
            goal_profile=self._goal_profile,
            curriculum_spine=self._curriculum_spine,
            current_frontier=self.active_learning_branch().frontier if self.active_learning_branch() else self._frontier,
            current_focus=active_task,
            skills=tuple(skill for skill in self._graph.skills if skill.id in current_ids),
            recent_evidence=recent_evidence,
            active_task=active_task,
            learning_history=self._learning_history,
            current_goal_skill_ids=self._current_goal_skill_ids,
            knowledge_cards=tuple(card for card in self._knowledge_cards.values() if card.skill_id in current_ids),
            recycled_goal_ids=(*self._purged_goal_ids, *(p.project.goal_profile.id for p in self._recycled_projects)),
            practice_context=project_practice(tuple(self.effective_assessment(a) for a in self._answer_assessments), self._goal_profile.id if self._goal_profile else None,
                                             active_task.related_skill_ids if active_task else ()),
            plan_revision=self.current_plan_revision,
            learning_paths=self.learning_paths(),
        )

    def get_skill_learning_context(self, skill_id: str, limit: int = 5) -> dict:
        """仅投影前台 Goal 的既有事实；卡片自评和笔记保持独立标签。"""
        if not 1 <= limit <= 10:
            raise ValueError("limit must be between 1 and 10")
        if self._goal_profile is None or skill_id not in self._current_goal_skill_ids:
            raise KeyError(f"Skill {skill_id} is not in the current Goal")
        skill = self.get_skill(skill_id)
        evidence = self.get_evidence_for_skill(skill_id)
        cards = self.get_knowledge_cards_for_skill(skill_id)
        active = self.get_active_task()
        remaining = 6000
        text_truncated = False

        def clip(value: str | None, field_limit: int) -> str | None:
            nonlocal remaining, text_truncated
            if value is None:
                return None
            length = min(len(value), field_limit, remaining)
            text_truncated |= length < len(value)
            remaining -= length
            return value[:length]

        return {
            "read_at": datetime.now(timezone.utc).isoformat(),
            "goal_id": self._goal_profile.id,
            "skill_id": skill.id,
            "skill_name": skill.name,
            "skill_state": skill.status.value,
            "target_depth": skill.target_depth.value,
            "active_task": {"id": active.id, "title": active.title, "status": active.status.value,
                            "related_skill_ids": active.related_skill_ids,
                            "is_target_skill": skill_id in active.related_skill_ids}
            if active else None,
            "evidence": [
                {"id": item.id, "type": item.evidence_type.value,
                 "claim": clip(item.description, 500), "assistance": item.assistance_level.value,
                 "source": clip(item.source, 160), "created_at": item.created_at.isoformat()}
                for item in reversed(evidence[-limit:])
            ],
            "cards": [
                {"id": card.id, "question": clip(card.question, 250),
                 "answer": clip(card.answer, 350), "self_report": card.feedback.value if card.feedback else None,
                 "learner_note": clip(card.learner_note, 250),
                 "source_conversation_id": card.source_conversation_id or "unavailable"}
                for card in reversed(cards[-limit:])
            ],
            "evidence_count": len(evidence), "card_count": len(cards),
            "answer_assessments": [{"id": a.id, "topic_id": a.topic_id, "topic": a.topic, "question": a.question[:400],
                                    "score": a.score, "max_score": 10, "summary": a.summary,
                                    "gaps": a.gaps, "assistance_level": a.assistance_level,
                                    "follow_up": a.follow_up, "created_at": a.created_at.isoformat()}
                                   for a in self.list_answer_assessments(self._goal_profile.id, skill_id=skill_id, limit=limit)],
            "evidence_truncated": len(evidence) > limit,
            "cards_truncated": len(cards) > limit,
            "text_truncated": text_truncated,
            "answer_anchor": "unavailable",
            "notice": "Evidence is a saved assessment, not guaranteed mastery; self-report and notes are not Evidence.",
        }

    def get_learning_library(self) -> LearningLibrary:
        """Project durable Goal/Skill/Evidence history without reading chat text."""
        # 学习库是 Kernel 事实的只读投影，不读取 Pi JSONL，也不从聊天内容推断 Evidence。
        projects: list[LearningLibraryProject] = []
        if self._goal_profile is not None:
            projects.append(
                self._library_project(
                    status="CURRENT",
                    goal_profile=self._goal_profile,
                    curriculum_spine=self._curriculum_spine,
                    skill_ids=self._current_goal_skill_ids,
                )
            )
        # 操作顺序：最近加入历史区的在前；回收恢复保留旧快照时间，因此不能按时间排序。
        for archived in reversed(self._learning_history):
            projects.append(
                self._library_project(
                    status="ARCHIVED",
                    goal_profile=archived.goal_profile,
                    curriculum_spine=archived.curriculum_spine,
                    skill_ids=archived.skill_ids,
                    archived_at=archived.archived_at,
                )
            )
        return LearningLibrary(projects=tuple(projects))

    def switch_goal_by_user(self, goal_id: str) -> LearningOverview:
        """Restore a saved Goal workspace; only the explicit user route calls this."""
        if self._goal_profile is not None and self._goal_profile.id == goal_id:
            return self.get_learning_overview()
        target = next((item for item in self._learning_history if item.goal_profile.id == goal_id), None)
        if target is None:
            raise KeyError(f"Unknown Goal id: {goal_id}")
        history = tuple(item for item in self._learning_history if item.goal_profile.id != goal_id)
        if self._goal_profile is not None:
            # archived_at 记录本次切出的工作区快照；不表示首次归档或学习发生时间。
            history = (*history, ArchivedLearningProject(
                goal_profile=self._goal_profile,
                curriculum_spine=self._curriculum_spine,
                skill_ids=self._current_goal_skill_ids,
                frontier=self._frontier,
            ))
        # 历史项目仍引用同一份 Skill/Evidence 事实；切换只改前台工作区。
        self._learning_history = history
        self._goal_profile = target.goal_profile
        self._current_goal = target.goal_profile.goal_description
        self._curriculum_spine = target.curriculum_spine
        self._current_goal_skill_ids = target.skill_ids
        self._frontier = target.frontier
        self._state_changed()
        return self.get_learning_overview()

    def scope_is_available(self, scope: str) -> bool:
        """资料、解析和回读共用 Kernel 的回收权限，不能靠索引缓存重新授予访问。"""
        return scope not in self._recycled_drafts and scope not in self._purged_goal_ids and not any(
            item.project.goal_profile.id == scope for item in self._recycled_projects)

    def _skill_is_recycled(self, skill_id: str) -> bool:
        recycled = any(skill_id in p.project.skill_ids for p in self._recycled_projects)
        available = skill_id in self._current_goal_skill_ids or any(
            skill_id in p.skill_ids for p in self._learning_history)
        return recycled and not available

    def _commit_recycle(self, before: dict) -> None:
        # 写盘失败必须回滚内存；否则 API 报错后用户仍会失去原工作区。
        try:
            self._state_changed()
        except Exception:
            self.__dict__.update(before)
            raise

    def recycle_goal_by_user(self, goal_id: str) -> RecycledLearningProject:
        existing = next((p for p in self._recycled_projects if p.project.goal_profile.id == goal_id), None)
        if existing:
            return existing
        before = self.__dict__.copy()
        current = self._goal_profile is not None and self._goal_profile.id == goal_id
        project = (ArchivedLearningProject(self._goal_profile, self._curriculum_spine,
                   self._current_goal_skill_ids, frontier=self._frontier) if current else
                   next((p for p in self._learning_history if p.goal_profile.id == goal_id), None))
        if project is None:
            raise KeyError(f"Unknown Goal id: {goal_id}")
        active = tuple(t.id for t in self._tasks.values() if t.goal_id == goal_id and t.status is TaskStatus.ACTIVE)
        recycled = RecycledLearningProject(project, active_task_ids=active)
        self._tasks = {key: t.pause() if key in active else t for key, t in self._tasks.items()}
        self._learning_history = tuple(p for p in self._learning_history if p.goal_profile.id != goal_id)
        self._recycled_projects = (*self._recycled_projects, recycled)
        if current:
            target = self._learning_history[-1] if self._learning_history else None
            if target:
                self._learning_history = self._learning_history[:-1]
            self._goal_profile = target.goal_profile if target else None
            self._current_goal = target.goal_profile.goal_description if target else None
            self._curriculum_spine = target.curriculum_spine if target else ()
            self._current_goal_skill_ids = target.skill_ids if target else ()
            self._frontier = target.frontier if target else None
        self._commit_recycle(before)
        return recycled

    def restore_goal_by_user(self, goal_id: str) -> None:
        item = next((p for p in self._recycled_projects if p.project.goal_profile.id == goal_id), None)
        if item is None:
            if any(p.goal_profile.id == goal_id for p in self.get_learning_library().projects):
                return  # HTTP 重试不重复添加项目或重置学习状态。
            raise KeyError(f"Unknown recycled Goal id: {goal_id}")
        if item.purge_started:
            raise ValueError("永久删除已经开始，请重试永久删除以完成剩余处理。")
        before = self.__dict__.copy()
        self._learning_history = (*self._learning_history, item.project)
        self._recycled_projects = tuple(p for p in self._recycled_projects if p is not item)
        self._tasks = {key: t.activate() if key in item.active_task_ids and t.status is TaskStatus.PAUSED else t
                       for key, t in self._tasks.items()}
        self._commit_recycle(before)

    def recycle_draft_by_user(self, scope: str, *, restore: bool = False) -> None:
        if not scope.startswith("draft:"):
            raise ValueError("Only unbound drafts use this operation")
        before = self.__dict__.copy()
        scopes = set(self._recycled_drafts)
        scopes.discard(scope) if restore else scopes.add(scope)
        self._recycled_drafts = tuple(sorted(scopes))
        self._commit_recycle(before)

    def purge_goal_by_user(self, goal_id: str) -> None:
        item = next((p for p in self._recycled_projects if p.project.goal_profile.id == goal_id), None)
        if item is None:
            raise KeyError(f"Unknown recycled Goal id: {goal_id}")
        before = self.__dict__.copy()
        self._recycled_projects = tuple(p for p in self._recycled_projects if p is not item)
        # 只保留被销毁的身份，旧共享对话或迟到请求不能重新激活它；不保留学习内容。
        self._purged_goal_ids = (*self._purged_goal_ids, goal_id)
        self._learning_branches = tuple(b for b in self._learning_branches if b.goal_id != goal_id)
        growth = self._growth_data()
        growth["adoptions"] = {k: a for k, a in growth["adoptions"].items() if a["recommendation"].get("goal_id") != goal_id}
        self._growth = type(self._growth).from_json(growth)
        # Shared Skill / prerequisites protect other goals (including other recycle items).
        # Evidence 属于 Skill 的真实事实；不能因一个目标永久删除而破坏其他目标。
        keep = set(self._current_goal_skill_ids)
        for p in self._learning_history:
            keep.update(p.skill_ids)
        for p in self._recycled_projects:
            keep.update(p.project.skill_ids)
        for t in self._tasks.values():
            if t.goal_id != goal_id:
                keep.update(t.related_skill_ids)
        candidates = set(item.project.skill_ids)
        keep.update(s.id for s in self._graph.skills if s.id not in candidates)
        stack = list(keep)
        while stack:
            for prerequisite in self._graph.get_skill(stack.pop()).prerequisites:
                if prerequisite not in keep:
                    keep.add(prerequisite)
                    stack.append(prerequisite)
        removed = candidates - keep
        self._graph = SkillGraph(s for s in self._graph.skills if s.id not in removed)
        self._tasks = {k: t for k, t in self._tasks.items() if t.goal_id != goal_id}
        self._evidence = {k: e for k, e in self._evidence.items() if e.skill_id not in removed}
        self._knowledge_cards = {k: c for k, c in self._knowledge_cards.items() if c.skill_id not in removed}
        self._purge_teaching_goal(goal_id)
        self._plan_revisions = tuple(item for item in self._plan_revisions if item.goal_id != goal_id)
        self._answer_assessments = tuple(a for a in self._answer_assessments if a.goal_id != goal_id)
        self._commit_recycle(before)

    def begin_goal_purge_by_user(self, goal_id: str) -> None:
        item = next((p for p in self._recycled_projects if p.project.goal_profile.id == goal_id), None)
        if item is None:
            raise KeyError(f"Unknown recycled Goal id: {goal_id}")
        if item.purge_started:
            return
        before = self.__dict__.copy()
        self._recycled_projects = tuple(replace(p, purge_started=True) if p is item else p for p in self._recycled_projects)
        self._commit_recycle(before)

    def _library_project(
        self,
        *,
        status: str,
        goal_profile: GoalProfile,
        curriculum_spine: tuple[CurriculumMilestone, ...],
        skill_ids: tuple[str, ...],
        archived_at: datetime | None = None,
    ) -> LearningLibraryProject:
        skills = tuple(self._graph.get_skill(skill_id) for skill_id in skill_ids)
        evidence = tuple(
            self.get_evidence(evidence_id)
            for skill in skills
            for evidence_id in skill.evidence_ids
        )
        # Knowledge Cards are a separate durable asset class, never merged with Evidence.
        cards = tuple(
            card
            for card in self._knowledge_cards.values()
            if card.skill_id in skill_ids
        )
        return LearningLibraryProject(
            status=status,
            goal_profile=goal_profile,
            curriculum_spine=curriculum_spine,
            skills=skills,
            evidence=evidence,
            knowledge_cards=cards,
            archived_at=archived_at,
            answer_assessments=tuple(self.effective_assessment(a) for a in self._answer_assessments if a.goal_id == goal_profile.id),
            assessment_count=sum(a.goal_id == goal_profile.id for a in self._answer_assessments),
        )

    def record_answer_assessment(self, assessment: AnswerAssessment, *, topic_aliases: tuple[str, ...] = ()) -> AnswerAssessment:
        """保存一次真实作答；旧知识点复测只归原Skill，不触碰当前Task/Evidence。"""
        if not isinstance(assessment, AnswerAssessment):
            raise TypeError("An AnswerAssessment is required")
        with self._assessment_lock:
            self._check_contract(assessment)
            existing = next((a for a in self._answer_assessments if a.id == assessment.id or
                             (a.source_session_id, a.source_turn_id) == (assessment.source_session_id, assessment.source_turn_id)), None)
            if existing:
                anchor = ("goal_id", "source_session_id", "source_turn_id", "question_entry_id", "question", "answer_sha256")
                if any(getattr(existing, k) != getattr(assessment, k) for k in anchor):
                    raise ValueError("Assessment retry conflicts with the saved answer provenance")
                return existing  # 首次已保存的评分冻结；工具重试不能改分或重复排队。
            task = self.get_active_task()
            if not self._goal_profile or assessment.goal_id != self._goal_profile.id or not task or task.id != assessment.source_task_id:
                raise ValueError("Assessment must belong to the current Goal and ACTIVE source Task")
            if assessment.skill_id not in self._current_goal_skill_ids:
                raise ValueError("Assessment Skill is outside the current Goal")
            from app.domain.assessment_topic import topic_catalog, resolve_topic
            catalog = topic_catalog(self._answer_assessments, self._teaching.topics)
            topic = next((v for v in catalog if v.id == assessment.topic_id), None)
            if not topic and (assessment.skill_id not in task.related_skill_ids or assessment.topic_id != assessment_topic_id(assessment.goal_id, assessment.skill_id, assessment.topic)):
                raise ValueError("A new assessment topic must belong to the ACTIVE Task Skill")
            if len(topic_aliases) > 6:
                raise ValueError("At most 6 aliases may be added per assessment")
            assessment, topics = resolve_topic(catalog, assessment, topic_aliases)
            before, before_teaching = self._answer_assessments, self._teaching
            self._answer_assessments = (*before, assessment)
            self._teaching = replace(self._teaching, topics=topics)
            try:
                self._state_changed()
            except Exception:
                self._answer_assessments = before
                self._teaching = before_teaching
                raise
            return assessment

    def list_answer_assessments(self, goal_id: str, *, skill_id: str | None = None,
                                offset: int = 0, limit: int = 20) -> tuple[AnswerAssessment, ...]:
        available = {p.goal_profile.id for p in self._learning_history}
        if self._goal_profile:
            available.add(self._goal_profile.id)
        if goal_id not in available:
            raise KeyError("Assessment Goal is unavailable")
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("Assessment page requires offset >= 0 and 1 <= limit <= 100")
        records = [a for a in reversed(self._answer_assessments) if a.goal_id == goal_id and (skill_id is None or a.skill_id == skill_id)]
        return tuple(self.effective_assessment(a) for a in records[offset:offset + limit])

    def get_answer_assessment(self, goal_id: str, assessment_id: str) -> AnswerAssessment:
        """按权威身份核验未知写入结果；不创建、重批或跨目标借用成绩。"""
        with self._assessment_lock:
            available = {p.goal_profile.id for p in self._learning_history}
            if self._goal_profile:
                available.add(self._goal_profile.id)
            if goal_id not in available:
                raise KeyError("Assessment Goal is unavailable")
            record = next((a for a in self._answer_assessments if a.goal_id == goal_id and a.id == assessment_id), None)
            if record is None:
                raise KeyError("Assessment is unavailable in this Goal")
            # 同写入锁等待原评分提交/回滚；仅内存append不能作为“已保存”的权威回执。
            self.ensure_state_saved()
            return record

    def get_current_plan(self) -> LearningPlan | None:
        if self._goal_profile is None or self._frontier is None:
            return None
        return LearningPlan(
            goal_profile=self._goal_profile,
            curriculum_spine=self._curriculum_spine,
            frontier=self._frontier,
        )

    def initialize_curriculum(
        self,
        goal_profile: GoalProfile,
        curriculum_spine: tuple[CurriculumMilestone, ...],
        frontier_skills: tuple[SkillNode, ...],
        frontier: FrontierPlan,
        *,
        replace_existing: bool = False,
    ) -> LearningPlan:
        """Atomically install a confirmed Goal and its initial working curriculum."""
        if not isinstance(goal_profile, GoalProfile):
            raise TypeError("initialize_curriculum requires a GoalProfile")
        if self.active_learning_branch() and self._goal_profile.id == goal_profile.id:
            raise ValueError("Branch teaching cannot reinitialize the main curriculum")
        continuing_import = bool(self._goal_profile and self._goal_profile.id == goal_profile.id
                                 and self.growth_needs_route(goal_profile.id))
        if not self.scope_is_available(goal_profile.id) or any(p.goal_profile.id == goal_profile.id for p in self._learning_history):
            raise ValueError("Goal identity already belongs to a saved workspace")
        if any(self._skill_is_recycled(skill.id) for skill in frontier_skills):
            raise ValueError("Recycled Skill identities must be restored before reuse")
        if self._current_goal is not None and not replace_existing:
            raise ValueError("An active Learning Goal already exists")

        plan = LearningPlan(goal_profile, tuple(curriculum_spine), frontier)
        goal_skill_ids = tuple(dict.fromkeys([*(self._current_goal_skill_ids if continuing_import else ()), *(s.id for s in frontier_skills)]))
        self._validate_milestone_memberships(plan.curriculum_spine, goal_skill_ids)
        self._protect_branch_membership(goal_profile.id, goal_skill_ids, plan.curriculum_spine)
        if continuing_import:
            existing_ids = {s.id for s in self._graph.skills}
            if any(s.id in existing_ids and s.id not in self._current_goal_skill_ids for s in frontier_skills):
                raise ValueError("Imported Goal cannot reuse another Goal's Skill identity")
        proposed = {skill.id: skill for skill in frontier_skills}

        # Goal 切换后旧工作区还可恢复，因此旧 Skill（含未开始节点）都必须保留。
        if replace_existing or self._learning_history or self._recycled_projects:
            for existing in self._graph.skills:
                proposed[existing.id] = existing

        candidate_graph = SkillGraph(proposed.values())
        self._validate_frontier(plan.frontier, candidate_graph)

        # 与原评分事务保持一致：持久化失败不能让overview/学习库泄漏仅在内存生效的新目标。
        before = self.__dict__.copy()
        self._tasks = dict(self._tasks)
        history = self._learning_history
        if replace_existing and self._goal_profile is not None and not continuing_import:
            # V1 tasks had no Goal ID. Before replacing, pin the tasks that only
            # the outgoing Goal could own, especially its ACTIVE task.
            for task_id, task in tuple(self._tasks.items()):
                if task.goal_id is None and set(task.related_skill_ids).issubset(self._current_goal_skill_ids):
                    self._tasks[task_id] = replace(task, goal_id=self._goal_profile.id)
            # 完整保存旧路线的 Skill/Frontier；返回时不重新推断或重规划。
            history = (
                *history,
                ArchivedLearningProject(
                    goal_profile=self._goal_profile,
                    curriculum_spine=self._curriculum_spine,
                    skill_ids=self._current_goal_skill_ids,
                    frontier=self._frontier,
                ),
            )

        self._graph = candidate_graph
        self._goal_profile = goal_profile
        self._current_goal = goal_profile.goal_description
        self._curriculum_spine = plan.curriculum_spine
        self._frontier = plan.frontier
        self._learning_history = history
        # 首次为导入目标补路线只扩展归属，不归档/复制同一目标，也不覆盖已导入知识点。
        self._current_goal_skill_ids = goal_skill_ids
        try:
            self._state_changed()
        except Exception:
            self.__dict__.update(before)
            raise
        return plan

    @staticmethod
    def _validate_frontier(frontier: FrontierPlan, graph: SkillGraph) -> None:
        graph.get_skill(frontier.focus_skill_id)
        for skill_id in frontier.supporting_skill_ids:
            graph.get_skill(skill_id)

    @staticmethod
    def _validate_milestone_memberships(
        spine: tuple[CurriculumMilestone, ...],
        goal_skill_ids: tuple[str, ...],
    ) -> None:
        available, assigned = set(goal_skill_ids), set()
        for milestone in spine:
            for skill_id in milestone.skill_ids:
                if skill_id not in available:
                    raise ValueError(f"Milestone Skill {skill_id} does not belong to the current Goal")
                if skill_id in assigned:
                    raise ValueError(f"Skill {skill_id} cannot belong to multiple milestones in one Goal")
                assigned.add(skill_id)

    def update_frontier(self, frontier: FrontierPlan) -> FrontierPlan:
        """Apply a planning decision without starting a LearningTask."""
        if self.active_learning_branch():
            return self._apply_branch_frontier(frontier)
        if self._goal_profile and frontier.focus_skill_id not in self.learning_paths()["main_skill_ids"]:
            raise ValueError("Enter the branch before focusing a branch-only Skill")
        self._validate_frontier(frontier, self._graph)
        self._require_current_skill(frontier.focus_skill_id)
        self._frontier = frontier
        self._state_changed()
        return frontier

    def apply_frontier_plan(
        self,
        frontier: FrontierPlan,
        *,
        added_skills: tuple[SkillNode, ...] = (),
        depth_changes: tuple[tuple[str, LearningDepth], ...] = (),
        prerequisite_additions: tuple[tuple[str, str], ...] = (),
        remove_skill_ids: tuple[str, ...] = (),
        milestone_assignments: tuple[tuple[str, str], ...] = (),
    ) -> FrontierPlan:
        """Atomically revise the unlearned edge of the curriculum.

        The planner may reshape future work, but it must never rewrite the
        identity, state, prerequisites or target depth of learning history.
        """
        if self._goal_profile is None:
            raise ValueError("Cannot revise a frontier before Goal initialization")
        if self.active_learning_branch():
            if depth_changes or prerequisite_additions or remove_skill_ids or milestone_assignments:
                raise ValueError("Branch teaching cannot rewrite the main curriculum; extend its own Frontier")
            return self._apply_branch_frontier(frontier, added_skills)
        if any(
            item.goal_id == self._goal_profile.id and item.status == "PENDING"
            for item in self._plan_revisions
        ):
            raise ValueError("A complete plan revision is pending; confirm or reject it before changing the Frontier")
        nodes = {skill.id: skill for skill in self._graph.skills}

        def require_future(skill_id: str) -> SkillNode:
            self._require_current_skill(skill_id)
            if any(skill_id in project.skill_ids for project in self._learning_history):
                raise ValueError(f"Cannot revise Skill {skill_id} because another Goal still references it")
            try:
                skill = nodes[skill_id]
            except KeyError as error:
                raise KeyError(f"Unknown Skill id: {skill_id}") from error
            # 已开始学习或已有 Evidence 的节点属于不可改写的学习历史。
            # Frontier 重规划只能调整未来的 NOT_STARTED 节点。
            if skill.status is not SkillState.NOT_STARTED or skill.evidence_ids:
                raise ValueError(
                    f"Cannot revise Skill {skill_id} because it has learning history"
                )
            return skill

        for skill in added_skills:
            if not isinstance(skill, SkillNode):
                raise TypeError("added_skills accepts only SkillNode objects")
            if skill.id in nodes:
                raise ValueError(f"Duplicate Skill id: {skill.id}")
            nodes[skill.id] = skill

        for skill_id, target_depth in depth_changes:
            if not isinstance(target_depth, LearningDepth):
                raise TypeError("target_depth must be a LearningDepth")
            skill = require_future(skill_id)
            nodes[skill_id] = replace(skill, target_depth=target_depth)

        for skill_id, prerequisite_id in prerequisite_additions:
            skill = require_future(skill_id)
            if prerequisite_id not in nodes:
                raise KeyError(f"Unknown Skill id: {prerequisite_id}")
            if prerequisite_id not in skill.prerequisites:
                nodes[skill_id] = replace(
                    skill,
                    prerequisites=(*skill.prerequisites, prerequisite_id),
                )

        for skill_id in remove_skill_ids:
            require_future(skill_id)
            del nodes[skill_id]

        # 先在临时候选图完成缺失依赖、环和 Frontier 引用校验；
        # 所有校验通过后才替换权威状态，避免半成功的课程修订。
        candidate_graph = SkillGraph(nodes.values())
        self._validate_frontier(frontier, candidate_graph)
        if frontier.focus_skill_id not in (*self._current_goal_skill_ids, *(skill.id for skill in added_skills)):
            raise ValueError("Frontier focus does not belong to current Goal")
        if any(frontier.focus_skill_id in b.exclusive_skill_ids for b in self._learning_branches):
            raise ValueError("Main Frontier cannot focus a branch-only Skill")
        current_ids = set(self._current_goal_skill_ids)
        current_ids.update(skill.id for skill in added_skills)
        current_ids.difference_update(remove_skill_ids)
        goal_skill_ids = tuple(
            skill.id for skill in candidate_graph.skills if skill.id in current_ids
        )
        assignments = dict(milestone_assignments)
        if len(assignments) != len(milestone_assignments):
            raise ValueError("Milestone assignments must contain each Skill only once")
        milestone_ids = {item.id for item in self._curriculum_spine}
        for skill_id, milestone_id in assignments.items():
            if skill_id not in current_ids:
                raise ValueError(f"Milestone Skill {skill_id} does not belong to the current Goal")
            if milestone_id not in milestone_ids:
                raise ValueError(f"Unknown curriculum milestone: {milestone_id}")
        # 在候选Spine中移出旧归属再插入新归属；不碰原Skill/Evidence/Mastery或其他Goal。
        spine = tuple(
            replace(item, skill_ids=tuple(
                skill_id for skill_id in item.skill_ids
                if skill_id in current_ids and (skill_id not in assignments or assignments[skill_id] == item.id)
            ) + tuple(skill_id for skill_id, milestone_id in assignments.items()
                      if milestone_id == item.id and skill_id not in item.skill_ids))
            for item in self._curriculum_spine
        )
        self._validate_milestone_memberships(spine, goal_skill_ids)
        self._protect_branch_membership(self._goal_profile.id, goal_skill_ids, spine)
        before = self.__dict__.copy()
        try:
            self._graph = candidate_graph
            self._frontier = frontier
            self._current_goal_skill_ids = goal_skill_ids
            self._curriculum_spine = spine
            self._state_changed()
        except Exception:
            self.__dict__.clear()
            self.__dict__.update(before)
            raise
        return frontier

    def _learning_plan_signature(self) -> str:
        """Bind a revision to the complete plan state that produced it."""
        value = {
            "goal": {key: value for key, value in asdict(self._goal_profile).items()
                     if key != "learning_domain" or value} if self._goal_profile else None,
            # 空归属兼容旧版签名，不能仅因新增默认字段使已保存的用户确认候选失效。
            "spine": [
                {key: value for key, value in asdict(item).items() if key != "skill_ids" or value}
                for item in self._curriculum_spine
            ],
            # 偏好版本是派生教法的来源，不是课程本体；兼容升级前已确认/待确认计划的签名。
            "frontier": {key: value for key, value in asdict(self._frontier).items()
                         if key != "teaching_preferences_revision"} if self._frontier else None,
            "skills": [asdict(item) for item in self._graph.skills],
            "current_goal_skill_ids": list(self._current_goal_skill_ids),
            # 活动安排不改路线本体；空字段也不能使升级前已保存的路线签名失效。
            "active_task": {key: value for key, value in asdict(self.get_active_task()).items()
                            if key not in {"teaching_activity", "activity_revision"} and (key != "branch_id" or value)}
            if self.get_active_task() else None,
        }
        return sha256(json.dumps(value, default=str, sort_keys=True).encode("utf-8")).hexdigest()

    @property
    def current_plan_revision(self) -> int:
        if self._goal_profile is None:
            return 0
        return max(
            (
                item.revision
                for item in self._plan_revisions
                if item.goal_id == self._goal_profile.id and item.status == "CONFIRMED"
            ),
            default=0,
        )

    def get_plan_revision(self, revision_id: str) -> LearningPlanRevision:
        try:
            return next(item for item in self._plan_revisions if item.id == revision_id)
        except StopIteration as error:
            raise KeyError(f"Unknown plan revision: {revision_id}") from error

    def _preview_plan_revision(
        self,
        revision: LearningPlanRevision,
    ) -> tuple[SkillGraph, tuple[str, ...]]:
        """Validate and build the candidate graph without mutating authority."""
        if self._goal_profile is None or self._frontier is None:
            raise ValueError("Cannot revise a plan before Goal initialization")
        if revision.goal_id != self._goal_profile.id:
            raise ValueError("Plan revision must keep the current Goal identity")

        nodes = {skill.id: skill for skill in self._graph.skills}

        def require_future(skill_id: str) -> SkillNode:
            self._require_current_skill(skill_id)
            if any(skill_id in project.skill_ids for project in self._learning_history):
                raise ValueError(
                    f"Cannot revise Skill {skill_id} because another Goal still references it"
                )
            try:
                skill = nodes[skill_id]
            except KeyError as error:
                raise KeyError(f"Unknown Skill id: {skill_id}") from error
            if skill.status is not SkillState.NOT_STARTED or skill.evidence_ids:
                raise ValueError(
                    f"Cannot revise Skill {skill_id} because it has learning history"
                )
            return skill

        for skill in revision.updated_skills:
            old = require_future(skill.id)
            nodes[skill.id] = replace(
                old,
                name=skill.name,
                description=skill.description,
                prerequisites=skill.prerequisites,
                target_depth=skill.target_depth,
            )

        for skill in revision.added_skills:
            if skill.id in nodes:
                raise ValueError(f"Duplicate Skill id: {skill.id}")
            nodes[skill.id] = skill

        for skill_id in revision.remove_skill_ids:
            require_future(skill_id)
            del nodes[skill_id]

        candidate_graph = SkillGraph(nodes.values())
        self._validate_frontier(revision.frontier, candidate_graph)
        current_ids = [
            skill_id
            for skill_id in self._current_goal_skill_ids
            if skill_id not in revision.remove_skill_ids
        ]
        current_ids.extend(skill.id for skill in revision.added_skills if skill.id not in current_ids)
        current = tuple(skill.id for skill in candidate_graph.skills if skill.id in set(current_ids))
        if revision.frontier.focus_skill_id not in current:
            raise ValueError("Plan revision Frontier focus does not belong to the current Goal")
        if any(revision.frontier.focus_skill_id in b.exclusive_skill_ids for b in self._learning_branches):
            raise ValueError("Main Frontier cannot focus a branch-only Skill")
        active_task = self.get_active_task()
        if active_task and any(skill_id not in current for skill_id in active_task.related_skill_ids):
            raise ValueError("Plan revision cannot detach the ACTIVE Task from its Skill")
        # Constructing LearningPlan reuses the canonical Spine validation.
        LearningPlan(revision.goal_profile, revision.curriculum_spine, revision.frontier)
        self._validate_milestone_memberships(revision.curriculum_spine, current)
        self._protect_branch_membership(revision.goal_id, current, revision.curriculum_spine)
        previously_assigned = {
            skill_id for item in self._curriculum_spine for skill_id in item.skill_ids
        } - set(revision.remove_skill_ids)
        proposed_assignments = {
            skill_id for item in revision.curriculum_spine for skill_id in item.skill_ids
        }
        # 完整替换路线不能因省略新字段把既有知识点悄悄剥离；删阶段时须迁移仍保留的知识点。
        if previously_assigned - proposed_assignments:
            raise ValueError("Plan revision must retain a milestone assignment for every previously assigned Skill that remains in the Goal")
        return candidate_graph, current

    def _revision_summary(
        self,
        revision: LearningPlanRevision,
        *,
        goal_changed: bool,
        spine_changed: bool,
    ) -> str:
        changes: list[str] = []
        if goal_changed:
            previous = self._goal_profile.desired_outcome.strip()
            proposed = revision.goal_profile.desired_outcome.strip()
            previous_domain = self._goal_profile.learning_domain
            proposed_domain = revision.goal_profile.learning_domain
            if previous_domain != proposed_domain:
                changes.append(f"学习领域：{previous_domain or '未设定'} → {proposed_domain or '未设定'}；领域策略按新范围使用")
            if previous != proposed:
                changes.append(f"学习结果：{previous[:180]} → {proposed[:180]}")
            elif previous_domain == proposed_domain:
                changes.append("更新学习背景或目标安排")
        if spine_changed:
            before = {skill_id: item.id for item in self._curriculum_spine for skill_id in item.skill_ids}
            after = {skill_id: item.id for item in revision.curriculum_spine for skill_id in item.skill_ids}
            changed = sum(before.get(skill_id) != after.get(skill_id) for skill_id in before.keys() | after.keys())
            if changed:
                changes.append(f"知识点归属整理 {changed} 项")
            # 只整理阶段内的知识点时不重复整条同名路线，但独立确认必须看见归属发生变化。
            previous_stages = tuple((item.id, item.name, item.description, item.target_depth) for item in self._curriculum_spine)
            proposed_stages = tuple((item.id, item.name, item.description, item.target_depth) for item in revision.curriculum_spine)
            if previous_stages != proposed_stages:
                names = " → ".join(item.name[:80] for item in revision.curriculum_spine)
                changes.append(f"阶段里程碑：{names[:600]}")
        skill_name = {
            skill.id: skill.name for skill in (*self._graph.skills, *revision.added_skills, *revision.updated_skills)
        }
        if revision.added_skills:
            changes.append("新增知识点：" + "、".join(skill.name[:80] for skill in revision.added_skills[:6]))
        if revision.updated_skills:
            changes.append("更新知识点：" + "、".join(skill.name[:80] for skill in revision.updated_skills[:6]))
        if revision.remove_skill_ids:
            changes.append("移除未学习知识点：" + "、".join(
                skill_name.get(skill_id, skill_id)[:80] for skill_id in revision.remove_skill_ids[:6]
            ))
        if self._frontier != revision.frontier or revision.frontier.focus_skill_id not in {
            skill.id for skill in self._graph.skills
        }:
            changes.append(f"当前聚焦：{skill_name.get(revision.frontier.focus_skill_id, revision.frontier.focus_skill_id)}".replace("\n", " "))
        return "；".join(changes)[:1600] or "更新当前学习计划"

    def prepare_plan_revision(
        self,
        *,
        curriculum_spine: tuple[CurriculumMilestone, ...],
        added_skills: tuple[SkillNode, ...],
        updated_skills: tuple[SkillNode, ...],
        remove_skill_ids: tuple[str, ...],
        frontier: FrontierPlan,
        goal_profile: GoalProfile,
        reason: str,
        revision_id: str | None = None,
    ) -> LearningPlanRevision:
        """Persist a pending cross-layer revision without changing learning facts."""
        if self.active_learning_branch():
            raise ValueError("Return to the main path before revising its curriculum")
        if self._goal_profile is None or self._frontier is None:
            raise ValueError("Cannot revise a plan before Goal initialization")
        if goal_profile.id != self._goal_profile.id:
            raise ValueError("Plan revision must keep the current Goal identity")
        # 老客户端省略领域不得清掉已确认范围；更换具体领域仍走完整路线候选和用户确认。
        goal_profile = replace(goal_profile, created_at=self._goal_profile.created_at,
                               learning_domain=goal_profile.learning_domain or self._goal_profile.learning_domain)
        base_signature = self._learning_plan_signature()
        base_revision = self.current_plan_revision
        revision_number = base_revision + 1
        identity = revision_id or (
            "plan-revision-"
            + sha256(
                json.dumps(
                    [self._goal_profile.id, base_revision, reason, base_signature],
                    ensure_ascii=False,
                ).encode("utf-8")
            ).hexdigest()[:32]
        )
        goal_changed = goal_profile != self._goal_profile
        spine_changed = tuple(curriculum_spine) != self._curriculum_spine
        if not any(
            (
                goal_changed,
                spine_changed,
                bool(added_skills),
                bool(updated_skills),
                bool(remove_skill_ids),
                frontier != self._frontier,
            )
        ):
            raise ValueError("Plan revision does not change the current plan")
        placeholder = LearningPlanRevision(
            identity,
            goal_profile.id,
            base_revision,
            revision_number,
            base_signature,
            goal_profile,
            tuple(curriculum_spine),
            tuple(added_skills),
            tuple(updated_skills),
            tuple(remove_skill_ids),
            frontier,
            "pending",
            reason,
        )
        existing = next((item for item in self._plan_revisions if item.id == identity), None)
        if existing is not None:
            comparable = lambda item: (
                item.goal_id, item.base_revision, item.base_signature, item.goal_profile,
                item.curriculum_spine, item.added_skills, item.updated_skills,
                item.remove_skill_ids, item.frontier, item.reason,
            )
            if existing.status == "PENDING" and comparable(existing) == comparable(placeholder):
                return existing
            raise ValueError("Plan revision identity was already used for another proposal")
        self._preview_plan_revision(placeholder)
        revision = replace(
            placeholder,
            summary=self._revision_summary(
                placeholder,
                goal_changed=goal_changed,
                spine_changed=spine_changed,
            ),
        )
        with self._assessment_lock:
            before = self.__dict__.copy()
            decided_at = datetime.now(timezone.utc)
            revisions = tuple(
                replace(
                    item,
                    status="SUPERSEDED",
                    feedback="已由新的计划修订替代",
                    decided_at=decided_at,
                )
                if item.goal_id == goal_profile.id and item.status == "PENDING"
                else item
                for item in self._plan_revisions
            )
            try:
                self._plan_revisions = (*revisions, revision)
                self._state_changed()
            except Exception:
                self.__dict__.clear()
                self.__dict__.update(before)
                raise
        return revision

    def decide_plan_revision(
        self,
        revision_id: str,
        *,
        action: str,
        feedback: str,
        request_id: str,
    ) -> LearningPlanRevision:
        """Confirm or reject a pending revision with retry-safe decision identity."""
        if self.active_learning_branch():
            raise ValueError("Return to the main path before deciding its curriculum revision")
        if action not in {"CONFIRM", "REJECT"}:
            raise ValueError("Invalid plan revision decision")
        if not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 200:
            raise ValueError("Plan revision requires a bounded request identity")
        if action == "CONFIRM" and feedback.strip():
            raise ValueError("Supplemental feedback is not confirmation")
        with self._assessment_lock:
            revision = self.get_plan_revision(revision_id)
            expected_status = "CONFIRMED" if action == "CONFIRM" else "REJECTED"
            if revision.status == expected_status:
                if revision.decision_request_id == request_id and revision.feedback == feedback:
                    return revision
                raise ValueError("Plan revision already received a different decision")
            if revision.status != "PENDING":
                raise ValueError("This plan revision is no longer pending")
            if revision.goal_id != (self._goal_profile.id if self._goal_profile else None):
                raise ValueError("Plan revision Goal is no longer active")
            if revision.base_signature != self._learning_plan_signature():
                raise ValueError("Plan changed after this revision was prepared; reload and prepare a new revision")

            decided = replace(
                revision,
                status=expected_status,
                feedback=feedback,
                decision_request_id=request_id,
                decided_at=datetime.now(timezone.utc),
            )
            revisions = tuple(
                decided if item.id == revision.id else item for item in self._plan_revisions
            )
            if action == "REJECT":
                before = self.__dict__.copy()
                try:
                    self._plan_revisions = revisions
                    self._state_changed()
                except Exception:
                    self.__dict__.clear()
                    self.__dict__.update(before)
                    raise
                return decided

            candidate_graph, current_ids = self._preview_plan_revision(revision)
            updated = replace(
                decided,
                goal_profile=revision.goal_profile,
                curriculum_spine=revision.curriculum_spine,
                frontier=revision.frontier,
            )
            revisions = tuple(
                updated if item.id == revision.id else item for item in self._plan_revisions
            )
            # Publish one complete successor state. The persistence callback runs
            # only after every dependent field has passed validation.
            before = self.__dict__.copy()
            try:
                self._graph = candidate_graph
                self._goal_profile = revision.goal_profile
                self._current_goal = revision.goal_profile.goal_description
                self._curriculum_spine = revision.curriculum_spine
                self._frontier = revision.frontier
                self._current_goal_skill_ids = current_ids
                self._plan_revisions = revisions
                self._state_changed()
            except Exception:
                self.__dict__.clear()
                self.__dict__.update(before)
                raise
            return updated

    def change_future_skill_depth(
        self,
        skill_id: str,
        target_depth: LearningDepth,
    ) -> SkillNode:
        if self.active_learning_branch():
            raise ValueError("Return to the main path before changing curriculum depth")
        if not isinstance(target_depth, LearningDepth):
            raise TypeError("target_depth must be a LearningDepth")
        self._require_current_skill(skill_id)
        skill = self.get_skill(skill_id)
        # 已开始或已有 Evidence 的 Skill 是学习历史，不允许规划器静默改写。
        if skill.status is not SkillState.NOT_STARTED or skill.evidence_ids:
            raise ValueError("Cannot change target depth for a Skill with learning history")
        updated = replace(skill, target_depth=target_depth)
        self._graph = self._graph.replace_skill(updated)
        self._state_changed()
        return updated

    def get_skill(self, skill_id: str) -> SkillNode:
        if self._skill_is_recycled(skill_id):
            raise KeyError(f"Skill {skill_id} belongs to a recycled Goal")
        return self._graph.get_skill(skill_id)

    def submit_evidence(self, evidence: Evidence) -> SkillNode:
        """Persist live teaching Evidence only for the current Goal's ACTIVE Task."""
        if not isinstance(evidence, Evidence):
            raise TypeError("submit_evidence requires an Evidence object")
        self._require_current_skill(evidence.skill_id)
        self.get_skill(evidence.skill_id)
        if self._goal_profile is not None:
            # Evidence 可在一个教学片段末尾批量提交，但归属必须仍是当前教学 Task。
            # Frontier supporting Skill 只是背景，不能靠提交 Evidence 偷偷越过激活流程。
            active_task = self.get_active_task()
            if active_task is None or evidence.skill_id not in active_task.related_skill_ids:
                raise ValueError(
                    f"Evidence for Skill {evidence.skill_id} requires its matching ACTIVE LearningTask"
                )
        return self._append_evidence(evidence)

    def _import_historical_evidence(self, evidence: Evidence) -> SkillNode:
        """仅供本地历史 fixture 装载既有事实；不可暴露给 Agent/API 绕过教学 Task。"""
        return self._append_evidence(evidence)

    def _append_evidence(self, evidence: Evidence) -> SkillNode:
        if not isinstance(evidence, Evidence):
            raise TypeError("submit_evidence requires an Evidence object")
        if evidence.id in self._evidence:
            raise ValueError(f"Duplicate Evidence id: {evidence.id}")

        self._require_current_skill(evidence.skill_id)

        skill = self.get_skill(evidence.skill_id)
        updated_skill = skill.record_evidence(evidence)
        updated_graph = self._graph.replace_skill(updated_skill)
        self._graph = updated_graph
        self._evidence[evidence.id] = evidence
        self._state_changed()
        return updated_skill

    def get_evidence(self, evidence_id: str) -> Evidence:
        try:
            evidence = self._evidence[evidence_id]
            self.get_skill(evidence.skill_id)
            return evidence
        except KeyError as error:
            raise KeyError(f"Unknown Evidence id: {evidence_id}") from error

    def get_evidence_for_skill(self, skill_id: str) -> tuple[Evidence, ...]:
        skill = self.get_skill(skill_id)
        # Following the Skill's IDs preserves its evidence order. A dangling
        # reference is an integrity error and must not be silently omitted.
        return tuple(self.get_evidence(evidence_id) for evidence_id in skill.evidence_ids)

    # ── Knowledge Cards ──────────────────────────────────────────────
    # Cards are learning material created by the Agent.  Feedback and notes
    # are user-owned self-report / personal content.  None of these create
    # Evidence, change SkillState, or trigger Mastery.

    def create_knowledge_card(
        self,
        card: KnowledgeCard,
    ) -> KnowledgeCard:
        """Create a KnowledgeCard (Agent-authorized). Does not touch Evidence or SkillState."""
        if not isinstance(card, KnowledgeCard):
            raise TypeError("create_knowledge_card requires a KnowledgeCard object")
        if card.id in self._knowledge_cards:
            raise ValueError(f"Duplicate KnowledgeCard id: {card.id}")
        self._require_current_skill(card.skill_id)
        # Validates skill_id exists; archived skills remain valid card owners.
        self.get_skill(card.skill_id)
        self._knowledge_cards[card.id] = card
        self._state_changed()
        return card

    def get_knowledge_card(self, card_id: str) -> KnowledgeCard:
        try:
            card = self._knowledge_cards[card_id]
            self.get_skill(card.skill_id)
            return card
        except KeyError as error:
            raise KeyError(f"Unknown KnowledgeCard id: {card_id}") from error

    def get_knowledge_cards_for_skill(self, skill_id: str) -> tuple[KnowledgeCard, ...]:
        # Validate skill exists; raises KeyError for unknown ids.
        self.get_skill(skill_id)
        return tuple(
            card
            for card in self._knowledge_cards.values()
            if card.skill_id == skill_id
        )

    def get_all_knowledge_cards(self) -> tuple[KnowledgeCard, ...]:
        return tuple(c for c in self._knowledge_cards.values() if not self._skill_is_recycled(c.skill_id))

    # USER-OWNED card actions: exposed only through /api/user/*.
    # Agent Tool Registry must never include these.

    def set_card_feedback_by_user(
        self, card_id: str, status: CardFeedbackStatus
    ) -> KnowledgeCard:
        """Set user self-report (KNOWN/UNSURE/UNKNOWN). Does not create Evidence or change SkillState."""
        if not isinstance(status, CardFeedbackStatus):
            raise TypeError("card feedback status must be a CardFeedbackStatus")
        with self._assessment_lock:
            card = self.get_knowledge_card(card_id)
            updated = card.set_feedback(status)
            before = self._knowledge_cards
            self._knowledge_cards = {**before, card_id: updated}
            try:
                self._state_changed()
            except Exception:
                self._knowledge_cards = before
                raise
            return updated

    def set_card_note_by_user(self, card_id: str, note: str) -> KnowledgeCard:
        """Set user-owned learner note. Not Evidence, not AI assessment."""
        card = self.get_knowledge_card(card_id)
        updated = card.set_note(note)
        self._knowledge_cards[card_id] = updated
        self._state_changed()
        return updated

    def clear_card_note_by_user(self, card_id: str) -> KnowledgeCard:
        """Remove user-owned learner note."""
        card = self.get_knowledge_card(card_id)
        updated = card.clear_note()
        self._knowledge_cards[card_id] = updated
        self._state_changed()
        return updated

    def delete_knowledge_card_by_user(self, card_id: str) -> None:
        """Delete a KnowledgeCard. User-owned action; Agent may not delete cards."""
        card = self.get_knowledge_card(card_id)
        del self._knowledge_cards[card_id]
        self._state_changed()

    def update_knowledge_card_by_user(
        self, card_id: str, question: str, answer: str
    ) -> KnowledgeCard:
        """Update card question/answer. User-owned action; Agent may not modify cards."""
        card = self.get_knowledge_card(card_id)
        updated = card.update_content(question, answer)
        self._knowledge_cards[card_id] = updated
        self._state_changed()
        return updated

    def create_task(self, task: LearningTask) -> LearningTask:
        if not isinstance(task, LearningTask):
            raise TypeError("create_task requires a LearningTask object")
        if task.id in self._tasks:
            raise ValueError(f"Duplicate LearningTask id: {task.id}")
        if task.status is not TaskStatus.TODO:
            raise ValueError("A newly created LearningTask must be TODO")
        branch = self.active_learning_branch()
        if task.branch_id and task.branch_id != (branch.id if branch else None):
            raise ValueError("Task belongs to another learning path")
        if branch:
            if not set(task.related_skill_ids).issubset(branch.skill_ids):
                raise ValueError("Branch Task must stay in its learning scope")
            task = replace(task, branch_id=branch.id, goal_id=branch.goal_id)
        elif any(s in b.exclusive_skill_ids for b in self._learning_branches for s in task.related_skill_ids):
            raise ValueError("Enter the branch before creating a Task for its exclusive Skill")
        if task.teaching_activity is not None and task.activity_revision != 1:
            raise ValueError("A new task teaching activity must start at revision 1")
        for skill_id in task.related_skill_ids:
            self.get_skill(skill_id)
            self._require_current_skill(skill_id)
        if len(task.related_skill_ids) != 1:
            raise ValueError("A new LearningTask must relate to exactly one Skill")
        current_id = self._goal_profile.id if self._goal_profile else None
        if task.goal_id is not None and task.goal_id != current_id:
            raise ValueError("LearningTask does not belong to current Goal")
        if current_id is not None and task.goal_id is None:
            task = replace(task, goal_id=current_id)
        duplicate = next(
            (
                current
                for current in self._tasks.values()
                if current.goal_id == current_id
                and current.branch_id == task.branch_id
                and current.status in (TaskStatus.TODO, TaskStatus.ACTIVE, TaskStatus.PAUSED)
                and current.title.strip().casefold() == task.title.strip().casefold()
                and frozenset(current.related_skill_ids)
                == frozenset(task.related_skill_ids)
            ),
            None,
        )
        if duplicate is not None:
            raise ValueError("Duplicate current LearningTask")
        before = self._tasks
        before_branches = self._learning_branches
        try:
            self._tasks = {**before, task.id: task}
            if branch:
                self._replace_learning_branch(replace(branch, task_ids=(*branch.task_ids, task.id)))
            self._state_changed()
        except Exception:
            self._tasks = before
            self._learning_branches = before_branches
            raise
        return task

    def get_task(self, task_id: str) -> LearningTask:
        try:
            task = self._tasks[task_id]
            if task.goal_id is not None and not self.scope_is_available(task.goal_id):
                raise KeyError(task_id)
            return task
        except KeyError as error:
            raise KeyError(f"Unknown LearningTask id: {task_id}") from error

    def set_teaching_activity(
        self,
        task_id: str,
        *,
        expected_goal_id: str,
        expected_revision: int,
        teaching_activity: TeachingActivity,
    ) -> LearningTask:
        """只调整当前任务的教法；不改变任务状态、评分、Evidence 或掌握状态。"""
        if type(expected_revision) is not int or expected_revision < 0:
            raise ValueError("Activity revision must be a non-negative integer")
        if not isinstance(teaching_activity, TeachingActivity):
            raise TypeError("Teaching activity must be a TeachingActivity")
        with self._assessment_lock:
            current_goal_id = self._goal_profile.id if self._goal_profile else None
            if not current_goal_id or expected_goal_id != current_goal_id:
                raise ValueError("Teaching activity Goal is no longer current")
            task = self.get_task(task_id)
            self._require_current_task(task)
            if task.status not in (TaskStatus.TODO, TaskStatus.ACTIVE):
                raise ValueError("Only a current TODO or ACTIVE task may change its teaching activity")
            # 网络回包不确定时只承认最近一次相同写入；更旧版本不能越过后续调整。
            if task.teaching_activity == teaching_activity and expected_revision in (
                task.activity_revision, task.activity_revision - 1,
            ):
                return task
            if expected_revision != task.activity_revision:
                raise ValueError("Teaching activity changed; reload the current task before adjusting it")
            updated = replace(task, teaching_activity=teaching_activity,
                              activity_revision=task.activity_revision + 1)
            before = self._tasks
            try:
                self._tasks = {**before, task_id: updated}
                self._state_changed()
            except Exception:
                self._tasks = before
                raise
            return updated

    def get_all_tasks(self) -> tuple[LearningTask, ...]:
        return tuple(t for t in self._tasks.values() if t.goal_id is None or self.scope_is_available(t.goal_id))

    def get_active_task(self) -> LearningTask | None:
        if self._current_goal is None:
            return None
        return next(
            (task for task in self._tasks.values() if task.status is TaskStatus.ACTIVE and self._task_belongs_to_current_goal(task)),
            None,
        )

    def get_current_focus(self) -> LearningTask | None:
        """V0.1 focus is the sole ACTIVE task, not a second source of state."""
        return self.get_active_task()

    def activate_task(self, task_id: str) -> LearningTask:
        task = self.get_task(task_id)
        self._require_current_task(task)
        # 旧多 Skill Task 可读取、已暂停的可恢复；未启动的旧 TODO 不再批量启动 Skill。
        if task.status is TaskStatus.TODO and len(task.related_skill_ids) != 1:
            raise ValueError("Cannot activate a legacy multi-Skill TODO LearningTask")
        active_task = self.get_active_task()
        if active_task is not None and active_task.id != task_id:
            raise ValueError(f"LearningTask {active_task.id} is already ACTIVE")
        updated = task.activate()
        updated_graph = self._graph
        for skill_id in task.related_skill_ids:
            skill = updated_graph.get_skill(skill_id)
            if skill.status is SkillState.NOT_STARTED:
                updated_graph = updated_graph.replace_skill(skill.start_learning())
        self._graph = updated_graph
        self._tasks[task_id] = updated
        self._state_changed()
        return updated

    def complete_task(self, task_id: str) -> LearningTask:
        task = self.get_task(task_id)
        self._require_current_task(task)
        updated = task.complete()
        self._tasks[task_id] = updated
        self._state_changed()
        return updated

    def skip_task(self, task_id: str) -> LearningTask:
        task = self.get_task(task_id)
        self._require_current_task(task)
        updated = task.skip()
        self._tasks[task_id] = updated
        self._state_changed()
        return updated

    def start_review_by_user(self, skill_id: str, operation_id: str) -> LearningTask:
        if self.active_learning_branch():
            raise ValueError("Return to the main path before starting a separate review")
        self._require_current_skill(skill_id)
        review_id = f"review-{operation_id}"
        existing = self._tasks.get(review_id)
        if existing is not None:
            if skill_id not in existing.related_skill_ids or existing.goal_id != self._goal_profile.id:
                raise ValueError("Review operation id belongs to another Skill or Goal")
            if existing.status is TaskStatus.DONE:
                raise ValueError("Review operation has already finished")
            if existing.status is not TaskStatus.ACTIVE:
                raise ValueError("Review operation is not active")
            return existing
        skill = self.get_skill(skill_id)
        parent = self.get_active_task()
        if parent is not None and self._is_review_task(parent):
            raise ValueError("Finish the current review before starting another review")
        if skill.status is SkillState.MASTERED_BY_USER:
            self._graph = self._graph.replace_skill(skill.reopen_by_user())
        elif skill.status is SkillState.NOT_STARTED:
            self._graph = self._graph.replace_skill(skill.start_learning())
        if parent is not None:
            self._tasks[parent.id] = parent.pause()
        review = LearningTask(
            id=review_id,
            title=f"复习 {skill.name}",
            description=f"从原学习对话复习 {skill.name}",
            related_skill_ids=(skill_id,),
            expected_evidence_types=(),
            status=TaskStatus.ACTIVE,
            goal_id=self._goal_profile.id,
            review_parent_task_id=parent.id if parent else None,
        )
        self._tasks[review.id] = review
        self._state_changed()
        return review

    def finish_review_by_user(self, review_id: str) -> LearningTask | None:
        review = self.get_task(review_id)
        self._require_current_task(review)
        updates, resumed = self._review_finish_updates(review)
        if updates:
            self._tasks.update(updates)
            self._state_changed()
        return resumed

    @staticmethod
    def _is_review_task(task: LearningTask) -> bool:
        return task.review_parent_task_id is not None or task.id.startswith("review-")

    def _review_finish_updates(self, review: LearningTask) -> tuple[dict[str, LearningTask], LearningTask | None]:
        """先核对复习/原任务，再生成同一次持久化的变更；不复活终态或抢占后续任务。"""
        self._require_current_task(review)
        if not self._is_review_task(review):
            raise ValueError("LearningTask is not a review task")
        if review.status not in (TaskStatus.ACTIVE, TaskStatus.DONE):
            raise ValueError("Only an ACTIVE review task can finish")
        parent = self._tasks.get(review.review_parent_task_id or "")
        if review.review_parent_task_id is not None and parent is None:
            raise ValueError("Review parent task is unavailable")
        if parent is not None:
            self._require_current_task(parent)
        active = self.get_active_task()
        if review.status is TaskStatus.ACTIVE and active is not None and active.id != review.id:
            raise ValueError("Another LearningTask is already ACTIVE")
        updates = {review.id: review.complete()} if review.status is TaskStatus.ACTIVE else {}
        if parent is not None and parent.status is TaskStatus.PAUSED and (active is None or active.id == review.id):
            updates[parent.id] = parent.activate()
            return updates, updates[parent.id]
        # DONE 的重试只返回现有现场；旧复习不能把后来启动的任务替换掉。
        return updates, active if active is not None and active.id != review.id else None

    # USER-OWNED USE CASES: exposed only through the local /api/user boundary.
    # Never register these operations as Agent tools. The current boundary
    # trusts a local single-user CLI and is not authentication for deployment.
    def confirm_mastery_by_user(self, skill_id: str, *, expected_goal_id: str | None = None,
                               expected_task_id: str | None = None) -> SkillNode:
        with self._assessment_lock:
            # 邀请不是授权；旧组件必须同时匹配当前Goal、ACTIVE Task及Skill，才执行这次用户确认。
            # HTTP层统一写锁使校验和写入之间不能穿插切Goal/切Task；无锚点保留原手动入口。
            if (expected_goal_id is None) != (expected_task_id is None):
                raise ValueError("Mastery confirmation requires both expected Goal and Task")
            if expected_goal_id is not None:
                if not all(isinstance(value, str) and value.strip() for value in (expected_goal_id, expected_task_id)):
                    raise ValueError("Mastery confirmation scope must contain non-empty Goal and Task")
                if self._goal_profile is None or self._goal_profile.id != expected_goal_id:
                    raise ValueError("Mastery confirmation does not belong to current Goal")
                active = self.get_active_task()
                if active is None or active.id != expected_task_id or skill_id not in active.related_skill_ids:
                    raise ValueError("Mastery confirmation does not match the current ACTIVE Task and Skill")
            self._require_current_skill(skill_id)
            skill = self.get_skill(skill_id)
            active = self.get_active_task()
            review = active if active is not None and self._is_review_task(active) and skill_id in active.related_skill_ids else None
            if review is None and active is None:
                # 兼容旧版：老师已完成复习 Task，但原 Task 仍 PAUSED，用户尚未再次确认掌握。
                review = next((task for task in reversed(tuple(self._tasks.values()))
                    if self._task_belongs_to_current_goal(task) and self._is_review_task(task)
                    and task.status is TaskStatus.DONE and skill_id in task.related_skill_ids
                    and (parent := self._tasks.get(task.review_parent_task_id or "")) is not None
                    and parent.status is TaskStatus.PAUSED), None)
            task_updates, _ = self._review_finish_updates(review) if review is not None else ({}, None)
            # /master 是用户的最终确认动作。LEARNING可组合迁移，不把毕业权限交给Agent。
            if skill.status is SkillState.LEARNING:
                skill = skill.start_practicing()
            # 旧版留下 ACTIVE + MASTERED 的复习允许收尾；普通重复掌握仍由 Domain 拒绝。
            updated_skill = skill if review is not None and skill.status is SkillState.MASTERED_BY_USER else skill.confirm_mastery_by_user()
            self._graph = self._graph.replace_skill(updated_skill)
            self._tasks.update(task_updates)
            self._state_changed()
            return updated_skill

    def reopen_skill_by_user(self, skill_id: str) -> SkillNode:
        self._require_current_skill(skill_id)
        updated_skill = self.get_skill(skill_id).reopen_by_user()
        self._graph = self._graph.replace_skill(updated_skill)
        self._state_changed()
        return updated_skill

    def start_practicing_by_user(self, skill_id: str) -> SkillNode:
        self._require_current_skill(skill_id)
        updated_skill = self.get_skill(skill_id).start_practicing()
        self._graph = self._graph.replace_skill(updated_skill)
        self._state_changed()
        return updated_skill

    def return_skill_to_learning(self, skill_id: str) -> SkillNode:
        self._require_current_skill(skill_id)
        updated_skill = self.get_skill(skill_id).return_to_learning()
        self._graph = self._graph.replace_skill(updated_skill)
        self._state_changed()
        return updated_skill
