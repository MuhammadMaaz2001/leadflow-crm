import { activityLogSchema, assignSchema, bulkSchema, fullName, leadSchema, leadUpdateSchema, mergeSchema } from '@leadflow/shared';
import { z } from 'zod';
import { cachedForLarge, hashKey } from '../../lib/cache';
import { db } from '../../db';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { Reply, created, defineRoutes, paged } from '../../http';
import { pageMeta, paginate, pageQuery } from '../../lib/pagination';
import { lite, usersById } from '../../lib/users';
import { audit } from '../../lib/audit';
import { logActivity } from '../activities/service';
import { notify } from '../notifications/service';
import { emitTrigger } from '../automations/events';
import {
  archiveLead, assignLead, createLead, findDuplicates, getLeadOr404, leadScope, mergeLeads, restoreLead, updateLead,
} from './service';
import { buildLeadWhere, leadInclude, leadListQuery, shapeLeads } from './queries';
import { exportLeads, exportQuery, importLeads, importOptions, tabular } from './transfer';

export const leads = defineRoutes('Leads', '/leads');

leads.get('/', { query: leadListQuery, summary: 'List leads (search, filters, sort, pagination)' }, async ({ ctx, query }) => {
  const where = buildLeadWhere(ctx, query);
  const orderBy = query.sort === 'name' ? [{ firstName: query.order }, { lastName: query.order }] : query.sort === 'company' ? [{ companyName: query.order }] : [{ [query.sort]: query.order }];
  const [total, rows] = await Promise.all([
    // exact for normal workspaces; ≤ 20 s old for very large ones (see lib/cache.ts) — the rows themselves are always live
    cachedForLarge(ctx.orgId, `lead-total:${hashKey(where)}`, () => db().lead.count({ where })),
    db().lead.findMany({ where, include: leadInclude, orderBy: orderBy as never, ...paginate(query) }),
  ]);
  return paged(await shapeLeads(ctx, rows), pageMeta(query, total));
});

leads.post('/', { perm: 'leads.create', body: leadSchema, summary: 'Create a lead (duplicate detection, auto-assignment, plan limit)' }, async ({ ctx, body }) => {
  const lead = await createLead(ctx, body);
  const full = await db().lead.findUniqueOrThrow({ where: { id: lead.id }, include: leadInclude });
  return created((await shapeLeads(ctx, [full]))[0]);
});

leads.post('/check-duplicates', { perm: ['leads.create', 'leads.update'], body: z.object({ email: z.string().optional(), phone: z.string().optional(), excludeId: z.string().uuid().optional() }), summary: 'Look for existing leads with the same email/phone' }, async ({ ctx, body }) => {
  const m = await findDuplicates(ctx.orgId, body.email, body.phone, body.excludeId);
  // Matches the caller cannot see are reported as a count only (no private details).
  const visible = await db().lead.findMany({ where: { id: { in: m.map((x) => x.id) }, organizationId: ctx.orgId, AND: [leadScope(ctx)] }, select: { id: true } });
  const vis = new Set(visible.map((v) => v.id));
  return { matches: m.filter((x) => vis.has(x.id)), hiddenMatches: m.filter((x) => !vis.has(x.id)).length };
});

leads.get('/duplicates', { perm: 'leads.merge', summary: 'Scan the workspace for duplicate lead groups' }, async ({ ctx }) => {
  const groups = await db().$queryRaw<{ kind: string; k: string; ids: string[] }[]>`
    SELECT 'email' AS kind, email_normalized AS k, array_agg(id::text ORDER BY created_at) AS ids FROM leads
      WHERE organization_id = ${ctx.orgId}::uuid AND archived_at IS NULL AND merged_into_id IS NULL AND email_normalized IS NOT NULL GROUP BY email_normalized HAVING count(*) > 1
    UNION ALL
    SELECT 'phone', phone_normalized, array_agg(id::text ORDER BY created_at) FROM leads
      WHERE organization_id = ${ctx.orgId}::uuid AND archived_at IS NULL AND merged_into_id IS NULL AND phone_normalized IS NOT NULL GROUP BY phone_normalized HAVING count(*) > 1
    LIMIT 100`;
  const ids = [...new Set(groups.flatMap((g) => g.ids))];
  const rows = await db().lead.findMany({ where: { id: { in: ids }, organizationId: ctx.orgId }, include: leadInclude });
  const map = new Map((await shapeLeads(ctx, rows)).map((l) => [l.id, l]));
  return groups.map((g) => ({ kind: g.kind, key: g.k, leads: g.ids.map((i) => map.get(i)).filter(Boolean) }));
});

