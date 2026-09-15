import { Decimal } from 'decimal.js';

import { currencyExponent, toCurrencyCode, type CurrencyCode } from '../common/money';
import { InvalidAmountError } from '../common/errors/domain.errors';
import { Money } from '../common/money';
import { type ExchangeRate } from './exchange-rate.types';

/**
 * How to settle the fractional minor unit a conversion leaves behind.
 * We round capacity taken up, and return exactly what was stored, so rounding
 * can only favour the program and never invents capacity.
 */
export enum ConversionRounding {
  /** Away from zero. Used when taking capacity. */
  Up = 'UP',
  /** Towards zero. */
  Down = 'DOWN',
  /** Nearest, ties away from zero. Used for reporting. */
  HalfUp = 'HALF_UP',
}

const DECIMAL_ROUNDING: Record<ConversionRounding, Decimal.Rounding> = {
  [ConversionRounding.Up]: Decimal.ROUND_UP,
  [ConversionRounding.Down]: Decimal.ROUND_DOWN,
  [ConversionRounding.HalfUp]: Decimal.ROUND_HALF_UP,
};

export interface ConversionResult {
  /** Converted amount in the target currency. */
  amount: Money;
  /** Rate used, kept so the conversion stays reproducible. */
  rate: ExchangeRate;
}

/**
 * Converts `amount` into `target` using `rate`.
 * Pure, so rounding is easy to pin down in tests. Works on minor units directly
 * so there is exactly one rounding step, at the end.
 */
export function convertMoney(
  amount: Money,
  target: string,
  rate: ExchangeRate,
  rounding: ConversionRounding = ConversionRounding.Up,
): ConversionResult {
  const targetCurrency = toCurrencyCode(target);

  if (amount.currency === targetCurrency) {
    return { amount, rate };
  }

  assertRateApplies(amount.currency, targetCurrency, rate);

  const rateDecimal = new Decimal(rate.rate);
  if (!rateDecimal.isFinite() || rateDecimal.lessThanOrEqualTo(0)) {
    throw new InvalidAmountError(`Exchange rate must be a positive finite number: ${rate.rate}`, {
      rate: rate.rate,
      base: rate.base,
      quote: rate.quote,
    });
  }

  const exponentShift = currencyExponent(targetCurrency) - currencyExponent(amount.currency);

  const converted = new Decimal(amount.minorUnits.toString())
    .times(rateDecimal)
    .times(new Decimal(10).pow(exponentShift))
    .toDecimalPlaces(0, DECIMAL_ROUNDING[rounding]);

  return {
    amount: Money.fromMinorUnits(BigInt(converted.toFixed(0)), targetCurrency),
    rate,
  };
}

function assertRateApplies(from: CurrencyCode, to: CurrencyCode, rate: ExchangeRate): void {
  if (rate.base !== from || rate.quote !== to) {
    throw new InvalidAmountError(
      `Exchange rate ${rate.base}/${rate.quote} cannot convert ${from} to ${to}`,
      { expected: `${from}/${to}`, received: `${rate.base}/${rate.quote}` },
    );
  }
}

/** Rate used when invoice and program share a currency. */
export function identityRate(currency: CurrencyCode, at: Date): ExchangeRate {
  return { base: currency, quote: currency, rate: '1', asOf: at, source: 'IDENTITY' };
}
