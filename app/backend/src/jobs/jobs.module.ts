import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { JobsController } from './jobs.controller';
import { RETENTION_PURGE_QUEUE } from '../retention-policy/retention-purge.processor';
import { DlqService } from './dlq.service';
import { SecurityEventJob } from './security-event.job';
import { UsageTrackerModule } from '../observability/usage-tracker/usage-tracker.module';
import { AuditModule } from '../audit/audit.module';
import { BalanceLedgerSnapshotJob } from './balance-ledger-snapshot.job';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'verification' }),
    BullModule.registerQueue({ name: 'notifications' }),
    BullModule.registerQueue({ name: 'onchain' }),
    BullModule.registerQueue({ name: RETENTION_PURGE_QUEUE }),
    BullModule.registerQueue({ name: 'dead-letter' }),
    UsageTrackerModule,
    AuditModule,
    PrismaModule,
  ],
  controllers: [JobsController],
  providers: [DlqService, SecurityEventJob, BalanceLedgerSnapshotJob],
  exports: [DlqService, SecurityEventJob, BalanceLedgerSnapshotJob],
})
export class JobsModule {}
