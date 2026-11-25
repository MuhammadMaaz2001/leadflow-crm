import { Worker } from 'bullmq';
import { addHours } from 'date-fns';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { acquireLock, withLock } from '../src/lib/lock';
import { getRedis, closeRedis } from '../src/lib/redis';
import { resetMemoryLimits } from '../src/lib/ratelimit';
import { runLockedSchedulerTick, runSchedulerTick } from '../src/modules/automations/scheduler';
import { executeAutomation } from '../src/modules/automations/engine';
import { JOB_ATTEMPTS, QUEUE_NAME, redisConnection, getQueue, closeQueue } from '../src/lib/queue';
import { clearErrorReporters, setErrorReporter } from '../src/lib/error-report';
import { deliverEmail, setEmailProvider, sweepEmailOutbox, type EmailProvider } from '../src/lib/email';
import { addMember, boot, createWorkspace, ownerPrisma, request, signUp, uniq, type Actor, PASSWORD } from './helpers';

const prefix = `rltest-${uniq()}`;
beforeAll(async () => { await boot(); });
afterAll(async () => {
  const r = getRedis();
  const keys = await r.keys(`${prefix}*`); if (keys.length) await r.del(...keys);
  await closeQueue(); await closeRedis();
});

describe('Redis-backed rate limiting (shared by every API instance)', () => {
  const mk = (p: string) => createApp({ rateLimit: true, rateLimitStore: 'redis', rateLimitPrefix: `${prefix}-${p}` });

  it('enforces ONE limit across two API instances, under concurrency', async () => {
    const a = mk('shared'), b = mk('shared'); // two separate Express apps = two instances, same Redis, same prefix
    const calls = Array.from({ length: 30 }, (_, i) => request(i % 2 ? a : b).post('/api/auth/forgot-password').send({ email: `nobody-${i}@example.com` }));
    const res = await Promise.all(calls);
    const ok = res.filter((r) => r.status !== 429).length, limited = res.filter((r) => r.status === 429);
    expect(ok).toBe(10);                                  // forgot-password: 10 per minute per IP — exactly, not 10 per instance
    expect(limited).toHaveLength(20);
    expect(limited[0]!.body.error.code).toBe('RATE_LIMITED');
    expect(Number(limited[0]!.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited[0]!.headers['ratelimit-limit']).toBe('10');
    expect(res.every((r) => r.headers['x-request-id'])).toBe(true);
  });

  it('keeps per-account login limits regardless of source (credential stuffing) and separate prefixes do not share counters', async () => {
    const a = mk('acct1'), b = mk('acct2');
    const email = `victim-${uniq()}@example.com`;
    const res = await Promise.all(Array.from({ length: 16 }, (_, i) => request(i % 2 ? a : b).post('/api/auth/login').send({ email, password: 'wrong-password-1' })));
    // different prefixes → each app counts alone: 8 requests each, below the per-account limit of 10 → none limited
    expect(res.filter((r) => r.status === 429)).toHaveLength(0);
    const c = mk('acct1');
    const more = await Promise.all(Array.from({ length: 6 }, () => request(c).post('/api/auth/login').send({ email, password: 'wrong-password-1' })));
    expect(more.filter((r) => r.status === 429).length).toBeGreaterThan(0); // shares acct1's counter (8 earlier + 6 > 10)
  });

  it('degrades to a per-process window when Redis is unavailable instead of failing requests', async () => {
    resetMemoryLimits();
    const spy = vi.spyOn(getRedis(), 'eval').mockRejectedValue(new Error('redis down'));
    try {
      const app = mk('fallback');
      const res = await Promise.all(Array.from({ length: 14 }, (_, i) => request(app).post('/api/auth/forgot-password').send({ email: `fb-${i}@example.com` })));
      expect(res.some((r) => r.status >= 500)).toBe(false);
      expect(res.filter((r) => r.status === 429).length).toBe(4);
    } finally { spy.mockRestore(); resetMemoryLimits(); }
  });
});

describe('distributed locks', () => {
  it('grants a lock to exactly one of many concurrent contenders', async () => {
    const key = `${prefix}-contend`;
    const leases = await Promise.all(Array.from({ length: 12 }, () => acquireLock(key, 5000)));
    expect(leases.filter(Boolean)).toHaveLength(1);
    await leases.find(Boolean)!.release();
    const again = await acquireLock(key, 5000);
    expect(again).not.toBeNull();
    await again!.release();
  });

  it('a crashed holder (no renewal) loses the lock when its lease expires; a stale holder cannot release the new owner\'s lock', async () => {
    const key = `${prefix}-crash`;
    // simulate a crashed instance: it set the key and never renews it
    await getRedis().set(`lock:${key}`, 'dead-instance-token', 'PX', 400, 'NX');
    expect(await acquireLock(key, 2000)).toBeNull();
    await new Promise((r) => setTimeout(r, 500));
    const lease = await acquireLock(key, 2000);
    expect(lease).not.toBeNull();
    // a paused ex-holder wakes up and releases with its OLD token: must not delete our lock
    await getRedis().eval(`if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`, 1, `lock:${key}`, 'dead-instance-token');
    expect(await getRedis().get(`lock:${key}`)).toBe(lease!.token);
    await lease!.release();
    expect(await getRedis().get(`lock:${key}`)).toBeNull();
  });

  it('renews the lease while work runs and reports when it was lost', async () => {
    const key = `${prefix}-renew`;
    const r = await withLock(key, 600, async (lease) => {
      await new Promise((res) => setTimeout(res, 1500));      // runs 2.5× longer than the TTL
      expect(lease.lost()).toBe(false);
      expect(await acquireLock(key, 600)).toBeNull();         // still protected
      return 'done';
    });
    expect(r).toEqual({ ran: true, value: 'done' });
    const lost = await withLock(`${key}-lost`, 600, async (lease) => {
      await getRedis().set(`lock:${key}-lost`, 'someone-else');   // lease stolen / expired during a pause
      await new Promise((res) => setTimeout(res, 500));
      return lease.lost();
    });
    expect(lost).toEqual({ ran: true, value: true });
    await getRedis().del(`lock:${key}-lost`);
  });
});

describe('scheduler coordination and idempotency', () => {
  let owner: Actor, agent: Actor;
  beforeAll(async () => {
    owner = await createWorkspace(await signUp('Sched Owner'), 'Sched Co');
    agent = await addMember(owner, 'SALES_AGENT');
  });

  it('several scheduler instances: only one runs a tick at a time, the others skip', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => runLockedSchedulerTick()));
    expect(results.filter((r) => r.ran)).toHaveLength(1);
    const status = await getRedis().get('scheduler:last-run');
    expect(status).toBeTruthy();
    // lock is released afterwards, the next tick can run
    expect((await runLockedSchedulerTick()).ran).toBe(true);
  });

  it('is idempotent even WITHOUT the lock: concurrent ticks never duplicate tasks, executions or notifications', async () => {
    const lead = await owner.post('/leads', { firstName: 'Idem', email: `idem-${uniq()}@x.com`, assignedToId: agent.userId });
    const when = addHours(new Date(), 30);
    await Promise.all([runSchedulerTick(when), runSchedulerTick(when), runSchedulerTick(when)]);
    await runSchedulerTick(when); // converge (an org transaction that lost a race is retried by the next tick)
    const tasks = await ownerPrisma.task.findMany({ where: { organizationId: owner.orgId!, leadId: lead.body.data.id, isAutomated: true } });
    expect(tasks.filter((t) => /Contact this lead/.test(t.title))).toHaveLength(1);
    const execs = await ownerPrisma.automationExecution.findMany({ where: { organizationId: owner.orgId!, entityId: lead.body.data.id, eventKey: { startsWith: 'LEAD_NOT_CONTACTED' } } });
    expect(new Set(execs.map((e) => `${e.ruleId}:${e.eventKey}`)).size).toBe(execs.length);
  });

  it('automation execution has exactly-once effects when delivered twice concurrently (stalled-job redelivery / duplicate enqueue)', async () => {
    const rule = await owner.post('/automations', { name: 'Task on hot', trigger: 'LEAD_CREATED', conditions: {}, actions: [{ type: 'CREATE_TASK', title: 'EXACTLY-ONCE task', assignee: 'OWNER' }] });
    expect(rule.status).toBe(201);
    const lead = await owner.post('/leads', { firstName: 'Once', email: `once-${uniq()}@x.com`, assignedToId: agent.userId });
    const ex = await ownerPrisma.automationExecution.findFirstOrThrow({ where: { ruleId: rule.body.data.id, entityId: lead.body.data.id } });
    expect(ex.status).toBe('SUCCESS');
    await ownerPrisma.automationExecution.update({ where: { id: ex.id }, data: { status: 'PENDING', finishedAt: null } });
    const before = await ownerPrisma.task.count({ where: { organizationId: owner.orgId!, title: 'EXACTLY-ONCE task', leadId: lead.body.data.id } });
    await Promise.all([executeAutomation(owner.orgId!, ex.id), executeAutomation(owner.orgId!, ex.id), executeAutomation(owner.orgId!, ex.id)]);
    const after = await ownerPrisma.task.count({ where: { organizationId: owner.orgId!, title: 'EXACTLY-ONCE task', leadId: lead.body.data.id } });
    expect(after - before).toBe(1);
  });
});

