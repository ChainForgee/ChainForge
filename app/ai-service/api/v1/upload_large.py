"""
v1 upload-large endpoint — accepts up to 64 MiB requests.

Issue #267: ``MaxRequestBodySizeMiddleware`` defaults to the
service-wide ``MAX_REQUEST_BODY_BYTES`` (10 MiB) but per-route overrides
are required for routes like this one that handle genomic evidence or
large OCR pre-flight payloads.  The ``@with_body_size(...)`` marker is
read by ``main.py::lifespan`` and converted into a per-route regex
lookup so an oversized body on this route is rejected with 413 only
once the actual cap is exceeded; the default 10 MiB cap stays in force
for every other POST.
"""

import logging
from typing import Annotated

from fastapi import APIRouter, File, HTTPException, Request, UploadFile

from api.decorators import with_body_size

logger = logging.getLogger(__name__)

router = APIRouter(tags=["upload"])

# 64 MiB per the acceptance criteria of issue #267.  Stored as a
# module-level constant so the rate-limit middleware, observability,
# and tests all read the same value.
MAX_UPLOAD_BYTES = 64 * 1024 * 1024


@router.post("/ai/upload-large")
@with_body_size(MAX_UPLOAD_BYTES)
async def upload_large(
    request: Request,
    file: Annotated[UploadFile, File(description="Large evidence or document blob")],
):
    """Accept an upload of up to 64 MiB.  Larger uploads are rejected
    with HTTP 413 by ``MaxRequestBodySizeMiddleware``."""
    contents = await file.read()
    size = len(contents)

    if size == 0:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "empty_payload",
                "message": "Uploaded payload is empty",
            },
        )

    logger.info(
        "upload-large accepted filename=%s size=%d limit=%d",
        file.filename or "<unnamed>",
        size,
        MAX_UPLOAD_BYTES,
    )

    return {
        "success": True,
        "filename": file.filename,
        "size": size,
        "limit_bytes": MAX_UPLOAD_BYTES,
    }
