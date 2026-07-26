"""
app/ai-service/schemas/codes.py

Issue #249 — Shared error-code taxonomy consumed by both backend
(NestJS, ``app/backend``) and AI service (FastAPI, ``app/ai-service``).

This file is the Python binding for ``docs/errors.yaml``, the single
source of truth.  The TypeScript binding lives in
``app/backend/src/common/errors/codes.ts``.  Parity between the two
bindings is checked automatically by:

  * ``app/backend/src/common/errors/codes.spec.ts``   (backend unit test)
  * ``app/ai-service/tests/test_codes.py``           (AI service unit test)

Both tests load ``docs/errors.yaml``, walk every entry, and assert that:

  1. The string ``code`` from YAML matches ``ErrorCode.<NAME>.value`` here.
  2. The numeric ``http_status`` from YAML matches ``ErrorCodeMeta.http_status``.
  3. The ``description`` matches the meta table.

If you change this file you MUST update ``docs/errors.yaml`` AND
``app/backend/src/common/errors/codes.ts`` in the same change. The parity
tests will fail otherwise, which is the whole point of the issue.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional


class ErrorCode(str, Enum):
    """Stable string codes emitted by the API surface.

    String values are what the wire format publishes.  Mirroring
    ``ErrorCode`` in ``app/backend/src/common/errors/codes.ts`` exactly;
    parity is enforced by ``tests/test_codes.py``.
    """

    CODE_BODY_LENGTH_MISMATCH = "CODE_BODY_LENGTH_MISMATCH"
    HTTP_400 = "HTTP_400"
    HTTP_401 = "HTTP_401"
    HTTP_403 = "HTTP_403"
    HTTP_404 = "HTTP_404"
    HTTP_409 = "HTTP_409"
    HTTP_413 = "HTTP_413"
    HTTP_422 = "HTTP_422"
    HTTP_500 = "HTTP_500"
    HTTP_502 = "HTTP_502"
    HTTP_503 = "HTTP_503"
    INTERNAL_SERVER_ERROR = "INTERNAL_SERVER_ERROR"
    PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    AI_SERVICE_ERROR = "AI_SERVICE_ERROR"
    AI_TIMEOUT = "AI_TIMEOUT"


@dataclass(frozen=True)
class ErrorCodeMeta:
    """Per-code metadata derived from ``docs/errors.yaml``.

    Indexed by ``ErrorCode`` so consumers can look up HTTP status and
    description in O(1).  Every entry here MUST be a 1:1 with
    ``ErrorCode`` and ``docs/errors.yaml``; ``tests/test_codes.py`` fails
    the build if they are not.
    """

    code: str
    http_status: int
    description: str


# Metadata table — keys here MUST exist in ``ErrorCode``; the parity
# test enforces this.
ERROR_CODE_META: dict[ErrorCode, ErrorCodeMeta] = {
    ErrorCode.HTTP_400: ErrorCodeMeta(
        code="HTTP_400",
        http_status=400,
        description="Bad request — the request was malformed or contained invalid parameters.",
    ),
    ErrorCode.HTTP_401: ErrorCodeMeta(
        code="HTTP_401",
        http_status=401,
        description="Unauthorized — authentication is required to access this resource.",
    ),
    ErrorCode.HTTP_403: ErrorCodeMeta(
        code="HTTP_403",
        http_status=403,
        description="Forbidden — the caller is authenticated but lacks permission.",
    ),
    ErrorCode.HTTP_404: ErrorCodeMeta(
        code="HTTP_404",
        http_status=404,
        description="Not found — the requested resource does not exist.",
    ),
    ErrorCode.HTTP_409: ErrorCodeMeta(
        code="HTTP_409",
        http_status=409,
        description="Conflict — the request conflicts with the current resource state.",
    ),
    ErrorCode.HTTP_413: ErrorCodeMeta(
        code="HTTP_413",
        http_status=413,
        description="Payload too large — the request body exceeds the configured limit.",
    ),
    ErrorCode.HTTP_422: ErrorCodeMeta(
        code="HTTP_422",
        http_status=422,
        description="Unprocessable entity — request payload failed schema validation.",
    ),
    ErrorCode.HTTP_500: ErrorCodeMeta(
        code="HTTP_500",
        http_status=500,
        description="Internal server error — an unexpected exception escaped the handler.",
    ),
    ErrorCode.HTTP_502: ErrorCodeMeta(
        code="HTTP_502",
        http_status=502,
        description="Bad gateway — an upstream/downstream dependency failed.",
    ),
    ErrorCode.HTTP_503: ErrorCodeMeta(
        code="HTTP_503",
        http_status=503,
        description="Service unavailable — temporary degradation; retry with backoff.",
    ),
    ErrorCode.VALIDATION_ERROR: ErrorCodeMeta(
        code="VALIDATION_ERROR",
        http_status=422,
        description="Validation failed — request payload does not match the expected schema.",
    ),
    ErrorCode.AI_SERVICE_ERROR: ErrorCodeMeta(
        code="AI_SERVICE_ERROR",
        http_status=502,
        description="AI service error — the upstream LLM/OCR provider failed to respond.",
    ),
    ErrorCode.AI_TIMEOUT: ErrorCodeMeta(
        code="AI_TIMEOUT",
        http_status=502,
        description="AI service timeout — the upstream LLM exceeded its time budget.",
    ),
    ErrorCode.PAYLOAD_TOO_LARGE: ErrorCodeMeta(
        code="PAYLOAD_TOO_LARGE",
        http_status=413,
        description="Payload too large — the request body exceeded the configured size limit.",
    ),
    ErrorCode.CODE_BODY_LENGTH_MISMATCH: ErrorCodeMeta(
        code="CODE_BODY_LENGTH_MISMATCH",
        http_status=400,
        description="Body length mismatch — streamed bytes exceeded the declared Content-Length.",
    ),
    ErrorCode.INTERNAL_SERVER_ERROR: ErrorCodeMeta(
        code="INTERNAL_SERVER_ERROR",
        http_status=500,
        description="Internal server error — generic catch-all for unhandled exceptions.",
    ),
}


def code_for_http_status(status: int) -> str:
    """Reverse lookup: HTTP status → stable string code.

    Mirrors ``codeForHttpStatus`` in
    ``app/backend/src/common/errors/codes.ts``.  If a status maps to
    multiple codes the FIRST one declared in ``ERROR_CODE_META`` wins
    (preserves insertion order); ``tests/test_codes.py`` asserts this
    matches the lookup in the TS module.
    """
    for meta in ERROR_CODE_META.values():
        if meta.http_status == status:
            return meta.code
    return f"HTTP_{status}"


def http_status_for_code(code: str) -> Optional[int]:
    """Reverse lookup: stable string code → HTTP status.

    Mirrors ``httpStatusForCode`` in
    ``app/backend/src/common/errors/codes.ts``.
    """
    for code_value, meta in ERROR_CODE_META.items():
        if code_value.value == code or meta.code == code:
            return meta.http_status
    return None
