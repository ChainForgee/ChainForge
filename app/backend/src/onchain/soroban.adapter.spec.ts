import { ConfigService } from '@nestjs/config';
import { SorobanAdapter } from './soroban.adapter';

/**
 * Regression tests for issue #426.
 *
 * `SorobanOnchainAdapter` (deleted) fabricated success by posting a hand-rolled
 * `{ contractId, method, args }` JSON blob to `simulateTransaction` /
 * `sendTransaction` — a payload that is not a Soroban envelope — and returned
 * `status: 'success'` with an empty `transactionHash` for every call. These
 * tests lock the canonical `SorobanAdapter` to the opposite contract:
 *
 *   1. what reaches `simulateTransaction`/`sendTransaction` is a real
 *      `TransactionBuilder`-built transaction (an object with `toEnvelope`),
 *      never a JSON blob; and
 *   2. a mutation only reports `status: 'success'` with the non-empty hash of
 *      an actually sent, confirmed transaction — a failed simulation or
 *      rejected submission rejects instead of fabricating success.
 */

const mockServer = {
  getAccount: jest.fn(),
  simulateTransaction: jest.fn(),
  sendTransaction: jest.fn(),
  getTransaction: jest.fn(),
};

jest.mock('@stellar/stellar-sdk', () => {
  const txLike = () => ({
    toEnvelope: jest.fn(() => 'ENVELOPE-XDR'),
    toXDR: jest.fn(() => 'TRANSACTION-XDR'),
    sign: jest.fn(),
    hash: jest.fn(() => Buffer.from('abc')),
  });

  return {
    rpc: {
      Server: jest.fn().mockImplementation(() => mockServer),
      Api: {
        isSimulationError: jest.fn((sim: unknown) =>
          Boolean(sim && typeof sim === 'object' && 'error' in sim),
        ),
        isSimulationSuccess: jest.fn((sim: unknown) =>
          Boolean(sim && typeof sim === 'object' && 'result' in sim),
        ),
        GetTransactionStatus: {
          NOT_FOUND: 'NOT_FOUND',
          FAILED: 'FAILED',
          SUCCESS: 'SUCCESS',
        },
      },
      assembleTransaction: jest.fn(
        (tx: unknown) =>
          ({
            build: () => tx,
          }) as unknown,
      ),
    },
    Contract: jest.fn().mockImplementation(() => ({
      call: jest.fn().mockReturnValue({ _op: 'contract-call' }),
    })),
    nativeToScVal: jest.fn(v => ({ _native: v })),
    scValToNative: jest.fn(v =>
      v && typeof v === 'object' && '_native' in v ? v._native : v,
    ),
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn(txLike),
    })),
    Keypair: {
      fromSecret: jest.fn().mockReturnValue({
        publicKey: () =>
          'GBXGQJWVLWOYHFLVTKWV5FGHA3JYYV3A7JQKNO6TCTSVL4K3JDLDZBPK',
        sign: jest.fn(),
      }),
    },
    BASE_FEE: '100',
    xdr: {},
  };
});