describe('BullMQ worker: retries, backoff, duplicates, graceful drain', () => {
  const connection = () => redisConnection();
  const mkWorker = (processor: (name: string, data: Record<string, unknown>) => Promise<void>, opts: { concurrency?: number } = {}) =>
    new Worker(QUEUE_NAME, async (job) => processor(job.name, job.data), { connection: connection(), concurrency: opts.concurrency ?? 2, stalledInterval: 1000, lockDuration: 1500 });
  const until = async (fn: () => Promise<boolean>, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('condition not met in time'); };

  it('retries a failing job with backoff until it succeeds', async () => {
    const attempts: number[] = []; const id = `retry-${uniq()}`;
    const w = mkWorker(async (_n, d) => { if (d.id !== id) return; attempts.push(Date.now()); if (attempts.length < 3) throw new Error('transient'); });
    try {
      await getQueue().add('email.send', { id }, { jobId: id });
      await until(async () => (await getQueue().getJob(id))?.finishedOn !== undefined);
      const job = (await getQueue().getJob(id))!;
      expect(attempts).toHaveLength(3);
      expect(await job.isCompleted()).toBe(true);
      expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(90);        // backoff 100 ms
      expect(attempts[2]! - attempts[1]!).toBeGreaterThanOrEqual(180);       // exponential: 200 ms
    } finally { await w.close(); }
  });

  it('gives up after the configured attempts, keeps the job in the failed set and reports it', async () => {
    const id = `dead-${uniq()}`; let runs = 0;
    const reported: unknown[] = [];
    setErrorReporter((e) => { reported.push(e); });
    const w = mkWorker(async (_n, d) => { if (d.id === id) { runs++; throw new Error('permanent failure'); } });
    w.on('failed', (job, err) => { if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) (async () => { const { reportError } = await import('../src/lib/error-report'); reportError(err, `job:${job.name}`, { jobId: job.id }); })(); });
    try {
      await getQueue().add('email.send', { id }, { jobId: id });
      await until(async () => (await getQueue().getJob(id))?.failedReason !== undefined && ((await getQueue().getJob(id))?.attemptsMade ?? 0) >= JOB_ATTEMPTS);
      expect(runs).toBe(JOB_ATTEMPTS);
      const failed = await getQueue().getFailed(0, 50);
      expect(failed.some((j) => j.id === id)).toBe(true);
      await until(async () => reported.length > 0);
    } finally { clearErrorReporters(); await w.close(); }
  });

  it('duplicate enqueue with the same job id is processed once', async () => {
    const id = `dup-${uniq()}`; let runs = 0;
    const w = mkWorker(async (_n, d) => { if (d.id === id) runs++; });
    try {
      await Promise.all([1, 2, 3, 4].map(() => getQueue().add('email.send', { id }, { jobId: id })));
      await until(async () => runs >= 1);
      await new Promise((r) => setTimeout(r, 400));
      expect(runs).toBe(1);
    } finally { await w.close(); }
  });

  it('graceful close waits for the in-flight job instead of dropping it', async () => {
    const id = `drain-${uniq()}`; let started = false, finished = false;
    const w = mkWorker(async (_n, d) => { if (d.id !== id) return; started = true; await new Promise((r) => setTimeout(r, 700)); finished = true; });
    await getQueue().add('email.send', { id }, { jobId: id });
    await until(async () => started);
    await w.close();                       // what SIGTERM triggers
    expect(finished).toBe(true);
    expect(await (await getQueue().getJob(id))!.isCompleted()).toBe(true);
  });

  it('a job whose worker died is detected as stalled and processed by another worker', async () => {
    const id = `stall-${uniq()}`; const seen: string[] = [];
    const dying = new Worker(QUEUE_NAME, async (job) => { if (job.data.id === id) { seen.push('first'); await new Promise((r) => setTimeout(r, 60_000)); } }, { connection: connection(), stalledInterval: 500, lockDuration: 600, maxStalledCount: 2 });
    await getQueue().add('email.send', { id }, { jobId: id });
    await until(async () => seen.length === 1);
    // simulate a crash: stop lock renewal without finishing the job (no graceful close)
    const internal = dying as unknown as { stalledCheckTimer?: NodeJS.Timeout; lockManager?: { close: () => void }; closing?: Promise<void> };
    internal.lockManager?.close();
    const rescuer = mkWorker(async (_n, d) => { if (d.id === id) seen.push('rescued'); });
    try {
      await until(async () => seen.includes('rescued'), 20000);
      expect(seen).toEqual(['first', 'rescued']);
    } finally { await rescuer.close(); await dying.close(true).catch(() => undefined); }
  });
});

