import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { RedisService } from '../../cache/redis.service';
import { MetricsService } from '../observability/metrics/metrics.service';
import { CspViolationDetails } from './dto/csp-report.dto';

const DEDUP_TTL_SECONDS = 3600; // 1 hour deduplication window

@Injectable()
export class CspReportService {
  private readonly logger = new Logger(CspReportService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Process a CSP violation report.
   *
   * Deduplicates reports by (sourceFile, lineNumber, blockedUri) to prevent
   * double-counting when the same violation is reported multiple times.
   *
   * @returns true if the report was new and processed, false if it was a duplicate
   */
  async processReport(report: CspViolationDetails): Promise<boolean> {
    const dedupKey = this.buildDedupKey(report);
    const isDuplicate = await this.checkAndMarkSeen(dedupKey);

    if (isDuplicate) {
      this.logger.debug(`Duplicate CSP report ignored: ${dedupKey}`);
      return false;
    }

    const directive = report['effective-directive'] ?? report['violated-directive'] ?? 'unknown';
    this.metrics.incrementCspViolation(directive);

    this.logger.log({
      message: 'CSP violation reported',
      directive,
      blockedUri: report['blocked-uri'],
      sourceFile: report['source-file'],
      lineNumber: report['line-number'],
      documentUri: report['document-uri'],
    });

    return true;
  }

  /**
   * Build a deduplication key from the report fields that uniquely identify
   * a violation: sourceFile, lineNumber, and blockedUri.
   */
  private buildDedupKey(report: CspViolationDetails): string {
    const components = [
      report['source-file'] ?? '',
      String(report['line-number'] ?? ''),
      report['blocked-uri'] ?? '',
    ].join('|');

    const hash = createHash('sha256').update(components).digest('hex').slice(0, 16);
    return `csp:dedup:${hash}`;
  }

  /**
   * Check if a report with this key has been seen recently.
   * If not, mark it as seen with a TTL.
   *
   * @returns true if the key was already seen (duplicate), false if new
   */
  private async checkAndMarkSeen(key: string): Promise<boolean> {
    const existing = await this.redis.get<number>(key);
    if (existing !== null) {
      return true;
    }

    await this.redis.set(key, 1, DEDUP_TTL_SECONDS);
    return false;
  }
}
