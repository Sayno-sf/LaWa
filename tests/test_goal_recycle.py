"""回收以真实学习工作区为单位，失败或重启不能丢失事实。"""
import json
import time
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.application import LearningService
from app.domain import (AssistanceLevel, Evidence, EvidenceType, KnowledgeCard, LearningTask,
                        SkillGraph, TaskStatus)
from app.materials import MaterialStore, MaterialError
from app.persistence import JsonLearningStateStore
from app.retrieval_sources import RetrievalSources
from test_goal_workspaces import install


def populated(tmp_path):
    store = JsonLearningStateStore(tmp_path / "state.json")
    service = store.bind(LearningService(SkillGraph([]), current_goal=None))
    install(service, "goal-a", "skill-a")
    service.create_task(LearningTask("task-a", "A", "Study A", ("skill-a",), ()))
    service.activate_task("task-a")
    service.submit_evidence(Evidence("ev-a", "skill-a", EvidenceType.EXPLAIN, "解释原理", AssistanceLevel.INDEPENDENT, "原对话#entry"))
    service.confirm_mastery_by_user("skill-a")
    service.create_knowledge_card(KnowledgeCard("card-a", "skill-a", "问题", "答案", datetime.now(timezone.utc),
                                               learner_note="我的原笔记"))
    materials = MaterialStore(tmp_path / "materials", scope_is_available=service.scope_is_available)
    upload = tmp_path / "a.txt"
    upload.write_text("学习资料原文\n第二行", encoding="utf-8")
    material = materials.create(upload, "a.txt", "goal-a")
    return store, service, materials, material


def test_recycle_excludes_all_projections_and_restore_preserves_exact_facts_after_restart(tmp_path):
    store, service, materials, material = populated(tmp_path)
    original = service.get_learning_library().projects[0]
    task = service.get_task("task-a")
    plan = service.get_current_plan()
    refs = RetrievalSources(service, materials).descriptors()
    assert len(refs) == 3  # card, note, material
    service.recycle_goal_by_user("goal-a")
    assert service.get_learning_library().projects == ()
    assert service.get_learning_overview().current_goal is None
    assert not service.get_learning_overview().skills
    assert not service.get_all_tasks()
    assert not service.get_all_knowledge_cards()
    assert not RetrievalSources(service, materials).descriptors()
    assert materials.list("goal-a")["total"] == 0
    for read in [lambda: service.get_skill("skill-a"), lambda: service.get_task("task-a"),
                 lambda: service.get_evidence("ev-a"), lambda: service.get_knowledge_card("card-a")]:
        with pytest.raises(KeyError): read()
    with pytest.raises(MaterialError): materials._load(material["id"], "goal-a")
    assert (materials.root / material["id"] / "source").exists()
    assert service.snapshot().tasks[0].status is TaskStatus.PAUSED
    resumed = store.load()
    assert resumed is not None
    assert not resumed.get_learning_library().projects
    resumed.restore_goal_by_user("goal-a")
    resumed.restore_goal_by_user("goal-a")
    resumed.switch_goal_by_user("goal-a")
    assert resumed.get_current_plan() == plan
    assert resumed.get_task("task-a") == task
    assert resumed.get_learning_library().projects[0] == original
    materials.scope_is_available = resumed.scope_is_available
    assert RetrievalSources(resumed, materials).descriptors() == refs
    assert store.load().get_task("task-a") == task


def test_current_delete_returns_saved_task_and_archived_delete_leaves_current_unchanged(tmp_path):
    _, service, _, _ = populated(tmp_path)
    install(service, "goal-b", "skill-b", replace=True)
    service.create_task(LearningTask("task-b", "B", "Study B", ("skill-b",), ()))
    service.activate_task("task-b")
    service.recycle_goal_by_user("goal-a")
    assert service.get_active_task().id == "task-b"
    service.restore_goal_by_user("goal-a")
    service.recycle_goal_by_user("goal-b")
    assert service.get_active_task().id == "task-a"
    assert service.get_learning_overview().goal_profile.id == "goal-a"
    assert service.snapshot().tasks[1].status is TaskStatus.PAUSED


def test_failed_persistence_rolls_back_delete_restore_and_purge(tmp_path):
    store, service, _, _ = populated(tmp_path)
    original = service.snapshot()
    def fail(_): raise OSError("disk full")
    service.enable_auto_save(fail)
    with pytest.raises(OSError): service.recycle_goal_by_user("goal-a")
    assert service.snapshot() == original
    store.bind(service)
    service.recycle_goal_by_user("goal-a")
    deleted = service.snapshot()
    service.enable_auto_save(fail)
    with pytest.raises(OSError): service.restore_goal_by_user("goal-a")
    assert service.snapshot() == deleted
    with pytest.raises(OSError): service.purge_goal_by_user("goal-a")
    assert service.snapshot() == deleted


