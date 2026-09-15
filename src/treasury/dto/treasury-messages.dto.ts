import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
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
  @MaxLength(64)
  programCode: string;

  /**
   * Monotonic per program. Lets the service ignore a message that arrives after
   * a newer one, which Kafka allows across partitions.
   *
   * Carried as a string as well as a number: the column is a `bigint`, and a
   * JSON number loses precision past 2^53. `BigInt(sequence)` reads either.
   */
  @Matches(/^\d{1,19}$/, { message: 'sequence must be a non-negative integer' })
  @Transform(({ value }: { value: unknown }) => String(value))
  sequence: string;

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
  @MaxLength(128)
  invoiceId: string;

  @ValidateNested()
  @Type(() => PositiveMoneyDto)
  amount: PositiveMoneyDto;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  externalReference?: string;
}

export class CapacityReleasedPayloadDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  invoiceId: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
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
  @MaxLength(128)
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

  /**
   * The reservations treasury holds open, quoted in the program's currency.
   * Omitted means the snapshot says nothing about individual rows; an empty
   * array means treasury holds none. When present it must sum to
   * `reservedTotal`, and the rows are rebuilt from it.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OpenReservationDto)
  openReservations?: OpenReservationDto[];
}
