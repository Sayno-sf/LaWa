"""Knowledge Card domain: learning material, self-report and learner-owned notes.

A KnowledgeCard is NOT Evidence. Its feedback (KNOWN/UNSURE/UNKNOWN) is a
user self-report, not an objective ability proof. Its learner_note is content
owned by the user, not an AI assessment or candidate Evidence.
"""

from dataclasses import dataclass, replace
from datetime import datetime
from enum import Enum


class CardFeedbackStatus(str, Enum):
    """User self-report about a KnowledgeCard. Stable enum, never an ability score."""

    KNOWN = "KNOWN"
    UNSURE = "UNSURE"
    UNKNOWN = "UNKNOWN"


@dataclass(frozen=True, slots=True)
class KnowledgeCard:
    """A durable learning material card linked to one Skill.

    The card itself is created by the Teacher/Agent.  Feedback and note are
    user-owned and may only be set through user-authorized endpoints.
    """

    id: str
    skill_id: str
    question: str
    answer: str
    created_at: datetime
    source_conversation_id: str | None = None
    feedback: CardFeedbackStatus | None = None
    feedback_updated_at: datetime | None = None
    learner_note: str | None = None
    note_updated_at: datetime | None = None
    feedback_revision: int = 0

    def __post_init__(self) -> None:
        if not isinstance(self.id, str) or not self.id.strip():
            raise ValueError("KnowledgeCard id must be a non-empty string")
        if not isinstance(self.skill_id, str) or not self.skill_id.strip():
            raise ValueError("KnowledgeCard skill_id must be a non-empty string")
        if not isinstance(self.question, str) or not self.question.strip():
            raise ValueError("KnowledgeCard question must be a non-empty string")
        if not isinstance(self.answer, str) or not self.answer.strip():
            raise ValueError("KnowledgeCard answer must be a non-empty string")
        if not isinstance(self.created_at, datetime):
            raise TypeError("KnowledgeCard created_at must be a datetime")
        if self.source_conversation_id is not None and (
            not isinstance(self.source_conversation_id, str)
            or not self.source_conversation_id.strip()
        ):
            raise ValueError("KnowledgeCard source_conversation_id must be None or a non-empty string")
        if self.feedback is not None and not isinstance(self.feedback, CardFeedbackStatus):
            raise TypeError("KnowledgeCard feedback must be None or a CardFeedbackStatus")
        if type(self.feedback_revision) is not int or not 0 <= self.feedback_revision <= 2**53 - 1:
            raise ValueError("Invalid card feedback revision")

    def set_feedback(self, status: CardFeedbackStatus) -> "KnowledgeCard":
        """Return a new card with user self-report updated. User-owned action."""
        if not isinstance(status, CardFeedbackStatus):
            raise TypeError("card feedback status must be a CardFeedbackStatus")
        return replace(self, feedback=status, feedback_updated_at=datetime.now(),
                       feedback_revision=self.feedback_revision + 1)

    def set_note(self, note: str) -> "KnowledgeCard":
        """Return a new card with learner note set. User-owned action."""
        if not isinstance(note, str):
            raise TypeError("learner note must be a string")
        if not note.strip():
            raise ValueError("learner note must be a non-empty string; use clear_note to remove")
        return replace(self, learner_note=note, note_updated_at=datetime.now())

    def clear_note(self) -> "KnowledgeCard":
        """Return a new card with learner note removed. User-owned action."""
        return replace(self, learner_note=None, note_updated_at=datetime.now())

    def update_content(self, question: str, answer: str) -> "KnowledgeCard":
        """Return a new card with question/answer updated. User-owned action."""
        if not isinstance(question, str) or not question.strip():
            raise ValueError("KnowledgeCard question must be a non-empty string")
        if not isinstance(answer, str) or not answer.strip():
            raise ValueError("KnowledgeCard answer must be a non-empty string")
        return replace(self, question=question, answer=answer)
