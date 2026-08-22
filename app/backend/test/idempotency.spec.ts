import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import express, { Request } from 'express';
import { Pool } from 'pg';

import { IdempotencyStore } from '../src/idempotency/store';
import { IdempotencyKey } from '../src/idempotency/key';
import { idempotencyMiddleware } from '../src/idempotency/middleware';
import { submitTransaction } from '../src/handlers/transaction';
import { RequestFingerprint } from '../src/idempotency/fingerprint';

const hasDatabase = Boolean(process.env.DATABASE_URL);

let pool: Pool;
let store: IdempotencyStore;
let app: express.Application;

const validBody = { transactionXdr: 'AAAAAAABLC0=' };

(hasDatabase ? describe : describe.skip)(
  'Idempotency integration tests',
  () => {
    beforeAll(async () => {
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
      });

      store = new IdempotencyStore(pool);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS idempotency_records (
                                                         idempotency_key TEXT PRIMARY KEY,
                                                         request_fingerprint TEXT NOT NULL,
                                                         status TEXT NOT NULL DEFAULT 'processing',
                                                         response_body BYTEA,
                                                         response_status SMALLINT,
                                                         lease_expires_at TIMESTAMPTZ DEFAULT now() + interval '30 seconds',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
      `);

      app = express();

      app.use(express.json());

      app.post(
        '/v1/transactions/submit',
        idempotencyMiddleware(store),
        submitTransaction,
      );
    });

    afterAll(async () => {
      await pool.query('DROP TABLE IF EXISTS idempotency_records;');
      await pool.end();
    });

    it('Missing key returns 400', async () => {
      const res = await request(app)
        .post('/v1/transactions/submit')
        .send(validBody);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing');
    });

    it('Invalid key returns 400', async () => {
      const res = await request(app)
        .post('/v1/transactions/submit')
        .set('Idempotency-Key', 'bad key!')
        .send(validBody);

      expect(res.status).toBe(400);
    });

    it('First request succeeds', async () => {
      const res = await request(app)
        .post('/v1/transactions/submit')
        .set('Idempotency-Key', 'key-1')
        .send(validBody);

      expect(res.status).toBe(200);
      expect(res.headers['x-idempotent-replayed']).toBeUndefined();
    });

    it('Duplicate request replays cached response', async () => {
      const res1 = await request(app)
        .post('/v1/transactions/submit')
        .set('Idempotency-Key', 'key-2')
        .send(validBody);

      const res2 = await request(app)
        .post('/v1/transactions/submit')
        .set('Idempotency-Key', 'key-2')
        .send(validBody);

      expect(res2.status).toBe(200);
      expect(res2.headers['x-idempotent-replayed']).toBe('true');
      expect(res2.body.hash).toEqual(res1.body.hash);
    });

    it('Mismatched body returns 409', async () => {
      await request(app)
        .post('/v1/transactions/submit')
        .set('Idempotency-Key', 'key-3')
        .send(validBody);

      const res = await request(app)
        .post('/v1/transactions/submit')
        .set('Idempotency-Key', 'key-3')
        .send({ transactionXdr: 'B' });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('fingerprint');
    });

    it('Live processing record returns 409', async () => {
      const validFingerprint =
        RequestFingerprint.fromBody(validBody).asString();

      await pool.query(
        `
          INSERT INTO idempotency_records (
            idempotency_key,
            request_fingerprint,
            status,
            lease_expires_at
          )
          VALUES ($1, $2, 'processing', now() + interval '1 minute')
        `,
        ['key-4', validFingerprint],
      );

      const res = await request(app)
        .post('/v1/transactions/submit')
        .set('Idempotency-Key', 'key-4')
        .send(validBody);

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('processed');
    });

    it('Expired processing lease is re-acquired instead of stuck at 409', async () => {
      const validFingerprint =
        RequestFingerprint.fromBody(validBody).asString();

      // Simulate a crash: the record is `processing` with an expired lease,
      // exactly what is left behind when the process dies between acquire and
      // complete.
      await pool.query(
        `
          INSERT INTO idempotency_records (
            idempotency_key,
            request_fingerprint,
            status,
            lease_expires_at
          )
          VALUES ($1, $2, 'processing', now() - interval '1 minute')
        `,
        ['key-crash', validFingerprint],
      );

      const res = await request(app)
        .post('/v1/transactions/submit')
        .set('Idempotency-Key', 'key-crash')
        .send(validBody);

      expect(res.status).toBe(200);
      expect(res.headers['x-idempotent-replayed']).toBeUndefined();

      const { rows } = await pool.query(
        `SELECT status, lease_expires_at
           FROM idempotency_records
          WHERE idempotency_key = $1`,
        ['key-crash'],
      );
      expect(rows[0].status).toBe('succeeded');
      expect(rows[0].lease_expires_at).toBeNull();
    });

    it('heartbeat refreshes the lease on a live processing record', async () => {
      const key = IdempotencyKey.fromHeaders({
        headers: { 'idempotency-key': 'key-heartbeat' },
      } as unknown as Request);
      const fingerprint = RequestFingerprint.fromBody(validBody);

      // A live record with a lease that is still valid but about to expire.
      await pool.query(
        `
          INSERT INTO idempotency_records (
            idempotency_key,
            request_fingerprint,
            status,
            lease_expires_at
          )
          VALUES ($1, $2, 'processing', now() + interval '5 seconds')
        `,
        [key.asString(), fingerprint.asString()],
      );

      const before = await pool.query(
        `SELECT lease_expires_at
           FROM idempotency_records
          WHERE idempotency_key = $1`,
        [key.asString()],
      );
      const beforeMs = (before.rows[0].lease_expires_at as Date).getTime();

      await store.heartbeat(key);

      const after = await pool.query(
        `SELECT lease_expires_at
           FROM idempotency_records
          WHERE idempotency_key = $1`,
        [key.asString()],
      );
      const afterMs = (after.rows[0].lease_expires_at as Date).getTime();

      // The lease must be pushed out to roughly now + leaseDurationMs (30s),
      // not left to expire while the handler is still running.
      expect(afterMs).toBeGreaterThan(beforeMs + 5_000);
      expect(afterMs).toBeGreaterThan(Date.now() + 10_000);
    });

    it('Concurrent request while the first is processing returns 409, then replays', async () => {
      let started!: () => void;
      let release!: () => void;
      const startedPromise = new Promise<void>(resolve => {
        started = resolve;
      });
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });

      app.post(
        '/v1/gated',
        idempotencyMiddleware(store),
        async (_req: Request, res: express.Response) => {
          started();
          await gate;
          res.status(200).json({ gated: true });
        },
      );

      // Dispatch the first request without awaiting it, so the handler runs
      // (and holds a live lease) while we probe concurrency with `second`.
      const first = request(app)
        .post('/v1/gated')
        .set('Idempotency-Key', 'key-gated')
        .send(validBody)
        .then(res => res);

      // Wait until the first handler is actually in flight (lease live).
      await startedPromise;

      const second = await request(app)
        .post('/v1/gated')
        .set('Idempotency-Key', 'key-gated')
        .send(validBody);

      expect(second.status).toBe(409);
      expect(second.body.error).toContain('processed');

      release();
      const firstRes = await first;
      expect(firstRes.status).toBe(200);

      const third = await request(app)
        .post('/v1/gated')
        .set('Idempotency-Key', 'key-gated')
        .send(validBody);

      expect(third.status).toBe(200);
      expect(third.headers['x-idempotent-replayed']).toBe('true');
      expect(third.body.gated).toBe(true);
    });

    it('Concurrent tryAcquire on an expired lease: exactly one request wins', async () => {
      const key = IdempotencyKey.fromHeaders({
        headers: { 'idempotency-key': 'key-race' },
      } as unknown as Request);
      const fingerprint = RequestFingerprint.fromBody(validBody);

      await pool.query(
        `
          INSERT INTO idempotency_records (
            idempotency_key,
            request_fingerprint,
            status,
            lease_expires_at
          )
          VALUES ($1, $2, 'processing', now() - interval '1 minute')
        `,
        ['key-race', fingerprint.asString()],
      );

      const results = await Promise.all([
        store.tryAcquire(key, fingerprint),
        store.tryAcquire(key, fingerprint),
      ]);

      // An abandoned lease must never let two handlers run concurrently.
      const winners = results.filter(r => r === undefined).length;
      expect(winners).toBe(1);

      const record = results.find(r => r !== undefined);
      expect(record).toBeDefined();
      expect(record!.status).toBe('processing');
      expect(record!.leaseExpiresAt).not.toBeNull();
      expect((record!.leaseExpiresAt as Date).getTime()).toBeGreaterThan(
        Date.now(),
      );
    });

    it('GET /v1/transactions/:hash returns 404', async () => {
      const res = await request(app).get('/v1/transactions/some-hash');

      expect(res.status).toBe(404);
    });

    it('Handles request body with arrays for fingerprinting', async () => {
      const bodyWithArray = {
        transactionXdr: 'AAAA',
        args: [1, 2, 3],
      };

      const res = await request(app)
        .post('/v1/transactions/submit')
        .set('Idempotency-Key', 'key-array')
        .send(bodyWithArray);

      expect(res.status).toBe(200);
    });

    it('Too long key returns 400', async () => {
      const longKey = 'a'.repeat(129);

      const res = await request(app)
        .post('/v1/transactions/submit')
        .set('Idempotency-Key', longKey)
        .send(validBody);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('maximum length');
    });

    it('Cleanup deletes expired records', async () => {
      await pool.query(
        `
          INSERT INTO idempotency_records (
            idempotency_key,
            request_fingerprint,
            status,
            created_at,
            updated_at
          )
          VALUES (
                   $1,
                   $2,
                   'succeeded',
                   now() - interval '48 hours',
                   now() - interval '48 hours'
                 )
        `,
        ['expired-key', 'fake-fingerprint'],
      );

      const deleted = await store.cleanup(24);

      expect(deleted).toBe(1);
    });
  },
);
