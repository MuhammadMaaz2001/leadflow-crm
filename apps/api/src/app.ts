import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { errorMiddleware } from './http';
import { routers } from './modules';
import { openApiDocument, swaggerHandlers } from './openapi';

export interface AppOptions { rateLimit?: boolean }

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
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: config.allowedOrigins, credentials: true, exposedHeaders: ['Content-Disposition'] }));
  // API responses carry private tenant data: never cache them in browsers or shared proxies.
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
  app.use(originGuard);
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  if (limit) {
    const rl = (windowMs: number, max: number) => rateLimit({ windowMs, limit: max, standardHeaders: true, legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a minute and try again.' } } });
    app.use('/api', rl(60_000, 900));
    for (const p of ['/api/auth/reset-password', '/api/auth/verify-email', '/api/auth/resend-verification', '/api/auth/invitation', '/api/auth/change-password']) app.use(p, rl(60_000, 20));
    app.use('/api/leads/import', rl(60_000, 10));
    app.use('/api/auth/login', rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a minute.' } } }));
    app.use('/api/auth/register', rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }));
    app.use('/api/auth/forgot-password', rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false }));
  }

  app.get('/api/openapi.json', (_req, res) => res.json(openApiDocument()));
  app.use('/api/docs', ...swaggerHandlers());
  for (const r of routers) app.use('/api', r);

  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));
  app.use(errorMiddleware);
  return app;
}
