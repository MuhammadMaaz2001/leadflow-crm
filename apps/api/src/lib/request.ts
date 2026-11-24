import type { NextFunction, Request, Response } from 'express';
import { log, newRequestId, runWithRequest, sanitizeRequestId } from './logger';

/** Assigns a request id (honouring a sane inbound `X-Request-Id`), echoes it, and writes one access-log line per request. */
export function requestContext(opts: { accessLog: boolean }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const id = sanitizeRequestId(req.headers['x-request-id']) ?? newRequestId();
    res.setHeader('X-Request-Id', id);
    (req as Request & { id: string }).id = id;
    const start = process.hrtime.bigint();
    runWithRequest(id, () => {
      res.on('finish', () => {
        if (!opts.accessLog) return;
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        const path = (req.baseUrl + (req.route?.path ?? req.path)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id');
        const lvl = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : req.path.startsWith('/api/health') ? 'debug' : 'info';
        log[lvl]('request', { method: req.method, path, status: res.statusCode, durationMs: Math.round(ms * 10) / 10, ip: req.ip, bytes: Number(res.getHeader('content-length')) || undefined });
      });
      next();
    });
  };
}
