import { type Money } from '../common/money/money';
import { type LedgerEntrySource } from '../ledger/capacity-ledger-entry.entity';
import { type ProgramEntity } from '../programs/program.entity';
import {
  type InvoiceReservationEntity,
  type ReservationSource,
} from './invoice-reservation.entity';

export interface ReserveCapacityCommand {
  /** Program id or code. */
  programRef: string;
  invoiceId: string;
  /** Invoice face value, in the invoice's own currency. */
  amount: Money;
  source: ReservationSource;
  ledgerSource: LedgerEntrySource;
  idempotencyKey?: string | null;
  externalReference?: string | null;
  correlationId?: string | null;
  /** When the approval happened; also the moment the FX rate is taken at. */
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface CloseReservationCommand {
  programRef: string;
  /** Reservation id or invoice id. */
  reservationRef: string;
  ledgerSource: LedgerEntrySource;
  correlationId?: string | null;
  occurredAt?: Date;
  reason?: string | null;
}

export interface ReservationResult {
  reservation: InvoiceReservationEntity;
  program: ProgramEntity;
  /** False when an idempotent replay returned an existing record unchanged. */
  changed: boolean;
}
