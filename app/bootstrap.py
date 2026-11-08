"""Explicit in-memory bootstraps for demos and repeatable acceptance tests."""

from datetime import datetime

from app.application import LearningService
from app.domain import (
    AssistanceLevel,
    CurriculumMilestone,
    Evidence,
    EvidenceType,
    FrontierPlan,
    GoalProfile,
    LearningDepth,
    LearningTask,
    SkillGraph,
    SkillNode,
    SkillState,
)


DEMO_GOAL = "掌握 CNN，并能够独立实现一个图像分类网络。"


def build_empty_learning_service() -> LearningService:
    """真实产品入口从空 Goal 开始；Demo seed 不得冒充用户状态。"""
    return LearningService(SkillGraph([]), current_goal=None)


def build_demo_learning_service() -> LearningService:
    graph = SkillGraph(
        [
            SkillNode(
                "neural-network",
                "Neural Network Basics",
                status=SkillState.MASTERED_BY_USER,
            ),
            SkillNode(
                "backpropagation",
                "Backpropagation",
                prerequisites=("neural-network",),
                status=SkillState.MASTERED_BY_USER,
            ),
            SkillNode(
                "pytorch",
                "PyTorch Basics",
                prerequisites=("backpropagation",),
                status=SkillState.PRACTICING,
            ),
            SkillNode(
                "cnn",
                "CNN",
                prerequisites=("pytorch",),
            ),
            SkillNode(
                "training-loop",
                "Training Loop",
                prerequisites=("pytorch",),
                status=SkillState.PRACTICING,
            ),
            SkillNode(
                "cnn-classifier",
                "CNN Classifier",
                prerequisites=("cnn", "training-loop"),
            ),
        ]
    )
    service = LearningService(graph, current_goal=DEMO_GOAL)
    service._import_historical_evidence(
        Evidence(
            id="evidence-forward-backward",
            skill_id="backpropagation",
            evidence_type=EvidenceType.EXPLAIN,
            description="能够解释 forward 与 backward 的基本数据流。",
            assistance_level=AssistanceLevel.INDEPENDENT,
            source="demo-learning-log",
        )
    )
    service._import_historical_evidence(
        Evidence(
            id="evidence-training-loop",
            skill_id="training-loop",
            evidence_type=EvidenceType.BUILD,
            description="写过基础训练循环，但 validation 仍需要参考。",
            assistance_level=AssistanceLevel.WITH_REFERENCE,
            source="demo-learning-log",
        )
    )
    service._import_historical_evidence(
        Evidence(
            id="evidence-training-loop-independent",
            skill_id="training-loop",
            evidence_type=EvidenceType.BUILD,
            description=(
                "独立完成 training loop 核心代码，training 与 validation 均跑通。"
            ),
            assistance_level=AssistanceLevel.INDEPENDENT,
            source="user report",
        )
    )
    task = service.create_task(
        LearningTask(
            id="task-cifar10-training-loop",
            title="独立实现 CIFAR-10 CNN Training Loop",
            description="不看完整模板，实现训练、validation 与基础指标记录。",
            related_skill_ids=("training-loop",),
            expected_evidence_types=(EvidenceType.BUILD, EvidenceType.DEBUG),
        )
    )
    service.activate_task(task.id)
    service.complete_task(task.id)
    return service


GRADIENT_DEMO_GOAL = "用等高线理解梯度，并在二次函数上练习梯度下降。"


