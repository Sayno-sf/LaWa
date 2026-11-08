"""Archive snapshots describe workspace operations, never learning occurrence times.

All learners, timestamps and persisted JSON in this module are synthetic. These
tests use only a temporary directory and do not import or start the API runtime.
"""

import json
import unittest
from dataclasses import replace
from datetime import UTC, datetime, timedelta, timezone, tzinfo
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

from app.application import LearningService
from app.domain import (
    AssistanceLevel,
    CurriculumMilestone,
    Evidence,
    EvidenceType,
    FrontierPlan,
    GoalProfile,
    LearningDepth,
    LearningTask,
    SkillGraph,
    SkillNode,
    SkillState,
    TaskStatus,
)
from app.persistence import JsonLearningStateStore


GOAL_CREATED_AT = datetime(2020, 1, 1, 9, tzinfo=UTC)
EVIDENCE_CREATED_AT = datetime(2020, 1, 2, 10, tzinfo=timezone(timedelta(hours=2)))
T1 = datetime(2026, 1, 1, 10, tzinfo=UTC)
T2 = datetime(2026, 1, 2, 10, tzinfo=UTC)
T3 = datetime(2026, 1, 3, 10, tzinfo=UTC)
T4 = datetime(2026, 1, 4, 10, tzinfo=UTC)


class _ClockMeta(type):
    def __instancecheck__(cls, value):
        # Persistence returns ordinary datetime instances, which remain valid.
        return isinstance(value, datetime)


class _Clock(datetime, metaclass=_ClockMeta):
    instants = [T1]
    calls = 0

    @classmethod
    def at(cls, *instants):
        cls.instants = list(instants)
        cls.calls = 0

    @classmethod
    def now(cls, tz=None):
        cls.calls += 1
        value = cls.instants.pop(0) if len(cls.instants) > 1 else cls.instants[0]
        return value.astimezone(tz) if tz is not None else value.replace(tzinfo=None)


def _install(service, goal_id, *, replace_existing=False):
    skill_id = f"{goal_id}-skill"
    service.initialize_curriculum(
        GoalProfile(
            goal_id, f"Synthetic {goal_id}", "Synthetic background", "Synthetic outcome",
            created_at=GOAL_CREATED_AT,
        ),
        tuple(
            CurriculumMilestone(
                f"{goal_id}-stage-{index}", f"Stage {index}", "Synthetic stage",
                LearningDepth.PRACTICAL,
            )
            for index in range(5)
        ),
        (SkillNode(skill_id, f"Synthetic skill {goal_id}"),),
        FrontierPlan(
            focus_skill_id=skill_id, reason="Synthetic fixture",
            target_depth=LearningDepth.PRACTICAL,
            suggested_learning_mode="BUILD", next_action="Continue",
        ),
        replace_existing=replace_existing,
    )
    service.create_task(LearningTask(
        f"{goal_id}-task", f"Synthetic task {goal_id}", "Synthetic action",
        (skill_id,), (EvidenceType.EXPLAIN,),
    ))
    service.activate_task(f"{goal_id}-task")
    service.submit_evidence(Evidence(
        f"{goal_id}-evidence", skill_id, EvidenceType.EXPLAIN,
        "Synthetic explanation", AssistanceLevel.INDEPENDENT, "synthetic:test",
        created_at=EVIDENCE_CREATED_AT,
    ))
    service.confirm_mastery_by_user(skill_id)


def _facts(service, *, include_tasks=True):
    """Compare facts separately from foreground, archive and recycle metadata."""
    snapshot = service.snapshot()
    goals = {
        project.goal_profile.id: (
            project.goal_profile, project.curriculum_spine, project.skill_ids, project.frontier,
        )
        for project in (
            *snapshot.learning_history,
            *(item.project for item in snapshot.recycled_projects),
        )
    }
    if snapshot.goal_profile is not None:
        goals[snapshot.goal_profile.id] = (
            snapshot.goal_profile, snapshot.curriculum_spine,
            snapshot.current_goal_skill_ids, snapshot.frontier,
        )
    return (
        goals, snapshot.skills, snapshot.evidence,
        snapshot.tasks if include_tasks else (),
        snapshot.knowledge_cards, snapshot.answer_assessments,
        snapshot.teaching, snapshot.plan_revisions,
    )


