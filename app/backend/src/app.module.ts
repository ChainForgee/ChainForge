import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { FeatureModuleRegistry } from './feature-modules.registry';

import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { ApiKeyGuard } from './common/guards/api-key.guard';
import { RolesGuard } from './auth/roles.guard';
import { AdaptiveRateLimitGuard } from './common/guards/adaptive-rate-limit.guard';
import { DeprecationInterceptor } from './common/interceptors/deprecation.interceptor';
import { HttpCacheInterceptor } from './common/interceptors/http-cache.interceptor';
import { LoggingInterceptor } from './interceptors/logging.interceptor';
import { RequestCorrelationMiddleware } from './middleware/request-correlation.middleware';
import { LoggerService } from './logger/logger.service';

/**
 * Top-level application module.
 *
 * All first-party feature modules and infrastructure ``forRoot(...)``
 * factories are wired through {@link FeatureModuleRegistry}; this file
 * only declares the controllers, global guards, filters and
 * interceptors that span every route.  The split keeps the import
 * graph reviewable (one diff for every new module, plenty of unit-test
 * surface) and means a unit test of any single module can stand it up
 * without pulling in the rest of the application (Issue #256).
 */
@Module({
  imports: [FeatureModuleRegistry.forRoot()],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // ApiKeyGuard before RolesGuard so request.user is populated.
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: AdaptiveRateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: DeprecationInterceptor },
    // HttpCacheInterceptor runs closest to the route handler to
    // observe the raw response body for ETag computation.
    { provide: APP_INTERCEPTOR, useClass: HttpCacheInterceptor },
  ],
})
export class AppModule implements NestModule {
  constructor(
    private readonly loggerService: LoggerService,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestCorrelationMiddleware).forRoutes('*');
    this.loggerService.log(
      'AppModule initialized with structured logging, correlation IDs, and rate limiting',
      'AppModule',
    );
  }
}
