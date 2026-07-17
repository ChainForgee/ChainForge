from enum import Enum
from typing import Any, Optional
from pydantic import BaseModel


class ErrorCode(str, Enum):
    AI_SERVICE_ERROR = "AI_SERVICE_ERROR"
    AI_TIMEOUT = "AI_TIMEOUT"
    AI_PROVIDER_ERROR = "AI_PROVIDER_ERROR"
    AI_CONNECTION_ERROR = "AI_CONNECTION_ERROR"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE"
    HTTP_400 = "HTTP_400"
    HTTP_401 = "HTTP_401"
    HTTP_403 = "HTTP_403"
    HTTP_404 = "HTTP_404"
    HTTP_405 = "HTTP_405"
    HTTP_422 = "HTTP_422"
    HTTP_429 = "HTTP_429"
    HTTP_500 = "HTTP_500"
    INTERNAL_SERVER_ERROR = "HTTP_500"  # Alias for HTTP_500
    HTTP_502 = "HTTP_502"


class ErrorDetail(BaseModel):
    code: ErrorCode
    message: str
    details: Optional[Any] = None


class ErrorEnvelope(BaseModel):
    error: ErrorDetail