leads.post('/merge', { perm: 'leads.merge', body: mergeSchema, summary: 'Merge a duplicate lead into another' }, async ({ ctx, body }) => {
  const r = await mergeLeads(ctx, body.sourceId, body.targetId, body.overrides ?? {});
  await audit(ctx, 'lead.merged', 'lead', body.targetId, { sourceId: body.sourceId, moved: r.moved });
  return { leadId: r.lead.id, moved: r.moved };
});

leads.post('/bulk', { perm: ['leads.update', 'leads.assign', 'leads.archive'], body: bulkSchema, summary: 'Bulk assign / status / archive / tag / priority (all-or-nothing validation)' }, async ({ ctx, body }) => {
  const ids = [...new Set(body.ids)];
  const need = body.action === 'assign' ? 'leads.assign' : body.action === 'archive' || body.action === 'restore' ? 'leads.archive' : 'leads.update';
  if (!ctx.can(need)) throw forbidden(`Missing permission: ${need}`, 'MISSING_PERMISSION');
  const found = await db().lead.findMany({ where: { id: { in: ids }, organizationId: ctx.orgId, AND: [leadScope(ctx)], ...(body.action === 'restore' ? {} : { archivedAt: null }) } });
  if (found.length !== ids.length) {
    const ok = new Set(found.map((f) => f.id));
    throw badRequest(`${ids.length - found.length} selected lead(s) are unavailable or outside your access. Nothing was changed.`, { invalidIds: ids.filter((i) => !ok.has(i)) }, 'BULK_VALIDATION_FAILED');
  }
  let affected = 0;
  if (body.action === 'assign') {
    if (body.assignedToId === undefined) throw badRequest('assignedToId is required');
    for (const l of found) { if (l.assignedToId !== body.assignedToId) { await assignLead(ctx, l, body.assignedToId, { method: 'BULK' }); affected++; } }
  } else if (body.action === 'status') {
    if (!body.status) throw badRequest('status is required');
    for (const l of found) { if (l.status !== 'CONVERTED') { await updateLead(ctx, l, { status: body.status, lostReasonId: body.lostReasonId }); affected++; } }
  } else if (body.action === 'archive') {
    for (const l of found) { await archiveLead(ctx, l); affected++; }
  } else if (body.action === 'restore') {
    for (const l of found) { if (l.archivedAt) { await restoreLead(ctx, l); affected++; } }
  } else if (body.action === 'tag') {
    if (!body.tagId) throw badRequest('tagId is required');
    if (!(await db().tag.findFirst({ where: { id: body.tagId, organizationId: ctx.orgId } }))) throw notFound('Tag');
    await db().leadTag.createMany({ data: found.map((l) => ({ organizationId: ctx.orgId, leadId: l.id, tagId: body.tagId! })), skipDuplicates: true });
    affected = found.length;
  } else if (body.action === 'priority') {
    if (!body.priorityId || !(await db().leadPriority.findFirst({ where: { id: body.priorityId, organizationId: ctx.orgId } }))) throw badRequest('Unknown priority');
    await db().lead.updateMany({ where: { id: { in: ids }, organizationId: ctx.orgId }, data: { priorityId: body.priorityId } });
    affected = found.length;
  }
  await audit(ctx, `lead.bulk_${body.action}`, 'lead', undefined, { count: ids.length, affected });
  return { requested: ids.length, affected };
});

