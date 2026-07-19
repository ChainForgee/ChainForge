import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import {
  PAGINATION_DEFAULTS_KEY,
  PaginationDefaultsOptions,
} from '../decorators/pagination.decorator';

@Injectable()
export class PaginationInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const handler = context.getHandler();

    // Check handler metadata first, then controller class metadata
    const defaults =
      this.reflector.getAllAndOverride<PaginationDefaultsOptions>(
        PAGINATION_DEFAULTS_KEY,
        [handler, context.getClass()],
      ) || { default: 25, max: 100 };

    const defaultLimit = defaults.default ?? 25;
    const maxLimit = defaults.max ?? 100;

    let limit = defaultLimit;
    if (request.query.limit !== undefined) {
      const parsed = parseInt(request.query.limit, 10);
      if (!isNaN(parsed)) {
        limit = Math.min(maxLimit, Math.max(1, parsed));
      }
    }

    const cursor =
      typeof request.query.cursor === 'string' &&
      request.query.cursor.trim() !== ''
        ? request.query.cursor
        : undefined;

    request.pagination = { limit, cursor };

    return next.handle();
  }
}
