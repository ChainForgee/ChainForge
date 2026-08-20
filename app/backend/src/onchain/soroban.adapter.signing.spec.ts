import { ConfigService } from '@nestjs/config';
import { SorobanAdapter } from './soroban.adapter';
import {
  xdr,
  Keypair,
  StrKey,
  nativeToScVal,
  TransactionBuilder,
  SorobanDataBuilder,
  Operation,
  Account,
  Transaction,
  authorizeEntry,
} from '@stellar/stellar-sdk';

/**
 * Client-signing seam tests for issue #428.
 *
 * The contract's auth model is per-caller: `claim(id, claimer)` calls
 * `claimer.require_auth()` and `create_package` calls
 * `require_admin_or_distributor(&operator)`. The adapter must therefore be
 * able to submit transactions whose Soroban auth entries were signed by the
 * recipient / distributor — not by the backend admin keypair.
 *
 * These tests exercise the seam (`buildUnsignedClaimTx` /
 * `buildUnsignedCreatePackageTx` -> client signs -> `submitSignedTx`) against
 * the *real* stellar-sdk crypto and XDR codecs; only the RPC server boundary
 * (`getAccount` / `simulateTransaction` / `sendTransaction` / `getTransaction`)
 * is mocked. The auth-entry signature preimage is the one the SDK's
 * `authorizeEntry` uses, so a wrong-signer entry (admin keypair) is detected
 * and rejected before submission.
 */

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const PASSPHRASE = 'Test SDF Network ; September 2015';
const HASH_64 = 'A'.repeat(64);

const mockServer = {
  getAccount: jest.fn(),
  simulateTransaction: jest.fn(),
  sendTransaction: jest.fn(),
  getTransaction: jest.fn(),
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

const admin = Keypair.random();
const recipient = Keypair.random();
const operator = Keypair.random();
const thirdParty = Keypair.random();

/** Build the unsigned Soroban auth entry a real simulation would return. */
function unsignedAuthEntry(
  requiredSigner: Keypair,
  method: string,
  args: xdr.ScVal[],
): xdr.SorobanAuthorizationEntry {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function:
      xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: xdr.ScAddress.scAddressTypeContract(
            StrKey.decodeContract(CONTRACT_ID) as unknown as xdr.Hash,
          ),
          functionName: method,
          args,
        }),
      ),
    subInvocations: [],
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: xdr.ScAddress.scAddressTypeAccount(
          xdr.PublicKey.publicKeyTypeEd25519(requiredSigner.rawPublicKey()),
        ),
        nonce: xdr.Int64.fromString('7'),
        signatureExpirationLedger: 5000,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: invocation,
  });
}

/** Raw RPC simulation response carrying one unsigned auth entry. */
function simulationWithEntry(
  entry: xdr.SorobanAuthorizationEntry,
): Record<string, unknown> {
  const txData = new SorobanDataBuilder().setFootprint([], []).build();
  return {
    transactionData: txData.toXDR('base64'),
    minResourceFee: '100',
    results: [
      {
        auth: [entry.toXDR('base64')],
        xdr: xdr.ScVal.scvVoid().toXDR('base64'),
      },
    ],
    cost: { cpuInsns: '0', memBytes: '0' },
    latestLedger: 4000,
  };
}

/**
 * Client-side signing: parse the unsigned envelope, sign every auth entry with
 * `signer` (exactly what a wallet such as Freighter / WalletConnect does), and
 * rebuild the envelope with the signed entries.
 */
function invokeHostOperation(tx: Transaction): Operation.InvokeHostFunction {
  const op = tx.operations[0];
  if (op.type !== 'invokeHostFunction') {
    throw new Error('expected an invokeHostFunction operation');
  }
  return op;
}

async function signAuthEntries(
  unsignedXdr: string,
  signer: Keypair,
): Promise<string> {
  const clientTx = TransactionBuilder.fromXDR(
    unsignedXdr,
    PASSPHRASE,
  ) as Transaction;
  const op = invokeHostOperation(clientTx);
  const auth = op.auth!; // the simulated envelope always carries auth entries
  const expiration = auth[0]
    .credentials()
    .address()
    .signatureExpirationLedger();
  const signed: xdr.SorobanAuthorizationEntry[] = [];
  for (const entry of auth) {
    signed.push(await authorizeEntry(entry, signer, expiration, PASSPHRASE));
  }
  const rebuilt = TransactionBuilder.cloneFrom(clientTx, {
    fee: clientTx.fee,
    networkPassphrase: PASSPHRASE,
    sorobanData: (
      clientTx as unknown as { sorobanData: xdr.SorobanTransactionData }
    ).sorobanData,
  })
    .clearOperations()
    .addOperation(
      Operation.invokeHostFunction({
        source: op.source,
        func: op.func,
        auth: signed,
      }),
    )
    .build();
  return rebuilt.toXDR();
}

