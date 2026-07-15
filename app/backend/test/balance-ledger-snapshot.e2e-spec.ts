/**
 * balance-ledger-snapshot.e2e-spec.ts
 *
 * Acceptance-criteria test for issue #261:
 *
 *   "An end-to-end test asserts that the running total matches
 *    Σ BalanceLedger.amount for the last 24 h."
 *
 * The test:
 *  1. Creates a campaign.
 *  2. Inserts several BalanceLedger rows with Decimal amounts within the last
 *     24 h window.
 *  3. Inserts one row outside the 24 h window (should be excluded).
 *  4. Triggers BalanceLedgerSnapshotJob.run() directly.
 *  5. Reads the written BalanceLedgerSnapshot and asserts that
 *     snapshot.totalLocked === Σ in-window amounts.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { AppModule } from 'src/app.module';
import { PrismaService } from 'src/prisma/prisma.service';
import { BalanceLedgerSnapshotJob } from 'src/jobs/balance-ledger-snapshot.job';

describe('BalanceLedgerSnapshotJob (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let snapshotJob: BalanceLedgerSnapshotJob;

  let campaignId: string;
  let orgId: string;

  // Amounts (in Decimal-safe string form) for entries within the 24 h window
  const inWindowAmounts = ['100.50', '200.25', '50.00'];
  // Expected sum: 350.75
  const expectedTotal = inWindowAmounts
    .reduce((sum, a) => sum + parseFloat(a), 0)
    .toFixed(8); // "350.75000000"

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = moduleRef.get<PrismaService>(PrismaService);
    snapshotJob = moduleRef.get<BalanceLedgerSnapshotJob>(
      BalanceLedgerSnapshotJob,
    );

    // ------------------------------------------------------------------
    // Seed: organization → campaign
    // ------------------------------------------------------------------
    const org = await prisma.organization.create({
      data: { name: 'Snapshot Test Org' },
    });
    orgId = org.id;

    const campaign = await prisma.campaign.create({
      data: {
        name: 'Snapshot Test Campaign',
        budget: 10000,
        orgId,
      },
    });
    campaignId = campaign.id;

    const now = new Date();
    const within24h = new Date(now.getTime() - 12 * 60 * 60 * 1000); // 12 h ago
    const outside24h = new Date(now.getTime() - 25 * 60 * 60 * 1000); // 25 h ago

    // Insert in-window ledger entries
    for (const amt of inWindowAmounts) {
      await prisma.balanceLedger.create({
        data: {
          campaignId,
          eventType: 'lock',
          amount: new Decimal(amt),
          createdAt: within24h,
        },
      });
    }

    // Insert an out-of-window entry — must NOT be included in the snapshot
    await prisma.balanceLedger.create({
      data: {
        campaignId,
        eventType: 'lock',
        amount: new Decimal('999.99'),
        createdAt: outside24h,
      },
    });
  });

  afterAll(async () => {
    // Clean up in dependency order
    await prisma.balanceLedgerSnapshot.deleteMany({ where: { campaignId } });
    await prisma.balanceLedger.deleteMany({ where: { campaignId } });
    await prisma.campaign.delete({ where: { id: campaignId } });
    await prisma.organization.delete({ where: { id: orgId } });
    await app.close();
  });

  it('should write a snapshot row for the campaign', async () => {
    const written = await snapshotJob.run();
    expect(written).toBeGreaterThanOrEqual(1);
  });

  it('snapshot.totalLocked equals Σ BalanceLedger.amount for the last 24 h', async () => {
    // Direct DB sum for the 24 h window (ground truth)
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);

    const agg = await prisma.balanceLedger.aggregate({
      _sum: { amount: true },
      where: {
        campaignId,
        createdAt: { gte: windowStart, lte: windowEnd },
      },
    });

    const dbSum = agg._sum.amount ?? new Decimal(0);

    // Latest snapshot for this campaign
    const snapshot = await prisma.balanceLedgerSnapshot.findFirst({
      where: { campaignId },
      orderBy: { snapshotAt: 'desc' },
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot!.totalLocked.toFixed(8)).toBe(dbSum.toFixed(8));

    // Also verify our manual expected sum (sanity check)
    expect(dbSum.toFixed(8)).toBe(expectedTotal);
  });

  it('snapshot.totalLocked excludes entries older than 24 h', async () => {
    const snapshot = await prisma.balanceLedgerSnapshot.findFirst({
      where: { campaignId },
      orderBy: { snapshotAt: 'desc' },
    });

    expect(snapshot).not.toBeNull();
    // The out-of-window entry (999.99) must not appear in the total
    const total = snapshot!.totalLocked.toNumber();
    expect(total).not.toBeCloseTo(
      parseFloat(expectedTotal) + 999.99,
      2,
    );
    expect(total).toBeCloseTo(parseFloat(expectedTotal), 2);
  });
});
