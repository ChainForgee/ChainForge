import { Pool } from 'pg';
import { IdempotencyKey } from './key';
import { RequestFingerprint } from './fingerprint';

export type RecordStatus = 'processing' | 'succeeded' | 'failed';

export interface IdempotencyRecord {
  idempotencyKey: string;
  requestFingerprint: string;
  status: RecordStatus;
  responseBody: Buffer | null;
  responseStatus: number | null;
  leaseExpiresAt: Date | null;
}

export interface IdempotencyStoreOptions {
  /**
   * How long a `processing` record may hold the key before it is considered
   * abandoned and becomes re-acquirable. The middleware refreshes this lease
   * with `heartbeat()` while the handler runs.
   */
  leaseDurationMs?: number;
}

const DEFAULT_LEASE_DURATION_MS = 30_000;

/**
 * SQL fragment that computes a lease expiry from `now()`. The lease duration
 * (milliseconds) is passed as the query parameter at `paramIndex` — callers
 * must pass it as the last parameter of their statement.
 */
const leaseExpirySql = (paramIndex: number) =>
  `now() + make_interval(secs => $${paramIndex}::float8 / 1000.0)`;

export class IdempotencyStore {
  private pool: Pool;

  /** Lease duration for `processing` records, in milliseconds. */
  public readonly leaseDurationMs: number;

  constructor(pool: Pool, options: IdempotencyStoreOptions = {}) {
    this.pool = pool;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  }

  /**
   * Attempts to acquire the idempotency key.
   *
   * - Returns `undefined` when the caller may proceed (fresh key, or an
   *   abandoned `processing` lease was atomically re-acquired).
   * - Returns the existing record otherwise; the caller must decide between
   *   replaying a cached response and returning 409 for a live `processing`
   *   record.
   */
  public async tryAcquire(
    key: IdempotencyKey,
    fingerprint: RequestFingerprint,
  ): Promise<IdempotencyRecord | undefined> {
    const insertResult = await this.pool.query(
      `INSERT INTO idempotency_records (idempotency_key, request_fingerprint, status, lease_expires_at)
           VALUES ($1, $2, 'processing', ${leaseExpirySql(3)})
               ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [key.asString(), fingerprint.asString(), this.leaseDurationMs],
    );

    if (insertResult.rows.length > 0) {
      return undefined; // Fresh key — proceed!
    }

    // Key exists. Atomically claim it if the previous lease has expired: the
    // row-level lock guarantees only one concurrent request can re-acquire an
    // abandoned `processing` record, so an abandoned lease can never cause the
    // handler to run twice concurrently.
    const claimResult = await this.pool.query(
      `UPDATE idempotency_records
          SET request_fingerprint = $2,
              status = 'processing',
              response_body = NULL,
              response_status = NULL,
              lease_expires_at = ${leaseExpirySql(3)},
              updated_at = now()
        WHERE idempotency_key = $1
          AND status = 'processing'
          AND (lease_expires_at IS NULL OR lease_expires_at <= now())
      RETURNING idempotency_key`,
      [key.asString(), fingerprint.asString(), this.leaseDurationMs],
    );

    if (claimResult.rows.length > 0) {
      return undefined; // Abandoned lease re-acquired — proceed!
    }

    // Key exists with a live lease or a terminal status — fetch it
    const { rows } = await this.pool.query(
      `SELECT idempotency_key, request_fingerprint, status, response_body, response_status, lease_expires_at
           FROM idempotency_records WHERE idempotency_key = $1`,
      [key.asString()],
    );

    const row = rows[0];
    return {
      idempotencyKey: row.idempotency_key,
      requestFingerprint: row.request_fingerprint,
      status: row.status,
      responseBody: row.response_body,
      responseStatus: row.response_status,
      leaseExpiresAt: row.lease_expires_at,
    };
  }

  /**
   * Refreshes the lease on a `processing` record. Called periodically by the
   * middleware while the handler runs so a slow request is never mistaken for
   * an abandoned one. A lease that has already expired is left untouched so a
   * crashed request's record can still be re-acquired.
   */
  public async heartbeat(key: IdempotencyKey): Promise<void> {
    await this.pool.query(
      `UPDATE idempotency_records
          SET lease_expires_at = ${leaseExpirySql(2)}, updated_at = now()
        WHERE idempotency_key = $1
          AND status = 'processing'
          AND (lease_expires_at IS NULL OR lease_expires_at > now())`,
      [key.asString(), this.leaseDurationMs],
    );
  }

  public async complete(
    key: IdempotencyKey,
    status: RecordStatus,
    responseStatus: number,
    responseBody: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE idempotency_records
          SET status = $2,
              response_status = $3,
              response_body = $4,
              lease_expires_at = NULL,
              updated_at = now()
        WHERE idempotency_key = $1
          AND status = 'processing'`,
      [key.asString(), status, responseStatus, Buffer.from(responseBody)],
    );
  }

  public async cleanup(maxAgeHours: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM idempotency_records
           WHERE created_at < now() - ($1::int || ' hours')::interval`,
      [maxAgeHours],
    );
    return result.rowCount ?? 0;
  }
}
