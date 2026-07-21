import { Module } from '@nestjs/common';
import { UsageTrackerService } from './usage-tracker.service';
import { MetricsModule } from '../metrics/metrics.module';
import { AuditModule } from '../../audit/audit.module';

@Module({
  imports: [MetricsModule, AuditModule],
  providers: [UsageTrackerService],
  exports: [UsageTrackerService],
})
export class UsageTrackerModule {}
