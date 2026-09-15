import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { PRINTABLE_MESSAGE, PRINTABLE_TEXT } from '../../common/http/text.patterns';
import { NonNegativeMoneyDto } from '../../common/money/constrained-money.dto';

export class CreateProgramDto {
  @ApiProperty({ example: 'PRG-USD-001' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9._-]+$/, {
    message: 'code may contain letters, digits, dot, dash, underscore',
  })
  code: string;

  @ApiProperty({ example: 'Global Supplier Finance USD' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Matches(PRINTABLE_TEXT, { message: `name ${PRINTABLE_MESSAGE}` })
  name: string;

  @ApiProperty({
    type: NonNegativeMoneyDto,
    description: "Sets both the limit and the program's currency",
  })
  @IsDefined()
  @IsDefined()
  @ValidateNested()
  @Type(() => NonNegativeMoneyDto)
  totalLimit: NonNegativeMoneyDto;
}

export class UpdateProgramLimitDto {
  @ApiProperty({ type: NonNegativeMoneyDto, description: "Must be in the program's own currency" })
  @ValidateNested()
  @Type(() => NonNegativeMoneyDto)
  totalLimit: NonNegativeMoneyDto;
}
