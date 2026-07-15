import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../prisma/prisma.service';

/**
 * BalanceLedgerSnapshotJob
 *
 * Runs every hour (configurable via BALANCE_SNAPSHOT_CRON).
 * For every campaign that has at least one BalanceLedger entry in the last
 * 24 hours, it computes Σ amount and writes a BalanceLedgerSnapshot row.
 *
 * The snapshot captures the running total of *all* ledger entries inside the
 * 24-hour window ending at the moment the job fires.
 */
@Injectable()
export class BalanceLedgerSnapshotJob {
  private readonly logger = new Logger(BalanceLedgerSnapshotJob.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Exposed for direct invocation from tests and manual triggers.
   * Returns the number of snapshots written.
   */
  async run(): Promise<number> {
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);

    this.logger.log(
      `Running balance-ledger snapshot ` +
        `[${windowStart.toISOString()} → ${windowEnd.toISOString()}]`,
    );

    // Aggregate per campaign for the 24 h window
    const rows = await this.prisma.balanceLedger.groupBy({
      by: ['campaignId'],
      where: {
        createdAt: { gte: windowStart, lte: windowEnd },
      },
      _sum: { amount: true },
    });

    if (rows.length === 0) {
      this.logger.log('No ledger activity in the last 24 h — nothing to snapshot.');
      return 0;
    }

    // Persist one snapshot row per active campaign
    const snapshots = rows.map(row => ({
      campaignId: row.campaignId,
      totalLocked: (row._sum.amount ?? new Decimal(0)) as Decimal,
      snapshotAt: windowEnd,
    }));

    await this.prisma.balanceLedgerSnapshot.createMany({
      data: snapshots,
    });

    this.logger.log(
      `Snapshot complete — wrote ${snapshots.length} row(s).`,
    );

    return snapshots.length;
  }

  /** Scheduled entry-point — fires every hour by default. */
  @Cron(CronExpression.EVERY_HOUR)
  async handleCron(): Promise<void> {
    try {
      await this.run();
    } catch (err) {
      this.logger.error(
        `Balance-ledger snapshot job failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }
}
