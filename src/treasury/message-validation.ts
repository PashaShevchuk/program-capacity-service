import { plainToInstance } from 'class-transformer';
import { validateSync, type ValidationError } from 'class-validator';

import { MalformedMessageError } from '../common/errors/domain.errors';

type Constructor<T> = new () => T;

/**
 * Validates a message body against its contract.
 *
 * A message that fails here will fail the same way on every redelivery, so the
 * consumer treats the resulting error as permanent and parks it in the DLQ.
 */
export function parseMessageBody<T extends object>(
  topic: string,
  cls: Constructor<T>,
  body: unknown,
): T {
  const instance = plainToInstance(cls, body, { enableImplicitConversion: false });
  const errors = validateSync(instance as object, {
    whitelist: true,
    forbidUnknownValues: true,
  });

  if (errors.length > 0) {
    throw new MalformedMessageError(topic, flatten(errors));
  }

  return instance;
}

function flatten(errors: ValidationError[], path = ''): string[] {
  return errors.flatMap((error) => {
    const property = path ? `${path}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map((message) => `${property}: ${message}`);
    const nested = error.children?.length ? flatten(error.children, property) : [];

    return [...own, ...nested];
  });
}
