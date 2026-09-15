import { Money } from '../common/money';
import { InvalidAmountError } from '../common/errors/domain.errors';
import { ConversionRounding, convertMoney, identityRate } from './currency-converter';
import { type ExchangeRate } from './exchange-rate.types';

const asOf = new Date('2026-01-01T00:00:00.000Z');

const rate = (base: string, quote: string, value: string): ExchangeRate =>
  ({ base, quote, rate: value, asOf, source: 'TEST' }) as ExchangeRate;

describe('convertMoney', () => {
  it('converts between currencies of the same scale', () => {
    const result = convertMoney(
      Money.fromDecimal('1000000.00', 'EUR'),
      'USD',
      rate('EUR', 'USD', '1.085'),
    );

    expect(result.amount.toDecimalString()).toBe('1085000.00');
    expect(result.amount.currency).toBe('USD');
  });

  it('handles a change of scale between currencies', () => {
    // JPY has no minor units, so 10000 JPY at 0.0067 is 67.00 USD.
    const result = convertMoney(
      Money.fromDecimal('10000', 'JPY'),
      'USD',
      rate('JPY', 'USD', '0.0067'),
    );

    expect(result.amount.toDecimalString()).toBe('67.00');
  });

  it('rounds up when taking capacity, so the program is never short', () => {
    const result = convertMoney(
      Money.fromDecimal('100.01', 'EUR'),
      'USD',
      rate('EUR', 'USD', '1.085'),
      ConversionRounding.Up,
    );

    // 10001 * 1.085 = 10851.085 minor units
    expect(result.amount.toDecimalString()).toBe('108.52');
  });

  it('can round down when asked', () => {
    const result = convertMoney(
      Money.fromDecimal('100.01', 'EUR'),
      'USD',
      rate('EUR', 'USD', '1.085'),
      ConversionRounding.Down,
    );

    expect(result.amount.toDecimalString()).toBe('108.51');
  });

  it('returns the amount untouched when the currency already matches', () => {
    const amount = Money.fromDecimal('500.00', 'USD');
    const result = convertMoney(amount, 'USD', identityRate('USD', asOf));

    expect(result.amount.equals(amount)).toBe(true);
  });

  it('refuses a rate for the wrong pair', () => {
    expect(() =>
      convertMoney(Money.fromDecimal('100.00', 'EUR'), 'USD', rate('GBP', 'USD', '1.27')),
    ).toThrow(InvalidAmountError);
  });

  it('refuses a rate that is zero or negative', () => {
    expect(() =>
      convertMoney(Money.fromDecimal('100.00', 'EUR'), 'USD', rate('EUR', 'USD', '0')),
    ).toThrow(InvalidAmountError);
  });

  it('does not lose precision on large amounts', () => {
    const result = convertMoney(
      Money.fromDecimal('9999999999.99', 'EUR'),
      'USD',
      rate('EUR', 'USD', '1.085'),
    );

    expect(result.amount.toDecimalString()).toBe('10849999999.99');
  });
});
