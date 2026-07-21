import { DecimalSerializerInterceptor } from '../src/common/interceptors/decimal-serializer.interceptor';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';
import { lastValueFrom } from 'rxjs';

// ---------------------------------------------------------------------------
// Mock Prisma Decimal-like objects
// ---------------------------------------------------------------------------

/**
 * Simulates a Prisma Decimal object returned from the database.
 * Prisma's Decimal type serialises via the `toJSON` method.
 */
function prismaDecimal(value: string) {
  return {
    toString: () => value,
    toJSON: () => value,
    s: 1,               // sign
    e: value.length - 1, // exponent
    d: value.split('').map(Number).filter(c => c >= 0), // digits
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Decimal Money Round-trip', () => {
  let interceptor: DecimalSerializerInterceptor;
  let mockContext: ExecutionContext;
  let mockCallHandler: CallHandler;

  beforeEach(() => {
    interceptor = new DecimalSerializerInterceptor();
    mockContext = {} as ExecutionContext;
  });

  describe('Prisma Decimal serialization', () => {
    it('should convert Prisma Decimal to string', async () => {
      const data = { amount: prismaDecimal('1000.50') };
      mockCallHandler = { handle: () => of(data) } as CallHandler;

      const result = await lastValueFrom(
        interceptor.intercept(mockContext, mockCallHandler),
      );

      expect(result).toEqual({ amount: '1000.50' });
    });

    it('should handle zero values', async () => {
      const data = { amount: prismaDecimal('0.00') };
      mockCallHandler = { handle: () => of(data) } as CallHandler;

      const result = await lastValueFrom(
        interceptor.intercept(mockContext, mockCallHandler),
      );

      expect(result).toEqual({ amount: '0.00' });
    });

    it('should handle very large Decimal values', async () => {
      const largeValue = '999999999999999999.999999999999999999';
      const data = { amount: prismaDecimal(largeValue) };
      mockCallHandler = { handle: () => of(data) } as CallHandler;

      const result = await lastValueFrom(
        interceptor.intercept(mockContext, mockCallHandler),
      );

      expect(result).toEqual({ amount: largeValue });
    });

    it('should handle negative values', async () => {
      const data = { amount: prismaDecimal('-500.25') };
      mockCallHandler = { handle: () => of(data) } as CallHandler;

      const result = await lastValueFrom(
        interceptor.intercept(mockContext, mockCallHandler),
      );

      expect(result).toEqual({ amount: '-500.25' });
    });

    it('should handle nested objects with Decimal', async () => {
      const data = {
        campaign: {
          budget: prismaDecimal('10000.00'),
          packages: [
            { totalAmount: prismaDecimal('5000.00') },
            { totalAmount: prismaDecimal('3000.00') },
          ],
        },
      };
      mockCallHandler = { handle: () => of(data) } as CallHandler;

      const result = await lastValueFrom(
        interceptor.intercept(mockContext, mockCallHandler),
      );

      expect(result).toEqual({
        campaign: {
          budget: '10000.00',
          packages: [
            { totalAmount: '5000.00' },
            { totalAmount: '3000.00' },
          ],
        },
      });
    });

    it('should not convert regular numbers', async () => {
      const data = { count: 42, name: 'test' };
      mockCallHandler = { handle: () => of(data) } as CallHandler;

      const result = await lastValueFrom(
        interceptor.intercept(mockContext, mockCallHandler),
      );

      expect(result).toEqual({ count: 42, name: 'test' });
    });

    it('should handle null and undefined values', async () => {
      const data = { amount: null, optional: undefined };
      mockCallHandler = { handle: () => of(data) } as CallHandler;

      const result = await lastValueFrom(
        interceptor.intercept(mockContext, mockCallHandler),
      );

      expect(result).toEqual({ amount: null, optional: undefined });
    });

    it('should handle arrays of Decimals', async () => {
      const data = {
        amounts: [
          prismaDecimal('100.00'),
          prismaDecimal('200.00'),
          prismaDecimal('300.00'),
        ],
      };
      mockCallHandler = { handle: () => of(data) } as CallHandler;

      const result = await lastValueFrom(
        interceptor.intercept(mockContext, mockCallHandler),
      );

      expect(result).toEqual({
        amounts: ['100.00', '200.00', '300.00'],
      });
    });
  });

  describe('Precision preservation', () => {
    it('should preserve USDC cent precision (0.01)', async () => {
      const data = { amount: prismaDecimal('0.01') };
      mockCallHandler = { handle: () => of(data) } as CallHandler;

      const result = await lastValueFrom(
        interceptor.intercept(mockContext, mockCallHandler),
      );

      expect(result).toEqual({ amount: '0.01' });
    });

    it('should not exhibit 0.1 + 0.2 floating point error', async () => {
      const sum = '0.30';
      // In floating point: 0.1 + 0.2 = 0.30000000000000004
      // In Decimal: sum is exactly '0.30'
      const data = { amount: prismaDecimal(sum) };
      mockCallHandler = { handle: () => of(data) } as CallHandler;

      const result = await lastValueFrom(
        interceptor.intercept(mockContext, mockCallHandler),
      );

      // Verify no floating point precision loss
      expect(result).toEqual({ amount: '0.30' });
      expect(result.amount).not.toBe('0.30000000000000004');
    });

    it('should preserve 38-digit decimal values', async () => {
      const preciseValue = '12345678901234567890.123456789012345678';
      const data = { amount: prismaDecimal(preciseValue) };
      mockCallHandler = { handle: () => of(data) } as CallHandler;

      const result = await lastValueFrom(
        interceptor.intercept(mockContext, mockCallHandler),
      );

      expect(result).toEqual({ amount: preciseValue });
    });
  });
});
