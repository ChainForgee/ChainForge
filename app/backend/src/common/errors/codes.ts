/**
 * Cross-service error-code taxonomy (Issue #249).
 *
 * Canonical source: docs/errors.yaml. This enum is a hand-mirrored
 * view of that file. The parity test in `codes.spec.ts` asserts every
 * name in docs/errors.yaml appears here and vice-versa, so a typo or
 * forgotten rename fails CI rather than silently drifting apart.
 *
 * Naming convention: SCREAMING_SNAKE_CASE strings. Each value is the
 * literal string `"<NAME>"` so a JSON serialised enum value is
 * directly comparable across stacks.
 *
 * Backend usage:
 *   The NestJS exception filter attaches the corresponding `ErrorCode`
 *   to every `ErrorResponse` via the optional `errorCode` field
 *   alongside the HTTP numeric `code`.
 *
 * Cross-service parity:
 *   app/ai-service/schemas/error_codes.py mirrors this enum verbatim.
 *   Tests on both sides assert same name → same string.
 */
export enum ErrorCode {
  // Cross-service HTTP categories ----------------------------------------
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  CONFLICT = 'CONFLICT',
  BAD_REQUEST = 'BAD_REQUEST',
  PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',
  BODY_LENGTH_MISMATCH = 'BODY_LENGTH_MISMATCH',
  INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR',
  UPSTREAM_TIMEOUT = 'UPSTREAM_TIMEOUT',
  UPSTREAM_UNAVAILABLE = 'UPSTREAM_UNAVAILABLE',
  UPSTREAM_ERROR = 'UPSTREAM_ERROR',
  AI_SERVICE_ERROR = 'AI_SERVICE_ERROR',
  AI_TIMEOUT = 'AI_TIMEOUT',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',

  // Soroban contract errors (AidEscrow `Error` enum, 1..=23) --------------
  CONTRACT_NOT_INITIALIZED = 'CONTRACT_NOT_INITIALIZED',
  CONTRACT_ALREADY_INITIALIZED = 'CONTRACT_ALREADY_INITIALIZED',
  CONTRACT_NOT_AUTHORIZED = 'CONTRACT_NOT_AUTHORIZED',
  CONTRACT_INVALID_AMOUNT = 'CONTRACT_INVALID_AMOUNT',
  CONTRACT_PACKAGE_NOT_FOUND = 'CONTRACT_PACKAGE_NOT_FOUND',
  CONTRACT_PACKAGE_NOT_ACTIVE = 'CONTRACT_PACKAGE_NOT_ACTIVE',
  CONTRACT_PACKAGE_EXPIRED = 'CONTRACT_PACKAGE_EXPIRED',
  CONTRACT_PACKAGE_NOT_EXPIRED = 'CONTRACT_PACKAGE_NOT_EXPIRED',
  CONTRACT_INSUFFICIENT_FUNDS = 'CONTRACT_INSUFFICIENT_FUNDS',
  CONTRACT_PACKAGE_ID_EXISTS = 'CONTRACT_PACKAGE_ID_EXISTS',
  CONTRACT_INVALID_STATE = 'CONTRACT_INVALID_STATE',
  CONTRACT_MISMATCHED_ARRAYS = 'CONTRACT_MISMATCHED_ARRAYS',
  CONTRACT_INSUFFICIENT_SURPLUS = 'CONTRACT_INSUFFICIENT_SURPLUS',
  CONTRACT_PAUSED = 'CONTRACT_PAUSED',
  CONTRACT_CLAIM_TOO_EARLY = 'CONTRACT_CLAIM_TOO_EARLY',
  CONTRACT_INVALID_PROOF = 'CONTRACT_INVALID_PROOF',
  CONTRACT_INVALID_TOKEN = 'CONTRACT_INVALID_TOKEN',
  CONTRACT_TOKEN_TRANSFER_FAILED = 'CONTRACT_TOKEN_TRANSFER_FAILED',
  CONTRACT_ALLOWLIST_EXPIRED = 'CONTRACT_ALLOWLIST_EXPIRED',
  CONTRACT_PROOF_TOO_LARGE = 'CONTRACT_PROOF_TOO_LARGE',
  CONTRACT_NO_PENDING_ADMIN = 'CONTRACT_NO_PENDING_ADMIN',
  CONTRACT_ADMIN_ROTATION_EXPIRED = 'CONTRACT_ADMIN_ROTATION_EXPIRED',
  CONTRACT_TOO_MANY_ALLOWED_TOKENS = 'CONTRACT_TOO_MANY_ALLOWED_TOKENS',
}

/**
 * Numeric Soroban contract error code (the `#[repr(u32)]` discriminant
 * from `aid_escrow::Error`) → shared `ErrorCode`.
 *
 * Mirrors `app/backend/contracts/aid_escrow/src/lib.rs::Error` and is
 * the single source of truth for translating numeric contract errors
 * to the cross-service taxonomy before forwarding to a downstream
 * service or external client.
 */
export const CONTRACT_ERROR_CODE_BY_NUMBER: Readonly<Record<number, ErrorCode>> =
  Object.freeze({
    1: ErrorCode.CONTRACT_NOT_INITIALIZED,
    2: ErrorCode.CONTRACT_ALREADY_INITIALIZED,
    3: ErrorCode.CONTRACT_NOT_AUTHORIZED,
    4: ErrorCode.CONTRACT_INVALID_AMOUNT,
    5: ErrorCode.CONTRACT_PACKAGE_NOT_FOUND,
    6: ErrorCode.CONTRACT_PACKAGE_NOT_ACTIVE,
    7: ErrorCode.CONTRACT_PACKAGE_EXPIRED,
    8: ErrorCode.CONTRACT_PACKAGE_NOT_EXPIRED,
    9: ErrorCode.CONTRACT_INSUFFICIENT_FUNDS,
    10: ErrorCode.CONTRACT_PACKAGE_ID_EXISTS,
    11: ErrorCode.CONTRACT_INVALID_STATE,
    12: ErrorCode.CONTRACT_MISMATCHED_ARRAYS,
    13: ErrorCode.CONTRACT_INSUFFICIENT_SURPLUS,
    14: ErrorCode.CONTRACT_PAUSED,
    15: ErrorCode.CONTRACT_CLAIM_TOO_EARLY,
    16: ErrorCode.CONTRACT_INVALID_PROOF,
    17: ErrorCode.CONTRACT_INVALID_TOKEN,
    18: ErrorCode.CONTRACT_TOKEN_TRANSFER_FAILED,
    19: ErrorCode.CONTRACT_ALLOWLIST_EXPIRED,
    20: ErrorCode.CONTRACT_PROOF_TOO_LARGE,
    21: ErrorCode.CONTRACT_NO_PENDING_ADMIN,
    22: ErrorCode.CONTRACT_ADMIN_ROTATION_EXPIRED,
    23: ErrorCode.CONTRACT_TOO_MANY_ALLOWED_TOKENS,
  });
