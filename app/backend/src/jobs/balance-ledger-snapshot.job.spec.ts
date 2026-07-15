import { BalanceLedgerSnapshotJob } from './balance-ledger-snapshot.job';
import { PrismaService } from '../prisma/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';

describe('BalanceLedgerSnapshotJob', () => {
  let job: BalanceLedgerSnapshotJob;
  let prisma: jest.Mocked<
    Pick<PrismaService, 'balanceLedger' | 'balanceLedgerSnapshot'>
  >;

  const makeDecimal = (s: string) => new Decimal(s);

  beforeEach(() => {
    prisma = {
      balanceLedger: {
        groupBy: jest.fn(),
      } as unknown as jest.Mocked<PrismaService['balanceLedger']>,
      balanceLedgerSnapshot: {
        createMany: jest.fn(),
      } as unknown as jest.Mocked<PrismaService['balanceLedgerSnapshot']>,
    };

    job = new BalanceLedgerSnapshotJob(prisma as unknown as PrismaService);
  });

  it('returns 0 and skips createMany when no ledger activity', async () => {
    (prisma.balanceLedger.groupBy as jest.Mock).mockResolvedValue([]);

    const result = await job.run();

    expect(result).toBe(0);
    expect(prisma.balanceLedgerSnapshot.createMany).not.toHaveBeenCalled();
  });

  it('creates one snapshot per campaign with the correct totalLocked', async () => {
    (prisma.balanceLedger.groupBy as jest.Mock).mockResolvedValue([
      { campaignId: 'c1', _sum: { amount: makeDecimal('350.75') } },
      { campaignId: 'c2', _sum: { amount: makeDecimal('1000.00') } },
    ]);
    (prisma.balanceLedgerSnapshot.createMany as jest.Mock).mockResolvedValue({
      count: 2,
    });

    const result = await job.run();

    expect(result).toBe(2);

    const call = (prisma.balanceLedgerSnapshot.createMany as jest.Mock).mock
      .calls[0][0];
    expect(call.data).toHaveLength(2);
    expect(call.data[0].campaignId).toBe('c1');
    expect(call.data[0].totalLocked.toFixed(2)).toBe('350.75');
    expect(call.data[1].campaignId).toBe('c2');
    expect(call.data[1].totalLocked.toFixed(2)).toBe('1000.00');
  });

  it('uses Decimal(0) when _sum.amount is null', async () => {
    (prisma.balanceLedger.groupBy as jest.Mock).mockResolvedValue([
      { campaignId: 'c3', _sum: { amount: null } },
    ]);
    (prisma.balanceLedgerSnapshot.createMany as jest.Mock).mockResolvedValue({
      count: 1,
    });

    await job.run();

    const call = (prisma.balanceLedgerSnapshot.createMany as jest.Mock).mock
      .calls[0][0];
    expect(call.data[0].totalLocked.toFixed(2)).toBe('0.00');
  });
});
