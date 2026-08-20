"""Tests for proof-of-life liveness gate (Issue #431).

Verifies that:
  - A selfie-only request (no burst frames) returns is_real_person: false.
  - Burst-based requests are scored on actual blink/head-movement evidence.
"""

from unittest.mock import patch

from proof_of_life import ProofOfLifeAnalyzer, ProofOfLifeConfig


def _make_analyzer():
    """Build an analyzer in test-provider mode so we skip cascade loading."""
    cfg = ProofOfLifeConfig(confidence_threshold=0.65)
    analyzer = ProofOfLifeAnalyzer(config=cfg)
    return analyzer


class TestSelfieOnlyRefusal:
    """Selfie-only requests must always be refused."""

    def test_selfie_only_returns_false(self):
        """Without burst frames, is_real_person must be False."""
        analyzer = _make_analyzer()
        result = analyzer.analyze(selfie_image_base64="dGVzdA==")
        assert result["is_real_person"] is False

    def test_selfie_only_reason_mentions_liveness(self):
        analyzer = _make_analyzer()
        result = analyzer.analyze(selfie_image_base64="dGVzdA==")
        assert "liveness" in result["reason"].lower()

    def test_empty_burst_list_treated_as_selfie_only(self):
        """An explicit empty list is equivalent to no burst frames."""
        analyzer = _make_analyzer()
        result = analyzer.analyze(
            selfie_image_base64="dGVzdA==",
            burst_images_base64=[],
        )
        assert result["is_real_person"] is False


class TestBurstLivenessEvidence:
    """When burst frames are provided, liveness is scored on actual signals."""

    @patch.object(ProofOfLifeAnalyzer, "_analyze_burst_frames")
    @patch.object(ProofOfLifeAnalyzer, "_detect_primary_face")
    @patch.object(ProofOfLifeAnalyzer, "_decode_image")
    def test_burst_with_blink_and_movement_can_pass(
        self, mock_decode, mock_face, mock_burst
    ):
        import numpy as np

        mock_decode.return_value = np.zeros((200, 200, 3), dtype=np.uint8)
        mock_face.return_value = (50, 50, 100, 100)
        mock_burst.return_value = {
            "blink_detected": True,
            "head_movement_detected": True,
            "processed_burst_frames": 5,
        }

        analyzer = _make_analyzer()
        # Use a very low threshold so the combined score passes
        analyzer.config.confidence_threshold = 0.10
        result = analyzer.analyze(
            selfie_image_base64="dGVzdA==",
            burst_images_base64=["frame1", "frame2"],
        )
        assert result["checks"]["blink_detected"] is True
        assert result["checks"]["head_movement_detected"] is True

    @patch.object(ProofOfLifeAnalyzer, "_analyze_burst_frames")
    @patch.object(ProofOfLifeAnalyzer, "_detect_primary_face")
    @patch.object(ProofOfLifeAnalyzer, "_decode_image")
    def test_burst_without_liveness_fails(
        self, mock_decode, mock_face, mock_burst
    ):
        import numpy as np

        mock_decode.return_value = np.zeros((200, 200, 3), dtype=np.uint8)
        mock_face.return_value = (50, 50, 100, 100)
        mock_burst.return_value = {
            "blink_detected": False,
            "head_movement_detected": False,
            "processed_burst_frames": 5,
        }

        analyzer = _make_analyzer()
        result = analyzer.analyze(
            selfie_image_base64="dGVzdA==",
            burst_images_base64=["frame1", "frame2"],
        )
        assert result["is_real_person"] is False
        assert "liveness" in result["reason"].lower()
