import { Logger, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { FeatureModuleRegistry } from './feature-modules.registry';
import { LoggerModule } from './logger/logger.module';

import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { ApiKeyGuard } from './common/guards/api-key.guard';
import { RolesGuard } from './auth/roles.guard';
import { AdaptiveRateLimitGuard } from './common/guards/adaptive-rate-limit.guard';
import { DeprecationInterceptor } from './common/interceptors/deprecation.interceptor';
import { HttpCacheInterceptor } from './common/interceptors/http-cache.interceptor';
import { LoggingInterceptor } from './interceptors/logging.interceptor';
import { RequestCorrelationMiddleware } from './middleware/request-correlation.middleware';
import { CsrfMiddleware } from './common/security/csrf.middleware';

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
 *
 * Note: this module does NOT inject {@link LoggerService} from the
 * bespoke ``logger`` package.  The bespoke service lives behind a
 * factory-consumer pair that used to be imported directly here, and
 * removing the constructor dependency keeps the test surface clean
 * (``Test.createTestingModule({imports: [AppModule]}).compile()`` now
 * resolves cleanly without spinning up every module in the registry).
 * The startup banner uses NestJS's built-in ``Logger`` which is
 * available without DI and follows Nest conventions.
 */
@Module({
  // LoggerModule is wired as a *direct* sibling import alongside
  // ``FeatureModuleRegistry`` because the bespoke ``AllExceptionsFilter``
  // (registered below as APP_FILTER) injects ``LoggerService`` and the
  // DI container needs the LoggerModule export chain to be reachable
  // from AppModule's scope.  Nested-DynamicModule imports in NestJS do
  // not always hoist exported providers reliably across test fixtures,
  // so an explicit sibling import is the most defensive approach.
  imports: [LoggerModule, FeatureModuleRegistry.forRoot()],
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
  private readonly logger = new Logger(AppModule.name);

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestCorrelationMiddleware).forRoutes('*');
    // CSRF middleware: gated behind CSRF_PROTECTION_ENABLED env variable.
    // See docs/security/csrf-posture.md for the current posture.
    consumer.apply(CsrfMiddleware).forRoutes('*');
    this.logger.log(
      'AppModule initialized with structured logging, correlation IDs, rate limiting, and CSRF protection',
    );
  }
}
