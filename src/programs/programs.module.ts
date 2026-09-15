import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CapacityLedgerEntryEntity } from '../ledger/capacity-ledger-entry.entity';
import { LedgerModule } from '../ledger/ledger.module';
import { OutboxModule } from '../outbox/outbox.module';
import { CapacityEventsService } from './capacity-events.service';
import { ProgramCapacityRepository } from './program-capacity.repository';
import { ProgramEntity } from './program.entity';
import { ProgramsController } from './programs.controller';
import { ProgramsService } from './programs.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ProgramEntity, CapacityLedgerEntryEntity]),
    LedgerModule,
    OutboxModule,
  ],
  controllers: [ProgramsController],
  providers: [ProgramsService, ProgramCapacityRepository, CapacityEventsService],
  exports: [ProgramsService, ProgramCapacityRepository, CapacityEventsService],
})
export class ProgramsModule {}
