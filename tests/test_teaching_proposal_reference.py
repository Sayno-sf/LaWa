"""Exact proposal identity lookup and current closure facts use isolated real Kernel APIs."""
from dataclasses import asdict, replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import json
import shutil
import subprocess
import unittest
from fastapi.testclient import TestClient
from app.api.main import app, get_learning_service
from app.domain.teaching_evolution import TeachingProposal
from tests.test_answer_assessment import service_fixture, assessment
from tests.test_goal_closure_coverage import route_fixture


class TeachingProposalReferenceTests(unittest.TestCase):
    def setUp(self):
        self.service = service_fixture()
        self.service.record_answer_assessment(assessment())
        app.dependency_overrides[get_learning_service] = lambda: self.service
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        app.dependency_overrides.clear()

    def reference(self, identity):
        response = self.client.get("/api/learning/teaching", params={"proposal_id": identity})
        self.assertEqual(response.status_code, 200)
        return response.json()["proposal_reference"]

    def test_new_and_saved_identity_are_exact_and_do_not_mutate_learning(self):
        for index in range(3):
            identity = f"close-{index}"
            with self.subTest(run=index):
                before = self.service.snapshot()
                self.assertEqual(self.reference(identity)["status"], "NOT_FOUND")
                self.assertEqual(self.service.snapshot(), before)
                payload = {"id": identity, "goal_id": "goal", "kind": "CLOSURE", "text": f"结束建议{index}", "reason": "实际作答",
                    "scope": "GOAL", "assessment_ids": ["assessment-0"], "expected_revision": 1, "revision": 2}
                rejected = self.client.post("/api/learning/teaching/proposals", json=payload)
                self.assertEqual(rejected.status_code, 409, "Kernel version guard remains strict")
                self.assertEqual(self.reference(identity)["status"], "NOT_FOUND")
                payload.update(expected_revision=0, revision=1)
                self.assertEqual(self.client.post("/api/learning/teaching/proposals", json=payload).status_code, 200)
                ref = self.reference(identity)
                self.assertEqual((ref["revision"], ref["status"], ref["kind"]), (1, "PENDING", "CLOSURE"))
                self.assertNotIn("text", ref)
                after = self.service.snapshot()
                self.assertEqual((after.skills, after.tasks, after.evidence, after.answer_assessments),
                    (before.skills, before.tasks, before.evidence, before.answer_assessments))

    def test_deleted_reference_does_not_restore_text_or_accept_recreation(self):
        value = TeachingProposal("deleted", "goal", "STRATEGY", "先给短例子", "实际观察", "GOAL", "", ("assessment-0",))
        self.service.propose_teaching(value)
        self.service.decide_teaching("deleted", 1, "CONFIRM", "", "confirm")
        self.service.decide_teaching("deleted", 2, "DELETE", "", "delete")
        self.assertEqual(self.reference("deleted")["status"], "DELETED")
        self.assertNotIn("text", self.reference("deleted"))
        with self.assertRaisesRegex(ValueError, "deleted"):
            self.service.propose_teaching(value, 0)

    def test_explicit_revision_of_independent_user_strategy_keeps_working(self):
        value = TeachingProposal("user-strategy", "goal", "STRATEGY", "先给短例子", "实际观察", "USER", "",
            ("assessment-0",), source_independent=True)
        self.service.propose_teaching(value)
        self.service.decide_teaching(value.id, 1, "CONFIRM", "", "confirm-user")
        self.service.decide_teaching(value.id, 2, "SUPPLEMENT", "例子还需要更短", "revise-user")
        reference = self.reference(value.id)
        self.assertEqual((reference["status"], reference["revision"]), ("REVISION_REQUESTED", 3))
        revised = replace(value, text="先给一个更短的例子", revision=4)
        self.assertEqual(self.service.propose_teaching(revised, 3).revision, 4)

    @unittest.skipUnless(shutil.which("node"), "cross-runtime regression requires Node")
    def test_actual_typescript_tool_and_kernel_create_first_closure_twice(self):
        """HTTP transport is isolated; both production adapters and strict Kernel logic are real."""
        client = self.client

        class Adapter(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def relay(self):
                content = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                reply = client.request(self.command, self.path, content=content,
                    headers={"Content-Type": "application/json"})
                self.send_response(reply.status_code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(reply.content)))
                self.end_headers()
                self.wfile.write(reply.content)

            do_GET = relay
            do_POST = relay

        server = ThreadingHTTPServer(("127.0.0.1", 0), Adapter)
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        script = f"""
            import assert from 'node:assert/strict';
            import {{createTeachingEvolutionTools}} from './src/teachingEvolution.ts';
            const tool = createTeachingEvolutionTools({{baseUrl:'http://127.0.0.1:{server.server_port}', log:()=>{{}}}})
              .find(tool=>tool.name==='suggest_goal_completion');
              const result=await tool.execute('call', {{proposal_id:'real-cross-runtime', expected_revision:1,
                text:'可结束本次会话，也可继续复习。',reason:'逐节点记录已核对',scope:'GOAL',assessment_ids:['assessment-0']}},
                new AbortController().signal,undefined,{{}});
              const saved=JSON.parse(result.content[0].text);
              assert.equal(saved.status,'PENDING'); assert.equal(saved.revision,1);
              assert.equal(saved.id,'real-cross-runtime');
              assert.ok(saved.closure_progress);
        """
        try:
            for index in range(2):
                with self.subTest(isolated_run=index):
                    self.service = service_fixture()
                    self.service.record_answer_assessment(assessment())
                    before = self.service.snapshot()
                    run = subprocess.run([shutil.which("node"), "--import", "tsx", "--input-type=module", "-e", script],
                        cwd=Path(__file__).resolve().parents[1] / "pi-agent", capture_output=True, text=True,
                        encoding="utf-8", timeout=40)
                    self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
                    self.assertEqual(len(self.service.teaching_proposals()), 1)
                    after = self.service.snapshot()
                    self.assertEqual((after.skills, after.tasks, after.evidence, after.answer_assessments),
                        (before.skills, before.tasks, before.evidence, before.answer_assessments))
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=3)

    def test_closure_latest_help_and_real_skill_status_survive_projection(self):
        for level in ("WITH_HINT", "WITH_HELP", "WITH_REFERENCE"):
            with self.subTest(level=level):
                self.service = route_fixture(covered=6, missing_score=99)
                self.service._answer_assessments = tuple(replace(a, assistance_level=level) if a.skill_id == "s6" else a
                    for a in self.service._answer_assessments)
                before = self.service.snapshot()
                report = self.client.get("/api/learning/teaching").json()["closure_progress"]
                node = report["milestones"][-1]["skills"][0]
                self.assertEqual(node["latest_assessment"]["assistance_level"], level)
                self.assertEqual(node["status"], "LEARNING")
                self.assertEqual(report["user_confirmed_count"], 0)
                self.assertEqual(self.service.snapshot(), before)
