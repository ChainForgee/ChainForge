import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';

/**
 * CSRF Protection Middleware
 *
 * Implements a double-submit-cookie pattern:
 *  1. For safe methods (GET, HEAD, OPTIONS), the middleware sets a
 *     cryptographically-random `csrf-token` cookie on the response.
 *  2. For state-changing methods (POST, PUT, PATCH, DELETE), the middleware
 *     reads the token from both the `csrf-token` cookie AND the
 *     `X-CSRF-Token` request header, then compares them.  A mismatch (or
 *     absence of either value) causes a 403.
 *
 * This middleware is a *future-proofing* gate.  Currently ChainForge uses
 * API-key / custom-header authentication exclusively, so browsers never
 * auto-attach credentials cross-origin and CSRF is not exploitable today.
 * The middleware is gated behind the `CSRF_PROTECTION_ENABLED` environment
 * variable so it has zero overhead until the threat model changes.
 *
 * Reference: docs/security/csrf-posture.md
 */

export const CSRF_COOKIE_NAME = 'csrf-token';
export const CSRF_HEADER_NAME = 'x-csrf-token';

/** Safe methods – no CSRF check needed */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Methods that must carry a valid CSRF token */
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function generateCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CsrfMiddleware.name);
  private readonly enabled: boolean;
  private readonly cookieOptions: {
    httpOnly: boolean;
    sameSite: 'lax' | 'strict' | 'none';
    secure: boolean;
    path: string;
  };

  constructor(config: ConfigService) {
    this.enabled = config.get<string>('CSRF_PROTECTION_ENABLED', 'false') === 'true';
    const isProduction = config.get<string>('NODE_ENV') === 'production';

    this.cookieOptions = {
      httpOnly: false,  // Client-side JS must read via document.cookie to set X-CSRF-Token header
      sameSite: isProduction ? 'strict' : 'lax',
      secure: isProduction,
      path: '/',
    };

    if (this.enabled) {
      this.logger.log('CSRF protection is ENABLED');
    }
  }

  use(req: Request, res: Response, next: NextFunction): void {
    if (!this.enabled) {
      // Feature flag is off – pass through without any CSRF validation.
      // The code still sets the cookie for forward compatibility, but does
      // not enforce the header check.
      if (!(req.cookies as Record<string, string>)?.[CSRF_COOKIE_NAME]) {
        const token = generateCsrfToken();
        res.cookie(CSRF_COOKIE_NAME, token, this.cookieOptions);
      }
      next();
      return;
    }

    const method = (req.method ?? 'GET').toUpperCase();

    if (SAFE_METHODS.has(method)) {
      // Ensure every response carries a token cookie for subsequent
      // state-changing requests issued by the same origin.
      const existing = (req.cookies as Record<string, string>)?.[CSRF_COOKIE_NAME] as string | undefined;
      res.cookie(CSRF_COOKIE_NAME, existing ?? generateCsrfToken(), this.cookieOptions);
      next();
      return;
    }

    if (STATE_CHANGING_METHODS.has(method)) {
      const cookieToken = (req.cookies as Record<string, string>)?.[CSRF_COOKIE_NAME] as string | undefined;
      const headerToken = req.headers[CSRF_HEADER_NAME] as string | undefined;

      if (!cookieToken || !headerToken) {
        this.logger.warn(
          `CSRF validation failed for ${method} ${req.path}: missing token(s)`,
        );
        res.status(403).json({
          statusCode: 403,
          error: 'Forbidden',
          message: 'CSRF token missing',
        });
        return;
      }

      // Constant-time comparison to prevent timing attacks
      if (cookieToken.length !== headerToken.length) {
        this.logger.warn(
          `CSRF validation failed for ${method} ${req.path}: token length mismatch`,
        );
        res.status(403).json({
          statusCode: 403,
          error: 'Forbidden',
          message: 'CSRF token mismatch',
        });
        return;
      }

      let mismatch = 0;
      for (let i = 0; i < cookieToken.length; i++) {
        mismatch |= cookieToken.charCodeAt(i) ^ headerToken.charCodeAt(i);
      }

      if (mismatch !== 0) {
        this.logger.warn(
          `CSRF validation failed for ${method} ${req.path}: token value mismatch`,
        );
        res.status(403).json({
          statusCode: 403,
          error: 'Forbidden',
          message: 'CSRF token mismatch',
        });
        return;
      }

      // Token is valid – rotate it for forward secrecy
      const newToken = generateCsrfToken();
      res.cookie(CSRF_COOKIE_NAME, newToken, this.cookieOptions);
    }

    next();
  }
}
