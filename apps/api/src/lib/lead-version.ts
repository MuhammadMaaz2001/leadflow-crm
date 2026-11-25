import { getRedis } from './redis';
import { log } from './logger';

/**
 * Per-workspace "lead data version". Every committed transaction that wrote to `leads` / `lead_tags` bumps it (see db.ts), and cached lead
 * aggregates include it in their key — so a cached total can never outlive a change: the next read after a commit computes fresh numbers.
 * Redis problems never fail a request (the TTL of the cache is the fallback).
 */
const key = (orgId: string) => `leadver:${orgId}`;
export async function getLeadVersion(orgId: string): Promise<string> {
  try { return (await getRedis().get(key(orgId))) ?? '0'; } catch { return 'x'; }
}
export async function bumpLeadVersion(orgId: string): Promise<void> {
  try { await getRedis().incr(key(orgId)); } catch (e) { log.warn('lead version bump failed', { error: (e as Error).message }); }
}