describe('email outbox: honest delivery states', () => {
  const tokenOf = (body: { data: { devVerificationLink: string } }) => new URL(body.data.devVerificationLink).searchParams.get('token');
  const register = async () => { const email = `mail-${uniq()}@example.com`; const r = await request(createApp({ rateLimit: false })).post('/api/auth/register').send({ name: 'Mail T', email, password: PASSWORD }); expect(r.status).toBe(201); return { email, r }; };
  const rowFor = (email: string) => ownerPrisma.outboundEmail.findFirstOrThrow({ where: { toEmail: email }, orderBy: { createdAt: 'desc' } });

  it('dev provider: the mailbox row is SENT with provider "dev"', async () => {
    const { email, r } = await register();
    expect(tokenOf(r.body)).toBeTruthy();
    const row = await rowFor(email);
    expect(row.status).toBe('SENT'); expect(row.provider).toBe('dev'); expect(row.link).toContain('verify-email');
  });

  it('no provider configured: marked UNDELIVERABLE — never SENT', async () => {
    setEmailProvider({ name: 'none', send: async () => { const { EmailNotConfiguredError } = await import('../src/lib/email'); throw new EmailNotConfiguredError(); } });
    try {
      const { email } = await register();
      const row = await rowFor(email);
      expect(row.status).toBe('UNDELIVERABLE'); expect(row.sentAt).toBeNull(); expect(row.lastError).toMatch(/No email provider/);
    } finally { setEmailProvider(null); }
  });

  it('provider outage: FAILED with the error, retried by the sweeper, then SENT; real providers get the link scrubbed afterwards', async () => {
    let up = false; const sent: string[] = [];
    const smtpLike: EmailProvider = { name: 'smtp', send: async (m) => { if (!up) throw new Error('ECONNREFUSED smtp'); sent.push(m.text); return { messageId: '<abc@mail>' }; } };
    setEmailProvider(smtpLike);
    try {
      const { email } = await register();
      let row = await rowFor(email);
      expect(row.status).toBe('FAILED'); expect(row.attempts).toBe(1); expect(row.lastError).toMatch(/ECONNREFUSED/);
      up = true;
      expect(await sweepEmailOutbox(new Date(Date.now() + 3 * 60_000))).toBeGreaterThan(0);
      await deliverEmail(row.id).catch(() => undefined); // sweeper enqueues inline in tests; idempotent if already sent
      row = await rowFor(email);
      expect(row.status).toBe('SENT'); expect(row.messageId).toBe('<abc@mail>');
      expect(sent.join('\n')).toContain('verify-email?token=');   // the provider received the link
      expect(row.link).toBeNull(); expect(row.body).toBe('[delivered]'); // …but it is not kept at rest
    } finally { setEmailProvider(null); }
  });
});

