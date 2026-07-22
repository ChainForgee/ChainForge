import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ApiKeyUsageTrackerService } from '../observability/usage-tracker/api-key-usage-tracker.service';
import { AuditService } from '../audit/audit.service';

/**
 * Scheduled job that flushes API key usage windows and writes security
 * events to the AuditLog when anomalies are detected.
 *
 * Runs every hour by default. The `@Cron` decorator ensures only one
 * instance executes across a cluster when using a distributed lock
 * (via `@nestjs/schedule`'s `BullMQ` integration or singleton mode).
 */
@Injectable()
export class SecurityEventJob {
  private readonly logger = new Logger(SecurityEventJob.name);

  constructor(
    private readonly usageTracker: ApiKeyUsageTrackerService,
    private readonly auditService: AuditService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async flushUsageWindows(): Promise<void> {
    try {
      this.logger.log('Flushing API key usage windows for security events');

      const anomalies = await this.usageTracker.flushAllWindows();

      for (const anomaly of anomalies) {
        await this.auditService.record({
          actorId: `apikey:${anomaly.keyId}`,
          entity: 'ApiKey',
          entityId: anomaly.keyId,
          action: 'security_anomaly',
          metadata: {
            kind: 'api_key_anomaly',
            distinctCountries: anomaly.distinctCountries,
            countries: anomaly.countries,
            orgId: anomaly.orgId,
            windowStart: anomaly.windowStart.toISOString(),
            windowEnd: anomaly.windowEnd.toISOString(),
          },
        });

        this.logger.warn(
          `Security event recorded: keyId=${anomaly.keyId}, ` +
            `countries=${anomaly.distinctCountries}, ` +
            `window=${anomaly.windowStart.toISOString()} → ${anomaly.windowEnd.toISOString()}`,
        );
      }

      if (anomalies.length === 0) {
        this.logger.debug('No API key anomalies detected during flush');
      } else {
        this.logger.warn(
          `Recorded ${anomalies.length} security event(s) from usage flush`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Security event flush failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }
}