def _archived(service, goal_id):
    return next(
        item for item in service.snapshot().learning_history
        if item.goal_profile.id == goal_id
    )


class ArchiveTimeSemanticsTests(unittest.TestCase):
    def setUp(self):
        _Clock.at(T1)
        self.clock_patch = patch("app.domain.history.datetime", _Clock)
        self.clock_patch.start()
        self.addCleanup(self.clock_patch.stop)

    def two_goals(self):
        service = LearningService(SkillGraph([]), current_goal=None)
        _install(service, "a")
        _Clock.at(T1)
        _install(service, "b", replace_existing=True)
        return service

    def assert_synthetic_learning_facts(self, service):
        snapshot = service.snapshot()
        self.assertTrue(snapshot.evidence)
        self.assertTrue(all(item.created_at == EVIDENCE_CREATED_AT for item in snapshot.evidence))
        self.assertTrue(all(item.status is SkillState.MASTERED_BY_USER for item in snapshot.skills))

    def test_repeated_switches_create_new_archive_snapshots_without_rewriting_facts(self):
        service = self.two_goals()  # A -> B first archives A at T1.
        original = _facts(service)
        self.assertEqual(_archived(service, "a").archived_at, T1)

        _Clock.at(T2)
        service.switch_goal_by_user("a")
        self.assertEqual(_archived(service, "b").archived_at, T2)
        self.assertEqual(service.get_learning_library().projects[0].archived_at, None)
        self.assertEqual(_facts(service), original)

        _Clock.at(T3)
        service.switch_goal_by_user("b")
        self.assertEqual(_archived(service, "a").archived_at, T3)
        self.assertNotEqual(_archived(service, "a").archived_at, T1)
        self.assertEqual(_facts(service), original)
        self.assert_synthetic_learning_facts(service)

    def test_restart_preserves_saved_snapshot_but_next_exit_creates_new_timestamp(self):
        service = self.two_goals()
        original = _facts(service)
        with TemporaryDirectory() as directory:
            store = JsonLearningStateStore(Path(directory) / "synthetic-state.json")
            store.bind(service)
            _Clock.at(T2)
            service.switch_goal_by_user("a")
            _Clock.at(T3)
            restored = store.load()
            self.assertIsNotNone(restored)
            self.assertEqual(_archived(restored, "b").archived_at, T2)
            self.assertEqual(_Clock.calls, 0)
            restored.switch_goal_by_user("b")
            self.assertEqual(_archived(restored, "a").archived_at, T3)
            reloaded = store.load()
            self.assertEqual(_archived(reloaded, "a").archived_at, T3)
            self.assertEqual(_facts(reloaded), original)
            self.assert_synthetic_learning_facts(reloaded)

    def test_same_goal_and_readonly_projections_do_not_change_timestamps_or_save(self):
        service = self.two_goals()
        save = Mock()
        service.enable_auto_save(save)
        before = service.snapshot()
        _Clock.at(T4)
        service.switch_goal_by_user("b")
        service.get_learning_library()
        service.get_learning_overview()
        service.get_current_plan()
        self.assertEqual(service.snapshot(), before)
        save.assert_not_called()
        self.assertEqual(_Clock.calls, 0)

    def test_restore_preserves_archive_time_and_operation_order_is_not_date_order(self):
        service = self.two_goals()
        _Clock.at(T2)
        _install(service, "c", replace_existing=True)
        original = _facts(service)
        self.assertEqual(
            [p.goal_profile.id for p in service.get_learning_library().projects],
            ["c", "b", "a"],
        )
        with TemporaryDirectory() as directory:
            store = JsonLearningStateStore(Path(directory) / "synthetic-state.json")
            store.bind(service)
            _Clock.at(T3)
            recycled = service.recycle_goal_by_user("a")
            self.assertEqual(recycled.project.archived_at, T1)
            self.assertEqual(recycled.deleted_at, T3)
            self.assertEqual(_facts(service, include_tasks=False), _facts_without_tasks(original))

            _Clock.at(T4)
            service.restore_goal_by_user("a")
            self.assertEqual(_Clock.calls, 0)
            self.assertEqual(_facts(service), original)
            projects = service.get_learning_library().projects
            self.assertEqual([p.goal_profile.id for p in projects], ["c", "a", "b"])
            self.assertEqual([p.archived_at for p in projects], [None, T1, T2])
            restored = store.load()
            self.assertEqual(restored.get_learning_library(), service.get_learning_library())
            self.assertEqual(_facts(restored), original)

    def test_recycling_current_creates_snapshot_and_independent_deletion_timestamp(self):
        service = self.two_goals()
        original = _facts(service)
        _Clock.at(T3, T4)
        recycled = service.recycle_goal_by_user("b")
        self.assertEqual(recycled.project.archived_at, T3)
        self.assertEqual(recycled.deleted_at, T4)
        self.assertEqual(service.snapshot().goal_profile.id, "a")
        self.assertEqual(_facts(service, include_tasks=False), _facts_without_tasks(original))
        tasks = {task.id: task for task in service.snapshot().tasks}
        original_tasks = {task.id: task for task in original[3]}
        self.assertEqual(tasks["a-task"], original_tasks["a-task"])
        self.assertEqual(tasks["b-task"], replace(original_tasks["b-task"], status=TaskStatus.PAUSED))

        service.restore_goal_by_user("b")
        self.assertEqual(_archived(service, "b").archived_at, T3)
        self.assertEqual(_facts(service), original)
        self.assert_synthetic_learning_facts(service)

    def test_archive_timezone_validation_rejects_naive_or_unknown_times(self):
        project = _archived(self.two_goals(), "a")

        class NoOffset(tzinfo):
            def utcoffset(self, value):
                return None

        for value in (
            datetime(2026, 1, 1), datetime(2026, 1, 1, tzinfo=NoOffset()), None, "2026-01-01",
        ):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "timezone-aware"):
                    replace(project, archived_at=value)
        offset_time = datetime(2026, 1, 1, 15, 30, tzinfo=timezone(timedelta(hours=5, minutes=30)))
        self.assertEqual(replace(project, archived_at=offset_time).archived_at, offset_time)

    def test_synthetic_persistence_preserves_offsets_order_and_evidence_exactly(self):
        service = self.two_goals()
        original = _facts(service)
        archive_time = "2026-01-01T15:30:00+05:30"
        with TemporaryDirectory() as directory:
            store = JsonLearningStateStore(Path(directory) / "synthetic-state.json")
            store.save(service)
            payload = json.loads(store.path.read_text(encoding="utf-8"))
            payload["learning_history"][0]["archived_at"] = archive_time
            store.path.write_text(json.dumps(payload), encoding="utf-8")
            restored = store.load()
            self.assertEqual(_archived(restored, "a").archived_at.isoformat(), archive_time)
            self.assertEqual(_facts(restored), original)
            store.save(restored)
            roundtrip = json.loads(store.path.read_text(encoding="utf-8"))
            self.assertEqual(roundtrip, payload)
            self.assertEqual(roundtrip["evidence"], payload["evidence"])
            self.assert_synthetic_learning_facts(restored)

    def test_api_schema_preserves_workspace_and_evidence_times_without_mutation(self):
        from app.api.schemas import LearningLibraryResponse, LearningOverviewResponse

        service = self.two_goals()
        before = service.snapshot()
        save = Mock()
        service.enable_auto_save(save)
        library = LearningLibraryResponse.from_application(service.get_learning_library())
        payload = library.model_dump(mode="json")
        self.assertEqual([p["goal_profile"]["id"] for p in payload["projects"]], ["b", "a"])
        self.assertIsNone(payload["projects"][0]["archived_at"])
        self.assertEqual(library.projects[1].archived_at, T1)
        self.assertEqual(library.projects[1].goal_profile.created_at, GOAL_CREATED_AT)
        self.assertEqual(
            library.projects[1].evidence[0].created_at.isoformat(),
            EVIDENCE_CREATED_AT.isoformat(),
        )
        overview = LearningOverviewResponse.from_application(service.get_learning_overview())
        self.assertEqual(overview.learning_history[0].archived_at, T1)
        self.assertEqual(service.snapshot(), before)
        save.assert_not_called()


def _facts_without_tasks(facts):
    return (*facts[:3], (), *facts[4:])


if __name__ == "__main__":
    unittest.main()
