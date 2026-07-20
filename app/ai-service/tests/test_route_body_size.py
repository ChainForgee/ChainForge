"""Tests for per-route body-size overrides (Issue #267).

Two angles:

1. ``@with_body_size(...)`` decorator sets ``_max_body_size`` on the
   function so FastAPI's route table can pick it up.

2. ``MaxRequestBodySizeMiddleware`` honours the per-route limit while
   preserving the global default for unmarked routes.
"""

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from api.decorators import with_body_size
from main import MaxRequestBodySizeMiddleware


def _build_app_with_decoration(decorated_handler):
    """Stand up a FastAPI app containing a single decorated route and
    walk ``app.routes`` to populate the middleware registry that the
    real lifespan wires up.
    """
    app = FastAPI()
    app.add_middleware(
        MaxRequestBodySizeMiddleware,
        max_bytes=128,  # tight global default
    )

    @decorated_handler
    async def handler(req: Request):
        body = await req.body()
        return {"size": len(body)}

    app.add_api_route("/decorated", handler, methods=["POST"])

    # Reproduce the lifespan route walk.
    route_body_limits: dict[tuple, int] = {}
    for route in app.routes:
        marker = getattr(getattr(route, "endpoint", None), "_max_body_size", None)
        if not marker:
            continue
        for method in route.methods or set():
            route_body_limits[(method.upper(), route.path_regex)] = int(marker)
    app.state.route_body_limits = route_body_limits

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
        async def handler(req: Request):
            return {"ok": True}

        handler.__name__ = "decorated_handler"
        decorated = with_body_size(64 * 1024 * 1024)(handler)
        app = _build_app_with_decoration(decorated)
        client = TestClient(app)
        resp = client.post("/decorated", content=b"x" * 500)
        assert resp.status_code == 200
        assert resp.json() == {"size": 500}

    def test_undecorated_route_uses_global_limit(self):
        """A POST without a ``@with_body_size`` marker should still be
        rejected at the service-wide default (Issue #267 acceptance:
        ``Default unchanged``).
        """
        app = FastAPI()
        app.add_middleware(MaxRequestBodySizeMiddleware, max_bytes=128)

        @app.post("/plain")
        async def plain(req: Request):
            return {"ok": True}

        # Walk routes (no markers).
        app.state.route_body_limits = {}
        client = TestClient(app)
        resp = client.post("/plain", content=b"x" * 200)
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
        async def small_handler(req: Request):
            return {"ok": True}

        decorated = with_body_size(512)(small_handler)
        app = FastAPI()
        app.add_middleware(MaxRequestBodySizeMiddleware, max_bytes=1024)
        app.add_api_route("/small", decorated, methods=["POST"])

        # Walk routes to populate ``state`` exactly as ``lifespan`` does.
        route_body_limits: dict[tuple, int] = {}
        for route in app.routes:
            marker = getattr(getattr(route, "endpoint", None), "_max_body_size", None)
            if not marker:
                continue
            for method in route.methods or set():
                route_body_limits[(method.upper(), route.path_regex)] = int(marker)
        app.state.route_body_limits = route_body_limits

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

        async def upload_handler(req: Request):
            body = await req.body()
            return {"size": len(body)}

        decorated = with_body_size(override_cap)(upload_handler)
        app = FastAPI()
        app.add_middleware(MaxRequestBodySizeMiddleware, max_bytes=global_default)
        app.add_api_route("/v1/ai/upload-large", decorated, methods=["POST"])

        route_body_limits: dict = {}
        for route in app.routes:
            marker = getattr(getattr(route, "endpoint", None), "_max_body_size", None)
            if not marker:
                continue
            for method in route.methods or set():
                route_body_limits[(method.upper(), route.path_regex)] = int(marker)
        app.state.route_body_limits = route_body_limits

        client = TestClient(app)
        # Just under the override cap stays under the global cap and
        # is accepted.  Below we use 2 MiB which is > 1 MiB default but
        # < 4 MiB override — proving the override widens the default.
        resp = client.post("/v1/ai/upload-large", content=b"x" * (2 * 1024 * 1024))
        assert resp.status_code == 200
        assert resp.json()["size"] == 2 * 1024 * 1024

        # Above the override cap is rejected.  Use 5 MiB which exceeds
        # BOTH the global default (1 MiB) and the override (4 MiB).
        # The error message must reference the per-route 4 MiB ceiling.
        resp = client.post("/v1/ai/upload-large", content=b"x" * (5 * 1024 * 1024))
        assert resp.status_code == 413
        msg = resp.json()["error"]["message"]
        assert str(override_cap) in msg


# ---------------------------------------------------------------------------
# 3. Real ``main.app`` wiring — fast unit check
# ---------------------------------------------------------------------------


class TestRealAppWiring:
    def test_route_body_limits_collected_for_decorated_routes(self):
        """After lifespan runs, ``main.app.state.route_body_limits`` should
        reflect every route marked with ``@with_body_size``.  We can't
        import ``main.app`` directly here because the OCR handler pulls
        in optional deps, so we walk our local app instead.
        """
        async def handler(req: Request):
            return {"ok": True}

        decorated = with_body_size(64 * 1024 * 1024)(handler)
        app = _build_app_with_decoration(decorated)
        limits = app.state.route_body_limits
        assert limits, "expected at least one route registered"
        values = set(limits.values())
        assert 64 * 1024 * 1024 in values
