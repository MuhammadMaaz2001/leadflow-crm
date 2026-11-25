import { Prisma } from '@leadflow/database';
import { db } from '../../db';
import type { Ctx } from '../../http';
import { type FilterCtx } from './filters';
import { bucketKeys, fillBuckets, granularityFor, num as n, pct, salespersonStats, trunc } from './dashboard';
import { followUpScope } from '../followups/service';

export type ColType = 'text' | 'number' | 'percent' | 'money' | 'hours' | 'date';
export interface Column { key: string; label: string; type: ColType }
export interface ReportResult { key: string; title: string; description: string; columns: Column[]; rows: Array<Record<string, string | number | null>>; summary: Array<{ label: string; value: string | number; type: ColType }>; extra?: Record<string, unknown> }

export const REPORTS = [
  { key: 'lead-generation', title: 'Lead Generation', description: 'Leads created over time, and how far each period\'s leads progressed.' },
  { key: 'lead-source', title: 'Lead Source Performance', description: 'Volume, contact rate, conversion and revenue by lead source.' },
  { key: 'assignment', title: 'Assignment', description: 'Who received leads, how fast leads were assigned and current ownership load.' },
  { key: 'contact-performance', title: 'Contact Performance', description: 'Contact rate and logged interactions per salesperson.' },
  { key: 'follow-up', title: 'Follow-up', description: 'Scheduling discipline: completed, on-time, overdue and canceled follow-ups.' },
  { key: 'pipeline', title: 'Pipeline', description: 'Open opportunities, value and time-in-stage for every stage.' },
  { key: 'conversion', title: 'Conversion', description: 'Won vs lost opportunities and conversion rate per period.' },
  { key: 'lost-leads', title: 'Lost Lead', description: 'Why opportunities are being lost.' },
  { key: 'salesperson', title: 'Salesperson Performance', description: 'Leads, contact, deals won and revenue per team member.' },
  { key: 'lead-aging', title: 'Lead Aging', description: 'How long open leads have been waiting.' },
  { key: 'response-time', title: 'Response Time', description: 'Time from lead creation to first recorded contact attempt.' },
  { key: 'lead-status', title: 'Lead Status', description: 'Where the leads created in the period stand today: new, contacted, qualified, converted, lost.' },
  { key: 'activity', title: 'Activity', description: 'Logged calls, emails, WhatsApp chats, meetings and notes per team member (manually recorded interactions).' },
  { key: 'task-performance', title: 'Task Performance', description: 'Tasks due in the period: completed, completed on time, overdue and still open, per assignee.' },
] as const;
export type ReportKey = (typeof REPORTS)[number]['key'];

const meta = (key: ReportKey) => REPORTS.find((r) => r.key === key)!;
const rnd = (v: unknown, d = 1) => (v == null ? null : Math.round(Number(v) * 10 ** d) / 10 ** d);
type Row = Record<string, string | number | null>;

