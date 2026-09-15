import { ApiProperty } from '@nestjs/swagger';

import { MoneyDto } from '../../common/money/money.dto';
import { type ProgramEntity, ProgramStatus } from '../program.entity';

export class ProgramDto {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty({ example: 'USD' }) currency: string;
  @ApiProperty({ enum: ProgramStatus }) status: ProgramStatus;
  @ApiProperty({ type: MoneyDto }) totalLimit: MoneyDto;
  @ApiProperty({ type: MoneyDto }) reserved: MoneyDto;
  @ApiProperty({ type: MoneyDto }) available: MoneyDto;
  @ApiProperty() version: number;
  @ApiProperty({ nullable: true }) lastReconciledAt: string | null;

  static from(program: ProgramEntity): ProgramDto {
    return {
      id: program.id,
      code: program.code,
      name: program.name,
      currency: program.currency,
      status: program.status,
      totalLimit: MoneyDto.from(program.totalLimit),
      reserved: MoneyDto.from(program.reserved),
      available: MoneyDto.from(program.available),
      version: program.version,
      lastReconciledAt: program.lastReconciledAt?.toISOString() ?? null,
    };
  }
}

export class ProgramCapacityDto {
  @ApiProperty() programId: string;
  @ApiProperty() programCode: string;
  @ApiProperty({ example: 'USD' }) currency: string;
  @ApiProperty({ enum: ProgramStatus }) status: ProgramStatus;
  @ApiProperty({ type: MoneyDto }) totalLimit: MoneyDto;
  @ApiProperty({ type: MoneyDto }) reserved: MoneyDto;
  @ApiProperty({ type: MoneyDto }) available: MoneyDto;

  @ApiProperty({ description: 'Reservations exceed the limit after a treasury reconciliation' })
  overcommitted: boolean;

  @ApiProperty({ description: 'Increments on every capacity movement' })
  version: number;

  @ApiProperty({ nullable: true, description: 'Last treasury reconciliation applied' })
  lastReconciledAt: string | null;

  @ApiProperty() asOf: string;

  static from(program: ProgramEntity): ProgramCapacityDto {
    return {
      programId: program.id,
      programCode: program.code,
      currency: program.currency,
      status: program.status,
      totalLimit: MoneyDto.from(program.totalLimit),
      reserved: MoneyDto.from(program.reserved),
      available: MoneyDto.from(program.available),
      overcommitted: program.isOvercommitted,
      version: program.version,
      lastReconciledAt: program.lastReconciledAt?.toISOString() ?? null,
      asOf: new Date().toISOString(),
    };
  }
}