def test_permanent_delete_keeps_shared_skills_evidence_notes_and_dependencies(tmp_path):
    store, service, _, _ = populated(tmp_path)
    install(service, "goal-b", "skill-b", replace=True)
    # 两个 Goal 引用同一真实 Skill：旧事实不能随一个项目一起销毁。
    service._current_goal_skill_ids = ("skill-b", "skill-a")
    service._state_changed()
    service.recycle_goal_by_user("goal-a")
    service.purge_goal_by_user("goal-a")
    assert service.get_skill("skill-a").evidence_ids == ("ev-a",)
    assert service.get_evidence("ev-a").description == "解释原理"
    assert service.get_knowledge_card("card-a").learner_note == "我的原笔记"
    assert store.load().get_skill("skill-a") == service.get_skill("skill-a")
    assert "task-a" not in {t.id for t in service.snapshot().tasks}
    with pytest.raises(KeyError): service.restore_goal_by_user("goal-a")


def test_exclusive_purge_removes_records_without_dangling_references(tmp_path):
    store, service, materials, material = populated(tmp_path)
    service.recycle_goal_by_user("goal-a")
    materials.purge_scope("goal-a")
    service.purge_goal_by_user("goal-a")
    restored = store.load()
    assert not restored.snapshot().skills
    assert not restored.snapshot().evidence
    assert not restored.snapshot().tasks
    assert not restored.snapshot().knowledge_cards
    assert not (materials.root / material["id"]).exists()


def test_draft_recycle_does_not_touch_bound_materials_or_current_goal(tmp_path):
    _, service, materials, material = populated(tmp_path)
    upload = tmp_path / "draft.txt"
    upload.write_text("草稿资料", encoding="utf-8")
    draft = materials.create(upload, "draft.txt", "draft:session-draft")
    current = service.get_learning_overview()
    service.recycle_draft_by_user("draft:session-draft")
    assert service.get_learning_overview() == current
    assert materials.list("goal-a")["total"] == 1
    assert not materials.list("draft:session-draft")["total"]
    materials.purge_scope("draft:session-draft")
    assert not (materials.root / draft["id"]).exists()
    assert (materials.root / material["id"]).exists()


def test_recycled_workspaces_reserve_goal_and_skill_identities_when_new_goal_is_created(tmp_path):
    store, service, _, _ = populated(tmp_path)
    service.recycle_goal_by_user("goal-a")
    with pytest.raises(ValueError): install(service, "goal-a", "skill-a")
    install(service, "goal-b", "skill-b")
    service.restore_goal_by_user("goal-a")
    assert {s.id for s in store.load().snapshot().skills} == {"skill-a", "skill-b"}
    assert service.get_knowledge_card("card-a").learner_note == "我的原笔记"


def test_api_delete_restore_purge_and_old_v2_ledger(tmp_path):
    from app.api.main import app, get_learning_service, get_material_store
    store, service, materials, material = populated(tmp_path)
    old = json.loads(store.path.read_text(encoding="utf-8"))
    old.update(version=2)
    old.pop("recycled_projects"); old.pop("recycled_drafts")
    store.path.write_text(json.dumps(old), encoding="utf-8")
    assert store.load().get_skill("skill-a") == service.get_skill("skill-a")
    app.dependency_overrides[get_learning_service] = lambda: service
    app.dependency_overrides[get_material_store] = lambda: materials
    try:
        with TestClient(app) as client:
            assert client.delete("/api/user/recycle/goals/goal-a").status_code == 409
            # 已整合/已不存在的旧目标不能误报“仍在使用”，否则Node回收重放永远卡住。
            assert client.delete("/api/user/recycle/goals/missing").status_code == 404
            assert client.delete("/api/user/goals/missing").status_code == 404
            assert client.delete("/api/user/goals/goal-a").status_code == 200
            assert client.delete("/api/user/goals/goal-a").status_code == 200
            assert len(client.get("/api/user/recycle").json()["goals"]) == 1
            assert not client.get("/api/learning/retrieval/catalog").json()["sources"]
            assert client.get("/api/learning/tasks/task-a").status_code == 404
            assert client.post("/api/user/goals/goal-a/activate").status_code == 404
            assert client.get(f'/api/learning/retrieval/visual-plan?material_id={material["id"]}&fingerprint=test').status_code == 404
            assert client.post("/api/user/recycle/goals/goal-a/restore").status_code == 200
            assert client.post("/api/user/goals/goal-a/activate").status_code == 200
            assert client.get("/api/learning/tasks/task-a").json()["status"] == "ACTIVE"
            assert client.delete("/api/user/goals/goal-a").status_code == 200
            assert client.delete("/api/user/recycle/goals/goal-a").status_code == 200
            assert not client.get("/api/user/recycle").json()["goals"]
            assert not store.load().snapshot().evidence
    finally:
        app.dependency_overrides.clear()


