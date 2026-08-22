"""Tests for Issue #430: mandatory PII scrubbing on the humanitarian verification path.

The verification pipeline must scrub ``aid_claim`` / ``supporting_evidence`` /
``context_factors`` before any provider call, fail closed when scrubbing is
disabled or unavailable, expose the scrubbed/raw distinction in the response
envelope, and record aggregate audit metadata (never text).
"""

import pytest

from config import settings
from services.humanitarian_verification import HumanitarianVerificationService
from persistence.pii_decisions import PIIDecisionStore


class TestHumanitarianPIIscrubbing:
    def setup_method(self):
        self.service = HumanitarianVerificationService()

    def _capture_provider(self, monkeypatch, response=None):
        """Patch _call_provider to capture prompts; returns (calls, result)."""
        calls = []

        def fake_call_provider(
            provider, model, system_prompt, user_prompt, timeout=None
        ):
            calls.append(
                {
                    "provider": provider,
                    "system": system_prompt,
                    "user": user_prompt,
                }
            )
            if response is not None:
                return response
            return '{"verdict":"credible","confidence":0.9,"summary":"mocked"}'

        monkeypatch.setattr(settings, "openai_api_key", "test-key")
        monkeypatch.setattr(
            self.service, "_provider_attempt_order", lambda p: ["openai"]
        )
        monkeypatch.setattr(
            self.service, "_get_model_for_provider", lambda p: "test-model"
        )
        monkeypatch.setattr(self.service, "_call_provider", fake_call_provider)
        return calls

    def test_provider_payload_contains_no_raw_pii(self, monkeypatch):
        """AC: evidence with a name/phone/email reaches the provider only as
        masked tokens; the raw values never appear in the payload."""
        calls = self._capture_provider(monkeypatch)

        result = self.service.verify_claim(
            aid_claim="Mary Johnson requested emergency food aid.",
            supporting_evidence=[
                "Phone 08012345678 and email mary.johnson@example.com",
                "Interview held in Maiduguri Camp.",
            ],
            context_factors={"contact": "mary.johnson@example.com"},
            provider_preference="openai",
        )

        assert result["pii_scrubbing"]["applied"] is True
        assert result["pii_scrubbing"]["anonymized"] is True
        assert result["pii_scrubbing"]["pii_summary"]["total"] > 0

        assert len(calls) == 1
        prompt = calls[0]["user"]
        assert "[RECIPIENT_NAME]" in prompt
        assert "[PHONE_NUMBER]" in prompt
        assert "[EMAIL_ADDRESS]" in prompt
        assert "[LOCATION]" in prompt
        for raw in (
            "Mary",
            "Johnson",
            "08012345678",
            "mary.johnson@example.com",
            "Maiduguri",
        ):
            assert raw not in prompt, f"raw PII leaked into provider payload: {raw!r}"

    def test_verify_claim_preserves_non_pii_text(self, monkeypatch):
        """Scrubbing must not mangle evidence that contains no PII."""
        calls = self._capture_provider(monkeypatch)

        result = self.service.verify_claim(
            aid_claim="Relief teams delivered hygiene kits to all registered households in the affected region.",
            supporting_evidence=["Distribution list #B-17"],
            context_factors={"security_status": "stable"},
            provider_preference="openai",
        )

        assert result["pii_scrubbing"]["applied"] is True
        assert result["pii_scrubbing"]["anonymized"] is False
        assert result["pii_scrubbing"]["pii_summary"]["total"] == 0

        prompt = calls[0]["user"]
        assert "Relief teams delivered hygiene kits" in prompt
        assert "Distribution list #B-17" in prompt
        assert "security_status: stable" in prompt

    def test_fail_closed_when_scrubber_unavailable(self, monkeypatch):
        """AC: if scrubbing fails, the request is rejected and the provider is
        never called (no unredacted fallback)."""
        calls = self._capture_provider(monkeypatch)

        def boom(text):
            raise RuntimeError("spaCy model unavailable")

        monkeypatch.setattr(self.service.scrubber, "scrub_text", boom)

        with pytest.raises(RuntimeError, match="PII scrubbing failed"):
            self.service.verify_claim(
                aid_claim="Mary Johnson requested emergency food aid.",
                supporting_evidence=["Phone 08012345678"],
                context_factors={},
                provider_preference="openai",
            )

        assert calls == [], "provider must not be called when scrubbing fails"

    def test_fail_closed_when_scrubbing_disabled(self, monkeypatch):
        """AC: if scrubbing is disabled, the request is rejected rather than
        sent unredacted."""
        calls = self._capture_provider(monkeypatch)
        monkeypatch.setattr(settings, "pii_scrubbing_enabled", False)

        with pytest.raises(RuntimeError, match="PII scrubbing is disabled"):
            self.service.verify_claim(
                aid_claim="Mary Johnson requested emergency food aid.",
                supporting_evidence=["Phone 08012345678"],
                context_factors={},
                provider_preference="openai",
            )

        assert calls == [], "provider must not be called when scrubbing is disabled"

    def test_pii_decision_record_persisted_when_enabled(self, monkeypatch, tmp_path):
        """Emit aggregate scrub metadata into pii_decisions (never text)."""
        db_path = tmp_path / "pii.db"
        monkeypatch.setattr(settings, "pii_decisions_enabled", True)
        monkeypatch.setattr(settings, "pii_decisions_db_path", str(db_path))
        monkeypatch.setattr(settings, "test_provider_mode", True)
        monkeypatch.setattr(settings, "openai_api_key", None)
        monkeypatch.setattr(settings, "groq_api_key", None)

        store = PIIDecisionStore(str(db_path))
        store.initialize()

        result = self.service.verify_claim(
            aid_claim="Mary Johnson requested emergency food aid.",
            supporting_evidence=["Phone 08012345678"],
            context_factors={},
            provider_preference="auto",
        )

        assert result["provider"] == "test"
        assert result["pii_scrubbing"]["anonymized"] is True

        rows = store.get_recent_decisions()
        assert len(rows) == 1
        record = rows[0]
        assert record["pii_summary"]["total"] > 0
        assert record["pii_summary"]["names"] >= 1
        assert record["text_fingerprint"]
        assert record["model_version"] == "test-provider/fixture"
        # Aggregate-only guardrail: raw or anonymized text must never be stored.
        assert "anonymized_text" not in record
        assert "Mary" not in str(record)

    def test_pii_decision_not_recorded_when_disabled(self, monkeypatch, tmp_path):
        """Audit store stays untouched when pii_decisions_enabled is off."""
        db_path = tmp_path / "pii.db"
        monkeypatch.setattr(settings, "pii_decisions_enabled", False)
        monkeypatch.setattr(settings, "pii_decisions_db_path", str(db_path))
        monkeypatch.setattr(settings, "test_provider_mode", True)
        monkeypatch.setattr(settings, "openai_api_key", None)
        monkeypatch.setattr(settings, "groq_api_key", None)

        store = PIIDecisionStore(str(db_path))
        store.initialize()

        self.service.verify_claim(
            aid_claim="Mary Johnson requested emergency food aid.",
            supporting_evidence=["Phone 08012345678"],
            context_factors={},
            provider_preference="auto",
        )

        assert store.count() == 0

    def test_route_rejects_when_scrubbing_disabled(self, monkeypatch):
        """End-to-end: the /v1/ai/humanitarian/verify route surfaces the
        fail-closed rejection instead of sending unredacted evidence."""
        import main as _main

        calls = []
        monkeypatch.setattr(settings, "pii_scrubbing_enabled", False)
        monkeypatch.setattr(
            _main.humanitarian_verification_service,
            "_provider_attempt_order",
            lambda p: ["openai"],
        )
        monkeypatch.setattr(
            _main.humanitarian_verification_service,
            "_call_provider",
            lambda *a, **k: calls.append(a) or '{"verdict":"credible"}',
        )

        from fastapi.testclient import TestClient

        client = TestClient(_main.app)
        response = client.post(
            "/v1/ai/humanitarian/verify",
            json={
                "aid_claim": "Mary Johnson requested emergency food aid.",
                "supporting_evidence": ["Phone 08012345678"],
                "context_factors": {},
                "provider_preference": "openai",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is False
        assert "PII scrubbing is disabled" in data["error"]
        assert calls == [], "provider must not be called when scrubbing is disabled"
