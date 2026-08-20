import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { rpc as SorobanRpc, xdr, scValToNative, StrKey } from '@stellar/stellar-sdk';
import { withRetryTimeout } from './utils/retry-with-timeout';

export const LEDGER_ON_CHAIN_SOURCE = 'LEDGER_ON_CHAIN_SOURCE';

/**
 * A single BalanceLedger-relevant on-chain event.
 *
 * `id` is the join key with `BalanceLedger.id`: it is `${transactionHash}:${eventIndex}`,
 * so a backfill that stores on-chain event ids verbatim reconciles 1:1 with
 * this source. `amount` is the contract's raw i128 integer units serialized as
 * a string — never a float, so comparisons stay exact.
 */
export interface OnChainLedgerEntry {
  id: string;
  ledger: number;
  amount: string;
  eventType: string;
}

/**
 * Port for the on-chain side of ledger reconciliation.
 *
 * Implementations must either return the entries found within
 * `[startLedger, endLedger]` or throw — a caller must never treat a partial,
 * un-coverable, or errored read as an authoritative empty result.
 */
export interface LedgerOnChainSource {
  fetchLedgerEntries(
    startLedger: number,
    endLedger: number,
  ): Promise<OnChainLedgerEntry[]>;
}

/**
 * Maps aid_escrow contract event names to the `BalanceLedger.eventType`
 * vocabulary the rest of the backend writes (`lock` / `unlock` / `disburse`).
 * Events without a mapping (escrow_funded, batch_created, admin_rotated, …)
 * have no BalanceLedger counterpart and are skipped by the source.
 */
export const CONTRACT_EVENT_TO_BALANCE_LEDGER_TYPE: Record<string, string> = {
  package_created: 'lock',
  package_disbursed: 'disburse',
  package_revoked: 'unlock',
  package_refunded: 'unlock',
};

/**
 * Decode one aid_escrow `#[contractevent]` payload into an `OnChainLedgerEntry`.
 * Returns `null` for diagnostic/system events, events from other contracts,
 * unknown topic names, and events without a numeric `amount`.
 */
export function decodeContractEvent(
  event: xdr.ContractEvent,
  contractId: string,
  txHash: string,
  ledger: number,
  eventIndex: number,
): OnChainLedgerEntry | null {
  if (event.type() !== xdr.ContractEventType.contract()) {
    return null; // diagnostic / system events
  }
  const eventContractId = event.contractId();
  if (!eventContractId || StrKey.encodeContract(eventContractId as unknown as Buffer) !== contractId) {
    return null; // another contract's event
  }
  if (event.body().switch() !== 0) {
    return null; // only ContractEventBody v0 is defined
  }
  const v0 = event.body().v0();
  const topics = v0.topics();
  if (topics.length === 0 || topics[0].switch() !== xdr.ScValType.scvSymbol()) {
    return null;
  }
  const eventName = scValToNative(topics[0]) as string;
  const eventType = CONTRACT_EVENT_TO_BALANCE_LEDGER_TYPE[eventName];
  if (!eventType) {
    return null; // no BalanceLedger counterpart for this event
  }

  const data = scValToNative(v0.data()) as Record<string, unknown>;
  if (typeof data.amount !== 'bigint' && typeof data.amount !== 'number') {
    return null;
  }

  return {
    id: `${txHash}:${eventIndex}`,
    ledger,
    amount: data.amount.toString(),
    eventType,
  };
}

/**
 * Real on-chain source: pages the Stellar RPC `getTransactions` API over
 * `[startLedger, endLedger]` and decodes the aid_escrow contract's `#[contractevent]`
 * payloads (topic symbol + named data map) into `OnChainLedgerEntry`s.
 *
 * Coverage is explicit: the source throws when the requested range extends
 * beyond the chain head (`latestLedger < endLedger`), when the RPC's ledger
 * retention starts after `startLedger`, or when pagination is exhausted before
 * the range end could be confirmed. A fully covered range with no relevant
 * events legitimately returns `[]`.
 */
@Injectable()
export class SorobanLedgerOnChainSource implements LedgerOnChainSource {
  private static readonly PAGE_SIZE = 200;
  private static readonly MAX_PAGES = 500;

