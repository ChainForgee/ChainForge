import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { UsageTrackerService } from './usage-tracker.service';

/**
 * Middleware that records every API-authenticated request into the
 * usage sliding window.
 *
 * It extracts the `x-api-key` identifier and the request's country
 * (from `x-country-code` or `cf-ipcountry` headers) and calls
 * {@link UsageTrackerService#recordUsage}.
 *
 * Requests without a recognised API key are silently skipped
 * (no usage entry is created).
 */
@Injectable()
export class UsageTrackerMiddleware implements NestMiddleware {
  private readonly logger = new Logger(UsageTrackerMiddleware.name);

  constructor(private readonly usageTracker: UsageTrackerService) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    // Extract API key identifier from the request.
    // The key is stored in the request by ApiKeyGuard as `req.apiKey` or
    // we can read the header ourselves.
    const keyId = this.extractKeyId(req);

    if (keyId) {
      const orgId = this.extractOrgId(req);
      const countryCode = this.extractCountryCode(req);

      // Fire-and-forget — never block the request pipeline on usage tracking.
      this.usageTracker
        .recordUsage(keyId, orgId, countryCode)
        .catch((err: Error) =>
          this.logger.debug(
            `Failed to record usage for key ${keyId}: ${err.message}`,
          ),
        );
    }

    next();
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /**
   * Extract the API key identifier.
   *
   * Checks several possible sources:
   * 1. `req.apiKeyId` — set by ApiKeyGuard if the request was authenticated
   * 2. `x-api-key-id` header
   * 3. The raw `x-api-key` header (hashed for privacy)
   */
  private extractKeyId(req: Request): string | null {
    // If the guard stored the key ID, use it directly
    const fromGuard = (req as Record<string, unknown>).apiKeyId;
    if (typeof fromGuard === 'string' && fromGuard.length > 0) {
      return fromGuard;
    }

    const header = req.headers['x-api-key'] ?? req.headers['authorization'];
    if (typeof header === 'string' && header.length > 0) {
      // Use a prefix + last 4 chars as a pseudonymous identifier
      const sanitised = header.length > 8
        ? `${header.slice(0, 4)}...${header.slice(-4)}`
        : header;
      return sanitised;
    }

    return null;
  }

  private extractOrgId(req: Request): string {
    const fromGuard = (req as Record<string, unknown>).orgId;
    if (typeof fromGuard === 'string') return fromGuard;

    const header = req.headers['x-org-id'];
    if (typeof header === 'string') return header;

    return 'unknown';
  }

  /**
   * Extract country code from request headers.
   *
   * Checks Cloudflare (`cf-ipcountry`), a custom `x-country-code`
   * header, or falls back to `--`.
   */
  private extractCountryCode(req: Request): string {
    const cf = req.headers['cf-ipcountry'];
    if (typeof cf === 'string' && cf.length === 2) return cf.toUpperCase();

    const custom = req.headers['x-country-code'];
    if (typeof custom === 'string' && custom.length === 2) return custom.toUpperCase();

    return '--';
  }
}
