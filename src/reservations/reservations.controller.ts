import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { type Response } from 'express';

import { type AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../auth/user.entity';
import { CorrelationId } from '../common/http/correlation-id.decorator';
import { ProblemDetails } from '../common/http/problem-details';
import { MoneyDto } from '../common/money/money.dto';
import { ApiCursorPage } from '../common/pagination/api-page.decorator';
import { CursorPageDto, CursorQueryDto } from '../common/pagination/cursor-pagination.dto';
import { LedgerEntrySource } from '../ledger/capacity-ledger-entry.entity';
import { userActor } from '../ledger/ledger-actor';
import { CloseReservationDto, CreateReservationDto } from './dto/create-reservation.dto';
import { ReservationDto } from './dto/reservation.dto';
import { ReservationSource } from './invoice-reservation.entity';
import { ReservationsService } from './reservations.service';

const PROGRAM_REF = 'Program id (UUID) or business code';
const RESERVATION_REF = 'Reservation id (UUID) or invoice id';

@ApiTags('reservations')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('programs/:programRef/reservations')
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Post()
  @Roles(UserRole.Admin, UserRole.Client)
  @ApiParam({ name: 'programRef', description: PROGRAM_REF })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Retrying with the same key returns the original reservation',
  })
  @ApiOperation({ summary: 'Reserve capacity for an approved invoice' })
  @ApiCreatedResponse({ type: ReservationDto })
  @ApiConflictResponse({ type: ProblemDetails, description: 'Not enough capacity, or a duplicate' })
  async reserve(
    @Param('programRef') programRef: string,
    @Body() body: CreateReservationDto,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ReservationDto> {
    const result = await this.reservations.reserve({
      programRef,
      invoiceId: body.invoiceId,
      amount: MoneyDto.toMoney(body.amount),
      source: ReservationSource.Api,
      ledgerSource: LedgerEntrySource.Api,
      actor: userActor(user.id, user.email),
      idempotencyKey: idempotencyKey ?? null,
      externalReference: body.externalReference ?? null,
      correlationId,
      occurredAt: body.approvedAt ? new Date(body.approvedAt) : undefined,
      metadata: body.metadata,
    });

    // A replay did not create anything, so it is 200 rather than 201.
    response.status(result.changed ? HttpStatus.CREATED : HttpStatus.OK);

    return ReservationDto.from(result.reservation);
  }

  @Get()
  @ApiParam({ name: 'programRef', description: PROGRAM_REF })
  @ApiOperation({ summary: 'List reservations on a program, newest first' })
  @ApiCursorPage(ReservationDto)
  async list(
    @Param('programRef') programRef: string,
    @Query() query: CursorQueryDto,
  ): Promise<CursorPageDto<ReservationDto>> {
    const page = await this.reservations.list(programRef, query);

    return { ...page, items: page.items.map((reservation) => ReservationDto.from(reservation)) };
  }

  @Get(':reservationRef')
  @ApiParam({ name: 'programRef', description: PROGRAM_REF })
  @ApiParam({ name: 'reservationRef', description: RESERVATION_REF })
  @ApiOperation({ summary: 'Get one reservation' })
  @ApiOkResponse({ type: ReservationDto })
  async findOne(
    @Param('programRef') programRef: string,
    @Param('reservationRef') reservationRef: string,
  ): Promise<ReservationDto> {
    return ReservationDto.from(await this.reservations.findOne(programRef, reservationRef));
  }

  @Post(':reservationRef/release')
  @Roles(UserRole.Admin, UserRole.Client)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'programRef', description: PROGRAM_REF })
  @ApiParam({ name: 'reservationRef', description: RESERVATION_REF })
  @ApiOperation({ summary: 'Release capacity after the invoice is repaid' })
  @ApiOkResponse({ type: ReservationDto })
  async release(
    @Param('programRef') programRef: string,
    @Param('reservationRef') reservationRef: string,
    @Body() body: CloseReservationDto,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<ReservationDto> {
    const result = await this.reservations.release({
      programRef,
      reservationRef,
      ledgerSource: LedgerEntrySource.Api,
      actor: userActor(user.id, user.email),
      correlationId,
      reason: body.reason ?? null,
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : undefined,
    });

    return ReservationDto.from(result.reservation);
  }

  @Post(':reservationRef/cancel')
  @Roles(UserRole.Admin, UserRole.Client)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'programRef', description: PROGRAM_REF })
  @ApiParam({ name: 'reservationRef', description: RESERVATION_REF })
  @ApiOperation({ summary: 'Cancel a reservation that will not be paid out' })
  @ApiOkResponse({ type: ReservationDto })
  async cancel(
    @Param('programRef') programRef: string,
    @Param('reservationRef') reservationRef: string,
    @Body() body: CloseReservationDto,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<ReservationDto> {
    const result = await this.reservations.cancel({
      programRef,
      reservationRef,
      ledgerSource: LedgerEntrySource.Api,
      actor: userActor(user.id, user.email),
      correlationId,
      reason: body.reason ?? null,
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : undefined,
    });

    return ReservationDto.from(result.reservation);
  }
}
