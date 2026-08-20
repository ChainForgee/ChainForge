"""Humanitarian claim verification service with model/provider fallbacks."""

import hashlib
import json
import logging
from typing import Any, Dict, List, Optional, Tuple
import time
import metrics

import httpx

from config import settings
from services.humanitarian_prompt import HumanitarianPromptEngine
from services.circuit_breaker import CircuitBreaker
from services.pii_scrubber import PIIScrubberService
from services.test_provider import TestProvider
from exceptions import AIServiceError

logger = logging.getLogger(__name__)


class HumanitarianVerificationService:
    """Runs humanitarian verification against configured LLM providers."""

    _PII_SUMMARY_KEYS = ("names", "locations", "dates", "emails", "phones", "ids", "total")

    def __init__(self):
        self.prompt_engine = HumanitarianPromptEngine()
        self.test_provider = TestProvider()
        # Issue #430: the scrubber is a mandatory preprocessing stage, not an
        # optional endpoint. Raw recipient text must never reach a provider.
        self.scrubber = PIIScrubberService()
        self.breakers = {
            "openai": CircuitBreaker(
                name="openai",
                failure_threshold=settings.circuit_breaker_failure_threshold,
                recovery_timeout=settings.circuit_breaker_recovery_timeout_seconds,
            ),
            "groq": CircuitBreaker(
                name="groq",
                failure_threshold=settings.circuit_breaker_failure_threshold,
                recovery_timeout=settings.circuit_breaker_recovery_timeout_seconds,
            ),
        }

    def verify_claim(
        self,
        aid_claim: str,
        supporting_evidence: Optional[List[str]] = None,
        context_factors: Optional[Dict[str, Any]] = None,
        provider_preference: str = "auto",
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        start_time = time.time()
        try:
            evidence = supporting_evidence or []
            context = context_factors or {}

            # Issue #430: mandatory PII preprocessing before any provider
            # call. Only the scrubbed inputs ever reach prompt construction,
            # so raw recipient text cannot leave the trust boundary.
            scrubbed_claim, scrubbed_evidence, scrubbed_context, pii_summary, pii_token_counts = (
                self._scrub_inputs(aid_claim, evidence, context)
            )

            primary_prompt = self.prompt_engine.build_primary_prompt(
                aid_claim=scrubbed_claim,
                supporting_evidence=scrubbed_evidence,
                context_factors=scrubbed_context,
            )
            fallback_prompt = self.prompt_engine.build_fallback_prompt(
                aid_claim=scrubbed_claim,
                supporting_evidence=scrubbed_evidence,
                context_factors=scrubbed_context,
            )

            providers = self._provider_attempt_order(provider_preference)
            if not providers:
                raise RuntimeError("No LLM providers configured for humanitarian verification")

            errors: List[str] = []

            for provider in providers:
                breaker = self.breakers.get(provider)
                if breaker and not breaker.allow_request():
                    logger.warning("Circuit breaker is OPEN for provider=%s. Skipping.", provider)
                    errors.append(f"provider={provider}, error=Circuit breaker is OPEN")
                    continue

                model = self._get_model_for_provider(provider)
                for prompt_variant, prompt in (("primary", primary_prompt), ("fallback", fallback_prompt)):
                    try:
                        logger.info(
                            "Attempting humanitarian verification with provider=%s model=%s prompt=%s",
                            provider,
                            model,
                            prompt_variant,
                        )
                        raw_content = self._call_provider(
                            provider=provider,
                            model=model,
                            system_prompt=prompt["system"],
                            user_prompt=prompt["user"],
                            timeout=timeout,
                        )
                        parsed = parse_verification_response(provider, raw_content)
                        if breaker:
                            breaker.record_success()
                        # Aggregate-only audit record (counts + fingerprint,
                        # never text) so the redaction decision is traceable.
                        self._record_pii_decision(
                            raw_claim=aid_claim,
                            raw_evidence=evidence,
                            raw_context=context,
                            summary=pii_summary,
                            token_counts=pii_token_counts,
                            model=model,
                        )
                        return {
                            "provider": provider,
                            "model": model,
                            "prompt_variant": prompt_variant,
                            "verification": parsed,
                            "raw_response": raw_content,
                            "stamp": {
                                "provider": provider,
                                "model": model,
                                "prompt_variant": prompt_variant,
                            },
                            "pii_scrubbing": {
                                "applied": True,
                                "anonymized": pii_summary["total"] > 0,
                                "pii_summary": pii_summary,
                            },
                        }
                    except Exception as exc:
                        if breaker:
                            breaker.record_failure()
                        err = f"provider={provider}, model={model}, prompt={prompt_variant}, error={exc}"
                        errors.append(err)
                        logger.warning("Humanitarian verification attempt failed: %s", err)

            raise RuntimeError("All humanitarian verification attempts failed: " + " | ".join(errors))
        finally:
            latency = time.time() - start_time
            metrics.PIPELINE_STEP_LATENCY.labels(step_name='verify').observe(latency)

    def _scrub_inputs(
        self,
        aid_claim: str,
        evidence: List[str],
        context: Dict[str, Any],
    ) -> Tuple[str, List[str], Dict[str, Any], Dict[str, int], Dict[str, int]]:
        """Fail-closed PII preprocessing stage for the verification pipeline.

        Masks names/locations/dates/emails/phones/IDs in the claim, each
        evidence entry, and string-valued context factors *before* any prompt
        is built, so raw recipient text can never reach an external LLM
        provider. Raises when scrubbing is disabled or fails rather than
        silently forwarding unredacted text (Issue #430).

        Returns the scrubbed inputs plus aggregated ``pii_summary`` and
        ``token_counts`` for the response envelope and the audit store.
        """
        if not settings.pii_scrubbing_enabled:
            raise RuntimeError(
                "PII scrubbing is disabled (PII_SCRUBBING_ENABLED=false); "
                "refusing to send unredacted evidence to an external LLM provider"
            )

        summary: Dict[str, int] = {key: 0 for key in self._PII_SUMMARY_KEYS}
        token_counts: Dict[str, int] = {}

        try:
            scrubbed_claim, field_summary, field_tokens = self._scrub_field(aid_claim)
            self._merge_scrub_stats(summary, token_counts, field_summary, field_tokens)

            scrubbed_evidence: List[str] = []
            for entry in evidence:
                scrubbed, field_summary, field_tokens = self._scrub_field(entry)
                scrubbed_evidence.append(scrubbed)
                self._merge_scrub_stats(summary, token_counts, field_summary, field_tokens)

            scrubbed_context: Dict[str, Any] = {}
            for key, value in context.items():
                if isinstance(value, str):
                    scrubbed, field_summary, field_tokens = self._scrub_field(value)
                    scrubbed_context[key] = scrubbed
                    self._merge_scrub_stats(summary, token_counts, field_summary, field_tokens)
                else:
                    scrubbed_context[key] = value
        except Exception as exc:
            raise RuntimeError(
                f"PII scrubbing failed ({exc}); refusing to send unredacted "
                "evidence to an external LLM provider"
            ) from exc

        return scrubbed_claim, scrubbed_evidence, scrubbed_context, summary, token_counts

    def _scrub_field(self, text: str) -> Tuple[str, Dict[str, int], Dict[str, int]]:
        """Scrub one free-text field; returns (masked, summary, token_counts)."""
        result = self.scrubber.scrub_text(text)
        return (
            result["anonymized_text"],
            result["pii_summary"],
            result["token_counts"],
        )

    def _merge_scrub_stats(
        self,
        summary: Dict[str, int],
        token_counts: Dict[str, int],
        field_summary: Dict[str, int],
        field_tokens: Dict[str, int],
    ) -> None:
        """Aggregate one field's scrub summary/token counts into the totals."""
        for key in self._PII_SUMMARY_KEYS:
            summary[key] += field_summary.get(key, 0)
        for token, count in (field_tokens or {}).items():
            token_counts[token] = token_counts.get(token, 0) + count

    def _record_pii_decision(
        self,
        raw_claim: str,
        raw_evidence: List[str],
        raw_context: Dict[str, Any],
        summary: Dict[str, int],
        token_counts: Dict[str, int],
        model: str,
    ) -> None:
        """Persist aggregate scrub metadata (never text) when enabled.

        Mirrors the /v1/ai/anonymize audit path: aggregate counts plus a
        non-reversible SHA-256 fingerprint of the concatenated inputs.
        Failures are logged, never raised, so an audit hiccup can't break a
        verification.
        """
        try:
            if not settings.pii_decisions_enabled:
                return
            from persistence.pii_decisions import (
                PIIDecisionRecord,
                PIIDecisionStore,
                new_record_id,
            )

            raw_text = (
                raw_claim
                + "\n"
                + "\n".join(raw_evidence)
                + "\n"
                + json.dumps(raw_context, sort_keys=True)
            )
            record = PIIDecisionRecord(
                id=new_record_id(),
                created_at=time.time(),
                original_length=len(raw_text),
                pii_summary=summary,
                token_counts=token_counts,
                text_fingerprint=hashlib.sha256(raw_text.encode("utf-8")).hexdigest(),
                model_version=model,
            )
            PIIDecisionStore(settings.pii_decisions_db_path).save_decision(
                record,
                settings.pii_decisions_retention_days,
            )
            logger.info(
                "stored pii_decision id=%s total=%d",
                record.id,
                summary.get("total", 0),
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.error("pii_decision persistence failed: %s", exc)

    def _provider_attempt_order(self, provider_preference: str) -> List[str]:
        available: List[str] = []
        if settings.test_provider_mode:
            available.append("test")
        if settings.openai_api_key:
            available.append("openai")
        if settings.groq_api_key:
            available.append("groq")

        preference = (provider_preference or "auto").lower()
        if preference == "test" and settings.test_provider_mode:
            return [preference]
        if preference in ("openai", "groq", "test") and preference in available:
            return [preference] + [provider for provider in available if provider != preference]
        return available

    def _get_model_for_provider(self, provider: str) -> str:
        if provider == "test":
            return "test-provider/fixture"
        if provider == "openai":
            return settings.openai_model
        if provider == "groq":
            return settings.groq_model
        raise ValueError(f"Unsupported provider: {provider}")

    def _call_provider(
        self,
        provider: str,
        model: str,
        system_prompt: str,
        user_prompt: str,
        timeout: Optional[float] = None,
    ) -> str:
        if provider == "test":
            return self._call_test(model, system_prompt, user_prompt)
        if provider == "openai":
            return self._call_openai(model, system_prompt, user_prompt, timeout)
        if provider == "groq":
            return self._call_groq(model, system_prompt, user_prompt, timeout)
        raise ValueError(f"Unsupported provider: {provider}")

    def _call_openai(
        self,
        model: str,
        system_prompt: str,
        user_prompt: str,
        timeout: Optional[float] = None,
    ) -> str:
        if not settings.openai_api_key:
            raise RuntimeError("OpenAI API key is not configured")
        return self._call_chat_completion_api(
            base_url="https://api.openai.com/v1/chat/completions",
            api_key=settings.openai_api_key,
            model=model,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            timeout=timeout,
        )

    def _call_groq(
        self,
        model: str,
        system_prompt: str,
        user_prompt: str,
        timeout: Optional[float] = None,
    ) -> str:
        if not settings.groq_api_key:
            raise RuntimeError("Groq API key is not configured")
        return self._call_chat_completion_api(
            base_url="https://api.groq.com/openai/v1/chat/completions",
            api_key=settings.groq_api_key,
            model=model,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            timeout=timeout,
        )

    def _call_chat_completion_api(
        self,
        base_url: str,
        api_key: str,
        model: str,
        system_prompt: str,
        user_prompt: str,
        timeout: Optional[float] = None,
    ) -> str:
        if settings.ai_deterministic_mode:
            logger.info("Deterministic AI mode enabled: returning stable response")
            return self._get_deterministic_response(model, system_prompt, user_prompt)

        payload = {
            "model": model,
            "temperature": 0.1,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        }
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        req_timeout = timeout if timeout is not None else float(settings.llm_timeout_seconds)
        provider_name = "openai" if "openai" in base_url else "groq"

        try:
            with httpx.Client(timeout=req_timeout) as client:
                response = client.post(base_url, json=payload, headers=headers)
                response.raise_for_status()
                data = response.json()
        except httpx.TimeoutException as exc:
            logger.error("LLM provider %s request timed out after %s seconds", provider_name, req_timeout)
            raise AIServiceError(
                message=f"LLM request timed out after {req_timeout}s",
                code="AI_TIMEOUT",
                details={"provider": provider_name, "timeout_seconds": req_timeout},
            ) from exc
        except httpx.HTTPStatusError as exc:
            logger.error("LLM provider %s returned status %s: %s", provider_name, exc.response.status_code, exc.response.text)
            raise AIServiceError(
                message=f"LLM request failed with status {exc.response.status_code}",
                code="AI_PROVIDER_ERROR",
                details={"provider": provider_name, "status_code": exc.response.status_code},
            ) from exc
        except Exception as exc:
            logger.error("LLM provider %s connection or unexpected error: %s", provider_name, str(exc))
            raise AIServiceError(
                message=f"LLM connection error: {str(exc)}",
                code="AI_CONNECTION_ERROR",
                details={"provider": provider_name},
            ) from exc

        try:
            content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise RuntimeError(f"Unexpected LLM response format: {data}") from exc

        if not content:
            raise RuntimeError("LLM returned empty content")

        return str(content)

    def _call_test(self, model: str, system_prompt: str, user_prompt: str) -> str:
        response = self.test_provider.get_response(
            endpoint="humanitarian",
            request_data={
                "system_prompt": system_prompt,
                "user_prompt": user_prompt,
            },
        )
        return json.dumps(response, separators=(",", ":"), sort_keys=True)

    def _get_deterministic_response(self, model: str, system_prompt: str, user_prompt: str) -> str:
        stable_response = {
            "verdict": "credible",
            "confidence": 0.74,
            "summary": "Deterministic verification output for testing",
        }
        return json.dumps(stable_response, separators=(",", ":"), sort_keys=True)

    def _parse_json_response(self, content: str) -> Dict[str, Any]:
        return parse_verification_response("auto", content)


def parse_verification_response(provider_name: str, raw_content: str) -> Dict[str, Any]:
    """Parses raw verification response, handling JSON markdown blocks and potential truncations."""
    normalized = raw_content.strip()
    if normalized.startswith("```"):
        normalized = normalized.strip("`")
        if normalized.startswith("json"):
            normalized = normalized[4:].strip()

    try:
        parsed = json.loads(normalized)
        if isinstance(parsed, dict):
            return _normalize_verification_dict(parsed)
    except json.JSONDecodeError:
        pass

    # Recovery parsing in case of truncation
    import re
    verdict_match = re.search(r'"verdict"\s*:\s*"([^"]+)"', normalized)
    confidence_match = re.search(r'"confidence"\s*:\s*([0-9.]+)', normalized)
    summary_match = re.search(r'"summary"\s*:\s*"([^"]*)"', normalized)

    verdict = verdict_match.group(1) if verdict_match else "inconclusive"
    confidence = float(confidence_match.group(1)) if confidence_match else 0.0
    summary = summary_match.group(1) if summary_match else "Truncated response parsed via recovery"

    if verdict not in ["credible", "partially_credible", "inconclusive", "not_credible"]:
        verdict = "inconclusive"

    return {
        "verdict": verdict,
        "confidence": confidence,
        "summary": summary,
        "criteria_assessment": None,
        "risk_flags": None,
        "missing_information": None,
        "recommended_next_steps": None,
    }


def _normalize_verification_dict(parsed: Dict[str, Any]) -> Dict[str, Any]:
    """Ensures a parsed dict strictly matches HumanitarianVerificationDetailsV2 structure."""
    verdict = parsed.get("verdict", "inconclusive")
    if verdict not in ["credible", "partially_credible", "inconclusive", "not_credible"]:
        verdict = "inconclusive"

    confidence = parsed.get("confidence", 0.0)
    try:
        confidence = float(confidence)
    except (ValueError, TypeError):
        confidence = 0.0

    return {
        "verdict": verdict,
        "confidence": confidence,
        "summary": str(parsed.get("summary", "")),
        "criteria_assessment": parsed.get("criteria_assessment"),
        "risk_flags": parsed.get("risk_flags"),
        "missing_information": parsed.get("missing_information"),
        "recommended_next_steps": parsed.get("recommended_next_steps"),
    }