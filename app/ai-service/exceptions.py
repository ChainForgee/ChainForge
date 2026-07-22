from typing import Any, Optional

from schemas.error_codes import ErrorCode


class AIServiceError(Exception):
    """Raised when a downstream AI/LLM call fails.

    ``code`` defaults to :attr:`ErrorCode.AI_SERVICE_ERROR` (Issue #249)
    — the shared cross-service taxonomy identifier.  Callers may pass
    any ``ErrorCode`` member (its ``.value`` string is what the AI
    service emits in the response envelope).
    """

    def __init__(
        self,
        message: str,
        code: ErrorCode | str = ErrorCode.AI_SERVICE_ERROR,
        details: Optional[Any] = None,
    ):
        super().__init__(message)
        self.message = message
        # Accept either an ErrorCode member or a raw string so existing
        # callers that pass ``code="AI_TIMEOUT"`` keep working; .value
        # is already the literal string for ErrorCode members.
        self.code = code.value if isinstance(code, ErrorCode) else code
        self.details = details

    def __str__(self) -> str:
        return f"[{self.code}] {self.message}"