describe('tenant isolation under concurrent load across two API instances', () => {
  it('interleaved reads and writes of different workspaces never mix data', async () => {
    const appA = createApp({ rateLimit: false }), appB = createApp({ rateLimit: false });
    const mkOrg = async (label: string) => { const o = await createWorkspace(await signUp(`${label} Owner`), `${label} ${uniq()}`); return o; };
    const [o1, o2] = await Promise.all([mkOrg('Iso1'), mkOrg('Iso2')]);
    const as = (o: Actor, app: ReturnType<typeof createApp>) => ({ post: (u: string, b: object) => request(app).post(`/api${u}`).set('Cookie', cookieOf(o)).set('X-Org-Id', o.orgId!).send(b), get: (u: string) => request(app).get(`/api${u}`).set('Cookie', cookieOf(o)).set('X-Org-Id', o.orgId!) });
    function cookieOf(o: Actor) { return ((o.agent as unknown as { jar: { getCookies: (a: object) => Array<{ name: string; value: string }> } }).jar.getCookies({ domain: '127.0.0.1', path: '/api', secure: false, script: false }) ?? []).map((c) => `${c.name}=${c.value}`).join('; '); }
    const N = 25;
    await Promise.all(Array.from({ length: N * 2 }, (_, i) => { const mine = i % 2 === 0 ? o1 : o2; return as(mine, i % 4 < 2 ? appA : appB).post('/leads', { firstName: `${i % 2 === 0 ? 'ONE' : 'TWO'}-${i}`, email: `iso-${uniq()}-${i}@x.com` }); }));
    const [l1, l2] = await Promise.all([as(o1, appB).get('/leads?pageSize=100'), as(o2, appA).get('/leads?pageSize=100')]);
    expect(l1.status).toBe(200); expect(l2.status).toBe(200);
    expect(l1.body.data).toHaveLength(N); expect(l2.body.data).toHaveLength(N);
    expect(l1.body.data.every((l: { firstName: string }) => l.firstName.startsWith('ONE'))).toBe(true);
    expect(l2.body.data.every((l: { firstName: string }) => l.firstName.startsWith('TWO'))).toBe(true);
    // a burst of mixed reads on both instances: each response must only ever contain its own workspace
    const burst = await Promise.all(Array.from({ length: 60 }, (_, i) => { const mine = i % 2 ? o1 : o2; return as(mine, i % 3 ? appA : appB).get('/leads?pageSize=100').then((r) => ({ r, tag: i % 2 ? 'ONE' : 'TWO' })); }));
    for (const { r, tag } of burst) { expect(r.status).toBe(200); expect(r.body.data.every((l: { firstName: string }) => l.firstName.startsWith(tag))).toBe(true); }
    // connection-pool pressure: 120 concurrent requests all succeed
    const flood = await Promise.all(Array.from({ length: 120 }, (_, i) => as(i % 2 ? o1 : o2, appA).get('/leads?pageSize=5')));
    expect(flood.every((r) => r.status === 200)).toBe(true);
  });
});

