import os from 'node:os';
import { prisma } from '../db';
import { getRedis, redisPing } from './redis';

export interface Check { ok: boolean; latencyMs: number; error?: string }

export async function checkDatabase(timeoutMs = 2000): Promise<Check> {
  const t = Date.now();
  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
    return { ok: true, latencyMs: Date.now() - t };
  } catch (e) { return { ok: false, latencyMs: Date.now() - t, error: (e as Error).message.slice(0, 120) }; }
}
export async function checkRedis(): Promise<Check> {
  const r = await redisPing();
  return { ok: r.ok, latencyMs: r.ms, error: r.error };
}

/* ── worker heartbeats ─────────────────────────────────────────────────────────── */
const HB_TTL_S = 30;
export const workerId = `${os.hostname()}:${process.pid}`;
export async function publishHeartbeat(extra: Record<string, unknown> = {}) {
  await getRedis().set(`worker:hb:${workerId}`, JSON.stringify({ workerId, pid: process.pid, host: os.hostname(), at: new Date().toISOString(), ...extra }), 'EX', HB_TTL_S);
}
export async function clearHeartbeat() { try { await getRedis().del(`worker:hb:${workerId}`); } catch { /* expires on its own */ } }
export async function recordSchedulerRun(info: { durationMs: number; orgs: number; failed: number }) {
  await getRedis().set('scheduler:last-run', JSON.stringify({ at: new Date().toISOString(), ...info }), 'EX', 24 * 3600);
}

export interface WorkerStatus { workers: number; schedulerLastRunAt: string | null; schedulerAgeSeconds: number | null; schedulerStale: boolean; lastRun?: Record<string, unknown> }
export async function workerStatus(staleAfterS = 180): Promise<WorkerStatus> {
  const r = getRedis();
  const keys: string[] = []; let cursor = '0';
  do { const [next, batch] = await r.scan(cursor, 'MATCH', 'worker:hb:*', 'COUNT', 100); cursor = next; keys.push(...batch); } while (cursor !== '0');
  const last = await r.get('scheduler:last-run');
  const parsed = last ? (JSON.parse(last) as { at: string }) : null;
  const age = parsed ? Math.round((Date.now() - new Date(parsed.at).getTime()) / 1000) : null;
  return { workers: keys.length, schedulerLastRunAt: parsed?.at ?? null, schedulerAgeSeconds: age, schedulerStale: age === null || age > staleAfterS, lastRun: parsed ?? undefined };
}

/* ── database role verification (production safety net for row level security) ───── */
export interface RoleProbe { user: string; superuser: boolean; bypassRls: boolean; canReadLeads: boolean }
export async function probeRole(client: { $queryRaw: <T>(q: TemplateStringsArray) => Promise<T> }): Promise<RoleProbe> {
  const [r] = await client.$queryRaw<Array<{ user: string; superuser: boolean; bypassrls: boolean; leads: boolean }>>`
    SELECT current_user::text AS user, r.rolsuper AS superuser, r.rolbypassrls AS bypassrls, has_table_privilege(current_user, 'leads', 'SELECT') AS leads
    FROM pg_roles r WHERE r.rolname = current_user`;
  return { user: r!.user, superuser: r!.superuser, bypassRls: r!.bypassrls, canReadLeads: r!.leads };
}
/** Returns human readable problems; an empty list means both runtime connections have the intended least-privilege roles. */
export function roleProblems(app: RoleProbe, platform: RoleProbe): string[] {
  const p: string[] = [];
  if (app.superuser || app.bypassRls) p.push(`APP_DATABASE_URL connects as "${app.user}" which is ${app.superuser ? 'a superuser' : 'BYPASSRLS'}: tenant isolation (row level security) would NOT apply.`);
  if (platform.superuser) p.push(`PLATFORM_DATABASE_URL connects as superuser "${platform.user}".`);
  if (platform.canReadLeads) p.push(`PLATFORM_DATABASE_URL role "${platform.user}" can read private CRM tables (leads).`);
  return p;
}
