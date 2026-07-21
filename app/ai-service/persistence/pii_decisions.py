"""SQLite-backed persistence for PII scrubber decisions.

Stores **aggregate** metadata only — never raw or anonymized source text —
so the audit trail can answer "we redacted N PII entities from a document
of length L" without ever reconstructing the redacted content.

A periodic sweeper prunes rows older than ``pii_decisions_retention_days``
(default 30) so the table cannot grow unbounded.

The module deliberately has no imports from ``config``, ``main``, or any
service module — it is a self-contained leaf so it can be exercised in
isolation and reused by future API endpoints.

Threading note
--------------
``sqlite3`` connections are not safe to share across threads by default.
``PIIDecisionStore`` opens a fresh connection per call (a few microseconds)
and disables ``check_same_thread`` for the per-call connection so that
``BackgroundTasks`` / threadpool workers can call it freely.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from dataclasses import dataclass, asdict, field
from typing import Any, Dict, List, Optional


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS pii_decisions (
    id                  TEXT PRIMARY KEY,
    created_at          REAL NOT NULL,
    retention_after     REAL NOT NULL,
    original_length     INTEGER NOT NULL,
    total_pii_entities  INTEGER NOT NULL,
    names               INTEGER NOT NULL,
    locations           INTEGER NOT NULL,
    dates               INTEGER NOT NULL,
    emails              INTEGER NOT NULL,
    phones              INTEGER NOT NULL,
    ids                 INTEGER NOT NULL,
    token_counts_json   TEXT NOT NULL,
    text_fingerprint    TEXT NOT NULL,
    model_version       TEXT
);

CREATE INDEX IF NOT EXISTS idx_pii_decisions_created_at
    ON pii_decisions (created_at);

CREATE INDEX IF NOT EXISTS idx_pii_decisions_retention_after
    ON pii_decisions (retention_after);
"""


@dataclass
class PIIDecisionRecord:
    """An aggregate audit record describing redacted PII in a document.

    Raw/anonymized text is *never* stored.  ``text_fingerprint`` is a
    non-reversible SHA-256 hex digest so duplicate redact audits can be
    detected without rehydrating any text.
    """

    id: str
    created_at: float
    original_length: int
    pii_summary: Dict[str, int]
    token_counts: Dict[str, int] = field(default_factory=dict)
    text_fingerprint: str = ""
    model_version: Optional[str] = None

    def to_row(self, retention_days: int) -> Dict[str, Any]:
        """Flatten to a SQLite row keyed by column name.

        ``retention_after`` is stored explicitly so the periodic sweeper
        can filter with a simple index scan instead of computing
        ``created_at + retention_days`` on the fly.
        """
        retention_after = self.created_at + retention_days * 86400.0
        names = self.pii_summary.get("names", 0)
        locations = self.pii_summary.get("locations", 0)
        dates = self.pii_summary.get("dates", 0)
        emails = self.pii_summary.get("emails", 0)
        phones = self.pii_summary.get("phones", 0)
        ids = self.pii_summary.get("ids", 0)
        return {
            "id": self.id,
            "created_at": self.created_at,
            "retention_after": retention_after,
            "original_length": self.original_length,
            "total_pii_entities": self.pii_summary.get("total", 0),
            "names": names,
            "locations": locations,
            "dates": dates,
            "emails": emails,
            "phones": phones,
            "ids": ids,
            "token_counts_json": json.dumps(self.token_counts, sort_keys=True),
            "text_fingerprint": self.text_fingerprint,
            "model_version": self.model_version,
        }