describe('SorobanAdapter (issue #426 regression)', () => {
  const CONTRACT_ID =
    'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
  const SECRET = 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const TOKEN = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4';
  const RECIPIENT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

  function buildAdapter(): SorobanAdapter {
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        switch (key) {
          case 'AID_ESCROW_CONTRACT_ID':
            return CONTRACT_ID;
          case 'SOROBAN_ADMIN_SECRET_KEY':
            return SECRET;
          case 'STELLAR_RPC_URL':
            return 'https://soroban-testnet.stellar.org';
          case 'STELLAR_NETWORK_PASSPHRASE':
            return 'Test SDF Network ; September 2015';
          case 'SOROBAN_NETWORK':
            return 'testnet';
          default:
            return fallback;
        }
      }),
    } as unknown as ConfigService;

    return new SorobanAdapter(config);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockServer.getAccount.mockResolvedValue({
      id: 'GBXGQJWVLWOYHFLVTKWV5FGHA3JYYV3A7JQKNO6TCTSVL4K3JDLDZBPK',
      sequence: '1234567890',
    });
    mockServer.simulateTransaction.mockResolvedValue({
      result: { retval: { _native: 'ok' } },
      minResourceFee: '100',
    });
    mockServer.sendTransaction.mockResolvedValue({
      status: 'PENDING',
      hash: 'ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890',
    });
    mockServer.getTransaction.mockResolvedValue({
      status: 'SUCCESS',
      returnValue: { _native: 'ok' },
    });
  });

  it('submits a real TransactionBuilder-built envelope, not a JSON blob', async () => {
    const adapter = buildAdapter();
    const result = await adapter.createAidPackage({
      operatorAddress: RECIPIENT,
      packageId: '1',
      recipientAddress: RECIPIENT,
      amount: '100',
      tokenAddress: TOKEN,
      expiresAt: 1767225600,
    });

    // The transaction passed to the RPC boundary must be an envelope object,
    // never a stringified `{contractId, method, args}` blob.
    const simulated = mockServer.simulateTransaction.mock.calls[0][0];
    expect(simulated).toBeDefined();
    expect(typeof simulated).toBe('object');
    expect(typeof (simulated as { toEnvelope?: unknown }).toEnvelope).toBe(
      'function',
    );
    expect(typeof (simulated as { toXDR?: unknown }).toXDR).toBe('function');
    expect(JSON.stringify(simulated)).not.toContain('contractId');
    expect(JSON.stringify(simulated)).not.toContain('"method"');
    expect(JSON.stringify(simulated)).not.toContain('"args"');

    // Same for the submitted (signed, prepared) transaction.
    const sent = mockServer.sendTransaction.mock.calls[0][0];
    expect(sent).toBeDefined();
    expect(typeof (sent as { toEnvelope?: unknown }).toEnvelope).toBe(
      'function',
    );

    // Success is only reported together with the real confirmed hash.
    expect(result.status).toBe('success');
    expect(result.transactionHash).toMatch(/^[A-F0-9]{64}$/);
    expect(result.transactionHash).not.toBe('');
  });

  it('rejects when simulation fails instead of fabricating success', async () => {
    mockServer.simulateTransaction.mockResolvedValue({
      error: 'HostError: contract rejected',
    });

    const adapter = buildAdapter();
    await expect(
      adapter.createAidPackage({
        operatorAddress: RECIPIENT,
        packageId: '1',
        recipientAddress: RECIPIENT,
        amount: '100',
        tokenAddress: TOKEN,
        expiresAt: 1767225600,
      }),
    ).rejects.toThrow('Contract simulation error');
  });

  it('rejects when submission is not PENDING/DUPLICATE', async () => {
    mockServer.sendTransaction.mockResolvedValue({
      status: 'ERROR',
      errorResultXdr: 'AAAABQ==',
    });

    const adapter = buildAdapter();
    await expect(
      adapter.createAidPackage({
        operatorAddress: RECIPIENT,
        packageId: '1',
        recipientAddress: RECIPIENT,
        amount: '100',
        tokenAddress: TOKEN,
        expiresAt: 1767225600,
      }),
    ).rejects.toThrow('Transaction submission failed with status: ERROR');
  });

  it('rejects when the confirmed transaction failed', async () => {
    mockServer.sendTransaction.mockResolvedValue({
      status: 'PENDING',
      hash: 'ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890',
    });
    mockServer.getTransaction.mockResolvedValue({
      status: 'FAILED',
      resultXdr: 'AAAA',
    });

    const adapter = buildAdapter();
    await expect(
      adapter.createAidPackage({
        operatorAddress: RECIPIENT,
        packageId: '1',
        recipientAddress: RECIPIENT,
        amount: '100',
        tokenAddress: TOKEN,
        expiresAt: 1767225600,
      }),
    ).rejects.toThrow();
  });

  it('calls the real contract method name and argument list', async () => {
    const adapter = buildAdapter();
    await adapter.createAidPackage({
      operatorAddress: RECIPIENT,
      packageId: '42',
      recipientAddress: RECIPIENT,
      amount: '250',
      tokenAddress: TOKEN,
      expiresAt: 1767225600,
    });

    // The operation added to the envelope must target `create_package`, the
    // contract's real entrypoint (the deleted stub called `create_package`
    // with a 6-argument JSON blob; the contract takes 7 typed args).
    const { Contract, TransactionBuilder } = jest.requireMock(
      '@stellar/stellar-sdk',
    );

    const contractInstance = Contract.mock.results[0].value;
    const methodCalls = (contractInstance.call as jest.Mock).mock.calls;
    expect(methodCalls).toHaveLength(1);
    expect(methodCalls[0][0]).toBe('create_package');

    // The envelope carries one operation (the contract call), i.e. the
    // transaction was actually built, not stubbed as a JSON string.
    const builderInstance = TransactionBuilder.mock.results[0].value;
    expect(builderInstance.addOperation).toHaveBeenCalledTimes(1);
    expect(builderInstance.build).toHaveBeenCalledTimes(1);
  });
});
