"""Tests for proof-of-life liveness gate (Issue #431).

Verifies that:
  - A selfie-only request (no burst frames) returns is_real_person: false.
  - Burst-based requests are scored on actual blink/head-movement evidence.
"""

from unittest.mock import patch, MagicMock

import numpy as np

from proof_of_life import ProofOfLifeAnalyzer, ProofOfLifeConfig


def _make_analyzer():
    """Build an analyzer with mocked cascade classifiers."""
    cfg = ProofOfLifeConfig(confidence_threshold=0.65)
    with patch("cv2.CascadeClassifier") as mock_cls:
        mock_instance = MagicMock()
        mock_instance.empty.return_value = False
        mock_cls.return_value = mock_instance
        analyzer = ProofOfLifeAnalyzer(config=cfg)
    return analyzer


def _fake_decode(image_base64: str) -> np.ndarray:
    """Return a synthetic 200x200 BGR image for any base64 input."""
    return np.zeros((200, 200, 3), dtype=np.uint8)


class TestSelfieOnlyRefusal:
    """Selfie-only requests must always be refused."""

    def test_selfie_only_returns_false(self):
        analyzer = _make_analyzer()
        with patch.object(analyzer, "_decode_image", side_effect=_fake_decode):
            result = analyzer.analyze(selfie_image_base64="dGVzdA==")
        assert result["is_real_person"] is False

    def test_selfie_only_reason_mentions_liveness(self):
        analyzer = _make_analyzer()
        with patch.object(analyzer, "_decode_image", side_effect=_fake_decode):
            result = analyzer.analyze(selfie_image_base64="dGVzdA==")
        assert "liveness" in result["reason"].lower()

    def test_empty_burst_list_treated_as_selfie_only(self):
        analyzer = _make_analyzer()
        with patch.object(analyzer, "_decode_image", side_effect=_fake_decode):
            result = analyzer.analyze(
                selfie_image_base64="dGVzdA==",
                burst_images_base64=[],
            )
        assert result["is_real_person"] is False


class TestBurstLivenessEvidence:
    """When burst frames are provided, liveness is scored on actual signals."""

    def test_burst_with_blink_and_movement_can_pass(self):
        analyzer = _make_analyzer()
        analyzer.config.confidence_threshold = 0.10
        with patch.object(analyzer, "_decode_image", side_effect=_fake_decode), \
             patch.object(analyzer, "_detect_primary_face", return_value=(50, 50, 100, 100)), \
             patch.object(
                 analyzer,
                 "_analyze_burst_frames",
                 return_value={
                     "blink_detected": True,
                     "head_movement_detected": True,
                     "processed_burst_frames": 5,
                 },
             ):
            result = analyzer.analyze(
                selfie_image_base64="dGVzdA==",
                burst_images_base64=["frame1", "frame2"],
            )
        assert result["checks"]["blink_detected"] is True
        assert result["checks"]["head_movement_detected"] is True

    def test_burst_without_liveness_fails(self):
        analyzer = _make_analyzer()
        with patch.object(analyzer, "_decode_image", side_effect=_fake_decode), \
             patch.object(analyzer, "_detect_primary_face", return_value=(50, 50, 100, 100)), \
             patch.object(
                 analyzer,
                 "_analyze_burst_frames",
                 return_value={
                     "blink_detected": False,
                     "head_movement_detected": False,
                     "processed_burst_frames": 5,
                 },
             ):
            result = analyzer.analyze(
                selfie_image_base64="dGVzdA==",
                burst_images_base64=["frame1", "frame2"],
            )
        assert result["is_real_person"] is False
        assert "liveness" in result["reason"].lower()
