"""成长图谱应用边界：所有模型结果都是带来源的派生资料，不是学习命令。"""
from dataclasses import asdict, replace
from datetime import datetime, timezone
import math
import time
from uuid import uuid4

from app.domain import ArchivedLearningProject, GoalProfile, SkillGraph, SkillNode
from app.domain.growth import DIMENSIONS, DIRECTIONS, POLICY_VERSION, GrowthState, fingerprint, zero_dimensions
from app.growth_protocol import parse_import
from app.domain.learning_branch import LearningBranch


def import_entry_hash(goal):
    # v1新增可选主题标签不能让旧文件失去精确去重能力。
    value = {k: v for k, v in goal.items() if k != "ref"}
    value["skills"] = [{k: v for k, v in s.items() if k != "topic" or v is not None} for s in goal["skills"]]
    return fingerprint(value)


def imported_profile(profile):
    return {**asdict(profile), "created_at": profile.created_at.isoformat()}


def stamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def text(value, maximum=8000, allow_empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not allow_empty and not value.strip()):
        raise ValueError("文字为空或超过长度限制")
    return value.strip()


def strings(value, maximum=8, length=200):
    if not isinstance(value, list) or len(value) > maximum:
        raise ValueError("列表格式或数量不正确")
    return [text(x, length) for x in value]


