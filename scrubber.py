"""Deprecated legacy PII scrubber reference.

The active anonymization implementation is
``app/ai-service/services/pii_scrubber.py::PIIScrubberService``.

This module intentionally does not expose ``scrub_pii`` so new code and tests
use the canonical AI service implementation instead of the legacy regex-only
helper.
"""
