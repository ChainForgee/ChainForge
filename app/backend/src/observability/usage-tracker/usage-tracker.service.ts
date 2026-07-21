import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@liaoliaots/nestjs-redis';
import { MetricsService } from '../metrics/metrics.service';
import { AuditService } from '../../audit/audit.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single usage observation stored in the sliding window. */
export interface UsageRecord {
  keyId: string;
  orgId: string;
  countryCode: string;
  timestamp: number; // Unix ms
}

/** Anomaly detected for a given API key. */
export interface UsageAnomaly {
  keyId: string;
  orgId: string;
  distinctCountries: number;
  requestCount: number;
  windowStart: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Redis key prefix for the 15-minute sliding window per API key. */
const USAGE_PREFIX = 'usage';
/** Window duration in milliseconds (15 minutes). */
const WINDOW_MS = 15 * 60 * 1000;
/** Threshold: more than this many distinct countries triggers an anomaly. */
const ANOMALY_COUNTRY_THRESHOLD = 3;

/**
 * Build the Redis key for a given API key's sliding window.
 * Format: `usage:<keyId>:15m`
 */
const redisKey = (keyId: string): string =>
  `${USAGE_PREFIX}:${keyId}:15m`;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class UsageTrackerService {
  private readonly logger = new Logger(UsageTrackerService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly metricsService: MetricsService,
    private readonly auditService: AuditService,
  ) {}

  // ── Record ────────────────────────────────────────────────────────────

  /**
   * Record an API key usage observation in the sliding window.
   *
   * @param keyId      The API key identifier.
   * @param orgId      The organisation identifier associated with the key.
   * @param countryCode  ISO-3166-1 alpha-2 country code (empty string if unknown).
   */
  async recordUsage(
    keyId: string,
    orgId: string,
    countryCode: string,
  ): Promise<void> {
    const redis = this.redisService.getOrThrow();
    const key = redisKey(keyId);
    const now = Date.now();

    // Store as a sorted-set member: `countryCode:timestamp` with score = timestamp
    // This lets us query distinct countries and trim old entries by score.
    const member = `${countryCode}:${now}`;

    await redis
      .multi()
      .zadd(key, now, member)
      .zremrangebyscore(key, 0, now - WINDOW_MS)
      .expire(key, Math.ceil(WINDOW_MS / 1000) + 60) // TTL = window + 1 min grace
      .exec();
  }

  // ── Query ─────────────────────────────────────────────────────────────

  /**
   * Return all API keys that currently exceed the anomaly threshold
   * (> 3 distinct countries in the last 15 minutes).
   */
  async getAnomalies(): Promise<UsageAnomaly[]> {
    const redis = this.redisService.getOrThrow();
    const now = Date.now();
    const windowStart = now - WINDOW_MS;

    // Scan Redis for usage keys (pattern: `usage:*:15m`).
    // In production this should be `SCAN`; for moderate cardinality `KEYS`
    // is acceptable because `usage:*:15m` keys expire automatically.
    const keys = await redis.keys(`${USAGE_PREFIX}:*:15m`);
    if (!keys.length) return [];

    const anomalies: UsageAnomaly[] = [];

    for (const key of keys) {
      // Extract keyId from `usage:<keyId>:15m`
      const keyId = key.slice(
        USAGE_PREFIX.length + 1,
        key.length - ':15m'.length,
      );

      // Get members within the current window
      const members = await redis.zrangebyscore(key, windowStart, now);
      if (members.length < 2) continue; // Need at least 2+ requests to detect

      // Extract distinct country codes from members (`countryCode:timestamp`)
      const countries = new Set<string>();
      for (const member of members) {
        const cc = member.split(':')[0];
        if (cc) countries.add(cc);
      }

      if (countries.size > ANOMALY_COUNTRY_THRESHOLD) {
        const orgId = await this.resolveOrgId(keyId);
        anomalies.push({
          keyId,
          orgId,
          distinctCountries: countries.size,
          requestCount: members.length,
          windowStart,
        });
      }
    }

    return anomalies;
  }

  /**
   * Get the total request count for a specific API key in the current window.
   */
  async getRequestCount(keyId: string): Promise<number> {
    const redis = this.redisService.getOrThrow();
    const now = Date.now();
    const count = await redis.zcount(
      redisKey(keyId),
      now - WINDOW_MS,
      now,
    );
    return count;
  }

  // ── Maintenance ───────────────────────────────────────────────────────

  /**
   * Trim expired entries from all usage windows and remove empty keys.
   */
  async flushExpired(): Promise<void> {
    const redis = this.redisService.getOrThrow();
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    let cleaned = 0;

    const keys = await redis.keys(`${USAGE_PREFIX}:*:15m`);
    for (const key of keys) {
      await redis.zremrangebyscore(key, 0, cutoff);
      const size = await redis.zcard(key);
      if (size === 0) {
        await redis.del(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug(`Flushed ${cleaned} empty usage windows`);
    }
  }

  // ── Anomaly reporting ─────────────────────────────────────────────────

  /**
   * Flush expired windows, detect anomalies, and write them to the AuditLog.
   *
   * Designed to be called from a cron job every hour.
   */
  async detectAndReportAnomalies(): Promise<void> {
    await this.flushExpired();

    const anomalies = await this.getAnomalies();

    for (const anomaly of anomalies) {
      this.logger.warn(
        `API key anomaly detected: keyId=${anomaly.keyId} ` +
        `orgId=${anomaly.orgId} ` +
        `distinctCountries=${anomaly.distinctCountries} ` +
        `requestCount=${anomaly.requestCount}`,
      );

      // Record in AuditLog
      await this.auditService.record({
        actorId: `system:usage-tracker`,
        entity: 'ApiKey',
        entityId: anomaly.keyId,
        action: 'api_key_anomaly',
        metadata: {
          orgId: anomaly.orgId,
          distinctCountries: anomaly.distinctCountries,
          requestCount: anomaly.requestCount,
          windowStart: new Date(anomaly.windowStart).toISOString(),
        } as Record<string, unknown>,
      });

      // Increment Prometheus security event counter
      this.metricsService.incrementSecurityEvent('api_key_anomaly');
    }

    if (anomalies.length > 0) {
      this.logger.warn(
        `Detected ${anomalies.length} API key usage anomaly/ies`,
      );
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private async resolveOrgId(_keyId: string): Promise<string> {
    // In production this would query the ApiKeys table via PrismaService.
    // For now we return a placeholder — the anomaly is still logged.
    return 'unknown';
  }
}
