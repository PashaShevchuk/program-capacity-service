import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

import { NonNegativeMoneyDto, PositiveMoneyDto } from '../../common/money/constrained-money.dto';

export enum TreasuryEventType {
  CapacityReserved = 'CapacityReserved',
  CapacityReleased = 'CapacityReleased',
  ProgramLimitChanged = 'ProgramLimitChanged',
}

/** Fields every treasury message carries. */
export abstract class TreasuryEnvelopeDto {
  @IsUUID()
  eventId: string;

  @IsString()
  @IsNotEmpty()
  programCode: string;

  /**
   * Monotonic per program. Lets the service ignore a message that arrives after
   * a newer one, which Kafka allows across partitions.
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sequence: number;

  @IsISO8601()
  occurredAt: string;
}

export class TreasuryEventDto extends TreasuryEnvelopeDto {
  @IsEnum(TreasuryEventType)
  eventType: TreasuryEventType;

  @IsObject()
  payload: Record<string, unknown>;
}

export class CapacityReservedPayloadDto {
  @IsString()
  @IsNotEmpty()
  invoiceId: string;

  @ValidateNested()
  @Type(() => PositiveMoneyDto)
  amount: PositiveMoneyDto;

  @IsOptional()
  @IsString()
  externalReference?: string;
}

export class CapacityReleasedPayloadDto {
  @IsString()
  @IsNotEmpty()
  invoiceId: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class ProgramLimitChangedPayloadDto {
  @ValidateNested()
  @Type(() => NonNegativeMoneyDto)
  totalLimit: NonNegativeMoneyDto;
}

export class OpenReservationDto {
  @IsString()
  @IsNotEmpty()
  invoiceId: string;

  @ValidateNested()
  @Type(() => PositiveMoneyDto)
  amount: PositiveMoneyDto;
}

/**
 * Periodic snapshot of a program's whole capacity position.
 * `asOf` is the moment the snapshot describes, which is what local reservations
 * are compared against during reconciliation.
 */
export class TreasuryReconciliationDto extends TreasuryEnvelopeDto {
  @IsISO8601()
  asOf: string;

  @ValidateNested()
  @Type(() => NonNegativeMoneyDto)
  totalLimit: NonNegativeMoneyDto;

  @ValidateNested()
  @Type(() => NonNegativeMoneyDto)
  reservedTotal: NonNegativeMoneyDto;

  /** Optional detail, used only to cross-check `reservedTotal`. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OpenReservationDto)
  openReservations?: OpenReservationDto[];
}