describe('single-use tokens and database roles under concurrency', () => {
  it('a password-reset token can be redeemed exactly once even when redeemed concurrently', async () => {
    const owner = await signUp('Reset Race');
    const f = await request(createApp({ rateLimit: false })).post('/api/auth/forgot-password').send({ email: owner.email });
    const token = new URL(f.body.data.devResetLink).searchParams.get('token');
    const res = await Promise.all(Array.from({ length: 6 }, (_, i) => request(createApp({ rateLimit: false })).post('/api/auth/reset-password').send({ token, password: `NewPassw0rd${i}!` })));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(res.filter((r) => r.status === 400)).toHaveLength(5);
  });
  it('requesting a new reset / verification link invalidates the previous one', async () => {
    const owner = await signUp('Reset Twice');
    const a = await request(createApp({ rateLimit: false })).post('/api/auth/forgot-password').send({ email: owner.email });
    const b = await request(createApp({ rateLimit: false })).post('/api/auth/forgot-password').send({ email: owner.email });
    const tok = (r: { body: { data: { devResetLink: string } } }) => new URL(r.body.data.devResetLink).searchParams.get('token');
    expect((await request(createApp({ rateLimit: false })).post('/api/auth/reset-password').send({ token: tok(a), password: 'BrandNew1234!' })).status).toBe(400);
    expect((await request(createApp({ rateLimit: false })).post('/api/auth/reset-password').send({ token: tok(b), password: 'BrandNew1234!' })).status).toBe(200);
  });
  it('an invitation can be accepted exactly once under concurrency', async () => {
    const o = await createWorkspace(await signUp('Inv Owner'), `Inv ${uniq()}`);
    const roles = (await o.get('/roles')).body.data as Array<{ id: string; systemKey: string }>;
    const email = `inv-${uniq()}@example.com`;
    const inv = await o.post('/invitations', { email, roleId: roles.find((r) => r.systemKey === 'VIEWER')!.id });
    const token = new URL(inv.body.data.devInviteLink).searchParams.get('token');
    const user = await signUp('Invitee', email);
    const res = await Promise.all(Array.from({ length: 5 }, () => user.agent.post('/api/auth/invitation/accept').send({ token })));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await ownerPrisma.membership.count({ where: { organizationId: o.orgId!, userId: user.userId } })).toBe(1);
  });
  it('startup role probe: the runtime role is least-privilege, the owner role is flagged unsafe', async () => {
    const { probeRole, roleProblems } = await import('../src/lib/health');
    const { prisma, platformPrisma } = await import('../src/db');
    expect(roleProblems(await probeRole(prisma), await probeRole(platformPrisma))).toEqual([]);
    const ownerProbe = await probeRole(ownerPrisma as unknown as Parameters<typeof probeRole>[0]);
    expect(roleProblems(ownerProbe, await probeRole(platformPrisma)).join(' ')).toMatch(/superuser|BYPASSRLS/);
  });
});

