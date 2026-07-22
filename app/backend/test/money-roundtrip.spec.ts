import { DecimalSerializerInterceptor } from '../src/common/interceptors/decimal-serializer.interceptor';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';
import { Decimal } from '@prisma/client/runtime/library';

describe('DecimalSerializerInterceptor', () => {
  const interceptor = new DecimalSerializerInterceptor();
  const mockContext = {} as ExecutionContext;

  function createCallHandler(data: unknown): CallHandler {
    return {
      handle: () => of(data),
    };
  }

  it('should convert Decimal values to strings', done => {
    const decimalValue = new Decimal('1000.5');
    const data = { amount: decimalValue, name: 'test' };

    const result$ = interceptor.intercept(mockContext, createCallHandler(data));

    result$.subscribe((result: any) => {
      expect(result.amount).toBe('1000.5');
      expect(result.name).toBe('test');
      done();
    });
  });

  it('should handle nested Decimal values', done => {
    const data = {
      campaign: {
        budget: new Decimal('50000.00'),
        name: 'Test Campaign',
      },
      claims: [
        { amount: new Decimal('100.50') },
        { amount: new Decimal('200.75') },
      ],
    };

    const result$ = interceptor.intercept(mockContext, createCallHandler(data));

    result$.subscribe((result: any) => {
      expect(result.campaign.budget).toBe('50000');
      expect(result.claims[0].amount).toBe('100.5');
      expect(result.claims[1].amount).toBe('200.75');
      done();
    });
  });

  it('should preserve non-Decimal numeric values', done => {
    const data = {
      count: 42,
      percentage: 0.85,
      amount: new Decimal('100.00'),
    };

    const result$ = interceptor.intercept(mockContext, createCallHandler(data));

    result$.subscribe((result: any) => {
      expect(result.count).toBe(42);
      expect(result.percentage).toBe(0.85);
      expect(result.amount).toBe('100');
      done();
    });
  });

  it('should handle null and undefined values', done => {
    const data = {
      amount: null,
      value: undefined,
      other: new Decimal('123.45'),
    };

    const result$ = interceptor.intercept(mockContext, createCallHandler(data));

    result$.subscribe((result: any) => {
      expect(result.amount).toBeNull();
      expect(result.value).toBeUndefined();
      expect(result.other).toBe('123.45');
      done();
    });
  });

  it('should handle array of objects with Decimal values', done => {
    const data = [
      { id: '1', amount: new Decimal('100.00') },
      { id: '2', amount: new Decimal('200.00') },
    ];

    const result$ = interceptor.intercept(mockContext, createCallHandler(data));

    result$.subscribe((result: any) => {
      expect(result[0].amount).toBe('100');
      expect(result[1].amount).toBe('200');
      done();
    });
  });
});

describe('Decimal round-trip precision', () => {
  it('should preserve precision for common monetary values', () => {
    const testCases = [
      '0.01',
      '0.1',
      '1',
      '10.5',
      '100.99',
      '1000.5',
      '10000',
      '99999999.99',
      '0.001',
      '0.0001',
    ];

    for (const testCase of testCases) {
      const decimal = new Decimal(testCase);
      const stringValue = decimal.toString();
      const reconstructed = new Decimal(stringValue);

      expect(stringValue).toBe(testCase);
      expect(decimal.equals(reconstructed)).toBe(true);
    }
  });

  it('should handle the specific value from the issue: 1000.5', () => {
    const decimal = new Decimal('1000.5');
    const stringValue = decimal.toString();
    const reconstructed = new Decimal(stringValue);

    expect(stringValue).toBe('1000.5');
    expect(decimal.equals(reconstructed)).toBe(true);

    // Verify that Float would fail this
    const floatValue = parseFloat('1000.5');
    expect(floatValue.toString()).toBe('1000.5'); // This happens to work for simple cases
    // But for complex cases like 0.1 + 0.2:
    const floatSum = 0.1 + 0.2;
    expect(floatSum).not.toBe(0.3); // Float precision issue
    const decimalSum = new Decimal('0.1').add(new Decimal('0.2'));
    expect(decimalSum.equals(new Decimal('0.3'))).toBe(true); // Decimal precision works
  });
});
