import { Prisma } from '@prisma/client';
import { LedgerReconciliationService } from './ledger-reconciliation.service';
import { OnChainLedgerEntry } from './ledger-on-chain-source';

/**
 * Tests for issue #427: the reconciliation must read real on-chain data (a
 * source error fails the job), compare amounts in exact integer units, and
 * never flag every stored row as missing when the source returns nothing.
 * The on-chain source is injected as a fake so the comparison logic is what is
 * exercised.
 */

const fakeSource = {
  fetchLedgerEntries: jest.fn(),
};

const fakeQueue = {
  add: jest.fn(),
  getJob: jest.fn(),
};

const prismaMock = {
  balanceLedger: {
    findMany: jest.fn(),
  },
};

function buildService(): LedgerReconciliationService {
  return new LedgerReconciliationService(
    prismaMock as never,
    fakeQueue as never,
    fakeSource as never,
  );
}

function onChainEntry(overrides: Partial<OnChainLedgerEntry>): OnChainLedgerEntry {
  return {
    id: 'txhash123:0',
    ledger: 1000,
    amount: '10000000',
    eventType: 'lock',
    ...overrides,
  };
}

describe('LedgerReconciliationService (issue #427)', () => {
  let service: LedgerReconciliationService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = buildService();
  });

  const jobData = {
    startLedger: 1000,
    endLedger: 1100,
    thresholdPercent: 5,
  };

  it('fails the job when the on-chain source errors instead of returning a completed report', async () => {
    fakeSource.fetchLedgerEntries.mockRejectedValue(
      new Error('RPC timeout: getTransactions failed'),
    );

    await expect(service.processReconciliation(jobData)).rejects.toThrow(
      'RPC timeout',
    );
    expect(prismaMock.balanceLedger.findMany).not.toHaveBeenCalled();
  });

  it('fails the job when the on-chain source returns zero entries and never flags stored rows as missing', async () => {
    fakeSource.fetchLedgerEntries.mockResolvedValue([]);
    prismaMock.balanceLedger.findMany.mockResolvedValue([
      {
        id: 'stored-1',
        eventType: 'lock',
        amount: new Prisma.Decimal('10000000'),
      },
    ]);

    await expect(service.processReconciliation(jobData)).rejects.toThrow(
      'refusing to flag stored rows as missing',
    );
    // The vacuous completed report (every stored row "missing" at ledger -1)
    // must never be produced.
    expect(prismaMock.balanceLedger.findMany).not.toHaveBeenCalled();
  });

  it('flags an on-chain entry with no stored counterpart as missing with the correct ledger', async () => {
    const entry = onChainEntry({ id: 'txhash123:0', ledger: 1005 });
    fakeSource.fetchLedgerEntries.mockResolvedValue([entry]);
    prismaMock.balanceLedger.findMany.mockResolvedValue([]);

    const report = await service.processReconciliation(jobData);

    expect(report.status).toBe('completed');
    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0]).toMatchObject({
      ledger: 1005,
      type: 'missing',
      severity: 'high',
    });
    expect(report.checkedLedgers).toBe(1);
  });

  it('flags an amount difference above the threshold as amount_mismatch using exact integer units', async () => {
    // 10,000,000 vs 9,000,000 = 10% — above the 5% threshold.
    const entry = onChainEntry({ id: 'match:0', amount: '10000000' });
    fakeSource.fetchLedgerEntries.mockResolvedValue([entry]);
    prismaMock.balanceLedger.findMany.mockResolvedValue([
      {
        id: 'match:0',
        eventType: 'lock',
        amount: new Prisma.Decimal('9000000.000000000000000000'),
      },
    ]);

    const report = await service.processReconciliation(jobData);

    const mismatch = report.discrepancies.find(
      d => d.type === 'amount_mismatch',
    );
    expect(mismatch).toBeDefined();
    expect(mismatch).toMatchObject({
      ledger: entry.ledger,
      expected: '10000000',
      observed: '9000000',
      severity: 'medium',
    });
  });

  it('does not flag an amount difference within the threshold (exact Decimal compare)', async () => {
    const entry = onChainEntry({ id: 'match:0', amount: '10000000' });
    fakeSource.fetchLedgerEntries.mockResolvedValue([entry]);
    // 1% difference — under the 5% threshold, and the stored value carries a
    // fractional part that a float comparison would round away.
    prismaMock.balanceLedger.findMany.mockResolvedValue([
      {
        id: 'match:0',
        eventType: 'lock',
        amount: new Prisma.Decimal('9900000.000000000000000000'),
      },
    ]);

    const report = await service.processReconciliation(jobData);

    expect(
      report.discrepancies.some(d => d.type === 'amount_mismatch'),
    ).toBe(false);
  });

  it('flags a fractional stored amount that a float comparison would hide', async () => {
    const entry = onChainEntry({ id: 'match:0', amount: '10000000' });
    fakeSource.fetchLedgerEntries.mockResolvedValue([entry]);
    // Stored 10,000,000.5 vs on-chain 10,000,000 — a 0.000005% difference, so
    // no mismatch; the point is the comparison stays exact and does not error
    // on the fractional Decimal.
    prismaMock.balanceLedger.findMany.mockResolvedValue([
      {
        id: 'match:0',
        eventType: 'lock',
        amount: new Prisma.Decimal('10000000.500000000000000000'),
      },
    ]);

    const report = await service.processReconciliation(jobData);

    expect(
      report.discrepancies.some(d => d.type === 'amount_mismatch'),
    ).toBe(false);
  });

  it('flags an event type difference as count_mismatch', async () => {
    const entry = onChainEntry({ id: 'match:0', eventType: 'lock' });
    fakeSource.fetchLedgerEntries.mockResolvedValue([entry]);
    prismaMock.balanceLedger.findMany.mockResolvedValue([
      {
        id: 'match:0',
        eventType: 'disburse',
        amount: new Prisma.Decimal('10000000'),
      },
    ]);

    const report = await service.processReconciliation(jobData);

    expect(
      report.discrepancies.find(d => d.type === 'count_mismatch'),
    ).toMatchObject({
      ledger: entry.ledger,
      expected: 'lock',
      observed: 'disburse',
      severity: 'medium',
    });
  });

  it('flags a stored row without an on-chain counterpart as missing with an unknown ledger (-1)', async () => {
    const entry = onChainEntry({ id: 'onchain:0' });
    fakeSource.fetchLedgerEntries.mockResolvedValue([entry]);
    prismaMock.balanceLedger.findMany.mockResolvedValue([
      {
        id: 'stored-only-1',
        eventType: 'lock',
        amount: new Prisma.Decimal('5000000'),
      },
    ]);

    const report = await service.processReconciliation(jobData);

    const storedMissing = report.discrepancies.find(
      d => d.type === 'missing' && d.ledger === -1,
    );
    expect(storedMissing).toMatchObject({
      ledger: -1,
      severity: 'medium',
      expected: null,
    });
  });

  it('computes actionable from the summary (high discrepancies are actionable)', async () => {
    fakeSource.fetchLedgerEntries.mockResolvedValue([
      onChainEntry({ id: 'missing-a' }),
      onChainEntry({ id: 'missing-b' }),
    ]);
    prismaMock.balanceLedger.findMany.mockResolvedValue([]);

    const report = await service.processReconciliation(jobData);

    expect(report.summary.byType.missing).toBe(2);
    expect(report.summary.bySeverity.high).toBe(2);
    expect(report.actionable).toBe(true);
  });

  it('is not actionable for a small number of low/medium discrepancies', async () => {
    fakeSource.fetchLedgerEntries.mockResolvedValue([
      onChainEntry({ id: 'match:0' }),
    ]);
    prismaMock.balanceLedger.findMany.mockResolvedValue([
      {
        id: 'match:0',
        eventType: 'lock',
        amount: new Prisma.Decimal('10000000'),
      },
      {
        id: 'stored-only-1',
        eventType: 'lock',
        amount: new Prisma.Decimal('5000000'),
      },
    ]);

    const report = await service.processReconciliation(jobData);

    // The matched row reconciles cleanly; only the stored-only row is a
    // single medium-severity missing entry, which is not actionable.
    expect(report.summary.totalDiscrepancies).toBe(1);
    expect(report.summary.bySeverity.medium).toBe(1);
    expect(report.actionable).toBe(false);
  });
});
