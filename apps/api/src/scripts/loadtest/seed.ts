/**
 * Bulk data generator for load tests (NEVER run against a real environment: it creates fake users with a known password).
 *   NODE_ENV=development npx tsx src/scripts/loadtest/seed.ts --leads 100000 --label l100k [--agents 20]
 * It creates one workspace through the public API (so roles, pipeline, lookups and subscription are bootstrapped by the
 * product's own code) and then fills it with SQL generate_series in the owner connection — fast, and realistic in shape:
 * 8 % of leads have an opportunity, 6 % a pending follow-up, 3 % a task, 40 % have activity history, 500 notifications per user.
 */
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { PrismaClient } from '@leadflow/database';
import { hashPassword } from '../../lib/crypto';

loadEnv({ path: path.resolve(__dirname, '../../../../../.env') });
const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1]! : d; };
const N = Number(arg('leads', '30000')), LABEL = arg('label', `l${N}`), AGENTS = Number(arg('agents', '20'));
const API = process.env.LOAD_API_URL ?? 'http://localhost:4000';
export const LOAD_PASSWORD = 'Load#Pass2026';
const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

async function http(method: string, url: string, body?: unknown, cookie?: string, org?: string) {
  const r = await fetch(`${API}/api${url}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(org ? { 'x-org-id': org } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const setCookie = r.headers.getSetCookie?.()[0]?.split(';')[0];
  return { status: r.status, json: await r.json().catch(() => null), cookie: setCookie };
}

(async () => {
  const t0 = Date.now();
  const email = `owner-${LABEL}@load.test`;
  const hash = await hashPassword(LOAD_PASSWORD);
  // 1. owner + workspace via the API
  await owner.$executeRawUnsafe(`DELETE FROM organizations WHERE name = $1`, `Load ${LABEL}`);
  await owner.$executeRawUnsafe(`DELETE FROM users WHERE email LIKE $1`, `%-${LABEL}@load.test`);
  const reg = await http('POST', '/auth/register', { name: 'Load Owner', email, password: LOAD_PASSWORD });
  if (reg.status !== 201) throw new Error(`register failed ${reg.status} ${JSON.stringify(reg.json)} (start the API with DISABLE_RATE_LIMIT=true)`);
  await owner.$executeRawUnsafe(`UPDATE users SET email_verified_at = now() WHERE email = $1`, email);
  const login = await http('POST', '/auth/login', { email, password: LOAD_PASSWORD });
  const org = await http('POST', '/organizations', { name: `Load ${LABEL}`, industry: 'Load test' }, login.cookie);
  const orgId = (org.json as { data: { id: string } }).data.id;
  console.log(`workspace ${orgId} created`);

  // 2. plan without limits, users and memberships
  await owner.$executeRawUnsafe(`INSERT INTO subscription_plans (id, code, name, description, price_monthly, price_yearly, trial_days, max_leads, max_seats, features, sort_order, is_active, created_at, updated_at)
    SELECT gen_random_uuid(), 'loadtest', 'Load test', 'unlimited', 0, 0, 0, 100000000, 100000, features, 99, true, now(), now() FROM subscription_plans WHERE code = 'professional' ON CONFLICT (code) DO NOTHING`);
  await owner.$executeRawUnsafe(`UPDATE subscriptions SET plan_id = (SELECT id FROM subscription_plans WHERE code = 'loadtest'), status = 'ACTIVE', trial_ends_at = NULL, current_period_end = now() + interval '365 days' WHERE organization_id = $1::uuid`, orgId);
  await owner.$executeRawUnsafe(`UPDATE organizations SET onboarding_completed_at = now() WHERE id = $1::uuid`, orgId);
  const roles = Object.fromEntries((await owner.$queryRawUnsafe<Array<{ id: string; system_key: string }>>(`SELECT id, system_key FROM roles WHERE organization_id = $1::uuid`, orgId)).map((r) => [r.system_key, r.id]));
  const people: Array<{ email: string; role: string; name: string }> = [{ email: `manager-${LABEL}@load.test`, role: 'MANAGER', name: 'Load Manager' }, { email: `viewer-${LABEL}@load.test`, role: 'VIEWER', name: 'Load Viewer' }, ...Array.from({ length: AGENTS }, (_, i) => ({ email: `agent${i + 1}-${LABEL}@load.test`, role: 'SALES_AGENT', name: `Agent ${i + 1}` }))];
  for (const p of people) {
    await owner.$executeRawUnsafe(`INSERT INTO users (id, email, name, password_hash, email_verified_at, is_active, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, now(), true, now(), now())`, p.email, p.name, hash);
    await owner.$executeRawUnsafe(`INSERT INTO memberships (id, organization_id, user_id, role_id, status, joined_at) SELECT gen_random_uuid(), $1::uuid, id, $3::uuid, 'ACTIVE', now() FROM users WHERE email = $2`, orgId, p.email, roles[p.role]);
  }
  console.log(`${people.length} users created`);

  // 3. bulk rows
  const sql = (s: string) => owner.$executeRawUnsafe(s.replace(/:org/g, `'${orgId}'::uuid`));
  const FIRST = ['Olivia', 'Liam', 'Emma', 'Noah', 'Ava', 'Lucas', 'Mia', 'Ethan', 'Sofia', 'Mason', 'Isla', 'Logan', 'Zara', 'Omar', 'Priya', 'Chen', 'Fatima', 'Diego', 'Hannah', 'Jamal'];
  const LAST = ['Smith', 'Garcia', 'Khan', 'Nguyen', 'Brown', 'Patel', 'Johnson', 'Silva', 'Lee', 'Martin', 'Cohen', 'Ali', 'Rossi', 'Kim', 'Novak', 'Ito', 'Moreau', 'Weber', 'Santos', 'Okafor'];
  const arr = (a: string[]) => `(ARRAY[${a.map((x) => `'${x}'`).join(",")}])`;
  const t1 = Date.now();
  await sql(`
    WITH a AS (SELECT array_agg(m.user_id ORDER BY m.user_id) ids FROM memberships m JOIN roles r ON r.id = m.role_id WHERE m.organization_id = :org AND r.system_key = 'SALES_AGENT'),
         s AS (SELECT array_agg(id ORDER BY name) ids FROM lead_sources WHERE organization_id = :org),
         p AS (SELECT array_agg(id ORDER BY name) ids FROM lead_priorities WHERE organization_id = :org)
    INSERT INTO leads (id, organization_id, first_name, last_name, email, email_normalized, phone, phone_normalized, company_name, job_title, source_id, campaign, priority_id, status,
                       assigned_to_id, assigned_at, created_by_id, first_contacted_at, last_activity_at, converted_at, lost_at, created_at, updated_at, custom_fields)
    SELECT gen_random_uuid(), :org, f, l, lower(f || '.' || l || g || '@acme' || (g % 997) || '.test'), lower(f || '.' || l || g || '@acme' || (g % 997) || '.test'),
           '+1 202 555 ' || lpad((g % 10000)::text, 4, '0'), '1202555' || lpad((g % 10000)::text, 4, '0'),
           (ARRAY['Acme','Globex','Initech','Umbrella','Hooli','Stark','Wayne','Wonka','Soylent','Cyberdyne'])[1 + g % 10] || ' ' || (g % 5000), (ARRAY['CEO','CTO','Buyer','Manager','Director','Founder'])[1 + g % 6],
           s.ids[1 + g % cardinality(s.ids)], (ARRAY['spring-launch','webinar','partner','organic','retarget'])[1 + g % 5], p.ids[1 + g % cardinality(p.ids)], st,
           CASE WHEN g % 9 = 0 THEN NULL ELSE a.ids[1 + g % cardinality(a.ids)] END, CASE WHEN g % 9 = 0 THEN NULL ELSE ts + interval '5 minutes' END, a.ids[1 + (g * 7) % cardinality(a.ids)],
           CASE WHEN st <> 'NEW' THEN ts + interval '1 hour' END, ts + (random() * interval '20 days'),
           CASE WHEN st = 'CONVERTED' THEN ts + interval '10 days' END, CASE WHEN st = 'LOST' THEN ts + interval '8 days' END, ts, ts, '{}'::jsonb
    FROM (SELECT g, ${arr(FIRST)}[1 + g % 20] AS f, ${arr(LAST)}[1 + (g / 20) % 20] AS l,
                 (ARRAY['NEW','NEW','CONTACTED','CONTACTED','QUALIFIED','QUALIFIED','CONVERTED','LOST'])[1 + g % 8]::"LeadStatus" AS st,
                 now() - (random() * interval '540 days') AS ts FROM generate_series(1, ${N}) g) x, a, s, p`);
  console.log(`${N} leads inserted in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  await sql(`
    WITH pl AS (SELECT id FROM pipelines WHERE organization_id = :org ORDER BY created_at LIMIT 1),
         st AS (SELECT array_agg(id ORDER BY position) ids, array_agg(kind ORDER BY position) kinds FROM pipeline_stages WHERE pipeline_id = (SELECT id FROM pl)),
         lr AS (SELECT id FROM lost_reasons WHERE organization_id = :org LIMIT 1)
    INSERT INTO opportunities (id, organization_id, lead_id, pipeline_id, stage_id, name, value, expected_close_date, status, owner_id, position, stage_entered_at, won_at, lost_at, lost_reason_id, created_by_id, created_at, updated_at)
    SELECT gen_random_uuid(), :org, l.id, (SELECT id FROM pl), st.ids[k], 'Deal ' || l.first_name || ' ' || l.last_name, (500 + (random() * 40000))::numeric(14,2), (now() + (random() * interval '60 days'))::date,
           CASE st.kinds[k] WHEN 'WON' THEN 'WON' WHEN 'LOST' THEN 'LOST' ELSE 'OPEN' END::"OppStatus", l.assigned_to_id, row_number() OVER () * 1024, l.created_at + interval '2 days',
           CASE WHEN st.kinds[k] = 'WON' THEN l.created_at + interval '9 days' END, CASE WHEN st.kinds[k] = 'LOST' THEN l.created_at + interval '9 days' END, CASE WHEN st.kinds[k] = 'LOST' THEN (SELECT id FROM lr) END, l.created_by_id, l.created_at + interval '2 days', l.created_at + interval '2 days'
    FROM (SELECT *, 1 + floor(random() * cardinality((SELECT ids FROM st)))::int AS k FROM leads WHERE organization_id = :org AND assigned_to_id IS NOT NULL AND abs(hashtext(id::text)) % 100 < 8) l, st`);
  await sql(`
    INSERT INTO follow_ups (id, organization_id, lead_id, type, title, due_at, assigned_to_id, created_by_id, priority, status, created_at, updated_at)
    SELECT gen_random_uuid(), :org, id, (ARRAY['CALL','EMAIL','MEETING','WHATSAPP'])[1 + abs(hashtext(id::text)) % 4]::"FollowUpType", 'Check in', now() + ((abs(hashtext(id::text)) % 29 - 14) || ' days')::interval + ((abs(hashtext(id::text)) % 600) || ' minutes')::interval,
           assigned_to_id, assigned_to_id, 'MEDIUM', 'PENDING', created_at, created_at
    FROM leads WHERE organization_id = :org AND assigned_to_id IS NOT NULL AND abs(hashtext(id::text)) % 100 < 6`);
  await sql(`
    INSERT INTO tasks (id, organization_id, title, status, priority, due_at, assigned_to_id, created_by_id, lead_id, created_at, updated_at)
    SELECT gen_random_uuid(), :org, 'Prepare proposal for ' || first_name, 'TODO', 'MEDIUM', now() + ((abs(hashtext(id::text)) % 21 - 7) || ' days')::interval, assigned_to_id, assigned_to_id, id, created_at, created_at
    FROM leads WHERE organization_id = :org AND assigned_to_id IS NOT NULL AND abs(hashtext(id::text)) % 100 < 3`);
  await sql(`
    INSERT INTO activities (id, organization_id, lead_id, type, actor_id, title, body, occurred_at, created_at)
    SELECT gen_random_uuid(), :org, id, t, created_by_id, CASE t WHEN 'LEAD_CREATED' THEN 'Lead created' ELSE 'Intro call' END, CASE t WHEN 'CALL' THEN 'Discussed requirements and budget.' END,
           created_at + (CASE t WHEN 'LEAD_CREATED' THEN interval '0' ELSE interval '2 hours' END), created_at
    FROM leads, unnest(ARRAY['LEAD_CREATED','CALL']::"ActivityType"[]) t WHERE organization_id = :org AND abs(hashtext(id::text)) % 100 < 40`);
  await sql(`
    INSERT INTO notifications (id, organization_id, user_id, type, title, body, link, read_at, created_at)
    SELECT gen_random_uuid(), :org, m.user_id, 'NEW_LEAD', 'New lead received: Lead ' || g, 'Automation: Notify managers', '/leads', CASE WHEN g % 10 < 7 THEN now() ELSE NULL END, now() - (g || ' minutes')::interval
    FROM memberships m, generate_series(1, 500) g WHERE m.organization_id = :org`);
  await owner.$executeRawUnsafe(`ANALYZE`);
  const counts = await owner.$queryRawUnsafe<Array<Record<string, bigint>>>(`SELECT (SELECT count(*) FROM leads WHERE organization_id = '${orgId}') leads, (SELECT count(*) FROM opportunities WHERE organization_id = '${orgId}') opportunities, (SELECT count(*) FROM follow_ups WHERE organization_id = '${orgId}') follow_ups, (SELECT count(*) FROM tasks WHERE organization_id = '${orgId}') tasks, (SELECT count(*) FROM activities WHERE organization_id = '${orgId}') activities, (SELECT count(*) FROM notifications WHERE organization_id = '${orgId}') notifications`);
  const info = { label: LABEL, orgId, ownerEmail: email, managerEmail: `manager-${LABEL}@load.test`, agentEmails: people.filter((p) => p.role === 'SALES_AGENT').map((p) => p.email), password: LOAD_PASSWORD, counts: Object.fromEntries(Object.entries(counts[0]!).map(([k, v]) => [k, Number(v)])) };
  fs.mkdirSync(path.resolve(__dirname, '../../../../../loadtest-results'), { recursive: true });
  fs.writeFileSync(path.resolve(__dirname, `../../../../../loadtest-results/dataset-${LABEL}.json`), JSON.stringify(info, null, 2));
  console.log(JSON.stringify(info.counts), `done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await owner.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
