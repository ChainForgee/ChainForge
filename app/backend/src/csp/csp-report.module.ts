import { Module } from '@nestjs/common';
import { CspReportController } from './csp-report.controller';
import { CspReportService } from './csp-report.service';
import { RedisService } from '../../cache/redis.service';
import { MetricsModule } from '../observability/metrics/metrics.module';

@Module({
  imports: [MetricsModule],
  controllers: [CspReportController],
  providers: [CspReportService, RedisService],
})
export class CspReportModule {}
