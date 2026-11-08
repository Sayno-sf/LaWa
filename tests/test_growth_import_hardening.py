"""AI导出常见空值、主题归组和后续学习上下文的真实Kernel回归。"""
from copy import deepcopy
import unittest

from app.bootstrap import build_empty_learning_service
from app.growth_protocol import parse_import
from tests.test_growth import payload
from app.domain import LearningTask
from app.domain.growth import fingerprint
from app.persistence import JsonLearningStateStore
from tempfile import TemporaryDirectory
from pathlib import Path
import json


class ImportHardeningTests(unittest.TestCase):
    def test_import_order_survives_topic_regrouping_and_restart(self):
        value = payload(); goal = value['goals'][0]
        goal['self_reports'] = []; goal['work_samples'] = []
        goal['skills'] = [
            {'ref': 's9', 'name': '先看Transformer', 'topic': '序列建模'},
            {'ref': 's2', 'name': '再补Tensor', 'topic': '基础'},
            {'ref': 's1', 'name': '回到Attention', 'topic': '序列建模'},
        ]
        service = build_empty_learning_service()
        preview = service.growth_preview_import(value)
        batch = service.growth_commit_import(value, preview['preview_hash'], ['g1'], {})
        entry = batch['entries'][0]; goal_id = entry['goal_id']
        service.switch_goal_by_user(goal_id)
        ids = list(entry['skill_map'].values())
        context = service.growth_goal_context(goal_id)
        service.growth_assign_topic(goal_id, [ids[1]], 'topic', '序列建模', context['topic_revision'])
        self.assertEqual(service.growth_goal_context(goal_id)['topics'][0]['skill_ids'], ids)
        with TemporaryDirectory() as folder:
            store = JsonLearningStateStore(Path(folder) / 'state.json'); store.save(service)
            restored = store.load()
            self.assertEqual(restored.growth_goal_context(goal_id)['topics'][0]['skill_ids'], ids)
            names = [s['name'] for offset in range(3)
                     for s in restored.growth_learning_context(offset=offset, limit=1)['skills']]
            self.assertEqual(names, [s['name'] for s in goal['skills']])
            self.assertEqual(restored.snapshot().tasks, ())

    def test_optional_null_title_and_blank_question_keep_original_answer(self):
        value = payload()
        value["source"]["conversation_title"] = None
        value["source"]["media_descriptions"] = None
        sample = value["goals"][0]["work_samples"][0]
        sample.update(question="", feedback=None, context=None, assistance_level=None, occurred_at="")
        sample["learner_answer"] = "def f():\n    return 1\n"
        source, valid, invalid = parse_import(value)
        self.assertFalse(invalid)
        self.assertEqual(source["conversation_title"], "")
        self.assertIsNone(valid[0]["work_samples"][0]["question"])
        self.assertEqual(valid[0]["work_samples"][0]["learner_answer"], sample["learner_answer"])
        self.assertEqual(valid[0]["work_samples"][0]["assistance_level"], "UNKNOWN")

    def test_required_answer_error_is_short_chinese_and_points_to_field(self):
        value = payload(); value["goals"][0]["work_samples"][0]["learner_answer"] = ""
        _, valid, invalid = parse_import(value)
        self.assertFalse(valid)
        message = invalid[0]["error"]
        self.assertIn("作答", message)
        self.assertNotIn("pydantic", message)
        self.assertNotIn("input_value", message)
        self.assertLess(len(message), 300)

    def test_grouped_import_has_one_goal_and_distinct_topics_with_shared_local_refs(self):
        value = payload(); second = deepcopy(value["goals"][0])
        second["ref"] = "g2"; second["goal_profile"]["goal_description"] = "分析CSV"
        second["skills"][0]["name"] = "筛选行"; second["work_samples"][0]["learner_answer"] = "筛选符合条件的行"
        value["goals"].append(second)
        service = build_empty_learning_service()
        preview = service.growth_preview_import(value)
        batch = service.growth_commit_import(value, preview["preview_hash"], ["g1", "g2"], {}, group_title="CSV实践")
        projects = service.get_learning_library().projects
        self.assertEqual(len(projects), 1)
        goal_id = projects[0].goal_profile.id
        self.assertEqual(projects[0].goal_profile.goal_description, "CSV实践")
        context = service.growth_goal_context(goal_id)
        self.assertEqual(len(context["topics"]), 2)
        self.assertEqual(len({e["goal_id"] for e in batch["entries"]}), 1)
        self.assertEqual(len(context["samples"]), 2)
        service.growth_commit_import(value, preview["preview_hash"], ["g1", "g2"], {}, group_title="CSV实践")
        self.assertEqual(len(service.get_learning_library().projects), 1)

    def separate(self):
        value = payload(); other = deepcopy(value["goals"][0]); other["ref"] = "g2"
        other["goal_profile"]["goal_description"] = "分析CSV"; other["skills"][0]["name"] = "分析"
        value["goals"].append(other)
        service = build_empty_learning_service(); preview = service.growth_preview_import(value)
        batch = service.growth_commit_import(value, preview["preview_hash"], ["g1", "g2"], {})
        return service, batch, value

    def test_existing_batch_group_keeps_active_identity_sources_topics_and_reimport_dedup(self):
        service, batch, value = self.separate()
        active = batch["entries"][1]["goal_id"]
        service.switch_goal_by_user(active)
        before = service._growth_data()
        preview = service.growth_group_preview(batch["id"])
        grouped = service.growth_group_import(batch["id"], preview["preview_hash"], "CSV实践")
        self.assertEqual(grouped["goal_id"], active)
        self.assertEqual(service.snapshot().goal_profile.id, active)
        self.assertEqual(len(service.get_learning_library().projects), 1)
        self.assertEqual(service.snapshot().current_goal, "CSV实践")
        after = service._growth_data()
        for key, record in before["samples"].items():
            self.assertEqual(after["samples"][key]["learner_answer"], record["learner_answer"])
            self.assertEqual(after["samples"][key]["skill_id"], record["skill_id"])
        context = service.growth_learning_context(limit=10)
        self.assertEqual(len(context["topics"]), 2)
        self.assertEqual(sum(r["origin"] == "external_unverified" for r in context["records"]), 2)
        self.assertEqual(service.growth_learning_summary(active)["samples"], 2)
        self.assertTrue(all(g["duplicate"] for g in service.growth_preview_import(value)["goals"]))
        with TemporaryDirectory() as folder:
            store = JsonLearningStateStore(Path(folder)/'state.json'); store.save(service)
            self.assertEqual(store.load().growth_learning_context(limit=10), context)

    def test_existing_group_rejects_stale_preview_and_rolls_back_failed_save(self):
        service, batch, _ = self.separate()
        preview = service.growth_group_preview(batch["id"])
        before = JsonLearningStateStore._encode(service)
        with self.assertRaises(ValueError): service.growth_group_import(batch["id"], "0" * 64, "CSV")
        def fail(_): raise OSError("disk failure")
        service.enable_auto_save(fail)
        with self.assertRaises(OSError): service.growth_group_import(batch["id"], preview["preview_hash"], "CSV")
        self.assertEqual(JsonLearningStateStore._encode(service), before)

    def test_group_reuses_the_started_goal_without_changing_native_task(self):
        service, batch, _ = self.separate()
        goal = batch["entries"][0]["goal_id"]; service.switch_goal_by_user(goal)
        skill = service.snapshot().skills[0]
        service.create_task(LearningTask("native", "练习", "练习CSV", (skill.id,), ()))
        before = service.snapshot().tasks
        preview = service.growth_group_preview(batch["id"])
        service.growth_group_import(batch["id"], preview["preview_hash"], "整体CSV学习")
        self.assertEqual(service.snapshot().tasks, before)
        self.assertEqual(service.snapshot().goal_profile.id, goal)
        self.assertEqual(len(service.get_learning_library().projects), 1)

    def test_two_independent_native_routes_are_not_collapsed(self):
        service, batch, _ = self.separate()
        for n, entry in enumerate(batch["entries"]):
            service.switch_goal_by_user(entry["goal_id"])
            skill = next(s for s in service.snapshot().skills if s.id in entry["skill_map"].values())
            service.create_task(LearningTask(f"native-{n}", "练习", "练习CSV", (skill.id,), ()))
        with self.assertRaisesRegex(ValueError, "学习进度"):
            service.growth_group_preview(batch["id"])
        self.assertEqual(len(service.get_learning_library().projects), 2)

    def test_legacy_entry_hash_ignores_absent_new_topic_field(self):
        from app.application.growth import import_entry_hash
        _, goals, _ = parse_import(payload())
        legacy = deepcopy(goals[0]); legacy.pop("ref")
        for skill in legacy["skills"]: skill.pop("topic")
        self.assertEqual(import_entry_hash(goals[0]), fingerprint(legacy))

    def test_partial_separate_import_requires_explicit_group_before_adding_more(self):
        value = payload()
        for n in (2, 3):
            goal = deepcopy(value['goals'][0]); goal['ref'] = f'g{n}'
            goal['goal_profile']['goal_description'] = f'CSV主题{n}'
            goal['skills'][0]['name'] = f'CSV知识点{n}'
            value['goals'].append(goal)
        service = build_empty_learning_service(); preview = service.growth_preview_import(value)
        batch = service.growth_commit_import(value, preview['preview_hash'], ['g1', 'g2'], {})
        before = service._growth_data()
        with self.assertRaisesRegex(ValueError, '先在导入记录'):
            service.growth_commit_import(value, preview['preview_hash'], ['g3'], {}, group_title='CSV实践')
        self.assertEqual(service._growth_data(), before)
        grouped = service.growth_group_preview(batch['id'])
        result = service.growth_group_import(batch['id'], grouped['preview_hash'], 'CSV实践')
        appended = service.growth_commit_import(value, preview['preview_hash'], ['g3'], {}, group_title='CSV实践')
        self.assertEqual({e['goal_id'] for e in appended['entries']}, {result['goal_id']})
        self.assertEqual(len(service.get_learning_library().projects), 1)

    def test_context_filter_stays_inside_goal_and_keeps_unknown_question(self):
        value = payload(); value["goals"][0]["work_samples"][0]["question"] = None
        service = build_empty_learning_service(); p = service.growth_preview_import(value)
        batch = service.growth_commit_import(value, p["preview_hash"], ["g1"], {})
        service.switch_goal_by_user(batch["entries"][0]["goal_id"])
        skill = next(iter(batch["entries"][0]["skill_map"].values()))
        context = service.growth_learning_context(skill_id=skill)
        self.assertTrue(any(r.get("question", "provided") is None for r in context["records"]))
        with self.assertRaises(ValueError): service.growth_learning_context(skill_id="foreign")

    def test_export_prompt_example_matches_protocol(self):
        from app.growth_protocol import LearningImport
        prompt = Path("resources/growth/export-prompt.md").read_text('utf-8')
        example = prompt.split('```json\n')[1].split('```')[0]
        self.assertEqual(len(LearningImport.model_validate(json.loads(example)).goals), 1)

    def test_topic_assignment_preserves_originals_and_rejects_stale_or_foreign_edits(self):
        service, batch, value = self.separate()
        goal = batch['entries'][0]['goal_id']; skill = next(iter(batch['entries'][0]['skill_map'].values()))
        context = service.growth_goal_context(goal); before = service._growth_data()
        result = service.growth_assign_topic(goal, [skill], 'topic', 'CSV读取与清洗', context['topic_revision'])
        self.assertEqual(result['topics'][0]['name'], 'CSV读取与清洗')
        self.assertEqual(service._growth_data()['samples'], before['samples'])
        self.assertEqual(service._growth_data()['supplements'], before['supplements'])
        entry = service._growth_data()['batches'][batch['id']]['entries'][0]
        self.assertEqual(entry['topics'], before['batches'][batch['id']]['entries'][0]['topics'])
        self.assertEqual(entry['entry_hash'], before['batches'][batch['id']]['entries'][0]['entry_hash'])
        with self.assertRaisesRegex(ValueError, '已变化'):
            service.growth_assign_topic(goal, [skill], 'topic', '其他', context['topic_revision'])
        foreign = next(iter(batch['entries'][1]['skill_map'].values()))
        with self.assertRaisesRegex(ValueError, '这个目标'):
            service.growth_assign_topic(goal, [foreign], 'topic', '其他', result['topic_revision'])

    def test_move_imported_skill_to_existing_stage_and_back_keeps_task_and_rolls_back_failure(self):
        from app.domain import CurriculumMilestone, LearningDepth
        service, batch, _ = self.separate()
        goal = batch['entries'][0]['goal_id']; skill = next(iter(batch['entries'][0]['skill_map'].values()))
        service.switch_goal_by_user(goal)
        service._curriculum_spine = (CurriculumMilestone('stage-a', '表格实践', '数据处理', LearningDepth.PRACTICAL),)
        service.create_task(LearningTask('topic-task', '处理CSV', '练习', (skill,), ()))
        task = service.get_task('topic-task')
        context = service.growth_goal_context(goal)
        result = service.growth_assign_topic(goal, [skill], 'milestone', 'stage-a', context['topic_revision'])
        self.assertEqual(service.snapshot().curriculum_spine[0].skill_ids, (skill,))
        before = service.snapshot()
        service.enable_auto_save(lambda _: (_ for _ in ()).throw(OSError('disk full')))
        with self.assertRaises(OSError):
            service.growth_assign_topic(goal, [skill], 'topic', 'CSV清洗', result['topic_revision'])
        self.assertEqual(service.snapshot(), before)
        service.enable_auto_save(lambda _: None)
        service.growth_assign_topic(goal, [skill], 'topic', 'CSV清洗', result['topic_revision'])
        self.assertEqual(service.snapshot().curriculum_spine[0].skill_ids, ())
        self.assertEqual(service.get_task('topic-task'), task)
