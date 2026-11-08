"""Competition Sprint 1 FastAPI adapter tests."""

import unittest

from fastapi.testclient import TestClient

from app.api.main import app, get_learning_service
from app.bootstrap import build_demo_learning_service


class LearningOverviewApiTests(unittest.TestCase):
    def test_default_product_start_has_no_goal_and_enters_onboarding(self) -> None:
        from app.bootstrap import build_empty_learning_service

        app.dependency_overrides[get_learning_service] = build_empty_learning_service
        with TestClient(app) as client:
            response = client.get("/api/learning/overview")
        app.dependency_overrides.clear()

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIsNone(body["current_goal"])
        self.assertIsNone(body["goal_profile"])
        self.assertEqual(body["curriculum_spine"], [])
        self.assertIsNone(body["current_frontier"])
        self.assertIsNone(body["current_focus"])
        self.assertIsNone(body["active_task"])
        self.assertEqual(body["skills"], [])
        self.assertEqual(body["recent_evidence"], [])
        self.assertEqual(body["learning_history"], [])
        self.assertEqual(body["current_goal_skill_ids"], [])

    def test_overview_openapi_contract_is_registered(self) -> None:
        with TestClient(app) as client:
            response = client.get("/openapi.json")
        self.assertEqual(response.status_code, 200)
        self.assertIn("/api/learning/overview", response.json()["paths"])

    def test_learning_library_projects_kernel_history_with_full_evidence(self) -> None:
        from app.bootstrap import build_gradient_demo_learning_service

        app.dependency_overrides[get_learning_service] = build_gradient_demo_learning_service
        with TestClient(app) as client:
            response = client.get("/api/learning/library")
        app.dependency_overrides.clear()

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(len(body["projects"]), 1)
        project = body["projects"][0]
        self.assertEqual(project["status"], "CURRENT")
        self.assertEqual(project["goal_profile"]["id"], "gradient-for-deep-learning")
        self.assertGreaterEqual(len(project["skills"]), 1)
        evidence_ids = {
            evidence["id"]
            for evidence in project["evidence"]
        }
        self.assertIn("demo-gradient-evidence-01", evidence_ids)

    def test_empty_learning_library_has_no_projects(self) -> None:
        from app.bootstrap import build_empty_learning_service

        app.dependency_overrides[get_learning_service] = build_empty_learning_service
        with TestClient(app) as client:
            response = client.get("/api/learning/library")
        app.dependency_overrides.clear()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"projects": []})


