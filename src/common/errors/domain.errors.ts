/**
 * Framework-free errors so the domain does not depend on Nest or HTTP.
 * The exception filter turns them into RFC 7807 responses; the Kafka consumer
 * turns them into retry or DLQ decisions.
 */
export abstract class DomainError extends Error {
  /** Stable code that API clients can branch on. */
  abstract readonly code: string;

  /** Extra context for the error response. Must not contain secrets. */
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** The request is well-formed but violates a business rule. */
export abstract class BusinessRuleViolationError extends DomainError {}

/** The request refers to something that does not exist. */
export abstract class NotFoundError extends DomainError {}

/** The request is malformed or semantically invalid. */
export abstract class ValidationError extends DomainError {}

// --- money ------------------------------------------------------------------

export class InvalidCurrencyError extends ValidationError {
  readonly code = 'INVALID_CURRENCY';

  constructor(value: unknown, supported: readonly string[]) {
    super(`Unsupported currency code: ${String(value)}`, { value, supportedCurrencies: supported });
  }
}

export class CurrencyMismatchError extends ValidationError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(left: string, right: string) {
    super(`Cannot operate on amounts in different currencies: ${left} and ${right}`, {
      left,
      right,
    });
  }
}

export class InvalidAmountError extends ValidationError {
  readonly code = 'INVALID_AMOUNT';

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, details);
  }
}

// --- messaging --------------------------------------------------------------

export class MalformedMessageError extends ValidationError {
  readonly code = 'MALFORMED_MESSAGE';

  constructor(topic: string, violations: string[]) {
    super(`Message on ${topic} does not match its contract`, { topic, violations });
  }
}

// --- fx ---------------------------------------------------------------------

export class ExchangeRateUnavailableError extends BusinessRuleViolationError {
  readonly code = 'EXCHANGE_RATE_UNAVAILABLE';

  constructor(base: string, quote: string) {
    super(`No exchange rate available for ${base}/${quote}`, { base, quote });
  }
}

// --- program ----------------------------------------------------------------

export class ProgramNotFoundError extends NotFoundError {
  readonly code = 'PROGRAM_NOT_FOUND';

  constructor(identifier: string) {
    super(`Program not found: ${identifier}`, { program: identifier });
  }
}

export class ProgramCodeTakenError extends BusinessRuleViolationError {
  readonly code = 'PROGRAM_CODE_TAKEN';

  constructor(programCode: string) {
    super(`A program with code ${programCode} already exists`, { programCode });
  }
}

export class ProgramNotActiveError extends BusinessRuleViolationError {
  readonly code = 'PROGRAM_NOT_ACTIVE';

  constructor(programId: string, status: string) {
    super(`Program ${programId} does not accept reservations while ${status}`, {
      programId,
      status,
    });
  }
}

export class InsufficientCapacityError extends BusinessRuleViolationError {
  readonly code = 'INSUFFICIENT_CAPACITY';

  constructor(details: {
    programId: string;
    currency: string;
    requestedAmount: string;
    availableAmount: string;
  }) {
    super(
      `Program ${details.programId} has ${details.availableAmount} ${details.currency} available, ` +
        `which is less than the requested ${details.requestedAmount} ${details.currency}`,
      details,
    );
  }
}

export class ProgramLimitBelowReservedError extends BusinessRuleViolationError {
  readonly code = 'LIMIT_BELOW_RESERVED';

  constructor(details: { programId: string; newLimit: string; reserved: string }) {
    super(
      `Cannot lower the limit of program ${details.programId} to ${details.newLimit}: ` +
        `${details.reserved} is currently reserved`,
      details,
    );
  }
}

// --- reservation ------------------------------------------------------------

export class ReservationNotFoundError extends NotFoundError {
  readonly code = 'RESERVATION_NOT_FOUND';

  constructor(identifier: string) {
    super(`Reservation not found: ${identifier}`, { reservation: identifier });
  }
}

export class DuplicateReservationError extends BusinessRuleViolationError {
  readonly code = 'DUPLICATE_RESERVATION';

  constructor(details: { programId: string; invoiceId: string; reservationId: string }) {
    super(
      `Invoice ${details.invoiceId} already holds a reservation on program ${details.programId}`,
      details,
    );
  }
}

export class IdempotencyKeyConflictError extends BusinessRuleViolationError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';

  constructor(idempotencyKey: string) {
    super(`Idempotency-Key ${idempotencyKey} was already used with a different request payload`, {
      idempotencyKey,
    });
  }
}

export class InvalidReservationTransitionError extends BusinessRuleViolationError {
  readonly code = 'INVALID_RESERVATION_TRANSITION';

  constructor(details: { reservationId: string; from: string; to: string }) {
    super(
      `Reservation ${details.reservationId} cannot move from ${details.from} to ${details.to}`,
      details,
    );
  }
}

// --- concurrency ------------------------------------------------------------

export class ConcurrentModificationError extends DomainError {
  readonly code = 'CONCURRENT_MODIFICATION';

  constructor(entity: string, id: string) {
    super(`${entity} ${id} was modified concurrently; retry the request`, { entity, id });
  }
}
