"""Cross-service error-code taxonomy (Issue #249).

Python mirror of ``docs/errors.yaml`` and
``app/backend/src/common/errors/codes.ts``. The parity test in
``tests/test_error_codes.py`` asserts every name listed in the YAML
appears here, and that every enum value here appears in the YAML.

Inheriting from ``str`` lets ``ErrorCode.VALIDATION_ERROR`` serialise
directly to ``"VALIDATION_ERROR"`` in JSON without any extra mapping
code, matching the TypeScript side exactly.
"""
from __future__ import annotations

from enum import Enum
from typing import Dict


class ErrorCode(str, Enum):
    """Canonical SCREAMING_SNAKE_CASE identifiers mirroring docs/errors.yaml.

    Each member's ``value`` is the literal string form, e.g.::

        ErrorCode.NOT_FOUND.value == "NOT_FOUND"

    so the JSON serialised identifier is byte-identical to the
    TypeScript-side emission.
    """

    # Cross-service HTTP categories ----------------------------------
    VALIDATION_ERROR = "VALIDATION_ERROR"
    NOT_FOUND = "NOT_FOUND"
    UNAUTHORIZED = "UNAUTHORIZED"
    FORBIDDEN = "FORBIDDEN"
    CONFLICT = "CONFLICT"
    BAD_REQUEST = "BAD_REQUEST"
    PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE"
    BODY_LENGTH_MISMATCH = "BODY_LENGTH_MISMATCH"
    INTERNAL_SERVER_ERROR = "INTERNAL_SERVER_ERROR"
    UPSTREAM_TIMEOUT = "UPSTREAM_TIMEOUT"
    UPSTREAM_UNAVAILABLE = "UPSTREAM_UNAVAILABLE"
    UPSTREAM_ERROR = "UPSTREAM_ERROR"
    AI_SERVICE_ERROR = "AI_SERVICE_ERROR"
    AI_TIMEOUT = "AI_TIMEOUT"
    RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED"

    # Soroban contract errors (AidEscrow `Error` enum, 1..=23) --------
    CONTRACT_NOT_INITIALIZED = "CONTRACT_NOT_INITIALIZED"
    CONTRACT_ALREADY_INITIALIZED = "CONTRACT_ALREADY_INITIALIZED"
    CONTRACT_NOT_AUTHORIZED = "CONTRACT_NOT_AUTHORIZED"
    CONTRACT_INVALID_AMOUNT = "CONTRACT_INVALID_AMOUNT"
    CONTRACT_PACKAGE_NOT_FOUND = "CONTRACT_PACKAGE_NOT_FOUND"
    CONTRACT_PACKAGE_NOT_ACTIVE = "CONTRACT_PACKAGE_NOT_ACTIVE"
    CONTRACT_PACKAGE_EXPIRED = "CONTRACT_PACKAGE_EXPIRED"
    CONTRACT_PACKAGE_NOT_EXPIRED = "CONTRACT_PACKAGE_NOT_EXPIRED"
    CONTRACT_INSUFFICIENT_FUNDS = "CONTRACT_INSUFFICIENT_FUNDS"
    CONTRACT_PACKAGE_ID_EXISTS = "CONTRACT_PACKAGE_ID_EXISTS"
    CONTRACT_INVALID_STATE = "CONTRACT_INVALID_STATE"
    CONTRACT_MISMATCHED_ARRAYS = "CONTRACT_MISMATCHED_ARRAYS"
    CONTRACT_INSUFFICIENT_SURPLUS = "CONTRACT_INSUFFICIENT_SURPLUS"
    CONTRACT_PAUSED = "CONTRACT_PAUSED"
    CONTRACT_CLAIM_TOO_EARLY = "CONTRACT_CLAIM_TOO_EARLY"
    CONTRACT_INVALID_PROOF = "CONTRACT_INVALID_PROOF"
    CONTRACT_INVALID_TOKEN = "CONTRACT_INVALID_TOKEN"
    CONTRACT_TOKEN_TRANSFER_FAILED = "CONTRACT_TOKEN_TRANSFER_FAILED"
    CONTRACT_ALLOWLIST_EXPIRED = "CONTRACT_ALLOWLIST_EXPIRED"
    CONTRACT_PROOF_TOO_LARGE = "CONTRACT_PROOF_TOO_LARGE"
    CONTRACT_NO_PENDING_ADMIN = "CONTRACT_NO_PENDING_ADMIN"
    CONTRACT_ADMIN_ROTATION_EXPIRED = "CONTRACT_ADMIN_ROTATION_EXPIRED"
    CONTRACT_TOO_MANY_ALLOWED_TOKENS = "CONTRACT_TOO_MANY_ALLOWED_TOKENS"


