import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { type Request, type Response } from 'express';

import {
  BusinessRuleViolationError,
  ConcurrentModificationError,
  DomainError,
  NotFoundError,
  ValidationError,
} from '../errors/domain.errors';
import { ProblemDetails } from './problem-details';

const ERROR_DOC_BASE_URL = 'https://docs.capacity.example/errors';

/**
 * Turns everything thrown in the app into one RFC 7807 shape, so clients parse
 * errors the same way no matter which layer produced them.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: string }>();
    const response = http.getResponse<Response>();

    const problem = this.toProblemDetails(exception, request);

    if (problem.status >= 500) {
      this.logger.error(
        { err: exception, requestId: problem.requestId, path: problem.instance },
        'Unhandled error',
      );
    } else {
      this.logger.debug(
        { code: problem.code, requestId: problem.requestId, path: problem.instance },
        problem.detail,
      );
    }

    response.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblemDetails(exception: unknown, request: Request & { id?: string }): ProblemDetails {
    const base = {
      instance: request.originalUrl ?? request.url,
      timestamp: new Date().toISOString(),
      requestId: String(request.id ?? request.headers['x-request-id'] ?? ''),
    };

    if (exception instanceof DomainError) {
      const status = statusForDomainError(exception);

      return {
        ...base,
        type: `${ERROR_DOC_BASE_URL}/${exception.code}`,
        title: titleCase(exception.code),
        status,
        detail: exception.message,
        code: exception.code,
        details: Object.keys(exception.details).length ? exception.details : undefined,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const detail =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: string | string[] }).message ?? exception.message);

      return {
        ...base,
        type: `${ERROR_DOC_BASE_URL}/HTTP_${status}`,
        title: exception.name.replace(/Exception$/, ''),
        status,
        detail: Array.isArray(detail) ? detail.join('; ') : detail,
        code: `HTTP_${status}`,
        details:
          typeof payload === 'object' && Array.isArray((payload as { message?: unknown }).message)
            ? { violations: (payload as { message: string[] }).message }
            : undefined,
      };
    }

    return {
      ...base,
      type: `${ERROR_DOC_BASE_URL}/INTERNAL_ERROR`,
      title: 'Internal Server Error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      // Never leak an unexpected error's message to the client.
      detail: 'An unexpected error occurred. Quote the request id when reporting it.',
      code: 'INTERNAL_ERROR',
    };
  }
}

function statusForDomainError(error: DomainError): number {
  if (error instanceof NotFoundError) return HttpStatus.NOT_FOUND;
  if (error instanceof ValidationError) return HttpStatus.UNPROCESSABLE_ENTITY;
  if (error instanceof ConcurrentModificationError) return HttpStatus.CONFLICT;
  if (error instanceof BusinessRuleViolationError) return HttpStatus.CONFLICT;
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

function titleCase(code: string): string {
  return code
    .toLowerCase()
    .split('_')
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}
