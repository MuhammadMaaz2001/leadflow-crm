import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalDiskStorage, setObjectStorage } from '../src/lib/storage';
import { boot, createWorkspace, ownerPrisma, signUp, uniq } from './helpers';

/** Opt-in benchmark (IMPORT_BENCH_ROWS=100000 npx vitest run test/import-bench.test.ts): imports N synthetic rows end to end and prints throughput and memory. */
const N = Number(process.env.IMPORT_BENCH_ROWS ?? 0);
describe.skipIf(!N)('import benchmark', () => {
  it(`imports ${N} rows`, async () => {
    await boot();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-bench-')); setObjectStorage(new LocalDiskStorage(dir));
    const owner = await createWorkspace(await signUp('Bench Owner'), `Bench ${uniq()}`);
    const plan = await ownerPrisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'professional' } });
    await ownerPrisma.subscriptionPlan.update({ where: { id: plan.id }, data: { maxLeads: 2_000_000 } });
    try {
      const rows = ['First Name,Last Name,Email,Phone,Company,Source,Tags'];
      for (let i = 0; i < N; i++) rows.push(`Pat${i},Lee,bench${i}@bulk.test,,Acme ${i % 50},Website,bulk`);
      const buf = Buffer.from(rows.join('\n'));
      const t0 = Date.now(); const rss0 = process.memoryUsage().rss; let peak = rss0;
      const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 200);
      const an = process.env.IMPORT_BENCH_ANALYZE ? setInterval(() => { void ownerPrisma.$executeRawUnsafe('ANALYZE leads; ANALYZE lead_tags; ANALYZE activities').catch(() => undefined); }, 2000) : null;
      const up = await owner.agent.post('/api/leads/import/jobs').set('X-Org-Id', owner.orgId!).attach('file', buf, { filename: 'bench.csv', contentType: 'text/csv' });
      expect(up.status, JSON.stringify(up.body).slice(0, 300)).toBe(201);
      const tUp = Date.now() - t0;
      await owner.post(`/leads/import/jobs/${up.body.data.id}/start`);
      clearInterval(timer); if (an) clearInterval(an);
      const j = (await owner.get(`/leads/import/jobs/${up.body.data.id}`)).body.data;
      const total = Date.now() - t0;
      expect(j).toMatchObject({ status: 'COMPLETED', createdRows: N });
      fs.appendFileSync(process.env.IMPORT_BENCH_OUT ?? '/tmp/import-bench.txt', `IMPORT_BENCH rows=${N} fileMB=${(buf.length / 1048576).toFixed(1)} upload+preview=${tUp}ms process=${total - tUp}ms total=${total}ms rate=${Math.round(N / ((total - tUp) / 1000))} rows/s peakRSS+${Math.round((peak - rss0) / 1048576)}MB\n`);
    } finally { await ownerPrisma.subscriptionPlan.update({ where: { id: plan.id }, data: { maxLeads: 25000 } }); setObjectStorage(null); fs.rmSync(dir, { recursive: true, force: true }); }
  }, 900_000);
});
