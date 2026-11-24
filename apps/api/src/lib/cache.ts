import { createHash } from 'node:crypto';
import { db } from '../db';
import { config } from '../config';
import { getRedis } from './redis';
import { log } from './logger';

/**
 * Short-TTL result cache for the three whole-workspace aggregations that grow with workspace size: list totals (`count(*)`),
 * the dashboard and the reports. It is deliberately conservative:
 *   • only workspaces with at least LARGE_WORKSPACE_LEADS leads use it (decided from the latest daily usage snapshot — one row),
 *     so small and medium workspaces always see exact, immediately consistent numbers;
 *   • entries live CACHE_TTL_SECONDS (default 20 s): large-workspace aggregates may lag by that long, the list rows themselves never do;
 *   • keys include the workspace and the caller's data scope (own vs all) — a cached value can never cross tenants or scopes;
 *   • concurrent identical misses in one process share one computation; any Redis problem falls through to computing directly.
 */
const sizeMemo = new Map<string, { large: boolean; until: number }>();
export const resetCacheMemo = () => sizeMemo.clear();

export async function isLargeWorkspace(orgId: string): Promise<boolean> {
  if (config.largeWorkspaceLeads <= 0) return false;
  const hit = sizeMemo.get(orgId);
  if (hit && hit.until > Date.now()) return hit.large;
  const snap = await db().usageRecord.findFirst({ where: { organizationId: orgId }, orderBy: { day: 'desc' }, select: { leads: true } });
  const large = (snap?.leads ?? 0) >= config.largeWorkspaceLeads;
  sizeMemo.set(orgId, { large, until: Date.now() + 60_000 });
  return large;
}

const inflight = new Map<string, Promise<unknown>>();
export const hashKey = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 24);

export async function cachedForLarge<T>(orgId: string, key: string, compute: () => Promise<T>): Promise<T> {
  if (!(await isLargeWorkspace(orgId))) return compute();
  const k = `cache:${orgId}:${key}`;
  try {
    const hit = await getRedis().get(k);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch (e) { log.warn('cache read failed', { error: (e as Error).message }); return compute(); }
  const running = inflight.get(k);
  if (running) return running as Promise<T>;
  const p = (async () => {
    const value = await compute();
    try { await getRedis().set(k, JSON.stringify(value), 'EX', config.cacheTtlSeconds); } catch (e) { log.warn('cache write failed', { error: (e as Error).message }); }
    return value;
  })().finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}
