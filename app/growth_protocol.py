"""外部学习交换格式；只允许资料，不接受状态、坐标或已核验分数。"""
from collections import Counter
from datetime import datetime
import json
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, ValidationError, ValidationInfo, field_validator, model_validator

IMPORT_VERSION = "lawa.learning-import/v1"
MAX_IMPORT_BYTES = 1024 * 1024


class ImportValue(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    @model_validator(mode="before")
    @classmethod
    def optional_values(cls, value):
        if not isinstance(value, dict):
            return value
        value = dict(value)
        # AI常把“未提供”写成null。只补可选字段的协议默认值，不猜原答或能力。
        for key, field in cls.model_fields.items():
            if key in value and value[key] is None and not field.is_required():
                value[key] = field.get_default(call_default_factory=True)
        for key in ("question", "occurred_at", "reference", "claimed_level", "topic"):
            if key in value and isinstance(value[key], str) and not value[key].strip():
                value[key] = None
        if value.get("assistance_level") == "":
            value["assistance_level"] = "UNKNOWN"
        if value.get("background_summary") == "":
            value["background_summary"] = "未提供"
        return value

    @field_validator("*", mode="before", check_fields=False)
    @classmethod
    def preserve_originals(cls, value, info: ValidationInfo):
        # 原答的缩进和换行可能影响代码含义；只规范元数据，不改写原题、原答和自述。
        originals = {"question", "learner_answer", "feedback", "context", "statement"}
        return value.strip() if isinstance(value, str) and info.field_name not in originals else value

    @field_validator("learner_answer", "statement", check_fields=False)
    @classmethod
    def meaningful_original(cls, value):
        if not value.strip():
            raise ValueError("原文不能全部为空白")
        return value


class ImportSource(ImportValue):
    platform: str = Field(min_length=1, max_length=120)
    conversation_title: str | None = Field(default="", max_length=300)
    reference: str | None = Field(default=None, max_length=2000)
    media_descriptions: list[Annotated[str, Field(min_length=1, max_length=2000)]] | None = Field(default_factory=list, max_length=20, description="图片或音频只保留来源说明，不据此评审")

    @field_validator("media_descriptions")
    @classmethod
    def bounded_media(cls, values):
        if any(not v.strip() or len(v) > 2000 for v in values):
            raise ValueError("媒体来源说明须为1至2000字符")
        return values


class ImportGoalProfile(ImportValue):
    goal_description: str = Field(min_length=1, max_length=2000)
    background_summary: str | None = Field(default="未提供", min_length=1, max_length=2000, description="有依据的最近学习位置、未解决问题与续学意愿，再概括此前经历；未知保留，不是掌握证明")
    desired_outcome: str = Field(min_length=1, max_length=2000)
    learning_domain: str | None = Field(default="", max_length=80)

    @field_validator("learning_domain")
    @classmethod
    def valid_domain(cls, value):
        from app.domain.planning import normalize_learning_domain
        return normalize_learning_domain(value)


class ImportSkill(ImportValue):
    ref: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default="", max_length=2000)
    topic: str | None = Field(default=None, max_length=200, description="新导出请填写简短明确的所属主题，如Tensor基础、训练循环；不是另一个目标。缺失仅为旧版兼容，导入后可调整")


class ImportClaim(ImportValue):
    skill_ref: str | None = Field(default=None, max_length=100)
    statement: str = Field(min_length=1, max_length=8000)
    claimed_level: Literal["IDENTIFY", "EXPLAIN", "APPLY", "ADAPT", "TRANSFER"] | None = None


class ImportSample(ImportValue):
    ref: str = Field(min_length=1, max_length=100)
    skill_ref: str = Field(min_length=1, max_length=100)
    question: str | None = Field(default=None, max_length=16000, description="原题未知时为null；不能为通过校验编造问题")
    learner_answer: str = Field(min_length=1, max_length=16000)
    assistance_level: Literal["UNKNOWN", "WITH_HELP", "WITH_HINT", "WITH_REFERENCE", "INDEPENDENT", "TRANSFERRED"] | None = "UNKNOWN"
    feedback: str | None = Field(default="", max_length=16000)
    context: str | None = Field(default="", max_length=16000)
    occurred_at: str | None = None

    @field_validator("occurred_at")
    @classmethod
    def valid_time(cls, value):
        if value is not None and datetime.fromisoformat(value).tzinfo is None:
            raise ValueError("学习时间须带时区；未知时填null")
        return value

    @model_validator(mode="after")
    def bounded_sample(self):
        if sum(len(getattr(self, k) or "") for k in ("question", "learner_answer", "feedback", "context")) > 16000:
            raise ValueError("单份表现样本合计不能超过16000字符")
        return self