leads.get('/import/template', { perm: 'leads.import', feature: 'import_export', summary: 'Download the CSV import template' }, async () => {
  const header = ['First Name', 'Last Name', 'Email', 'Phone', 'Company', 'Job Title', 'Source', 'Campaign', 'Priority', 'Tags', 'Assigned To (email)', 'Description'];
  return tabular('leadflow-import-template', header, [['Jane', 'Doe', 'jane@example.com', '+1 415 555 0100', 'Example Inc', 'Head of Sales', 'Website', 'Spring promo', 'Warm', 'vip; q2', '', 'Met at the spring expo']], 'csv');
});

leads.post('/import', { perm: 'leads.import', feature: 'import_export', upload: true, summary: 'Import leads from CSV/XLSX (multipart "file"; ?dryRun=true to validate only)' }, async ({ ctx, req }) => {
  if (!req.file) throw badRequest('Attach a CSV or Excel file in the "file" field');
  const opts = importOptions.parse(req.query);
  const result = await importLeads(ctx, req.file, opts);
  if (!opts.dryRun) await audit(ctx, 'lead.imported', 'lead', undefined, { file: req.file.originalname, created: result.created, failed: result.failed, skipped: result.skippedDuplicates });
  return result;
});

leads.get('/export', { perm: 'leads.export', feature: 'import_export', query: exportQuery, summary: 'Export leads (CSV or XLSX), honouring filters / selected ids' }, async ({ ctx, query }) => {
  const f = await exportLeads(ctx, query);
  await audit(ctx, 'lead.exported', 'lead', undefined, { format: query.format });
  return f;
});

leads.get('/:id', { summary: 'Lead detail' }, async ({ ctx, params }) => {
  const base = await getLeadOr404(ctx, params.id, { includeArchived: true });
  const full = await db().lead.findUniqueOrThrow({ where: { id: base.id }, include: leadInclude });
  const [shaped] = await shapeLeads(ctx, [full]);
  const [opps, openTasks, pendingFollowUps, lostReason] = await Promise.all([
    db().opportunity.findMany({ where: { leadId: base.id, organizationId: ctx.orgId, archivedAt: null }, include: { stage: true, pipeline: { select: { id: true, name: true } }, lostReason: true }, orderBy: { createdAt: 'desc' } }),
    db().task.count({ where: { leadId: base.id, organizationId: ctx.orgId, status: { in: ['TODO', 'IN_PROGRESS'] } } }),
    db().followUp.count({ where: { leadId: base.id, organizationId: ctx.orgId, status: 'PENDING' } }),
    base.lostReasonId ? db().lostReason.findUnique({ where: { id: base.lostReasonId } }) : null,
  ]);
  const owners = await usersById(opps.map((o) => o.ownerId));
  return {
    ...shaped, mergedIntoId: base.mergedIntoId, convertedAt: base.convertedAt, lostAt: base.lostAt, lostReason: lostReason ? { id: lostReason.id, name: lostReason.name } : null,
    opportunities: opps.map((o) => ({ id: o.id, name: o.name, value: Number(o.value), status: o.status, stage: { id: o.stage.id, name: o.stage.name, color: o.stage.color, kind: o.stage.kind }, pipeline: o.pipeline, expectedCloseDate: o.expectedCloseDate, owner: lite(owners, o.ownerId), createdAt: o.createdAt, wonAt: o.wonAt, lostAt: o.lostAt, lostReason: o.lostReason?.name ?? null })),
    counts: { openTasks, pendingFollowUps },
  };
});

leads.patch('/:id', { perm: 'leads.update', body: leadUpdateSchema, summary: 'Update a lead' }, async ({ ctx, params, body }) => {
  const lead = await getLeadOr404(ctx, params.id);
  await updateLead(ctx, lead, body);
  const full = await db().lead.findUniqueOrThrow({ where: { id: lead.id }, include: leadInclude });
  return (await shapeLeads(ctx, [full]))[0];
});

leads.post('/:id/archive', { perm: 'leads.archive', summary: 'Archive a lead (history is preserved)' }, async ({ ctx, params }) => {
  const lead = await getLeadOr404(ctx, params.id);
  await archiveLead(ctx, lead);
  await audit(ctx, 'lead.archived', 'lead', lead.id);
  return { archived: true };
});
leads.post('/:id/restore', { perm: 'leads.archive', summary: 'Restore an archived lead' }, async ({ ctx, params }) => {
  const lead = await getLeadOr404(ctx, params.id, { includeArchived: true });
  if (!lead.archivedAt) return { restored: true };
  await restoreLead(ctx, lead);
  await audit(ctx, 'lead.restored', 'lead', lead.id);
  return { restored: true };
});

