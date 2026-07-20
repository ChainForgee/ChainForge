"""Tests for per-route body-size overrides (Issue #267).

Two angles:

1. ``@with_body_size(...)`` decorator sets ``_max_body_size`` on the
   function so the size-limit middleware can pick it up by walking
   ``self.app.routes`` at request time.

2. ``MaxRequestBodySizeMiddleware`` honours the per-route limit while
   preserving the global default for unmarked routes.

The middleware reads ``self.app.routes`` — which is
``fastapi.app.router.routes`` — because writing per-route limits via
``app.state.route_body_limits`` does not survive the ASGI chain (each
layer carries its own ``state`` object).  The decorator marker on the
endpoint is the contract surfaces both in production and in tests.
"""

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from api.decorators import with_body_size
from main import MaxRequestBodySizeMiddleware


def _build_app(
    *,
    max_bytes: int,
    decorator=None,
    path: str = "/decorated",
    extra_routes: list | None = None,
) -> FastAPI:
    """Stand up a small FastAPI app with a single POST route and the
    size-limit middleware attached.

    ``decorator`` is the *decorator factory* returned by
    :func:`api.decorators.with_body_size` — it is applied to the route
    handler before ``add_api_route`` so the middleware sees the marker
    via ``self.app.routes``.
    """
    app = FastAPI()
    app.add_middleware(MaxRequestBodySizeMiddleware, max_bytes=max_bytes)

    async def handler(req: Request):
        body = await req.body()
        return {"size": len(body)}

    if decorator is not None:
        handler = decorator(handler)

    app.add_api_route(path, handler, methods=["POST"])
    return app


# ---------------------------------------------------------------------------
# 1. Decorator wiring
# ---------------------------------------------------------------------------


class TestWithBodySizeDecorator:
    def test_decorator_attaches_marker(self):
        @with_body_size(64 * 1024 * 1024)
        async def my_handler():
            return None

        assert getattr(my_handler, "_max_body_size") == 64 * 1024 * 1024

    def test_decorator_rejects_non_positive(self):
        import pytest

        with pytest.raises(ValueError):
            with_body_size(0)

        with pytest.raises(ValueError):
            with_body_size(-1)


# ---------------------------------------------------------------------------
# 2. Middleware honours per-route override
# ---------------------------------------------------------------------------


class TestRouteSpecificLimit:
    """The acceptance criterion from Issue #267:
    ``/v1/ai/upload-large`` declared with ``max_bytes=64*1024*1024``
    returns 413 only on 64 MiB+ requests.
    """

    def test_decorated_handler_accepts_500_byte_body_under_64_mib(self):
        # Override = 64 MiB, global default = 128 B.  A 500 B body is
        # over the global default but under the override — middleware
        # must accept it.
        app = _build_app(
            max_bytes=128,
            decorator=with_body_size(64 * 1024 * 1024),
        )
        client = TestClient(app)
        resp = client.post("/decorated", content=b"x" * 500)
        assert resp.status_code == 200
        assert resp.json() == {"size": 500}

    def test_undecorated_route_uses_global_limit(self):
        """A POST without a ``@with_body_size`` marker should still be
        rejected at the service-wide default (Issue #267 acceptance:
        ``Default unchanged``).
        """
        app = _build_app(max_bytes=128)
        client = TestClient(app)
        resp = client.post("/decorated", content=b"x" * 200)
        assert resp.status_code == 413
        assert resp.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"
        assert "128 bytes" in resp.json()["error"]["message"]

    def test_decorated_handler_413_message_references_per_route_limit(self):
        """The 413 envelope message must surface the effective (per-route)
        limit so clients can size their retries correctly.

        Issue #267 acceptance: a route decorated with a SMALLER limit
        than the global default must be honoured (e.g. an OCR route
        capping at 512 B while the global default is 1 KiB).
        """
        app = _build_app(
            max_bytes=1024,
            decorator=with_body_size(512),
            path="/small",
        )
        client = TestClient(app)
        # 700 bytes exceeds the per-route 512 cap but is under the global
        # 1024 default — only the override-aware middleware rejects.
        resp = client.post("/small", content=b"x" * 700)
        assert resp.status_code == 413
        body = resp.json()
        assert body["error"]["code"] == "PAYLOAD_TOO_LARGE"
        assert "512 bytes" in body["error"]["message"]

    def test_upload_large_64mib_overrides_10mib_default(self):
        """AC: ``/v1/ai/upload-large`` declared with
        ``max_bytes=64*1024*1024`` returns 413 only on 64 MiB+ payloads.

        We exercise the same machinery with smaller numbers so the test
        is fast (linear in the byte cap; the production behaviour is
        identical).
        """
        # 64 MiB = 67108864 bytes; pick a small stand-in cap so the
        # "above the cap" case fits in a few MB.  The middleware logic
        # is byte-accurate, so the ratio between (global, override,
        # payload) is what matters, not the absolute values.
        global_default = 1024 * 1024  # 1 MiB stands in for 10 MiB
        override_cap = 4 * 1024 * 1024  # 4 MiB stands in for 64 MiB

        app = _build_app(
            max_bytes=global_default,
            decorator=with_body_size(override_cap),
            path="/v1/ai/upload-large",
        )
        client = TestClient(app)
        # Just under the override cap is accepted.  2 MiB is over the
        # 1 MiB global default but under the 4 MiB override — proving
        # the override widens the default.
        resp = client.post("/v1/ai/upload-large", content=b"x" * (2 * 1024 * 1024))
        assert resp.status_code == 200
        assert resp.json()["size"] == 2 * 1024 * 1024

        # Above the override cap is rejected.  5 MiB exceeds BOTH the
        # global default (1 MiB) and the override (4 MiB).  The error
        # message must reference the per-route 4 MiB ceiling.
        resp = client.post("/v1/ai/upload-large", content=b"x" * (5 * 1024 * 1024))
        assert resp.status_code == 413
        msg = resp.json()["error"]["message"]
        assert str(override_cap) in msg