  private readonly logger = new Logger(SorobanLedgerOnChainSource.name);
  private readonly rpcUrl: string;
  private readonly contractId: string;
  private server: SorobanRpc.Server | null = null;

  constructor(configService: ConfigService) {
    this.rpcUrl = configService.get<string>(
      'STELLAR_RPC_URL',
      'https://soroban-testnet.stellar.org',
    );
    this.contractId = configService.get<string>('AID_ESCROW_CONTRACT_ID', '');
  }

  private getServer(): SorobanRpc.Server {
    if (!this.server) {
      this.server = new SorobanRpc.Server(this.rpcUrl, {
        allowHttp: this.rpcUrl.startsWith('http://'),
      });
    }
    return this.server;
  }

  async fetchLedgerEntries(
    startLedger: number,
    endLedger: number,
  ): Promise<OnChainLedgerEntry[]> {
    if (startLedger > endLedger) {
      throw new Error(
        `startLedger (${startLedger}) must be <= endLedger (${endLedger})`,
      );
    }
    if (!this.contractId) {
      throw new Error(
        'AID_ESCROW_CONTRACT_ID is not configured; cannot fetch on-chain ledger events',
      );
    }

    const server = this.getServer();
    const correlationId = `ledger-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const entries: OnChainLedgerEntry[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let rangeCovered = false;
    let maxLedgerSeen = 0;

    while (pages < SorobanLedgerOnChainSource.MAX_PAGES) {
      const page = await withRetryTimeout(
        () =>
          server.getTransactions(
            cursor
              ? {
                  pagination: {
                    cursor,
                    limit: SorobanLedgerOnChainSource.PAGE_SIZE,
                  },
                }
              : {
                  startLedger,
                  pagination: {
                    limit: SorobanLedgerOnChainSource.PAGE_SIZE,
                  },
                },
          ),
        `getTransactions(page=${pages + 1})`,
        correlationId,
        {},
        this.logger,
      );

      if (page.latestLedger >= endLedger) {
        rangeCovered = true;
      }
      if (page.oldestLedger > startLedger) {
        throw new Error(
          `On-chain source cannot cover ledgers ${startLedger}-${endLedger}: RPC retention starts at ledger ${page.oldestLedger}`,
        );
      }
      if (page.latestLedger < endLedger) {
        throw new Error(
          `On-chain source cannot cover ledgers ${startLedger}-${endLedger}: chain head is at ledger ${page.latestLedger}`,
        );
      }

      const transactions = page.transactions ?? [];
      for (const tx of transactions) {
        if (tx.ledger > endLedger) {
          cursor = '';
          break;
        }
        maxLedgerSeen = Math.max(maxLedgerSeen, tx.ledger);
        if (
          tx.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS &&
          tx.events?.contractEventsXdr
        ) {
          entries.push(
            ...this.extractEntries(tx.txHash, tx.ledger, tx.events.contractEventsXdr),
          );
        }
      }

      pages++;
      cursor = page.cursor;

      if (
        !cursor ||
        cursor === '' ||
        transactions.length === 0 ||
        maxLedgerSeen >= endLedger
      ) {
        break;
      }
    }

    if (!rangeCovered) {
      throw new Error(
        `On-chain source could not confirm coverage of ledgers ${startLedger}-${endLedger}`,
      );
    }

    return entries;
  }

  /**
   * Decode the contract events of one transaction into BalanceLedger entries.
   * The decoded `id` is `${transactionHash}:${eventIndex}` where `eventIndex`
   * is the position within the transaction's contract-event list.
   */
  private extractEntries(
    txHash: string,
    ledger: number,
    contractEvents: xdr.ContractEvent[][],
  ): OnChainLedgerEntry[] {
    const entries: OnChainLedgerEntry[] = [];
    let eventIndex = 0;

    for (const batch of contractEvents) {
      for (const event of batch) {
        const parsed = decodeContractEvent(
          event,
          this.contractId,
          txHash,
          ledger,
          eventIndex,
        );
        eventIndex++;
        if (parsed) {
          entries.push(parsed);
        }
      }
    }

    return entries;
  }
}
