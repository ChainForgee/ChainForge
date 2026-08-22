# ChainForge AI Service

AI-powered document verification, proof-of-life analysis, humanitarian claim verification, and PII anonymization for the ChainForge aid platform.

The AI Service sits between the ChainForge backend and external LLM/ML providers, providing a unified API for inference tasks. It handles OCR document extraction, facial recognition for proof-of-life, LLM-driven claim verification against Sphere Handbook criteria, anomaly-based fraud detection, and privacy-preserving text sanitization.

---

## Quick start

```bash
pip install -r requirements.txt
python main.py
```

The service starts at `http://localhost:8000`. Interactive API documentation is available at `/docs`.

## Environment configuration

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | — | OpenAI API key |
| `GROQ_API_KEY` | — | Groq API key |
| `OPENAI_MODEL` | `gpt-4o-mini` | Default OpenAI model |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Default Groq model |
| `AI_DETERMINISTIC_MODE` | `false` | Stable responses for CI/testing |
| `TEST_PROVIDER_MODE` | `false` | Fixture-driven responses (no API keys needed) |
| `LLM_TIMEOUT_SECONDS` | `30` | Timeout for LLM API requests |
| `APP_ENV` | `development` | `development`, `staging`, `production`, or `test` |
| `LOG_LEVEL` | `INFO` | Logging verbosity |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis connection for task queue |
| `BACKEND_WEBHOOK_URL` | `http://localhost:3001/ai/webhook` | Backend notification endpoint |
| `MAX_REQUEST_BODY_BYTES` | `10485760` (10 MiB) | Maximum HTTP request body size; oversized requests are rejected with HTTP 413 to prevent memory-exhaustion DoS. Set to `0` to disable (not recommended in production). |
| `REQUEST_BODY_BYPASS_PATHS` | _(empty)_ | Comma-separated path entries that bypass body-size limiting. Entries without a trailing `'/'` must match the path exactly; entries with a trailing `'/'` (e.g. `/hooks/`) match any path with that prefix. The default bypass list (`/health`, `/`, `/ai/metrics`, `/docs`, `/redoc`, `/openapi.json`) is always merged in. |
| `PII_SCRUBBING_ENABLED` | `true` | Master switch for the mandatory PII preprocessing stage on `/v1/ai/humanitarian/verify`. When disabled the service **fails closed**: verification requests are rejected rather than sending unredacted evidence to an external LLM provider. |
| `PII_DECISIONS_ENABLED` | `false` | When truthy, every successful scrubbing event (the `/v1/ai/anonymize` endpoint and the humanitarian verification pipeline) writes aggregate audit metadata (counts + fingerprint only, never text) to the PII decisions store. |

## Core services

### Health and discovery

| Endpoint | Description |
|---|---|
| `GET /health` | Service health status |
| `GET /health/dependencies` | Redis, provider, and filesystem probe |
| `GET /` | Service root with API links |

### OCR processing

```
POST /ai/ocr
```

Extracts text fields from uploaded identity document images (JPEG, PNG, BMP, TIFF, WebP) and returns structured data with confidence scores.

```bash
curl -X POST http://localhost:8000/ai/ocr \
  -F "image=@document.jpg"
```

### Proof-of-life verification

```
POST /ai/proof-of-life
```

Analyzes selfie images and optional burst frames for face detection and liveness signals (blink detection, head movement).

```json
{
  "selfie_image_base64": "<base64-image>",
  "burst_images_base64": ["<base64-image>"],
  "confidence_threshold": 0.65
}
```

### Humanitarian claim verification

```
POST /ai/humanitarian/verify
```

Evaluates aid claims against Sphere Handbook criteria using configurable LLM providers with automatic fallback and circuit breaker protection.

```json
{
  "aid_claim": "Relief teams delivered hygiene kits to all registered households in Sector B.",
  "supporting_evidence": ["Distribution list #B-17"],
  "context_factors": {
    "security_status": "stable",
    "weather": "heavy_rain"
  },
  "provider_preference": "auto"
}
```

### PII anonymization

```
POST /ai/anonymize
```

Detects and masks personal identifiers (names, locations, dates, emails, phone numbers, IDs) before forwarding text to external LLM services.

```json
{
  "text": "On 15 Jan 2025, Mary Johnson received aid in Maiduguri Camp."
}
```

### Fraud detection

