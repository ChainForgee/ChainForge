/**
 * Aggregate registry of NestJS "feature" modules for the backend.
 *
 * ``AppModule`` used to import ~25 first-party modules directly.  As
 * the surface grew that made a single forward-looking unit test of any
 * module transitively pull in the entire application graph — defeating
 * the very purpose of modularity.  Issue #256 calls for a registry so
 * ``AppModule`` becomes a thin shell that does nothing but wire the
 * registry and provide global filters / interceptors.
 *
 * The registry is intentionally flat: every domain module is listed
 * here once, in dependency-correct order.  When a new module is added
 * it goes here, not in ``AppModule`` — keeping the import collisions
 * reviewable in a single diff and avoiding the 700-line file we had
 * before.
 *
 * Cross-cutting infrastructure modules (Config / Bull / Redis /
 * Schedule / Throttler) are kept separately because they take
 * ``forRoot`` configuration that the registry must preserve verbatim.
 */

import type { DynamicModule, Type } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { RedisModule } from '@liaoliaots/nestjs-redis';

import { AidModule } from './aid/aid.module';
import { AidEscrowModule } from './onchain/aid-escrow.module';
import { AdminSearchModule } from './search/admin-search.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { AuditModule } from './audit/audit.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { ClaimsModule } from './claims/claims.module';
import { CommonServicesModule } from './common/services/common-services.module';
import { DeploymentMetadataModule } from './deployment-metadata/deployment-metadata.module';
import { EntityLinkingModule } from './entity-linking/entity-linking.module';
import { EvidenceModule } from './evidence/evidence.module';
import { HealthModule } from './health/health.module';
import { InvitesModule } from './orgs/invites.module';
import { JobsModule } from './jobs/jobs.module';
import { LoggerModule } from './logger/logger.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ObservabilityModule } from './observability/observability.module';
import { PrismaModule } from './prisma/prisma.module';
import { RetentionPolicyModule } from './retention-policy/retention-policy.module';
import { SandboxModule } from './sandbox/sandbox.module';
import { SecurityModule } from './common/security/security.module';
import { SessionModule } from './session/session.module';
import { TestErrorModule } from './test-error/test-error.module';
import { VerificationModule } from './verification/verification.module';

import { loadEnv } from './common/utils/env-loader';

/**
 * The single source of truth for first-party feature modules.
 *
 * Each entry is a NestJS module class; NestJS resolves the dependency
 * graph transitively from this list.  Cross-cutting infrastructure
 * (Config / Bull / Redis / Schedule / Throttler) lives in
 * {@link INFRASTRUCTURE_MODULES} so domain readers don't have to
 * scroll past 50 lines of ``forRootAsync`` boilerplate to find the
 * feature list.
 */
export const FEATURE_MODULES: Type<unknown>[] = [
  // Infrastructure-adjacent but feature-local.
  LoggerModule,
  PrismaModule,

  // Domain features, in loosely-dependency-correct order.
  // ``OnchainModule`` (./onchain/onchain.module) is deliberately NOT
  // listed here: the original ``AppModule`` only imported
  // ``AidEscrowModule`` (./onchain/aid-escrow.module).  Pulling in the
  // general on-chain module here would change the runtime adapter
  // graph and is out of scope for issue #256, which is purely a
  // refactor.
  HealthModule,
  AidModule,
  AidEscrowModule,
  VerificationModule,
  AuditModule,
  SecurityModule,
  TestErrorModule,
  CampaignsModule,
  ObservabilityModule,
  ClaimsModule,
  NotificationsModule,
  JobsModule,
  AnalyticsModule,
  ApiKeysModule,
  SessionModule,
  CommonServicesModule,
  EvidenceModule,
  RetentionPolicyModule,
  InvitesModule,
  AdminSearchModule,
  EntityLinkingModule,
  DeploymentMetadataModule,
  SandboxModule,
];

/**
 * Cross-cutting infrastructure modules wired up via ``forRoot`` /
 * ``forRootAsync``.  Kept apart from the feature list because every
 * entry uses a factory signature and a different runtime knob.
 */
function buildInfrastructureModules(): DynamicModule[] {
  return [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: loadEnv(),
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('REDIS_HOST') ?? 'localhost',
          port: parseInt(configService.get<string>('REDIS_PORT') ?? '6379', 10),
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          removeOnComplete: {
            age: 3600, // keep for 1 hour
            count: 1000,
          },
          removeOnFail: {
            age: 24 * 3600, // keep for 24 hours
            count: 5000,
          },
        },
      }),
      inject: [ConfigService],
    }),
    ScheduleModule.forRoot(),
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        config: {
          host: configService.get<string>('REDIS_HOST') ?? 'localhost',
          port: parseInt(configService.get<string>('REDIS_PORT') ?? '6379', 10),
        },
      }),
      inject: [ConfigService],
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60000, // 60 seconds window
        limit: 20, // default: 20 req/min
      },
    ]),
  ];
}

/**
 * Public surface: a single ``forRoot`` import for AppModule.
 *
 * Returns a DynamicModule whose ``imports`` array is the union of the
 * feature list and infrastructure ``forRoot(...)`` factories.  Tests
 * can call this directly to assert that no module is imported twice
 * transitively (Issue #256 acceptance criterion).
 */
export class FeatureModuleRegistry {
  static forRoot(): DynamicModule {
    return {
      module: FeatureModuleRegistry,
      global: true,
      imports: [...FEATURE_MODULES, ...buildInfrastructureModules()],
    };
  }
}

/**
 * Convenience export for tests and tooling that want to enumerate the
 * feature list without instantiating a ``DynamicModule``.
 */
export const FEATURE_MODULE_NAMES: string[] = FEATURE_MODULES.map(
  (m) => m?.name ?? '<anonymous>',
);
