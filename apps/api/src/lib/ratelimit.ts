import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getRedis } from './redis';
import { log } from './logger';

/**
 * Fixed-window rate limiter with a shared Redis store, so limits are enforced across ALL API instances.
 *  - Redis: one atomic Lua script per request (INCR + PEXPIRE on first hit), O(1), no race between instances.
 *  - If Redis is unreachable the limiter degrades to a per-process memory window (and logs a warning at most once
 *    a minute) instead of failing every request: security limits stay in force, only their cross-instance
 *    accuracy is lost until Redis returns.
 */
const SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {c, ttl}`;

export type Store = 'redis' | 'memory';
export interface LimiterOptions {
  name: string;
  windowMs: number;
  max: number;
  store?: Store;
  prefix?: string;
  message?: string;
  /** Defaults to the client IP (the API runs behind `trust proxy`). */
  key?: (req: Request) => string | null;
}

const memory = new Map<string, { count: number; resetAt: number }>();
function memoryHit(key: string, windowMs: number): { count: number; ttl: number } {
  const now = Date.now();
  let e = memory.get(key);
  if (!e || e.resetAt <= now) { e = { count: 0, resetAt: now + windowMs }; memory.set(key, e); }
  e.count += 1;
  if (memory.size > 50_000) for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
  return { count: e.count, ttl: e.resetAt - now };
}
export const resetMemoryLimits = () => { memory.clear(); redisDownUntil = 0; };

let lastWarn = 0;
/** Circuit breaker: after a Redis failure skip Redis for 5 s so an outage costs one slow request, not one per request. */
let redisDownUntil = 0;
export async function hit(o: Required<Pick<LimiterOptions, 'windowMs' | 'store'>> & { redisKey: string }): Promise<{ count: number; ttl: number; degraded: boolean }> {
  if (o.store === 'redis' && Date.now() >= redisDownUntil) {
    try {
      const [count, ttl] = (await getRedis().eval(SCRIPT, 1, o.redisKey, String(o.windowMs))) as [number, number];
      return { count, ttl, degraded: false };
    } catch (e) {
      redisDownUntil = Date.now() + 5000;
      if (Date.now() - lastWarn > 60_000) { lastWarn = Date.now(); log.warn('rate limiter: redis unavailable, using per-process fallback', { error: (e as Error).message }); }
    }
  }
  const m = memoryHit(o.redisKey, o.windowMs);
  return { ...m, degraded: o.store === 'redis' };
}

export function rateLimiter(o: LimiterOptions): RequestHandler {
  const store = o.store ?? 'redis';
  const prefix = o.prefix ?? 'rl';
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const who = (o.key ? o.key(req) : req.ip) ?? 'anonymous';
      const r = await hit({ windowMs: o.windowMs, store, redisKey: `${prefix}:${o.name}:${who}` });
      const reset = Math.max(1, Math.ceil(r.ttl / 1000));
      res.setHeader('RateLimit-Limit', String(o.max));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, o.max - r.count)));
      res.setHeader('RateLimit-Reset', String(reset));
      if (r.count > o.max) {
        res.setHeader('Retry-After', String(reset));
        res.status(429).json({ error: { code: 'RATE_LIMITED', message: o.message ?? 'Too many requests. Please wait a minute and try again.' } });
        return;
      }
      next();
    } catch (e) { next(e); }
  };
}
