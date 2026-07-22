import { Logger } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';

const CSRF_COOKIE_NAME = '_csrf_token';
const CSRF_HEADER_NAME = 'x-csrf-token';
const CSRF_TOKEN_LENGTH = 32;
const CSRF_COOKIE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

const parseCookies = (
  raw: string | undefined,
): Record<string, string | undefined> => {
  if (!raw) return {};
  const result: Record<string, string | undefined> = {};
  for (const pair of raw.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key.length > 0) {
      result[key] = value;
    }
  }
  return result;
};

/**
 * Double-submit-cookie CSRF middleware.
 *
 * Guarded behind the `CSRF_PROTECTION_ENABLED` feature flag.
 * When disabled (the default), this middleware is a no-op passthrough,
 * preserving the existing posture where API-key / custom-header auth
 * makes CSRF moot.
 *
 * When enabled:
 *  1. Safe methods receive a random CSRF token in a cookie.
 *  2. Unsafe methods (POST, PUT, PATCH, DELETE) require the token to be
 *     echoed back in the `x-csrf-token` request header *and* match the
 *     value stored in the cookie.
 *
 * This is the "double-submit cookie" pattern — no server-side session
 * store is required.
 */
export const createCsrfMiddleware = (): RequestHandler => {
  const logger = new Logger('CsrfMiddleware');

  return (req: Request, res: Response, next: NextFunction) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const rawCookie = req.headers.cookie;
    const cookieStr = Array.isArray(rawCookie) ? rawCookie[0] : rawCookie;
    const cookies = parseCookies(cookieStr);

    // --- Issue a fresh token on safe methods ---
    if (SAFE_METHODS.has(method)) {
      const existingToken = cookies[CSRF_COOKIE_NAME];
      if (!existingToken || existingToken.length !== CSRF_TOKEN_LENGTH * 2) {
        const token = randomBytes(CSRF_TOKEN_LENGTH).toString('hex');
        res.cookie(CSRF_COOKIE_NAME, token, {
          httpOnly: false, // JS must read it to echo back
          sameSite: 'strict',
          secure: process.env.NODE_ENV === 'production',
          maxAge: CSRF_COOKIE_MAX_AGE_MS,
          path: '/',
        });
      }
      return next();
    }

    // --- Validate on unsafe methods ---
    const cookieToken = cookies[CSRF_COOKIE_NAME];
    const rawHeader = req.headers[CSRF_HEADER_NAME];
    const headerToken = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    if (!cookieToken || !headerToken) {
      logger.warn(
        `CSRF validation failed: missing token (cookie=${Boolean(cookieToken)}, header=${Boolean(headerToken)})`,
      );
      res.status(403).json({
        statusCode: 403,
        message: 'CSRF token missing',
      });
      return;
    }

    // Constant-time comparison to prevent timing attacks
    if (
      cookieToken.length !== headerToken.length ||
      !timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken))
    ) {
      logger.warn('CSRF validation failed: token mismatch');
      res.status(403).json({
        statusCode: 403,
        message: 'CSRF token mismatch',
      });
      return;
    }

    next();
  };
};
