import { Request, Response, NextFunction } from 'express';
import { IdempotencyStore } from './store';
import { IdempotencyKey } from './key';
import { RequestFingerprint } from './fingerprint';
import {
  IdempotencyError,
  FingerprintMismatchError,
  AlreadyProcessingError,
} from './error';

export function idempotencyMiddleware(store: IdempotencyStore) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // 1. Parse Key
      const key = IdempotencyKey.fromHeaders(req);

      // 2. Fingerprint Body
      const fingerprint = RequestFingerprint.fromBody(req.body);

      // 3. Check Store
      const existingRecord = await store.tryAcquire(key, fingerprint);

      if (!existingRecord) {
        // First time (or an abandoned lease was re-acquired): intercept the
        // response to cache it, and keep the processing lease alive while the
        // handler runs so a slow request is never mistaken for an abandoned
        // one.
        const originalSend = res.send.bind(res);

        const heartbeatMs = Math.max(1, Math.floor(store.leaseDurationMs / 2));
        const heartbeat = setInterval(() => {
          store
            .heartbeat(key)
            .catch(err =>
              console.error(
                `Failed to refresh idempotency lease for key ${key.asString()}:`,
                err,
              ),
            );
        }, heartbeatMs);
        heartbeat.unref?.();

        const stopHeartbeat = () => clearInterval(heartbeat);
        res.once('close', stopHeartbeat);

        // Persist the result BEFORE the response is delivered, so a retry with
        // the same key can never observe `processing` after the first request
        // has responded. The write is deferred until the record is committed;
        // failures are logged, never thrown at the client.
        res.send = (body: any) => {
          stopHeartbeat();
          const status = res.statusCode;
          const recordStatus =
            status >= 200 && status < 300 ? 'succeeded' : 'failed';
          const bodyString =
            typeof body === 'string' ? body : JSON.stringify(body);

          void store
            .complete(key, recordStatus, status, bodyString)
            .catch(err =>
              console.error(
                `Failed to save idempotency record for key ${key.asString()}:`,
                err,
              ),
            )
            .finally(() => {
              try {
                originalSend(body);
              } catch (err) {
                console.error(
                  `Failed to deliver response for key ${key.asString()}:`,
                  err,
                );
              }
            });

          return res;
        };

        return next();
      }

      // Existing Record Found
      if (existingRecord.requestFingerprint !== fingerprint.asString()) {
        throw new FingerprintMismatchError();
      }

      if (existingRecord.status === 'processing') {
        throw new AlreadyProcessingError();
      }

      // Replay cached response
      res.setHeader('X-Idempotent-Replayed', 'true');
      res.status(existingRecord.responseStatus ?? 500);

      const bodyString = existingRecord.responseBody?.toString('utf-8') ?? '';
      try {
        res.json(JSON.parse(bodyString));
      } catch {
        res.send(bodyString);
      }
    } catch (error) {
      if (error instanceof IdempotencyError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      next(error);
    }
  };
}