class ImportGoal(ImportValue):
    ref: str = Field(min_length=1, max_length=100)
    goal_profile: ImportGoalProfile
    skills: list[ImportSkill] | None = Field(default_factory=list, max_length=200, description="按原对话首次实际学习的先后排列，不按教材逻辑、主题、名称或ref重排；回顾不重复建点")
    self_reports: list[ImportClaim] | None = Field(default_factory=list, max_length=200, description="保留自述在原对话中的先后顺序")
    work_samples: list[ImportSample] | None = Field(default_factory=list, max_length=100, description="保留真实作答的发生顺序；未知日期不编造")

    @model_validator(mode="after")
    def references(self):
        ids = [s.ref for s in self.skills]
        if len(ids) != len(set(ids)) or len({s.ref for s in self.work_samples}) != len(self.work_samples):
            raise ValueError("知识点或样本ref重复")
        if any(x.skill_ref is not None and x.skill_ref not in ids for x in [*self.self_reports, *self.work_samples]):
            raise ValueError("样本或自述引用不存在的知识点")
        return self


class LearningImport(ImportValue):
    schema_version: Literal["lawa.learning-import/v1"]
    source: ImportSource
    goals: list[ImportGoal] = Field(min_length=1, max_length=20, description="同一学习主线合为一个目标，不同目标按原对话首次实际学习顺序排列")


def import_error(error: ValueError) -> str:
    """只给位置与可修正原因，不回显用户原答或Pydantic内部链接。"""
    if not isinstance(error, ValidationError):
        return str(error)[:300]
    names = {"source": "来源", "platform": "平台", "conversation_title": "对话标题", "goal_profile": "目标",
             "goal_description": "目标描述", "desired_outcome": "希望达到的结果", "background_summary": "学习背景",
             "learning_domain": "领域", "skills": "知识点", "work_samples": "作答样本", "self_reports": "自述",
             "learner_answer": "学习者原作答", "question": "原题", "statement": "自述原文", "skill_ref": "知识点引用",
             "occurred_at": "发生时间", "ref": "文件内标识", "topic": "主题"}
    lines = []
    for item in error.errors(include_url=False, include_input=False)[:4]:
        path = " / ".join(f"第{k + 1}项" if isinstance(k, int) else names.get(k, k) for k in item["loc"])
        kind, context = item["type"], item.get("ctx", {})
        reason = {"missing": "请填写此项", "string_type": "应填写文字", "list_type": "应填写数组，没有内容用[]",
                  "string_too_short": "不能为空；没有学习者原作答时，请移除此样本，学习经历写入自述" if item["loc"][-1:] == ("learner_answer",) else "不能为空",
                  "string_too_long": f"超过长度限制（{context.get('max_length', '?')}字符）",
                  "extra_forbidden": "格式不支持此字段，请移除；不能导入掌握状态或分数",
                  "literal_error": "请使用格式说明中的选项，未知帮助情况填UNKNOWN"}.get(kind)
        reason = reason or str(item["msg"]).removeprefix("Value error, ")
        lines.append(f"{path}：{reason}" if path else reason)
    return "；".join(lines)[:600]


def parse_import(payload: dict) -> tuple[dict, list[dict], list[dict]]:
    """预览按目标显示问题；一条坏记录不掩盖其他可选的有效目标。"""
    if not isinstance(payload, dict) or set(payload) != {"schema_version", "source", "goals"} or payload["schema_version"] != IMPORT_VERSION:
        raise ValueError("请选择 lawa.learning-import/v1 格式的JSON")
    if len(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()) > MAX_IMPORT_BYTES:
        raise ValueError("导入文件超过1MiB")
    try:
        source = ImportSource.model_validate(payload["source"]).model_dump()
    except ValueError as error:
        raise ValueError("来源：" + import_error(error)) from error
    goals = payload["goals"]
    if not isinstance(goals, list) or not 1 <= len(goals) <= 20:
        raise ValueError("一次导入需要1至20个目标")
    for key, maximum in (("skills", 200), ("work_samples", 100)):
        if sum(len(g.get(key, [])) for g in goals if isinstance(g, dict) and isinstance(g.get(key, []), list)) > maximum:
            raise ValueError(f"{key} 超过总数量限制 {maximum}")
    refs = Counter(g.get("ref") for g in goals if isinstance(g, dict) and isinstance(g.get("ref"), str))
    valid, invalid = [], []
    for index, raw in enumerate(goals):
        try:
            goal = ImportGoal.model_validate(raw)
            if refs[goal.ref] != 1:
                raise ValueError("目标ref重复")
            valid.append(goal.model_dump())
        except ValueError as error:
            invalid.append({"index": index, "ref": raw.get("ref", str(index)) if isinstance(raw, dict) else str(index), "error": import_error(error)})
    return source, valid, invalid
