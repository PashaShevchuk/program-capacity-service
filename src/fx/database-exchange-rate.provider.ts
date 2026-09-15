import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Decimal } from 'decimal.js';
import { LessThanOrEqual, Repository } from 'typeorm';

import { type CurrencyCode } from '../common/money/currency';
import { ExchangeRateUnavailableError } from '../common/errors/domain.errors';
import { FxRateEntity } from './fx-rate.entity';
import { type ExchangeRate, type ExchangeRateProvider } from './exchange-rate.types';

/** Precision kept when inverting a rate. */
const INVERSE_RATE_PRECISION = 12;

/**
 * Serves rates from the `fx_rates` table, our local copy of the treasury feed.
 *
 * Lookups are point-in-time — the newest rate at or before the moment asked for
 * — so an old reservation can be re-derived with the rate that applied then.
 * A missing pair is an error: reserving at a guessed rate is worse than failing.
 */
@Injectable()
export class DatabaseExchangeRateProvider implements ExchangeRateProvider {
  private readonly logger = new Logger(DatabaseExchangeRateProvider.name);

  constructor(
    @InjectRepository(FxRateEntity)
    private readonly rates: Repository<FxRateEntity>,
  ) {}

  async getRate(base: CurrencyCode, quote: CurrencyCode, at: Date = new Date()): Promise<ExchangeRate> {
    if (base === quote) {
      return { base, quote, rate: '1', asOf: at, source: 'IDENTITY' };
    }

    const direct = await this.findLatest(base, quote, at);
    if (direct) {
      return { base, quote, rate: direct.rate, asOf: direct.asOf, source: direct.source };
    }

    // A feed that publishes EUR/USD need not also publish USD/EUR.
    const inverse = await this.findLatest(quote, base, at);
    if (inverse) {
      const rate = new Decimal(1).dividedBy(new Decimal(inverse.rate)).toFixed(INVERSE_RATE_PRECISION);

      this.logger.debug(
        `Derived ${base}/${quote} = ${rate} by inverting ${quote}/${base} = ${inverse.rate}`,
      );

      return { base, quote, rate, asOf: inverse.asOf, source: `INVERSE:${inverse.source}` };
    }

    throw new ExchangeRateUnavailableError(base, quote);
  }

  private findLatest(base: string, quote: string, at: Date): Promise<FxRateEntity | null> {
    return this.rates.findOne({
      where: { baseCurrency: base, quoteCurrency: quote, asOf: LessThanOrEqual(at) },
      order: { asOf: 'DESC' },
    });
  }
}
