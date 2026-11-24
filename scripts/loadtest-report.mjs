// Renders loadtest-results/*.json as Markdown tables (used to build PRODUCTION_READINESS.md so numbers are never retyped).
import fs from 'node:fs';
import path from 'node:path';
const dir = path.resolve(import.meta.dirname, '../loadtest-results');
const read = (f) => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : null);
const row = (r) => r && `${r.reqPerSec} | ${r.p50} / ${r.p90} / ${r.p99} | ${r.errorRatePct}%`;
const sizes = [['l30k', '30k'], ['l100k', '100k'], ['l250k', '250k']];
const out = [];
const base = Object.fromEntries(sizes.map(([k]) => [k, read(`results-${k}.json`)]));
const cached = Object.fromEntries(sizes.map(([k]) => [k, read(`results-${k}-cached.json`)]));
const names = base.l30k.rows.map((r) => r.scenario);
out.push('| Scenario (20 connections unless noted) | ' + sizes.map(([, l]) => `${l} leads: req/s · p50/p90/p99 ms · errors`).join(' | ') + ' |', '|---|' + sizes.map(() => '---|').join(''));
for (const n of names) out.push(`| ${n} | ` + sizes.map(([k]) => { const r = base[k]?.rows.find((x) => x.scenario === n); return r ? `${r.reqPerSec} · ${r.p50}/${r.p90}/${r.p99} · ${r.errorRatePct}%` : '–'; }).join(' | ') + ' |');
out.push('', '**After the large-workspace result cache** (same dataset and machine; scenarios it affects):', '', '| Scenario | 100k before → after (req/s · p50 ms) | 250k before → after (req/s · p50 ms) |', '|---|---|---|');
for (const n of ['leads-list', 'leads-list-deep-page', 'leads-search', 'leads-filter-sort', 'dashboard', 'reports', 'MIXED-100-users']) {
  const f = (k) => { const b = base[k]?.rows.find((x) => x.scenario === n), a = cached[k]?.rows.find((x) => x.scenario === n); return b && a ? `${b.reqPerSec} · ${b.p50} → **${a.reqPerSec} · ${a.p50}**` : '–'; };
  out.push(`| ${n} | ${f('l100k')} | ${f('l250k')} |`);
}
const a = read('results-l250k-two-a.json')?.rows[0], b = read('results-l250k-two-b.json')?.rows[0], one = cached.l250k?.rows.find((x) => x.scenario === 'MIXED-100-users');
if (a && b && one) out.push('', `**Two API instances** (250k leads, 100 virtual users split 50/50, same database and Redis): ${a.reqPerSec} + ${b.reqPerSec} = **${a.reqPerSec + b.reqPerSec} req/s** (p50 ${a.p50}/${b.p50} ms, p99 ${a.p99}/${b.p99} ms, errors ${a.errorRatePct}%/${b.errorRatePct}%) versus **${one.reqPerSec} req/s** with one instance and 100 users (p50 ${one.p50} ms, p99 ${one.p99} ms).`);
out.push('', '**Dataset sizes:** ' + sizes.map(([k, l]) => { const d = read(`dataset-${k}.json`); return d ? `${l}: ${Object.entries(d.counts).map(([x, v]) => `${v.toLocaleString('en')} ${x.replace('_', ' ')}`).join(', ')}` : ''; }).join(' · '));
out.push('', '### Statement timings (EXPLAIN ANALYZE as `leadflow_app` under row level security, warm cache, single execution)', '', '| Statement | 30k | 100k | 250k | Plan (250k) |', '|---|---|---|---|---|');
const ex = Object.fromEntries(sizes.map(([k]) => [k, read(`explain-${k}.json`)]));
for (const q of ex.l250k) out.push(`| ${q.q} | ${['l30k', 'l100k', 'l250k'].map((k) => `${ex[k]?.find((x) => x.q === q.q)?.ms ?? '–'} ms`).join(' | ')} | ${q.plan.replace(/\(actual.*$/, '').replace(/\|/g, '/').slice(0, 70)} |`);
console.log(out.join('\n'));
