import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { PRINTABLE_MESSAGE, PRINTABLE_TEXT } from '../../common/http/text.patterns';
import { PositiveMoneyDto } from '../../common/money/constrained-money.dto';

export class CreateReservationDto {
  @ApiProperty({ example: 'INV-2026-000123' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(PRINTABLE_TEXT, { message: `invoiceId ${PRINTABLE_MESSAGE}` })
  invoiceId: string;

  @ApiProperty({
    type: PositiveMoneyDto,
    description: "Invoice face value. May differ from the program's currency",
  })
  @IsDefined()
  @ValidateNested()
  @Type(() => PositiveMoneyDto)
  amount: PositiveMoneyDto;

  @ApiPropertyOptional({ description: 'Identifier of this invoice in an upstream system' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(PRINTABLE_TEXT, { message: `externalReference ${PRINTABLE_MESSAGE}` })
  externalReference?: string;

  @ApiPropertyOptional({ description: 'When the invoice was approved. Defaults to now' })
  @IsOptional()
  @IsISO8601()
  approvedAt?: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class CloseReservationDto {
  @ApiPropertyOptional({ description: 'Recorded on the ledger entry' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(PRINTABLE_TEXT, { message: `reason ${PRINTABLE_MESSAGE}` })
  reason?: string;

  @ApiPropertyOptional({ description: 'When repayment happened. Defaults to now' })
  @IsOptional()
  @IsISO8601()
  occurredAt?: string;
}
