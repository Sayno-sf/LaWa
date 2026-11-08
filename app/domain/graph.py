"""Dependency graph validation and lookup, independent of any storage layer."""

from collections.abc import Iterable

from .skill import SkillNode


class SkillGraph:
    def __init__(self, skills: Iterable[SkillNode]) -> None:
        nodes: dict[str, SkillNode] = {}
        for skill in skills:
            if not isinstance(skill, SkillNode):
                raise TypeError("SkillGraph accepts only SkillNode objects")
            if skill.id in nodes:
                raise ValueError(f"Duplicate Skill id: {skill.id}")
            nodes[skill.id] = skill

        for skill in nodes.values():
            for prerequisite_id in skill.prerequisites:
                if prerequisite_id not in nodes:
                    raise ValueError(
                        f"Skill {skill.id} has missing prerequisite {prerequisite_id}"
                    )

        self._check_cycles(nodes)
        self._nodes = nodes

    @staticmethod
    def _check_cycles(nodes: dict[str, SkillNode]) -> None:
        # Iterative DFS avoids Python recursion limits on longer learning graphs.
        visited: set[str] = set()
        visiting: set[str] = set()
        for start_id in nodes:
            if start_id in visited:
                continue
            stack: list[tuple[str, bool]] = [(start_id, False)]
            while stack:
                skill_id, finished = stack.pop()
                if finished:
                    visiting.remove(skill_id)
                    visited.add(skill_id)
                    continue
                if skill_id in visited:
                    continue
                if skill_id in visiting:
                    raise ValueError(f"Cycle detected at Skill {skill_id}")
                visiting.add(skill_id)
                stack.append((skill_id, True))
                for prerequisite_id in reversed(nodes[skill_id].prerequisites):
                    if prerequisite_id in visiting:
                        raise ValueError(
                            f"Cycle detected: {skill_id} depends on {prerequisite_id}"
                        )
                    if prerequisite_id not in visited:
                        stack.append((prerequisite_id, False))

    @property
    def skills(self) -> tuple[SkillNode, ...]:
        return tuple(self._nodes.values())

    def get_skill(self, skill_id: str) -> SkillNode:
        try:
            return self._nodes[skill_id]
        except KeyError as error:
            raise KeyError(f"Unknown Skill id: {skill_id}") from error

    def prerequisites_of(self, skill_id: str) -> tuple[SkillNode, ...]:
        skill = self.get_skill(skill_id)
        return tuple(self._nodes[item] for item in skill.prerequisites)

    def dependents_of(self, skill_id: str) -> tuple[SkillNode, ...]:
        self.get_skill(skill_id)
        return tuple(
            skill for skill in self._nodes.values() if skill_id in skill.prerequisites
        )

    def replace_skill(self, updated: SkillNode) -> "SkillGraph":
        """Return a validated graph with one updated immutable SkillNode."""
        if updated.id not in self._nodes:
            raise KeyError(f"Unknown Skill id: {updated.id}")
        return SkillGraph(
            updated if skill.id == updated.id else skill
            for skill in self._nodes.values()
        )
