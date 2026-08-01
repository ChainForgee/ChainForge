"""
Auditor search endpoint for PII decision records.

Returns only aggregate metadata — never raw or anonymized text — so
operators can answer "we redacted N PII entities at time T in a
document of length L" without rehydrating sensitive content.

Pair with the periodic retention sweep started in
``main.py::lifespan`` to keep the underlying SQLite table bounded.
"""

import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from schemas.anonymization import (
    PIIDecisionSummary,
    PIIDecisionRecord,
    PIIDecisionsResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["pii-decisions"])

# Cap page size so a misconfigured caller cannot exhaust the DB in a
# single request.  500 rows of metadata is still a tiny working set.
MAX_PAGE_SIZE = 500
DEFAULT_PAGE_SIZE = 100


@router.get("/ai/pii-decisions", response_model=PIIDecisionsResponse)
async def list_pii_decisions(
    limit: int = Query(
        DEFAULT_PAGE_SIZE,
        ge=1,
        le=MAX_PAGE_SIZE,
        description="Maximum number of decision records to return (newest first).",
    ),
) -> PIIDecisionsResponse:
    """Return recent PII decision records for auditor review."""
    from config import settings
    from persistence.pii_decisions import PIIDecisionStore

    if not settings.pii_decisions_enabled:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "pii_decisions_disabled",
                "message": (
                    "PII decisions persistence is disabled; set "
                    "PII_DECISIONS_ENABLED=true to enable auditing."
                ),
            },
        )

    try:
        store = PIIDecisionStore(settings.pii_decisions_db_path)
        rows = store.get_recent_decisions(limit=limit)
    except Exception as exc:
        logger.error("pii_decisions lookup failed: %s", exc)
        raise HTTPException(
            status_code=500,
            detail={
                "code": "pii_decisions_lookup_failed",
                "message": "Failed to query PII decisions store",
            },
        )

    decisions = []
    for r in rows:
        decisions.append(
            PIIDecisionRecord(
                id=r["id"],
                created_at=datetime.fromtimestamp(r["created_at"]),
                original_length=r["original_length"],
                pii_summary=PIIDecisionSummary(**r["pii_summary"]),
                token_counts=r.get("token_counts", {}),
                text_fingerprint=r["text_fingerprint"],
                model_version=r.get("model_version"),
            )
        )

    return PIIDecisionsResponse(
        success=True,
        count=len(decisions),
        decisions=decisions,
    )