def test_recycle_interrupts_running_parser_and_restart_does_not_schedule_deleted_scope(tmp_path):
    worker = tmp_path / "worker.py"
    worker.write_text("import time\ntime.sleep(60)\n", encoding="utf-8")
    service = LearningService(SkillGraph([]), current_goal=None)
    install(service, "goal-a", "skill-a")
    materials = MaterialStore(tmp_path / "materials", pdf_worker_path=worker, scope_is_available=service.scope_is_available)
    upload = tmp_path / "large.pdf"; upload.write_bytes(b"%PDF-fake")
    material = materials.create(upload, "large.pdf", "goal-a", background=True)
    path = materials.root / material["id"] / "metadata.json"
    until = time.monotonic() + 3
    while json.loads(path.read_text())["parse_status"] != "processing" and time.monotonic() < until:
        time.sleep(.01)
    assert json.loads(path.read_text())["parse_status"] == "processing"
    service.recycle_goal_by_user("goal-a")
    start = time.monotonic(); materials.close()
    assert time.monotonic() - start < 2
    assert json.loads(path.read_text())["parse_status"] == "queued"
    restarted = MaterialStore(materials.root, pdf_worker_path=worker, scope_is_available=service.scope_is_available)
    assert not restarted._queued
    restarted.close()
    service.restore_goal_by_user("goal-a")
    materials.resume_scope("goal-a")
    until = time.monotonic() + 3
    while json.loads(path.read_text())["parse_status"] != "processing" and time.monotonic() < until:
        time.sleep(.01)
    assert json.loads(path.read_text())["parse_status"] == "processing"
    service.recycle_goal_by_user("goal-a")
    materials.purge_scope("goal-a")
    start = time.monotonic(); materials.close()
    assert time.monotonic() - start < 2, "原件被永久删除后，不能丢失子进程的取消归属"


def test_failed_file_purge_is_durable_and_cannot_restore_a_partly_destroyed_goal(tmp_path, monkeypatch):
    from app.api.main import app, get_learning_service, get_material_store
    store, service, materials, _ = populated(tmp_path)
    app.dependency_overrides[get_learning_service] = lambda: service
    app.dependency_overrides[get_material_store] = lambda: materials
    purge = materials.purge_scope
    def fail(*_): raise OSError("file locked")
    try:
        with TestClient(app) as client:
            assert client.delete("/api/user/goals/goal-a").status_code == 200
            monkeypatch.setattr(materials, "purge_scope", fail)
            assert client.delete("/api/user/recycle/goals/goal-a").status_code == 503
            assert client.get("/api/user/recycle").json()["goals"][0]["purge_started"] is True
            assert store.load().snapshot().recycled_projects[0].purge_started is True
            assert client.post("/api/user/recycle/goals/goal-a/restore").status_code == 409
            monkeypatch.setattr(materials, "purge_scope", purge)
            assert client.delete("/api/user/recycle/goals/goal-a").status_code == 200
    finally:
        app.dependency_overrides.clear()


def test_shared_material_reference_preserves_same_id_bytes_and_moves_ownership_to_existing_goal(tmp_path):
    from app.api.main import app, get_learning_service, get_material_store
    _, service, materials, material = populated(tmp_path)
    source = materials.root / material["id"] / "source"
    original = source.read_bytes()
    install(service, "goal-b", "skill-b", replace=True)
    service.create_knowledge_card(KnowledgeCard("card-b", "skill-b", "共享引用", material["id"], datetime.now(timezone.utc)))
    app.dependency_overrides[get_learning_service] = lambda: service
    app.dependency_overrides[get_material_store] = lambda: materials
    try:
        with TestClient(app) as client:
            assert client.delete("/api/user/goals/goal-a").status_code == 200
            assert client.request("DELETE", "/api/user/recycle/goals/goal-a", json={"material_references": {material["id"]: "nonexistent-goal"}}).status_code == 200
            assert source.read_bytes() == original
            assert materials._load(material["id"], "goal-b")[1]["id"] == material["id"]
            assert any(row["source_id"] == "material:" + material["id"] and row["goal_id"] == "goal-b"
                       for row in client.get("/api/learning/retrieval/catalog").json()["sources"])
            assert client.post("/api/user/goals/goal-a/activate").status_code == 404
            assert not service.scope_is_available("goal-a")
    finally:
        app.dependency_overrides.clear()