function buildAdapter(): SorobanAdapter {
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => {
      switch (key) {
        case 'AID_ESCROW_CONTRACT_ID':
          return CONTRACT_ID;
        case 'SOROBAN_ADMIN_SECRET_KEY':
          return admin.secret();
        case 'STELLAR_RPC_URL':
          return 'https://soroban-testnet.stellar.org';
        case 'STELLAR_NETWORK_PASSPHRASE':
          return PASSPHRASE;
        case 'SOROBAN_NETWORK':
          return 'testnet';
        default:
          return fallback;
      }
    }),
  } as unknown as ConfigService;

  return new SorobanAdapter(config);
}

function claimArgs(packageId: number): xdr.ScVal[] {
  return [
    nativeToScVal(packageId, { type: 'u64' }),
    nativeToScVal(recipient.publicKey(), { type: 'address' }),
  ];
}

describe('SorobanAdapter client-signing seam (issue #428)', () => {
  let adapter: SorobanAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    mockServer.getAccount.mockResolvedValue(
      new Account(admin.publicKey(), '100'),
    );
    mockServer.sendTransaction.mockResolvedValue({
      status: 'PENDING',
      hash: HASH_64,
    });
    mockServer.getTransaction.mockResolvedValue({
      status: 'SUCCESS',
      returnValue: xdr.ScVal.scvVoid(),
      ledger: 4001,
    });
    adapter = buildAdapter();
  });

  describe('buildUnsignedClaimTx', () => {
    beforeEach(() => {
      mockServer.simulateTransaction.mockResolvedValue(
        simulationWithEntry(
          unsignedAuthEntry(recipient, 'claim', claimArgs(1)),
        ),
      );
    });

    it('returns an unsigned envelope whose auth entry demands the recipient signature', async () => {
      const result = await adapter.buildUnsignedClaimTx({
        packageId: '1',
        recipientAddress: recipient.publicKey(),
      });

      expect(result.transactionXdr).toBeTruthy();
      expect(result.transactionHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(result.recipientAddress).toBe(recipient.publicKey());

      // The returned XDR parses as the same transaction the hash was taken from.
      const parsed = TransactionBuilder.fromXDR(
        result.transactionXdr,
        PASSPHRASE,
      ) as Transaction;
      expect(parsed.hash().toString('hex')).toBe(result.transactionHash);

      // One auth entry, required signer = recipient, signature still void
      // (the recipient has not signed yet).
      const entries = invokeHostOperation(parsed).auth!;
      expect(entries).toHaveLength(1);
      const creds = entries[0].credentials();
      expect(
        creds.switch() ===
          xdr.SorobanCredentialsType.sorobanCredentialsAddress(),
      ).toBe(true);
      const required = StrKey.encodeEd25519PublicKey(
        creds.address().address().accountId().ed25519(),
      );
      expect(required).toBe(recipient.publicKey());
      expect(
        creds.address().signature().switch() === xdr.ScValType.scvVoid(),
      ).toBe(true);
    });
  });

  describe('submitSignedTx for claims', () => {
    beforeEach(() => {
      mockServer.simulateTransaction.mockResolvedValue(
        simulationWithEntry(
          unsignedAuthEntry(recipient, 'claim', claimArgs(1)),
        ),
      );
    });

    it('submits a recipient-signed claim successfully', async () => {
      const unsigned = await adapter.buildUnsignedClaimTx({
        packageId: '1',
        recipientAddress: recipient.publicKey(),
      });
      const signedXdr = await signAuthEntries(
        unsigned.transactionXdr,
        recipient,
      );

      const result = await adapter.submitSignedTx({
        signedXdr,
        expectedSigner: recipient.publicKey(),
      });

      expect(result.status).toBe('success');
      expect(result.transactionHash).toMatch(/^[A-F0-9]{64}$/);
      expect(mockServer.sendTransaction).toHaveBeenCalledTimes(1);

      // The envelope submitted carries the recipient-signed auth entry AND the
      // admin envelope signature (fee sponsorship).
      const sent = mockServer.sendTransaction.mock.calls[0][0] as Transaction;
      expect(sent.signatures).toHaveLength(1);
      const sentAuth = invokeHostOperation(sent).auth!;
      expect(sentAuth).toHaveLength(1);
      const sentCreds = sentAuth[0].credentials();
      expect(
        sentCreds.address().signature().switch() === xdr.ScValType.scvVoid(),
      ).toBe(false);
    });

    it('rejects a claim whose auth entry was signed by the admin keypair, not the recipient', async () => {
      const unsigned = await adapter.buildUnsignedClaimTx({
        packageId: '1',
        recipientAddress: recipient.publicKey(),
      });
      // The recipient's key is never touched; the admin keypair signs instead.
      const signedXdr = await signAuthEntries(unsigned.transactionXdr, admin);

      await expect(
        adapter.submitSignedTx({
          signedXdr,
          expectedSigner: recipient.publicKey(),
        }),
      ).rejects.toThrow(
        `auth entry signed by ${admin.publicKey()} but the contract requires ${recipient.publicKey()}`,
      );
      // The wrong-signer transaction must never reach the network.
      expect(mockServer.sendTransaction).not.toHaveBeenCalled();
    });

    it('rejects a claim signed by a third party when the recipient was expected', async () => {
      const unsigned = await adapter.buildUnsignedClaimTx({
        packageId: '1',
        recipientAddress: recipient.publicKey(),
      });
      const signedXdr = await signAuthEntries(
        unsigned.transactionXdr,
        thirdParty,
      );

      await expect(
        adapter.submitSignedTx({
          signedXdr,
          expectedSigner: recipient.publicKey(),
        }),
      ).rejects.toThrow(
        `auth entry signed by ${thirdParty.publicKey()} but the contract requires ${recipient.publicKey()}`,
      );
      expect(mockServer.sendTransaction).not.toHaveBeenCalled();
    });

    it('rejects when the auth entry is valid but expectedSigner points at the wrong account', async () => {
      const unsigned = await adapter.buildUnsignedClaimTx({
        packageId: '1',
        recipientAddress: recipient.publicKey(),
      });
      // Signed by the recipient (the entry's required account) — cryptographically
      // valid — but the caller declares a different expectedSigner.
      const signedXdr = await signAuthEntries(
        unsigned.transactionXdr,
        recipient,
      );

      await expect(
        adapter.submitSignedTx({
          signedXdr,
          expectedSigner: thirdParty.publicKey(),
        }),
      ).rejects.toThrow(
        `auth entry signed by ${recipient.publicKey()}, expected ${thirdParty.publicKey()}`,
      );
      expect(mockServer.sendTransaction).not.toHaveBeenCalled();
    });

    it('rejects an unsigned envelope (no signature applied)', async () => {
      const unsigned = await adapter.buildUnsignedClaimTx({
        packageId: '1',
        recipientAddress: recipient.publicKey(),
      });

      await expect(
        adapter.submitSignedTx({
          signedXdr: unsigned.transactionXdr,
          expectedSigner: recipient.publicKey(),
        }),
      ).rejects.toThrow('auth entry is unsigned');
      expect(mockServer.sendTransaction).not.toHaveBeenCalled();
    });

    it('rejects an envelope that is not valid XDR', async () => {
      await expect(
        adapter.submitSignedTx({
          signedXdr: 'this-is-not-base64-xdr!!',
          expectedSigner: recipient.publicKey(),
        }),
      ).rejects.toThrow('not a valid transaction envelope');
    });
  });

  describe('distributor-created packages', () => {
    const createPackageArgs = (): xdr.ScVal[] => [
      nativeToScVal(operator.publicKey(), { type: 'address' }),
      nativeToScVal(42, { type: 'u64' }),
      nativeToScVal(recipient.publicKey(), { type: 'address' }),
      nativeToScVal('250', { type: 'i128' }),
      nativeToScVal(
        'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4',
        {
          type: 'address',
        },
      ),
      nativeToScVal(1767225600, { type: 'u64' }),
      nativeToScVal([], { type: 'map' }),
    ];

    beforeEach(() => {
      mockServer.simulateTransaction.mockResolvedValue(
        simulationWithEntry(
          unsignedAuthEntry(operator, 'create_package', createPackageArgs()),
        ),
      );
    });

    it('builds and submits a distributor-signed create_package for a non-admin operator', async () => {
      const unsigned = await adapter.buildUnsignedCreatePackageTx({
        operatorAddress: operator.publicKey(),
        packageId: '42',
        recipientAddress: recipient.publicKey(),
        amount: '250',
        tokenAddress:
          'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4',
        expiresAt: 1767225600,
      });
      expect(unsigned.operatorAddress).toBe(operator.publicKey());
      expect(unsigned.transactionHash).toMatch(/^[0-9a-f]{64}$/);

      const signedXdr = await signAuthEntries(
        unsigned.transactionXdr,
        operator,
      );
      const result = await adapter.submitSignedTx({
        signedXdr,
        expectedSigner: operator.publicKey(),
      });

      expect(result.status).toBe('success');
      expect(mockServer.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it('rejects a create_package auth entry signed by the admin instead of the distributor', async () => {
      const unsigned = await adapter.buildUnsignedCreatePackageTx({
        operatorAddress: operator.publicKey(),
        packageId: '42',
        recipientAddress: recipient.publicKey(),
        amount: '250',
        tokenAddress:
          'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4',
        expiresAt: 1767225600,
      });
      const signedXdr = await signAuthEntries(unsigned.transactionXdr, admin);

      await expect(
        adapter.submitSignedTx({
          signedXdr,
          expectedSigner: operator.publicKey(),
        }),
      ).rejects.toThrow('but the contract requires');
      expect(mockServer.sendTransaction).not.toHaveBeenCalled();
    });
  });
});
