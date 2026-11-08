"""知识点身份与别名；相似度只提示，不把相似文本自动合并为学习事实。"""

from dataclasses import dataclass, replace
from difflib import SequenceMatcher
import re
import unicodedata


def topic_key(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value).strip()).casefold()


@dataclass(frozen=True, slots=True)
class AssessmentTopic:
    id: str
    goal_id: str
    skill_id: str
    name: str
    aliases: tuple[str, ...] = ()

    def __post_init__(self):
        for key, limit in (("id", 200), ("goal_id", 200), ("skill_id", 200), ("name", 160)):
            value = getattr(self, key)
            if not isinstance(value, str) or not value.strip() or len(value) > limit:
                raise ValueError(f"Invalid topic {key}")
        object.__setattr__(self, "aliases", tuple(self.aliases))
        if len(self.aliases) > 12 or any(not isinstance(v, str) or not v.strip() or len(v) > 160 for v in self.aliases):
            raise ValueError("Topic aliases must contain at most 12 short names")
        if len({topic_key(v) for v in (self.name, *self.aliases)}) != len(self.aliases) + 1:
            raise ValueError("Duplicate topic alias")

    def keys(self):
        return {topic_key(v) for v in (self.name, *self.aliases)}


def topic_catalog(records, saved: tuple[AssessmentTopic, ...]) -> tuple[AssessmentTopic, ...]:
    """旧评分只读派生身份，不重写旧ID、评分或帮助；首次相关写入才保存目录。"""
    result = {v.id: v for v in saved}
    for record in records:
        result.setdefault(record.topic_id, AssessmentTopic(record.topic_id, record.goal_id, record.skill_id, record.topic))
    return tuple(result.values())


def resolve_topic(catalog: tuple[AssessmentTopic, ...], assessment, aliases: tuple[str, ...]):
    from app.domain.answer_assessment import assessment_topic_id

    # 只在同Goal/Skill中复用明确身份或已登记别名，绝不跨技能自动归并。
    exact_id = next((v for v in catalog if v.id == assessment.topic_id), None)
    if exact_id and (exact_id.goal_id, exact_id.skill_id) != (assessment.goal_id, assessment.skill_id):
        raise ValueError("Topic identity is outside the saved Goal and Skill")
    if exact_id is None and assessment.topic_id != assessment_topic_id(assessment.goal_id, assessment.skill_id, assessment.topic):
        raise ValueError("Unknown topic identity")
    candidates = [v for v in catalog if (v.goal_id, v.skill_id) == (assessment.goal_id, assessment.skill_id)]
    matches = [v for v in candidates if topic_key(assessment.topic) in v.keys()]
    if len(matches) > 1 or exact_id and matches and matches[0].id != exact_id.id:
        raise ValueError("Topic name has conflicting identities; reuse an unambiguous original topic_id")
    target = exact_id or (matches[0] if matches else AssessmentTopic(assessment.topic_id, assessment.goal_id, assessment.skill_id, assessment.topic))
    names = {topic_key(v): v for v in target.aliases}
    for name in (assessment.topic, *aliases):
        if not isinstance(name, str) or not name.strip() or len(name) > 160:
            raise ValueError("Invalid topic alias")
        key = topic_key(name)
        if any(v.id != target.id and key in v.keys() for v in candidates):
            raise ValueError("Alias already belongs to another topic; historical topics cannot be merged silently")
        if key != topic_key(target.name):
            names.setdefault(key, name.strip())
    updated = replace(target, aliases=tuple(names.values()))
    return replace(assessment, topic_id=target.id, topic=target.name), tuple(v for v in catalog if v.id != target.id) + (updated,)


def find_topics(catalog: tuple[AssessmentTopic, ...], query: str):
    key = topic_key(query)
    scored = []
    for topic in catalog:
        exact = key in topic.keys()
        score = max((SequenceMatcher(None, key, v).ratio() for v in topic.keys()), default=0)
        if not query or exact or any(key in v or v in key for v in topic.keys()) or score >= .45:
            scored.append((exact, score, topic))
    return sorted(scored, key=lambda item: (-item[0], -item[1], item[2].id))[:20]
