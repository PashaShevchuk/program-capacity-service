import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { type Request } from 'express';

/** The request id assigned by pino-http, echoed into logs and ledger entries. */
export const CorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    String(context.switchToHttp().getRequest<Request & { id?: string }>().id ?? ''),
);
