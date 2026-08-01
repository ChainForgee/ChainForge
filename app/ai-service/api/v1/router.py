"""
API v1 router – aggregates all versioned sub-routers.

Every route defined here lives under the /v1 prefix (mounted in main.py).
Add new versioned routers to the `include_router` calls below as the
surface grows.
"""

from fastapi import APIRouter

from api.v1 import (
    ocr,
    inference,
    proof_of_life,
    anonymize,
    humanitarian,
    fraud,
    artifacts,
    pii_decisions,
    upload_large,
)

v1_router = APIRouter(prefix="/v1")

v1_router.include_router(ocr.router)
v1_router.include_router(inference.router)
v1_router.include_router(proof_of_life.router)
v1_router.include_router(anonymize.router)
v1_router.include_router(humanitarian.router)
v1_router.include_router(fraud.router)
v1_router.include_router(artifacts.router)
# Auditor endpoint for PII decision records (Issue #274).
v1_router.include_router(pii_decisions.router)
# Large-payload ingest with per-route 64 MiB cap (Issue #267).
v1_router.include_router(upload_large.router)
