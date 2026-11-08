"""生成可丢弃的桌面验收资料。所有内容和分数都是明确标注的合成样例。"""
from dataclasses import replace
from datetime import datetime, timezone
import sys
from pathlib import Path
from unittest.mock import patch
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.domain import CurriculumMilestone, KnowledgeCard, LearningDepth
from app.domain.growth import zero_dimensions
from app.persistence import JsonLearningStateStore
from tests.test_answer_assessment import service_fixture, assessment
from tests.test_growth import payload, commit


def seed(path):
    if path.exists():
        raise SystemExit("Preview seed refuses to overwrite an existing ledger")
    service = service_fixture()
    service._goal_profile = replace(service._goal_profile, goal_description="TypeScript 基础", desired_outcome="看懂类型约束，写出清晰的小程序")
    service._current_goal = "TypeScript 基础"
    service._curriculum_spine = tuple(CurriculumMilestone(f"phase-{n}", title, "通过例子理解与练习", LearningDepth.PRACTICAL,
        skill_ids=("a",) if n == 0 else ("b",) if n == 1 else ()) for n, title in enumerate(["值与类型", "函数与结构", "组织代码", "调试与验证", "综合练习"]))
    service._knowledge_cards = {"preview-card": KnowledgeCard("preview-card", "a", "如何区分字符串拼接与数值相加？",
        "## 先看操作数的类型\n\n`2 + 3` 得到 `5`；`2 + '3'` 得到 `'23'`。\n\n```ts\nconst count: number = 3;\nconst label = '数量：' + count;\n```\n\n" + "理解类型后，再预测运算结果。\n\n" * 24,
        datetime.now(timezone.utc), learner_note="我自己的理解：类型决定运算含义，先判断类型再看结果。")}
    service.record_answer_assessment(assessment())
    topics = [("Python 数据整理", "清洗一份CSV并汇总", [0, 3, 0, 0]), ("概率与抽样", "理解样本与总体", [3, 1, 0, 0]),
              ("日常中的函数关系", "把变量之间的变化画出来", [3, 0, 0, 0]), ("现代史中的制度选择", "比较历史情境中的选择", [0, 0, 3, 0]),
              ("让说明文更易读", "面向初学者组织一段说明", [0, 0, 1, 3]), ("光影与摄影", "用自然光表达画面意图", [1, 1, 0, 3]),
              ("一周生活安排", "安排现实任务并复盘", [0, 1, 2, 0]), ("节奏与音乐", "辨认并创作短节奏", [1, 0, 0, 3])]
    weights = {"goal": [1, 3, 0, 0]}
    for title, outcome, vector in topics:
        value = payload(); g = value["goals"][0]
        value["source"] = {"platform": "合成验收样例", "conversation_title": title}
        g["goal_profile"] = {"goal_description": title, "desired_outcome": outcome, "learning_domain": "", "background_summary": "示例经历"}
        g["skills"][0].update(name=title + " · 起点", description=outcome)
        g["self_reports"][0]["statement"] = "在示例中尝试过：" + outcome
        g["work_samples"][0].update(question="请说明你的尝试过程", learner_answer="这是用于验证布局与来源定位的合成作答；不代表真实用户能力。")
        batch = commit(service, value)
        weights[batch["entries"][0]["goal_id"]] = vector
    for goal, vector in weights.items():
        service.growth_set_classification(goal, dict(zip(("science", "technology", "humanities", "expression"), vector)))
    service.growth_supplement("我做过简单的数据整理，也尝试写说明文和安排每周计划。这里是合成预览资料。")
    for _ in range(40):
        with patch("app.application.growth.time.time", return_value=time.time() + 31):
            job = service.growth_claim("synthetic-preview/illustration-only")
        if not job: break
        if job["key"].startswith("review:"):
            result = {"sample_id": job["key"][7:], "supported": True, "reason": "合成评审：仅用于检验来源、布局和交互，不是实际能力判断。"}
        elif job["key"].startswith("score:"):
            refs = [r["id"] for r in job["input"]["records"] if r["origin"] == "observed"]
            dimensions = zero_dimensions()
            scores = [1.4, 2.1, 1.1, .8, .5, .6]
            for n, dimension in enumerate(dimensions):
                dimension.update(score=scores[n], rationale="合成预览评价：展示当前资料的有限范围，不代表真实用户能力。", source_refs=[refs[min(n, len(refs) - 1)]],
                                 coverage=["示例中的基础应用"], missing=["复杂情境", "跨场景迁移"])
            result = {"schema_version": "lawa.capability-evaluation/v1", "basis": job["input"]["basis"], "dimensions": dimensions}
        else:
            result = {"items": [{"kind": "deepen", "title": "设计类型安全的输入校验器", "reason": "把已有的类型知识用到真实边界处理中。", "goal_id": "goal", "prompt": "实现一个校验器，区分缺失值、错误类型和有效数据，并写三个反例测试。", "outcome": "能解释每种输入的边界", "source_goal_ids": ["goal"], "anchor_kind": "skill", "anchor_id": "a"},
                               {"kind": "bridge", "title": "用类型表达一个抽样实验", "reason": "结合数据结构与抽样知识解释偏差。", "goal_id": "goal", "prompt": "写一个抽样模拟，比较两种抽样方式并解释差异。", "outcome": "给出模拟代码和结论", "source_goal_ids": ["goal", next(i for i in weights if i != "goal")], "anchor_kind": "milestone", "anchor_id": "phase-1"},
                               {"kind": "explore", "title": "观察一件建筑的空间与用途", "reason": "从日常观察走向此前未涉及的建筑艺术。", "goal_id": None, "prompt": "观察一栋公共建筑，用草图说明空间如何服务不同人群。", "outcome": "完成一张观察草图", "source_goal_ids": [], "exploration_domain": "建筑与空间设计"}]}

        service.growth_complete(job["key"], job["lease"], result)
    JsonLearningStateStore(path).save(service)


if __name__ == "__main__": seed(Path(sys.argv[1]).resolve())
