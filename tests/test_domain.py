"""Phase 1 domain behavior and invariants, using only the Python standard library."""

import unittest
from dataclasses import FrozenInstanceError
from datetime import datetime, timezone

from app.domain import (
    AssistanceLevel,
    Evidence,
    EvidenceType,
    LearningTask,
    SkillGraph,
    SkillNode,
    SkillState,
    TaskStatus,
)


def make_evidence(**changes: object) -> Evidence:
    values = {
        "id": "evidence-1",
        "skill_id": "autograd",
        "evidence_type": EvidenceType.BUILD,
        "description": "Independently implemented a backward example",
        "assistance_level": AssistanceLevel.INDEPENDENT,
        "source": "learning note",
    }
    values.update(changes)
    return Evidence(**values)


def make_task(**changes: object) -> LearningTask:
    values = {
        "id": "task-1",
        "title": "Build an autograd example",
        "description": "Explain and run backward without a template",
        "related_skill_ids": ("autograd",),
        "expected_evidence_types": (EvidenceType.EXPLAIN, EvidenceType.BUILD),
    }
    values.update(changes)
    return LearningTask(**values)


class SkillNodeTests(unittest.TestCase):
    def test_four_core_states_only(self) -> None:
        self.assertEqual(
            [state.value for state in SkillState],
            ["NOT_STARTED", "LEARNING", "PRACTICING", "MASTERED_BY_USER"],
        )

    def test_learning_lifecycle_and_reopen(self) -> None:
        initial = SkillNode("autograd", "Autograd")
        learning = initial.start_learning()
        practicing = learning.start_practicing()
        mastered = practicing.confirm_mastery_by_user()
        reopened = mastered.reopen_by_user()
        self.assertEqual(initial.status, SkillState.NOT_STARTED)
        self.assertEqual(learning.status, SkillState.LEARNING)
        self.assertEqual(practicing.status, SkillState.PRACTICING)
        self.assertEqual(mastered.status, SkillState.MASTERED_BY_USER)
        self.assertEqual(reopened.status, SkillState.PRACTICING)

    def test_invalid_transitions_are_rejected(self) -> None:
        skill = SkillNode("autograd", "Autograd")
        with self.assertRaises(ValueError):
            skill.start_practicing()
        with self.assertRaises(ValueError):
            skill.confirm_mastery_by_user()
        with self.assertRaises(ValueError):
            skill.reopen_by_user()
        with self.assertRaises(ValueError):
            skill.start_learning().start_learning()

    def test_return_to_learning_from_practicing_returns_new_skill(self) -> None:
        practicing = (
            SkillNode("autograd", "Autograd")
            .start_learning()
            .start_practicing()
            .record_evidence(make_evidence())
        )
        learning = practicing.return_to_learning()
        self.assertIsNot(learning, practicing)
        self.assertEqual(learning.status, SkillState.LEARNING)
        self.assertEqual(practicing.status, SkillState.PRACTICING)
        self.assertEqual(learning.evidence_ids, practicing.evidence_ids)
        self.assertEqual(learning.id, practicing.id)

    def test_return_to_learning_rejects_every_other_state(self) -> None:
        not_started = SkillNode("autograd", "Autograd")
        learning = not_started.start_learning()
        mastered = learning.start_practicing().confirm_mastery_by_user()
        for skill in (not_started, learning, mastered):
            with self.subTest(state=skill.status):
                with self.assertRaises(ValueError):
                    skill.return_to_learning()

    def test_record_evidence_does_not_change_skill_state(self) -> None:
        skill = SkillNode("autograd", "Autograd").start_learning().start_practicing()
        updated = skill.record_evidence(make_evidence())
        self.assertEqual(updated.evidence_ids, ("evidence-1",))
        self.assertEqual(updated.status, SkillState.PRACTICING)
        self.assertEqual(skill.evidence_ids, ())
        with self.assertRaises(ValueError):
            updated.record_evidence(make_evidence())

    def test_evidence_must_belong_to_skill(self) -> None:
        with self.assertRaises(ValueError):
            SkillNode("tensor", "Tensor").record_evidence(make_evidence())

    def test_skill_validation_and_immutability(self) -> None:
        with self.assertRaises(ValueError):
            SkillNode("", "Autograd")
        with self.assertRaises(ValueError):
            SkillNode("autograd", "Autograd", prerequisites=("autograd",))
        with self.assertRaises(ValueError):
            SkillNode("autograd", "Autograd", prerequisites=("tensor", "tensor"))
        skill = SkillNode("autograd", "Autograd", prerequisites=["tensor"])
        self.assertEqual(skill.prerequisites, ("tensor",))
        with self.assertRaises(FrozenInstanceError):
            skill.status = SkillState.MASTERED_BY_USER


