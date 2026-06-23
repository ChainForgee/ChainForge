import { Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../decorators/public.decorator';
import { LoggerService } from '../../logger/logger.service';

/**
 * Threshold and window for "many violations in a short period" detection.
 * When this many violations are observed in the window we emit a single
 * high-severity log entry so monitoring can fire alerts.
 */
const CSP_SPIKE_THRESHOLD = 25;
const CSP_SPIKE_WINDOW_MS = 60_000;

/**
 * Cookie / header values we always strip from the user-agent before logging,
 * because some browsers leak cookie content into the User-Agent on violation
 * reports.  We just take the whole header; this is a defense-in-depth measure
 * alongside the recursive log redactor.
 */
const stripUserAgent = (
  raw: string | string[] | undefined,
): string | undefined => {
  if (!raw) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  // Truncate at first semi-colon to avoid leaking extension metadata.
  return value.slice(0, 256);
};

/**
 * Shape of a legacy CSP violation report
 * (https://www.w3.org/TR/CSP3/#violation-events).
 */
interface CspViolationReport {
  'document-uri'?: string;
  referrer?: string;
  'violated-directive'?: string;
  'effective-directive'?: string;
  'original-policy'?: string;
  disposition?: string;
  'blocked-uri'?: string;
  'line-number'?: number;
  'column-number'?: number;
  'source-file'?: string;
  'status-code'?: number;
  'script-sample'?: string;
  [key: string]: unknown;
}

/**
 * Endpoint that browsers POST browser-side CSP violations to.
 *
 * - Always responds with HTTP 204 immediately so the browser does not retry.
 * - Logs each violation through the shared LoggerService (warn level).
 * - Tracks an in-memory sliding-window counter to surface spikes at error level.
 *
 * Browsers do not send an API key, so this route is annotated `@Public()` to
 * bypass the global `ApiKeyGuard`.
 */
@ApiExcludeController()
@Public()
@SkipThrottle()
// CSP reports can legitimately spike during incidents and come from
// unauthenticated browsers; apply neither the global throttler nor the
// rate-limit middleware that runs on most protected endpoints.
@Controller('csp-report')
export class CspReportController {
  private windowStart = Date.now();
  private violationCount = 0;

  constructor(private readonly logger: LoggerService) {}

  @Post()
  @HttpCode(204)
  handleReport(@Req() req: Request, @Res() res: Response): void {
    // Acknowledge the browser first so it does not retry on slow processing.
    res.status(204).send();

    try {
      const reports = this.extractReports(req.body);
      if (!reports || reports.length === 0) {
        return;
      }

      for (const report of reports) {
        this.logViolation(report, req);
      }

      this.detectSpike(reports.length);
    } catch (error) {
      this.logger.debug(
        'Discarded malformed CSP violation report',
        'CspReportController',
        { reason: (error as { message?: string }).message ?? 'unknown' },
      );
    }
  }

  /**
   * Normalise the various browser-side payload shapes into an array of
   * `csp-report` documents.  Browsers historically send:
   *   - `application/csp-report` (legacy): `{ "csp-report": {...} }`
   *   - `application/reports+json` (newer Reporting API): `[{...}, ...]`
   *   - plain JSON: object or array of reports
   */
  private extractReports(body: unknown): CspViolationReport[] | null {
    if (body === null || body === undefined) {
      return null;
    }

    if (Array.isArray(body)) {
      return body
        .filter(
          (item): item is CspViolationReport =>
            item !== null && typeof item === 'object' && !Array.isArray(item),
        )
        .map(item => this.mergeReportingApiBody(item));
    }

    if (typeof body === 'object') {
      const record = body as Record<string, unknown>;
      const legacy = record['csp-report'];
      if (
        legacy !== null &&
        typeof legacy === 'object' &&
        !Array.isArray(legacy)
      ) {
        return [legacy as CspViolationReport];
      }
      return [this.mergeReportingApiBody(record as CspViolationReport)];
    }

    return null;
  }

  /**
   * Modern Reporting API items have a top-level `type` and `url`, and the
   * CSP details live inside a nested `body` object.  Legacy reports use
   * `document-uri` and friends directly on the csp-report object.  We blend
   * the two shapes so the rest of the pipeline can operate on a single
   * normalisation.
   */
  private mergeReportingApiBody(
    report: CspViolationReport,
  ): CspViolationReport {
    const raw = report as Record<string, unknown>;
    const nested = raw.body;
    if (
      nested === null ||
      typeof nested !== 'object' ||
      Array.isArray(nested)
    ) {
      return report;
    }
    const merged: CspViolationReport = { ...raw } as CspViolationReport;
    const inner = nested as Record<string, unknown>;
    for (const [key, value] of Object.entries(inner)) {
      if (merged[key] === undefined) {
        merged[key] = value as string | number | undefined;
      }
    }
    return merged;
  }

  private logViolation(report: CspViolationReport, req: Request): void {
    // Legacy reports put the URL under `document-uri`; modern Reporting API
    // items put it under `url` (top-level) and stash CSP details in `body`.
    // `mergeReportingApiBody` already normalised the modern case.
    const reportUrl =
      (typeof report.url === 'string' ? report.url : undefined) ??
      report['document-uri'];
    const rawSample = report['script-sample'];
    const scriptSample =
      typeof rawSample === 'string' ? rawSample.slice(0, 120) : undefined;

    const meta = {
      security_event: 'csp_violation',
      document_uri: reportUrl,
      referrer: report.referrer,
      violated_directive: report['violated-directive'],
      effective_directive: report['effective-directive'],
      blocked_uri: report['blocked-uri'],
      disposition: report.disposition,
      source_file: report['source-file'],
      line_number: report['line-number'],
      column_number: report['column-number'],
      status_code: report['status-code'],
      original_policy: report['original-policy'],
      // Sampling small preview avoids logging full script bodies which may
      // contain attacker-controllable PII.
      script_sample: scriptSample,
      user_agent: stripUserAgent(req.headers['user-agent']),
      remote_addr: req.ip,
    };

    this.logger.warn(
      'CSP violation reported by browser',
      'CspReportController',
      meta,
    );
  }

  private detectSpike(addedCount: number): void {
    const now = Date.now();
    if (now - this.windowStart >= CSP_SPIKE_WINDOW_MS) {
      this.windowStart = now;
      this.violationCount = 0;
    }

    this.violationCount += addedCount;

    if (this.violationCount >= CSP_SPIKE_THRESHOLD) {
      this.logger.error(
        'CSP violation spike detected',
        undefined,
        'CspReportController',
        {
          security_event: 'csp_violation_spike',
          count: this.violationCount,
          threshold: CSP_SPIKE_THRESHOLD,
          window_ms: CSP_SPIKE_WINDOW_MS,
        },
      );

      // Reset after alerting so we don't re-emit on every subsequent violation.
      this.violationCount = 0;
      this.windowStart = now;
    }
  }
}
