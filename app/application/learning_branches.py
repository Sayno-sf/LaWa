"""Kernel-owned curriculum paths. Commands commit Task/focus together or roll back."""

from dataclasses import asdict, replace
from hashlib import sha256

from app.domain.learning_branch import LearningBranch
from app.domain import FrontierPlan, LearningDepth, LearningTask, SkillNode, SkillGraph, SkillState, TaskStatus


class LearningBranches:
    def _validate_learning_branches(self):
        ids, active_goals = set(), set()
        memberships = {p.goal_profile.id: p.skill_ids for p in self._learning_history}
        memberships.update({p.project.goal_profile.id: p.project.skill_ids for p in self._recycled_projects})
        if self._goal_profile:
            memberships[self._goal_profile.id] = self._current_goal_skill_ids
        for branch in self._learning_branches:
            if not isinstance(branch, LearningBranch) or branch.id in ids:
                raise ValueError("Learning branches need unique identities")
            ids.add(branch.id)
            if branch.goal_id not in memberships or not set(branch.skill_ids).issubset(memberships[branch.goal_id]):
                raise ValueError("Learning branch has an unavailable owner or Skill")
            if branch.status == "ACTIVE":
                if branch.goal_id in active_goals:
                    raise ValueError("Only one learning path may be active in a Goal")
                active_goals.add(branch.goal_id)
            for task_id in branch.task_ids:
                task = self._tasks.get(task_id)
                if not task or task.branch_id != branch.id or task.goal_id != branch.goal_id:
                    raise ValueError("Learning branch Task ownership is inconsistent")
            if branch.return_task_id:
                parent = self._tasks.get(branch.return_task_id)
                if not parent or parent.goal_id != branch.goal_id or parent.branch_id:
                    raise ValueError("Learning branch return Task must belong to its main Goal")
        for task in self._tasks.values():
            if task.branch_id and task.branch_id not in ids:
                raise ValueError("Learning Task has an unknown branch")
            if task.branch_id:
                owner = next(b for b in self._learning_branches if b.id == task.branch_id)
                if task.id not in owner.task_ids or not set(task.related_skill_ids).issubset(owner.skill_ids):
                    raise ValueError("Learning Task must belong to its branch scope")
                if task.status is TaskStatus.ACTIVE and owner.status != "ACTIVE":
                    raise ValueError("Only an ACTIVE branch can own an ACTIVE Task")

    def _protect_branch_membership(self, goal_id, skill_ids, spine):
        """主线重规划不能让已经采纳的分支或其知识身份失去归属。"""
        skills, milestones = set(skill_ids), {m.id for m in spine}
        for branch in self._learning_branches:
            if branch.goal_id != goal_id:
                continue
            if not set(branch.skill_ids).issubset(skills) or branch.anchor_id not in (skills if branch.anchor_kind == "skill" else milestones):
                raise ValueError("Plan must retain the nodes referenced by existing learning branches")
            if any(s in m.skill_ids for m in spine for s in branch.exclusive_skill_ids):
                raise ValueError("Branch-only Skills cannot be added to main milestones")

    def active_learning_branch(self):
        goal = self._goal_profile.id if self._goal_profile else None
        return next((b for b in self._learning_branches if b.goal_id == goal and b.status == "ACTIVE"), None)

    def _branch_by_id(self, branch_id):
        branch = next((b for b in self._learning_branches if b.id == branch_id), None)
        if branch is None or not self.scope_is_available(branch.goal_id):
            raise KeyError("Learning branch is unavailable")
        return branch

    def learning_branch_context(self, branch_id):
        branch = self._branch_by_id(branch_id)
        if not self._goal_profile or branch.goal_id != self._goal_profile.id:
            raise ValueError("Read branch background from its current Goal")
        projects = self._growth_projects()
        records_by_origin = self._growth_records()
        sources = []
        for goal_id in branch.source_goal_ids:
            project = projects.get(goal_id)
            if not project:
                sources.append({"goal_id": goal_id, "unavailable": True})
                continue
            records = [r for values in records_by_origin.values() for r in values if r.get("goal_id") == goal_id]
            sources.append({"goal_id": goal_id, "title": project.goal_profile.goal_description, "read_only": True,
                            "skills": [{"id": s.id, "name": s.name, "state": s.status.value} for s in project.skills[:12]],
                            "records": [{k: v[:500] if isinstance(v, str) and k not in ("id", "goal_id", "skill_id", "source_session_id", "source_turn_id") else v for k, v in r.items()} for r in records[-6:]],
                            "omitted_records": max(0, len(records) - 6)})
        return {"branch": asdict(branch), "source_goals": sources,
                "notice": "来源目标只读；自述不代表实际表现，不改变来源目标路线、任务或掌握。"}

    def _replace_learning_branch(self, value):
        self._learning_branches = tuple(value if b.id == value.id else b for b in self._learning_branches)

    def _branch_commit(self, before):
        try:
            self._state_changed()
        except Exception:
            self.__dict__.clear()
            self.__dict__.update(before)
            raise

    def learning_paths(self):
        goal = self._goal_profile.id if self._goal_profile else None
        branches = [b for b in self._learning_branches if b.goal_id == goal]
        active = self.active_learning_branch()
        return {"active_branch_id": active.id if active else None,
                "branches": [asdict(b) for b in branches],
                "main_skill_ids": [s for s in self._current_goal_skill_ids
                                   if s not in {i for b in branches for i in b.exclusive_skill_ids}],
                "main_frontier": asdict(self._frontier) if self._frontier else None}

    def propose_learning_branch(self, branch: LearningBranch, expected_plan_revision: int):
        """教师只能提案。接纳与切换是不同的用户命令，不能从提案推导用户同意。"""
        if not self._goal_profile or branch.goal_id != self._goal_profile.id:
            raise ValueError("Branch Goal is no longer current")
        if self.active_learning_branch():
            raise ValueError("Already inside a learning branch; supplement this branch instead of creating a child")
        if expected_plan_revision != self.current_plan_revision:
            raise ValueError("Main plan changed; reload before proposing a branch")
        if branch.status != "PROPOSED" or branch.revision or branch.task_ids or branch.exclusive_skill_ids or branch.frontier:
            raise ValueError("A proposal cannot grant execution state")
        previous = next((b for b in self._learning_branches if b.id == branch.id), None)
        if previous:
            fields = ("goal_id", "anchor_kind", "anchor_id", "purpose", "title", "reason", "scope", "return_condition", "source_ids", "source_goal_ids")
            if any(getattr(previous, k) != getattr(branch, k) for k in fields):
                raise ValueError("Branch id already belongs to a different proposal")
            return previous
        anchors = self.learning_paths()["main_skill_ids"] if branch.anchor_kind == "skill" else [m.id for m in self._curriculum_spine]
        if branch.anchor_id not in anchors:
            raise ValueError("Branch anchor must be a main node of the current Goal")
        if not set(branch.skill_ids).issubset(self._current_goal_skill_ids):
            raise ValueError("Other Goals are read-only sources, not writable branch skills")
        if any(not self.scope_is_available(g) for g in branch.source_goal_ids):
            raise ValueError("Branch source Goal is unavailable")
        before = self.__dict__.copy()
        self._learning_branches = (*self._learning_branches, branch)
        self._branch_commit(before)
        return branch

    def transition_learning_branch_by_user(self, branch_id, action, *, operation_id, expected_revision,
                                           expected_goal_id, expected_task_id, expected_task_revision=0,
                                           handoff="", assistance_provided=False):
        """同一目标只保留一个活动任务；返回不授予掌握、不完成父任务，也不要求考试。"""
        branch = self._branch_by_id(branch_id)
        if not self._goal_profile or expected_goal_id != self._goal_profile.id or branch.goal_id != expected_goal_id:
            raise ValueError("Learning Goal changed")
        if not isinstance(operation_id, str) or not 8 <= len(operation_id) <= 100:
            raise ValueError("Invalid branch operation id")
        if action not in ("accept", "enter", "return", "complete"):
            raise ValueError("Unknown branch action")
        if branch.last_operation_id == operation_id:
            if branch.last_action != action:
                raise ValueError("Operation id was used for another action")
            return branch
        if branch.revision != expected_revision:
            raise ValueError("Learning path changed; reload before retrying")
        active_task = self.get_active_task()
        if expected_task_id != (active_task.id if active_task else None) or expected_task_revision != (active_task.activity_revision if active_task else 0):
            raise ValueError("Current Task changed; this request is stale")
        active_branch = self.active_learning_branch()
        before = self.__dict__.copy()
        tasks = dict(self._tasks)
        graph, goal_skill_ids = self._graph, self._current_goal_skill_ids
        if action == "accept":
            if branch.status not in ("PROPOSED", "READY"):
                raise ValueError("Branch already started")
            branch = replace(branch, status="READY")
        elif action == "enter":
            if active_branch or branch.status == "COMPLETED":
                raise ValueError("Return to the main path before entering another branch")
            if active_task and active_task.id.startswith("review-"):
                raise ValueError("Finish the separate review before entering a learning branch")
            if active_task:
                tasks[active_task.id] = active_task.pause()
            if not branch.skill_ids:
                skill_id = "branch-skill-" + sha256(branch.id.encode()).hexdigest()[:24]
                skill = SkillNode(skill_id, branch.title, branch.scope)
                graph = SkillGraph((*graph.skills, skill))
                goal_skill_ids = (*goal_skill_ids, skill_id)
                branch = replace(branch, skill_ids=(skill_id,), exclusive_skill_ids=(skill_id,))
            frontier = branch.frontier or FrontierPlan(branch.skill_ids[0], branch.reason, LearningDepth.PRACTICAL,
                                                       "DIALOGUE", branch.scope)
            paused = next((tasks[t] for t in reversed(branch.task_ids) if tasks[t].status == TaskStatus.PAUSED), None)
            if paused:
                task = paused.activate()
            else:
                task = LearningTask("branch-task-" + sha256(operation_id.encode()).hexdigest()[:24], branch.title,
                                    branch.scope, (frontier.focus_skill_id,), (), TaskStatus.ACTIVE,
                                    branch.goal_id, branch_id=branch.id)
                branch = replace(branch, task_ids=(*branch.task_ids, task.id))
            skill = graph.get_skill(task.related_skill_ids[0])
            if skill.status is SkillState.NOT_STARTED:
                graph = graph.replace_skill(skill.start_learning())
            tasks[task.id] = task
            branch = replace(branch, status="ACTIVE", frontier=frontier, return_task_id=active_task.id if active_task else None)
        else:
            if not active_branch or active_branch.id != branch.id:
                raise ValueError("Only the current learning branch can return")
            if active_task:
                if active_task.branch_id != branch.id:
                    raise ValueError("Active Task does not belong to this path")
                tasks[active_task.id] = active_task.complete() if action == "complete" else active_task.pause()
            parent = tasks.get(branch.return_task_id)
            if parent:
                if parent.status is not TaskStatus.PAUSED or parent.branch_id:
                    raise ValueError("Main Task changed; refusing to resurrect a different task")
                tasks[parent.id] = parent.activate()
            branch = replace(branch, status="COMPLETED" if action == "complete" else "PAUSED",
                             handoff=str(handoff)[:6000], assistance_provided=branch.assistance_provided or bool(assistance_provided))
        branch = replace(branch, revision=branch.revision + 1, last_operation_id=operation_id, last_action=action)
        self._tasks = tasks
        self._graph, self._current_goal_skill_ids = graph, goal_skill_ids
        self._replace_learning_branch(branch)
        self._branch_commit(before)
        return branch

    def _apply_branch_frontier(self, frontier, added_skills=()):
        branch = self.active_learning_branch()
        if not branch:
            raise ValueError("No active learning branch")
        # 继续补基础只扩充当前分支。新增技能不能覆盖已有身份，也不能写另一目标的路线。
        if any(s.id in {n.id for n in self._graph.skills} or s.status is not SkillState.NOT_STARTED or s.evidence_ids for s in added_skills):
            raise ValueError("New branch skills must be new and unlearned")
        ids = (*branch.skill_ids, *(s.id for s in added_skills))
        if any(s not in ids for s in (frontier.focus_skill_id, *frontier.supporting_skill_ids)):
            raise ValueError("Branch Frontier must stay within its own learning scope")
        graph = SkillGraph((*self._graph.skills, *added_skills))
        self._validate_frontier(frontier, graph)
        before = self.__dict__.copy()
        self._graph = graph
        self._current_goal_skill_ids = (*self._current_goal_skill_ids, *(s.id for s in added_skills))
        self._replace_learning_branch(replace(branch, frontier=frontier, skill_ids=ids,
            exclusive_skill_ids=(*branch.exclusive_skill_ids, *(s.id for s in added_skills)), revision=branch.revision + 1))
        self._branch_commit(before)
        return frontier