class PIIDecisionStore:
    """A tiny SQLite-backed store for PII decision audit records.

    Why SQLite?  The AI service is a self-contained FastAPI app.  Adding
    Postgres or another service dependency for an audit log of five
    integers per document would be overkill.  SQLite ships with the
    standard library, supports WAL-mode for concurrent reads, and is
    perfectly happy with a few thousand rows per day.
    """

    def __init__(self, db_path: str) -> None:
        self.db_path = db_path

    # ------------------------------------------------------------------
    # Schema management
    # ------------------------------------------------------------------

    def _connect(self) -> sqlite3.Connection:
        parent = os.path.dirname(os.path.abspath(self.db_path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        conn = sqlite3.connect(
            self.db_path,
            check_same_thread=False,
            timeout=5.0,
        )
        # WAL keeps writes off the read path so the auditor GET endpoint
        # never blocks the BackgroundTasks writer.
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    def initialize(self) -> None:
        """Create the schema if it doesn't already exist.

        Safe to call on every startup; idempotent.
        """
        with self._connect() as conn:
            conn.executescript(SCHEMA_SQL)
            conn.commit()

    # ------------------------------------------------------------------
    # Write path
    # ------------------------------------------------------------------

    def save_decision(
        self,
        record: PIIDecisionRecord,
        retention_days: int,
    ) -> None:
        """Persist a single decision record.

        ``retention_days`` is captured at write time so that snapshotting
        different windows in time is a single ``retention_after`` filter.
        """
        if retention_days < 0:
            raise ValueError("retention_days must be non-negative")

        row = record.to_row(retention_days)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO pii_decisions (
                    id,
                    created_at,
                    retention_after,
                    original_length,
                    total_pii_entities,
                    names,
                    locations,
                    dates,
                    emails,
                    phones,
                    ids,
                    token_counts_json,
                    text_fingerprint,
                    model_version
                )
                VALUES (
                    :id,
                    :created_at,
                    :retention_after,
                    :original_length,
                    :total_pii_entities,
                    :names,
                    :locations,
                    :dates,
                    :emails,
                    :phones,
                    :ids,
                    :token_counts_json,
                    :text_fingerprint,
                    :model_version
                )
                """,
                row,
            )
            conn.commit()

    # ------------------------------------------------------------------
    # Read path
    # ------------------------------------------------------------------

    def get_recent_decisions(
        self,
        limit: int = 100,
        now: Optional[float] = None,
    ) -> List[Dict[str, Any]]:
        """Return up to ``limit`` decisions ordered newest-first.

        Rows whose ``retention_after`` is in the past are filtered out so
        auditors only see rows still within the retention window, even
        before the sweeper has had a chance to purge them.
        """
        if limit <= 0:
            return []
        now = now if now is not None else time.time()
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            cur = conn.execute(
                """
                SELECT
                    id,
                    created_at,
                    retention_after,
                    original_length,
                    total_pii_entities,
                    names,
                    locations,
                    dates,
                    emails,
                    phones,
                    ids,
                    token_counts_json,
                    text_fingerprint,
                    model_version
                FROM pii_decisions
                WHERE retention_after > ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (now, limit),
            )
            rows = cur.fetchall()

        out: List[Dict[str, Any]] = []
        for r in rows:
            token_counts = json.loads(r["token_counts_json"])
            out.append(
                {
                    "id": r["id"],
                    "created_at": r["created_at"],
                    "original_length": r["original_length"],
                    "pii_summary": {
                        "names": r["names"],
                        "locations": r["locations"],
                        "dates": r["dates"],
                        "emails": r["emails"],
                        "phones": r["phones"],
                        "ids": r["ids"],
                        "total": r["total_pii_entities"],
                    },
                    "token_counts": token_counts,
                    "text_fingerprint": r["text_fingerprint"],
                    "model_version": r["model_version"],
                }
            )
        return out

    # ------------------------------------------------------------------
    # Retention
    # ------------------------------------------------------------------

    def sweep_expired_decisions(
        self,
        now: Optional[float] = None,
    ) -> int:
        """Delete rows whose ``retention_after`` has passed.

        Returns the number of rows removed so callers (and tests) can
        assert that the sweeper actually did work.  Uses
        ``retention_after`` (not ``created_at``) so that a record written
        under a 90-day retention policy isn't pruned until day 91 even
        if the config later drops to 30.
        """
        now = now if now is not None else time.time()
        with self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM pii_decisions WHERE retention_after <= ?",
                (now,),
            )
            removed = cur.rowcount
            conn.commit()
        return removed

    def count(self) -> int:
        """Total rows currently in the store (debug / test helper)."""
        with self._connect() as conn:
            cur = conn.execute("SELECT COUNT(*) FROM pii_decisions")
            return int(cur.fetchone()[0])


def new_record_id() -> str:
    """Return a fresh UUID4 string for the record primary key."""
    return str(uuid.uuid4())
