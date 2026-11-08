"""挂接唯一 LearningService 写入口的教学用例；不建立独立账本。"""

from dataclasses import replace, asdict
from hashlib import sha256
import json

from app.domain.teaching_evolution import (
    QuestionContract, AssessmentCorrection, TeachingProposal, ProposalDecision, TeachingEvolutionState,
    bounded, DeletedProposal,
)
from app.domain import TaskStatus, SkillState
from app.domain.assessment_topic import topic_catalog, find_topics


class TeachingEvolution:
    def _validate_teaching(self):
        memberships = {p.goal_profile.id: p.skill_ids for p in self._learning_history}
        memberships.update({p.project.goal_profile.id: p.project.skill_ids for p in self._recycled_projects})
        if self._goal_profile:
            memberships[self._goal_profile.id] = self._current_goal_skill_ids
        for contract in self._teaching.contracts:
            task = self._tasks.get(contract.task_id)
            if contract.skill_id not in memberships.get(contract.goal_id, ()) or not task or task.goal_id != contract.goal_id:
                raise ValueError("Question has unavailable Goal/Task/Skill")
            if contract.review_topic_id is not None and not any((a.topic_id, a.goal_id, a.skill_id) ==
                    (contract.review_topic_id, contract.goal_id, contract.skill_id) for a in self._answer_assessments):
                raise ValueError("Review question lost its original topic scope")
        revisions = {}
        for correction in self._teaching.corrections:
            original = next((a for a in self._answer_assessments if a.id == correction.assessment_id), None)
            if not original or correction.expected_revision != revisions.get(correction.assessment_id, 0):
                raise ValueError("Correction history has an invalid source or revision")
            revised = replace(original, criteria=correction.criteria, summary=correction.summary,
                              strengths=correction.strengths, gaps=correction.gaps)
            if tuple((c.label, c.possible) for c in revised.criteria) != tuple((c.label, c.possible) for c in original.criteria):
                raise ValueError("Correction history changed original scoring requirements")
            self._check_contract(revised)
            revisions[correction.assessment_id] = correction.expected_revision + 1
        for assessment in self._answer_assessments:
            self._check_contract(assessment)
        for proposal in (*self._teaching.proposals, *self._teaching.proposal_versions):
            if proposal.goal_id is None:
                continue  # 已明确确认的独立通用安排不依赖已删除的课堂。
            if proposal.goal_id not in memberships or any(not any(a.id == key and a.goal_id == proposal.goal_id for a in self._answer_assessments) for key in proposal.assessment_ids):
                raise ValueError("Teaching proposal has unavailable source observations")
        for topic in self._teaching.topics:
            if not any((a.topic_id, a.goal_id, a.skill_id) == (topic.id, topic.goal_id, topic.skill_id) for a in self._answer_assessments):
                raise ValueError("Topic identity has no matching source assessment")

    def _save_teaching(self, state: TeachingEvolutionState, tasks=None):
        # 决策与策略激活同一快照提交；磁盘失败时连同任务暂停一起撤销。
        before, old_tasks = self._teaching, self._tasks
        self._teaching = state
        if tasks is not None:
            self._tasks = tasks
        try:
            self._state_changed()
        except Exception:
            self._teaching, self._tasks = before, old_tasks
            raise

    def _teaching_goal(self, goal_id: str):
        if not self._goal_profile or self._goal_profile.id != goal_id or not self.scope_is_available(goal_id):
            raise ValueError("Teaching action must belong to the current available Goal")

    def _teaching_goal_signature(self):
        profile = asdict(self._goal_profile) if self._goal_profile else None
        if profile is not None and not profile.get("learning_domain"):
            profile.pop("learning_domain", None)
        value = {"goal": profile,
                 "spine": [asdict(v) for v in self._curriculum_spine]}
        return sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")).hexdigest()

    def list_assessment_topics(self, query: str = ""):
        if not isinstance(query, str) or len(query) > 160:
            raise ValueError("Topic search requires a short name")
        if not self._goal_profile:
            return []
        catalog = tuple(v for v in topic_catalog(self._answer_assessments, self._teaching.topics) if v.goal_id == self._goal_profile.id)
        return [{**asdict(topic), "match": "EXACT" if exact else "POSSIBLE", "automatic_merge": False}
                for exact, _, topic in find_topics(catalog, query)]

    def teaching_proposals(self):
        return tuple(v for v in self._teaching.proposals if v.goal_id is None or self.scope_is_available(v.goal_id))

    def teaching_proposal_reference(self, identity: str):
        """精确读取版本身份，不恢复删除正文，不创建候选或代做用户决定。"""
        bounded(identity, 200, "proposal_id")
        with self._assessment_lock:
            goal_id = self._goal_profile.id if self._goal_profile else None
            if not goal_id:
                raise ValueError("No current Goal for a teaching proposal")
            if any(item.id == identity for item in self._teaching.deleted_proposals):
                return {"id": identity, "goal_id": goal_id, "status": "DELETED"}
            item = next((item for item in self._teaching.proposals if item.id == identity), None)
            if item is None:
                return {"id": identity, "goal_id": goal_id, "status": "NOT_FOUND"}
            independent_user = item.goal_id is None and item.kind == "STRATEGY" and item.scope == "USER" and item.source_independent
            if item.goal_id != goal_id and not independent_user:
                return {"id": identity, "goal_id": goal_id, "status": "UNAVAILABLE"}
            # goal_id绑定本次提案的目标；USER安排的原来源可为空，补充后仍可按原版本修订。
            return {"id": item.id, "goal_id": goal_id, "source_goal_id": item.goal_id,
                    "kind": item.kind, "status": item.status, "revision": item.revision}

    def goal_closure_progress(self):
        """现有账本的即时只读投影；结束会话不授予路线完成、验证或掌握。"""
        with self._assessment_lock:
            return self._goal_closure_progress_locked()

    def _goal_closure_progress_locked(self):
        if self._goal_profile is None:
            return None
        goal_id = self._goal_profile.id
        current_ids = set(self.learning_paths()["main_skill_ids"])
        tasks = tuple(t for t in self._tasks.values() if t.goal_id == goal_id and not t.branch_id)
        assessments = tuple(self.effective_assessment(a) for a in self._answer_assessments if a.goal_id == goal_id)
        def skill_progress(identity):
            skill = self.get_skill(identity)
            related_tasks = tuple(t for t in tasks if identity in t.related_skill_ids)
            scores = tuple(a for a in assessments if a.skill_id == identity)
            records = tuple(e for e in self._evidence.values() if e.skill_id == identity)
            latest = scores[-1] if scores else None
            return {"id": identity, "name": skill.name, "status": skill.status.value,
                    "tasks": [{"id": t.id, "status": t.status.value} for t in related_tasks],
                    "task_completed": any(t.status is TaskStatus.DONE for t in related_tasks),
                    "response_recorded": bool(scores or records),
                    "evidence_count": len(records), "evidence_scope": "SKILL_HISTORY", "assessment_count": len(scores),
                    "assistance_levels": sorted({e.assistance_level.value for e in records} | {a.assistance_level for a in scores}),
                    "latest_assessment": {"id": latest.id, "score": latest.score, "assistance_level": latest.assistance_level,
                        "source_task_id": latest.source_task_id, "source_turn_id": latest.source_turn_id,
                        "created_at": latest.created_at} if latest else None,
                    "mastered_by_user": skill.status is SkillState.MASTERED_BY_USER}

        # 未展开阶段必须保持未覆盖；不能从综合题文本猜测其他节点已学习。
        milestones = []
        represented = set()
        for stage in self._curriculum_spine:
            ids = tuple(identity for identity in stage.skill_ids if identity in current_ids)
            represented.update(ids)
            items = [skill_progress(identity) for identity in ids]
            milestones.append({"id": stage.id, "name": stage.name, "skills": items,
                "expanded": bool(items), "covered": bool(items) and all(s["response_recorded"] for s in items),
                "tasks_completed": bool(items) and all(s["task_completed"] for s in items)})
        # 旧路线可能缺归属；仍显示这些当前Goal节点，不把它们静默丢掉或猜到某个阶段。
        unassigned = [skill_progress(identity) for identity in self._current_goal_skill_ids if identity in current_ids and identity not in represented]
        skills = {s["id"]: s for stage in milestones for s in stage["skills"]}
        skills.update({s["id"]: s for s in unassigned})
        closures = [p for p in self._teaching.proposals if p.goal_id == goal_id and p.kind == "CLOSURE"]
        latest_closure = closures[-1] if closures else None
        complete = bool(milestones) and all(s["covered"] and s["tasks_completed"] for s in milestones)
        if unassigned:
            complete = complete and all(s["response_recorded"] and s["task_completed"] for s in unassigned)
        report = {"goal_id": goal_id, "plan_revision": self.current_plan_revision,
            "milestone_count": len(milestones), "covered_milestone_count": sum(s["covered"] for s in milestones),
            "milestones": milestones, "unassigned_skills": unassigned,
            "uncovered_milestone_ids": [s["id"] for s in milestones if not s["covered"]],
            "unscored_skill_ids": [s["id"] for s in skills.values() if not s["assessment_count"]],
            "assessment_scope": "AT_LEAST_ONE_PER_SKILL",
            "route_learning_complete": complete,
            "formal_assessment_coverage_complete": bool(skills) and all(s["assessment_count"] for s in skills.values()) and all(s["expanded"] for s in milestones),
            "verification_status": "NOT_INFERRED",
            "user_confirmed_count": sum(s["mastered_by_user"] for s in skills.values()),
            "expanded_skill_count": len(skills),
            # 这是历史用户选择，不是当前会话终态；后来复习DONE也不能把旧决定变成新的结束。
            "latest_end_choice_status": latest_closure.status if latest_closure else None,
            "active_task_present": any(t.status is TaskStatus.ACTIVE for t in tasks),
            "notice": "本次结束、路线学习记录覆盖、正式评分、整体能力验证及用户确认掌握分别呈现；未评分不补分，过程完成不等于全部掌握。"}
        report["snapshot_signature"] = sha256(json.dumps(report, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")).hexdigest()
        return report

    def record_question_contract(self, contract: QuestionContract):
        with self._assessment_lock:
            self._teaching_goal(contract.goal_id)
            old = next((v for v in self._teaching.contracts if v.id == contract.id), None)
            if old:
                # 快照由Kernel保存；重试返回原合同，不能用已变化的Task追溯加要求。
                if replace(contract, created_at=old.created_at, teaching_activity=old.teaching_activity) != old:
                    raise ValueError("Question identity already has different requirements")
                return old
            task = self.get_active_task()
            review = next((a for a in self._answer_assessments if a.topic_id == contract.review_topic_id and
                           (a.goal_id, a.skill_id) == (contract.goal_id, contract.skill_id)), None)
            if not task or task.id != contract.task_id or (contract.review_topic_id is not None and not review) or (not review and contract.skill_id not in task.related_skill_ids):
                raise ValueError("Question requires the current ACTIVE Task")
            if task.teaching_activity is None or contract.activity_revision != task.activity_revision:
                raise ValueError("Question requires the current teaching activity and its exact revision")
            if not review and not {label for label, _ in contract.criteria}.issubset(set(task.teaching_activity.evaluation_focus)):
                raise ValueError("Question criteria must come from the current activity evaluation focus")
            contract = replace(contract, teaching_activity=task.teaching_activity)
            self._save_teaching(replace(self._teaching, contracts=(*self._teaching.contracts, contract)))
            return contract

    def _check_contract(self, assessment):
        if not assessment.contract_id:
            return  # 升级前的自然语言题保留原始兼容语义，不能假造事前要求。
        contract = next((v for v in self._teaching.contracts if v.id == assessment.contract_id), None)
        if not contract or (contract.goal_id, contract.task_id, contract.skill_id, contract.session_id, contract.question) != (
            assessment.goal_id, assessment.source_task_id, assessment.skill_id, assessment.source_session_id, assessment.question
        ):
            raise ValueError("Assessment is not bound to its original question requirements")
        if tuple((c.label, c.possible) for c in assessment.criteria) != contract.criteria:
            raise ValueError("Cannot add or change scoring requirements after the answer")
        if contract.review_topic_id is not None and assessment.topic_id != contract.review_topic_id:
            raise ValueError("Review must retain the original topic identity")

    def effective_assessment(self, assessment):
        result = assessment
        for correction in self._teaching.corrections:
            if correction.assessment_id == assessment.id:
                result = replace(result, criteria=correction.criteria, summary=correction.summary,
                                 strengths=correction.strengths, gaps=correction.gaps, correction_reason=correction.reason)
        return result

    def correct_assessment(self, correction: AssessmentCorrection):
        with self._assessment_lock:
            previous = next((v for v in self._teaching.corrections if v.id == correction.id), None)
            if previous:
                if replace(previous, created_at=correction.created_at) != correction:
                    raise ValueError("Correction request identity conflicts")
                return previous
            original = next((a for a in self._answer_assessments if a.id == correction.assessment_id), None)
            if original is None:
                raise KeyError("Assessment does not exist")
            self._teaching_goal(original.goal_id)
            revision = sum(c.assessment_id == original.id for c in self._teaching.corrections)
            if correction.expected_revision != revision:
                raise ValueError("Assessment changed; reload before correcting")
            revised = replace(original, criteria=correction.criteria, summary=correction.summary,
                              strengths=correction.strengths, gaps=correction.gaps)
            if tuple((c.label, c.possible) for c in revised.criteria) != tuple((c.label, c.possible) for c in original.criteria):
                raise ValueError("Corrections must preserve the original scoring requirements")
            self._check_contract(revised)
            self._save_teaching(replace(self._teaching, corrections=(*self._teaching.corrections, correction)))
            return correction

    def propose_teaching(self, proposal: TeachingProposal, expected_revision: int = 0):
        with self._assessment_lock:
            self._teaching_goal(proposal.goal_id)
            if proposal.status != "PENDING" or proposal.feedback:
                raise ValueError("Teacher cannot confirm its own strategy")
            if proposal.scope == "SUBJECT":
                domain = self._goal_profile.learning_domain
                if not domain or proposal.subject != f"domain:{domain}":
                    raise ValueError("Subject strategies require the current Goal's confirmed learning domain; use GOAL when unknown")
            proposal = replace(proposal, goal_signature=self._teaching_goal_signature())
            fingerprint = sha256(proposal.text.strip().encode("utf-8")).hexdigest()
            if any(v.id == proposal.id or fingerprint in v.fingerprints for v in self._teaching.deleted_proposals):
                raise ValueError("The user deleted this teaching arrangement; do not restore it from conversation history")
            for identity in proposal.assessment_ids:
                if not any(a.id == identity and a.goal_id == proposal.goal_id for a in self._answer_assessments):
                    raise ValueError("Proposal references unavailable learning observations")
            old = next((v for v in self._teaching.proposals if v.id == proposal.id), None)
            if old:
                if replace(old, created_at=proposal.created_at) == proposal:
                    return old
                needs_revision = old.status == "REVISION_REQUESTED" or (old.status == "PENDING" and old.goal_signature != proposal.goal_signature)
                if not needs_revision or old.revision != expected_revision:
                    raise ValueError("Only a requested or outdated proposal may be revised at its exact version")
                if proposal.revision != old.revision + 1 or proposal.kind != old.kind:
                    raise ValueError("Invalid revised proposal version")
            elif expected_revision or proposal.revision != 1:
                raise ValueError("New proposal must start at version 1")
            # 已拒绝的同义文字至少不能通过换ID原样重复呈现。
            if any(v.id != proposal.id and v.kind == proposal.kind and v.text.strip() == proposal.text.strip()
                   and v.status not in {"WITHDRAWN"} for v in self._teaching.proposals):
                raise ValueError("This proposal already exists; do not repeatedly ask")
            values = tuple(v for v in self._teaching.proposals if v.id != proposal.id) + (proposal,)
            self._save_teaching(replace(self._teaching, proposals=values,
                proposal_versions=(*self._teaching.proposal_versions, old) if old else self._teaching.proposal_versions))
            return proposal

    def decide_teaching(self, proposal_id: str, expected_revision: int, action: str, feedback: str, request_id: str):
        bounded(request_id, 200, "request_id")
        if action not in {"CONFIRM", "REJECT", "SUPPLEMENT", "WITHDRAW", "RESTORE", "PAUSE", "DELETE"} or not isinstance(feedback, str) or len(feedback) > 4000:
            raise ValueError("Invalid strategy decision")
        if action == "SUPPLEMENT" and not feedback.strip() or action != "SUPPLEMENT" and feedback:
            raise ValueError("Supplemental feedback is a separate decision, not acceptance")
        decision = ProposalDecision(request_id, proposal_id, expected_revision, action, feedback)
        with self._assessment_lock:
            deleted = next((v for v in self._teaching.deleted_proposals if v.id == proposal_id), None)
            if deleted:
                if action == "DELETE" and (deleted.request_id, deleted.expected_revision) == (request_id, expected_revision):
                    return deleted
                raise ValueError("This teaching arrangement has been deleted")
            if any(v.request_id == request_id for v in self._teaching.deleted_proposals):
                raise ValueError("Request identity cannot be reused for a different decision")
            old_decision = next((v for v in self._teaching.decisions if v.request_id == request_id), None)
            proposal = next((v for v in self._teaching.proposals if v.id == proposal_id), None)
            if proposal is None:
                raise KeyError("Proposal is unavailable")
            # 确认可能已将通用安排与来源解耦；响应丢失后的同请求重试先核对收据。
            if old_decision:
                if old_decision != decision:
                    raise ValueError("Request identity cannot be reused for a different decision")
                return proposal
            if action in {"WITHDRAW", "RESTORE", "DELETE", "SUPPLEMENT"} and proposal.kind == "STRATEGY":
                if proposal.goal_id is not None and not self.scope_is_available(proposal.goal_id):
                    raise ValueError("Strategy source Goal is unavailable")
            else:
                self._teaching_goal(proposal.goal_id)
            if proposal.revision != expected_revision:
                raise ValueError("Proposal changed; reload its latest version")
            if proposal.status == "PENDING" and action in {"CONFIRM", "PAUSE", "SUPPLEMENT"} and proposal.goal_signature != self._teaching_goal_signature():
                raise ValueError("Goal requirements changed; ask the teacher for an updated proposal")
            if action == "DELETE":
                if proposal.kind != "STRATEGY":
                    raise ValueError("Only teaching arrangements may be deleted here")
                # 删除所有策略正文/意见副本；只留散列防止旧Pi记录把同一安排重新激活。
                versions = [v for v in (*self._teaching.proposal_versions, proposal) if v.id == proposal_id]
                deleted = DeletedProposal(proposal_id, proposal.goal_id,
                    tuple(sorted({sha256(v.text.strip().encode("utf-8")).hexdigest() for v in versions})), request_id, expected_revision)
                self._save_teaching(replace(self._teaching,
                    proposals=tuple(v for v in self._teaching.proposals if v.id != proposal_id),
                    proposal_versions=tuple(v for v in self._teaching.proposal_versions if v.id != proposal_id),
                    decisions=tuple(v for v in self._teaching.decisions if v.proposal_id != proposal_id),
                    deleted_proposals=(*self._teaching.deleted_proposals, deleted)))
                return deleted
            if action == "WITHDRAW":
                if proposal.kind != "STRATEGY" or proposal.status != "CONFIRMED":
                    raise ValueError("Only confirmed strategies can be withdrawn")
            elif action == "RESTORE":
                if proposal.kind != "STRATEGY" or proposal.status != "WITHDRAWN":
                    raise ValueError("Only withdrawn strategies can be restored")
            elif proposal.status != "PENDING" and not (action == "SUPPLEMENT" and proposal.kind == "STRATEGY" and proposal.status == "CONFIRMED"):
                raise ValueError("This proposal has already received a decision")
            if action == "PAUSE" and proposal.kind != "CLOSURE":
                raise ValueError("Only a Goal can be paused")
            target = {"CONFIRM": "CONFIRMED", "RESTORE": "CONFIRMED", "REJECT": "REJECTED", "SUPPLEMENT": "REVISION_REQUESTED",
                      "WITHDRAW": "WITHDRAWN", "PAUSE": "PAUSED"}[action]
            updated = replace(proposal, status=target, feedback=feedback, revision=proposal.revision + 1)
            if action == "CONFIRM" and proposal.source_independent:
                # 确认通用方法后，运行时只用个人安排；原观察仅作可删除的来源审计。
                updated = replace(updated, goal_id=None, reason="", assessment_ids=(), goal_signature="")
            values = tuple(updated if v.id == proposal_id else v for v in self._teaching.proposals)
            tasks = None
            if proposal.kind == "CLOSURE" and action in {"CONFIRM", "PAUSE"}:
                tasks = {key: replace(task, status=TaskStatus.PAUSED) if task.goal_id == proposal.goal_id and task.status is TaskStatus.ACTIVE else task
                         for key, task in self._tasks.items()}
            self._save_teaching(replace(self._teaching, proposals=values, decisions=(*self._teaching.decisions, decision),
                                       proposal_versions=(*self._teaching.proposal_versions, proposal)), tasks)
            return updated

    def teaching_context(self, subject: str = "") -> dict:
        goal_id = self._goal_profile.id if self._goal_profile else None
        domain = self._goal_profile.learning_domain if self._goal_profile else ""
        current_subject = f"domain:{domain}" if domain else ""
        # 旧query保留协议兼容，但调用方不能借它读取其他领域的策略。
        # 旧关键词范围从未确认过稳定领域，只能在原Goal继续使用，不扩大旧同意。
        def applicable(item):
            if item.scope == "USER":
                return True
            if item.scope == "GOAL" or not item.subject.startswith("domain:"):
                return item.goal_id == goal_id
            return bool(current_subject) and item.subject == current_subject

        available = self.teaching_proposals()
        pending = [asdict(v) for v in available if (v.goal_id is None or v.goal_id == goal_id) and v.status in {"PENDING", "REVISION_REQUESTED"}]
        confirmed = []
        for item in reversed(available):
            if item.kind != "STRATEGY" or item.status != "CONFIRMED":
                continue
            if not applicable(item):
                continue
            confirmed.append({"id": item.id, "revision": item.revision, "text": item.text,
                              "scope": item.scope, "subject": item.subject})
        omitted = sum(v.kind == "STRATEGY" and v.status == "CONFIRMED" and applicable(v)
                      for v in available) - len(confirmed)
        # 包含撤回/恢复的版本与删除墓碑；重启可重算，不保存第二份策略状态。
        revision_data = (goal_id, current_subject,
                         sorted((v.id, v.revision, v.status) for v in self._teaching.proposals if v.kind == "STRATEGY"),
                         sorted((v.id, v.expected_revision, v.request_id) for v in self._teaching.deleted_proposals))
        preference_revision = sha256(repr(revision_data).encode("utf-8")).hexdigest()
        profiles = ([self._goal_profile] if self._goal_profile else []) + [p.goal_profile for p in self._learning_history]
        domains = sorted({profile.learning_domain for profile in profiles if profile.learning_domain})
        return {"preference_revision": preference_revision, "proposals": pending[-3:], "strategies": confirmed, "strategies_omitted": omitted,
                "closure_progress": self.goal_closure_progress(),
                "learning_domain": domain, "available_domains": domains,
                "notice": "Personal teaching arrangements only; never Evidence, Mastery or authority to override the current user."}

    def _purge_teaching_goal(self, goal_id: str):
        removed = {p.id for p in self._teaching.proposals if p.goal_id == goal_id}
        affected = removed | {p.id for p in self._teaching.proposal_versions if p.goal_id == goal_id}
        source_ids = {a.id for a in self._answer_assessments if a.goal_id == goal_id}
        self._teaching = replace(self._teaching,
            contracts=tuple(c for c in self._teaching.contracts if c.goal_id != goal_id),
            corrections=tuple(c for c in self._teaching.corrections if c.assessment_id not in source_ids),
            proposals=tuple(replace(p, feedback="") if p.id in affected and p.goal_id is None else p
                            for p in self._teaching.proposals if p.goal_id != goal_id),
            proposal_versions=tuple(p for p in self._teaching.proposal_versions if p.id not in affected),
            decisions=tuple(d for d in self._teaching.decisions if d.proposal_id not in affected),
            topics=tuple(t for t in self._teaching.topics if t.goal_id != goal_id))
