import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma, PrismaClient } from '@leadflow/database';
import { config } from './config';
import { log } from './lib/logger';

/** Application connection: restricted role, subject to PostgreSQL row level security. */
const slowLog = config.slowQueryMs > 0 ? ([{ emit: 'event', level: 'query' }] as const) : undefined;
export const prisma = new PrismaClient({ datasourceUrl: config.appDatabaseUrl, log: slowLog as never });
/** Platform administration connection: no grants on private CRM tables (see migration). */
export const platformPrisma = new PrismaClient({ datasourceUrl: config.platformDatabaseUrl, log: slowLog as never });

/**
 * Slow-query log: every statement slower than SLOW_QUERY_MS is logged with its duration and the PARAMETERISED SQL text
 * (`$1, $2…`). Parameter values are never logged because they contain customer data.
 */
if (config.slowQueryMs > 0) {
  for (const [name, client] of [['app', prisma], ['platform', platformPrisma]] as const) {
    (client as unknown as { $on: (e: 'query', cb: (q: { query: string; duration: number }) => void) => void }).$on('query', (q) => {
      if (q.duration >= config.slowQueryMs && !/^\s*(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/i.test(q.query)) log.warn('slow query', { client: name, durationMs: q.duration, sql: q.query.replace(/\s+/g, ' ').slice(0, 600) });
    });
  }
}

export type Tx = Prisma.TransactionClient;

interface Store {
  tx: Tx;
  orgId: string | null;
  userId: string | null;
  afterCommit: Array<() => Promise<void>>;
  /** Set while an automation executes: actions performed by automations never trigger other automations (no loops). */
  suppressTriggers?: boolean;
}
const als = new AsyncLocalStorage<Store>();

export function db(): Tx {
  const s = als.getStore();
  if (!s) throw new Error('db() called outside of a tenant context');
  return s.tx;
}
export function currentStore() {
  return als.getStore();
}
/** Run a callback only after the surrounding transaction committed (e.g. enqueue background jobs). */
export function afterCommit(fn: () => Promise<void>) {
  const s = als.getStore();
  if (!s) throw new Error('afterCommit() outside context');
  s.afterCommit.push(fn);
}

export interface ContextOptions {
  orgId?: string | null;
  userId?: string | null;
  inviteToken?: string | null;
}

/**
 * Opens a transaction whose PostgreSQL session variables (app.org_id / app.user_id) drive row level
 * security policies. Every database access of a request happens inside exactly one such transaction.
 */
export async function withContext<T>(opts: ContextOptions, fn: () => Promise<T>): Promise<T> {
  const existing = als.getStore();
  if (existing) {
    if ((opts.orgId ?? null) !== existing.orgId && opts.orgId !== undefined) await setOrg(opts.orgId ?? null);
    return fn();
  }
  const hooks: Array<() => Promise<void>> = [];
  const result = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.org_id', ${opts.orgId ?? ''}, true),
        set_config('app.user_id', ${opts.userId ?? ''}, true),
        set_config('app.invite_token', ${opts.inviteToken ?? ''}, true)`;
      return als.run({ tx, orgId: opts.orgId ?? null, userId: opts.userId ?? null, afterCommit: hooks }, fn);
    },
    { timeout: 120_000, maxWait: 15_000 },
  );
  for (const h of hooks) {
    try { await h(); } catch (e) { log.error('afterCommit hook failed', { error: e }); }
  }
  return result;
}

/** Switch the active workspace inside the current transaction (used when creating a workspace / accepting an invite). */
export async function setOrg(orgId: string | null) {
  const s = als.getStore();
  if (!s) throw new Error('setOrg outside context');
  await s.tx.$executeRaw`SELECT set_config('app.org_id', ${orgId ?? ''}, true)`;
  s.orgId = orgId;
}

/** Iterate all active workspaces, each in its own tenant-scoped transaction (background jobs). A failing workspace never stops the others. */
export async function forEachOrg(fn: (orgId: string) => Promise<void>, shouldStop: () => boolean = () => false): Promise<{ orgs: number; failed: number }> {
  const orgs = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM app_list_active_orgs()`;
  let failed = 0;
  for (const { id } of orgs) {
    if (shouldStop()) { log.warn('workspace iteration aborted (lease lost or shutting down)', { remaining: orgs.length }); break; }
    try {
      await withContext({ orgId: id }, () => fn(id));
    } catch (e) {
      failed += 1;
      log.error('background job failed for workspace', { orgId: id, error: e });
    }
  }
  return { orgs: orgs.length, failed };
}
