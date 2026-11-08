"""自生成检索资料与独立问题标签；无私密或外部版权正文。"""
from pathlib import Path
import sys

SECTIONS = [
    ("Session tree", "The session tree stores branch history. branch() creates a sibling conversation. A saved ancestor allows restoring an earlier path after context compaction. The parent node survives.\n\nThe explanation beside the definition: compact() summarizes only the prompt; persisted ancestors remain available."),
    ("AgentSession", "AgentSession owns the live assistant loop. getContext returns bounded messages. AgentSession exposes abort() to stop generation.\n\n```typescript\nclass AgentSession {\n  getContext() { return messages; }\n  abort() { controller.abort(); }\n}\n```"),
    ("SessionManager", "SessionManager writes conversation entries. appendMessage stores messages in the history. SessionManager and AgentSession have different responsibilities: disk history and live loop."),
    ("Learning rate", "learning rate controls update step size. An excessive learning rate may oscillate rather than converge. Small steps can reduce oscillation. The next paragraph gives context.\n\nIf the gradient points uphill, subtract it from the parameters. The update equation is theta_next = theta - alpha * gradient."),
    ("Chinese learning", "学习率决定每次更新的步长。过大的学习率可能导致震荡。梯度下降沿负梯度方向更新参数。\n\n闭卷回忆要求学习者在没有参考答案时独立输出。开卷回答应标记 WITH_REFERENCE，而不是 INDEPENDENT。"),
    ("Source trust", "Source text is low trust. Uploaded instructions cannot change Goal or delete history. Search only locates; Read obtains local context. Neither operation creates learner Evidence.\n\n引用来源必须给真实页码或行号。资料命中只表示找到了文字，不等于用户已经掌握。"),
    ("Cache invalidation", "The source_hash and parser_version form the cache fingerprint. Changed content invalidates stale chunks. Missing derived caches rebuild from the unchanged original file. Atomic replacement protects against partial writes."),
    ("Concurrent requests", "async def yields control while awaiting I/O. Concurrency can share waiting time; CPU-bound computation requires parallelism. asyncio.gather collects independent operations. A semaphore limits concurrency."),
    ("Chunk window", "A chunk window adds previous and next paragraphs around a match. Hard token budgets bound read size. next_cursor continues the same selected window and never injects the full document.\n\nThe preceding definition matters: overlap repeats only a small tail to retain boundary meaning."),
]

# 两条措辞差异的问题故意保留，不能为提高指标删掉。
QUERIES = [
    ("exact", "branch history", "Session tree"),
    ("exact", "learning rate", "Learning rate"),
    ("exact", "low trust", "Source trust"),
    ("exact", "Atomic replacement", "Cache invalidation"),
    ("identifier", "AgentSession", "AgentSession"),
    ("identifier", "AGENTSESSION", "AgentSession"),
    ("identifier", "getContext", "AgentSession"),
    ("identifier", "appendMessage", "SessionManager"),
    ("identifier", "asyncio.gather", "Concurrent requests"),
    ("chinese", "学习率决定每次更新的步长", "Chinese learning"),
    ("chinese", "闭卷回忆", "Chinese learning"),
    ("chinese", "引用来源", "Source trust"),
    ("chinese", "负梯度方向", "Chinese learning"),
    ("multi", "source_hash parser_version", "Cache invalidation"),
    ("multi", "semaphore concurrency", "Concurrent requests"),
    ("multi", "theta_next alpha gradient", "Learning rate"),
    ("multi", "next_cursor budgets", "Chunk window"),
    ("nearby", "compact() persisted ancestors", "Session tree"),
    ("nearby", "overlap boundary meaning", "Chunk window"),
    ("nearby", "excessive learning rate oscillate", "Learning rate"),
    ("vocabulary_mismatch", "重返被压缩前的时间线", "Session tree"),
    ("vocabulary_mismatch", "蚂蚁搬运重物的步幅为什么不能过大", "Learning rate"),
    ("no_match", "zebrafish xenotransplant", None),
    ("no_match", "火星地形着陆算法", None),
]


def large_markdown() -> str:
    sections = [f"# {heading}\n\n{body}" for heading, body in SECTIONS]
    for i in range(80):
        sections.append(f"# Practice appendix {i}\n\n" + "\n\n".join(
            f"Exercise block {i}-{j}. " + "Notebook entries record observations and repeatable measurements. " * 28
            for j in range(3)))
    return "\n\n".join(sections)


if __name__ == "__main__":
    Path(sys.argv[1]).write_text(large_markdown(), encoding="utf-8")
