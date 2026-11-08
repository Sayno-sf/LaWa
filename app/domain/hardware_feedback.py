"""Read and preserve device receipts from existing learning ledgers."""

from dataclasses import asdict, dataclass
from datetime import datetime
import re
from uuid import UUID

from .knowledge_card import CardFeedbackStatus


def require_uuid(value: str) -> None:
    if not isinstance(value, str) or str(UUID(value)) != value:
        raise ValueError("Hardware identities must be canonical UUID strings")


@dataclass(frozen=True, slots=True)
class HardwareFeedbackEvent:
    owner_id: str
    device_id: str
    event_id: str
    goal_id: str
    card_id: str
    content_revision: str
    base_feedback_revision: int
    status: str
    confirmed: bool

    def __post_init__(self) -> None:
        for value in (self.owner_id, self.device_id, self.event_id):
            require_uuid(value)
        for value in (self.goal_id, self.card_id):
            if (not isinstance(value, str) or not value.strip() or len(value) > 128 or
                    any(ord(c) < 32 or ord(c) == 127 for c in value)):
                raise ValueError("Invalid hardware feedback scope")
            value.encode("utf-8")
        if not isinstance(self.content_revision, str) or not re.fullmatch("[a-f0-9]{64}", self.content_revision):
            raise ValueError("Invalid content revision")
        if type(self.base_feedback_revision) is not int or not 0 <= self.base_feedback_revision < 2**53 - 1:
            raise ValueError("Invalid feedback revision")
        if self.status not in {value.value for value in CardFeedbackStatus} or type(self.status) is not str:
            raise ValueError("Invalid self-report status")
        if self.confirmed is not True:
            raise ValueError("Hardware self-report requires explicit confirmation")

    @property
    def key(self) -> tuple[str, str]:
        return self.device_id, self.event_id


@dataclass(frozen=True, slots=True)
class HardwareFeedbackReceipt:
    event: HardwareFeedbackEvent
    outcome: str
    reason: str | None
    feedback_revision: int | None
    recorded_at: str

@dataclass(frozen=True, slots=True)
class HardwareFeedbackState:
    owner_id: str | None = None
    receipts: tuple[HardwareFeedbackReceipt, ...] = ()

    def __post_init__(self) -> None:
        if self.owner_id is not None:
            require_uuid(self.owner_id)
        keys = set()
        for receipt in self.receipts:
            if not isinstance(receipt, HardwareFeedbackReceipt) or receipt.event.owner_id != self.owner_id:
                raise ValueError("Invalid hardware receipt owner")
            if receipt.event.key in keys:
                raise ValueError("Duplicate hardware event receipt")
            keys.add(receipt.event.key)
            if receipt.outcome not in ("saved", "conflict"):
                raise ValueError("Invalid hardware receipt outcome")
            if receipt.outcome == "saved" and (receipt.reason is not None or receipt.feedback_revision != receipt.event.base_feedback_revision + 1):
                raise ValueError("Invalid saved hardware receipt")
            if receipt.outcome == "conflict" and receipt.reason not in (
                    "card_unavailable", "goal_unavailable", "goal_mismatch", "content_changed", "feedback_changed"):
                raise ValueError("Invalid hardware conflict reason")
            if receipt.feedback_revision is not None and (type(receipt.feedback_revision) is not int or not 0 <= receipt.feedback_revision <= 2**53 - 1):
                raise ValueError("Invalid receipt feedback revision")
            recorded_at = datetime.fromisoformat(receipt.recorded_at)
            if recorded_at.tzinfo is None or recorded_at.utcoffset() is None:
                raise ValueError("Receipt timestamp must include a timezone")

    def to_json(self) -> dict:
        return {"owner_id": self.owner_id, "receipts": [asdict(receipt) for receipt in self.receipts]}

    @classmethod
    def from_json(cls, value: dict) -> "HardwareFeedbackState":
        if not isinstance(value, dict) or set(value) != {"owner_id", "receipts"} or not isinstance(value["receipts"], list):
            raise ValueError("Invalid hardware feedback ledger")
        return cls(owner_id=value["owner_id"], receipts=tuple(
            HardwareFeedbackReceipt(**{**item, "event": HardwareFeedbackEvent(**item["event"])})
            for item in value["receipts"]))
