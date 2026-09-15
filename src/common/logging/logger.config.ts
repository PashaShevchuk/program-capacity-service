import { randomUUID } from 'node:crypto';
import { type Params } from 'nestjs-pino';
import { type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * JSON logs with a request id on every line, so one request can be followed
 * across the API, the database and the Kafka consumer. Credentials and tokens
 * are redacted rather than relied on not to appear.
 */
export function buildLoggerOptions(level: string, pretty: boolean): Params {
  return {
    pinoHttp: {
      level,
      genReqId: (req: IncomingMessage, res: ServerResponse) => {
        const existing = req.headers['x-request-id'];
        const id = (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'res.headers["set-cookie"]',
        ],
        censor: '[redacted]',
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      autoLogging: {
        ignore: (req: IncomingMessage) =>
          ['/healthz', '/readyz', '/metrics'].includes(req.url ?? ''),
      },
      transport: pretty
        ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss.l' } }
        : undefined,
    },
  };
}