class SkillGraphTests(unittest.TestCase):
    def test_graph_skill_evidence_and_task_work_together(self) -> None:
        graph = SkillGraph(
            [
                SkillNode("tensor", "Tensor"),
                SkillNode("autograd", "Autograd", prerequisites=("tensor",)),
            ]
        )
        evidence = make_evidence()
        task = make_task()
        updated_skill = graph.get_skill("autograd").start_learning()
        updated_skill = updated_skill.start_practicing().record_evidence(evidence)
        graph = graph.replace_skill(updated_skill)
        evidence_by_id = {evidence.id: evidence}  # Phase 2 will own the collection.
        retrieved = tuple(
            evidence_by_id[item] for item in graph.get_skill("autograd").evidence_ids
        )
        self.assertEqual(retrieved, (evidence,))
        self.assertEqual(task.related_skill_ids, ("autograd",))
        self.assertEqual(graph.get_skill("autograd").status, SkillState.PRACTICING)

    def test_dependency_lookup_and_replacement(self) -> None:
        tensor = SkillNode("tensor", "Tensor")
        autograd = SkillNode("autograd", "Autograd", prerequisites=("tensor",))
        graph = SkillGraph([autograd, tensor])
        self.assertEqual(graph.get_skill("autograd"), autograd)
        self.assertEqual(graph.prerequisites_of("autograd"), (tensor,))
        self.assertEqual(graph.dependents_of("tensor"), (autograd,))
        updated = graph.replace_skill(autograd.start_learning())
        self.assertEqual(updated.get_skill("autograd").status, SkillState.LEARNING)
        self.assertEqual(graph.get_skill("autograd").status, SkillState.NOT_STARTED)

    def test_diamond_dependency_is_valid(self) -> None:
        graph = SkillGraph(
            [
                SkillNode("a", "A"),
                SkillNode("b", "B", prerequisites=("a",)),
                SkillNode("c", "C", prerequisites=("a",)),
                SkillNode("d", "D", prerequisites=("b", "c")),
            ]
        )
        self.assertEqual(len(graph.skills), 4)

    def test_missing_dependency_duplicate_and_cycle_are_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "missing prerequisite"):
            SkillGraph([SkillNode("autograd", "Autograd", prerequisites=("tensor",))])
        with self.assertRaisesRegex(ValueError, "Duplicate Skill"):
            SkillGraph([SkillNode("tensor", "Tensor"), SkillNode("tensor", "Tensor")])
        with self.assertRaisesRegex(ValueError, "Cycle"):
            SkillGraph(
                [
                    SkillNode("a", "A", prerequisites=("b",)),
                    SkillNode("b", "B", prerequisites=("c",)),
                    SkillNode("c", "C", prerequisites=("a",)),
                ]
            )

    def test_replacing_skill_revalidates_graph(self) -> None:
        graph = SkillGraph([SkillNode("tensor", "Tensor"), SkillNode("cnn", "CNN")])
        with self.assertRaisesRegex(ValueError, "missing prerequisite"):
            graph.replace_skill(SkillNode("cnn", "CNN", prerequisites=("unknown",)))
        with self.assertRaises(KeyError):
            graph.replace_skill(SkillNode("autograd", "Autograd"))

    def test_unknown_skill_is_explicit(self) -> None:
        with self.assertRaisesRegex(KeyError, "Unknown Skill"):
            SkillGraph([]).get_skill("unknown")


class EvidenceTests(unittest.TestCase):
    def test_evidence_records_type_assistance_source_and_time(self) -> None:
        evidence = make_evidence()
        self.assertEqual(evidence.evidence_type, EvidenceType.BUILD)
        self.assertEqual(evidence.assistance_level, AssistanceLevel.INDEPENDENT)
        self.assertEqual(evidence.source, "learning note")
        self.assertIsNotNone(evidence.created_at.tzinfo)

    def test_evidence_validation(self) -> None:
        with self.assertRaises(ValueError):
            make_evidence(description="")
        with self.assertRaises(ValueError):
            make_evidence(evidence_type="BUILD")
        with self.assertRaises(ValueError):
            make_evidence(assistance_level="INDEPENDENT")
        with self.assertRaises(ValueError):
            make_evidence(created_at=datetime(2026, 9, 14))
        self.assertEqual(
            make_evidence(created_at=datetime(2026, 9, 14, tzinfo=timezone.utc)).id,
            "evidence-1",
        )


class LearningTaskTests(unittest.TestCase):
    def test_task_lifecycle(self) -> None:
        todo = make_task()
        active = todo.activate()
        done = active.complete()
        skipped = make_task().skip()
        self.assertEqual(todo.status, TaskStatus.TODO)
        self.assertEqual(active.status, TaskStatus.ACTIVE)
        self.assertEqual(done.status, TaskStatus.DONE)
        self.assertEqual(skipped.status, TaskStatus.SKIPPED)

    def test_task_invalid_transitions(self) -> None:
        with self.assertRaises(ValueError):
            make_task().complete()
        with self.assertRaises(ValueError):
            make_task().activate().complete().skip()

    def test_task_validation_and_tuple_normalization(self) -> None:
        task = make_task(
            related_skill_ids=["autograd"],
            expected_evidence_types=[EvidenceType.EXPLAIN],
        )
        self.assertEqual(task.related_skill_ids, ("autograd",))
        self.assertEqual(task.expected_evidence_types, (EvidenceType.EXPLAIN,))
        with self.assertRaises(ValueError):
            make_task(related_skill_ids=())
        with self.assertRaises(ValueError):
            make_task(related_skill_ids=("autograd", "autograd"))
        self.assertEqual(make_task(expected_evidence_types=()).expected_evidence_types, ())
        with self.assertRaises(ValueError):
            make_task(expected_evidence_types=("EXPLAIN",))


if __name__ == "__main__":
    unittest.main()
