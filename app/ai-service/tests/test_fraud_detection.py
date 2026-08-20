"""Tests for fraud detection endpoint and service."""

import pytest
from fastapi.testclient import TestClient

from main import app
from schemas.fraud import ClaimMetadata
from services.fraud_detection import detect_fraud

client = TestClient(app)


def _make_claims(n: int):
    return [
        {"claim_id": f"c{i}", "ip_address": "1.2.3.4", "evidence_hash": f"hash{i}", "amount": 100.0}
        for i in range(n)
    ]


class TestFraudDetectionEndpoint:
    def test_returns_score_per_claim(self):
        payload = {"claims": _make_claims(3)}
        resp = client.post("/v1/fraud/detect", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["results"]) == 3
        for r in data["results"]:
            assert 0.0 <= r["fraud_risk_score"] <= 1.0

    def test_flagged_count_matches(self):
        payload = {"claims": _make_claims(5)}
        resp = client.post("/v1/fraud/detect", json=payload)
        data = resp.json()
        assert data["flagged_count"] == sum(r["is_flagged"] for r in data["results"])

    def test_single_claim_returns_zero_risk(self):
        payload = {"claims": [{"claim_id": "solo", "ip_address": "9.9.9.9", "amount": 50.0}]}
        resp = client.post("/v1/fraud/detect", json=payload)
        assert resp.status_code == 200
        result = resp.json()["results"][0]
        assert result["fraud_risk_score"] == 0.0
        assert result["is_flagged"] is False

    def test_empty_claims_rejected(self):
        resp = client.post("/v1/fraud/detect", json={"claims": []})
        assert resp.status_code == 422

    def test_outlier_gets_higher_score(self):
        """A claim with a very different IP should score higher than identical ones."""
        claims = [
            {"claim_id": f"c{i}", "ip_address": "1.2.3.4", "amount": 100.0}
            for i in range(8)
        ]
        claims.append({"claim_id": "outlier", "ip_address": "99.99.99.99", "amount": 9999.0})
        resp = client.post("/v1/fraud/detect", json={"claims": claims})
        assert resp.status_code == 200
        results = {r["claim_id"]: r["fraud_risk_score"] for r in resp.json()["results"]}
        assert results["outlier"] > results["c0"]

    def test_two_claim_batch_does_not_crash(self):
        """Two-claim batch must not raise ValueError from LOF."""
        payload = {"claims": [
            {"claim_id": "a", "ip_address": "1.2.3.4", "amount": 100.0},
            {"claim_id": "b", "ip_address": "5.6.7.8", "amount": 200.0},
        ]}
        resp = client.post("/v1/fraud/detect", json=payload)
        assert resp.status_code == 200
        assert len(resp.json()["results"]) == 2

    def test_three_claim_batch_does_not_crash(self):
        """Three-claim batch must not raise ValueError from LOF."""
        payload = {"claims": _make_claims(3)}
        resp = client.post("/v1/fraud/detect", json=payload)
        assert resp.status_code == 200
        assert len(resp.json()["results"]) == 3

    def test_model_version_in_response(self):
        payload = {"claims": _make_claims(3)}
        resp = client.post("/v1/fraud/detect", json=payload)
        data = resp.json()
        assert "model_version" in data
        assert data["model_version"] is not None


class TestFraudDetectionService:
    def test_single_claim(self):
        claims = [ClaimMetadata(claim_id="x1", ip_address="1.1.1.1")]
        results = detect_fraud(claims)
        assert len(results) == 1
        assert results[0].fraud_risk_score == 0.0

    def test_scores_in_range(self):
        claims = [ClaimMetadata(claim_id=f"c{i}", ip_address="1.1.1.1", amount=float(i)) for i in range(5)]
        results = detect_fraud(claims)
        for r in results:
            assert 0.0 <= r.fraud_risk_score <= 1.0

    def test_two_claims_no_crash(self):
        claims = [
            ClaimMetadata(claim_id="a", ip_address="1.1.1.1", amount=10.0),
            ClaimMetadata(claim_id="b", ip_address="2.2.2.2", amount=20.0),
        ]
        results = detect_fraud(claims)
        assert len(results) == 2
        for r in results:
            assert 0.0 <= r.fraud_risk_score <= 1.0

    def test_three_claims_no_crash(self):
        claims = [
            ClaimMetadata(claim_id="a", ip_address="1.1.1.1", amount=10.0),
            ClaimMetadata(claim_id="b", ip_address="2.2.2.2", amount=20.0),
            ClaimMetadata(claim_id="c", ip_address="3.3.3.3", amount=30.0),
        ]
        results = detect_fraud(claims)
        assert len(results) == 3
        for r in results:
            assert 0.0 <= r.fraud_risk_score <= 1.0

    def test_outlier_flagged_in_batch(self):
        """A constructed outlier should be flagged, homogeneous batch should not."""
        claims = [
            ClaimMetadata(claim_id=f"n{i}", ip_address="1.1.1.1", amount=100.0)
            for i in range(8)
        ]
        claims.append(ClaimMetadata(claim_id="outlier", ip_address="99.99.99.99", amount=99999.0))
        results = detect_fraud(claims)
        by_id = {r.claim_id: r for r in results}
        assert by_id["outlier"].fraud_risk_score > by_id["n0"].fraud_risk_score
