const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

interface PostgresError {
  code?: string;
  constraint?: string;
}

function asPostgresError(error: unknown): PostgresError | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as PostgresError)
    : null;
}

/** True when the error is a unique violation, optionally on a named constraint. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pgError = asPostgresError(error);
  if (pgError?.code !== UNIQUE_VIOLATION) return false;

  return constraint ? pgError.constraint === constraint : true;
}

export function isCheckViolation(error: unknown, constraint?: string): boolean {
  const pgError = asPostgresError(error);
  if (pgError?.code !== CHECK_VIOLATION) return false;

  return constraint ? pgError.constraint === constraint : true;
}
