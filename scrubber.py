"""
Deprecated root PII scrubber module.

The active anonymization implementation lives in
app/ai-service/services/pii_scrubber.py as PIIScrubberService.
This module intentionally no longer exposes the legacy regex-only scrub_pii
function so new code does not depend on the deprecated implementation.
"""
