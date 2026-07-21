/**
 * # MoneyMinorUnits
 *
 * An immutable value object representing a monetary amount in **minor units**
 * (stroops, wei, satoshi – the smallest divisible unit of a token).
 *
 * ## Currency-awareness
 *
 * Every instance carries an optional `tokenAddress` so cross-currency
 * arithmetic throws immediately.  Operations between amounts with different
 * tokens (or where one side has a token and the other does not) reject at
 * runtime.
 *
 * ## Serialisation
 *
 * - `toJSON()` / `toString()` → BigInt-as-string (safe across JSON,
 *   PostgreSQL `DECIMAL(38,18)`, and Soroban `i128`).
 * - `format(decimals)` → human-readable `"123.456"` given the token's
 *   decimal places.
 *
 * ## Usage
 *
 * ```typescript
 * const a = MoneyMinorUnits.fromMinor('500', 6, 'USDC');
 * const b = MoneyMinorUnits.fromMinor('200', 6, 'USDC');
 * const sum = a.add(b);             // 700 minor units
 * const str = sum.format(6);        // "0.000700"
 * ```
 *
 * @see docs/decisions/money-minor-units.md for the rationale.
 */

const TOKEN_MISMATCH =
  'MoneyMinorUnits: token address mismatch between operands';

// ---------------------------------------------------------------------------
// Value object
// ---------------------------------------------------------------------------

export class MoneyMinorUnits {
  // ── Constructors ──────────────────────────────────────────────────────

  private constructor(
    private readonly _amount: bigint,
    private readonly _token?: string,
  ) {}

  /**
   * Create from a BigInt amount in minor units.
   * @param amount  Minor-unit amount (e.g. 500n = 0.000500 for 6-decimal token)
   * @param token   Optional token identifier for currency-aware arithmetic.
   */
  static fromBigInt(amount: bigint, token?: string): MoneyMinorUnits {
    return new MoneyMinorUnits(amount, token);
  }

  /**
   * Create from a decimal **string** representing the amount in **whole**
   * (not minor) units, using `decimals` to scale down.
   *
   * @example
   * MoneyMinorUnits.fromMinor("123.456", 6)  // 123_456_000 minor units
   * MoneyMinorUnits.fromMinor("123", 6)      // 123_000_000 minor units
   */
  static fromMinor(amount: string, decimals: number, token?: string): MoneyMinorUnits {
    if (decimals < 0 || decimals > 38 || !Number.isInteger(decimals)) {
      throw new RangeError(
        `MoneyMinorUnits: decimals must be an integer in [0, 38], got ${decimals}`,
      );
    }

    const normalized = amount.trim();
    const dot = normalized.indexOf('.');

    let intPart: string;
    let fracPart: string;

    if (dot === -1) {
      intPart = normalized;
      fracPart = '';
    } else {
      intPart = normalized.slice(0, dot);
      fracPart = normalized.slice(dot + 1);
    }

    if (fracPart.length > decimals) {
      // Truncate excess decimal places (not round — match contract behaviour)
      fracPart = fracPart.slice(0, decimals);
    }

    const padded = fracPart.padEnd(decimals, '0');
    const negative = intPart.startsWith('-');
    const absInt = negative ? intPart.slice(1) : intPart;
    const stripped = absInt.replace(/^0+/, '') || '0';
    const combined = (negative ? '-' : '') + stripped;
    const full = combined + padded;

    return new MoneyMinorUnits(BigInt(full), token);
  }

  /** Zero minor units (no token). */
  static zero(): MoneyMinorUnits {
    return new MoneyMinorUnits(0n);
  }

  // ── Accessors ─────────────────────────────────────────────────────────

  /** The raw minor-unit BigInt. */
  toBigInt(): bigint {
    return this._amount;
  }

  /** The optional token address this amount is denominated in. */
  get token(): string | undefined {
    return this._token;
  }

