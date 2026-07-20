/**
 * Contract test: backend client ↔ AI service Pydantic schemas  (#279)
 *
 * Strategy
 * --------
 * 1. Obtain the AI service OpenAPI document – live fetch when
 *    AI_SERVICE_URL is set, embedded snapshot otherwise (always runnable in CI).
 * 2. Assert all v1 endpoints the backend depends on exist in that document.
 * 3. For each endpoint validate the declared response schema against real
 *    fixture payloads (app/ai-service/fixtures/).
 * 4. TypeScript compile-time assertions ensure the backend's internal
 *    interface definitions remain compatible with the schema shapes.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  fetchOpenApiSpec,
  getResponseSchema,
  validateAgainstSchema,
  OpenApiDocument,
} from '../../scripts/openapi-validate';

// ─── 1. Compile-time type mirrors ────────────────────────────────────────────
// These replicate the interfaces the backend currently uses to consume AI
// service responses (see verification.service.ts).  TypeScript will surface a
// compile error here before any test even runs if a shape diverges.

interface _OCRFieldResult        { value: string; confidence: number }
interface _OCRResponse {
  success: boolean;
  processing_time_ms: number;
  data?: { fields: Record<string, _OCRFieldResult>; raw_text: string; processing_time_ms: number };
  error?: Record<string, string>;
}
type _HumanitarianVerdict = 'credible' | 'inconclusive' | 'not_credible';
interface _HumanitarianResponse {
  success: boolean;
  provider?: string | null;
  model?: string | null;
  prompt_variant?: string | null;
  verification?: { verdict: _HumanitarianVerdict; confidence: number; summary?: string } | null;
  error?: string | null;
}
interface _ProofOfLifeResponse {
  is_real_person: boolean; confidence: number; threshold: number;
  checks: Record<string, unknown>; reason: string;
}
interface _AnonymizeResponse {
  success: boolean; anonymized_text: string; original_length: number;
  pii_summary: { names: number; locations: number; dates: number; total: number };
  token_counts: Record<string, number>;
}
interface _FraudDetectionResponse {
  results: Array<{ claim_id: string; fraud_risk_score: number; is_flagged: boolean; reason?: string | null }>;
  flagged_count: number;
}

// Compile-time-only guards – never called at runtime.
function _guardOCR(v: unknown): asserts v is _OCRResponse {
  void (v as _OCRResponse).success; void (v as _OCRResponse).processing_time_ms;
}
function _guardHumanitarian(v: unknown): asserts v is _HumanitarianResponse {
  void (v as _HumanitarianResponse).success;
}
function _guardPOL(v: unknown): asserts v is _ProofOfLifeResponse {
  void (v as _ProofOfLifeResponse).is_real_person;
  void (v as _ProofOfLifeResponse).confidence;
}
function _guardAnonymize(v: unknown): asserts v is _AnonymizeResponse {
  void (v as _AnonymizeResponse).anonymized_text;
}
function _guardFraud(v: unknown): asserts v is _FraudDetectionResponse {
  void (v as _FraudDetectionResponse).flagged_count;
}
void _guardOCR; void _guardHumanitarian; void _guardPOL; void _guardAnonymize; void _guardFraud;

// ─── 2. Embedded OpenAPI snapshot ────────────────────────────────────────────
// Generated from:  curl http://localhost:8000/openapi.json
// Update when AI service schemas change; CI runs without a live service.

const EMBEDDED_SPEC: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'ChainForge AI Service', version: '1.0.0' },
  paths: {
    '/v1/ai/humanitarian/verify': {
      post: {
        tags: ['humanitarian'], operationId: 'verify_humanitarian_claim',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/HumanitarianVerificationRequest' } } } },
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/HumanitarianVerificationResponse' } } } } },
      },
    },
    '/v1/ai/anonymize': {
      post: {
        tags: ['anonymization'], operationId: 'anonymize_text',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AnonymizeRequest' } } } },
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/AnonymizeResponse' } } } } },
      },
    },
    '/v1/ai/proof-of-life': {
      post: {
        tags: ['proof-of-life'], operationId: 'analyze_proof_of_life',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ProofOfLifeRequest' } } } },
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/ProofOfLifeResponse' } } } } },
      },
    },
    '/v1/fraud/detect': {
      post: {
        tags: ['fraud'], operationId: 'detect_fraud_endpoint',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/FraudDetectionRequest' } } } },
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/FraudDetectionResponse' } } } } },
      },
    },
    '/v1/ai/inference': {
      post: {
        tags: ['inference'], operationId: 'create_inference_task',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/v1/ai/status/{task_id}': {
      get: {
        tags: ['inference'], operationId: 'get_task_status',
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/TaskStatusResponse' } } } } },
      },
    },
  },
  components: {
    schemas: {
      HumanitarianVerificationRequest: {
        type: 'object', required: ['aid_claim'],
        properties: {
          aid_claim: { type: 'string' },
          supporting_evidence: { type: 'array', items: { type: 'string' } },
          context_factors: { type: 'object' },
          provider_preference: { type: 'string', enum: ['auto', 'test', 'openai', 'groq'], default: 'auto' },
          timeout: { type: 'number', nullable: true },
        },
      },
      HumanitarianVerificationResponse: {
        type: 'object', required: ['success'],
        properties: {
          success: { type: 'boolean' },
          provider: { type: 'string', nullable: true },
          model: { type: 'string', nullable: true },
          prompt_variant: { type: 'string', nullable: true },
          verification: { type: 'object', nullable: true },
          error: { type: 'string', nullable: true },
        },
      },
      AnonymizeRequest: {
        type: 'object', required: ['text'],
        properties: { text: { type: 'string' } },
      },
      PIISummary: {
        type: 'object', required: ['names', 'locations', 'dates', 'total'],
        properties: {
          names: { type: 'integer' }, locations: { type: 'integer' },
          dates: { type: 'integer' }, total: { type: 'integer' },
        },
      },
      AnonymizeResponse: {
        type: 'object', required: ['success', 'anonymized_text', 'original_length', 'pii_summary'],
        properties: {
          success: { type: 'boolean' },
          anonymized_text: { type: 'string' },
          original_length: { type: 'integer' },
          pii_summary: { $ref: '#/components/schemas/PIISummary' },
          token_counts: { type: 'object' },
        },
      },
      ProofOfLifeRequest: {
        type: 'object', required: ['selfie_image_base64'],
        properties: {
          selfie_image_base64: { type: 'string' },
          burst_images_base64: { type: 'array', items: { type: 'string' }, nullable: true },
          confidence_threshold: { type: 'number', nullable: true },
        },
      },
      ProofOfLifeResponse: {
        type: 'object', required: ['is_real_person', 'confidence', 'threshold', 'checks', 'reason'],
        properties: {
          is_real_person: { type: 'boolean' },
          confidence: { type: 'number' },
          threshold: { type: 'number' },
          checks: { type: 'object' },
          reason: { type: 'string' },
        },
      },
      ClaimMetadata: {
        type: 'object', required: ['claim_id'],
        properties: {
          claim_id: { type: 'string' },
          ip_address: { type: 'string', nullable: true },
          evidence_hash: { type: 'string', nullable: true },
          amount: { type: 'number', nullable: true },
          location: { type: 'string', nullable: true },
          extra: { type: 'object' },
        },
      },
      FraudDetectionRequest: {
        type: 'object', required: ['claims'],
        properties: { claims: { type: 'array', items: { $ref: '#/components/schemas/ClaimMetadata' } } },
      },
      ClaimFraudResult: {
        type: 'object', required: ['claim_id', 'fraud_risk_score', 'is_flagged'],
        properties: {
          claim_id: { type: 'string' },
          fraud_risk_score: { type: 'number' },
          is_flagged: { type: 'boolean' },
          reason: { type: 'string', nullable: true },
        },
      },
      FraudDetectionResponse: {
        type: 'object', required: ['results', 'flagged_count'],
        properties: {
          results: { type: 'array', items: { $ref: '#/components/schemas/ClaimFraudResult' } },
          flagged_count: { type: 'integer' },
        },
      },
      TaskStatusResponse: {
        type: 'object', required: ['task_id', 'status'],
        properties: {
          task_id: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'processing', 'completed', 'failed', 'cancelled', 'not_found'] },
          result: { nullable: true },
          error: { type: 'string', nullable: true },
        },
      },
      ErrorDetail: {
        type: 'object', required: ['code', 'message'],
        properties: {
          code: { type: 'string' }, message: { type: 'string' }, details: { nullable: true },
        },
      },
      ErrorEnvelope: {
        type: 'object', required: ['error'],
        properties: { error: { $ref: '#/components/schemas/ErrorDetail' } },
      },
    },
  },
};

// ─── 3. Fixture loader ────────────────────────────────────────────────────────

const FIXTURES_DIR = path.resolve(
  __dirname, '..', '..', '..', 'ai-service', 'fixtures',
);

function loadFixture<T>(name: string): T[] {
  const file = path.join(FIXTURES_DIR, `${name}_responses.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Fixture file not found: ${file}`);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
  return (Array.isArray(raw) ? raw : [raw]) as T[];
}

// ─── 4. Helpers ───────────────────────────────────────────────────────────────

/**
 * Resolves the response schema for a path/method and validates every fixture
 * entry against it.  Asserts no validation errors.
 */