leads.post('/:id/assign', { perm: 'leads.assign', body: assignSchema, summary: 'Assign / reassign / unassign a lead' }, async ({ ctx, params, body }) => {
  const lead = await getLeadOr404(ctx, params.id);
  await assignLead(ctx, lead, body.assignedToId, { note: body.note ?? null });
  return { assignedToId: body.assignedToId };
});

leads.get('/:id/assignments', { summary: 'Assignment history' }, async ({ ctx, params }) => {
  const lead = await getLeadOr404(ctx, params.id, { includeArchived: true });
  const rows = await db().leadAssignment.findMany({ where: { leadId: lead.id, organizationId: ctx.orgId }, orderBy: { createdAt: 'desc' } });
  const u = await usersById(rows.flatMap((r) => [r.fromUserId, r.toUserId, r.assignedById]));
  return rows.map((r) => ({ id: r.id, from: lite(u, r.fromUserId), to: lite(u, r.toUserId), assignedBy: lite(u, r.assignedById), method: r.method, note: r.note, createdAt: r.createdAt }));
});

leads.get('/:id/activities', { query: z.object({ ...pageQuery, type: z.string().optional() }), summary: 'Chronological activity timeline' }, async ({ ctx, params, query }) => {
  const lead = await getLeadOr404(ctx, params.id, { includeArchived: true });
  const where = { leadId: lead.id, organizationId: ctx.orgId, ...(query.type ? { type: { in: query.type.split(',') as never } } : {}) };
  const [total, rows] = await Promise.all([
    db().activity.count({ where }),
    db().activity.findMany({ where, orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }], ...paginate(query) }),
  ]);
  const u = await usersById(rows.map((r) => r.actorId));
  return paged(rows.map((r) => ({ id: r.id, type: r.type, title: r.title, body: r.body, metadata: r.metadata, actor: lite(u, r.actorId), occurredAt: r.occurredAt, createdAt: r.createdAt })), pageMeta(query, total));
});

leads.post('/:id/activities', { perm: 'leads.update', body: activityLogSchema, summary: 'Manually log a call / email / WhatsApp / meeting / note' }, async ({ ctx, params, body }) => {
  const lead = await getLeadOr404(ctx, params.id);
  if (body.occurredAt && body.occurredAt.getTime() > Date.now() + 5 * 60_000) throw badRequest('The interaction time cannot be in the future', { fields: { occurredAt: 'Cannot be in the future' } });
  const label = { CALL: 'Call', EMAIL: 'Email', WHATSAPP: 'WhatsApp', MEETING: 'Meeting', NOTE: 'Note' }[body.type];
  const a = await logActivity({
    leadId: lead.id, type: body.type, title: body.title ?? (body.type === 'NOTE' ? 'Note added' : `${label} logged`), body: body.body ?? null, occurredAt: body.occurredAt,
    metadata: { direction: body.direction ?? null, durationMinutes: body.durationMinutes ?? null, manual: true },
  });
  return created({ id: a.id });
});

leads.get('/:id/followups', { summary: 'Follow-up history for a lead' }, async ({ ctx, params }) => {
  const lead = await getLeadOr404(ctx, params.id, { includeArchived: true });
  const rows = await db().followUp.findMany({ where: { leadId: lead.id, organizationId: ctx.orgId }, orderBy: { dueAt: 'desc' }, take: 200 });
  const u = await usersById(rows.flatMap((r) => [r.assignedToId, r.completedById]));
  const now = Date.now();
  return rows.map((r) => ({ ...r, assignedTo: lite(u, r.assignedToId), completedBy: lite(u, r.completedById), isOverdue: r.status === 'PENDING' && r.dueAt.getTime() < now }));
});

void [Reply, fullName, notify, emitTrigger];
