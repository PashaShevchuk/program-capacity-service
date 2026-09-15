import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNotEmpty, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';

import { MoneyDto } from '../../common/money/money.dto';

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
  name: string;

  @ApiProperty({ type: MoneyDto, description: "Sets both the limit and the program's currency" })
  @ValidateNested()
  @Type(() => MoneyDto)
  totalLimit: MoneyDto;
}

export class UpdateProgramLimitDto {
  @ApiProperty({ type: MoneyDto, description: "Must be in the program's own currency" })
  @ValidateNested()
  @Type(() => MoneyDto)
  totalLimit: MoneyDto;
}
