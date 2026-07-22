import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Serializes Prisma Decimal values to strings in API responses.
 *
 * JavaScript Number cannot safely represent the full precision of
 * 38,18 Decimals.  Prisma already serialises Decimals as strings
 * when the `decimalNumbers` preview feature is not enabled, but
 * this interceptor provides an additional safety net for deeply
 * nested or programmatically constructed values.
 *
 * Registered as the LAST `APP_INTERCEPTOR` in AppModule so it
 * transforms the response after all other interceptors (including
 * ETag computation) have finished.
 */
@Injectable()
export class DecimalSerializerInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map(data => this.serializeDecimals(data)));
  }

  private serializeDecimals(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    // Date objects have toJSON but should not be transformed
    if (value instanceof Date) {
      return value;
    }

    // Duck-type Prisma Decimal: has a callable toJSON method
    // that returns a numeric string value.
    if (typeof value === 'object' && !Array.isArray(value)) {
      const toJsonFn = (value as Record<string, unknown>).toJSON;
      if (typeof toJsonFn === 'function') {
        const jsonVal = toJsonFn.call(value);
        if (typeof jsonVal === 'number' || typeof jsonVal === 'string') {
          return String(jsonVal);
        }
        return jsonVal;
      }
    }

    // Handle arrays
    if (Array.isArray(value)) {
      return value.map(item => this.serializeDecimals(item));
    }

    // Handle plain objects (recursively)
    if (typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(
        value as Record<string, unknown>,
      )) {
        result[key] = this.serializeDecimals(val);
      }
      return result;
    }

    return value;
  }
}
