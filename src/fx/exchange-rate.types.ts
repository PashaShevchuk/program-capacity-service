import { type CurrencyCode } from '../common/money';

/** One rate observation: 1 `base` = `rate` `quote`, as at `asOf`. */
export interface ExchangeRate {
  base: CurrencyCode;
  quote: CurrencyCode;
  /** Decimal string, never a float, so the stored rate reproduces exactly. */
  rate: string;
  asOf: Date;
  /** Where it came from: SEED, IDENTITY, INVERSE:SEED, TREASURY. */
  source: string;
}

/**
 * Port for whatever supplies exchange rates.
 * Ships with a database-backed adapter; a live FX provider is a different
 * binding for this token and no change to callers.
 */
export interface ExchangeRateProvider {
  /** Rate to use at `at` (default now). Throws if the pair has no rate. */
  getRate(base: CurrencyCode, quote: CurrencyCode, at?: Date): Promise<ExchangeRate>;
}

export const EXCHANGE_RATE_PROVIDER = Symbol('EXCHANGE_RATE_PROVIDER');