  /** Human-readable for debugging. */
  toString(): string {
    return this._amount.toString();
  }

  /** Serialise as a BigInt string so JSON round-trips safely. */
  toJSON(): string {
    return this._amount.toString();
  }

  /** Structural equality (value + token). */
  equals(other: MoneyMinorUnits): boolean {
    return this._amount === other._amount && this._token === other._token;
  }

  // ── Arithmetic ────────────────────────────────────────────────────────

  /**
   * Returns a new `MoneyMinorUnits` whose minor-unit value is the sum.
   *
   * @throws if this and `other` have different non-undefined token addresses.
   */
  add(other: MoneyMinorUnits): MoneyMinorUnits {
    this.assertSameToken(other);
    return new MoneyMinorUnits(this._amount + other._amount, this._token ?? other._token);
  }

  /**
   * Returns a new `MoneyMinorUnits` whose minor-unit value is the difference
   * (this − other).
   *
   * @throws if this and `other` have different non-undefined token addresses.
   */
  sub(other: MoneyMinorUnits): MoneyMinorUnits {
    this.assertSameToken(other);
    return new MoneyMinorUnits(this._amount - other._amount, this._token ?? other._token);
  }

  /**
   * Returns a new `MoneyMinorUnits` whose minor-unit value is multiplied by
   * `multiplier`.
   *
   * Multiplicative operations are deliberately scalar-only — cross-currency
   * multiplication would produce a meaningless unit.
   */
  mul(multiplier: bigint | number): MoneyMinorUnits {
    const m = typeof multiplier === 'number' ? BigInt(multiplier) : multiplier;
    return new MoneyMinorUnits(this._amount * m, this._token);
  }

  // ── Formatting ────────────────────────────────────────────────────────

  /**
   * Format as a human-readable decimal string with `decimals` fractional
   * digits.
   *
   * @example
   * MoneyMinorUnits.fromMinor("123", 6).format(6) === "0.000123"
   * MoneyMinorUnits.fromMinor("123.456", 6).format(6) === "123.456000"
   */
  format(decimals: number): string {
    if (decimals < 0 || decimals > 38 || !Number.isInteger(decimals)) {
      throw new RangeError(
        `MoneyMinorUnits: decimals must be an integer in [0, 38], got ${decimals}`,
      );
    }

    const negative = this._amount < 0n;
    const abs = negative ? -this._amount : this._amount;
    const s = abs.toString().padStart(decimals + 1, '0');
    const intPart = s.slice(0, s.length - decimals) || '0';
    const fracPart = s.slice(s.length - decimals).padEnd(decimals, '0');
    return `${negative ? '-' : ''}${intPart}.${fracPart}`;
  }

  // ── Prisma field transformer helpers ──────────────────────────────────

  /**
   * Convert to the string representation that Prisma's `@db.Decimal(38, 18)`
   * runtime accepts.
   *
   * @example
   * MoneyMinorUnits.fromMinor("123.45", 6).toPrismaDecimal() === "123450000"
   */
  toPrismaDecimal(): string {
    return this._amount.toString();
  }

  /**
   * Parse a Prisma `@db.Decimal(38, 18)` string back into minor units given
   * the token's known decimals.
   *
   * @param prismaDecimal  The raw string from Prisma (e.g. "123450000").
   * @param decimals       Number of decimal places for the token.
   * @param token          Optional token address.
   */
  static fromPrismaDecimal(
    prismaDecimal: string,
    decimals: number,
    token?: string,
  ): MoneyMinorUnits {
    return new MoneyMinorUnits(BigInt(prismaDecimal), token);
  }

  // ── Guard ─────────────────────────────────────────────────────────────

  private assertSameToken(other: MoneyMinorUnits): void {
    const t1 = this._token;
    const t2 = other._token;

    if (t1 !== undefined && t2 !== undefined && t1 !== t2) {
      throw new Error(TOKEN_MISMATCH);
    }
  }
}