def build_gradient_demo_learning_service() -> LearningService:
    """Create a synthetic, finished gradient course for regression tests."""
    date = datetime.fromisoformat("2025-01-01T00:00:00+00:00")
    profile = GoalProfile(
        id="gradient-for-deep-learning",
        goal_description=GRADIENT_DEMO_GOAL,
        background_summary="认识一元函数和导数。",
        desired_outcome="画出梯度方向，并计算一次梯度下降更新。",
        created_at=date,
    )
    spine = (
        CurriculumMilestone("multivariable-and-partial-derivatives", "偏导数", "计算两个偏导数。", LearningDepth.OVERVIEW),
        CurriculumMilestone("direction-derivative", "方向导数", "比较两个单位方向的变化率。", LearningDepth.OVERVIEW),
        CurriculumMilestone("gradient-direction-and-magnitude", "梯度", "解释梯度的方向和长度。", LearningDepth.OVERVIEW),
        CurriculumMilestone("contour-lines-and-steepest-ascent", "等高线", "在等高线图中画出梯度。", LearningDepth.OVERVIEW),
        CurriculumMilestone("loss-landscape-in-parameter-space", "损失曲面", "用二次函数举例。", LearningDepth.PRACTICAL),
        CurriculumMilestone("gradient-descent-update-rule", "梯度下降", "计算一次参数更新。", LearningDepth.PRACTICAL),
        CurriculumMilestone("learning-rate-and-optimization-pitfalls", "学习率", "比较两种步长。", LearningDepth.OVERVIEW),
    )
    skills = (
        ("partial-derivative-recall", "偏导数复习", (), LearningDepth.OVERVIEW),
        ("direction-derivative-and-gradient", "方向导数和梯度", ("partial-derivative-recall",), LearningDepth.OVERVIEW),
        ("gradient-descent-update-rule", "梯度下降更新", ("direction-derivative-and-gradient",), LearningDepth.PRACTICAL),
        ("learning-rate-and-optimization-pitfalls", "学习率和步长", ("gradient-descent-update-rule",), LearningDepth.OVERVIEW),
        ("contour-lines-and-gradient-geometry", "等高线和梯度方向", ("direction-derivative-and-gradient",), LearningDepth.OVERVIEW),
        ("loss-landscape-in-parameter-space", "参数空间的损失曲面", ("gradient-descent-update-rule",), LearningDepth.PRACTICAL),
    )
    graph = SkillGraph([
        SkillNode(identifier, title, prerequisites=prerequisites, target_depth=depth, status=SkillState.MASTERED_BY_USER)
        for identifier, title, prerequisites, depth in skills
    ])
    service = LearningService(
        graph,
        current_goal=profile.goal_description,
        goal_profile=profile,
        curriculum_spine=spine,
        frontier=FrontierPlan(
            focus_skill_id="contour-lines-and-gradient-geometry",
            supporting_skill_ids=("direction-derivative-and-gradient",),
            reason="将公式与等高线图联系起来。",
            target_depth=LearningDepth.OVERVIEW,
            suggested_learning_mode="EXPLAIN",
            next_action="用一个新二次函数检验梯度方向。",
        ),
    )

    direction = "direction-derivative-and-gradient"
    update = "gradient-descent-update-rule"
    rate = "learning-rate-and-optimization-pitfalls"
    contour = "contour-lines-and-gradient-geometry"
    loss = "loss-landscape-in-parameter-space"
    hints = AssistanceLevel.WITH_HINT
    independent = AssistanceLevel.INDEPENDENT
    explain = EvidenceType.EXPLAIN
    build = EvidenceType.BUILD
    examples = (
        (direction, explain, hints, "在提示下将方向导数写成梯度与单位向量的点积。"),
        (update, explain, hints, "在提示下解释沿负梯度方向更新参数。"),
        (update, build, hints, "按提示计算二次函数上的一次参数更新。"),
        (rate, build, hints, "在练习中比较两个步长更新后的损失。"),
        (rate, explain, independent, "解释步长过大时为何可能跨过最低点。"),
        (rate, explain, hints, "在提示下解释学习率与梯度分量的分工。"),
        (update, explain, independent, "解释一阶近似下负梯度方向的损失变化。"),
        (contour, explain, independent, "画出圆形等高线的法向方向。"),
        (loss, explain, independent, "说明固定参数时损失曲面切片的含义。"),
        (contour, EvidenceType.TRANSFER, AssistanceLevel.TRANSFERRED, "将梯度法向关系应用于椭圆形等高线。"),
    )
    for index, (skill_id, kind, assistance, description) in enumerate(examples, 1):
        service._import_historical_evidence(Evidence(
            id=f"demo-gradient-evidence-{index:02d}",
            skill_id=skill_id,
            evidence_type=kind,
            description=description,
            assistance_level=assistance,
            source="synthetic gradient demo",
            created_at=date.replace(minute=index),
        ))

    tasks = (
        LearningTask(
            id="demo-gradient-task-direction",
            title="解释方向导数",
            description="在两个指定方向计算变化率。",
            related_skill_ids=(direction,),
            expected_evidence_types=(explain,),
        ),
        LearningTask(
            id="demo-gradient-task-step",
            title="比较更新步长",
            description="计算两种学习率更新后的损失。",
            related_skill_ids=(rate,),
            expected_evidence_types=(build, explain),
        ),
    )
    for task in tasks:
        service.create_task(task)
        service.activate_task(task.id)
        service.complete_task(task.id)
    return service


def build_learning_service(bootstrap_mode: str | None) -> LearningService:
    """Select an explicit fixture without changing the empty default."""
    if bootstrap_mode == "demo":
        return build_demo_learning_service()
    if bootstrap_mode == "gradient-demo":
        return build_gradient_demo_learning_service()
    return build_empty_learning_service()
