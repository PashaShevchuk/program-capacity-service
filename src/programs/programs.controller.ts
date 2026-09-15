import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Sse,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { map, type Observable } from 'rxjs';

import { type AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../auth/user.entity';
import { CorrelationId } from '../common/http/correlation-id.decorator';
import { MoneyDto } from '../common/money/money.dto';
import { PageDto, PaginationQueryDto } from '../common/pagination/pagination.dto';
import { userActor } from '../ledger/ledger-actor';
import { LedgerEntryDto } from '../ledger/dto/ledger-entry.dto';
import { type CapacityChangedPayload } from './capacity-changed.event';
import { CapacityEventsService } from './capacity-events.service';
import { CreateProgramDto, UpdateProgramLimitDto } from './dto/create-program.dto';
import { ProgramCapacityDto, ProgramDto } from './dto/program.dto';
import { ProgramsService } from './programs.service';

const PROGRAM_REF = 'Program id (UUID) or business code, e.g. PRG-USD-001';

@ApiTags('programs')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('programs')
export class ProgramsController {
  constructor(
    private readonly programs: ProgramsService,
    private readonly capacityEvents: CapacityEventsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List financing programs' })
  @ApiOkResponse({ type: PageDto<ProgramDto> })
  async list(@Query() query: PaginationQueryDto): Promise<PageDto<ProgramDto>> {
    const page = await this.programs.list(query);

    return PageDto.of(
      page.items.map((program) => ProgramDto.from(program)),
      page.total,
      query,
    );
  }

  @Post()
  @Roles(UserRole.Admin)
  @ApiOperation({ summary: 'Create a financing program' })
  @ApiCreatedResponse({ type: ProgramDto })
  async create(
    @Body() body: CreateProgramDto,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<ProgramDto> {
    const program = await this.programs.create({
      code: body.code,
      name: body.name,
      totalLimit: MoneyDto.toMoney(body.totalLimit),
      actor: userActor(user.id, user.email),
      correlationId,
    });

    return ProgramDto.from(program);
  }

  @Get(':programRef')
  @ApiParam({ name: 'programRef', description: PROGRAM_REF })
  @ApiOperation({ summary: 'Get one program' })
  @ApiOkResponse({ type: ProgramDto })
  async findOne(@Param('programRef') programRef: string): Promise<ProgramDto> {
    return ProgramDto.from(await this.programs.findOne(programRef));
  }

  @Get(':programRef/capacity')
  @ApiParam({ name: 'programRef', description: PROGRAM_REF })
  @ApiOperation({ summary: 'Current capacity: limit, reserved and available' })
  @ApiOkResponse({ type: ProgramCapacityDto })
  async capacity(@Param('programRef') programRef: string): Promise<ProgramCapacityDto> {
    return ProgramCapacityDto.from(await this.programs.findOne(programRef));
  }

  /**
   * Server-sent events, so clients can follow capacity without polling.
   * Authenticated like every other route; EventSource cannot set headers, so a
   * browser client needs a fetch-based SSE reader to send the bearer token.
   */
  @Sse(':programRef/capacity/stream')
  @ApiParam({ name: 'programRef', description: PROGRAM_REF })
  @ApiOperation({ summary: 'Stream capacity changes for a program' })
  async stream(
    @Param('programRef') programRef: string,
  ): Promise<Observable<{ data: CapacityChangedPayload }>> {
    const program = await this.programs.findOne(programRef);

    return this.capacityEvents.forProgram(program.id).pipe(map((data) => ({ data })));
  }

  @Patch(':programRef/limit')
  @Roles(UserRole.Admin)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'programRef', description: PROGRAM_REF })
  @ApiOperation({ summary: 'Change the credit limit' })
  @ApiOkResponse({ type: ProgramDto })
  async changeLimit(
    @Param('programRef') programRef: string,
    @Body() body: UpdateProgramLimitDto,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<ProgramDto> {
    const program = await this.programs.changeLimit({
      programRef,
      totalLimit: MoneyDto.toMoney(body.totalLimit),
      actor: userActor(user.id, user.email),
      correlationId,
    });

    return ProgramDto.from(program);
  }

  @Get(':programRef/ledger')
  @ApiParam({ name: 'programRef', description: PROGRAM_REF })
  @ApiOperation({ summary: 'Audit trail of capacity movements' })
  @ApiOkResponse({ type: PageDto<LedgerEntryDto> })
  async ledger(
    @Param('programRef') programRef: string,
    @Query() query: PaginationQueryDto,
  ): Promise<PageDto<LedgerEntryDto>> {
    const page = await this.programs.ledgerEntries(programRef, query);

    return PageDto.of(
      page.items.map((entry) => LedgerEntryDto.from(entry)),
      page.total,
      query,
    );
  }
}
