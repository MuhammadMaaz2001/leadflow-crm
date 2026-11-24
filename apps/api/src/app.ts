import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { errorMiddleware } from './http';
import { routers } from './modules';
import { openApiDocument, swaggerHandlers } from './openapi';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: config.webUrl, credentials: true, exposedHeaders: ['Content-Disposition'] }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  if (config.rateLimit) {
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
