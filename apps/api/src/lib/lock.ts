import { randomUUID } from 'node:crypto';
import { getRedis } from './redis';
import { log } from './logger';

/**
 * Redis lease lock (single-Redis variant of the documented SET NX PX pattern).
 *  - acquire: SET key token NX PX ttl
 *  - renew:   extends the TTL only while we still own the token (Lua compare-and-pexpire)
 *  - release: deletes the key only while we still own the token (Lua compare-and-del)
 * A crashed holder simply stops renewing, so the lease expires after `ttlMs` and another instance takes over.
 * Correctness never depends on the lock alone: all guarded work is also idempotent (unique keys / row locks),
 * because a paused process can outlive its lease.
 */
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export interface Lease { key: string; token: string; lost: () => boolean; release: () => Promise<void> }

export async function acquireLock(key: string, ttlMs: number): Promise<Lease | null> {
  const token = randomUUID();
  const ok = await getRedis().set(`lock:${key}`, token, 'PX', ttlMs, 'NX');
  if (ok !== 'OK') return null;
  let lost = false;
  const timer = setInterval(() => {
    getRedis().eval(RENEW, 1, `lock:${key}`, token, String(ttlMs))
      .then((r) => { if (r !== 1) { lost = true; clearInterval(timer); log.warn('lock lease lost', { key }); } })
      .catch((e) => log.warn('lock renew failed', { key, error: (e as Error).message }));
  }, Math.max(250, Math.floor(ttlMs / 3)));
  timer.unref();
  return {
    key, token, lost: () => lost,
    release: async () => { clearInterval(timer); try { await getRedis().eval(RELEASE, 1, `lock:${key}`, token); } catch { /* lease will expire */ } },
  };
}

/** Runs `fn` only when the lock was acquired; returns `{ ran: false }` when another instance holds it. */
export async function withLock<T>(key: string, ttlMs: number, fn: (lease: Lease) => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  const lease = await acquireLock(key, ttlMs);
  if (!lease) return { ran: false };
  try { return { ran: true, value: await fn(lease) }; } finally { await lease.release(); }
}
