/**
 * Load-test runner (autocannon). Requires a running API + the dataset created by seed.ts.
 *   LOAD_API_URL=http://localhost:4100 npx tsx src/scripts/loadtest/run.ts --label l30k [--duration 15] [--only leads-list,dashboard]
 * Output: a table on stdout and loadtest-results/results-<label>.json. Results depend entirely on the machine they run on
 * (see PRODUCTION_READINESS.md for the hardware used); they are measurements, not promises.
 */
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import autocannon from 'autocannon';
import { PrismaClient } from '@leadflow/database';

loadEnv({ path: path.resolve(__dirname, '../../../../../.env') });
const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1]! : d; };
const TAG = arg('tag', ''), LABEL = arg('label', 'l30k'), DURATION = Number(arg('duration', '15')), ONLY = arg('only', '').split(',').filter(Boolean);
const API = process.env.LOAD_API_URL ?? 'http://localhost:4100';
const ds = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../../../loadtest-results/dataset-${LABEL}.json`), 'utf8')) as { orgId: string; ownerEmail: string; managerEmail: string; agentEmails: string[]; password: string; counts: Record<string, number> };

async function login(email: string): Promise<string> {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: ds.password }) });
  if (r.status !== 200) throw new Error(`login ${email} -> ${r.status}`);
  return r.headers.getSetCookie()[0]!.split(';')[0]!;
}
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)]!;
const TERMS = ['smith', 'garcia', 'acme 12', 'olivia', 'khan', 'globex', 'patel', 'liam.lee', 'initech 4', '@acme1', '1202555'];

interface Scenario { name: string; who: 'manager' | 'agents' | 'mixed'; connections?: number; build: (ctx: Ctx) => autocannon.Request[]; duration?: number }
interface Ctx { leadIds: string[]; agentIds: string[]; stageIds: string[]; byCookie: Map<string, string[]> }

const SCENARIOS: Scenario[] = [
  { name: 'auth-login', who: 'mixed', connections: 10, build: () => [] },    // special-cased below
  { name: 'leads-list', who: 'mixed', build: () => [{ method: 'GET', path: '/api/leads?pageSize=25' }] },
  { name: 'leads-list-deep-page', who: 'manager', build: () => [{ method: 'GET', path: `/api/leads?pageSize=25&page=${Math.max(2, Math.floor(ds.counts.leads / 25 / 2))}` }] },
  { name: 'leads-search', who: 'mixed', build: () => TERMS.map((t) => ({ method: 'GET', path: `/api/leads?q=${encodeURIComponent(t)}&pageSize=25` })) },
  { name: 'leads-filter-sort', who: 'mixed', build: () => [{ method: 'GET', path: '/api/leads?status=QUALIFIED&sort=lastActivityAt&order=desc&pageSize=25' }, { method: 'GET', path: '/api/leads?uncontacted=true&sort=createdAt&order=asc&pageSize=25' }, { method: 'GET', path: '/api/leads?hasOverdueFollowUp=true&pageSize=25' }] },
  { name: 'lead-detail', who: 'manager', build: (c) => c.leadIds.slice(0, 50).map((id) => ({ method: 'GET', path: `/api/leads/${id}` })) },
  { name: 'lead-create', who: 'agents', build: () => [{ method: 'POST', path: '/api/leads', headers: { 'content-type': 'application/json' }, setupRequest: (req: autocannon.Request) => { const n = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; req.body = JSON.stringify({ firstName: 'Load', lastName: `Test${n}`, email: `load.${n}@loadgen.test`, phone: `+1 ${Math.floor(200 + Math.random() * 700)} ${Math.floor(200 + Math.random() * 700)} ${Math.floor(1000 + Math.random() * 8999)}`, companyName: 'Loadgen Inc' }); return req; } } as autocannon.Request] },
  { name: 'lead-assign', who: 'manager', build: (c) => [{ method: 'POST', path: '/api/leads/:id/assign', headers: { 'content-type': 'application/json' }, setupRequest: (req: autocannon.Request) => { req.path = `/api/leads/${pick(c.leadIds)}/assign`; req.body = JSON.stringify({ assignedToId: pick(c.agentIds) }); return req; } } as autocannon.Request] },
  { name: 'pipeline-board', who: 'mixed', build: () => [{ method: 'GET', path: '/api/opportunities/board' }] },
  { name: 'dashboard', who: 'mixed', build: () => [{ method: 'GET', path: '/api/dashboard' }, { method: 'GET', path: '/api/dashboard?range=last_30_days' }] },
  { name: 'reports', who: 'manager', build: () => ['lead-generation', 'lead-source', 'pipeline', 'conversion', 'salesperson', 'lead-aging', 'follow-up'].map((k) => ({ method: 'GET', path: `/api/reports/${k}` })) },
  { name: 'notifications', who: 'mixed', build: () => [{ method: 'GET', path: '/api/notifications?pageSize=20' }, { method: 'GET', path: '/api/notifications/unread-count' }] },
  { name: 'followups-tasks', who: 'mixed', build: () => [{ method: 'GET', path: '/api/followups?view=today' }, { method: 'GET', path: '/api/followups/summary' }, { method: 'GET', path: '/api/tasks?scope=mine' }] },
  { name: 'MIXED-100-users', who: 'mixed', connections: 100, duration: 30, build: (c) => [
    ...Array(8).fill({ method: 'GET', path: '/api/leads?pageSize=25' }), ...TERMS.slice(0, 4).map((t) => ({ method: 'GET', path: `/api/leads?q=${encodeURIComponent(t)}&pageSize=25` })),
    { method: 'GET', path: '/api/dashboard' }, { method: 'GET', path: '/api/opportunities/board' }, { method: 'GET', path: '/api/notifications/unread-count' }, { method: 'GET', path: '/api/notifications/unread-count' },
    { method: 'GET', path: '/api/followups?view=today' }, ...Array(6).fill({ method: 'GET', path: '/api/leads/x', setupRequest: (req: autocannon.Request, cx: Record<string, unknown>) => { req.path = `/api/leads/${pick(c.byCookie.get(cx.cookie as string) ?? c.leadIds)}`; return req; } }),
    { method: 'POST', path: '/api/leads', headers: { 'content-type': 'application/json' }, setupRequest: (req: autocannon.Request) => { const n = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; req.body = JSON.stringify({ firstName: 'Mix', lastName: n, email: `mix.${n}@loadgen.test` }); return req; } } as autocannon.Request,
  ] },
];

(async () => {
  const sys = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const ids = async (sql: string) => (await sys.$queryRawUnsafe<Array<{ id: string }>>(sql)).map((r) => r.id);
  const ctx: Ctx = {
    leadIds: await ids(`SELECT id FROM leads WHERE organization_id = '${ds.orgId}' AND assigned_to_id IS NOT NULL ORDER BY random() LIMIT 400`),
    agentIds: await ids(`SELECT u.id FROM users u WHERE u.email LIKE 'agent%-${LABEL}@load.test'`), stageIds: [], byCookie: new Map(),
  };
  const cookies = { manager: [await login(ds.managerEmail)], agents: await Promise.all(ds.agentEmails.slice(0, 10).map(login)) };
  const all = [...cookies.manager, ...cookies.agents];
  // agents can only open their own leads (anything else is a correct 404), so each virtual user gets ids it may read
  cookies.agents.forEach((ck, i) => { void ids(`SELECT l.id FROM leads l JOIN users u ON u.id = l.assigned_to_id WHERE l.organization_id = '${ds.orgId}' AND u.email = '${ds.agentEmails[i]}' LIMIT 30`).then((v) => ctx.byCookie.set(ck, v)); });
  ctx.byCookie.set(cookies.manager[0]!, ctx.leadIds);
  await new Promise((r) => setTimeout(r, 1500));
  const out: Array<Record<string, unknown>> = [];
  for (const s of SCENARIOS) {
    if (ONLY.length && !ONLY.includes(s.name)) continue;
    const jar = s.who === 'manager' ? cookies.manager : s.who === 'agents' ? cookies.agents : all;
    const conns = Number(arg('connections', '0')) || (s.connections ?? 20);
    const base: autocannon.Options = { url: API, connections: conns, duration: s.duration ?? DURATION, timeout: 30, headers: { 'x-org-id': ds.orgId } };
    let r: autocannon.Result;
    if (s.name === 'auth-login') {
      const emails = [ds.managerEmail, ...ds.agentEmails];
      r = await autocannon({ ...base, headers: { 'content-type': 'application/json' }, requests: [{ method: 'POST', path: '/api/auth/login', setupRequest: (req: autocannon.Request) => { req.body = JSON.stringify({ email: pick(emails), password: ds.password }); return req; } } as autocannon.Request] });
    } else {
      // every request carries the cookie of "its" virtual user (assigned per connection through the per-client context)
      let n = 0;
      const withAuth = (rq: autocannon.Request): autocannon.Request => {
        const inner = (rq as { setupRequest?: (r: autocannon.Request, c: Record<string, unknown>) => autocannon.Request }).setupRequest;
        return { ...rq, setupRequest: (req: autocannon.Request, c: Record<string, unknown>) => { c.cookie ??= jar[n++ % jar.length]; const r2 = inner ? inner(req, c) : req; r2.headers = { ...(r2.headers ?? {}), cookie: c.cookie as string, 'x-org-id': ds.orgId, 'content-type': 'application/json' }; return r2; } } as autocannon.Request;
      };
      r = await autocannon({ ...base, requests: s.build(ctx).map(withAuth) });
    }
    const ok = r['2xx'], total = r.requests.total;
    const row = { scenario: s.name, connections: conns, durationS: r.duration, reqPerSec: Math.round(r.requests.average), p50: r.latency.p50, p90: r.latency.p90, p97_5: r.latency.p97_5, p99: r.latency.p99, max: r.latency.max, total, ok2xx: ok, non2xx: r.non2xx, errors: r.errors, timeouts: r.timeouts, statuses: Object.fromEntries(Object.entries(r.statusCodeStats ?? {}).map(([k, v]) => [k, (v as { count: number }).count])), errorRatePct: +(((total - ok) + r.errors) / Math.max(1, total + r.errors) * 100).toFixed(2) };
    out.push(row);
    console.log(`${s.name.padEnd(22)} ${String(conns).padStart(3)}c  ${String(row.reqPerSec).padStart(6)} req/s  p50 ${String(row.p50).padStart(5)}  p90 ${String(row.p90).padStart(5)}  p99 ${String(row.p99).padStart(5)} ms  max ${String(row.max).padStart(6)}  err ${row.errorRatePct}% (non2xx ${row.non2xx}, errors ${row.errors}, timeouts ${row.timeouts}) ${row.non2xx ? JSON.stringify(row.statuses) : ""}`);
  }
  fs.writeFileSync(path.resolve(__dirname, `../../../../../loadtest-results/results-${LABEL}${TAG ? `-${TAG}` : ONLY.length ? '-partial' : ''}.json`), JSON.stringify({ label: LABEL, counts: ds.counts, when: new Date().toISOString(), api: API, rows: out }, null, 2));
  await sys.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
