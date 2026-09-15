import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Matches } from 'class-validator';

import { SUPPORTED_CURRENCIES } from './currency';

// No sign, at most 15 integer digits so the minor-unit value stays far inside a
// PostgreSQL bigint. The lookahead rejects an all-zero amount.
const POSITIVE = /^(?!0+(\.0+)?$)\d{1,15}(\.\d{1,6})?$/;
const NON_NEGATIVE = /^\d{1,15}(\.\d{1,6})?$/;

const CURRENCY = {
  example: 'EUR',
  enum: SUPPORTED_CURRENCIES,
};

/**
 * Input amounts are constrained at the edge rather than left to the database.
 * A negative or oversized amount is a client error, and should read as one.
 */
export class PositiveMoneyDto {
  @ApiProperty({ example: '150000.00', description: 'Decimal string, greater than zero' })
  @IsString()
  @Matches(POSITIVE, { message: 'amount must be a positive decimal string, e.g. "150000.00"' })
  amount: string;

  @ApiProperty(CURRENCY)
  @IsString()
  @IsIn(SUPPORTED_CURRENCIES, {
    message: `currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`,
  })
  currency: string;
}

/** An amount that may be zero but never negative, such as a credit limit. */
export class NonNegativeMoneyDto {
  @ApiProperty({ example: '10000000.00', description: 'Decimal string, zero or greater' })
  @IsString()
  @Matches(NON_NEGATIVE, { message: 'amount must be a non-negative decimal string' })
  amount: string;

  @ApiProperty(CURRENCY)
  @IsString()
  @IsIn(SUPPORTED_CURRENCIES, {
    message: `currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`,
  })
  currency: string;
}
