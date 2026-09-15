import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LedgerModule } from '../ledger/ledger.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ProgramsModule } from '../programs/programs.module';
import { InvoiceReservationEntity } from '../reservations/invoice-reservation.entity';
import { ReservationsModule } from '../reservations/reservations.module';
import { TreasuryEventsHandler } from './handlers/treasury-events.handler';
import { TreasuryReconciliationHandler } from './handlers/treasury-reconciliation.handler';

/** Consumes the treasury system's capacity feed. */
@Module({
  imports: [
    TypeOrmModule.forFeature([InvoiceReservationEntity]),
    ProgramsModule,
    ReservationsModule,
    LedgerModule,
    OutboxModule,
  ],
  providers: [TreasuryEventsHandler, TreasuryReconciliationHandler],
})
export class TreasuryModule {}
