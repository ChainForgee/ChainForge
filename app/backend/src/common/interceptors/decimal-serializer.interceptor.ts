import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';

/**
 * Recursively converts Prisma Decimal values (which are objects with a
 * `toString()` method) to their string representation in API responses.
 *
 * This ensures monetary values are serialized as strings (e.g., "1000.50")
 * rather than floating-point numbers, preventing precision loss in clients.
 */
function serializeDecimals(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Prisma Decimal objects have a `toString()` method and a `valueOf()` method
  if (
    typeof obj === 'object' &&
    'toString' in obj &&
    typeof (obj as { valueOf: () => unknown }).valueOf === 'function'
  ) {
    const str = (obj as { toString: () => string }).toString();
    // Check if it looks like a decimal number (contains only digits, dots, and optional minus sign)
    if (/^-?\d+(\.\d+)?$/.test(str)) {
      return str;
    }
  }

  if (Array.isArray(obj)) {
    return obj.map(serializeDecimals);
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = serializeDecimals(value);
    }
    return result;
  }

  return obj;
}

@Injectable()
export class DecimalSerializerInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((data) => serializeDecimals(data)),
    );
  }
}