export async function runReport(key: ReportKey, ctx: Ctx, f: FilterCtx): Promise<ReportResult> {
  const m = meta(key);
  const base = { key, title: m.title, description: m.description };
  const { from, to } = f.range;
  const g = granularityFor(f);

  switch (key) {
    case 'lead-generation': {
      const rows = await db().$queryRaw<Row[]>`
        SELECT ${trunc(g, 'l.created_at', f.tz)} AS bucket, count(*)::int AS leads, count(*) FILTER (WHERE l.assigned_to_id IS NOT NULL)::int AS assigned,
               count(*) FILTER (WHERE l.first_contacted_at IS NOT NULL)::int AS contacted, count(*) FILTER (WHERE l.status = 'CONVERTED')::int AS converted
        FROM leads l WHERE ${f.leadWhere} GROUP BY 1 ORDER BY 1`;
      const filled = fillBuckets(rows as Array<{ bucket: string }>, await bucketKeys(f, g), { leads: 0, assigned: 0, contacted: 0, converted: 0 } as never) as unknown as Row[];
      const t = filled.reduce<{ leads: number; assigned: number; contacted: number; converted: number }>((a, r) => ({ leads: a.leads + n(r.leads), assigned: a.assigned + n(r.assigned), contacted: a.contacted + n(r.contacted), converted: a.converted + n(r.converted) }), { leads: 0, assigned: 0, contacted: 0, converted: 0 });
      return { ...base, columns: [{ key: 'bucket', label: g === 'day' ? 'Date' : g === 'week' ? 'Week starting' : 'Month', type: 'date' }, { key: 'leads', label: 'Leads', type: 'number' }, { key: 'assigned', label: 'Assigned', type: 'number' }, { key: 'contacted', label: 'Contacted', type: 'number' }, { key: 'converted', label: 'Converted', type: 'number' }], rows: filled,
        summary: [{ label: 'Total leads', value: t.leads, type: 'number' }, { label: 'Assigned', value: t.assigned, type: 'number' }, { label: 'Contacted', value: t.contacted, type: 'number' }, { label: 'Converted', value: t.converted, type: 'number' }, { label: 'Contact rate', value: pct(t.contacted, t.assigned), type: 'percent' }] };
    }
    case 'lead-source': {
      const rows = await db().$queryRaw<Row[]>`
        SELECT COALESCE(s.name, 'Unknown') AS source, count(l.id)::int AS leads, count(*) FILTER (WHERE l.first_contacted_at IS NOT NULL)::int AS contacted,
               count(*) FILTER (WHERE l.status IN ('QUALIFIED','CONVERTED'))::int AS qualified, count(*) FILTER (WHERE l.status = 'CONVERTED')::int AS won, count(*) FILTER (WHERE l.status = 'LOST')::int AS lost,
               COALESCE((SELECT sum(o.value) FROM opportunities o WHERE o.organization_id = l.organization_id AND o.status = 'WON' AND o.archived_at IS NULL AND o.lead_id = ANY(array_agg(l.id))), 0)::float AS won_value,
               avg(EXTRACT(EPOCH FROM (l.first_contacted_at - l.created_at)) / 3600) FILTER (WHERE l.first_contacted_at IS NOT NULL)::float AS avg_response_h
        FROM leads l LEFT JOIN lead_sources s ON s.id = l.source_id AND s.organization_id = l.organization_id WHERE ${f.leadWhere} GROUP BY s.name, l.organization_id ORDER BY count(l.id) DESC`;
      const out = rows.map((r): Row => ({ ...r, contact_rate: pct(n(r.contacted), n(r.leads)), conversion_rate: pct(n(r.won), n(r.leads)), avg_response_h: rnd(r.avg_response_h) }));
      const tl = out.reduce((a, r) => a + n(r.leads), 0), tw = out.reduce((a, r) => a + n(r.won), 0);
      return { ...base, columns: [{ key: 'source', label: 'Source', type: 'text' }, { key: 'leads', label: 'Leads', type: 'number' }, { key: 'contacted', label: 'Contacted', type: 'number' }, { key: 'contact_rate', label: 'Contact rate', type: 'percent' }, { key: 'qualified', label: 'Qualified+', type: 'number' }, { key: 'won', label: 'Won', type: 'number' }, { key: 'lost', label: 'Lost', type: 'number' }, { key: 'conversion_rate', label: 'Lead → won', type: 'percent' }, { key: 'won_value', label: 'Won value', type: 'money' }, { key: 'avg_response_h', label: 'Avg first response (h)', type: 'hours' }], rows: out,
        summary: [{ label: 'Sources', value: out.length, type: 'number' }, { label: 'Leads', value: tl, type: 'number' }, { label: 'Won', value: tw, type: 'number' }, { label: 'Overall lead → won', value: pct(tw, tl), type: 'percent' }], extra: { best: out.slice().sort((a, b) => n(b.conversion_rate) - n(a.conversion_rate))[0]?.source ?? null } };
    }
    case 'assignment': {
      const rows = await db().$queryRaw<Row[]>`
        WITH mem AS (SELECT m.user_id, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ${ctx.orgId}::uuid AND m.status = 'ACTIVE' ${f.assigneeId ? Prisma.sql`AND m.user_id = ${f.assigneeId}::uuid` : Prisma.empty}),
        got AS (SELECT to_user_id AS uid, count(*)::int AS received, count(*) FILTER (WHERE method = 'ROUND_ROBIN')::int AS rr, count(*) FILTER (WHERE method = 'RULE')::int AS by_rule, count(*) FILTER (WHERE method IN ('MANUAL','BULK'))::int AS manual, count(*) FILTER (WHERE method = 'AUTOMATION')::int AS automation, count(*) FILTER (WHERE method NOT IN ('MANUAL','BULK','ROUND_ROBIN','RULE','AUTOMATION'))::int AS other FROM lead_assignments WHERE organization_id = ${ctx.orgId}::uuid AND to_user_id IS NOT NULL AND created_at >= ${from} AND created_at < ${to} GROUP BY 1),
        lost AS (SELECT from_user_id AS uid, count(*)::int AS reassigned_away FROM lead_assignments WHERE organization_id = ${ctx.orgId}::uuid AND from_user_id IS NOT NULL AND (to_user_id IS DISTINCT FROM from_user_id) AND created_at >= ${from} AND created_at < ${to} GROUP BY 1),
        cur AS (SELECT l.assigned_to_id AS uid, count(*)::int AS open_leads FROM leads l WHERE ${f.leadAnyWhere} AND l.status IN ('NEW','CONTACTED','QUALIFIED') GROUP BY 1)
        SELECT mem.name AS member, COALESCE(got.received, 0) AS received, COALESCE(got.manual, 0) AS manual, COALESCE(got.automation, 0) AS automation, COALESCE(got.other, 0) AS other, COALESCE(got.rr, 0) AS round_robin, COALESCE(got.by_rule, 0) AS by_rule, COALESCE(lost.reassigned_away, 0) AS reassigned_away, COALESCE(cur.open_leads, 0) AS open_leads
        FROM mem LEFT JOIN got ON got.uid = mem.user_id LEFT JOIN lost ON lost.uid = mem.user_id LEFT JOIN cur ON cur.uid = mem.user_id ORDER BY COALESCE(got.received, 0) DESC`;
      const [u] = await db().$queryRaw<Array<{ unassigned: number; avg_h: number | null }>>`
        SELECT (SELECT count(*)::int FROM leads l WHERE ${f.leadAnyWhere} AND l.assigned_to_id IS NULL AND l.status IN ('NEW','CONTACTED','QUALIFIED')) AS unassigned,
               (SELECT avg(EXTRACT(EPOCH FROM (l.assigned_at - l.created_at)) / 3600)::float FROM leads l WHERE ${f.leadWhere} AND l.assigned_at IS NOT NULL) AS avg_h`;
      return { ...base, columns: [{ key: 'member', label: 'Team member', type: 'text' }, { key: 'received', label: 'Leads received', type: 'number' }, { key: 'manual', label: 'Manual', type: 'number' }, { key: 'automation', label: 'Automation', type: 'number' }, { key: 'other', label: 'Import / transfer / merge', type: 'number' }, { key: 'round_robin', label: 'Round-robin', type: 'number' }, { key: 'by_rule', label: 'Rule-based', type: 'number' }, { key: 'reassigned_away', label: 'Reassigned away', type: 'number' }, { key: 'open_leads', label: 'Open leads now', type: 'number' }], rows,
        summary: [{ label: 'Unassigned open leads', value: u?.unassigned ?? 0, type: 'number' }, { label: 'Avg time to assign (h)', value: rnd(u?.avg_h) ?? 0, type: 'hours' }, { label: 'Assignments in range', value: rows.reduce((a, r) => a + n(r.received), 0), type: 'number' }] };
    }
    case 'contact-performance': {
      const rows = await db().$queryRaw<Row[]>`
        WITH mem AS (SELECT m.user_id, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ${ctx.orgId}::uuid AND m.status = 'ACTIVE' ${f.assigneeId ? Prisma.sql`AND m.user_id = ${f.assigneeId}::uuid` : Prisma.empty}),
        ls AS (SELECT l.assigned_to_id AS uid, count(*)::int AS assigned, count(*) FILTER (WHERE l.first_contacted_at IS NOT NULL)::int AS contacted FROM leads l WHERE ${f.leadWhere} AND l.assigned_to_id IS NOT NULL GROUP BY 1),
        act AS (SELECT actor_id AS uid, count(*) FILTER (WHERE type = 'CALL')::int AS calls, count(*) FILTER (WHERE type = 'EMAIL')::int AS emails, count(*) FILTER (WHERE type = 'WHATSAPP')::int AS whatsapp, count(*) FILTER (WHERE type = 'MEETING')::int AS meetings FROM activities WHERE organization_id = ${ctx.orgId}::uuid AND type IN ('CALL','EMAIL','WHATSAPP','MEETING') AND occurred_at >= ${from} AND occurred_at < ${to} GROUP BY 1)
        SELECT mem.name AS member, COALESCE(ls.assigned, 0) AS assigned, COALESCE(ls.contacted, 0) AS contacted, COALESCE(act.calls, 0) AS calls, COALESCE(act.emails, 0) AS emails, COALESCE(act.whatsapp, 0) AS whatsapp, COALESCE(act.meetings, 0) AS meetings
        FROM mem LEFT JOIN ls ON ls.uid = mem.user_id LEFT JOIN act ON act.uid = mem.user_id ORDER BY COALESCE(ls.contacted, 0) DESC`;
      const out = rows.map((r): Row => ({ ...r, contact_rate: pct(n(r.contacted), n(r.assigned)), interactions: n(r.calls) + n(r.emails) + n(r.whatsapp) + n(r.meetings) }));
      const ta = out.reduce((a, r) => a + n(r.assigned), 0), tc = out.reduce((a, r) => a + n(r.contacted), 0);
      return { ...base, columns: [{ key: 'member', label: 'Team member', type: 'text' }, { key: 'assigned', label: 'Assigned leads', type: 'number' }, { key: 'contacted', label: 'Contacted', type: 'number' }, { key: 'contact_rate', label: 'Contact rate', type: 'percent' }, { key: 'calls', label: 'Calls', type: 'number' }, { key: 'emails', label: 'Emails', type: 'number' }, { key: 'whatsapp', label: 'WhatsApp', type: 'number' }, { key: 'meetings', label: 'Meetings', type: 'number' }, { key: 'interactions', label: 'Total interactions', type: 'number' }], rows: out,
        summary: [{ label: 'Assigned leads', value: ta, type: 'number' }, { label: 'Contacted', value: tc, type: 'number' }, { label: 'Contact rate', value: pct(tc, ta), type: 'percent' }] };
    }
    case 'follow-up': {
      const scope = ctx.can('followups.view_all') ? Prisma.empty : Prisma.sql`AND (f.assigned_to_id = ${ctx.userId}::uuid)`;
      const rows = await db().$queryRaw<Row[]>`
        SELECT u.name AS member, count(*) FILTER (WHERE f.status <> 'CANCELED')::int AS due,
               count(*) FILTER (WHERE f.status = 'COMPLETED')::int AS completed, count(*) FILTER (WHERE f.status = 'COMPLETED' AND f.completed_at <= f.due_at)::int AS on_time,
               count(*) FILTER (WHERE f.status = 'PENDING' AND f.due_at < ${f.now})::int AS overdue, count(*) FILTER (WHERE f.status = 'PENDING' AND f.due_at >= ${f.now})::int AS upcoming,
               count(*) FILTER (WHERE f.status = 'CANCELED')::int AS canceled, COALESCE(sum(f.reschedule_count), 0)::int AS reschedules
        FROM follow_ups f JOIN users u ON u.id = f.assigned_to_id WHERE f.organization_id = ${ctx.orgId}::uuid AND f.due_at >= ${from} AND f.due_at < ${to}
          ${f.assigneeId ? Prisma.sql`AND f.assigned_to_id = ${f.assigneeId}::uuid` : Prisma.empty} ${scope} GROUP BY u.name ORDER BY count(*) DESC`;
      const out = rows.map((r): Row => ({ ...r, completion_rate: pct(n(r.completed), n(r.due) - n(r.upcoming)), on_time_rate: pct(n(r.on_time), n(r.completed)) }));
      const t = out.reduce<{ due: number; completed: number; overdue: number; upcoming: number }>((a, r) => ({ due: a.due + n(r.due), completed: a.completed + n(r.completed), overdue: a.overdue + n(r.overdue), upcoming: a.upcoming + n(r.upcoming) }), { due: 0, completed: 0, overdue: 0, upcoming: 0 });
      return { ...base, columns: [{ key: 'member', label: 'Team member', type: 'text' }, { key: 'due', label: 'Scheduled (in range)', type: 'number' }, { key: 'completed', label: 'Completed', type: 'number' }, { key: 'on_time', label: 'Completed on time', type: 'number' }, { key: 'overdue', label: 'Overdue now', type: 'number' }, { key: 'upcoming', label: 'Upcoming', type: 'number' }, { key: 'canceled', label: 'Canceled', type: 'number' }, { key: 'reschedules', label: 'Reschedules', type: 'number' }, { key: 'completion_rate', label: 'Completion rate', type: 'percent' }, { key: 'on_time_rate', label: 'On-time rate', type: 'percent' }], rows: out,
        summary: [{ label: 'Scheduled', value: t.due, type: 'number' }, { label: 'Completed', value: t.completed, type: 'number' }, { label: 'Overdue now', value: t.overdue, type: 'number' }, { label: 'Completion rate', value: pct(t.completed, t.due - t.upcoming), type: 'percent' }] };
    }
    case 'pipeline': {
      const pipeline = f.pipelineId ? await db().pipeline.findFirst({ where: { id: f.pipelineId, organizationId: ctx.orgId } }) : await db().pipeline.findFirst({ where: { organizationId: ctx.orgId, isDefault: true, archivedAt: null } });
      const rows = pipeline ? await db().$queryRaw<Row[]>`
        SELECT st.name AS stage, st.kind::text AS kind, st.probability AS probability, count(o.id)::int AS deals, COALESCE(sum(o.value), 0)::float AS value,
               (COALESCE(sum(o.value), 0) * st.probability / 100.0)::float AS weighted_value,
               avg(EXTRACT(EPOCH FROM (${f.now}::timestamptz - o.stage_entered_at)) / 86400)::float AS avg_days_in_stage
        FROM pipeline_stages st
        LEFT JOIN (SELECT o.* FROM opportunities o JOIN leads l ON l.id = o.lead_id AND l.organization_id = o.organization_id WHERE ${f.oppWhere}) o ON o.stage_id = st.id AND o.organization_id = st.organization_id
        WHERE st.pipeline_id = ${pipeline.id}::uuid AND st.organization_id = ${ctx.orgId}::uuid GROUP BY st.id ORDER BY st.position` : [];
      const out = rows.map((r): Row => ({ ...r, avg_days_in_stage: rnd(r.avg_days_in_stage) }));
      const open = out.filter((r) => r.kind === 'OPEN');
      return { ...base, columns: [{ key: 'stage', label: 'Stage', type: 'text' }, { key: 'kind', label: 'Type', type: 'text' }, { key: 'probability', label: 'Win probability', type: 'percent' }, { key: 'deals', label: 'Deals', type: 'number' }, { key: 'value', label: 'Value', type: 'money' }, { key: 'weighted_value', label: 'Weighted value', type: 'money' }, { key: 'avg_days_in_stage', label: 'Avg days in stage', type: 'number' }], rows: out,
        summary: [{ label: 'Open deals', value: open.reduce((a, r) => a + n(r.deals), 0), type: 'number' }, { label: 'Open pipeline value', value: open.reduce((a, r) => a + n(r.value), 0), type: 'money' }, { label: 'Weighted forecast', value: Math.round(open.reduce((a, r) => a + n(r.weighted_value), 0)), type: 'money' }], extra: { pipeline: pipeline?.name } };
    }
    case 'conversion': {
      const rows = await db().$queryRaw<Row[]>`
        SELECT b AS bucket, sum(w)::int AS won, sum(x)::int AS lost, (sum(w) + sum(x))::int AS closed, COALESCE(sum(v), 0)::float AS won_value FROM (
          SELECT ${trunc(g, 'o.won_at', f.tz)} AS b, 1 AS w, 0 AS x, o.value AS v FROM opportunities o JOIN leads l ON l.id = o.lead_id AND l.organization_id = o.organization_id WHERE ${f.oppWhere} AND o.status = 'WON' AND o.won_at >= ${from} AND o.won_at < ${to}
          UNION ALL SELECT ${trunc(g, 'o.lost_at', f.tz)}, 0, 1, 0 FROM opportunities o JOIN leads l ON l.id = o.lead_id AND l.organization_id = o.organization_id WHERE ${f.oppWhere} AND o.status = 'LOST' AND o.lost_at >= ${from} AND o.lost_at < ${to}
        ) t GROUP BY b ORDER BY b`;
      const filled = fillBuckets(rows as Array<{ bucket: string }>, await bucketKeys(f, g), { won: 0, lost: 0, closed: 0, won_value: 0 } as never) as unknown as Row[];
      const out = filled.map((r): Row => ({ ...r, conversion_rate: pct(n(r.won), n(r.closed)) }));
      const won = out.reduce((a, r) => a + n(r.won), 0), closed = out.reduce((a, r) => a + n(r.closed), 0);
      return { ...base, columns: [{ key: 'bucket', label: 'Period', type: 'date' }, { key: 'won', label: 'Won', type: 'number' }, { key: 'lost', label: 'Lost', type: 'number' }, { key: 'closed', label: 'Closed', type: 'number' }, { key: 'conversion_rate', label: 'Conversion rate', type: 'percent' }, { key: 'won_value', label: 'Won value', type: 'money' }], rows: out,
        summary: [{ label: 'Won', value: won, type: 'number' }, { label: 'Closed', value: closed, type: 'number' }, { label: 'Conversion rate', value: pct(won, closed), type: 'percent' }, { label: 'Won value', value: out.reduce((a, r) => a + n(r.won_value), 0), type: 'money' }] };
    }
    case 'lost-leads': {
      const rows = await db().$queryRaw<Row[]>`
        SELECT COALESCE(r.name, 'No reason recorded') AS reason, count(*)::int AS deals, COALESCE(sum(o.value), 0)::float AS value
        FROM opportunities o JOIN leads l ON l.id = o.lead_id AND l.organization_id = o.organization_id LEFT JOIN lost_reasons r ON r.id = o.lost_reason_id AND r.organization_id = o.organization_id
        WHERE ${f.oppWhere} AND o.status = 'LOST' AND o.lost_at >= ${from} AND o.lost_at < ${to} GROUP BY r.name ORDER BY count(*) DESC`;
      const total = rows.reduce((a, r) => a + n(r.deals), 0);
      const out = rows.map((r): Row => ({ ...r, share: pct(n(r.deals), total) }));
      const deals = await db().$queryRaw<Row[]>`
        SELECT o.name AS deal, trim(l.first_name || ' ' || COALESCE(l.last_name, '')) AS lead, COALESCE(r.name, '—') AS reason, o.value::float AS value, to_char(o.lost_at AT TIME ZONE ${f.tz}, 'YYYY-MM-DD') AS lost_on, u.name AS owner
        FROM opportunities o JOIN leads l ON l.id = o.lead_id AND l.organization_id = o.organization_id LEFT JOIN lost_reasons r ON r.id = o.lost_reason_id AND r.organization_id = o.organization_id LEFT JOIN users u ON u.id = o.owner_id
        WHERE ${f.oppWhere} AND o.status = 'LOST' AND o.lost_at >= ${from} AND o.lost_at < ${to} ORDER BY o.lost_at DESC LIMIT 100`;
      return { ...base, columns: [{ key: 'reason', label: 'Lost reason', type: 'text' }, { key: 'deals', label: 'Deals lost', type: 'number' }, { key: 'share', label: 'Share', type: 'percent' }, { key: 'value', label: 'Value lost', type: 'money' }], rows: out,
        summary: [{ label: 'Deals lost', value: total, type: 'number' }, { label: 'Value lost', value: rows.reduce((a, r) => a + n(r.value), 0), type: 'money' }, { label: 'Top reason', value: String(rows[0]?.reason ?? '—'), type: 'text' }], extra: { deals } };
    }
    case 'salesperson': {
      const stats = await salespersonStats(f, ctx);
      return { ...base, columns: [{ key: 'name', label: 'Salesperson', type: 'text' }, { key: 'leads', label: 'Leads (created in range)', type: 'number' }, { key: 'contacted', label: 'Contacted', type: 'number' }, { key: 'contactRate', label: 'Contact rate', type: 'percent' }, { key: 'avgResponseHours', label: 'Avg first response (h)', type: 'hours' }, { key: 'followUpsCompleted', label: 'Follow-ups done', type: 'number' }, { key: 'openOpportunities', label: 'Open deals', type: 'number' }, { key: 'won', label: 'Won', type: 'number' }, { key: 'lost', label: 'Lost', type: 'number' }, { key: 'conversionRate', label: 'Conversion rate', type: 'percent' }, { key: 'wonValue', label: 'Won value', type: 'money' }],
        rows: stats as unknown as Row[], summary: [{ label: 'Team won value', value: stats.reduce((a, s) => a + s.wonValue, 0), type: 'money' }, { label: 'Top performer', value: stats[0]?.name ?? '—', type: 'text' }, { label: 'Deals won', value: stats.reduce((a, s) => a + s.won, 0), type: 'number' }] };
    }
    case 'lead-aging': {
      const rows = await db().$queryRaw<Row[]>`
        SELECT bucket, count(*)::int AS leads, count(*) FILTER (WHERE status = 'NEW')::int AS new_leads, count(*) FILTER (WHERE status = 'CONTACTED')::int AS contacted, count(*) FILTER (WHERE status = 'QUALIFIED')::int AS qualified,
               count(*) FILTER (WHERE assigned IS NULL)::int AS unassigned FROM (
          SELECT l.status, l.assigned_to_id AS assigned, CASE WHEN age < 1 THEN '0-1 days' WHEN age < 4 THEN '2-3 days' WHEN age < 8 THEN '4-7 days' WHEN age < 15 THEN '8-14 days' WHEN age < 31 THEN '15-30 days' ELSE 'Over 30 days' END AS bucket
          FROM (SELECT l.*, EXTRACT(EPOCH FROM (${f.now}::timestamptz - l.created_at)) / 86400 AS age FROM leads l WHERE ${f.leadAnyWhere} AND l.status IN ('NEW','CONTACTED','QUALIFIED')) l) t GROUP BY bucket`;
      const order = ['0-1 days', '2-3 days', '4-7 days', '8-14 days', '15-30 days', 'Over 30 days'];
      const out = order.map((b) => ({ bucket: b, ...(rows.find((r) => r.bucket === b) ?? { leads: 0, new_leads: 0, contacted: 0, qualified: 0, unassigned: 0 }) })) as Row[];
      return { ...base, columns: [{ key: 'bucket', label: 'Age since creation', type: 'text' }, { key: 'leads', label: 'Open leads', type: 'number' }, { key: 'new_leads', label: 'New', type: 'number' }, { key: 'contacted', label: 'Contacted', type: 'number' }, { key: 'qualified', label: 'Qualified', type: 'number' }, { key: 'unassigned', label: 'Unassigned', type: 'number' }], rows: out,
        summary: [{ label: 'Open leads', value: out.reduce((a, r) => a + n(r.leads), 0), type: 'number' }, { label: 'Older than 14 days', value: n(out[4]?.leads) + n(out[5]?.leads), type: 'number' }] };
    }
    case 'lead-status': {
      const rows = await db().$queryRaw<Row[]>`
        SELECT l.status::text AS status, count(*)::int AS leads, count(*) FILTER (WHERE l.assigned_to_id IS NULL)::int AS unassigned,
               count(*) FILTER (WHERE l.first_contacted_at IS NOT NULL)::int AS contacted,
               avg(EXTRACT(EPOCH FROM (${f.now}::timestamptz - l.created_at)) / 86400)::float AS avg_age_days
        FROM leads l WHERE ${f.leadWhere} GROUP BY l.status`;
      const order = ['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST'];
      const total = rows.reduce((a, r) => a + n(r.leads), 0);
      const out = order.map((st): Row => { const r = rows.find((x) => x.status === st); return { status: st, leads: n(r?.leads), share: pct(n(r?.leads), total), unassigned: n(r?.unassigned), contacted: n(r?.contacted), avg_age_days: rnd(r?.avg_age_days) ?? 0 }; });
      const count = (st: string) => n(out.find((r) => r.status === st)?.leads);
      return { ...base, columns: [{ key: 'status', label: 'Status', type: 'text' }, { key: 'leads', label: 'Leads', type: 'number' }, { key: 'share', label: 'Share', type: 'percent' }, { key: 'unassigned', label: 'Unassigned', type: 'number' }, { key: 'contacted', label: 'Contacted', type: 'number' }, { key: 'avg_age_days', label: 'Avg age (days)', type: 'number' }], rows: out,
        summary: [{ label: 'Leads created in range', value: total, type: 'number' }, { label: 'Still open', value: count('NEW') + count('CONTACTED') + count('QUALIFIED'), type: 'number' }, { label: 'Converted', value: count('CONVERTED'), type: 'number' }, { label: 'Lost', value: count('LOST'), type: 'number' }] };
    }
    case 'activity': {
      const viewAll = ctx.can('activity.view_all');
      const who = f.assigneeId ?? (viewAll ? null : ctx.userId);
      const rows = await db().$queryRaw<Row[]>`
        WITH mem AS (SELECT m.user_id, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ${ctx.orgId}::uuid AND m.status = 'ACTIVE' ${who ? Prisma.sql`AND m.user_id = ${who}::uuid` : Prisma.empty}),
        act AS (SELECT actor_id AS uid, count(*) FILTER (WHERE type = 'CALL')::int AS calls, count(*) FILTER (WHERE type = 'EMAIL')::int AS emails, count(*) FILTER (WHERE type = 'WHATSAPP')::int AS whatsapp,
                       count(*) FILTER (WHERE type = 'MEETING')::int AS meetings, count(*) FILTER (WHERE type = 'NOTE')::int AS notes, count(DISTINCT lead_id)::int AS leads_touched
                FROM activities WHERE organization_id = ${ctx.orgId}::uuid AND type IN ('CALL','EMAIL','WHATSAPP','MEETING','NOTE') AND occurred_at >= ${from} AND occurred_at < ${to} GROUP BY 1)
        SELECT mem.name AS member, COALESCE(act.calls, 0) AS calls, COALESCE(act.emails, 0) AS emails, COALESCE(act.whatsapp, 0) AS whatsapp, COALESCE(act.meetings, 0) AS meetings, COALESCE(act.notes, 0) AS notes,
               (COALESCE(act.calls, 0) + COALESCE(act.emails, 0) + COALESCE(act.whatsapp, 0) + COALESCE(act.meetings, 0) + COALESCE(act.notes, 0))::int AS total, COALESCE(act.leads_touched, 0) AS leads_touched
        FROM mem LEFT JOIN act ON act.uid = mem.user_id ORDER BY 7 DESC, mem.name`;
      const t = (k: string) => rows.reduce((a, r) => a + n(r[k]), 0);
      return { ...base, columns: [{ key: 'member', label: 'Team member', type: 'text' }, { key: 'calls', label: 'Calls', type: 'number' }, { key: 'emails', label: 'Emails', type: 'number' }, { key: 'whatsapp', label: 'WhatsApp', type: 'number' }, { key: 'meetings', label: 'Meetings', type: 'number' }, { key: 'notes', label: 'Notes', type: 'number' }, { key: 'total', label: 'Total', type: 'number' }, { key: 'leads_touched', label: 'Leads touched', type: 'number' }], rows,
        summary: [{ label: 'Logged activities', value: t('total'), type: 'number' }, { label: 'Calls', value: t('calls'), type: 'number' }, { label: 'Emails', value: t('emails'), type: 'number' }, { label: 'WhatsApp', value: t('whatsapp'), type: 'number' }, { label: 'Meetings', value: t('meetings'), type: 'number' }] };
    }
    case 'task-performance': {
      const scope = ctx.can('tasks.view_all') ? Prisma.empty : Prisma.sql`AND t.assigned_to_id = ${ctx.userId}::uuid`;
      const rows = await db().$queryRaw<Row[]>`
        SELECT COALESCE(u.name, 'Unassigned') AS member, count(*) FILTER (WHERE t.status <> 'CANCELED')::int AS due,
               count(*) FILTER (WHERE t.status = 'DONE')::int AS completed, count(*) FILTER (WHERE t.status = 'DONE' AND t.completed_at <= t.due_at)::int AS on_time,
               count(*) FILTER (WHERE t.status IN ('TODO','IN_PROGRESS') AND t.due_at < ${f.now})::int AS overdue, count(*) FILTER (WHERE t.status IN ('TODO','IN_PROGRESS') AND t.due_at >= ${f.now})::int AS upcoming,
               count(*) FILTER (WHERE t.priority = 'HIGH' AND t.status IN ('TODO','IN_PROGRESS'))::int AS high_open
        FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to_id WHERE t.organization_id = ${ctx.orgId}::uuid AND t.due_at >= ${from} AND t.due_at < ${to}
          ${f.assigneeId ? Prisma.sql`AND t.assigned_to_id = ${f.assigneeId}::uuid` : Prisma.empty} ${scope} GROUP BY u.name ORDER BY count(*) DESC`;
      const out = rows.map((r): Row => ({ ...r, completion_rate: pct(n(r.completed), n(r.due) - n(r.upcoming)), on_time_rate: pct(n(r.on_time), n(r.completed)) }));
      const t = (k: string) => out.reduce((a, r) => a + n(r[k]), 0);
      return { ...base, columns: [{ key: 'member', label: 'Assignee', type: 'text' }, { key: 'due', label: 'Tasks due (in range)', type: 'number' }, { key: 'completed', label: 'Completed', type: 'number' }, { key: 'on_time', label: 'Completed on time', type: 'number' }, { key: 'overdue', label: 'Overdue now', type: 'number' }, { key: 'upcoming', label: 'Upcoming', type: 'number' }, { key: 'high_open', label: 'High priority open', type: 'number' }, { key: 'completion_rate', label: 'Completion rate', type: 'percent' }, { key: 'on_time_rate', label: 'On-time rate', type: 'percent' }], rows: out,
        summary: [{ label: 'Tasks due', value: t('due'), type: 'number' }, { label: 'Completed', value: t('completed'), type: 'number' }, { label: 'Overdue now', value: t('overdue'), type: 'number' }, { label: 'Completion rate', value: pct(t('completed'), t('due') - t('upcoming')), type: 'percent' }] };
    }
    case 'response-time': {
      const rows = await db().$queryRaw<Row[]>`
        SELECT COALESCE(u.name, 'Unassigned') AS member, count(*)::int AS leads, count(*) FILTER (WHERE l.first_contacted_at IS NOT NULL)::int AS contacted, count(*) FILTER (WHERE l.first_contacted_at IS NULL)::int AS never_contacted,
               avg(EXTRACT(EPOCH FROM (l.first_contacted_at - l.created_at)) / 3600)::float AS avg_h,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (l.first_contacted_at - l.created_at)) / 3600)::float AS median_h,
               count(*) FILTER (WHERE l.first_contacted_at - l.created_at <= interval '1 hour')::int AS within_1h, count(*) FILTER (WHERE l.first_contacted_at - l.created_at <= interval '24 hours')::int AS within_24h
        FROM leads l LEFT JOIN users u ON u.id = l.assigned_to_id WHERE ${f.leadWhere} GROUP BY u.name ORDER BY avg(EXTRACT(EPOCH FROM (l.first_contacted_at - l.created_at))) NULLS LAST`;
      const out = rows.map((r): Row => ({ ...r, avg_h: rnd(r.avg_h), median_h: rnd(r.median_h), pct_1h: pct(n(r.within_1h), n(r.leads)), pct_24h: pct(n(r.within_24h), n(r.leads)) }));
      const [tot] = await db().$queryRaw<Array<{ avg_h: number | null; never: number }>>`
        SELECT avg(EXTRACT(EPOCH FROM (l.first_contacted_at - l.created_at)) / 3600)::float AS avg_h, count(*) FILTER (WHERE l.first_contacted_at IS NULL)::int AS never FROM leads l WHERE ${f.leadWhere}`;
      return { ...base, columns: [{ key: 'member', label: 'Owner', type: 'text' }, { key: 'leads', label: 'Leads', type: 'number' }, { key: 'contacted', label: 'Contacted', type: 'number' }, { key: 'never_contacted', label: 'Never contacted', type: 'number' }, { key: 'avg_h', label: 'Avg first response (h)', type: 'hours' }, { key: 'median_h', label: 'Median (h)', type: 'hours' }, { key: 'pct_1h', label: 'Within 1 hour', type: 'percent' }, { key: 'pct_24h', label: 'Within 24 hours', type: 'percent' }], rows: out,
        summary: [{ label: 'Avg first response (h)', value: rnd(tot?.avg_h) ?? 0, type: 'hours' }, { label: 'Never contacted', value: tot?.never ?? 0, type: 'number' }] };
    }
  }
}
void followUpScope;
