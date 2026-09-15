import { type ProgramEntity } from './program.entity';

export const CAPACITY_CHANGED_EVENT_TYPE = 'ProgramCapacityChanged';

/** Emitted to Kafka and to the SSE stream whenever a program's capacity moves. */
export interface CapacityChangedPayload extends Record<string, unknown> {
  programId: string;
  programCode: string;
  currency: string;
  totalLimit: string;
  reserved: string;
  available: string;
  version: number;
  reason: string;
  reservationId: string | null;
  occurredAt: string;
}

export function buildCapacityChangedPayload(
  program: ProgramEntity,
  reason: string,
  reservationId: string | null = null,
): CapacityChangedPayload {
  return {
    programId: program.id,
    programCode: program.code,
    currency: program.currency,
    totalLimit: program.totalLimit.toDecimalString(),
    reserved: program.reserved.toDecimalString(),
    available: program.available.toDecimalString(),
    version: program.version,
    reason,
    reservationId,
    occurredAt: new Date().toISOString(),
  };
}
