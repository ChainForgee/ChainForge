import { MoneyMinorUnits } from '../money-minor-units';

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('MoneyMinorUnits', () => {
  describe('fromBigInt', () => {
    it('stores the raw bigint', () => {
      const m = MoneyMinorUnits.fromBigInt(500n);
      expect(m.toBigInt()).toBe(500n);
    });

    it('stores an optional token', () => {
      const m = MoneyMinorUnits.fromBigInt(100n, 'USDC');
      expect(m.token).toBe('USDC');
    });

    it('token is undefined when omitted', () => {
      const m = MoneyMinorUnits.fromBigInt(100n);
      expect(m.token).toBeUndefined();
    });
  });

  describe('fromMinor', () => {
    it('parses a whole-number string', () => {
      expect(MoneyMinorUnits.fromMinor('123', 6).toBigInt()).toBe(123_000_000n);
    });

    it('parses a decimal string', () => {
      expect(MoneyMinorUnits.fromMinor('123.456', 6).toBigInt()).toBe(123_456_000n);
    });

    it('parses a fractional-only string', () => {
      expect(MoneyMinorUnits.fromMinor('0.5', 6).toBigInt()).toBe(500_000n);
    });

    it('truncates excess fractional digits', () => {
      expect(MoneyMinorUnits.fromMinor('1.1234567', 6).toBigInt()).toBe(1_123_456n);
    });

    it('pads short fractional part', () => {
      expect(MoneyMinorUnits.fromMinor('1.1', 6).toBigInt()).toBe(1_100_000n);
    });

    it('handles leading zeros in integer part', () => {
      expect(MoneyMinorUnits.fromMinor('00123', 6).toBigInt()).toBe(123_000_000n);
    });

    it('handles zero', () => {
      expect(MoneyMinorUnits.fromMinor('0', 6).toBigInt()).toBe(0n);
    });

    it('rejects decimals out of range', () => {
      expect(() => MoneyMinorUnits.fromMinor('1', -1)).toThrow(RangeError);
      expect(() => MoneyMinorUnits.fromMinor('1', 39)).toThrow(RangeError);
    });
  });

  describe('zero', () => {
    it('returns zero with no token', () => {
      const z = MoneyMinorUnits.zero();
      expect(z.toBigInt()).toBe(0n);
      expect(z.token).toBeUndefined();
    });
  });

  // ── Arithmetic ────────────────────────────────────────────────────────

  describe('add', () => {
    it('adds two tokenless amounts', () => {
      const a = MoneyMinorUnits.fromBigInt(100n);
      const b = MoneyMinorUnits.fromBigInt(200n);
      expect(a.add(b).toBigInt()).toBe(300n);
    });

    it('adds two amounts with the same token', () => {
      const a = MoneyMinorUnits.fromBigInt(100n, 'USDC');
      const b = MoneyMinorUnits.fromBigInt(200n, 'USDC');
      expect(a.add(b).toBigInt()).toBe(300n);
      expect(a.add(b).token).toBe('USDC');
    });

    it('throws on token mismatch', () => {
      const a = MoneyMinorUnits.fromBigInt(100n, 'USDC');
      const b = MoneyMinorUnits.fromBigInt(200n, 'USDT');
      expect(() => a.add(b)).toThrow('token address mismatch');
    });

    it('allows adding tokenless to token-bearing (uses the token)', () => {
      const a = MoneyMinorUnits.fromBigInt(100n, 'USDC');
      const b = MoneyMinorUnits.fromBigInt(200n);
      expect(a.add(b).token).toBe('USDC');
    });
  });

  describe('sub', () => {
    it('subtracts two amounts', () => {
      const a = MoneyMinorUnits.fromBigInt(500n);
      const b = MoneyMinorUnits.fromBigInt(200n);
      expect(a.sub(b).toBigInt()).toBe(300n);
    });

    it('throws on token mismatch', () => {
      expect(() =>
        MoneyMinorUnits.fromBigInt(500n, 'ETH').sub(MoneyMinorUnits.fromBigInt(200n, 'BTC')),
      ).toThrow('token address mismatch');
    });

    it('allows negative result', () => {
      const a = MoneyMinorUnits.fromBigInt(100n);
      const b = MoneyMinorUnits.fromBigInt(500n);
      expect(a.sub(b).toBigInt()).toBe(-400n);
    });
  });

  describe('mul', () => {
    it('multiplies by a bigint', () => {
      const m = MoneyMinorUnits.fromBigInt(10n);
      expect(m.mul(3n).toBigInt()).toBe(30n);
    });

    it('multiplies by a number', () => {
      const m = MoneyMinorUnits.fromBigInt(10n);
      expect(m.mul(3).toBigInt()).toBe(30n);
    });

    it('preserves token', () => {
      const m = MoneyMinorUnits.fromBigInt(10n, 'USDC');
      expect(m.mul(2n).token).toBe('USDC');
    });
  });

  // ── Equality ──────────────────────────────────────────────────────────

  describe('equals', () => {
    it('returns true for same value and token', () => {
      const a = MoneyMinorUnits.fromBigInt(100n, 'USDC');
      const b = MoneyMinorUnits.fromBigInt(100n, 'USDC');
      expect(a.equals(b)).toBe(true);
    });

    it('returns false for different value', () => {
      const a = MoneyMinorUnits.fromBigInt(100n);
      const b = MoneyMinorUnits.fromBigInt(200n);
      expect(a.equals(b)).toBe(false);
    });

    it('returns false for different token', () => {
      const a = MoneyMinorUnits.fromBigInt(100n, 'USDC');
      const b = MoneyMinorUnits.fromBigInt(100n, 'USDT');
      expect(a.equals(b)).toBe(false);
    });
  });

  // ── Formatting ────────────────────────────────────────────────────────

  describe('format', () => {
    it('formats a whole number', () => {
      expect(MoneyMinorUnits.fromMinor('123', 6).format(6)).toBe('123.000000');
    });

    it('formats a fractional number', () => {
      expect(MoneyMinorUnits.fromMinor('123.456', 6).format(6)).toBe('123.456000');
    });

    it('formats a small number', () => {
      expect(MoneyMinorUnits.fromMinor('0.0005', 6).format(6)).toBe('0.000500');
    });

    it('formats zero', () => {
      expect(MoneyMinorUnits.zero().format(6)).toBe('0.000000');
    });

    it('formats a negative number', () => {
      const neg = MoneyMinorUnits.fromBigInt(-500n);
      expect(neg.format(6)).toBe('-0.000500');
    });

    it('formats with different decimal places', () => {
      expect(MoneyMinorUnits.fromMinor('1.5', 2).format(2)).toBe('1.50');
    });

    it('rejects decimals out of range', () => {
      expect(() => MoneyMinorUnits.zero().format(-1)).toThrow(RangeError);
      expect(() => MoneyMinorUnits.zero().format(39)).toThrow(RangeError);
    });
  });

  // ── JSON serialization ────────────────────────────────────────────────

  describe('toJSON', () => {
    it('serialises as a string', () => {
      const m = MoneyMinorUnits.fromBigInt(123_456_789n);
      expect(JSON.stringify(m)).toBe('"123456789"');
    });

    it('round-trips through JSON.parse', () => {
      const m = MoneyMinorUnits.fromBigInt(500n);
      const raw = JSON.parse(JSON.stringify(m));
      const restored = MoneyMinorUnits.fromMinor(raw, 6);
      expect(restored.toBigInt()).toBe(500n);
    });
  });

  // ── Prisma helpers ────────────────────────────────────────────────────

  describe('toPrismaDecimal / fromPrismaDecimal', () => {
    it('toPrismaDecimal returns BigInt string', () => {
      const m = MoneyMinorUnits.fromBigInt(123_456_000n);
      expect(m.toPrismaDecimal()).toBe('123456000');
    });

    it('fromPrismaDecimal reconstructs the value', () => {
      const m = MoneyMinorUnits.fromPrismaDecimal('123456000', 6, 'USDC');
      expect(m.toBigInt()).toBe(123_456_000n);
      expect(m.token).toBe('USDC');
    });
  });

  // ── Immutability ──────────────────────────────────────────────────────

  describe('immutability', () => {
    it('add returns a new instance', () => {
      const a = MoneyMinorUnits.fromBigInt(100n);
      const b = MoneyMinorUnits.fromBigInt(200n);
      const c = a.add(b);
      expect(a.toBigInt()).toBe(100n);
      expect(b.toBigInt()).toBe(200n);
      expect(c.toBigInt()).toBe(300n);
    });

    it('sub returns a new instance', () => {
      const a = MoneyMinorUnits.fromBigInt(500n);
      const b = MoneyMinorUnits.fromBigInt(200n);
      const c = a.sub(b);
      expect(a.toBigInt()).toBe(500n);
      expect(b.toBigInt()).toBe(200n);
      expect(c.toBigInt()).toBe(300n);
    });
  });

  // ── Integration: fromMinor → add → format ────────────────────────────

  describe('fromMinor → add → format', () => {
    it('produces stable output', () => {
      const a = MoneyMinorUnits.fromMinor('123', 6, 'USDC');
      const b = MoneyMinorUnits.fromMinor('456', 6, 'USDC');
      const sum = a.add(b);
      expect(sum.format(6)).toBe('579.000000');
    });

    it('handles fractional adds', () => {
      const a = MoneyMinorUnits.fromMinor('1.50', 6, 'USDC');
      const b = MoneyMinorUnits.fromMinor('2.75', 6, 'USDC');
      const sum = a.add(b);
      expect(sum.format(6)).toBe('4.250000');
    });

    it('handles the issue example: fromMinor("123", 6).add(...).format()', () => {
      const a = MoneyMinorUnits.fromMinor('123', 6, 'USDC');
      const b = MoneyMinorUnits.fromMinor('100', 6, 'USDC');
      const result = a.add(b);
      expect(result.format(6)).toBe('223.000000');
    });
  });
});
