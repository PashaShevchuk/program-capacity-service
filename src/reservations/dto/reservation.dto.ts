import { ApiProperty } from '@nestjs/swagger';

import { MoneyDto } from '../../common/money/money.dto';
import {
  type InvoiceReservationEntity,
  ReservationSource,
  ReservationStatus,
} from '../invoice-reservation.entity';

export class ReservationDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  programId: string;

  @ApiProperty()
  invoiceId: string;

  @ApiProperty({ enum: ReservationStatus })
  status: ReservationStatus;

  @ApiProperty({ enum: ReservationSource })
  source: ReservationSource;

  @ApiProperty({ type: MoneyDto, description: 'Invoice face value' })
  invoiceAmount: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: "Amount held against the program's capacity" })
  reservedAmount: MoneyDto;

  @ApiProperty({ description: 'Rate frozen at reservation time', example: '1.085000000000' })
  fxRate: string;

  @ApiProperty()
  fxRateSource: string;

  @ApiProperty()
  reservedAt: string;

  @ApiProperty({ nullable: true })
  releasedAt: string | null;

  @ApiProperty({ nullable: true })
  cancelledAt: string | null;

  @ApiProperty({ nullable: true })
  externalReference: string | null;

  static from(reservation: InvoiceReservationEntity): ReservationDto {
    return {
      id: reservation.id,
      programId: reservation.programId,
      invoiceId: reservation.invoiceId,
      status: reservation.status,
      source: reservation.source,
      invoiceAmount: MoneyDto.from(reservation.invoiceAmount),
      reservedAmount: MoneyDto.from(reservation.reservedAmount),
      fxRate: reservation.fxRate,
      fxRateSource: reservation.fxRateSource,
      reservedAt: reservation.reservedAt.toISOString(),
      releasedAt: reservation.releasedAt?.toISOString() ?? null,
      cancelledAt: reservation.cancelledAt?.toISOString() ?? null,
      externalReference: reservation.externalReference,
    };
  }
}
