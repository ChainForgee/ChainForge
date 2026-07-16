import os
import pytest
from unittest.mock import patch, MagicMock
from config import settings
from services.humanitarian_verification import HumanitarianVerificationService
from tracing.otel_setup import (
    reset_tracing_for_test,
    get_in_memory_exporter,
)

class TestOtelSpans:
    @pytest.fixture(autouse=True)
    def setup_otel(self, monkeypatch):
        # Force app env to test to register InMemorySpanExporter
        monkeypatch.setenv("APP_ENV", "test")
        monkeypatch.setattr(settings, "openai_api_key", "test-openai-key")
        monkeypatch.setattr(settings, "groq_api_key", "test-groq-key")
        reset_tracing_for_test()
        
        self.exporter = get_in_memory_exporter()
        if self.exporter:
            self.exporter.clear()

    def test_verify_claim_emits_two_spans_openai(self, monkeypatch):
        service = HumanitarianVerificationService()
        
        # Mock _call_chat_completion_api to avoid making real network requests
        mock_response = '{"verdict": "credible", "confidence": 0.95, "summary": "verified"}'
        monkeypatch.setattr(
            service,
            "_call_chat_completion_api",
            lambda *args, **kwargs: mock_response
        )
        
        # Ensure we only try to call openai
        monkeypatch.setattr(service, "_provider_attempt_order", lambda pref: ["openai"])
        monkeypatch.setattr(service, "_get_model_for_provider", lambda prov: "gpt-4-test")
        
        # Trigger claim verification
        result = service.verify_claim(
            aid_claim="Food packs delivered to flood zone.",
            supporting_evidence=["waybill-102"],
            context_factors={"weather": "clear"},
            provider_preference="openai"
        )
        
        assert result["provider"] == "openai"
        assert result["prompt_variant"] == "primary"
        
        # Verify tracing spans
        finished_spans = self.exporter.get_finished_spans()
        assert len(finished_spans) == 2, f"Expected 2 spans, got {len(finished_spans)}"
        
        # Spans are emitted as they finish:
        # call_openai is nested inside call_provider, so call_openai finishes first!
        span_openai = finished_spans[0]
        span_provider = finished_spans[1]
        
        assert span_openai.name == "humanitarian_verification.call_openai"
        assert span_openai.attributes.get("model") == "gpt-4-test"
        assert span_openai.attributes.get("prompt_variant") == "primary"
        
        assert span_provider.name == "humanitarian_verification.call_provider"
        assert span_provider.attributes.get("model") == "gpt-4-test"
        assert span_provider.attributes.get("prompt_variant") == "primary"

    def test_verify_claim_emits_two_spans_groq(self, monkeypatch):
        service = HumanitarianVerificationService()
        
        # Mock _call_chat_completion_api to avoid making real network requests
        mock_response = '{"verdict": "not_credible", "confidence": 0.85, "summary": "no evidence"}'
        monkeypatch.setattr(
            service,
            "_call_chat_completion_api",
            lambda *args, **kwargs: mock_response
        )
        
        # Ensure we only try to call groq
        monkeypatch.setattr(service, "_provider_attempt_order", lambda pref: ["groq"])
        monkeypatch.setattr(service, "_get_model_for_provider", lambda prov: "llama3-groq-test")
        
        # Trigger claim verification
        result = service.verify_claim(
            aid_claim="Medicines delivered to shelter.",
            supporting_evidence=["receipt-44"],
            context_factors={"region": "north"},
            provider_preference="groq"
        )
        
        assert result["provider"] == "groq"
        assert result["prompt_variant"] == "primary"
        
        # Verify tracing spans
        finished_spans = self.exporter.get_finished_spans()
        assert len(finished_spans) == 2, f"Expected 2 spans, got {len(finished_spans)}"
        
        span_groq = finished_spans[0]
        span_provider = finished_spans[1]
        
        assert span_groq.name == "humanitarian_verification.call_groq"
        assert span_groq.attributes.get("model") == "llama3-groq-test"
        assert span_groq.attributes.get("prompt_variant") == "primary"
        
        assert span_provider.name == "humanitarian_verification.call_provider"
        assert span_provider.attributes.get("model") == "llama3-groq-test"
        assert span_provider.attributes.get("prompt_variant") == "primary"