```
POST /v1/ai/fraud/detect
```

Analyzes claim metadata batches using Local Outlier Factor and flags anomalous patterns for manual review.

---

## PII scrubbing posture

PII anonymization is enforced as a **mandatory preprocessing stage**, not an
opt-in helper. Before any prompt is built for an external LLM provider, the
pipeline scrubs `aid_claim`, every `supporting_evidence` entry, and
string-valued `context_factors` using the same detector that backs
`/v1/ai/anonymize`.

| Endpoint | Scrubs PII before external processing | Notes |
|---|---|---|
| `POST /v1/ai/humanitarian/verify` | ✅ Yes | Fail-closed: if scrubbing is disabled (`PII_SCRUBBING_ENABLED=false`) or fails, the request is rejected with `success=false` and no provider call is made. The response includes a `pii_scrubbing` block (`applied`, `anonymized`, `pii_summary`); the raw text is never returned and remains only on the backend (human-review) side. |
| `POST /v1/ai/anonymize` | ✅ Yes | Explicit scrubbing endpoint; the caller receives the anonymized text and aggregate summary. |
| `POST /ai/ocr` | ❌ No | Local document extraction (Tesseract); no external LLM call is made from this path. |
| `POST /v1/ai/fraud/detect` | ❌ No | Local statistical anomaly detection (LOF); no external LLM call is made from this path. |
| `POST /ai/proof-of-life` | ❌ No | Local face/liveness analysis; no external LLM call is made from this path. |

**Residual risk.** Detection relies on a regex set plus a spaCy `blank`
entity ruler, so precision is imperfect: generic capitalized phrases can be
over-redacted, and unusual identifier formats (e.g. non-Nigerian ID numbers,
foreign phone formats) can pass through undetected. Treat scrubbing as a
privacy-control layer, not a guarantee; recipients should be advised that
names and locations embedded in evidence are material to verification and
may affect the verdict. Do not rely on scrubbed output to fully de-identify
free text.

**Audit.** When `PII_DECISIONS_ENABLED=true`, each scrubbing event writes an
aggregate record (entity counts, token counts, a non-reversible SHA-256
fingerprint, model version) to the SQLite `pii_decisions` store. Raw or
anonymized text is never persisted.

---

## Versioned API

All routes are available under versioned and legacy paths during the transition period.

| Prefix | Status |
|---|---|
| `/v1/ai/...` | Canonical — all new development |
| `/ai/...` | Legacy — 308 redirects to `/v1` |

---

## Deployment

### Docker (CPU)

```bash
docker compose up ai-service
```

### Docker (GPU)

```bash
docker compose --profile gpu up ai-service-gpu
```

### Dockerfile targets

| Target | Base | Use case |
|---|---|---|
| `development` | CUDA 12.1 | Development with hot-reload |
| `production` | Python 3.10-slim | Production CPU |
| `production-gpu` | CUDA 12.1 | Production GPU |

### Kubernetes / Cloud

Set `APP_ENV=production` and configure `OPENAI_API_KEY` or `GROQ_API_KEY`. The service scales horizontally behind a load balancer; each instance manages its own circuit breaker state and Redis-backed task queue.

---

## Testing

```bash
# Run all tests
pytest -v

# Run with coverage
pytest --cov=. -v

# Run specific test suite
pytest tests/test_routes.py -v
```

Use `AI_DETERMINISTIC_MODE=true` for stable verification outputs in CI. Use `TEST_PROVIDER_MODE=true` when no API keys are available — responses are served from fixture files under `fixtures/`.

---

## Project structure

```
app/ai-service/
├── main.py                   # FastAPI application entry point
├── config.py                 # Environment configuration
├── tasks.py                  # Celery background task processing
├── metrics.py                # Prometheus metrics collection
├── exceptions.py             # Shared error types
├── proof_of_life.py          # OpenCV face/liveness analysis
├── conftest.py               # Pytest fixtures and stubs
├── api/
│   ├── routes.py             # Legacy OCR route
│   └── v1/                   # Versioned API routes
├── schemas/                  # Request/response models
├── services/                 # Business logic services
├── fixtures/                 # Test fixture response files
├── tests/                    # Unit and integration tests
├── Dockerfile                # Multi-stage Docker build
├── docker-compose.yml        # Service orchestration
└── requirements.txt          # Python dependencies
```

---

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for development guidelines.
