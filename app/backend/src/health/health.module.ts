import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { LoggerModule } from '../logger/logger.module';
import { OnchainModule } from '../onchain/onchain.module';
import { RedisModule } from '@liaoliaots/nestjs-redis';

@Module({
  imports: [LoggerModule, OnchainModule, RedisModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
