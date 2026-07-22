import { MoneyMinorUnits } from './money-minor-units';

describe('MoneyMinorUnits', () => {
  const USDC_ADDRESS = 'USDC_CONTRACT_ADDRESS';
  const ETH_ADDRESS = 'ETH_CONTRACT_ADDRESS';

  describe('creation', () => {
    it('should create from minor units', () => {
      const amount = MoneyMinorUnits.fromMinor('100050000', USDC_ADDRESS);
      expect(amount.toMinor()).toBe(100050000n);
      expect(amount.getTokenAddress()).toBe(USDC_ADDRESS);
    });

    it('should create from major units', () => {
      const amount = MoneyMinorUnits.fromMajor('100.50', 6, USDC_ADDRESS);
      expect(amount.toMinor()).toBe(100500000n);
    });

    it('should create zero amount', () => {
      const amount = MoneyMinorUnits.fromMinor('0', USDC_ADDRESS);
      expect(amount.isZero()).toBe(true);
    });

    it('should reject negative amounts', () => {
      expect(() => MoneyMinorUnits.fromMinor('-100', USDC_ADDRESS)).toThrow(
        'MoneyMinorUnits cannot be negative',
      );
    });
  });

  describe('conversion', () => {
    it('should convert to major units', () => {
      const amount = MoneyMinorUnits.fromMinor('100500000', USDC_ADDRESS);
      expect(amount.toMajor(6)).toBe('100.500000');
    });

    it('should handle zero padding', () => {
      const amount = MoneyMinorUnits.fromMinor('1', USDC_ADDRESS);
      expect(amount.toMajor(6)).toBe('0.000001');
    });

    it('should handle whole numbers', () => {
      const amount = MoneyMinorUnits.fromMinor('100000000', USDC_ADDRESS);
      expect(amount.toMajor(6)).toBe('100.000000');
    });

    it('should format with locale', () => {
      const amount = MoneyMinorUnits.fromMinor('100500000', USDC_ADDRESS);
      const formatted = amount.format(6, 'en-US');
      expect(formatted).toBe('100.500000');
    });
  });

  describe('arithmetic', () => {
    it('should add amounts', () => {
      const a = MoneyMinorUnits.fromMinor('100000', USDC_ADDRESS);
      const b = MoneyMinorUnits.fromMinor('200000', USDC_ADDRESS);
      const result = a.add(b);
      expect(result.toMinor()).toBe(300000n);
    });

    it('should subtract amounts', () => {
      const a = MoneyMinorUnits.fromMinor('300000', USDC_ADDRESS);
      const b = MoneyMinorUnits.fromMinor('100000', USDC_ADDRESS);
      const result = a.sub(b);
      expect(result.toMinor()).toBe(200000n);
    });

    it('should multiply by scalar', () => {
      const a = MoneyMinorUnits.fromMinor('100000', USDC_ADDRESS);
      const result = a.mul(3n);
      expect(result.toMinor()).toBe(300000n);
    });

    it('should reject subtraction resulting in negative', () => {
      const a = MoneyMinorUnits.fromMinor('100000', USDC_ADDRESS);
      const b = MoneyMinorUnits.fromMinor('200000', USDC_ADDRESS);
      expect(() => a.sub(b)).toThrow('Insufficient funds');
    });

    it('should reject operations on different tokens', () => {
      const a = MoneyMinorUnits.fromMinor('100000', USDC_ADDRESS);
      const b = MoneyMinorUnits.fromMinor('200000', ETH_ADDRESS);
      expect(() => a.add(b)).toThrow('Cannot operate on different tokens');
    });
  });

  describe('comparison', () => {
    it('should compare equal amounts', () => {
      const a = MoneyMinorUnits.fromMinor('100000', USDC_ADDRESS);
      const b = MoneyMinorUnits.fromMinor('100000', USDC_ADDRESS);
      expect(a.equals(b)).toBe(true);
      expect(a.compare(b)).toBe(0);
    });

    it('should compare less than', () => {
      const a = MoneyMinorUnits.fromMinor('100000', USDC_ADDRESS);
      const b = MoneyMinorUnits.fromMinor('200000', USDC_ADDRESS);
      expect(a.compare(b)).toBe(-1);
    });

    it('should compare greater than', () => {
      const a = MoneyMinorUnits.fromMinor('200000', USDC_ADDRESS);
      const b = MoneyMinorUnits.fromMinor('100000', USDC_ADDRESS);
      expect(a.compare(b)).toBe(1);
    });
  });

  describe('round-trip precision', () => {
    it('should preserve precision for the specific value from the issue', () => {
      const amount = MoneyMinorUnits.fromMajor('123', 6, USDC_ADDRESS);
      expect(amount.toMajor(6)).toBe('123.000000');
      expect(amount.format(6)).toBe('123.000000');
    });

    it('should handle the value from the acceptance criteria', () => {
      const amount = MoneyMinorUnits.fromMinor('123', USDC_ADDRESS);
      const doubled = amount.mul(2n);
      expect(doubled.format(0)).toBe('246');
    });

    it('should handle complex decimal operations losslessly', () => {
      const a = MoneyMinorUnits.fromMajor('0.1', 18, USDC_ADDRESS);
      const b = MoneyMinorUnits.fromMajor('0.2', 18, USDC_ADDRESS);
      const sum = a.add(b);
      const expected = MoneyMinorUnits.fromMajor('0.3', 18, USDC_ADDRESS);
      expect(sum.equals(expected)).toBe(true);
    });
  });

  describe('Prisma integration', () => {
    it('should convert to Prisma Decimal', () => {
      const amount = MoneyMinorUnits.fromMinor('100500000', USDC_ADDRESS);
      const decimal = amount.toPrismaDecimal(6);
      expect(decimal.toString()).toBe('100.500000');
    });
  });
});
