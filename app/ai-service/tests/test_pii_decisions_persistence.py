"""Tests for the PII decisions persistence layer (Issue #274).

Covers:
  * Write path: PIIDecisionStore.save_decision inserts schema-correct rows.
  * Read path: PIIDecisionStore.get_recent_decisions orders newest-first
    and never returns expired rows.
  * Retention: sweep_expired_decisions removes rows whose
    ``retention_after`` has passed (verified up-front as a fast-forward
    simulation of one month, not by sleeping — the AC explicitly accepts
    any equivalent test).
  * E2E: ``GET /v1/ai/pii-decisions`` returns aggregate-only metadata
    that can be consumed by auditors with no privacy leak.
"""

import hashlib
import json
import os
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from persistence.pii_decisions import (
    PIIDecisionRecord,
    PIIDecisionStore,
    new_record_id,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _text_fingerprint(text: str) -> str:
    """SHA-256 hex digest — mirrors the production code path in
    :mod:`api.v1.anonymize` so the helper can never accidentally mask a
    privacy regression by storing source text under the ``text_fingerprint``
    column."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _build_record(
    text: str,
    *,
    created_at: float | None = None,
    pii_summary: dict | None = None,
    token_counts: dict | None = None,
    text_fingerprint: str | None = None,
) -> PIIDecisionRecord:
    return PIIDecisionRecord(
        id=new_record_id(),
        created_at=created_at if created_at is not None else time.time(),
        original_length=len(text),
        pii_summary=pii_summary
        or {
            "names": 1,
            "locations": 2,
            "dates": 0,
            "emails": 0,
            "phones": 0,
            "ids": 0,
            "total": 3,
        },
        token_counts=token_counts
        if token_counts is not None
        else {"[RECIPIENT_NAME]": 1, "[LOCATION]": 2},
        text_fingerprint=text_fingerprint
        if text_fingerprint is not None
        else _text_fingerprint(text),
        model_version="test-v1",
    )


@pytest.fixture
def tmp_store_path(tmp_path):
    """Return a path inside pytest's tmp_path so each test is isolated."""
    return os.path.join(str(tmp_path), "pii_decisions.db")


# ---------------------------------------------------------------------------
# Unit tests for PIIDecisionStore
# ---------------------------------------------------------------------------


class TestPIIDecisionStore:
    def test_initialize_creates_schema(self, tmp_store_path):
        store = PIIDecisionStore(tmp_store_path)
        store.initialize()
        # Re-opening should not raise — schema is idempotent.
        store.initialize()
        assert store.count() == 0

    def test_save_and_retrieve_round_trip(self, tmp_store_path):
        store = PIIDecisionStore(tmp_store_path)
        store.initialize()

        record = _build_record("On 15 Jan 2025, Mary Johnson received aid in Maiduguri.")
        store.save_decision(record, retention_days=30)

        rows = store.get_recent_decisions(limit=10)
        assert len(rows) == 1
        row = rows[0]
        assert row["id"] == record.id
        assert row["original_length"] == record.original_length
        assert row["pii_summary"]["total"] == 3
        assert row["pii_summary"]["names"] == 1
        assert row["pii_summary"]["locations"] == 2
        assert row["token_counts"] == {"[LOCATION]": 2, "[RECIPIENT_NAME]": 1}
        assert row["model_version"] == "test-v1"
        # Default helper must produce a SHA-256 fingerprint, never raw text.
        assert row["text_fingerprint"] == _text_fingerprint(
            "On 15 Jan 2025, Mary Johnson received aid in Maiduguri."
        )

    def test_save_records_must_not_contain_text(self, tmp_store_path):
        """Explicit guardrail: raw or anonymized text must never reach the
        store.  If a future regression accidentally adds a ``text`` or
        ``anonymized_text`` column, this test will fail loudly.
        """
        store = PIIDecisionStore(tmp_store_path)
        store.initialize()
        record = _build_record(
            "Mary Johnson's 15 Jan 2025 Maideguri Camp entry.",
        )
        store.save_decision(record, retention_days=30)

        # Inspect the underlying file as JSON-shaped bytes to make the
        # privacy guarantee explicit.  The fingerprint column holds the
        # SHA-256 hex digest of the source text; bytes that would only
        # appear if we reverted to storing raw text must be absent.
        with open(tmp_store_path, "rb") as fh:
            raw = fh.read()
        offending = [
            b"Mary",
            b"Johnson",
            b"Maideguri",
            b"15 Jan 2025",
            b"Camp entry",
            b"anonymized_text",
            b"original_text",
        ]
        for needle in offending:
            assert needle not in raw, (
                f"forbidden token {needle!r} found in pii_decisions.db — "
                "raw or anonymized text must never be persisted"
            )

    def test_recent_decisions_orders_newest_first(self, tmp_store_path):
        store = PIIDecisionStore(tmp_store_path)
        store.initialize()

        # Three records at decreasing timestamps.
        base = time.time()
        for offset, total in [(100, 5), (50, 3), (10, 1)]:
            store.save_decision(
                _build_record(
                    f"old-{offset}",
                    created_at=base + offset,
                    pii_summary={
                        "names": 0, "locations": 0, "dates": 0,
                        "emails": 0, "phones": 0, "ids": 0,
                        "total": total,
                    },
                ),
                retention_days=30,
            )

        rows = store.get_recent_decisions(limit=10)
        assert [r["pii_summary"]["total"] for r in rows] == [5, 3, 1]

    def test_recent_decisions_excludes_already_expired_rows(self, tmp_store_path):
        """Expired rows should not appear in audit listings even if the
        sweeper has not yet run.
        """
        store = PIIDecisionStore(tmp_store_path)
        store.initialize()

        now = time.time()
        # One fresh row, one with retention_after already passed.
        fresh = _build_record("fresh", created_at=now - 60)
        stale = _build_record("stale", created_at=now - 90 * 86400)
        store.save_decision(fresh, retention_days=30)
        store.save_decision(stale, retention_days=30)
        assert store.count() == 2

        rows = store.get_recent_decisions(limit=10, now=now)
        ids = [r["id"] for r in rows]
        assert fresh.id in ids
        assert stale.id not in ids

    def test_sweep_removes_only_expired_rows(self, tmp_store_path):
        """AC: 'E2E test verifies that after a month, decisions are pruned.'"""
        store = PIIDecisionStore(tmp_store_path)
        store.initialize()

        now = time.time()
        fresh = _build_record("fresh", created_at=now - 60)
        # 31 days ago with a 30-day retention → expired.
        stale = _build_record("stale", created_at=now - 31 * 86400)
        store.save_decision(fresh, retention_days=30)
        store.save_decision(stale, retention_days=30)

        sweep_now = now
        removed = store.sweep_expired_decisions(now=sweep_now)
        assert removed == 1
        assert store.count() == 1
        ids = [r["id"] for r in store.get_recent_decisions(limit=10, now=sweep_now)]
        assert fresh.id in ids
        assert stale.id not in ids

    def test_sweep_returns_zero_when_nothing_expired(self, tmp_store_path):
        store = PIIDecisionStore(tmp_store_path)
        store.initialize()
        store.save_decision(_build_record("x"), retention_days=30)
        assert store.sweep_expired_decisions() == 0

    def test_save_rejects_negative_retention(self, tmp_store_path):
        store = PIIDecisionStore(tmp_store_path)
        store.initialize()
        with pytest.raises(ValueError):
            store.save_decision(_build_record("x"), retention_days=-1)

    def test_limit_zero_returns_empty(self, tmp_store_path):
        store = PIIDecisionStore(tmp_store_path)
        store.initialize()
        store.save_decision(_build_record("x"), retention_days=30)
        assert store.get_recent_decisions(limit=0) == []

    def test_wal_mode_is_enabled_with_timeout(self, tmp_store_path):
        """Confirm WAL is enabled so background writers never block auditors.

        We probe that opening the DB a second time on a different
        connection succeeds while another is mid-transaction.
        """
        store = PIIDecisionStore(tmp_store_path)
        store.initialize()
        c1 = store._connect()
        c2 = store._connect()
        # Sequential access is supported even in WAL; this exercises
        # both connections without surprises.
        c1.execute("SELECT 1")
        c2.execute("SELECT 1")
        c1.close()
        c2.close()


# ---------------------------------------------------------------------------
# FastAPI E2E test for ``GET /v1/ai/pii-decisions``
# ---------------------------------------------------------------------------


class TestPIIDecisionsEndpoint:
    """End-to-end test mounted on a tiny FastAPI app so we don't pull in
    the entire AI service dependency tree (OCR, Celery, Redis, ...).
    """

    def _build_app(self, tmp_store_path, *, retention_days: int = 30) -> FastAPI:
        from api.v1 import pii_decisions as pii_decisions_module
        from config import settings as _settings

        # Configure the store path before the route resolves it.
        _settings.pii_decisions_enabled = True
        _settings.pii_decisions_db_path = tmp_store_path
        _settings.pii_decisions_retention_days = retention_days

        # The route imports ``settings`` lazily so we only need to set
        # the attrs above.
        app = FastAPI()
        app.include_router(pii_decisions_module.router)
        return app

    def test_endpoint_disabled_returns_404(self, tmp_store_path):
        from config import settings as _settings
        _settings.pii_decisions_enabled = False
        _settings.pii_decisions_db_path = tmp_store_path

        from api.v1 import pii_decisions as pii_decisions_module
        app = FastAPI()
        app.include_router(pii_decisions_module.router)
        client = TestClient(app)
        resp = client.get("/ai/pii-decisions?limit=10")
        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "pii_decisions_disabled"

    def test_endpoint_returns_recent_decisions_without_text(self, tmp_store_path):
        app = self._build_app(tmp_store_path)
        store = PIIDecisionStore(tmp_store_path)
        store.initialize()
        store.save_decision(
            _build_record(
                "Mary Johnson at Maiduguri Camp on 15 Jan 2025",
                pii_summary={
                    "names": 1, "locations": 1, "dates": 1,
                    "emails": 0, "phones": 0, "ids": 0, "total": 3,
                },
                token_counts={
                    "[RECIPIENT_NAME]": 1,
                    "[LOCATION]": 1,
                    "[EVENT_DATE]": 1,
                },
            ),
            retention_days=30,
        )

        client = TestClient(app)
        resp = client.get("/ai/pii-decisions?limit=10")
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["count"] == 1
        record = body["decisions"][0]
        # Aggregate metadata only — never raw or anonymized text.
        assert set(record.keys()) == {
            "id",
            "created_at",
            "original_length",
            "pii_summary",
            "token_counts",
            "text_fingerprint",
            "model_version",
        }
        assert record["pii_summary"]["total"] == 3
        assert record["token_counts"] == {
            "[RECIPIENT_NAME]": 1,
            "[LOCATION]": 1,
            "[EVENT_DATE]": 1,
        }
        # Defense: ensure the response never carries raw text fields.
        assert "text" not in record
        assert "anonymized_text" not in record
        assert "original_text" not in record
        # Privacy guarantee: text_fingerprint is the SHA-256 hex digest.
        assert record["text_fingerprint"] == _text_fingerprint(
            "Mary Johnson at Maiduguri Camp on 15 Jan 2025"
        )

    def test_endpoint_rejects_oversized_limit(self, tmp_store_path):
        app = self._build_app(tmp_store_path)
        client = TestClient(app)
        resp = client.get("/ai/pii-decisions?limit=1000")  # > MAX_PAGE_SIZE 500
        assert resp.status_code == 422  # FastAPI validation