# Numeric Soroban contract error → shared ErrorCode. Mirrors the
# TypeScript-side table in app/backend/src/common/errors/codes.ts.
CONTRACT_ERROR_CODE_BY_NUMBER: Dict[int, ErrorCode] = {
    1: ErrorCode.CONTRACT_NOT_INITIALIZED,
    2: ErrorCode.CONTRACT_ALREADY_INITIALIZED,
    3: ErrorCode.CONTRACT_NOT_AUTHORIZED,
    4: ErrorCode.CONTRACT_INVALID_AMOUNT,
    5: ErrorCode.CONTRACT_PACKAGE_NOT_FOUND,
    6: ErrorCode.CONTRACT_PACKAGE_NOT_ACTIVE,
    7: ErrorCode.CONTRACT_PACKAGE_EXPIRED,
    8: ErrorCode.CONTRACT_PACKAGE_NOT_EXPIRED,
    9: ErrorCode.CONTRACT_INSUFFICIENT_FUNDS,
    10: ErrorCode.CONTRACT_PACKAGE_ID_EXISTS,
    11: ErrorCode.CONTRACT_INVALID_STATE,
    12: ErrorCode.CONTRACT_MISMATCHED_ARRAYS,
    13: ErrorCode.CONTRACT_INSUFFICIENT_SURPLUS,
    14: ErrorCode.CONTRACT_PAUSED,
    15: ErrorCode.CONTRACT_CLAIM_TOO_EARLY,
    16: ErrorCode.CONTRACT_INVALID_PROOF,
    17: ErrorCode.CONTRACT_INVALID_TOKEN,
    18: ErrorCode.CONTRACT_TOKEN_TRANSFER_FAILED,
    19: ErrorCode.CONTRACT_ALLOWLIST_EXPIRED,
    20: ErrorCode.CONTRACT_PROOF_TOO_LARGE,
    21: ErrorCode.CONTRACT_NO_PENDING_ADMIN,
    22: ErrorCode.CONTRACT_ADMIN_ROTATION_EXPIRED,
    23: ErrorCode.CONTRACT_TOO_MANY_ALLOWED_TOKENS,
}


# HTTP status code → ErrorCode mapping. Used by main.py to translate
# raised HTTPExceptions to the new shared taxonomy without sprinkling
# string literals through the error handlers.
HTTP_STATUS_TO_ERROR_CODE: Dict[int, ErrorCode] = {
    400: ErrorCode.BAD_REQUEST,
    401: ErrorCode.UNAUTHORIZED,
    403: ErrorCode.FORBIDDEN,
    404: ErrorCode.NOT_FOUND,
    409: ErrorCode.CONFLICT,
    413: ErrorCode.PAYLOAD_TOO_LARGE,
    422: ErrorCode.VALIDATION_ERROR,
    429: ErrorCode.RATE_LIMIT_EXCEEDED,
    500: ErrorCode.INTERNAL_SERVER_ERROR,
    502: ErrorCode.UPSTREAM_ERROR,
    503: ErrorCode.UPSTREAM_UNAVAILABLE,
    504: ErrorCode.UPSTREAM_TIMEOUT,
}


def error_code_for_http_status(status_code: int) -> ErrorCode:
    """Best-effort cross-stack mapping for HTTPException path.

    Falls back to ``BAD_REQUEST`` for unmapped 4xx, ``UPSTREAM_ERROR``
    for unmapped 5xx — never invent a new identifier at runtime.
    """
    if status_code in HTTP_STATUS_TO_ERROR_CODE:
        return HTTP_STATUS_TO_ERROR_CODE[status_code]
    if 400 <= status_code < 500:
        return ErrorCode.BAD_REQUEST
    if 500 <= status_code < 600:
        return ErrorCode.UPSTREAM_ERROR
    return ErrorCode.INTERNAL_SERVER_ERROR