# ---------------------------------------------------------------------------
# 3. The middleware reads ``self.app.routes`` (i.e. the inner Starlette
#    router).  This unit check confirms the lazy walk produces the right
#    regex table without any explicit app.state wiring.
# ---------------------------------------------------------------------------


class TestMiddlewareRouteWalk:
    def test_route_walk_collects_marker_from_self_app_routes(self):
        async def handler(req: Request):
            return {"ok": True}

        captured: dict = {}

        class _CapturingApp:
            """ASGI app that records the middleware's ``self.app`` and
            builds empty route tables so we can inspect the walk."""

            def __init__(self):
                self.routes = getattr(handler, "_max_body_size", None) and []

        # Probe directly: construct the middleware and call its lazy
        # walk helper with a synthetic Starlette-looking downstream
        # carrying one route with the marker.
        from main import MaxRequestBodySizeMiddleware

        middleware = MaxRequestBodySizeMiddleware(
            app=_CapturingApp(), max_bytes=1024
        )
        # Build a minimal route exposing .path_regex + .methods +
        # .endpoint with `_max_body_size`.
        import re

        class _FakeRoute:
            path = "/decorated"
            path_regex = re.compile(r"^/decorated$")
            methods = {"POST"}
            endpoint = handler

        # Inject the synthetic route table onto the downstream app.
        middleware.app.routes = [_FakeRoute()]  # type: ignore[attr-defined]
        middleware._ensure_route_limits()

        assert middleware.route_limits, "expected route_limits to be populated"
        limit = middleware._route_specific_limit(
            {
                "type": "http",
                "method": "POST",
                "raw_path": b"/decorated",
                "path": "/decorated",
            }
        )
        assert limit == 64 * 1024 * 1024

    def test_route_walk_handles_empty_marker(self):
        # When the route table has no markers, the walk should leave
        # the override map empty and fall back to the global cap.
        from main import MaxRequestBodySizeMiddleware

        class _NoMarkerRoute:
            path = "/unmarked"
            path_regex = __import__("re").compile(r"^/unmarked$")
            methods = {"POST"}

            class endpoint:
                pass

        class _Downstream:
            routes = [_NoMarkerRoute()]

        middleware = MaxRequestBodySizeMiddleware(
            app=_Downstream(), max_bytes=128
        )
        middleware._ensure_route_limits()
        assert middleware.route_limits == {}
