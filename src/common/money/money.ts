import { Decimal } from 'decimal.js';

import { CurrencyMismatchError, InvalidAmountError } from '../errors/domain.errors';
import { currencyExponent, toCurrencyCode, type CurrencyCode } from './currency';

/** Wire/DTO shape of a monetary amount: a decimal string plus an ISO-4217 code. */
export interface MoneyLike {
  amount: string;
  currency: string;
}

/**
 * An immutable amount stored as whole minor units (cents) plus its currency.
 *
 * Floats cannot hold decimal fractions exactly, so capacity totals built from
 * them drift. Integers make every add and subtract exact, and `bigint` keeps
 * large programs well clear of `Number.MAX_SAFE_INTEGER`.
 *
 * Mixing currencies throws: crossing them is the FX layer's job.
 */
export class Money {
  private constructor(
    readonly minorUnits: bigint,
    readonly currency: CurrencyCode,
  ) {}

  // --- construction ---------------------------------------------------------

  /** Builds from minor units: 1050n is USD 10.50. */
  static fromMinorUnits(minorUnits: bigint | number | string, currency: string): Money {
    const code = toCurrencyCode(currency);

    let value: bigint;
    try {
      value = typeof minorUnits === 'bigint' ? minorUnits : BigInt(minorUnits);
    } catch {
      throw new InvalidAmountError(`Amount is not an integer number of minor units: ${String(minorUnits)}`, {
        value: String(minorUnits),
        currency: code,
      });
    }

    return new Money(value, code);
  }

  /**
   * Builds from a decimal string such as `"10000000.00"`.
   * Too many decimal places is an error, not something to round: turning a
   * client's 10.005 into 10.01 would make our books disagree with theirs.
   */
  static fromDecimal(amount: string | number | Decimal, currency: string): Money {
    const code = toCurrencyCode(currency);
    const exponent = currencyExponent(code);

    let decimal: Decimal;
    try {
      decimal = new Decimal(amount);
    } catch {
      throw new InvalidAmountError(`Amount is not a valid decimal number: ${String(amount)}`, {
        value: String(amount),
        currency: code,
      });
    }

    if (!decimal.isFinite()) {
      throw new InvalidAmountError(`Amount must be finite: ${String(amount)}`, {
        value: String(amount),
        currency: code,
      });
    }

    if (decimal.decimalPlaces() > exponent) {
      throw new InvalidAmountError(
        `Amount ${decimal.toFixed()} has more precision than ${code} supports (${exponent} decimal places)`,
        { value: decimal.toFixed(), currency: code, maxDecimalPlaces: exponent },
      );
    }

    const scaled = decimal.times(new Decimal(10).pow(exponent));

    return new Money(BigInt(scaled.toFixed(0)), code);
  }

  static fromMoneyLike(value: MoneyLike): Money {
    return Money.fromDecimal(value.amount, value.currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, toCurrencyCode(currency));
  }

  // --- arithmetic -----------------------------------------------------------

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negated(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  absolute(): Money {
    return new Money(this.minorUnits < 0n ? -this.minorUnits : this.minorUnits, this.currency);
  }

  // --- comparison -----------------------------------------------------------

  compareTo(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.minorUnits < other.minorUnits) return -1;
    if (this.minorUnits > other.minorUnits) return 1;
    return 0;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  isGreaterThan(other: Money): boolean {
    return this.compareTo(other) > 0;
  }

  isGreaterThanOrEqual(other: Money): boolean {
    return this.compareTo(other) >= 0;
  }

  isLessThan(other: Money): boolean {
    return this.compareTo(other) < 0;
  }

  get isZero(): boolean {
    return this.minorUnits === 0n;
  }

  get isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  get isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  // --- representation -------------------------------------------------------

  /** Decimal string at the currency's scale, e.g. "10.50". */
  toDecimalString(): string {
    const exponent = currencyExponent(this.currency);
    return new Decimal(this.minorUnits.toString())
      .dividedBy(new Decimal(10).pow(exponent))
      .toFixed(exponent);
  }

  toDecimal(): Decimal {
    return new Decimal(this.toDecimalString());
  }

  toJSON(): MoneyLike {
    return { amount: this.toDecimalString(), currency: this.currency };
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