class CurriculumApiTests(unittest.TestCase):
    def test_evidence_for_supporting_skill_requires_its_own_active_task(self) -> None:
        initialized = self.client.post(
            "/api/learning/curriculum/initialize",
            json=self.curriculum_payload(),
        )
        self.assertEqual(initialized.status_code, 201)
        evidence = {
            "skill_id": "channel",
            "evidence_type": "EXPLAIN",
            "description": "Independent explanation",
            "assistance_level": "INDEPENDENT",
            "source": "teaching conversation",
        }
        self.assertEqual(self.client.post("/api/learning/evidence", json=evidence).status_code, 409)

        created = self.client.post(
            "/api/learning/tasks",
            json={
                "title": "Teach feature map",
                "description": "First Skill",
                "related_skill_ids": ["feature-map"],
                "expected_evidence_types": ["EXPLAIN"],
            },
        )
        self.assertEqual(created.status_code, 201)
        self.assertEqual(
            self.client.post(f"/api/learning/tasks/{created.json()['id']}/activate").status_code,
            200,
        )
        blocked = self.client.post("/api/learning/evidence", json=evidence)
        self.assertEqual(blocked.status_code, 409)
        self.assertIn("ACTIVE LearningTask", blocked.json()["detail"])
        self.assertEqual(self.service.get_skill("channel").evidence_ids, ())

    def setUp(self) -> None:
        from app.bootstrap import build_empty_learning_service

        self.service = build_empty_learning_service()
        app.dependency_overrides[get_learning_service] = lambda: self.service
        self.client = TestClient(app)

    def tearDown(self) -> None:
        self.client.close()
        app.dependency_overrides.clear()

    @staticmethod
    def curriculum_payload() -> dict[str, object]:
        milestones = [
            ("pytorch-vision", "PyTorch Vision", "PRACTICAL"),
            ("cnn", "CNN", "PRACTICAL"),
            ("feature-hierarchy", "Feature Hierarchy", "PRACTICAL"),
            ("object-detection", "Object Detection", "DEEP"),
            ("detection-architecture", "Detection Architecture", "DEEP"),
            ("yolo", "YOLO", "DEEP"),
            ("detection-project", "Detection Project", "PRACTICAL"),
        ]
        return {
            "goal_profile": {
                "id": "goal-yolo",
                "goal_description": "系统学习目标检测并真正理解 YOLO",
                "background_summary": "研究生，有数学基础，做过 AI 辅助的 YOLO 项目",
                "desired_outcome": "独立理解、修改并完成视觉检测项目",
                "learning_preferences": ["项目实践为主", "核心原理适当深入"],
                "time_constraint": "每天 1～2 小时",
                "prior_knowledge_claims": ["学过 CNN", "做过 YOLO"],
            },
            "curriculum_spine": [
                {
                    "id": milestone_id,
                    "name": name,
                    "description": name,
                    "target_depth": depth,
                }
                for milestone_id, name, depth in milestones
            ],
            "frontier_skills": [
                {
                    "id": "feature-map",
                    "name": "Feature Map",
                    "description": "理解卷积输出的空间响应",
                    "prerequisites": [],
                    "target_depth": "PRACTICAL",
                },
                {
                    "id": "channel",
                    "name": "Channel",
                    "description": "理解输入输出通道",
                    "prerequisites": ["feature-map"],
                    "target_depth": "PRACTICAL",
                },
            ],
            "frontier": {
                "focus_skill_id": "feature-map",
                "supporting_skill_ids": ["channel"],
                "reason": "已有项目背景，从 CNN 表征开始 diagnostic",
                "target_depth": "PRACTICAL",
                "suggested_learning_mode": "EXPLAIN",
                "next_action": "理解 feature map 与 channel",
            },
            "replace_existing": False,
        }

    def test_initialize_curriculum_returns_structured_plan_without_prior_evidence(self) -> None:
        response = self.client.post(
            "/api/learning/curriculum/initialize",
            json=self.curriculum_payload(),
        )
        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertEqual(body["goal_profile"]["id"], "goal-yolo")
        self.assertEqual(len(body["curriculum_spine"]), 7)
        self.assertEqual(body["frontier"]["focus_skill_id"], "feature-map")

        overview = self.client.get("/api/learning/overview").json()
        self.assertEqual(overview["current_goal"], "系统学习目标检测并真正理解 YOLO")
        self.assertEqual(overview["skills"][0]["target_depth"], "PRACTICAL")
        self.assertEqual(overview["skills"][0]["status"], "NOT_STARTED")
        self.assertEqual(
            overview["current_goal_skill_ids"],
            ["feature-map", "channel"],
        )
        self.assertEqual(overview["recent_evidence"], [])

    def test_initialize_rejects_overplanning_and_silent_goal_replacement(self) -> None:
        payload = self.curriculum_payload()
        payload["curriculum_spine"] = payload["curriculum_spine"][:4]
        invalid = self.client.post("/api/learning/curriculum/initialize", json=payload)
        self.assertEqual(invalid.status_code, 422)

        payload = self.curriculum_payload()
        self.assertEqual(
            self.client.post("/api/learning/curriculum/initialize", json=payload).status_code,
            201,
        )
        repeated = self.client.post("/api/learning/curriculum/initialize", json=payload)
        self.assertEqual(repeated.status_code, 409)
        self.assertIn("already exists", repeated.json()["detail"])

    def test_apply_frontier_plan_uses_structured_changes_and_preserves_history(self) -> None:
        self.assertEqual(
            self.client.post(
                "/api/learning/curriculum/initialize",
                json=self.curriculum_payload(),
            ).status_code,
            201,
        )
        response = self.client.post(
            "/api/learning/frontier/apply",
            json={
                "frontier": {
                    "focus_skill_id": "receptive-field",
                    "supporting_skill_ids": ["feature-map"],
                    "reason": "diagnostic complete; expand one step",
                    "target_depth": "DEEP",
                    "suggested_learning_mode": "BUILD",
                    "next_action": "build a receptive-field experiment",
                },
                "added_skills": [
                    {
                        "id": "receptive-field",
                        "name": "Receptive Field",
                        "description": "connect stacked convolutions to visible input area",
                        "prerequisites": ["feature-map"],
                        "target_depth": "DEEP",
                    }
                ],
                "depth_changes": [
                    {"skill_id": "channel", "target_depth": "DEEP"}
                ],
                "prerequisite_additions": [],
                "remove_skill_ids": [],
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["focus_skill_id"], "receptive-field")
        overview = self.client.get("/api/learning/overview").json()
        by_id = {skill["id"]: skill for skill in overview["skills"]}
        self.assertEqual(by_id["channel"]["target_depth"], "DEEP")
        self.assertEqual(by_id["receptive-field"]["status"], "NOT_STARTED")

    def test_plan_revision_stays_pending_until_real_decision_then_updates_all_layers(self) -> None:
        self.assertEqual(
            self.client.post(
                "/api/learning/curriculum/initialize",
                json=self.curriculum_payload(),
            ).status_code,
            201,
        )
        payload = self.curriculum_payload()
        payload["goal_profile"] = {
            **payload["goal_profile"],
            "goal_description": "只学习新版目标检测主线",
            "desired_outcome": "只按新版完成检测项目",
        }
        payload["curriculum_spine"] = [
            {**item, "name": f"新版：{item['name']}"}
            for item in payload["curriculum_spine"]
        ]
        payload.pop("frontier_skills")
        payload.pop("replace_existing")
        payload.update({
            "id": "plan-revision-api",
            "added_skills": [{
                "id": "new-feature-map",
                "name": "新版 Feature Map",
                "description": "新版主线",
                "prerequisites": [],
                "target_depth": "PRACTICAL",
            }],
            "updated_skills": [],
            "remove_skill_ids": ["feature-map", "channel"],
            "frontier": {
                "focus_skill_id": "new-feature-map",
                "supporting_skill_ids": [],
                "reason": "考试范围改为只含新版",
                "target_depth": "PRACTICAL",
                "suggested_learning_mode": "EXPLAIN",
                "next_action": "讲新版 feature map",
            },
            "reason": "用户明确更正考试范围与期望结果",
        })

        prepared = self.client.post("/api/learning/plan-revisions", json=payload)
        self.assertEqual(prepared.status_code, 201)
        self.assertEqual(prepared.json()["status"], "PENDING")
        self.assertEqual(
            self.client.get("/api/learning/overview").json()["goal_profile"]["desired_outcome"],
            "独立理解、修改并完成视觉检测项目",
        )

        decided = self.client.post(
            "/api/learning/plan-revisions/plan-revision-api/decision",
            json={
                "action": "CONFIRM",
                "feedback": "",
                "request_id": "real-user-confirmation",
            },
        )
        self.assertEqual(decided.status_code, 200)
        self.assertEqual(decided.json()["status"], "CONFIRMED")
        overview = self.client.get("/api/learning/overview").json()
        self.assertEqual(overview["goal_profile"]["desired_outcome"], "只按新版完成检测项目")
        self.assertEqual(overview["current_frontier"]["focus_skill_id"], "new-feature-map")
        self.assertEqual(overview["plan_revision"], 1)


class LearningWriteApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.service = build_demo_learning_service()
        app.dependency_overrides[get_learning_service] = lambda: self.service
        self.client = TestClient(app)

    def tearDown(self) -> None:
        self.client.close()
        app.dependency_overrides.clear()

    def test_create_task_rejects_duplicate_and_cannot_activate_second_task(self) -> None:
        first = self.client.post(
            "/api/learning/tasks",
            json={
                "title": "理解 CNN Feature Map",
                "description": "解释 channel 与 feature map，并推导输出 shape",
                "related_skill_ids": ["cnn"],
                "expected_evidence_types": ["EXPLAIN"],
            },
        )
        self.assertEqual(first.status_code, 201)

        duplicate = self.client.post(
            "/api/learning/tasks",
            json={
                "title": "理解 CNN Feature Map",
                "description": "重复任务",
                "related_skill_ids": ["cnn"],
                "expected_evidence_types": ["EXPLAIN"],
            },
        )
        self.assertEqual(duplicate.status_code, 409)
        self.assertIn("Duplicate current LearningTask", duplicate.json()["detail"])

        activated_first = self.client.post(
            f"/api/learning/tasks/{first.json()['id']}/activate"
        )
        self.assertEqual(activated_first.status_code, 200)

        second = self.client.post(
            "/api/learning/tasks",
            json={
                "title": "实现 CNN classifier",
                "description": "连接网络与训练循环",
                "related_skill_ids": ["cnn-classifier"],
                "expected_evidence_types": ["BUILD"],
            },
        )
        self.assertEqual(second.status_code, 201)
        self.assertEqual(second.json()["status"], "TODO")

        activation = self.client.post(
            f"/api/learning/tasks/{second.json()['id']}/activate"
        )
        self.assertEqual(activation.status_code, 409)
        self.assertIn("already ACTIVE", activation.json()["detail"])
        self.assertEqual(len(self.service.get_all_tasks()), 3)

    def test_create_task_rejects_multiple_related_skills(self) -> None:
        response = self.client.post(
            "/api/learning/tasks",
            json={
                "title": "Teach CNN and classifier",
                "description": "Two skills in one task",
                "related_skill_ids": ["cnn", "cnn-classifier"],
                "expected_evidence_types": ["EXPLAIN"],
            },
        )
        self.assertEqual(response.status_code, 422)
        self.assertIsNone(self.service.get_active_task())

    def test_complete_then_create_todo_and_explicitly_activate_next_task(self) -> None:
        current = self.client.post(
            "/api/learning/tasks",
            json={
                "title": "理解 CNN Feature Map",
                "description": "解释 channel 与 feature map",
                "related_skill_ids": ["cnn"],
                "expected_evidence_types": ["EXPLAIN"],
            },
        )
        self.assertEqual(current.status_code, 201)
        self.assertEqual(
            self.client.post(
                f"/api/learning/tasks/{current.json()['id']}/activate"
            ).status_code,
            200,
        )
        self.assertEqual(self.service.get_skill("cnn").status.value, "LEARNING")
        completed = self.client.post(
            f"/api/learning/tasks/{current.json()['id']}/complete"
        )
        self.assertEqual(completed.status_code, 200)
        self.assertEqual(completed.json()["status"], "DONE")
        self.assertIsNone(self.client.get("/api/learning/overview").json()["current_focus"])

        repeated = self.client.post(
            f"/api/learning/tasks/{current.json()['id']}/complete"
        )
        self.assertEqual(repeated.status_code, 409)

        created = self.client.post(
            "/api/learning/tasks",
            json={
                "title": "实现 CNN classifier",
                "description": "连接网络与训练循环",
                "related_skill_ids": ["cnn-classifier"],
                "expected_evidence_types": ["BUILD"],
            },
        )
        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.json()["status"], "TODO")
        self.assertIsNone(
            self.client.get("/api/learning/overview").json()["current_focus"]
        )

        activated = self.client.post(
            f"/api/learning/tasks/{created.json()['id']}/activate"
        )
        self.assertEqual(activated.status_code, 200)
        self.assertEqual(activated.json()["status"], "ACTIVE")
        self.assertEqual(
            self.client.get("/api/learning/overview").json()["current_focus"]["id"],
            created.json()["id"],
        )

    def test_submit_evidence_links_skill_without_changing_mastery(self) -> None:
        before = self.service.get_skill("training-loop").status
        response = self.client.post(
            "/api/learning/evidence",
            json={
                "skill_id": "training-loop",
                "evidence_type": "BUILD",
                "description": "独立完成 validation 并跑通",
                "assistance_level": "INDEPENDENT",
                "source": "user report",
            },
        )
        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertEqual(body["skill_id"], "training-loop")
        self.assertEqual(body["assistance_level"], "INDEPENDENT")
        self.assertIn(body["id"], self.service.get_skill("training-loop").evidence_ids)
        self.assertEqual(self.service.get_skill("training-loop").status, before)
        self.assertEqual(
            self.client.get("/api/learning/overview").json()["recent_evidence"][0]["id"],
            body["id"],
        )

    def test_write_validation_rejects_unknown_skill_and_unknown_enums(self) -> None:
        missing_skill = self.client.post(
            "/api/learning/evidence",
            json={
                "skill_id": "missing",
                "evidence_type": "BUILD",
                "description": "不可关联",
                "assistance_level": "WITH_REFERENCE",
                "source": "user report",
            },
        )
        self.assertEqual(missing_skill.status_code, 404)

        invalid_enum = self.client.post(
            "/api/learning/evidence",
            json={
                "skill_id": "training-loop",
                "evidence_type": "QUIZ",
                "description": "错误枚举",
                "assistance_level": "EXPERT",
                "source": "user report",
            },
        )
        self.assertEqual(invalid_enum.status_code, 422)

        invalid_task = self.client.post(
            "/api/learning/tasks",
            json={
                "title": "未知技能任务",
                "description": "不可创建",
                "related_skill_ids": ["missing"],
                "expected_evidence_types": ["BUILD"],
            },
        )
        self.assertEqual(invalid_task.status_code, 404)

    def test_user_can_confirm_mastery_and_reopen_through_user_routes(self) -> None:
        mastered = self.client.post(
            "/api/user/skills/training-loop/confirm-mastery"
        )
        self.assertEqual(mastered.status_code, 200)
        self.assertEqual(mastered.json()["status"], "MASTERED_BY_USER")

        repeated = self.client.post(
            "/api/user/skills/training-loop/confirm-mastery"
        )
        self.assertEqual(repeated.status_code, 409)
        self.assertEqual(
            self.service.get_skill("training-loop").status.value,
            "MASTERED_BY_USER",
        )

        reopened = self.client.post("/api/user/skills/training-loop/reopen")
        self.assertEqual(reopened.status_code, 200)
        self.assertEqual(reopened.json()["status"], "PRACTICING")

    def test_user_can_confirm_mastery_directly_from_learning_through_user_route(self) -> None:
        created = self.client.post(
            "/api/learning/tasks",
            json={
                "title": "CNN Feature Map",
                "description": "学习卷积输出形状",
                "related_skill_ids": ["cnn"],
                "expected_evidence_types": ["EXPLAIN"],
            },
        )
        self.client.post(f"/api/learning/tasks/{created.json()['id']}/activate")
        self.assertEqual(self.service.get_skill("cnn").status.value, "LEARNING")

        mastered = self.client.post("/api/user/skills/cnn/confirm-mastery")

        self.assertEqual(mastered.status_code, 200)
        self.assertEqual(mastered.json()["status"], "MASTERED_BY_USER")

    def test_user_can_abandon_an_active_task_through_the_user_route(self) -> None:
        created = self.client.post(
            "/api/learning/tasks",
            json={
                "title": "旧目标任务",
                "description": "即将被新 Goal 替换",
                "related_skill_ids": ["cnn"],
                "expected_evidence_types": ["EXPLAIN"],
            },
        )
        task_id = created.json()["id"]
        self.assertEqual(
            self.client.post(f"/api/learning/tasks/{task_id}/activate").status_code,
            200,
        )

        abandoned = self.client.post(f"/api/user/tasks/{task_id}/abandon")

        self.assertEqual(abandoned.status_code, 200)
        self.assertEqual(abandoned.json()["status"], "SKIPPED")
        self.assertIsNone(self.client.get("/api/learning/overview").json()["active_task"])

        missing = self.client.post("/api/user/skills/missing/confirm-mastery")
        self.assertEqual(missing.status_code, 404)

    def test_user_can_explicitly_move_a_learning_skill_to_practicing(self) -> None:
        created = self.client.post(
            "/api/learning/tasks",
            json={
                "title": "CNN Feature Map",
                "description": "学习卷积输出形状",
                "related_skill_ids": ["cnn"],
                "expected_evidence_types": ["EXPLAIN"],
            },
        )
        self.assertEqual(created.status_code, 201)
        activated = self.client.post(
            f"/api/learning/tasks/{created.json()['id']}/activate"
        )
        self.assertEqual(activated.status_code, 200)
        self.assertEqual(self.service.get_skill("cnn").status.value, "LEARNING")

        practicing = self.client.post(
            "/api/user/skills/cnn/start-practicing"
        )
        self.assertEqual(practicing.status_code, 200)
        self.assertEqual(practicing.json()["status"], "PRACTICING")

        repeated = self.client.post("/api/user/skills/cnn/start-practicing")
        self.assertEqual(repeated.status_code, 409)


if __name__ == "__main__":
    unittest.main()
