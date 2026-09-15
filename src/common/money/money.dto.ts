import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Matches } from 'class-validator';

import { SUPPORTED_CURRENCIES } from './currency';
import { Money } from './money';

/** Monetary amounts cross the wire as a decimal string, never as a JSON number. */
const DECIMAL_PATTERN = /^-?\d{1,18}(\.\d{1,6})?$/;

export class MoneyDto {
  @ApiProperty({ example: '150000.00', description: 'Decimal string' })
  @IsString()
  @Matches(DECIMAL_PATTERN, {
    message: 'amount must be a decimal string, e.g. "150000.00"',
  })
  amount: string;

  @ApiProperty({ example: 'EUR', enum: SUPPORTED_CURRENCIES })
  @IsString()
  @IsIn(SUPPORTED_CURRENCIES, { message: `currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}` })
  currency: string;

  /** Throws InvalidAmountError if the scale exceeds what the currency allows. */
  static toMoney(dto: MoneyDto): Money {
    return Money.fromDecimal(dto.amount, dto.currency);
  }

  static from(money: Money): MoneyDto {
    return { amount: money.toDecimalString(), currency: money.currency };
  }
}
