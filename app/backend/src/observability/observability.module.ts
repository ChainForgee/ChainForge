import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { HealthModule } from 'src/health/health.module';
import { MetricsMiddleware } from './metrics/metrics.middleware';
import { MetricsModule } from './metrics/metrics.module';
import { TracingService } from './tracing/tracing.service';
import { UsageTrackerMiddleware } from './usage-tracker/usage-tracker.middleware';
import { UsageTrackerModule } from './usage-tracker/usage-tracker.module';
import { AuditModule } from 'src/audit/audit.module';

@Module({
  imports: [MetricsModule, HealthModule, UsageTrackerModule],
  providers: [TracingService],
  exports: [MetricsModule, HealthModule, TracingService, UsageTrackerModule],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(MetricsMiddleware, UsageTrackerMiddleware)
      .forRoutes('*');
  }
}
