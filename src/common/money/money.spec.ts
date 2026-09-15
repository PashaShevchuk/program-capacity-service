import { CurrencyMismatchError, InvalidAmountError, InvalidCurrencyError } from '../errors/domain.errors';
import { Money } from './money';

describe('Money', () => {
  describe('construction', () => {
    it('parses a decimal string into minor units', () => {
      expect(Money.fromDecimal('10.50', 'USD').minorUnits).toBe(1050n);
      expect(Money.fromDecimal('10000000.00', 'USD').minorUnits).toBe(1_000_000_000n);
    });

    it('honours currencies with a zero exponent', () => {
      expect(Money.fromDecimal('1500', 'JPY').minorUnits).toBe(1500n);
      expect(Money.fromMinorUnits(1500n, 'JPY').toDecimalString()).toBe('1500');
    });

    it('rejects amounts more precise than the currency allows', () => {
      expect(() => Money.fromDecimal('10.005', 'USD')).toThrow(InvalidAmountError);
      expect(() => Money.fromDecimal('1500.5', 'JPY')).toThrow(InvalidAmountError);
    });

    it('rejects unknown currencies', () => {
      expect(() => Money.fromDecimal('10.00', 'XYZ')).toThrow(InvalidCurrencyError);
    });

    it('rejects non-finite amounts', () => {
      expect(() => Money.fromDecimal(Number.POSITIVE_INFINITY, 'USD')).toThrow(InvalidAmountError);
      expect(() => Money.fromDecimal('not-a-number', 'USD')).toThrow(InvalidAmountError);
    });

    it('normalises the currency code', () => {
      expect(Money.fromDecimal('1.00', 'usd').currency).toBe('USD');
    });
  });

  describe('arithmetic', () => {
    it('is exact where floating point is not', () => {
      const sum = Money.fromDecimal('0.10', 'USD').add(Money.fromDecimal('0.20', 'USD'));

      expect(sum.toDecimalString()).toBe('0.30');
      expect(0.1 + 0.2).not.toBe(0.3); // the reason this class exists
    });

    it('survives amounts beyond Number.MAX_SAFE_INTEGER', () => {
      const huge = Money.fromMinorUnits('9007199254740993', 'USD');

      expect(huge.add(Money.fromMinorUnits(1n, 'USD')).minorUnits).toBe(9007199254740994n);
    });

    it('refuses to mix currencies', () => {
      const usd = Money.fromDecimal('10.00', 'USD');
      const eur = Money.fromDecimal('10.00', 'EUR');

      expect(() => usd.add(eur)).toThrow(CurrencyMismatchError);
      expect(() => usd.subtract(eur)).toThrow(CurrencyMismatchError);
      expect(() => usd.compareTo(eur)).toThrow(CurrencyMismatchError);
    });

    it('supports subtraction into negative territory', () => {
      const result = Money.fromDecimal('5.00', 'USD').subtract(Money.fromDecimal('7.25', 'USD'));

      expect(result.toDecimalString()).toBe('-2.25');
      expect(result.isNegative).toBe(true);
      expect(result.absolute().toDecimalString()).toBe('2.25');
    });
  });

  describe('comparison', () => {
    it('orders amounts of the same currency', () => {
      const small = Money.fromDecimal('1.00', 'USD');
      const large = Money.fromDecimal('2.00', 'USD');

      expect(large.isGreaterThan(small)).toBe(true);
      expect(small.isLessThan(large)).toBe(true);
      expect(small.isGreaterThanOrEqual(Money.fromDecimal('1.00', 'USD'))).toBe(true);
    });

    it('treats equal amounts in different currencies as different', () => {
      expect(Money.fromDecimal('1.00', 'USD').equals(Money.fromDecimal('1.00', 'EUR'))).toBe(false);
    });
  });

  describe('representation', () => {
    it('round-trips through its wire format', () => {
      const original = Money.fromDecimal('1234567.89', 'EUR');
      const restored = Money.fromMoneyLike(original.toJSON());

      expect(restored.equals(original)).toBe(true);
      expect(original.toJSON()).toEqual({ amount: '1234567.89', currency: 'EUR' });
    });

    it('pads to the currency scale', () => {
      expect(Money.fromMinorUnits(5n, 'USD').toDecimalString()).toBe('0.05');
      expect(Money.zero('USD').toDecimalString()).toBe('0.00');
    });
  });
});