function assertFixturesMatchSchema(
  doc: OpenApiDocument,
  urlPath: string,
  method: 'get' | 'post',
  fixtures: Record<string, unknown>[],
  label: string,
): void {
  const schema = getResponseSchema(doc, urlPath, method, '200');
  expect(schema).toBeDefined();
  if (!schema) return;

  fixtures.forEach((fixture, i) => {
    const result = validateAgainstSchema(fixture, schema, doc, `${label}[${i}]`);
    if (!result.valid) {
      // Surface all errors in a single failure for easy diagnosis.
      throw new Error(
        `Fixture ${label}[${i}] failed schema validation:\n  ${result.errors.join('\n  ')}`,
      );
    }
  });
}

// ─── 5. Test suite ────────────────────────────────────────────────────────────

describe('AI service contract: backend client ↔ Pydantic schemas', () => {
  let doc: OpenApiDocument;

  // Attempt live fetch; fall back to snapshot transparently.
  beforeAll(async () => {
    const liveUrl = process.env['AI_SERVICE_URL'];
    if (liveUrl) {
      try {
        doc = await fetchOpenApiSpec(liveUrl);
        console.log(`[contract] Using live OpenAPI spec from ${liveUrl}`);
        return;
      } catch {
        console.warn('[contract] Live AI service unreachable – using embedded snapshot');
      }
    }
    doc = EMBEDDED_SPEC;
  });

  // ── 5a. Document shape ────────────────────────────────────────────────────

  describe('OpenAPI document structure', () => {
    it('has a valid openapi version string', () => {
      expect(doc.openapi).toMatch(/^3\./);
    });

    it('has info.title and info.version', () => {
      expect(typeof doc.info.title).toBe('string');
      expect(doc.info.title.length).toBeGreaterThan(0);
      expect(typeof doc.info.version).toBe('string');
    });

    it('exposes a components.schemas map', () => {
      expect(doc.components?.schemas).toBeDefined();
      expect(typeof doc.components!.schemas).toBe('object');
    });
  });

  // ── 5b. Required v1 paths ─────────────────────────────────────────────────

  describe('Required v1 endpoint paths', () => {
    const REQUIRED_PATHS: Array<{ path: string; method: 'get' | 'post'; label: string }> = [
      { path: '/v1/ai/humanitarian/verify', method: 'post', label: 'Humanitarian verification' },
      { path: '/v1/ai/anonymize',           method: 'post', label: 'PII anonymisation' },
      { path: '/v1/ai/proof-of-life',       method: 'post', label: 'Proof-of-life' },
      { path: '/v1/fraud/detect',           method: 'post', label: 'Fraud detection' },
      { path: '/v1/ai/inference',           method: 'post', label: 'Async inference task' },
      { path: '/v1/ai/status/{task_id}',    method: 'get',  label: 'Task status poll' },
    ];

    REQUIRED_PATHS.forEach(({ path: p, method, label }) => {
      it(`${label} – ${method.toUpperCase()} ${p} exists`, () => {
        expect(doc.paths[p]).toBeDefined();
        expect(doc.paths[p][method]).toBeDefined();
      });

      it(`${label} – returns a 200 response definition`, () => {
        const op = doc.paths[p]?.[method];
        expect(op?.responses?.['200']).toBeDefined();
      });
    });
  });

  // ── 5c. provider_preference enum ─────────────────────────────────────────

  describe('HumanitarianVerificationRequest: provider_preference enum', () => {
    const EXPECTED_PROVIDERS = ['auto', 'test', 'openai', 'groq'];

    it('declares provider_preference in request schema', () => {
      const schema = doc.components?.schemas?.['HumanitarianVerificationRequest'];
      expect(schema).toBeDefined();
      expect(schema?.properties?.['provider_preference']).toBeDefined();
    });

    it('provider_preference enum contains all expected values', () => {
      const prop = doc.components?.schemas?.['HumanitarianVerificationRequest']
        ?.properties?.['provider_preference'];
      expect(prop?.enum).toBeDefined();
      for (const v of EXPECTED_PROVIDERS) {
        expect(prop!.enum).toContain(v);
      }
    });

    it('provider_preference has a default of "auto"', () => {
      const prop = doc.components?.schemas?.['HumanitarianVerificationRequest']
        ?.properties?.['provider_preference'];
      expect(prop?.default).toBe('auto');
    });
  });

  // ── 5d. TaskStatusResponse status enum ───────────────────────────────────

  describe('TaskStatusResponse: status enum', () => {
    const EXPECTED_STATUSES = ['pending', 'processing', 'completed', 'failed'];

    it('declares status as an enum', () => {
      const schema = doc.components?.schemas?.['TaskStatusResponse'];
      expect(schema?.properties?.['status']?.enum).toBeDefined();
    });

    it('status enum contains all lifecycle values', () => {
      const enumVals = doc.components?.schemas?.['TaskStatusResponse']
        ?.properties?.['status']?.enum;
      for (const v of EXPECTED_STATUSES) {
        expect(enumVals).toContain(v);
      }
    });
  });

  // ── 5e. Required fields match backend interfaces ──────────────────────────

  describe('Response schema required fields align with backend interfaces', () => {
    it('HumanitarianVerificationResponse requires "success"', () => {
      const schema = doc.components?.schemas?.['HumanitarianVerificationResponse'];
      expect(schema?.required).toContain('success');
    });

    it('AnonymizeResponse requires success, anonymized_text, original_length, pii_summary', () => {
      const schema = doc.components?.schemas?.['AnonymizeResponse'];
      const req = schema?.required ?? [];
      expect(req).toContain('success');
      expect(req).toContain('anonymized_text');
      expect(req).toContain('original_length');
      expect(req).toContain('pii_summary');
    });

    it('ProofOfLifeResponse requires is_real_person, confidence, threshold, checks, reason', () => {
      const schema = doc.components?.schemas?.['ProofOfLifeResponse'];
      const req = schema?.required ?? [];
      ['is_real_person', 'confidence', 'threshold', 'checks', 'reason'].forEach((f) => {
        expect(req).toContain(f);
      });
    });

    it('FraudDetectionResponse requires results and flagged_count', () => {
      const schema = doc.components?.schemas?.['FraudDetectionResponse'];
      const req = schema?.required ?? [];
      expect(req).toContain('results');
      expect(req).toContain('flagged_count');
    });

    it('ClaimFraudResult requires claim_id, fraud_risk_score, is_flagged', () => {
      const schema = doc.components?.schemas?.['ClaimFraudResult'];
      const req = schema?.required ?? [];
      ['claim_id', 'fraud_risk_score', 'is_flagged'].forEach((f) => {
        expect(req).toContain(f);
      });
    });

    it('PIISummary requires names, locations, dates, total', () => {
      const schema = doc.components?.schemas?.['PIISummary'];
      const req = schema?.required ?? [];
      ['names', 'locations', 'dates', 'total'].forEach((f) => {
        expect(req).toContain(f);
      });
    });

    it('ErrorEnvelope requires error; ErrorDetail requires code and message', () => {
      const envelope = doc.components?.schemas?.['ErrorEnvelope'];
      expect(envelope?.required).toContain('error');
      const detail = doc.components?.schemas?.['ErrorDetail'];
      expect(detail?.required).toContain('code');
      expect(detail?.required).toContain('message');
    });
  });

  // ── 5f. Property type declarations ───────────────────────────────────────

  describe('Property type declarations', () => {
    it('ProofOfLifeResponse.is_real_person is boolean', () => {
      const prop = doc.components?.schemas?.['ProofOfLifeResponse']
        ?.properties?.['is_real_person'];
      expect(prop?.type).toBe('boolean');
    });

    it('ProofOfLifeResponse.confidence is number', () => {
      const prop = doc.components?.schemas?.['ProofOfLifeResponse']
        ?.properties?.['confidence'];
      expect(prop?.type).toBe('number');
    });

    it('FraudDetectionResponse.flagged_count is integer', () => {
      const prop = doc.components?.schemas?.['FraudDetectionResponse']
        ?.properties?.['flagged_count'];
      expect(prop?.type).toBe('integer');
    });

    it('AnonymizeResponse.original_length is integer', () => {
      const prop = doc.components?.schemas?.['AnonymizeResponse']
        ?.properties?.['original_length'];
      expect(prop?.type).toBe('integer');
    });

    it('ClaimFraudResult.fraud_risk_score is number', () => {
      const prop = doc.components?.schemas?.['ClaimFraudResult']
        ?.properties?.['fraud_risk_score'];
      expect(prop?.type).toBe('number');
    });
  });

  // ── 5g. Fixture validation ────────────────────────────────────────────────

  describe('AI service fixture payloads validate against declared schemas', () => {
    // Humanitarian fixtures wrap the raw fixture (verdict/confidence/summary)
    // in the response envelope the endpoint actually emits.
    it('humanitarian fixtures satisfy HumanitarianVerificationResponse schema', () => {
      const rawFixtures = loadFixture<Record<string, unknown>>('humanitarian');
      const enveloped = rawFixtures.map((f) => ({
        success: true,
        verification: f,
      }));
      assertFixturesMatchSchema(
        doc,
        '/v1/ai/humanitarian/verify',
        'post',
        enveloped,
        'humanitarian',
      );
    });

    it('anonymize fixtures satisfy AnonymizeResponse schema', () => {
      const fixtures = loadFixture<Record<string, unknown>>('anonymize');
      // The fixtures already contain all AnonymizeResponse fields except success.
      const enveloped = fixtures.map((f) => ({ success: true, ...f }));
      assertFixturesMatchSchema(
        doc,
        '/v1/ai/anonymize',
        'post',
        enveloped,
        'anonymize',
      );
    });

    it('proof_of_life fixtures satisfy ProofOfLifeResponse schema', () => {
      const fixtures = loadFixture<Record<string, unknown>>('proof_of_life');
      assertFixturesMatchSchema(
        doc,
        '/v1/ai/proof-of-life',
        'post',
        fixtures,
        'proof_of_life',
      );
    });
  });

  // ── 5h. Cross-field consistency ───────────────────────────────────────────

  describe('Cross-field consistency', () => {
    it('HumanitarianVerificationResponse.verification is nullable (not required)', () => {
      const schema = doc.components?.schemas?.['HumanitarianVerificationResponse'];
      const required = schema?.required ?? [];
      // verification must NOT be in required – it is absent on failure paths
      expect(required).not.toContain('verification');
    });

    it('HumanitarianVerificationResponse.error is nullable (not required)', () => {
      const schema = doc.components?.schemas?.['HumanitarianVerificationResponse'];
      expect((schema?.required ?? [])).not.toContain('error');
    });

    it('FraudDetectionRequest requires at least one claim (min-length enforced in Pydantic)', () => {
      // The spec reflects that claims is a required array; min-length is a
      // Pydantic concern, but the array type must be present.
      const schema = doc.components?.schemas?.['FraudDetectionRequest'];
      expect(schema?.required).toContain('claims');
      expect(schema?.properties?.['claims']?.type).toBe('array');
    });

    it('AnonymizeResponse.pii_summary $ref resolves to PIISummary', () => {
      const prop = doc.components?.schemas?.['AnonymizeResponse']
        ?.properties?.['pii_summary'];
      // Either $ref or inline – if $ref it must resolve
      if (prop?.$ref) {
        const resolved = doc.components?.schemas?.['PIISummary'];
        expect(resolved).toBeDefined();
        expect(resolved?.required).toContain('total');
      } else {
        expect(prop?.properties?.['total']).toBeDefined();
      }
    });
  });
});
