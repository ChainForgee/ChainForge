from datetime import datetime
from typing import Dict, Optional

from pydantic import BaseModel, Field


class AnonymizeRequest(BaseModel):
    text: str = Field(min_length=1, description="Input text to anonymize before LLM processing")


class PIISummary(BaseModel):
    names: int
    locations: int
    dates: int
    total: int


class AnonymizeResponse(BaseModel):
    success: bool
    anonymized_text: str
    original_length: int
    pii_summary: PIISummary
    token_counts: Dict[str, int] = Field(default_factory=dict)
    model_version: Optional[str] = None


class PIIDecisionSummary(BaseModel):
    """Aggregate counts of redacted PII entities for one document.

    Mirrors ``PIISummary`` plus email/phone/id counts so the audit
    surface matches the full scrubber output.
    """

    names: int
    locations: int
    dates: int
    emails: int
    phones: int
    ids: int
    total: int


class PIIDecisionRecord(BaseModel):
    """A PII decision record surfaced by the auditor search endpoint.

    No raw or anonymized text is ever returned: only aggregate metadata,
    a non-reversible text fingerprint, and the scrubber model version.
    """

    id: str
    created_at: datetime
    original_length: int
    pii_summary: PIIDecisionSummary
    token_counts: Dict[str, int] = Field(default_factory=dict)
    text_fingerprint: str
    model_version: Optional[str] = None


class PIIDecisionsResponse(BaseModel):
    """Wrapper around the list returned by ``GET /v1/ai/pii-decisions``."""

    success: bool
    count: int
    decisions: list[PIIDecisionRecord] = Field(default_factory=list)
