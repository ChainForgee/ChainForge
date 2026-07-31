import { Injectable, Logger } from '@nestjs/common';
import { MetricsService } from '../metrics/metrics.service';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const WINDOW_SECONDS = WINDOW_MS / 1000;

export interface UsageEntry {
  country: string;
  timestamp: number;
}

export interface AnomalyEvent {
  keyId: string;
  orgId: string | null;
  distinctCountries: number;
  countries: string[];
  windowStart: Date;
  windowEnd: Date;
}

/**
 * Redis-backed sliding-window usage aggregator for API keys.
 *
 * Tracks distinct (country, timestamp) pairs per API key within a 15-minute
 * window. When the number of distinct countries exceeds a configurable
 * threshold (default: 3), emits a security event into the AuditLog and
 * increments the `security_event_total{kind=api_key_anomaly}` counter.
 *
 * Redis key pattern: `apikey:usage:<keyId>:15m` (sorted set, score = timestamp)
 */
@Injectable()
export class ApiKeyUsageTrackerService {
  private readonly logger = new Logger(ApiKeyUsageTrackerService.name);
  private readonly threshold: number;
  private readonly redisClient: Redis;

  constructor(
    configService: ConfigService,
    private readonly metrics: MetricsService,
  ) {
    this.threshold = parseInt(
      configService.get<string>('API_KEY_ANOMALY_THRESHOLD', '3'),
      10,
    );

    this.redisClient = new Redis({
      host: configService.get<string>('REDIS_HOST', 'localhost'),
      port: parseInt(configService.get<string>('REDIS_PORT', '6379'), 10),
      maxRetriesPerRequest: 1,
      retryStrategy: times => (times <= 1 ? 200 : null),
      lazyConnect: true,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redisClient?.quit();
  }

  /**
   * Record an API key usage event.
   *
   * @param keyId     - The API key ID
   * @param orgId     - The organization ID (nullable)
   * @param country   - ISO 3166-1 alpha-2 country code from geo lookup
   * @returns AnomalyEvent if the threshold is exceeded, null otherwise
   */
  async recordUsage(
    keyId: string,
    orgId: string | null,
    country: string,
  ): Promise<AnomalyEvent | null> {
    const now = Date.now();
    const windowStart = now - WINDOW_MS;

    const usageKey = `apikey:usage:${keyId}:15m`;

    try {
      const multi = this.redisClient.multi();
      multi.zremrangebyscore(usageKey, '-inf', windowStart);
      multi.zadd(
        usageKey,
        now,
        `${country}:${now}:${Math.random().toString(36).slice(2, 8)}`,
      );
      multi.expire(usageKey, WINDOW_SECONDS);
      multi.zrangebyscore(usageKey, windowStart, '+inf');

      const results = await multi.exec();
      if (!results) {
        this.logger.warn('Redis multi execution returned null');
        return null;
      }

      const members = results[4] as string[];
      const countries = new Set<string>();
      if (Array.isArray(members)) {
        for (const member of members) {
          const countryPart = member.split(':')[0];
          if (countryPart) countries.add(countryPart);
        }
      }

      if (countries.size > this.threshold) {
        const anomaly: AnomalyEvent = {
          keyId,
          orgId,
          distinctCountries: countries.size,
          countries: Array.from(countries),
          windowStart: new Date(windowStart),
          windowEnd: new Date(now),
        };

        this.metrics.incrementSecurityEvent(
          'api_key_anomaly',
          keyId,
          orgId ?? 'none',
        );

        this.logger.warn(
          `API key anomaly detected: keyId=${keyId}, orgId=${orgId ?? 'none'}, countries=${countries.size} (threshold=${this.threshold})`,
        );

        return anomaly;
      }

      return null;
    } catch (err) {
      this.logger.warn(
        `Usage tracking failed for key ${keyId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Flush all active usage windows for anomaly events.
   * Called periodically by the security event job.
   */
  async flushAllWindows(): Promise<AnomalyEvent[]> {
    const anomalies: AnomalyEvent[] = [];
    try {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redisClient.scan(
          cursor,
          'MATCH',
          'apikey:usage:*:15m',
          'COUNT',
          100,
        );
        cursor = nextCursor;

        for (const key of keys) {
          const keyId = key.split(':')[2];
          if (!keyId) continue;

          const now = Date.now();
          const windowStart = now - WINDOW_MS;
          const members = await this.redisClient.zrangebyscore(
            key,
            windowStart,
            '+inf',
          );

          const countries = new Set<string>();
          for (const member of members) {
            const countryPart = member.split(':')[0];
            if (countryPart) countries.add(countryPart);
          }

          if (countries.size > this.threshold) {
            anomalies.push({
              keyId,
              orgId: null,
              distinctCountries: countries.size,
              countries: Array.from(countries),
              windowStart: new Date(windowStart),
              windowEnd: new Date(),
            });

            this.metrics.incrementSecurityEvent(
              'api_key_anomaly',
              keyId,
              'none',
            );
          }
        }
      } while (cursor !== '0');
    } catch (err) {
      this.logger.warn(
        `Flush failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return anomalies;
  }
}
