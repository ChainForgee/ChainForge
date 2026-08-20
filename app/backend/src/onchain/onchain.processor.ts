import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger, Inject } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  OnchainJobData,
  OnchainJobResult,
  OnchainOperationType,
} from './interfaces/onchain-job.interface';
import {
  ONCHAIN_ADAPTER_TOKEN,
  OnchainAdapter,
  InitEscrowResult,
  CreateClaimResult,
  DisburseResult,
} from './onchain.adapter';

import { DlqService } from '../jobs/dlq.service';
import { MetricsService } from '../observability/metrics/metrics.service';
import { LedgerBackfillService, BackfillJobData } from './ledger-backfill.service';
import {
  LedgerReconciliationService,
  ReconciliationJobData,
} from './ledger-reconciliation.service';

@Processor('onchain', {
  concurrency: 1, // Usually sequential for blockchain transactions
})
export class OnchainProcessor extends WorkerHost {
  private readonly logger = new Logger(OnchainProcessor.name);

  constructor(
    @Inject(ONCHAIN_ADAPTER_TOKEN)
    private readonly onchainAdapter: OnchainAdapter,
    private readonly dlqService: DlqService,
    private readonly metricsService: MetricsService,
    private readonly reconciliationService: LedgerReconciliationService,
    private readonly backfillService: LedgerBackfillService,
  ) {
    super();
  }

  async process(
    job: Job<
      OnchainJobData | ReconciliationJobData | BackfillJobData,
      OnchainJobResult,
      string
    >,
  ): Promise<OnchainJobResult> {
    const startedAt = Date.now();
    const operation = String((job.data as OnchainJobData).type);
    const correlationSuffix = (job.data as OnchainJobData).correlationId
      ? ` [correlationId=${(job.data as OnchainJobData).correlationId}]`
      : '';

    this.logger.log(
      `Processing onchain ${operation} (attempt ${job.attemptsMade + 1})${correlationSuffix}`,
    );

    try {
      // Ledger admin jobs share the 'onchain' queue but are dispatched by job
      // name to their dedicated services.
      if (job.name === 'ledger-reconciliation') {
        const report = await this.reconciliationService.processReconciliation(
          job.data as ReconciliationJobData,
        );
        return {
          success: true,
          metadata: { reconciliation: report },
        };
      }
      if (job.name === 'ledger-backfill') {
        const result = await this.backfillService.processBackfillBatch(
          job.data as BackfillJobData,
        );
        return {
          success: true,
          metadata: { backfill: result },
        };
      }

      let result: InitEscrowResult | CreateClaimResult | DisburseResult;
      const onchainData = job.data as OnchainJobData;
      switch (onchainData.type) {
        case OnchainOperationType.INIT_ESCROW:
          result = await this.onchainAdapter.initEscrow(onchainData.params);
          break;
        case OnchainOperationType.CREATE_CLAIM:
          result = await this.onchainAdapter.createClaim(onchainData.params);
          break;
        case OnchainOperationType.DISBURSE:
          result = await this.onchainAdapter.disburse(onchainData.params);
          break;
        default: {
          const unhandled: never = onchainData as never;
          throw new Error(
            `Unknown onchain operation type: ${String(unhandled)}`,
          );
        }
      }

      if (result.status === 'failed') {
        throw new Error(`Onchain operation failed: ${String(onchainData.type)}`);
      }

      this.metricsService.recordContractCallLatency(
        operation,
        'success',
        (Date.now() - startedAt) / 1000,
      );

      return {
        success: true,
        transactionHash: result.transactionHash,
        metadata: result.metadata,
      };
    } catch (error) {
      const errMessage =
        error instanceof Error
          ? error.message.toLowerCase()
          : String(error).toLowerCase();
      const isTransient =
        errMessage.includes('timeout') ||
        errMessage.includes('congestion') ||
        errMessage.includes('rate limit') ||
        errMessage.includes('too many requests') ||
        errMessage.includes('tx_too_late');

      if (isTransient) {
        this.logger.warn(
          `Onchain job ${job.id} encountered transient network/congestion error: ${error instanceof Error ? error.message : 'Unknown error'}. Relying on exponential backoff.`,
        );
      } else {
        this.logger.error(
          `Onchain job ${job.id} failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
      this.metricsService.recordContractCallLatency(
        operation,
        'failed',
        (Date.now() - startedAt) / 1000,
      );
      if (errMessage.includes('transaction') || errMessage.includes('tx_')) {
        this.metricsService.incrementTxSubmissionFailure(
          operation,
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<OnchainJobData, OnchainJobResult>) {
    this.logger.log(`Onchain job ${job.id} completed successfully`);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<OnchainJobData> | undefined, error: Error) {
    if (job) {
      this.logger.error(`Onchain job ${job.id} failed: ${error.message}`);
      this.metricsService.incrementCallbackFailure(
        'onchain_job',
        error.message,
      );
      await this.dlqService.moveToDlq('onchain', job, error);
    } else {
      this.logger.error(`Onchain job failed: ${error.message}`);
    }
  }
}
