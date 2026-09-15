import { Inject, Injectable } from '@nestjs/common';

import { toCurrencyCode } from '../common/money/currency';
import { type Money } from '../common/money/money';
import {
  ConversionRounding,
  convertMoney,
  type ConversionResult,
} from './currency-converter';
import { EXCHANGE_RATE_PROVIDER, type ExchangeRateProvider } from './exchange-rate.types';

/**
 * Fetches the applicable rate and applies it.
 * Callers get the rate back because they are expected to store it: the rate a
 * reservation used is part of its record.
 */
@Injectable()
export class FxService {
  constructor(
    @Inject(EXCHANGE_RATE_PROVIDER)
    private readonly provider: ExchangeRateProvider,
  ) {}

  /**
   * Converts `amount` into `targetCurrency` as at `at`.
   * Rounds up by default, since the caller is usually taking capacity.
   */
  async convert(
    amount: Money,
    targetCurrency: string,
    at: Date = new Date(),
    rounding: ConversionRounding = ConversionRounding.Up,
  ): Promise<ConversionResult> {
    const target = toCurrencyCode(targetCurrency);
    const rate = await this.provider.getRate(amount.currency, target, at);

    return convertMoney(amount, target, rate, rounding);
  }
}
