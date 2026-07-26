/**
 * src/common/errors/codes.ts
 *
 * Issue #249 — Shared error-code taxonomy consumed by both backend
 * (NestJS, `app/backend`) and AI service (FastAPI, `app/ai-service`).
 *
 * This file is the TypeScript binding for `docs/errors.yaml`, the single
 * source of truth.  The Python binding lives in
 * `app/ai-service/schemas/codes.py`.  Parity between the two bindings is
 * checked automatically by:
 *
 *   - `src/common/errors/codes.spec.ts`   (backend unit test)
 *   - `app/ai-service/tests/test_codes.py` (AI service unit test)
 *
 * Both tests load `docs/errors.yaml`, walk every entry, and assert that:
 *   1. The string `code` from YAML matches `ErrorCode.<NAME>` in this TS file.
 *   2. The numeric `httpStatus` from YAML matches `ErrorCodeMeta.httpStatus`.
 *   3. The `description` matches the meta table.
 *
 * If you change this file you MUST update `docs/errors.yaml` AND
 * `app/ai-service/schemas/codes.py` in the same change. The parity tests
 * will fail otherwise, which is the whole point of the issue.
 */

/**
 * Stable string codes emitted by the API surface.  Order here is purely
 * cosmetic and is kept alphabetical for ease of diffing against YAML.
 *
 * NOTE: TypeScript enums are bidirectional — `ErrorCode.HTTP_500` and
 * `ErrorCode['HTTP_500']` both work; the wire format we publish is
 * `ErrorCode.HTTP_500` (a string), never the underlying numeric value.
 */
export enum ErrorCode {
  CODE_BODY_LENGTH_MISMATCH = 'CODE_BODY_LENGTH_MISMATCH',
  HTTP_400 = 'HTTP_400',
  HTTP_401 = 'HTTP_401',
  HTTP_403 = 'HTTP_403',
  HTTP_404 = 'HTTP_404',
  HTTP_409 = 'HTTP_409',
  HTTP_413 = 'HTTP_413',
  HTTP_422 = 'HTTP_422',
  HTTP_500 = 'HTTP_500',
  HTTP_502 = 'HTTP_502',
  HTTP_503 = 'HTTP_503',
  INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR',
  PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  AI_SERVICE_ERROR = 'AI_SERVICE_ERROR',
  AI_TIMEOUT = 'AI_TIMEOUT',
}

/**
 * Per-code metadata derived from `docs/errors.yaml`.  Indexed by enum
 * value so consumers can look up the HTTP status and description in O(1).
 */
export interface ErrorCodeMeta {
  /** Stable identifier, identical to ErrorCode value (kept for convenience). */
  readonly code: string;
  /** HTTP status emitted on the wire. */
  readonly httpStatus: number;
  /** Human-readable explanation. */
  readonly description: string;
}

/**
 * Metadata table. Keys here MUST be a 1:1 with ErrorCode entries; the
 * parity test fails the build if they are not.
 */
export const ERROR_CODE_META: Readonly<Record<ErrorCode, ErrorCodeMeta>> = {
  [ErrorCode.HTTP_400]: {
    code: 'HTTP_400',
    httpStatus: 400,
    description:
      'Bad request — the request was malformed or contained invalid parameters.',
  },
  [ErrorCode.HTTP_401]: {
    code: 'HTTP_401',
    httpStatus: 401,
    description:
      'Unauthorized — authentication is required to access this resource.',
  },
  [ErrorCode.HTTP_403]: {
    code: 'HTTP_403',
    httpStatus: 403,
    description:
      'Forbidden — the caller is authenticated but lacks permission.',
  },
  [ErrorCode.HTTP_404]: {
    code: 'HTTP_404',
    httpStatus: 404,
    description: 'Not found — the requested resource does not exist.',
  },
  [ErrorCode.HTTP_409]: {
    code: 'HTTP_409',
    httpStatus: 409,
    description:
      'Conflict — the request conflicts with the current resource state.',
  },
  [ErrorCode.HTTP_413]: {
    code: 'HTTP_413',
    httpStatus: 413,
    description:
      'Payload too large — the request body exceeds the configured limit.',
  },
  [ErrorCode.HTTP_422]: {
    code: 'HTTP_422',
    httpStatus: 422,
    description:
      'Unprocessable entity — request payload failed schema validation.',
  },
  [ErrorCode.HTTP_500]: {
    code: 'HTTP_500',
    httpStatus: 500,
    description: 'Internal server error — an unexpected exception escaped the handler.',
  },
  [ErrorCode.HTTP_502]: {
    code: 'HTTP_502',
    httpStatus: 502,
    description: 'Bad gateway — an upstream/downstream dependency failed.',
  },
  [ErrorCode.HTTP_503]: {
    code: 'HTTP_503',
    httpStatus: 503,
    description:
      'Service unavailable — temporary degradation; retry with backoff.',
  },
  [ErrorCode.VALIDATION_ERROR]: {
    code: 'VALIDATION_ERROR',
    httpStatus: 422,
    description:
      'Validation failed — request payload does not match the expected schema.',
  },
  [ErrorCode.AI_SERVICE_ERROR]: {
    code: 'AI_SERVICE_ERROR',
    httpStatus: 502,
    description:
      'AI service error — the upstream LLM/OCR provider failed to respond.',
  },
  [ErrorCode.AI_TIMEOUT]: {
    code: 'AI_TIMEOUT',
    httpStatus: 502,
    description:
      'AI service timeout — the upstream LLM exceeded its time budget.',
  },
  [ErrorCode.PAYLOAD_TOO_LARGE]: {
    code: 'PAYLOAD_TOO_LARGE',
    httpStatus: 413,
    description:
      'Payload too large — the request body exceeded the configured size limit.',
  },
  [ErrorCode.CODE_BODY_LENGTH_MISMATCH]: {
    code: 'CODE_BODY_LENGTH_MISMATCH',
    httpStatus: 400,
    description:
      'Body length mismatch — streamed bytes exceeded the declared Content-Length.',
  },
  [ErrorCode.INTERNAL_SERVER_ERROR]: {
    code: 'INTERNAL_SERVER_ERROR',
    httpStatus: 500,
    description:
      'Internal server error — generic catch-all for unhandled exceptions.',
  },
};

/**
 * Reverse lookup: HTTP status → stable string code.  Used by the
 * NestJS exception filter to keep the on-wire `code` field (numeric,
 * because that's the existing public API contract — see
 * `test/error-handling.e2e-spec.ts` which asserts `typeof code === 'number'`)
 * in lock-step with the shared taxonomy.  If the same HTTP status ever
 * maps to multiple codes, the FIRST one declared in YAML wins; the YAML
 * parity test enforces that this lookup never disagrees with the YAML.
 */
export function codeForHttpStatus(status: number): string {
  for (const meta of Object.values(ERROR_CODE_META)) {
    if (meta.httpStatus === status) {
      return meta.code;
    }
  }
  return `HTTP_${status}`;
}

/**
 * Reverse lookup: stable string code → HTTP status.  Used by the AI
 * service's parity tests to verify the binding is well-formed.
 */
export function httpStatusForCode(code: string): number | undefined {
  for (const meta of Object.values(ERROR_CODE_META)) {
    if (meta.code === code) {
      return meta.httpStatus;
    }
  }
  return undefined;
}
