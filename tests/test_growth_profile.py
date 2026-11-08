"""Unified evidence, recommendation actions and durable adoption boundaries."""
from dataclasses import replace
import pytest
from app.domain.growth import GrowthState, fingerprint
from tests.test_growth import next_job, result, commit
from tests.test_answer_assessment import service_fixture, assessment


def test_new_claim_retains_every_performance_and_claim_only_axis_is_capped():
    service = service_fixture()
    service.record_answer_assessment(assessment())
    claim = service.growth_supplement("我学过基础写作")
    job = next_job(service, "score:integrated")
    assert {r["origin"] for r in job["input"]["records"]} == {"observed", "self_report"}
    assert any(r["id"] == "assessment:assessment-0" for r in job["input"]["records"])
    value = result(job, 2.1)
    value["dimensions"][1]["source_refs"] = [claim["id"]]
    with pytest.raises(ValueError, match="2.0"):
        service.growth_complete(job["key"], job["lease"], value)
    value["dimensions"][1]["score"] = 2
    service.growth_complete(job["key"], job["lease"], value)
    d = service.growth_atlas()["capability"]["evaluation"]["dimensions"][1]
    assert d["awaiting_practice"] and d["observed_refs"] == []
    assert len(service.snapshot().answer_assessments) == 1
    assert service.get_active_task().id == "ta"


def test_legacy_actual_score_waits_for_new_evaluation_and_source_removal_invalidates_it():
    service = service_fixture()
    service.record_answer_assessment(assessment())
    observed = service._growth_records()["observed"]
    data = service.snapshot().growth.to_json()
    data["evaluations"].append({"id": "legacy", "basis": "observed", "dimensions": result({"input": {"basis": "observed", "records": observed}})["dimensions"],
        "source_hashes": {r["id"]: fingerprint(r) for r in observed}, "input_hash": "legacy-hash", "model_id": "old-model", "policy_version": "growth-v1.3.1", "created_at": "2026-10-01"})
    service._growth = GrowthState.from_json(data)
    service.growth_supplement("用过新工具")
    layer = service.growth_atlas()["capability"]
    assert layer["evaluation"]["id"] == "legacy" and layer["status"] != "READY"
    service.recycle_goal_by_user("goal")
    assert service.growth_atlas()["capability"]["evaluation"] is None


def recommendation(kind="deepen", **kwargs):
    return {"kind": kind, "title": "给输入校验器设计反例", "reason": "已有加法与函数基础，进一步处理边界", "goal_id": "goal",
            "prompt": "实现处理三种输入边界的校验器，并解释失败案例", "outcome": "给出代码与三个反例",
            "source_goal_ids": ["goal"], "anchor_kind": "skill", "anchor_id": "a", **kwargs}


def test_recommendation_uses_topics_and_adoption_preserves_classroom_and_survives_refresh():
    service = service_fixture()
    service.record_answer_assessment(assessment())
    job = next_job(service, "recommend")
    goal = next(g for g in job["input"]["goals"] if g["goal_id"] == "goal")
    assert goal["skills"][0]["state"] == "LEARNING"
    assert "domain" in goal and "milestones" in goal
    service.growth_complete(job["key"], job["lease"], {"items": [recommendation()]})
    item = service.growth_atlas()["recommendations"][0]
    original = service.snapshot()
    adopted = service.growth_adopt_recommendation(item["id"])
    assert service.growth_adopt_recommendation(item["id"]) == adopted
    assert len(service.snapshot().learning_branches) == 1
    assert service.snapshot().tasks == original.tasks
    assert service.snapshot().curriculum_spine == original.curriculum_spine
    assert service.snapshot().current_goal_skill_ids == original.current_goal_skill_ids
    assert service.snapshot().learning_branches[0].status == "READY"
    service.growth_supplement("新增自述触发推荐更新")
    assert service.growth_adopt_recommendation(item["id"])["branch_id"] == adopted["branch_id"]
    assert len(service.get_learning_library().projects) == 1


def test_six_suggestions_two_per_kind_and_bridge_needs_real_sources():
    service = service_fixture()
    other = commit(service)["entries"][0]["goal_id"]
    job = next_job(service, "recommend")
    with pytest.raises(ValueError, match="两个目标"):
        service.growth_complete(job["key"], job["lease"], {"items": [recommendation("bridge")]})
    items = [recommendation(kind, prompt=f"具体挑战{n}", **({"source_goal_ids": ["goal", other]} if kind == "bridge" else
        {"goal_id": None, "exploration_domain": "建筑观察"} if kind == "explore" else {}))
        for kind in ("deepen", "bridge", "explore") for n in range(2)]
    service.growth_complete(job["key"], job["lease"], {"items": items})
    assert len(service.growth_atlas()["recommendations"]) == 6


def test_failed_adoption_rolls_back_both_intent_and_branch():
    service = service_fixture()
    job = next_job(service, "recommend")
    service.growth_complete(job["key"], job["lease"], {"items": [recommendation()]})
    id = service.growth_atlas()["recommendations"][0]["id"]
    original = service.snapshot()
    service.enable_auto_save(lambda _: (_ for _ in ()).throw(OSError("disk")))
    with pytest.raises(OSError): service.growth_adopt_recommendation(id)
    assert service.snapshot() == original
