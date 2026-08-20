import { ConfigService } from '@nestjs/config';
import {
  xdr,
  StrKey,
} from '@stellar/stellar-sdk';
import {
  SorobanLedgerOnChainSource,
  decodeContractEvent,
  CONTRACT_EVENT_TO_BALANCE_LEDGER_TYPE,
} from './ledger-on-chain-source';

/**
 * Tests for issue #427's real on-chain source: RPC pagination with explicit
 * range-coverage failures, and decoding of the aid_escrow `#[contractevent]`
 * payloads (topic symbol + named data map) into BalanceLedger entries.
 */

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const OTHER_CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4';

const mockServer = {
  getTransactions: jest.fn(),
};

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: jest.fn().mockImplementation(() => mockServer),
    },
  };
});

const contractIdBytes = (StrKey.decodeContract(CONTRACT_ID) as unknown) as xdr.ContractId;

/** Build a `ContractEvent` mirroring the contract's `#[contractevent]` payloads. */
function contractEvent(
  name: string,
  amount: bigint,
  opts: { contractId?: string; diagnostic?: boolean } = {},
): xdr.ContractEvent {
  const data = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('amount'),
      val: xdr.ScVal.scvI128(
        new xdr.Int128Parts({
          hi: xdr.Int64.fromString('0'),
          lo: xdr.Uint64.fromString(amount.toString()),
        }),
      ),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('package_id'),
      val: xdr.ScVal.scvU64(xdr.Uint64.fromString('42')),
    }),
  ]);
  return new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId: StrKey.decodeContract(
      opts.contractId ?? CONTRACT_ID,
    ) as unknown as xdr.ContractId,
    type: opts.diagnostic
      ? xdr.ContractEventType.diagnostic()
      : xdr.ContractEventType.contract(),
    body: new xdr.ContractEventBody(
      0,
      new xdr.ContractEventV0({
        topics: [xdr.ScVal.scvSymbol(name)],
        data,
      }),
    ),
  });
}

function eventWithoutAmount(name = 'package_created'): xdr.ContractEvent {
  return new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId: contractIdBytes,
    type: xdr.ContractEventType.contract(),
    body: new xdr.ContractEventBody(
      0,
      new xdr.ContractEventV0({
        topics: [xdr.ScVal.scvSymbol(name)],
        data: xdr.ScVal.scvMap([]),
      }),
    ),
  });
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    transactions: [],
    latestLedger: 2000,
    latestLedgerCloseTimestamp: 0,
    oldestLedger: 1,
    oldestLedgerCloseTimestamp: 0,
    cursor: '',
    ...overrides,
  };
}

function buildSource(): SorobanLedgerOnChainSource {
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => {
      switch (key) {
        case 'STELLAR_RPC_URL':
          return 'https://soroban-testnet.stellar.org';
        case 'AID_ESCROW_CONTRACT_ID':
          return CONTRACT_ID;
        default:
          return fallback;
      }
    }),
  } as unknown as ConfigService;
  return new SorobanLedgerOnChainSource(config);
}

