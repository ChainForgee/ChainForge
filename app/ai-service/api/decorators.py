"""Route decorators for the AI service.

This module currently exposes ``with_body_size`` so individual routes
can declare a larger body-size cap than the service-wide default
(``MAX_REQUEST_BODY_BYTES``/10 MiB).  See the ``MaxRequestBodySizeMiddleware``
implementation in ``main.py`` for the matching lookup.
"""

from __future__ import annotations

from typing import Callable, TypeVar

F = TypeVar("F", bound=Callable[..., object])


def with_body_size(max_bytes: int) -> Callable[[F], F]:
    """Decorator: mark a route handler with a custom body-size limit.

    Usage::

        from api.decorators import with_body_size

        @router.post("/ai/upload-large")
        @with_body_size(64 * 1024 * 1024)  # 64 MiB
        async def upload_large(...): ...

    The annotation is stored on ``func._max_body_size`` and read by
    ``main.py::lifespan`` while walking ``app.routes``.  Decorators
    return the original function untouched so FastAPI's introspection
    continues to see ``endpoint`` as a regular async callable.
    """
    if max_bytes is None or max_bytes <= 0:
        raise ValueError(
            "with_body_size requires a positive integer byte limit; "
            "use 0 only to disable globally, not for a single route."
        )

    def decorator(func: F) -> F:
        # FastAPI keeps a reference to the original callable via
        # ``route.endpoint``.  Setting the attribute on the wrapped
        # function (which is what the route stores) is enough.
        func._max_body_size = int(max_bytes)  # type: ignore[attr-defined]
        return func

    return decorator
