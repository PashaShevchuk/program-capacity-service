import { ApiProperty } from '@nestjs/swagger';

import { MoneyDto } from '../../common/money/money.dto';
import {
  type CapacityLedgerEntryEntity,
  LedgerEntrySource,
  LedgerEntryType,
} from '../capacity-ledger-entry.entity';
import { LedgerActorType } from '../ledger-actor';

export class LedgerActorDto {
  @ApiProperty({ enum: LedgerActorType })
  type: LedgerActorType;

  @ApiProperty({ nullable: true })
  id: string | null;

  @ApiProperty({ nullable: true, example: 'admin@demo.local' })
  label: string | null;
}

export class LedgerEntryDto {
  @ApiProperty()
  id: string;

  @ApiProperty({
    enum: LedgerEntryType,
  })
  entryType: LedgerEntryType;

  @ApiProperty({
    enum: LedgerEntrySource,
  })
  source: LedgerEntrySource;

  @ApiProperty({
    nullable: true,
  })
  reservationId: string | null;

  @ApiProperty({
    type: MoneyDto,
    description: 'Signed change to the reserved total',
  })
  reservedDelta: MoneyDto;

  @ApiProperty({
    type: MoneyDto,
  })
  reservedAfter: MoneyDto;

  @ApiProperty({
    type: MoneyDto,
  })
  limitAfter: MoneyDto;

  @ApiProperty({
    type: MoneyDto,
  })
  availableAfter: MoneyDto;

  @ApiProperty({
    nullable: true,
  })
  reason: string | null;

  @ApiProperty({ type: LedgerActorDto, description: 'Who caused this movement' })
  actor: LedgerActorDto;

  @ApiProperty({
    nullable: true,
  })
  correlationId: string | null;

  @ApiProperty()
  occurredAt: string;

  @ApiProperty()
  recordedAt: string;

  static from(entry: CapacityLedgerEntryEntity): LedgerEntryDto {
    return {
      id: entry.id,
      entryType: entry.entryType,
      source: entry.source,
      reservationId: entry.reservationId,
      reservedDelta: MoneyDto.from(entry.reservedDelta),
      reservedAfter: MoneyDto.from(entry.reservedAfter),
      limitAfter: MoneyDto.from(entry.limitAfter),
      availableAfter: MoneyDto.from(entry.availableAfter),
      reason: entry.reason,
      actor: entry.actor,
      correlationId: entry.correlationId,
      occurredAt: entry.occurredAt.toISOString(),
      recordedAt: entry.createdAt.toISOString(),
    };
  }
}
