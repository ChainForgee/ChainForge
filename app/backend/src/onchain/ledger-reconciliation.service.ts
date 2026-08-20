import { Injectable, Inject, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  LEDGER_ON_CHAIN_SOURCE,
  LedgerOnChainSource,
} from './ledger-on-chain-source';

export interface ReconciliationJobData {
  startLedger: number;
  endLedger: number;
  campaignId?: string;
  thresholdPercent: number;
}

export interface ReconciliationDiscrepancy {
  ledger: number;
  type: 'missing' | 'amount_mismatch' | 'count_mismatch';
  expected: unknown;
  observed: unknown;
  severity: 'low' | 'medium' | 'high';
}

interface ReconciliationProgressSnapshot {
  startLedger?: number;
  endLedger?: number;
  totalLedgers?: number;
  checkedLedgers?: number;
  discrepancies?: ReconciliationDiscrepancy[];
  summary?: ReconciliationReport['summary'];
  actionable?: boolean;
}

export interface ReconciliationReport {
  jobId: string;
  startLedger: number;
  endLedger: number;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  totalLedgers: number;
  checkedLedgers: number;
  discrepancies: ReconciliationDiscrepancy[];
  summary: {
    totalDiscrepancies: number;
    bySeverity: { low: number; medium: number; high: number };
    byType: {
      missing: number;
      amount_mismatch: number;
      count_mismatch: number;
    };
  };
  actionable: boolean;
}

@Injectable()
export class LedgerReconciliationService {
  private readonly logger = new Logger(LedgerReconciliationService.name);

