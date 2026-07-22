import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ApiKeyUsageTrackerService } from './api-key-usage-tracker.service';
import { MetricsModule } from '../metrics/metrics.module';

@Module({
  imports: [ConfigModule, MetricsModule],
  providers: [ApiKeyUsageTrackerService],
  exports: [ApiKeyUsageTrackerService],
})
export class UsageTrackerModule {}
