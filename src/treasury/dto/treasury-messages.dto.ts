import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';

import { PRINTABLE_MESSAGE, PRINTABLE_TEXT } from '../../common/http/text.patterns';
import { NonNegativeMoneyDto, PositiveMoneyDto } from '../../common/money/constrained-money.dto';

/** Cap on how many reservations one snapshot may carry. */
export const MAX_OPEN_RESERVATIONS = 2000;

/** Largest value a PostgreSQL `bigint` holds. */
const MAX_SEQUENCE = 9_223_372_036_854_775_807n;

@ValidatorConstraint({ name: 'isBigIntSequence' })
class IsBigIntSequence implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value >= 0;
    }

    if (typeof value !== 'string' || !/^\d{1,19}$/.test(value)) return false;

    return BigInt(value) <= MAX_SEQUENCE;
  }

  defaultMessage(): string {
    return 'sequence must be a non-negative integer within bigint range, sent as a string when above 2^53';
  }
}

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
  @Matches(PRINTABLE_TEXT, { message: `programCode ${PRINTABLE_MESSAGE}` })
  programCode: string;

  /**
   * Monotonic per program. Lets the service ignore a message that arrives after
   * a newer one, which Kafka allows across partitions.
   *
   * Read as a string, because the column is a `bigint` and `JSON.parse` has
   * already rounded any number past 2^53 before this class ever sees it. A
   * number is still accepted while it is exactly representable; beyond that the
   * producer has to send a string or the value it meant is already lost.
   */
  @Validate(IsBigIntSequence)
  sequence: string | number;

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
  @Matches(PRINTABLE_TEXT, { message: `invoiceId ${PRINTABLE_MESSAGE}` })
  invoiceId: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => PositiveMoneyDto)
  amount: PositiveMoneyDto;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(PRINTABLE_TEXT, { message: `externalReference ${PRINTABLE_MESSAGE}` })
  externalReference?: string;
}

export class CapacityReleasedPayloadDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(PRINTABLE_TEXT, { message: `invoiceId ${PRINTABLE_MESSAGE}` })
  invoiceId: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(PRINTABLE_TEXT, { message: `reason ${PRINTABLE_MESSAGE}` })
  reason?: string;
}

export class ProgramLimitChangedPayloadDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => NonNegativeMoneyDto)
  totalLimit: NonNegativeMoneyDto;
}

export class OpenReservationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(PRINTABLE_TEXT, { message: `invoiceId ${PRINTABLE_MESSAGE}` })
  invoiceId: string;

  @IsDefined()
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

  @IsDefined()
  @ValidateNested()
  @Type(() => NonNegativeMoneyDto)
  totalLimit: NonNegativeMoneyDto;

  @IsDefined()
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
  // Each row costs a write and a ledger entry inside the program lock, so an
  // unbounded list would hold the lock past the consumer's session timeout.
  @ArrayMaxSize(MAX_OPEN_RESERVATIONS)
  @ValidateNested({ each: true })
  @Type(() => OpenReservationDto)
  openReservations?: OpenReservationDto[];
}
