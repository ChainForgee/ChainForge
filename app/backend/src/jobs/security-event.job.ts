import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UsageTrackerService } from '../observability/usage-tracker/usage-tracker.service';

/**
 * Scheduled job that runs every hour to:
 * 1. Flush expired usage windows from Redis.
 * 2. Detect API key usage anomalies (> 3 distinct countries in 15 min).
 * 3. Report anomalies to the AuditLog.
 *
 * @see UsageTrackerService#detectAndReportAnomalies
 */
@Injectable()
export class SecurityEventJob {
  private readonly logger = new Logger(SecurityEventJob.name);

  constructor(
    private readonly usageTracker: UsageTrackerService,
  ) {}

  /**
   * Run every hour on the hour.
   * The underlying {@link UsageTrackerService#detectAndReportAnomalies}
   * handles the actual detection and audit-logging.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async detectAnomalies(): Promise<void> {
    this.logger.log('Running scheduled API key anomaly detection…');
    try {
      await this.usageTracker.detectAndReportAnomalies();
    } catch (error) {
      this.logger.error(
        `Anomaly detection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
