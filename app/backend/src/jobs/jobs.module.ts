import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { JobsController } from './jobs.controller';
import { RETENTION_PURGE_QUEUE } from '../retention-policy/retention-purge.processor';
import { DlqService } from './dlq.service';
import { SecurityEventJob } from './security-event.job';
import { UsageTrackerModule } from '../observability/usage-tracker/usage-tracker.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'verification' }),
    BullModule.registerQueue({ name: 'notifications' }),
    BullModule.registerQueue({ name: 'onchain' }),
    BullModule.registerQueue({ name: RETENTION_PURGE_QUEUE }),
    BullModule.registerQueue({ name: 'dead-letter' }),
    UsageTrackerModule,
  ],
  controllers: [JobsController],
  providers: [DlqService, SecurityEventJob],
  exports: [DlqService],
})
export class JobsModule {}