describe('decodeContractEvent (issue #427)', () => {
  it('decodes package_created into a lock entry with the exact integer amount', () => {
    const event = contractEvent('package_created', 10000000n);
    const entry = decodeContractEvent(event, CONTRACT_ID, 'txhash', 1234, 0);

    expect(entry).toEqual({
      id: 'txhash:0',
      ledger: 1234,
      amount: '10000000',
      eventType: 'lock',
    });
  });

  it('maps every BalanceLedger-relevant contract event to its vocabulary', () => {
    const cases: Array<[string, string]> = [
      ['package_created', 'lock'],
      ['package_disbursed', 'disburse'],
      ['package_revoked', 'unlock'],
      ['package_refunded', 'unlock'],
    ];
    for (const [eventName, eventType] of cases) {
      const entry = decodeContractEvent(
        contractEvent(eventName, 5n),
        CONTRACT_ID,
        'txhash',
        1,
        0,
      );
      expect(entry?.eventType).toBe(eventType);
    }
    expect(Object.keys(CONTRACT_EVENT_TO_BALANCE_LEDGER_TYPE)).toHaveLength(
      cases.length,
    );
  });

  it('skips diagnostic events, events from other contracts, and unmapped events', () => {
    expect(
      decodeContractEvent(
        contractEvent('package_created', 1n, { diagnostic: true }),
        CONTRACT_ID,
        'tx',
        1,
        0,
      ),
    ).toBeNull();
    expect(
      decodeContractEvent(
        contractEvent('package_created', 1n, { contractId: OTHER_CONTRACT_ID }),
        CONTRACT_ID,
        'tx',
        1,
        0,
      ),
    ).toBeNull();
    expect(
      decodeContractEvent(contractEvent('escrow_funded', 1n), CONTRACT_ID, 'tx', 1, 0),
    ).toBeNull();
  });

  it('skips events without a numeric amount', () => {
    expect(
      decodeContractEvent(eventWithoutAmount(), CONTRACT_ID, 'tx', 1, 0),
    ).toBeNull();
  });
});

describe('SorobanLedgerOnChainSource.fetchLedgerEntries (issue #427)', () => {
  let source: SorobanLedgerOnChainSource;

  beforeEach(() => {
    jest.clearAllMocks();
    source = buildSource();
  });

  it('pages transactions and decodes their events into entries', async () => {
    const event = contractEvent('package_created', 10000000n);
    mockServer.getTransactions
      .mockResolvedValueOnce(
        page({
          transactions: [
            {
              status: 'SUCCESS',
              ledger: 1000,
              txHash: 'txhash-a',
              events: { contractEventsXdr: [[event]] },
            },
            {
              status: 'SUCCESS',
              ledger: 1001,
              txHash: 'txhash-b',
              events: { contractEventsXdr: [] },
            },
          ],
          latestLedger: 1100,
          cursor: 'cursor-1',
        }),
      )
      .mockResolvedValueOnce(
        page({ transactions: [], latestLedger: 2000, oldestLedger: 1, cursor: '' }),
      );

    const entries = await source.fetchLedgerEntries(1000, 1100);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      id: 'txhash-a:0',
      ledger: 1000,
      amount: '10000000',
      eventType: 'lock',
    });
    // Two pages: the first carries the events and a cursor, the second is
    // empty (cursor exhausted) — the loop then stops.
    expect(mockServer.getTransactions).toHaveBeenCalledTimes(2);
  });

  it('fails loudly when the range extends beyond the chain head', async () => {
    mockServer.getTransactions.mockResolvedValue(
      page({ latestLedger: 900, oldestLedger: 1 }),
    );

    await expect(source.fetchLedgerEntries(1000, 1100)).rejects.toThrow(
      'chain head is at ledger 900',
    );
  });

  it('fails loudly when the requested range predates RPC retention', async () => {
    mockServer.getTransactions.mockResolvedValue(
      page({ latestLedger: 2000, oldestLedger: 1500 }),
    );

    await expect(source.fetchLedgerEntries(1000, 1100)).rejects.toThrow(
      'RPC retention starts at ledger 1500',
    );
  });

  it('returns an empty list for a fully covered range with no relevant events', async () => {
    mockServer.getTransactions.mockResolvedValue(
      page({ latestLedger: 2000, oldestLedger: 1 }),
    );

    const entries = await source.fetchLedgerEntries(1000, 1100);

    expect(entries).toEqual([]);
  });

  it('does not fail the job on an empty covered range (the service decides)', async () => {
    mockServer.getTransactions.mockResolvedValue(
      page({ latestLedger: 2000, oldestLedger: 1 }),
    );

    await expect(source.fetchLedgerEntries(1000, 1100)).resolves.toEqual([]);
  });
});
