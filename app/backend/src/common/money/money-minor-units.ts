import { Prisma } from '@prisma/client';

/**
 * A value object representing monetary amounts in minor units (e.g., cents, stroops).
 *
 * This class ensures all monetary operations are performed on integers,
 * eliminating floating-point precision issues. It is currency-aware
 * and tracks the token address for each amount.
 *
 * @example
 * const amount = MoneyMinorUnits.fromMinor('100050000', 'USDC_ADDRESS');
 * const doubled = amount.mul(2n);
 * console.log(doubled.toMajor('6')); // "2000.5" (assuming 6 decimals)
 */
export class MoneyMinorUnits {
  private constructor(
    private readonly minorUnits: bigint,
    private readonly tokenAddress: string,
  ) {}

  /**
   * Creates a MoneyMinorUnits from a minor unit string and token address.
   *
   * @param minor - The amount in minor units (e.g., "100500000" for 100.5 USDC with 6 decimals)
   * @param tokenAddress - The token contract address for currency identification
   */
  static fromMinor(minor: string, tokenAddress: string): MoneyMinorUnits {
    const value = BigInt(minor);
    if (value < 0n) {
      throw new Error('MoneyMinorUnits cannot be negative');
    }
    return new MoneyMinorUnits(value, tokenAddress);
  }

  /**
   * Creates a MoneyMinorUnits from a major unit string (e.g., "100.50") and token address.
   *
   * @param major - The amount in major units (e.g., "100.50")
   * @param decimals - The number of decimal places for the token (e.g., 6 for USDC)
   * @param tokenAddress - The token contract address for currency identification
   */
  static fromMajor(
    major: string,
    decimals: number,
    tokenAddress: string,
  ): MoneyMinorUnits {
    const parts = major.split('.');
    const integerPart = parts[0] || '0';
    const fractionalPart = (parts[1] || '').padEnd(decimals, '0').slice(0, decimals);
    const minorStr = integerPart + fractionalPart;
    return MoneyMinorUnits.fromMinor(minorStr, tokenAddress);
  }

  /**
   * Returns the amount in minor units as a bigint.
   */
  toMinor(): bigint {
    return this.minorUnits;
  }

  /**
   * Returns the amount in major units as a string.
   *
   * @param decimals - The number of decimal places for the token
   */
  toMajor(decimals: number): string {
    const str = this.minorUnits.toString();
    if (decimals === 0) {
      return str;
    }
    const padded = str.padStart(decimals + 1, '0');
    const integerPart = padded.slice(0, -decimals);
    const fractionalPart = padded.slice(-decimals);
    return `${integerPart}.${fractionalPart}`;
  }

  /**
   * Returns the token address.
   */
  getTokenAddress(): string {
    return this.tokenAddress;
  }

  /**
   * Adds another MoneyMinorUnits value (must have the same token address).
   *
   * @throws Error if token addresses don't match
   */
  add(other: MoneyMinorUnits): MoneyMinorUnits {
    this.validateSameToken(other);
    return new MoneyMinorUnits(
      this.minorUnits + other.minorUnits,
      this.tokenAddress,
    );
  }

  /**
   * Subtracts another MoneyMinorUnits value (must have the same token address).
   *
   * @throws Error if token addresses don't match or result would be negative
   */
  sub(other: MoneyMinorUnits): MoneyMinorUnits {
    this.validateSameToken(other);
    const result = this.minorUnits - other.minorUnits;
    if (result < 0n) {
      throw new Error('Insufficient funds: subtraction would result in negative amount');
    }
    return new MoneyMinorUnits(result, this.tokenAddress);
  }

  /**
   * Multiplies the amount by a scalar (bigint).
   *
   * @param scalar - The multiplier
   */
  mul(scalar: bigint): MoneyMinorUnits {
    return new MoneyMinorUnits(this.minorUnits * scalar, this.tokenAddress);
  }

  /**
   * Compares this MoneyMinorUnits with another.
   *
   * @returns negative if this < other, 0 if equal, positive if this > other
   */
  compare(other: MoneyMinorUnits): number {
    this.validateSameToken(other);
    if (this.minorUnits < other.minorUnits) return -1;
    if (this.minorUnits > other.minorUnits) return 1;
    return 0;
  }

  /**
   * Checks if this MoneyMinorUnits equals another.
   */
  equals(other: MoneyMinorUnits): boolean {
    return this.compare(other) === 0;
  }

  /**
   * Checks if this MoneyMinorUnits is zero.
   */
  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  /**
   * Formats the amount for display.
   *
   * @param decimals - The number of decimal places for the token
   * @param locale - Optional locale for formatting
   */
  format(decimals: number, locale?: string): string {
    const major = this.toMajor(decimals);
    if (locale) {
      return new Intl.NumberFormat(locale, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(parseFloat(major));
    }
    return major;
  }

  /**
   * Creates a Prisma Decimal for database storage.
   *
   * @param decimals - The number of decimal places for the token
   */
  toPrismaDecimal(decimals: number): Prisma.Decimal {
    return new Prisma.Decimal(this.toMajor(decimals));
  }

  /**
   * Returns a string representation for debugging.
   */
  toString(): string {
    return `MoneyMinorUnits(${this.minorUnits.toString()}, ${this.tokenAddress})`;
  }

  private validateSameToken(other: MoneyMinorUnits): void {
    if (this.tokenAddress !== other.tokenAddress) {
      throw new Error(
        `Cannot operate on different tokens: ${this.tokenAddress} vs ${other.tokenAddress}`,
      );
    }
  }
}
