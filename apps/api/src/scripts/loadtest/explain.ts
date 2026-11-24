/**
 * EXPLAIN (ANALYZE, BUFFERS) for the statements that matter, executed AS the runtime role under row level security
 * for the load-test workspace:   npx tsx src/scripts/loadtest/explain.ts --label l100k
 */
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { PrismaClient } from '@leadflow/database';

loadEnv({ path: path.resolve(__dirname, '../../../../../.env') });
const LABEL = process.argv[process.argv.indexOf('--label') + 1] ?? 'l30k';
const root = path.resolve(__dirname, '../../../../../loadtest-results');
const ds = JSON.parse(fs.readFileSync(path.join(root, `dataset-${LABEL}.json`), 'utf8')) as { orgId: string };
const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

const Q: Array<[string, string]> = [
  ['leads list (page 1, newest first)', `SELECT * FROM leads WHERE organization_id = :org AND archived_at IS NULL AND merged_into_id IS NULL ORDER BY created_at DESC LIMIT 25`],
  ['leads list count(*)', `SELECT count(*) FROM leads WHERE organization_id = :org AND archived_at IS NULL AND merged_into_id IS NULL`],
  ['leads list, agent scope (own leads)', `SELECT * FROM leads WHERE organization_id = :org AND archived_at IS NULL AND merged_into_id IS NULL AND assigned_to_id = (SELECT assigned_to_id FROM leads WHERE organization_id = :org AND assigned_to_id IS NOT NULL LIMIT 1) ORDER BY created_at DESC LIMIT 25`],
  ['leads list, status filter + sort by last activity', `SELECT * FROM leads WHERE organization_id = :org AND archived_at IS NULL AND merged_into_id IS NULL AND status = 'QUALIFIED' ORDER BY last_activity_at DESC LIMIT 25`],
  ['leads search ILIKE %smith% (name/email/company/phone)', `SELECT * FROM leads WHERE organization_id = :org AND archived_at IS NULL AND merged_into_id IS NULL AND (first_name ILIKE '%smith%' OR last_name ILIKE '%smith%' OR email ILIKE '%smith%' OR company_name ILIKE '%smith%' OR phone ILIKE '%smith%') ORDER BY created_at DESC LIMIT 25`],
  ['leads search, rare term (worst case: scans the workspace)', `SELECT * FROM leads WHERE organization_id = :org AND archived_at IS NULL AND merged_into_id IS NULL AND (first_name ILIKE '%zzqx%' OR last_name ILIKE '%zzqx%' OR email ILIKE '%zzqx%' OR company_name ILIKE '%zzqx%' OR phone ILIKE '%zzqx%') ORDER BY created_at DESC LIMIT 25`],
  ['duplicate check by normalised e-mail (lead create)', `SELECT id FROM leads WHERE organization_id = :org AND email_normalized = 'olivia.smith1@acme1.test' AND archived_at IS NULL LIMIT 5`],
  ['plan limit: count of active leads (lead create)', `SELECT count(*) FROM leads WHERE organization_id = :org AND archived_at IS NULL AND merged_into_id IS NULL`],
  ['dashboard: leads by status', `SELECT status, count(*) FROM leads WHERE organization_id = :org AND archived_at IS NULL AND merged_into_id IS NULL GROUP BY status`],
  ['dashboard: leads created per day (30 days)', `SELECT date_trunc('day', created_at) d, count(*) FROM leads WHERE organization_id = :org AND archived_at IS NULL AND created_at >= now() - interval '30 days' GROUP BY 1 ORDER BY 1`],
  ['dashboard: leads by source', `SELECT source_id, count(*) FROM leads WHERE organization_id = :org AND archived_at IS NULL AND created_at >= now() - interval '30 days' GROUP BY 1`],
  ['pipeline: open value per stage', `SELECT stage_id, count(*), sum(value) FROM opportunities WHERE organization_id = :org AND archived_at IS NULL GROUP BY 1`],
  ['pipeline: cards of one stage (60)', `SELECT * FROM opportunities WHERE organization_id = :org AND archived_at IS NULL AND stage_id = (SELECT stage_id FROM opportunities WHERE organization_id = :org LIMIT 1) ORDER BY position ASC LIMIT 60`],
  ['follow-ups: due today / overdue', `SELECT * FROM follow_ups WHERE organization_id = :org AND status = 'PENDING' AND due_at <= now() + interval '1 day' ORDER BY due_at LIMIT 25`],
  ['notifications: unread count for a user', `SELECT count(*) FROM notifications WHERE organization_id = :org AND user_id = (SELECT user_id FROM notifications WHERE organization_id = :org LIMIT 1) AND read_at IS NULL`],
  ['scheduler: uncontacted leads scan', `SELECT id FROM leads WHERE organization_id = :org AND archived_at IS NULL AND merged_into_id IS NULL AND first_contacted_at IS NULL AND status = 'NEW' AND created_at <= now() - interval '24 hours' LIMIT 200`],
  ['scheduler: inactive leads scan', `SELECT id FROM leads WHERE organization_id = :org AND archived_at IS NULL AND merged_into_id IS NULL AND status IN ('NEW','CONTACTED','QUALIFIED') AND last_activity_at <= now() - interval '7 days' LIMIT 200`],
  ['activity timeline of one lead', `SELECT * FROM activities WHERE organization_id = :org AND lead_id = (SELECT id FROM leads WHERE organization_id = :org LIMIT 1) ORDER BY occurred_at DESC LIMIT 50`],
];

(async () => {
  const out: string[] = [`# EXPLAIN ANALYZE as role leadflow_app under RLS — dataset ${LABEL} (${new Date().toISOString()})`, ''];
  const summary: Array<{ q: string; ms: number; plan: string }> = [];
  for (const [name, sql] of Q) {
    const text = sql.replace(/:org/g, `'${ds.orgId}'::uuid`);
    const rows = await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE leadflow_app`);
      await tx.$executeRawUnsafe(`SELECT set_config('app.org_id', '${ds.orgId}', true), set_config('app.user_id', '', true), set_config('app.invite_token', '', true)`);
      return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING ON, SUMMARY ON) ${text}`);
    }, { timeout: 120_000 });
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    const ms = Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? NaN);
    const top = /(Seq Scan|Index Scan|Index Only Scan|Bitmap Heap Scan|Parallel Seq Scan)[^\n]*/.exec(plan)?.[0]?.trim() ?? '';
    summary.push({ q: name, ms, plan: top });
    out.push(`## ${name}  —  ${ms} ms`, '```', plan, '```', '');
    console.log(`${String(ms).padStart(9)} ms  ${name}   [${top.slice(0, 90)}]`);
  }
  fs.writeFileSync(path.join(root, `explain-${LABEL}.md`), out.join('\n'));
  fs.writeFileSync(path.join(root, `explain-${LABEL}.json`), JSON.stringify(summary, null, 2));
  await owner.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
