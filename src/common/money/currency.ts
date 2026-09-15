import { InvalidCurrencyError } from '../errors/domain.errors';

/**
 * Supported ISO-4217 codes and how many minor units each has.
 * The list is explicit so an unknown code fails instead of getting a guessed exponent.
 */
const CURRENCY_EXPONENTS = {
  AUD: 2,
  CAD: 2,
  CHF: 2,
  CZK: 2,
  DKK: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  NOK: 2,
  PLN: 2,
  SEK: 2,
  UAH: 2,
  USD: 2,
} as const;

export type CurrencyCode = keyof typeof CURRENCY_EXPONENTS;

export const SUPPORTED_CURRENCIES = Object.keys(CURRENCY_EXPONENTS) as CurrencyCode[];

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENTS, value);
}

/** Validates a currency code and normalises its case. */
export function toCurrencyCode(value: string): CurrencyCode {
  const normalised = value?.trim().toUpperCase();

  if (!normalised || !isCurrencyCode(normalised)) {
    throw new InvalidCurrencyError(value, SUPPORTED_CURRENCIES);
  }

  return normalised;
}

/** Decimal places for the currency: USD -> 2, JPY -> 0. */
export function currencyExponent(currency: CurrencyCode): number {
  return CURRENCY_EXPONENTS[currency];
}