describe('lost-job recovery', () => {
  it('the scheduler re-queues automation executions that stayed PENDING (e.g. Redis was flushed) and they complete exactly once', async () => {
    const owner = await createWorkspace(await signUp('Stuck Owner'), `Stuck ${uniq()}`);
    const agent = await addMember(owner, 'SALES_AGENT');
    const rule = await owner.post('/automations', { name: 'Stuck task', trigger: 'LEAD_CREATED', conditions: {}, actions: [{ type: 'CREATE_TASK', title: 'RECOVERED task', assignee: 'OWNER' }] });
    const lead = await owner.post('/leads', { firstName: 'Stuck', email: `stuck-${uniq()}@x.com`, assignedToId: agent.userId });
    const ex = await ownerPrisma.automationExecution.findFirstOrThrow({ where: { ruleId: rule.body.data.id, entityId: lead.body.data.id } });
    // simulate: the job was lost before it ran (status PENDING, old, no side effects)
    await ownerPrisma.task.deleteMany({ where: { organizationId: owner.orgId!, title: 'RECOVERED task' } });
    await ownerPrisma.automationExecution.update({ where: { id: ex.id }, data: { status: 'PENDING', finishedAt: null, createdAt: new Date(Date.now() - 10 * 60_000) } });
    await runSchedulerTick(new Date());
    await runSchedulerTick(new Date());
    expect((await ownerPrisma.automationExecution.findUniqueOrThrow({ where: { id: ex.id } })).status).toBe('SUCCESS');
    expect(await ownerPrisma.task.count({ where: { organizationId: owner.orgId!, title: 'RECOVERED task', leadId: lead.body.data.id } })).toBe(1);
  });
});

