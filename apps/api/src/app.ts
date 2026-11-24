import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config } from './config';
import { errorMiddleware } from './http';
import { routers } from './modules';
import { openApiDocument, swaggerHandlers } from './openapi';
import { rateLimiter, type Store } from './lib/ratelimit';
import { requestContext } from './lib/request';

export interface AppOptions {
  rateLimit?: boolean;
  /** Where rate-limit counters live. `redis` is shared by every API instance. */
  rateLimitStore?: Store;
  /** Key prefix, so several apps / test runs can use one Redis without sharing counters. */
  rateLimitPrefix?: string;
  accessLog?: boolean;
}

/** CSRF defence for cookie auth: browsers always send Origin on cross-site state-changing requests. */
function originGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  const fetchSite = req.headers['sec-fetch-site'];
  if ((origin && !config.allowedOrigins.includes(origin) && origin !== config.apiUrl) || fetchSite === 'cross-site') {
    res.status(403).json({ error: { code: 'CSRF_BLOCKED', message: 'Cross-site request blocked' } });
    return;
  }
  next();
}

export function createApp(opts: AppOptions = {}) {
  const limit = opts.rateLimit ?? config.rateLimit;
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(requestContext({ accessLog: opts.accessLog ?? config.accessLog }));
  // The API only returns JSON: lock the browser policy down completely. (Swagger UI, mounted below, gets its own relaxed policy.)
  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: { maxAge: 63072000, includeSubDomains: true },
  }));
  app.use(cors({ origin: config.allowedOrigins, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'X-Org-Id', 'X-Request-Id'], exposedHeaders: ['Content-Disposition', 'X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'], maxAge: 600 }));
  // API responses carry private tenant data: never cache them in browsers or shared proxies.
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
  app.use(originGuard);
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  if (limit) {
    const store = opts.rateLimitStore ?? config.rateLimitStore;
    const prefix = opts.rateLimitPrefix ?? 'rl';
    const rl = (name: string, windowMs: number, max: number, message?: string, key?: (r: express.Request) => string | null) => rateLimiter({ name, windowMs, max, store, prefix, message, key });
    const emailKey = (r: express.Request) => { const e = (r.body as { email?: unknown } | undefined)?.email; return typeof e === 'string' && e.length < 255 ? `email:${e.trim().toLowerCase()}` : null; };
    app.use('/api', rl('api', 60_000, 900));
    for (const p of ['/api/auth/reset-password', '/api/auth/verify-email', '/api/auth/resend-verification', '/api/auth/invitation', '/api/auth/change-password']) app.use(p, rl(`sensitive:${p}`, 60_000, 20));
    app.use('/api/leads/import', rl('import', 60_000, 10));
    app.use('/api/auth/login', rl('login', 60_000, 20, 'Too many attempts. Please wait a minute.'));
    // per-account limit: stops a distributed credential-stuffing run against one mailbox regardless of source IP
    app.use('/api/auth/login', rl('login-account', 60_000, 10, 'Too many attempts for this account. Please wait a minute.', emailKey));
    app.use('/api/auth/register', rl('register', 60_000, 20));
    app.use('/api/auth/forgot-password', rl('forgot', 60_000, 10));
    app.use('/api/auth/forgot-password', rl('forgot-account', 3_600_000, 5, 'Too many reset requests for this address. Please try again later.', emailKey));
  }

  if (config.apiDocs) {
    app.get('/api/openapi.json', (_req, res) => res.json(openApiDocument()));
    app.use('/api/docs', ...swaggerHandlers());
  }
  for (const r of routers) app.use('/api', r);

  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));
  app.use(errorMiddleware);
  return app;
}