  /**
   * `BalanceLedger.amount` is `Decimal(38, 18)`. On-chain amounts are raw
   * integer token units (contract i128). Both are compared exactly by scaling
   * to a common 18-decimal integer representation — never through floats.
   */
  private static readonly AMOUNT_SCALE = 18n;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('onchain') private readonly onchainQueue: Queue,
    @Inject(LEDGER_ON_CHAIN_SOURCE)
    private readonly onChainSource: LedgerOnChainSource,
  ) {}

  async triggerReconciliation(
    startLedger: number,
    endLedger: number,
    campaignId?: string,
    thresholdPercent: number = 5,
  ): Promise<ReconciliationReport> {
    this.logger.log(
      `Triggering reconciliation for ledgers ${startLedger} to ${endLedger}`,
    );

    const totalLedgers = endLedger - startLedger + 1;

    const job = await this.onchainQueue.add(
      'ledger-reconciliation',
      {
        startLedger,
        endLedger,
        campaignId,
        thresholdPercent,
      } as ReconciliationJobData,
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: {
          count: 10,
          age: 3600,
        },
        removeOnFail: {
          count: 5,
          age: 7200,
        },
      },
    );

    return {
      jobId: job.id || 'unknown',
      startLedger,
      endLedger,
      status: 'queued',
      totalLedgers,
      checkedLedgers: 0,
      discrepancies: [],
      summary: {
        totalDiscrepancies: 0,
        bySeverity: { low: 0, medium: 0, high: 0 },
        byType: { missing: 0, amount_mismatch: 0, count_mismatch: 0 },
      },
      actionable: false,
    };
  }

  /**
   * Compare the database against the real on-chain event stream.
   *
   * Failure is loud: a source error (RPC failure, retention gap, range beyond
   * the chain head) or a source that returns zero entries rejects this method,
   * which fails the BullMQ job — the report is never a fabricated "completed"
   * with a vacuous comparison. In particular, zero on-chain entries never
   * degenerates into flagging every stored row as `missing` with `ledger: -1`.
   */
  async processReconciliation(
    data: ReconciliationJobData,
  ): Promise<ReconciliationReport> {
    const { startLedger, endLedger, campaignId, thresholdPercent } = data;
    const discrepancies: ReconciliationDiscrepancy[] = [];
    let checkedLedgers = 0;

    this.logger.log(
      `Processing reconciliation: ledgers ${startLedger}-${endLedger}`,
    );

    const onChainData = await this.onChainSource.fetchLedgerEntries(
      startLedger,
      endLedger,
    );

    if (onChainData.length === 0) {
      throw new Error(
        `On-chain source returned no entries for ledgers ${startLedger}-${endLedger}; ` +
          'refusing to flag stored rows as missing (job failed instead)',
      );
    }

    const storedEntries = await this.prisma.balanceLedger.findMany({
      where: campaignId ? { campaignId } : undefined,
      orderBy: { createdAt: 'asc' },
    });

    // On-chain entries with no stored counterpart: a genuine missing record.
    for (const onChainEntry of onChainData) {
      checkedLedgers++;

      const storedEntry = storedEntries.find(e => e.id === onChainEntry.id);

      if (!storedEntry) {
        discrepancies.push({
          ledger: onChainEntry.ledger,
          type: 'missing',
          expected: onChainEntry,
          observed: null,
          severity: 'high',
        });
        continue;
      }

      if (this.amountMismatchExceeds(
        onChainEntry.amount,
        storedEntry.amount,
        thresholdPercent,
      )) {
        discrepancies.push({
          ledger: onChainEntry.ledger,
          type: 'amount_mismatch',
          expected: onChainEntry.amount,
          observed: storedEntry.amount.toString(),
          severity: this.amountMismatchSeverity(
            onChainEntry.amount,
            storedEntry.amount,
            thresholdPercent,
          ),
        });
      }

      // Stored and on-chain event types are both in the BalanceLedger
      // vocabulary ('lock' / 'unlock' / 'disburse') — the source normalizes
      // contract event names (package_created, package_revoked, …) to it.
      if (onChainEntry.eventType !== storedEntry.eventType) {
        discrepancies.push({
          ledger: onChainEntry.ledger,
          type: 'count_mismatch',
          expected: onChainEntry.eventType,
          observed: storedEntry.eventType,
          severity: 'medium',
        });
      }
    }

    // Stored rows with no on-chain counterpart in the checked range. The
    // ledger number is genuinely unknown for stored rows (they carry no
    // ledger), so `-1` is used only here — never as a fabricated value.
    for (const storedEntry of storedEntries) {
      const onChainEntry = onChainData.find(e => e.id === storedEntry.id);
      if (!onChainEntry) {
        discrepancies.push({
          ledger: -1,
          type: 'missing',
          expected: null,
          observed: storedEntry,
          severity: 'medium',
        });
      }
    }

    const summary = this.calculateSummary(discrepancies);

    this.logger.log(
      `Reconciliation complete: ${checkedLedgers} on-chain entries checked, ${summary.totalDiscrepancies} discrepancies found`,
    );

    return {
      jobId: '',
      startLedger,
      endLedger,
      status: 'completed',
      totalLedgers: endLedger - startLedger + 1,
      checkedLedgers,
      discrepancies,
      summary,
      actionable: summary.bySeverity.high > 0 || summary.bySeverity.medium > 5,
    };
  }

  /**
   * Exact integer comparison of an on-chain raw amount against a stored
   * Decimal, in basis points (1/100 of a percent). `true` when the relative
   * difference exceeds `thresholdPercent`.
   */
  private amountMismatchExceeds(
    onChainAmount: string,
    storedAmount: Prisma.Decimal,
    thresholdPercent: number,
  ): boolean {
    const thresholdBps = BigInt(Math.round(thresholdPercent * 100));
    const expected = this.onChainAmountToBigInt(onChainAmount);
    const observed = this.decimalAmountToBigInt(storedAmount);
    const diff = expected > observed ? expected - observed : observed - expected;

    if (expected === 0n) {
      return diff > 0n;
    }
    return (diff * 10000n) / expected > thresholdBps;
  }

  private amountMismatchSeverity(
    onChainAmount: string,
    storedAmount: Prisma.Decimal,
    thresholdPercent: number,
  ): 'low' | 'medium' | 'high' {
    const thresholdBps = BigInt(Math.round(thresholdPercent * 100));
    const expected = this.onChainAmountToBigInt(onChainAmount);
    const observed = this.decimalAmountToBigInt(storedAmount);
    const diff = expected > observed ? expected - observed : observed - expected;
    if (expected === 0n) {
      return diff > 0n ? 'high' : 'low';
    }
    const bps = (diff * 10000n) / expected;
    return bps > thresholdBps * 2n ? 'high' : 'medium';
  }

  private onChainAmountToBigInt(raw: string): bigint {
    return BigInt(raw) * 10n ** LedgerReconciliationService.AMOUNT_SCALE;
  }

  /**
   * Exact conversion of the stored Decimal to a scaled BigInt. `toFixed(18)`
   * is lossless for `Decimal(38, 18)`; the absolute value is used because
   * `unlock` entries are stored negated while the on-chain event amount is
   * positive.
   */
  private decimalAmountToBigInt(amount: Prisma.Decimal): bigint {
    const fixed = amount.abs().toFixed(Number(LedgerReconciliationService.AMOUNT_SCALE));
    const [intPart, fracPart = ''] = fixed.split('.');
    return (
      BigInt(intPart) * 10n ** LedgerReconciliationService.AMOUNT_SCALE +
      BigInt(fracPart.padEnd(Number(LedgerReconciliationService.AMOUNT_SCALE), '0'))
    );
  }

  private calculateSummary(
    discrepancies: ReconciliationDiscrepancy[],
  ): ReconciliationReport['summary'] {
    const summary: ReconciliationReport['summary'] = {
      totalDiscrepancies: discrepancies.length,
      bySeverity: { low: 0, medium: 0, high: 0 },
      byType: { missing: 0, amount_mismatch: 0, count_mismatch: 0 },
    };

    for (const d of discrepancies) {
      summary.bySeverity[d.severity]++;
      summary.byType[d.type]++;
    }

    return summary;
  }

  async getReconciliationStatus(
    jobId: string,
  ): Promise<ReconciliationReport | null> {
    const job = await this.onchainQueue.getJob(jobId);

    if (!job) {
      return null;
    }

    const state = await job.getState();
    const progress = job.progress as ReconciliationProgressSnapshot | undefined;

    return {
      jobId: job.id || 'unknown',
      startLedger: progress?.startLedger || 0,
      endLedger: progress?.endLedger || 0,
      status: this.mapJobStateToStatus(state),
      totalLedgers: progress?.totalLedgers || 0,
      checkedLedgers: progress?.checkedLedgers || 0,
      discrepancies: progress?.discrepancies || [],
      summary: progress?.summary || {
        totalDiscrepancies: 0,
        bySeverity: { low: 0, medium: 0, high: 0 },
        byType: { missing: 0, amount_mismatch: 0, count_mismatch: 0 },
      },
      actionable: progress?.actionable || false,
    };
  }

  private mapJobStateToStatus(state: string): ReconciliationReport['status'] {
    switch (state) {
      case 'active':
        return 'processing';
      case 'completed':
        return 'completed';
      case 'failed':
        return 'failed';
      default:
        return 'queued';
    }
  }
}