describe('result cache for very large workspaces', () => {
  it('is off for normal workspaces (always exact) and on for large ones (scoped, short-lived, falls back when Redis fails)', async () => {
    const { config } = await import('../src/config');
    const { resetCacheMemo } = await import('../src/lib/cache');
    const owner = await createWorkspace(await signUp('Cache Owner'), `Cache ${uniq()}`);
    const agent = await addMember(owner, 'SALES_AGENT');
    await owner.post('/leads', { firstName: 'C1', email: `c1-${uniq()}@x.com` });
    // normal workspace: exact immediately
    expect((await owner.get('/leads')).body.meta.total).toBe(1);
    await owner.post('/leads', { firstName: 'C2', email: `c2-${uniq()}@x.com` });
    expect((await owner.get('/leads')).body.meta.total).toBe(2);
    // mark the workspace as large through its usage snapshot
    const original = config.largeWorkspaceLeads;
    (config as { largeWorkspaceLeads: number }).largeWorkspaceLeads = 2;
    await ownerPrisma.usageRecord.upsert({ where: { organizationId_day: { organizationId: owner.orgId!, day: new Date(Date.UTC(2026, 0, 1)) } }, create: { organizationId: owner.orgId!, day: new Date(Date.UTC(2026, 0, 1)), leads: 5, seats: 1, opportunities: 0, followUps: 0 }, update: {} });
    resetCacheMemo();
    try {
      expect((await owner.get('/leads')).body.meta.total).toBe(2);                  // computed and cached
      await owner.post('/leads', { firstName: 'C3', email: `c3-${uniq()}@x.com` });
      expect((await owner.get('/leads')).body.meta.total).toBe(3);                 // a committed lead change invalidates the cached total at once (lead-data version)
      // the cache itself is active: a change made behind the application's back (no version bump) stays invisible until the TTL …
      await ownerPrisma.lead.create({ data: { organizationId: owner.orgId!, firstName: 'Sneaky', email: 'sneaky@x.com', emailNormalized: 'sneaky@x.com' } });
      const cached = await owner.get('/leads');
      expect(cached.body.meta.total).toBe(3);                                      // served from cache …
      expect(cached.body.data).toHaveLength(4);                                    // … while the rows are live
      // scopes never share entries: an agent (own leads only) has her own total
      expect((await agent.get('/leads')).body.meta.total).toBe(0);
      // dashboards and reports are cached per scope too, and keep working when Redis is unavailable
      const d1 = await owner.get('/dashboard'); expect(d1.status).toBe(200);
      const spy = vi.spyOn(getRedis(), 'get').mockRejectedValue(new Error('redis down'));
      try { expect((await owner.get('/leads')).body.meta.total).toBe(4); expect((await owner.get('/dashboard')).status).toBe(200); } finally { spy.mockRestore(); }
      // after the TTL the number is exact again
      const keys = await getRedis().keys(`cache:${owner.orgId}:*`); expect(keys.length).toBeGreaterThan(0);
      await getRedis().del(...keys);
      expect((await owner.get('/leads')).body.meta.total).toBe(4);
    } finally {
      (config as { largeWorkspaceLeads: number }).largeWorkspaceLeads = original;
      resetCacheMemo();
      const keys = await getRedis().keys(`cache:${owner.orgId}:*`); if (keys.length) await getRedis().del(...keys);
    }
  });
});
