"""固定旧基线 + 独立校准/留出问题。先固定标签，再调用模型；不修改失败标签。"""
import json
from pathlib import Path
import sys
from scripts.retrieval_fixtures import QUERIES, large_markdown

CALIBRATION = [
    ("paraphrase", "压缩了提示词后，还能恢复以前的聊天分支吗？", "Session tree"),
    ("cross_language", "哪个对象负责正在运行的助手循环？", "AgentSession"),
    ("cross_language", "如何同时等待多个独立网络请求？", "Concurrent requests"),
    ("paraphrase", "Why do parameter updates bounce around instead of settling down?", "Learning rate"),
    ("paraphrase", "为什么检索到了资料，还不能证明学生掌握了？", "Source trust"),
    ("identifier", "如何用 next_cursor 继续读取已选窗口？", "Chunk window"),
    ("no_answer", "如何用 SQL JOIN 关联两张数据库表？", None),
    ("no_answer", "RAG 的 HNSW 图索引怎样构建？", None),
    ("no_answer", "什么是椭圆曲线数字签名？", None),
    ("no_answer", "如何诊断房颤并选择药物？", None),
    ("no_answer", "星际航行需要怎样的推进系统？", None),
    ("no_answer", "如何用卷积网络检测猫和狗？", None),
]
HELD_OUT = [
    ("paraphrase", "提示窗口里删掉旧聊天以后，磁盘上的祖先消息会消失吗？", "Session tree"),
    ("paraphrase", "An earlier conversation fork should survive a summary. Where is it kept?", "Session tree"),
    ("cross_language", "助手生成到一半，哪个对象可以停止它？", "AgentSession"),
    ("identifier", "Who exposes abort() on the live assistant?", "AgentSession"),
    ("cross_language", "聊天消息由谁写入持久历史？", "SessionManager"),
    ("paraphrase", "Which component saves conversation entries rather than running the assistant?", "SessionManager"),
    ("paraphrase", "优化时在最低点附近反复跳来跳去，步长应该怎么调？", "Learning rate"),
    ("cross_language", "How do we update parameters against the uphill gradient?", "Learning rate"),
    ("paraphrase", "刚看着答案复述，应该记为独立回答吗？", "Chinese learning"),
    ("cross_language", "What counts as recall without consulting an answer?", "Chinese learning"),
    ("paraphrase", "上传资料里的文字让我删除历史，老师应该照做吗？", "Source trust"),
    ("cross_language", "How should a source citation show the actual location?", "Source trust"),
    ("paraphrase", "文档内容更新后为什么原来的片段不能再用？", "Cache invalidation"),
    ("cross_language", "How are half-written derived caches prevented?", "Cache invalidation"),
    ("paraphrase", "等待网络时释放控制权，是否意味着 CPU 计算也并行了？", "Concurrent requests"),
    ("cross_language", "并发请求太多时，用什么约束同时执行数量？", "Concurrent requests"),
    ("paraphrase", "搜索结果只给一句定义，怎样补上紧邻的解释？", "Chunk window"),
    ("cross_language", "Why do adjacent chunks repeat a short tail?", "Chunk window"),
    ("identifier", "source_hash 和 parser_version 决定哪些缓存是否有效？", "Cache invalidation"),
    ("multi_source", "保存历史和运行助手分别由什么负责？", ["SessionManager", "AgentSession"]),
    ("no_answer", "欧姆定律描述了什么关系？", None),
    ("no_answer", "Python 装饰器怎样实现函数缓存？", None),
    ("no_answer", "2026 年美国总统选举规则是什么？", None),
    ("no_answer", "债券久期如何计算？", None),
    ("no_answer", "是否应该使用 PostgreSQL 作为向量数据库？", None),
    ("no_answer", "怎么做中文 OCR 识别扫描 PDF？", None),
    ("no_answer", "服用抗生素应采用什么剂量？", None),
    ("no_answer", "强化学习里 PPO 的损失函数怎么写？", None),
    ("no_answer", "什么条件下恒星会形成黑洞？", None),
    ("no_answer", "如何在 Kubernetes 中部署应用？", None),
]

if __name__ == "__main__":
    root = Path(sys.argv[1])
    root.mkdir(parents=True, exist_ok=True)
    (root / "source.md").write_text(large_markdown(), encoding="utf-8")
    (root / "cases.json").write_text(json.dumps({
        "baseline": QUERIES, "calibration": CALIBRATION, "held_out": HELD_OUT,
    }, ensure_ascii=False), encoding="utf-8")