class Growth:
    def _growth_data(self):
        return self._growth.to_json()

    def _growth_save(self, data, *, immediate=True):
        before = self._growth
        self._growth = GrowthState.from_json(data)
        try:
            self._growth_refresh(immediate=immediate)
            self._state_changed()
        except Exception:
            self._growth = before
            raise

    def _growth_projects(self):
        return {p.goal_profile.id: p for p in self.get_learning_library().projects}

    def _growth_records(self, data=None):
        data = data or self._growth_data()
        projects = self._growth_projects()
        observed, claims = {}, {}
        for goal_id, p in sorted(projects.items()):
            skill_names = {s.id: s.name for s in p.skills}
            for a in p.answer_assessments:
                key = "assessment:" + a.id
                observed[key] = {"id": key, "origin": "observed", "goal_id": goal_id, "skill_id": a.skill_id,
                    "title": a.topic, "task": a.question, "response": a.answer_excerpt,
                    "summary": a.summary, "assistance": a.assistance_level, "occurred_at": a.created_at.isoformat(),
                    "truncated": a.answer_truncated, "source_session_id": a.source_session_id, "source_turn_id": a.source_turn_id}
            for e in p.evidence:
                key = "evidence:" + e.id
                observed.setdefault(key, {"id": key, "origin": "observed", "goal_id": goal_id, "skill_id": e.skill_id,
                    "title": skill_names.get(e.skill_id, "学习表现"), "response": e.description, "source": e.source,
                    "assistance": e.assistance_level.value, "occurred_at": e.created_at.isoformat(),
                    "record_kind": "saved_learning_evidence", "response_format": "kernel_behavior_summary_not_verbatim_answer"})
            for index, claim in enumerate(p.goal_profile.prior_knowledge_claims):
                key = f"prior:{goal_id}:{index}"
                claims[key] = {"id": key, "origin": "self_report", "goal_id": goal_id, "skill_id": None,
                    "title": p.goal_profile.goal_description, "statement": claim, "occurred_at": None}
        for s in data["supplements"].values():
            if s.get("withdrawn") or (s.get("goal_id") and s["goal_id"] not in projects):
                continue
            if s.get("batch_id") and data["batches"][s["batch_id"]].get("withdrawn"):
                continue
            claims[s["id"]] = {"id": s["id"], "origin": "self_report", "goal_id": s.get("goal_id"),
                "skill_id": s.get("skill_id"), "title": "本人补充", "statement": s["text"], "occurred_at": s.get("occurred_at"),
                "claimed_level": s.get("claimed_level"), "created_at": s["created_at"],
                "source": data["batches"][s["batch_id"]]["source"] if s.get("batch_id") else None,
                "imported_at": data["batches"][s["batch_id"]]["created_at"] if s.get("batch_id") else None}
        for s in data["samples"].values():
            if s["goal_id"] not in projects or data["batches"][s["batch_id"]].get("withdrawn") or not (s.get("review") or {}).get("supported"):
                continue
            observed[s["id"]] = {"id": s["id"], "origin": "observed", "goal_id": s["goal_id"], "skill_id": s["skill_id"],
                "title": "外部学习表现", "task": s["question"], "response": s["learner_answer"], "context": s["context"],
                "assistance": s["assistance_level"], "occurred_at": s["occurred_at"], "review": s["review"]["reason"],
                "record_kind": "external_review", "source": data["batches"][s["batch_id"]]["source"],
                "imported_at": data["batches"][s["batch_id"]]["created_at"]}
        return {"observed": [observed[k] for k in sorted(observed)], "self_report": [claims[k] for k in sorted(claims)]}

    def _growth_inputs(self, data):
        projects = self._growth_projects()
        records = self._growth_records(data)
        combined = sorted(records["observed"] + records["self_report"], key=lambda r: r["id"])
        inputs = {"score:integrated": {"basis": "integrated", "records": combined}} if combined else {}
        pending = []
        for goal_id, p in sorted(projects.items()):
            goal = {"goal_id": goal_id, "title": p.goal_profile.goal_description, "outcome": p.goal_profile.desired_outcome,
                    "domain": p.goal_profile.learning_domain}
            classification = data["classifications"].get(goal_id)
            if not classification or classification["goal_hash"] != fingerprint(goal):
                pending.append(goal)
        if pending:
            inputs["classify"] = {"goals": pending}
        for s in data["samples"].values():
            if s["goal_id"] in projects and not s.get("review") and not data["batches"][s["batch_id"]].get("withdrawn"):
                inputs["review:" + s["id"]] = {"sample": {k: v for k, v in s.items() if k not in ("review", "created_at")}}
        goals = [{"goal_id": i, "title": p.goal_profile.goal_description, "outcome": p.goal_profile.desired_outcome,
                  "domain": p.goal_profile.learning_domain,
                  "classification": data["classifications"].get(i),
                  "skills": [{"id": s.id, "name": s.name, "state": s.status.value, "depth": s.target_depth.value} for s in p.skills
                             if not any(s.id in b.exclusive_skill_ids for b in self._learning_branches)],
                  "milestones": [{"id": m.id, "name": m.name, "skill_ids": list(m.skill_ids)} for m in p.curriculum_spine]}
                 for i, p in sorted(projects.items())]
        if goals or records["self_report"]:
            inputs["recommend"] = {"goals": goals,
                "capability": self._growth_evaluation(data, "integrated", combined)["evaluation"],
                "self_reports": records["self_report"],
                "adopted_intents": [a["recommendation"] for a in data["adoptions"].values()
                                    if not a["recommendation"].get("goal_id") or a["recommendation"]["goal_id"] in projects],
                "adopted_branches": [{"id": b.id, "goal_id": b.goal_id, "title": b.title, "scope": b.scope, "status": b.status}
                                     for b in self._learning_branches if b.status != "PROPOSED" and b.goal_id in projects]}
        return inputs

    def _growth_refresh(self, *, immediate=False):
        data = self._growth_data()
        inputs = self._growth_inputs(data)
        changed = False
        for key in list(data["jobs"]):
            if key not in inputs:
                del data["jobs"][key]
                changed = True
        for key, body in inputs.items():
            revision = fingerprint({"policy": POLICY_VERSION, "input": body})
            current = data["jobs"].get(key)
            if not current or current["input_hash"] != revision:
                data["jobs"][key] = {"key": key, "input_hash": revision, "status": "QUEUED", "attempts": 0,
                    "due_at": time.time() + (0 if immediate else 30), "lease": None, "summaries": [], "error": None}
                changed = True
        if changed:
            self._growth = GrowthState.from_json(data)

    def _growth_evaluation(self, data, basis, records):
        if not records:
            return {"status": "READY", "evaluation": {"basis": basis, "dimensions": zero_dimensions(), "created_at": None, "model_id": None}}
        hashes = {r["id"]: fingerprint(r) for r in records}
        current = next((e for e in reversed(data["evaluations"]) if e["basis"] == basis
                        and all(hashes.get(k) == h for k, h in e["source_hashes"].items())), None)
        # 升级期间只回退到仍有效的旧实际表现分；从不拼接、平均两套旧评价。
        if current is None and basis == "integrated":
            current = next((e for e in reversed(data["evaluations"]) if e["basis"] == "observed"
                            and all(hashes.get(k) == h for k, h in e["source_hashes"].items())), None)
        job = data["jobs"].get("score:" + basis, {})
        exact = current and current["input_hash"] == fingerprint({"policy": POLICY_VERSION, "input": {"basis": basis, "records": records}})
        state = "READY" if exact and job.get("status") == "READY" and current["model_id"] == job.get("model_id") else job.get("status", "QUEUED")
        return {"status": state, "evaluation": current, "error": job.get("error")}

    def growth_atlas(self):
        data, projects = self._growth_data(), self._growth_projects()
        records = self._growth_records(data)
        points = []
        for goal_id, p in projects.items():
            basis = {"goal_id": goal_id, "title": p.goal_profile.goal_description, "outcome": p.goal_profile.desired_outcome,
                     "domain": p.goal_profile.learning_domain}
            classified = data["classifications"].get(goal_id)
            if classified and classified["goal_hash"] != fingerprint(basis):
                classified = None
            weights = classified["weights"] if classified else None
            total = sum(weights.values()) if weights else 0
            points.append({**basis, "classification": classified, "status": p.status,
                "started": any(s.status.value != "NOT_STARTED" for s in p.skills),
                "x": (weights["technology"] - weights["humanities"]) / total if total else None,
                "y": (weights["science"] - weights["expression"]) / total if total else None})
        inputs = self._growth_inputs(data)
        recs = data["recommendations"]
        expected = fingerprint({"policy": POLICY_VERSION, "input": inputs["recommend"]}) if "recommend" in inputs else None
        return {"schema_version": "lawa.growth-atlas/v2", "policy_version": POLICY_VERSION, "points": points,
            "dimensions": [{"id": i, "name": n} for i, n in DIMENSIONS],
            "capability": self._growth_evaluation(data, "integrated", sorted(records["observed"] + records["self_report"], key=lambda r: r["id"])),
            "recommendations": recs["items"] if recs and recs["input_hash"] == expected else [],
            "adoptions": [a for a in data["adoptions"].values() if not a["recommendation"].get("goal_id") or a["recommendation"]["goal_id"] in projects],
            "jobs": [{k: j.get(k) for k in ("key", "status", "error", "attempts")} for j in data["jobs"].values()],
            "supplements": [s for s in data["supplements"].values() if not s.get("batch_id") and not s.get("withdrawn")],
            "imports": [self._growth_batch_summary(data, b) for b in reversed(list(data["batches"].values()))]}

    def growth_adopt_recommendation(self, recommendation_id):
        data = self._growth_data()
        if recommendation_id in data["adoptions"]:
            return data["adoptions"][recommendation_id]
        item = next((r for r in self.growth_atlas()["recommendations"] if r["id"] == recommendation_id), None)
        if not item:
            raise ValueError("建议已更新，请重新查看后采纳")
        before = self.__dict__.copy()
        branch_id = None
        if item["kind"] != "explore":
            branch_id = "branch-" + recommendation_id
            # 推荐已由Kernel验证挂接点；保存到目标旁，不激活目标、不改正在进行的课堂。
            branch = LearningBranch(branch_id, item["goal_id"], item["anchor_kind"], item["anchor_id"], "extension",
                                    item["title"], item["reason"], item["prompt"], item["outcome"],
                                    source_ids=(recommendation_id,), source_goal_ids=tuple(item["source_goal_ids"]), status="READY")
            existing = next((b for b in self._learning_branches if b.goal_id == branch.goal_id and b.scope == branch.scope
                             and b.anchor_kind == branch.anchor_kind and b.anchor_id == branch.anchor_id and b.purpose == branch.purpose), None)
            if existing:
                branch_id = existing.id
            else:
                self._learning_branches = (*self._learning_branches, branch)
        adoption = {"id": recommendation_id, "recommendation": item, "branch_id": branch_id, "created_at": stamp()}
        data["adoptions"][recommendation_id] = adoption
        self._growth = GrowthState.from_json(data)
        self._branch_commit(before)
        return adoption

    def growth_source(self, source_id):
        for values in self._growth_records().values():
            found = next((r for r in values if r["id"] == source_id), None)
            if found:
                return found
        raise KeyError("这条来源已不可用")

    def growth_goal_context(self, goal_id):
        if goal_id not in self._growth_projects():
            raise KeyError("目标不可用")
        records = self._growth_records()
        data = self._growth_data()
        topics, grouped, assigned, ordered_ids = [], {}, set(), []
        project = self._growth_projects()[goal_id]
        allowed = {s.id for s in project.skills}
        for batch in data["batches"].values():
            if batch.get("withdrawn"):
                continue
            for entry in batch["entries"]:
                if entry["goal_id"] != goal_id:
                    continue
                groups = entry.get("topics") or [{"name": entry.get("title") or self._growth_projects()[goal_id].goal_profile.goal_description,
                                                   "skill_ids": list(entry["skill_map"].values())}]
                names = {skill_id: group["name"] for group in groups for skill_id in group["skill_ids"]}
                # skill_map按原JSON数组插入并持久化；归组/改主题不能把原本穿插的学习经历重排。
                for skill_id in entry["skill_map"].values():
                    if skill_id in allowed and skill_id not in assigned:
                        name = entry.get("topic_overrides", {}).get(skill_id) or names.get(skill_id) or entry.get("title") or project.goal_profile.goal_description
                        grouped.setdefault(name, []).append(skill_id)
                        assigned.add(skill_id)
                        ordered_ids.append(skill_id)
        topics = [{"id": "topic-" + fingerprint([goal_id, name])[:20], "name": name, "skill_ids": ids} for name, ids in grouped.items()]
        revision = fingerprint({"goal_id": goal_id, "topics": topics,
                                "milestones": [{"id": m.id, "skill_ids": m.skill_ids} for m in project.curriculum_spine]})
        return {"goal_id": goal_id, "topics": topics, "imported_skill_ids": ordered_ids,
                "topic_revision": revision, "requires_initial_route": not project.curriculum_spine,
                "records": [r for rows in records.values() for r in rows if r.get("goal_id") == goal_id],
                "samples": [{**s, "source": data["batches"][s["batch_id"]]["source"], "imported_at": data["batches"][s["batch_id"]]["created_at"]}
                            for s in data["samples"].values() if s["goal_id"] == goal_id and not data["batches"][s["batch_id"]].get("withdrawn")]}

    def growth_assign_topic(self, goal_id, skill_ids, target_kind, target, expected_revision):
        """用户直接整理目录归属；不创建路线阶段、Task、Evidence或掌握状态。"""
        context = self.growth_goal_context(goal_id)
        if context["topic_revision"] != expected_revision:
            raise ValueError("知识点归属已变化，请刷新后再保存")
        selected = strings(skill_ids, 200, 200)
        imported = {s for g in context["topics"] for s in g["skill_ids"]}
        if not selected or len(set(selected)) != len(selected) or not set(selected) <= imported:
            raise ValueError("请选择这个目标中已导入的知识点")
        if target_kind not in ("topic", "milestone"):
            raise ValueError("请选择主题或已有路线阶段")
        target = text(target, 200)
        project, data = self._growth_projects()[goal_id], self._growth_data()
        if target_kind == "milestone" and target not in {m.id for m in project.curriculum_spine}:
            raise ValueError("路线阶段不存在，请刷新后选择")
        if target_kind == "topic":
            for batch in data["batches"].values():
                if batch.get("withdrawn"):
                    continue
                for entry in batch["entries"]:
                    if entry["goal_id"] == goal_id:
                        for skill_id in selected:
                            if skill_id in entry["skill_map"].values():
                                # 原导出的主题保留；本地调整单独存覆盖，不改原文/来源/去重hash。
                                entry.setdefault("topic_overrides", {})[skill_id] = target
        spine = tuple(replace(m, skill_ids=tuple(s for s in m.skill_ids if s not in selected)
                              + (tuple(selected) if target_kind == "milestone" and m.id == target else ()))
                      for m in project.curriculum_spine)
        self._validate_milestone_memberships(spine, tuple(s.id for s in project.skills))
        before = self._growth, self._curriculum_spine, self._learning_history
        if self._goal_profile and self._goal_profile.id == goal_id:
            self._curriculum_spine = spine
        else:
            self._learning_history = tuple(replace(p, curriculum_spine=spine) if p.goal_profile.id == goal_id else p for p in self._learning_history)
        try:
            self._growth_save(data)
        except Exception:
            self._growth, self._curriculum_spine, self._learning_history = before
            raise
        return self.growth_goal_context(goal_id)

    def growth_imported_goal(self, goal_id):
        return any(e["goal_id"] == goal_id for b in self._growth_data()["batches"].values() for e in b["entries"])

    def growth_needs_route(self, goal_id):
        project = self._growth_projects().get(goal_id)
        return bool(project and not project.curriculum_spine and self.growth_imported_goal(goal_id))

    def growth_learning_context(self, offset=0, limit=5, skill_id=None):
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 10:
            raise ValueError("资料分页范围不正确")
        if not self._goal_profile:
            return {"records": [], "next_offset": None, "skills": []}
        context = self.growth_goal_context(self._goal_profile.id)
        rows = [r for r in context["records"] if r["origin"] == "self_report" or r.get("record_kind") == "external_review"]
        # 待评审/不支持的外部原答仍可帮助选教学起点，但绝不伪装成已核验表现。
        included = {r["id"] for r in rows}
        rows.extend({"id": s["id"], "origin": "external_unverified", "goal_id": s["goal_id"], "skill_id": s["skill_id"],
                     "question": s.get("question"), "learner_answer": s["learner_answer"], "context": s["context"],
                     "assistance": s["assistance_level"], "review": s.get("review"), "source": s["source"],
                     "imported_at": s["imported_at"], "occurred_at": s["occurred_at"]}
                    for s in context["samples"] if s["id"] not in included)
        project = self._growth_projects()[self._goal_profile.id]
        by_id = {s.id: s for s in project.skills}
        skill_ids = dict.fromkeys([*context["imported_skill_ids"], *by_id])
        skills = [by_id[s] for s in skill_ids]
        if skill_id is not None:
            if skill_id not in {s.id for s in skills}:
                raise ValueError("知识点不属于当前目标")
            rows = [r for r in rows if r.get("skill_id") in (None, skill_id)]
            skills = [s for s in skills if s.id == skill_id]
        page = []
        for row in rows[offset:offset + limit]:
            value = dict(row)
            truncated = []
            for k, v in value.items():
                if isinstance(v, str) and len(v) > 2400:
                    value[k] = v[:2400]
                    truncated.append(k)
            if isinstance(value.get("source"), dict):
                source = value["source"]
                value["source"] = {k: source.get(k) for k in ("platform", "conversation_title")}
                value["source"]["reference"] = (source.get("reference") or "")[:400]
                if source.get("media_descriptions") or len(source.get("reference") or "") > 400:
                    truncated.append("source")
            value["truncated_fields"] = truncated
            page.append(value)
        return {"goal_id": self._goal_profile.id, "records": page, "total": len(rows),
                "background_summary": project.goal_profile.background_summary[:2400],
                "background_truncated": len(project.goal_profile.background_summary) > 2400,
                "skill_count": len(skills),
                "order_basis": "导入知识点沿用文件中的首次学习顺序，同主题按首次出现归组；多批资料按导入先后追加，不推断跨来源时间。顺序与背景摘要不是完成或掌握证明。",
                "next_offset": offset + limit if offset + limit < max(len(rows), len(skills), len(context["topics"])) else None,
                "skills": [{"id": s.id, "name": s.name, "description": s.description[:400]} for s in skills[offset:offset + limit]],
                "topics": [{**g, "name": g["name"][:200]} for g in context["topics"][offset:offset + limit]],
                "topic_count": len(context["topics"]),
                "unreviewed_samples": sum(s.get("review") is None for s in context["samples"]),
                "boundary": "自述、外部原答与评审用于选择教学起点；external_unverified尚未构成核验表现。原题缺失不猜题，不声称答对。均不授予Task、Evidence或Mastery。截断处须保留未知。"}

    def growth_learning_summary(self, goal_id):
        if not goal_id or not self.growth_imported_goal(goal_id):
            return None
        context = self.growth_goal_context(goal_id)
        claims = [r for r in context["records"] if r["origin"] == "self_report"]
        return {"goal_id": goal_id, "topics": [g["name"][:200] for g in context["topics"]][:20],
                "self_reports": len(claims), "samples": len(context["samples"]),
                "reviewed": sum(bool(s.get("review")) for s in context["samples"]),
                "instruction": "这是带历史记录续学。已有LaWa任务/路线时保留当前接点，不因导入重置。首次接续先用get_imported_learning_context读取背景摘要和相关知识点的原答/评审；按skill_count和next_offset读取需要的页，不能把第一页当全部经历。结合最近未解决问题与用户意愿说明从哪里继续，不默认从数组第一项或零基础重讲。区分AI讲过、用户自述、实际作答与外部评审；能支持当前教学的内容可简短衔接，仅对影响下一步的疑点做必要短检查，不要求逐点重考。记录不足就说明未知，不把导入当掌握或补造Evidence。"}

    def growth_supplement(self, value, supplement_id=None):
        data = self._growth_data()
        if supplement_id:
            old = data["supplements"].get(supplement_id)
            if not old or old.get("withdrawn") or old.get("batch_id"):
                raise KeyError("补充记录不可用")
        else:
            supplement_id = "supplement-" + uuid4().hex
            old = {"id": supplement_id, "created_at": stamp(), "goal_id": None, "skill_id": None, "batch_id": None}
        text(value, 16000)
        data["supplements"][supplement_id] = {**old, "text": value, "updated_at": stamp(), "withdrawn": False}
        self._growth_save(data)
        return data["supplements"][supplement_id]

    def growth_withdraw_supplement(self, supplement_id):
        data = self._growth_data()
        if supplement_id not in data["supplements"] or data["supplements"][supplement_id].get("batch_id"):
            raise KeyError("补充记录不可用")
        data["supplements"][supplement_id]["withdrawn"] = True
        self._growth_save(data)
        return {"withdrawn": True}

    def growth_set_classification(self, goal_id, weights):
        projects = self._growth_projects()
        if goal_id not in projects:
            raise KeyError("目标不可用")
        self._growth_weights(weights)
        p = projects[goal_id]
        goal = {"goal_id": goal_id, "title": p.goal_profile.goal_description, "outcome": p.goal_profile.desired_outcome, "domain": p.goal_profile.learning_domain}
        data = self._growth_data()
        data["classifications"][goal_id] = {"weights": weights, "goal_hash": fingerprint(goal), "manual": True, "reason": "本人调整", "created_at": stamp()}
        self._growth_save(data)
        return data["classifications"][goal_id]

    @staticmethod
    def _growth_weights(weights):
        if not isinstance(weights, dict) or set(weights) != set(DIRECTIONS) or any(type(v) is not int or not 0 <= v <= 3 for v in weights.values()):
            raise ValueError("四类关联程度须为0至3的整数")

    def growth_preview_import(self, payload):
        source, goals, invalid = parse_import(payload)
        data, projects = self._growth_data(), self._growth_projects()
        imported = {entry["entry_hash"]: entry for batch in data["batches"].values() if not batch.get("withdrawn") for entry in batch["entries"]}
        rows = []
        for g in goals:
            entry_hash = import_entry_hash(g)
            same = imported.get(entry_hash)
            suggestions = [{"goal_id": i, "title": p.goal_profile.goal_description} for i, p in projects.items()
                           if p.goal_profile.goal_description.casefold() == g["goal_profile"]["goal_description"].casefold()
                           or g["goal_profile"]["learning_domain"] and p.goal_profile.learning_domain == g["goal_profile"]["learning_domain"]][:5]
            rows.append({"ref": g["ref"], "title": g["goal_profile"]["goal_description"], "skills": len(g["skills"]),
                         "self_reports": len(g["self_reports"]), "samples": len(g["work_samples"]),
                         "warnings": (["部分原题未提供：保留原答，仅按可见内容评审，不推断答题正确性。"] if any(not s["question"] for s in g["work_samples"]) else [])
                                     + (["部分知识点未提供主题，先按原条目归组；导入后可调整归属。"] if any(not s.get("topic") for s in g["skills"]) else []),
                         "duplicate": bool(same), "goal_id": same["goal_id"] if same else None, "suggestions": suggestions})
        return {"preview_hash": fingerprint(payload), "source": source, "goals": rows, "invalid": invalid,
                "suggested_title": source["conversation_title"] or (rows[0]["title"] if rows else "导入的学习记录"),
                "limits": {"bytes": 1048576, "goals": 20, "skills": 200, "samples": 100, "sample_chars": 16000}}

    def growth_commit_import(self, payload, preview_hash, selected_refs, merge_targets, group_title=None):
        if fingerprint(payload) != preview_hash:
            raise ValueError("预览后资料已变化，请重新预览")
        source, goals, invalid = parse_import(payload)
        selected = strings(selected_refs, 20, 100)
        if not selected or len(selected) != len(set(selected)) or not set(selected).issubset({g["ref"] for g in goals}):
            raise ValueError("请选择有效且不重复的目标")
        if not isinstance(merge_targets, dict) or not set(merge_targets).issubset(selected):
            raise ValueError("合并目标不属于本次选择")
        projects, data = self._growth_projects(), self._growth_data()
        if any(v not in projects for v in merge_targets.values()):
            raise ValueError("合并目标已不可用")
        if group_title is not None:
            group_title = text(group_title, 200)
            if merge_targets:
                raise ValueError("合为新目标与追加已有目标不能同时使用")
        # 在同一Kernel事务内暂存Graph/归属/新资料，保存失败全部恢复；不恢复整份历史账本。
        before = (self._growth, self._graph, self._learning_history, self._current_goal_skill_ids)
        batch = next((b for b in data["batches"].values() if b["file_hash"] == preview_hash and not b.get("withdrawn")), None)
        batch = batch or {"id": "import-" + uuid4().hex, "file_hash": preview_hash, "source": source, "created_at": stamp(), "withdrawn": False, "entries": []}
        data["batches"][batch["id"]] = batch
        existing = {e["entry_hash"]: e for b in data["batches"].values() if not b.get("withdrawn") for e in b["entries"]}
        existing_goals = {e["goal_id"] for e in batch["entries"]}
        has_new = any(g["ref"] in selected and import_entry_hash(g) not in existing for g in goals)
        if group_title and has_new and len(existing_goals) > 1:
            raise ValueError("此文件已分别保存为多个目标，请先在导入记录中合为一个目标，或选择分别保存/追加")
        if group_title and has_new and any(i not in projects for i in existing_goals):
            raise ValueError("此前导入的目标已不可用，请选择分别保存或追加已有目标")
        graph = {s.id: s for s in self._graph.skills}
        history = list(self._learning_history)
        current_ids = list(self._current_goal_skill_ids)
        grouped_goal = next((e["goal_id"] for e in batch["entries"]), None) if group_title else None
        for g in goals:
            if g["ref"] not in selected:
                continue
            entry_hash = import_entry_hash(g)
            if entry_hash in existing:
                continue
            target = grouped_goal if group_title else merge_targets.get(g["ref"])
            goal_id = target or "import-goal-" + uuid4().hex
            existing_project = next((p for p in history if p.goal_profile.id == target), None)
            profile = (existing_project.goal_profile if existing_project else projects[target].goal_profile) if target else GoalProfile(id=goal_id, **g["goal_profile"])
            if group_title and not target:
                profile = replace(profile, goal_description=group_title, desired_outcome=group_title)
                grouped_goal = goal_id
            ids = list(existing_project.skill_ids) if existing_project else list(s.id for s in projects[target].skills) if target else []
            skill_map = {}
            for raw in g["skills"]:
                matches = [graph[i] for i in ids if graph[i].name == raw["name"] and graph[i].description == raw["description"]]
                skill = matches[0] if len(matches) == 1 else SkillNode("import-skill-" + uuid4().hex, raw["name"], raw["description"])
                graph[skill.id] = skill
                if skill.id not in ids:
                    ids.append(skill.id)
                skill_map[raw["ref"]] = skill.id
            if target and self._goal_profile and target == self._goal_profile.id:
                current_ids = list(dict.fromkeys([*current_ids, *ids]))
            elif target:
                history = [replace(p, skill_ids=tuple(dict.fromkeys([*p.skill_ids, *ids]))) if p.goal_profile.id == target else p for p in history]
            else:
                history.append(ArchivedLearningProject(profile, (), tuple(ids)))
            for claim in g["self_reports"]:
                identity = "claim-" + uuid4().hex
                data["supplements"][identity] = {"id": identity, "text": claim["statement"], "goal_id": goal_id,
                    "skill_id": skill_map.get(claim["skill_ref"]), "batch_id": batch["id"], "created_at": stamp(), "updated_at": stamp(), "withdrawn": False,
                    "claimed_level": claim["claimed_level"], "occurred_at": None}
            for raw in g["work_samples"]:
                sample = {k: v for k, v in raw.items() if k not in ("ref", "skill_ref")}
                sample.update({"goal_id": goal_id, "skill_id": skill_map[raw["skill_ref"]]})
                sample_hash = fingerprint(sample)
                if any(s["content_hash"] == sample_hash and not data["batches"][s["batch_id"]].get("withdrawn") for s in data["samples"].values()):
                    continue
                identity = "sample-" + uuid4().hex
                data["samples"][identity] = {**sample, "id": identity, "batch_id": batch["id"], "content_hash": sample_hash, "created_at": stamp(), "review": None}
            topics = {}
            for raw in g["skills"]:
                topics.setdefault(raw.get("topic") or g["goal_profile"]["goal_description"], []).append(skill_map[raw["ref"]])
            entry = {"ref": g["ref"], "entry_hash": entry_hash, "goal_id": goal_id, "created_goal": not target, "skill_map": skill_map,
                     "title": g["goal_profile"]["goal_description"], "goal_profile": g["goal_profile"],
                     "topics": [{"name": name, "skill_ids": ids} for name, ids in topics.items()]}
            batch["entries"].append(entry)
            existing[entry_hash] = entry
        self._graph, self._learning_history, self._current_goal_skill_ids = SkillGraph(graph.values()), tuple(history), tuple(current_ids)
        try:
            self._growth_save(data)
        except Exception:
            self._growth, self._graph, self._learning_history, self._current_goal_skill_ids = before
            raise
        return self._growth_batch_summary(self._growth_data(), batch)

    @staticmethod
    def _growth_batch_summary(data, batch):
        samples = [s for s in data["samples"].values() if s["batch_id"] == batch["id"]]
        reviewed = sum(bool(s.get("review")) for s in samples)
        failed = sum(data["jobs"].get("review:" + s["id"], {}).get("status") == "FAILED" for s in samples)
        state = "WITHDRAWN" if batch.get("withdrawn") else "FAILED" if failed else "PENDING_REVIEW" if reviewed < len(samples) else "COMPLETE"
        return {**batch, "goal_count": len({e["goal_id"] for e in batch["entries"]}), "sample_count": len(samples), "reviewed": reviewed, "failed": failed, "state": state,
                "supported": sum(bool(s.get("review", {}) and s["review"].get("supported")) for s in samples)}

    def growth_group_preview(self, batch_id):
        data, projects = self._growth_data(), self._growth_projects()
        batch = data["batches"].get(batch_id)
        if not batch or batch.get("withdrawn"):
            raise KeyError("导入批次不可用")
        ids = list(dict.fromkeys(e["goal_id"] for e in batch["entries"]))
        if not ids or any(i not in projects for i in ids):
            raise ValueError("部分目标已移除，不能整合本批")
        if any(not any(e["goal_id"] == i and e["created_goal"] for e in batch["entries"]) for i in ids):
            raise ValueError("本批追加过其他已有目标，不能移动其原有资料；请在原目标继续学习")
        skill_ids = {s.id for i in ids for s in projects[i].skills}
        protected = [i for i in ids if projects[i].curriculum_spine or any(s.status.value != "NOT_STARTED" for s in projects[i].skills)
                     or any(b.goal_id == i for b in self._learning_branches)
                     or any(t.goal_id == i or set(t.related_skill_ids) & {s.id for s in projects[i].skills} for t in self._tasks.values())]
        if len(protected) > 1 or any(e["goal_id"] in ids for b in data["batches"].values() if b["id"] != batch_id for e in b["entries"]):
            raise ValueError("多个目标已有独立学习进度或其他批次记录，暂不能整合；原记录已保留")
        active = self._goal_profile.id if self._goal_profile and self._goal_profile.id in ids else None
        target = protected[0] if protected else active or ids[0]
        if active and active != target:
            raise ValueError("请先返回本批已开始学习的目标，再整合记录；不会自动切换你的课堂")
        state = {"batch": batch, "target": target, "projects": [{"id": i, "profile": imported_profile(projects[i].goal_profile),
                  "skills": [s.id for s in projects[i].skills]} for i in ids]}
        return {"preview_hash": fingerprint(state), "goal_id": target, "goal_ids": ids, "skill_count": len(skill_ids),
                "topic_count": len(batch["entries"]), "title": batch["source"]["conversation_title"] or projects[target].goal_profile.goal_description}

    def growth_group_import(self, batch_id, preview_hash, title):
        preview = self.growth_group_preview(batch_id)
        if preview["preview_hash"] != preview_hash:
            raise ValueError("整合预览后目标已变化，请重新预览")
        title = text(title, 200)
        data, projects = self._growth_data(), self._growth_projects()
        ids, target = preview["goal_ids"], preview["goal_id"]
        skill_ids = tuple(dict.fromkeys(s.id for i in ids for s in projects[i].skills))
        profile = replace(projects[target].goal_profile, goal_description=title)
        batch = data["batches"][batch_id]
        for entry in batch["entries"]:
            old = projects[entry["goal_id"]].goal_profile
            entry.setdefault("original_goal_id", entry["goal_id"])
            entry.setdefault("title", old.goal_description)
            entry.setdefault("goal_profile", imported_profile(old))
            entry.setdefault("topics", [{"name": entry["title"], "skill_ids": list(entry["skill_map"].values())}])
            entry["goal_id"] = target
        for record in [*data["samples"].values(), *data["supplements"].values()]:
            if record.get("batch_id") == batch_id:
                record["goal_id"] = target
        for sample in data["samples"].values():
            if sample["batch_id"] == batch_id:
                sample["content_hash"] = fingerprint({k: sample[k] for k in ("goal_id", "skill_id", "question", "learner_answer", "feedback", "context", "assistance_level", "occurred_at")})
        before = (self._growth, self._learning_history, self._goal_profile, self._current_goal, self._current_goal_skill_ids)
        # 沿用当前导入目标的身份；原Skill/作答ID和全文均不重建。失败恢复本事务。
        history = [p for p in self._learning_history if p.goal_profile.id not in ids]
        if self._goal_profile and self._goal_profile.id == target:
            self._goal_profile, self._current_goal, self._current_goal_skill_ids = profile, title, skill_ids
        else:
            original = next(p for p in self._learning_history if p.goal_profile.id == target)
            history.append(replace(original, goal_profile=profile, skill_ids=skill_ids))
        self._learning_history = tuple(history)
        batch["group_title"] = title
        try:
            self._growth_save(data)
        except Exception:
            self._growth, self._learning_history, self._goal_profile, self._current_goal, self._current_goal_skill_ids = before
            raise
        return {"goal_id": target, "goal_count": 1, "topic_count": len(batch["entries"]), "skill_count": len(skill_ids)}

    def growth_withdraw_import(self, batch_id):
        data = self._growth_data()
        if batch_id not in data["batches"]:
            raise KeyError("导入批次不可用")
        data["batches"][batch_id]["withdrawn"] = True
        # 已确认的目标身份与后来发生的原生学习保留；仅撤回本批自述/外部样本的有效贡献。
        self._growth_save(data)
        return {"withdrawn": True}

    def growth_retry(self, key=None):
        data = self._growth_data()
        for identity, job in data["jobs"].items():
            if (key is None or identity == key or key.startswith("import-") and identity.startswith("review:") and data["samples"].get(identity[7:], {}).get("batch_id") == key) and job["status"] == "FAILED":
                job.update(status="QUEUED", attempts=0, due_at=time.time(), error=None, lease=None)
        self._growth_save(data)
        return {"queued": True}

    def growth_claim(self, model_id, policy_version=POLICY_VERSION):
        if policy_version != POLICY_VERSION:
            raise ValueError("评分说明版本不匹配")
        model_id = text(model_id, 300)
        data, now = self._growth_data(), time.time()
        inputs = self._growth_inputs(data)
        ordered = sorted(data["jobs"].values(), key=lambda j: (0 if j["key"].startswith("review:") else 1 if j["key"] == "classify" else 2 if j["key"].startswith("score:") else 3, j["due_at"]))
        for job in ordered:
            if job["key"] not in inputs:
                continue
            if job["status"] == "RUNNING" and job.get("lease_until", 0) <= now:
                attempts = job["attempts"] + 1
                job.update(status="FAILED" if attempts >= 2 else "QUEUED", attempts=attempts, lease=None, due_at=now, error="WORKER_LEASE_EXPIRED")
            if job["key"].startswith("score:") and job.get("model_id") and job["model_id"] != model_id and job["status"] != "RUNNING":
                job.update(status="QUEUED", attempts=0, due_at=now, error=None)
            if job["status"] != "QUEUED" or job["due_at"] > now:
                continue
            if job["key"].startswith("score:"):
                cached = next((e for e in reversed(data["evaluations"]) if e["input_hash"] == job["input_hash"] and e["model_id"] == model_id and e["policy_version"] == POLICY_VERSION), None)
                if cached:
                    data["evaluations"].remove(cached)
                    data["evaluations"].append(cached)
                    job.update(status="READY", model_id=model_id, lease=None, error=None, summaries=[])
                    continue
            if job.get("model_id") != model_id:
                job["summaries"] = []
            job.update(status="RUNNING", lease=uuid4().hex, lease_until=now + 90, model_id=model_id, error=None)
            self._growth_save(data, immediate=False)
            return {**job, "policy_version": POLICY_VERSION, "input": inputs[job["key"]]}
        if data != self._growth_data():
            self._growth_save(data, immediate=False)
        return None

    def growth_renew(self, key, lease):
        data = self._growth_data()
        job, _ = self._growth_lease(data, key, lease)
        job["lease_until"] = time.time() + 90
        self._growth_save(data, immediate=False)
        return {"renewed": True}

    def _growth_lease(self, data, key, lease):
        job = data["jobs"].get(key)
        if not job or job["status"] != "RUNNING" or job.get("lease") != lease or job.get("lease_until", 0) < time.time():
            raise ValueError("后台结果已过期")
        body = self._growth_inputs(data).get(key)
        if body is None or job["input_hash"] != fingerprint({"policy": POLICY_VERSION, "input": body}):
            raise ValueError("后台来源已经变化")
        return job, body

    def growth_checkpoint(self, key, lease, summary):
        data = self._growth_data()
        job, body = self._growth_lease(data, key, lease)
        if not key.startswith("score:"):
            raise ValueError("只有能力评估需要分组整理")
        refs = strings(summary.get("source_refs"), 1000, 250)
        valid = {r["id"] for r in body["records"]}
        if not refs or len(set(refs)) != len(refs) or not set(refs).issubset(valid):
            raise ValueError("摘要来源不正确")
        # 摘要过长时允许整组折叠，但不能切掉一个已有摘要的部分来源。
        if any(set(s["source_refs"]).intersection(refs) and not set(s["source_refs"]).issubset(refs) for s in job["summaries"]):
            raise ValueError("折叠摘要必须完整保留来源")
        job["summaries"] = [s for s in job["summaries"] if not set(s["source_refs"]).intersection(refs)]
        job["summaries"].append({"source_refs": refs, "summary": text(summary.get("summary"), 12000)})
        job["lease_until"] = time.time() + 90
        self._growth_save(data, immediate=False)
        return {"saved": True}

    def growth_complete(self, key, lease, result):
        data = self._growth_data()
        job, body = self._growth_lease(data, key, lease)
        if not isinstance(result, dict):
            raise ValueError("模型结果不是对象")
        if key.startswith("score:"):
            basis = body["basis"]
            if result.get("schema_version") != "lawa.capability-evaluation/v1" or result.get("basis") != basis:
                raise ValueError("评价版本或来源层不正确")
            dims = result.get("dimensions")
            if not isinstance(dims, list) or len(dims) != 6 or not all(isinstance(d, dict) for d in dims) or [d.get("id") for d in dims] != [i for i, _ in DIMENSIONS]:
                raise ValueError("评价必须包含固定六维")
            refs = {r["id"]: fingerprint(r) for r in body["records"]}
            clean = []
            for d in dims:
                value = d.get("score")
                if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 5 or abs(value * 10 - round(value * 10)) > 1e-8:
                    raise ValueError("能力分数须为0至5且最多一位小数")
                sources = strings(d.get("source_refs"), 1000, 250)
                if not set(sources).issubset(refs) or (value > 0 and not sources):
                    raise ValueError("评分引用无效或没有依据")
                actual = [r["id"] for r in body["records"] if r["id"] in sources and r["origin"] == "observed"]
                claims = [r["id"] for r in body["records"] if r["id"] in sources and r["origin"] == "self_report"]
                if value > 2 and not actual:
                    raise ValueError("仅有自述的维度不能超过2.0分")
                clean.append({"id": d["id"], "score": value, "rationale": text(d.get("rationale"), 1000),
                    "observed_refs": actual, "self_report_refs": claims,
                    "awaiting_practice": bool(claims and not actual),
                    "source_refs": list(dict.fromkeys(sources)), "coverage": strings(d.get("coverage"), 8), "missing": strings(d.get("missing"), 8)})
            data["evaluations"].append({"id": "evaluation-" + uuid4().hex, "basis": basis, "dimensions": clean,
                "input_hash": job["input_hash"], "source_hashes": refs, "model_id": job["model_id"], "policy_version": POLICY_VERSION, "created_at": stamp()})
        elif key == "classify":
            values = result.get("goals")
            expected = {g["goal_id"]: g for g in body["goals"]}
            if not isinstance(values, list) or len(values) != len(expected) or {g.get("goal_id") for g in values if isinstance(g, dict)} != set(expected):
                raise ValueError("分类结果未覆盖本批目标")
            for g in values:
                self._growth_weights(g.get("weights"))
                data["classifications"][g["goal_id"]] = {"weights": g["weights"], "reason": text(g.get("reason"), 600),
                    "goal_hash": fingerprint(expected[g["goal_id"]]), "manual": False, "created_at": stamp()}
        elif key.startswith("review:"):
            if type(result.get("supported")) is not bool:
                raise ValueError("外部作答评审格式不正确")
            sample_id = key[7:]
            if result.get("sample_id") != sample_id:
                raise ValueError("评审样本身份不正确")
            data["samples"][sample_id]["review"] = {"supported": result["supported"], "reason": text(result.get("reason"), 2000),
                "model_id": job["model_id"], "created_at": stamp(), "content_hash": data["samples"][sample_id]["content_hash"]}
        elif key == "recommend":
            items = result.get("items")
            if not isinstance(items, list) or len(items) > 6:
                raise ValueError("建议最多六条")
            seen = {}
            clean_items = []
            projects = self._growth_projects()
            for item in items:
                if not isinstance(item, dict):
                    raise ValueError("建议格式不正确")
                if item.get("kind") not in ("deepen", "bridge", "explore") or seen.get(item["kind"], 0) >= 2:
                    raise ValueError("建议类型不正确")
                seen[item["kind"]] = seen.get(item["kind"], 0) + 1
                for field in ("title", "reason", "prompt", "outcome"):
                    item[field] = text(item.get(field), 800)
                if item.get("goal_id") is not None and item["goal_id"] not in projects:
                    raise ValueError("建议目标不可用")
                source_goals = strings(item.get("source_goal_ids", []), 6, 250)
                if not set(source_goals).issubset(projects):
                    raise ValueError("建议来源目标不可用")
                if item["kind"] == "explore":
                    if item.get("goal_id") is not None:
                        raise ValueError("新领域探索必须进入新目标流程")
                    item["exploration_domain"] = text(item.get("exploration_domain"), 120)
                    item["anchor_kind"], item["anchor_id"] = None, None
                else:
                    project = projects.get(item.get("goal_id"))
                    if not project:
                        raise ValueError("深化与跨领域应用需要主要目标")
                    kind = item.get("anchor_kind")
                    anchors = [s.id for s in project.skills if not any(s.id in b.exclusive_skill_ids for b in self._learning_branches)] if kind == "skill" else [m.id for m in project.curriculum_spine] if kind == "milestone" else []
                    if item.get("anchor_id") not in anchors:
                        raise ValueError("建议须挂接主线中的知识点或阶段")
                    if item["kind"] == "bridge" and (len(set(source_goals)) < 2 or item["goal_id"] not in source_goals):
                        raise ValueError("跨领域应用需要至少两个目标来源，包含主要目标")
                item["source_goal_ids"] = source_goals
                item["id"] = "recommendation-" + fingerprint({k: item.get(k) for k in ("kind", "goal_id", "anchor_kind", "anchor_id", "prompt", "outcome", "source_goal_ids")})[:24]
                if not any(v["id"] == item["id"] for v in clean_items):
                    clean_items.append(item)
            data["recommendations"] = {"items": clean_items, "input_hash": job["input_hash"], "created_at": stamp()}
        else:
            raise ValueError("未知后台任务")
        job.update(status="READY", lease=None, summaries=[], error=None)
        self._growth_save(data)
        return {"saved": True}

    def growth_release(self, key, lease, failed=False, error_code=None):
        data = self._growth_data()
        job, _ = self._growth_lease(data, key, lease)
        attempts = job["attempts"] + (1 if failed else 0)
        job.update(status="FAILED" if attempts >= 2 else "QUEUED", attempts=attempts, lease=None,
                   due_at=time.time() + (30 if failed else 1), error=text(error_code or "MODEL_REQUEST_FAILED", 100) if failed else None)
        self._growth_save(data, immediate=False)
        return {"status": job["status"]}
