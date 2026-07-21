"""
v1 anonymization endpoint.

Records aggregate audit metadata (counts only, never raw or anonymized
text) for every successful anonymization when ``pii_decisions_enabled``
is true.  See ``persistence/pii_decisions.py`` for the storage layer.
"""

import hashlib
import logging
import time

from fastapi import APIRouter, BackgroundTasks, HTTPException

from schemas.anonymization import AnonymizeRequest, AnonymizeResponse
from persistence.pii_decisions import PIIDecisionRecord, new_record_id

logger = logging.getLogger(__name__)

router = APIRouter(tags=["anonymization"])


def _text_fingerprint(text: str) -> str:
    """SHA-256 hex digest so duplicate redact audits can be detected
    without ever rehydrating the source text."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _record_pii_decision(
    text: str,
    result: dict,
    model_version: str | None,
) -> None:
    """BackgroundTasks callback: persist aggregate audit metadata.

    Reads ``settings`` lazily inside the worker to avoid import cycles
    and to apply the latest config at the moment of write.
    """
    try:
        from config import settings
        if not settings.pii_decisions_enabled:
            return
        # Late import keeps the persistence module out of the request
        # path so import failures don't break the anonymize endpoint.
        from persistence.pii_decisions import PIIDecisionStore

        record = PIIDecisionRecord(
            id=new_record_id(),
            created_at=time.time(),
            original_length=result.get("original_length", len(text)),
            pii_summary=result.get("pii_summary", {}),
            token_counts=result.get("token_counts", {}),
            text_fingerprint=_text_fingerprint(text),
            model_version=model_version,
        )
        store = PIIDecisionStore(settings.pii_decisions_db_path)
        store.save_decision(record, settings.pii_decisions_retention_days)
        logger.info(
            "stored pii_decision id=%s total=%d",
            record.id,
            record.pii_summary.get("total", 0),
        )
    except Exception as exc:  # pragma: no cover - defensive
        # Never break the request because of audit-log failure.
        logger.error("pii_decision persistence failed: %s", exc)


@router.post("/ai/anonymize", response_model=AnonymizeResponse)
async def anonymize_text(
    request: AnonymizeRequest,
    background_tasks: BackgroundTasks,
):
    """Anonymize names, locations, and dates before text is sent to external LLMs."""
    import main as _main

    logger.info("Processing privacy-preserving anonymization request")

    try:
        result = _main.pii_scrubber_service.anonymize(request.text)
        from config import settings
        active_p = settings.get_active_provider()
        model_version = settings.groq_model if active_p == "groq" else settings.openai_model

        # Aggregate-only audit record; never touches raw or
        # anonymized text.  The fingerprint is enough to detect
        # duplicate scrub jobs without a privacy leak.  Skip the
        # BackgroundTasks dispatch entirely when persistence is
        # disabled so the default configuration incurs no per-request
        # overhead.
        if settings.pii_decisions_enabled:
            background_tasks.add_task(
                _record_pii_decision,
                request.text,
                result,
                model_version,
            )

        return AnonymizeResponse(success=True, model_version=model_version, **result)
    except Exception as e:
        logger.error(f"Anonymization failed: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to anonymize text")
