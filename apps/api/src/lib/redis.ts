import IORedis from 'ioredis';
import { config } from '../config';
import { log } from './logger';

/**
 * Shared command connection (rate limits, locks, health). Commands issued while the socket is still connecting are queued,
 * but every command fails after 1.5 s (and a request is retried once at most), so an outage never hangs callers for long; so callers can apply their own fail-open / fail-closed policy.
 * BullMQ uses its own connections (see lib/queue.ts) because blocking commands need `maxRetriesPerRequest: null`.
 */
let client: IORedis | null = null;
export function getRedis(): IORedis {
  if (!client) {
    client = new IORedis(config.redisUrl, { maxRetriesPerRequest: 1, commandTimeout: 1500, connectTimeout: 3000, retryStrategy: (n) => Math.min(n * 200, 2000), lazyConnect: false });
    client.on('error', (e) => log.warn('redis connection error', { error: e.message }));
  }
  return client;
}
export async function closeRedis() {
  const c = client; client = null;
  if (c) { try { await c.quit(); } catch { c.disconnect(); } }
}
export async function redisPing(timeoutMs = 1500): Promise<{ ok: boolean; ms: number; error?: string }> {
  const t = Date.now();
  try {
    const r = await Promise.race([getRedis().ping(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
    return { ok: r === 'PONG', ms: Date.now() - t };
  } catch (e) {
    return { ok: false, ms: Date.now() - t, error: (e as Error).message };
  }
}
