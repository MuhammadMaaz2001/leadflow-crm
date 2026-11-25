/**
 * Lead-search latency benchmark through the real HTTP API (authenticated manager, row level security active).
 *   LOAD_API_URL=http://localhost:4000 npx tsx src/scripts/loadtest/search-bench.ts --label l250k --tag before [--samples 15]
 * For every term it records latency percentiles and the number of matches; results go to loadtest-results/search-bench-<label>-<tag>.json.
 * Terms cover the cases that behave differently: selective, common, short, multi-term, e-mail fragment, phone digits and "no match" (worst case).
 */
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { PrismaClient } from '@leadflow/database';

loadEnv({ path: path.resolve(__dirname, '../../../../../.env') });
const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1]! : d; };
const LABEL = arg('label', 'l30k'), TAG = arg('tag', 'run'), SAMPLES = Number(arg('samples', '15')), API = process.env.LOAD_API_URL ?? 'http://localhost:4000';
const root = path.resolve(__dirname, '../../../../../loadtest-results');
const ds = JSON.parse(fs.readFileSync(path.join(root, `dataset-${LABEL}.json`), 'utf8')) as { orgId: string; managerEmail: string; password: string };
const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

async function main() {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ds.managerEmail, password: ds.password }) });
  if (r.status !== 200) throw new Error(`login failed ${r.status}`);
  const cookie = r.headers.getSetCookie()[0]!.split(';')[0]!;
  // a rare-but-existing term: the local part of one concrete e-mail address, and a phone number fragment
  const [one] = await owner.$queryRawUnsafe<Array<{ email: string; phone: string | null }>>(`SELECT email, phone FROM leads WHERE organization_id = '${ds.orgId}' AND email IS NOT NULL AND phone IS NOT NULL ORDER BY created_at OFFSET 4321 LIMIT 1`);
  const phoneDigits = (one?.phone ?? '').replace(/\D/g, '').slice(-7);
  const terms: Array<[string, string]> = [
    ['rare existing (full e-mail)', one!.email], ['rare existing (e-mail local part)', one!.email.split('@')[0]!], ['no match (worst case)', 'zzqxkv'], ['common surname', 'smith'], ['common first name', 'olivia'],
    ['two common terms', 'olivia smith'], ['company fragment', 'acme 12'], ['e-mail domain fragment', '@acme1'], ['phone digits', phoneDigits], ['2 characters', 'li'],
  ];
  const results: Array<Record<string, unknown>> = [];
  for (const [name, q] of terms) {
    const url = `${API}/api/leads?q=${encodeURIComponent(q)}&pageSize=25`;
    const call = async () => { const t = process.hrtime.bigint(); const res = await fetch(url, { headers: { cookie, 'x-org-id': ds.orgId } }); const j = await res.json() as { meta?: { total: number }; error?: unknown }; if (res.status !== 200) throw new Error(`${res.status} ${JSON.stringify(j)}`); return { ms: Number(process.hrtime.bigint() - t) / 1e6, total: j.meta!.total }; };
    for (let i = 0; i < 3; i++) await call();                                                     // warm-up (plans, caches)
    const ms: number[] = []; let total = 0;
    for (let i = 0; i < SAMPLES; i++) { const x = await call(); ms.push(x.ms); total = x.total; }
    ms.sort((a, b) => a - b);
    const p = (f: number) => Math.round(ms[Math.min(ms.length - 1, Math.floor(f * ms.length))]! * 10) / 10;
    results.push({ name, q, matches: total, p50: p(0.5), p95: p(0.95), max: Math.round(ms[ms.length - 1]! * 10) / 10 });
    console.log(`${name.padEnd(36)} q=${q.slice(0, 28).padEnd(28)} matches=${String(total).padStart(7)}  p50=${String(p(0.5)).padStart(8)} ms  p95=${String(p(0.95)).padStart(8)} ms`);
  }
  fs.writeFileSync(path.join(root, `search-bench-${LABEL}-${TAG}.json`), JSON.stringify({ label: LABEL, tag: TAG, samples: SAMPLES, at: new Date().toISOString(), results }, null, 2));
  await owner.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
