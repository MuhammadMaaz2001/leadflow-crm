import type { Lead, Prisma } from '@leadflow/database';
import { fullName, normalizeEmail, normalizePhone, type LeadInput } from '@leadflow/shared';
import { z } from 'zod';
import { db } from '../../db';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import type { Ctx } from '../../http';
import { logActivity } from '../activities/service';
import { emitTrigger } from '../automations/events';
import { notify } from '../notifications/service';
import { assertLeadCapacity } from '../subscriptions/service';
import { usersById } from '../../lib/users';

/** Row-level visibility inside a workspace: members without "view all" only see their own leads. */
export function leadScope(ctx: Ctx): Prisma.LeadWhereInput {
  return ctx.can('leads.view_all') ? {} : { OR: [{ assignedToId: ctx.userId }, { createdById: ctx.userId }] };
}

export async function getLeadOr404(ctx: Ctx, id: string, opts: { includeArchived?: boolean } = {}): Promise<Lead> {
  const lead = await db().lead.findFirst({
    where: { id, organizationId: ctx.orgId, ...(opts.includeArchived ? {} : { archivedAt: null }), AND: [leadScope(ctx)] },
  });
  if (!lead) throw notFound('Lead');
  return lead;
}

export async function assertActiveMember(ctx: Pick<Ctx, 'orgId'>, userId: string, label = 'User') {
  const m = await db().membership.findFirst({ where: { organizationId: ctx.orgId, userId, status: 'ACTIVE' } });
  if (!m) throw badRequest(`${label} is not an active member of this workspace`, { fields: { assignedToId: `${label} is not an active member` } }, 'INVALID_ASSIGNEE');
  return m;
}

async function assertRefs(ctx: Ctx, input: { sourceId?: string | null; priorityId?: string | null; tagIds?: string[] }) {
  if (input.sourceId && !(await db().leadSource.findFirst({ where: { id: input.sourceId, organizationId: ctx.orgId } }))) throw badRequest('Unknown lead source', { fields: { sourceId: 'Unknown lead source' } });
  if (input.priorityId && !(await db().leadPriority.findFirst({ where: { id: input.priorityId, organizationId: ctx.orgId } }))) throw badRequest('Unknown priority', { fields: { priorityId: 'Unknown priority' } });
  if (input.tagIds?.length) {
    const n = await db().tag.count({ where: { id: { in: input.tagIds }, organizationId: ctx.orgId } });
    if (n !== new Set(input.tagIds).size) throw badRequest('One or more tags do not exist', { fields: { tagIds: 'Unknown tag' } });
  }
}

type CustomDef = { key: string; label: string; type: string; options: string[]; required: boolean };
/**
 * Validates and normalises custom field values against the workspace's active field definitions. Nothing is silently cut or
 * coerced: wrong types, out-of-range dates, unknown dropdown options and over-long text are rejected with a field-level message.
 * Pass `defs` when validating many rows (imports) to avoid one query per row.
 */
export async function validateCustomFields(ctx: Ctx, values: Record<string, unknown> | undefined, partial = false, defs?: CustomDef[]) {
  const fields = defs ?? await db().customFieldDef.findMany({ where: { organizationId: ctx.orgId, isActive: true } });
  const out: Record<string, string | number | boolean | null> = {};
  const errors: Record<string, string> = {};
  for (const d of fields) {
    const raw = values?.[d.key];
    const empty = raw === undefined || raw === null || raw === '';
    const err = (m: string) => { errors[`customFields.${d.key}`] = m; };
    if (empty) {
      if (d.required && !partial) err(`${d.label} is required`);
      if (values && d.key in values) out[d.key] = null;
      continue;
    }
    if (d.type === 'NUMBER') {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, '').trim());
      if (!Number.isFinite(n) || String(raw).trim() === '') err(`${d.label} must be a number`); else if (Math.abs(n) > 1e15) err(`${d.label} is out of range`); else out[d.key] = n;
    } else if (d.type === 'BOOLEAN') {
      const v = String(raw).trim().toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(v)) out[d.key] = true; else if (['false', 'no', 'n', '0'].includes(v)) out[d.key] = false; else err(`${d.label} must be yes or no`);
    } else if (d.type === 'DATE') {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw).trim());
      const dt = m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)) : null;
      if (!m || !dt || dt.getUTCFullYear() !== +m[1]! || dt.getUTCMonth() !== +m[2]! - 1 || dt.getUTCDate() !== +m[3]! || +m[1]! < 1900 || +m[1]! > 2200) err(`${d.label} must be a valid date (YYYY-MM-DD)`); else out[d.key] = `${m[1]}-${m[2]}-${m[3]}`;
    } else if (d.type === 'SELECT') {
      const v = String(raw).trim();
      const match = d.options.find((o) => o.toLowerCase() === v.toLowerCase());
      if (!match) err(`${d.label}: choose one of ${d.options.join(', ')}`); else out[d.key] = match;
    } else {
      const v = String(raw).trim();
      if (v.length > 500) err(`${d.label} is too long (${v.length} of 500 characters)`); else out[d.key] = v;
    }
  }
  if (Object.keys(errors).length) throw badRequest('Some custom fields are invalid', { fields: errors }, 'VALIDATION_ERROR');
  return out;
}

export interface DuplicateMatch { id: string; name: string; email: string | null; phone: string | null; assignedToId: string | null; reasons: string[] }

export async function findDuplicates(orgId: string, email?: string | null, phone?: string | null, excludeId?: string): Promise<DuplicateMatch[]> {
  const e = normalizeEmail(email), p = normalizePhone(phone);
  if (!e && !p) return [];
  const rows = await db().lead.findMany({
    where: { organizationId: orgId, archivedAt: null, mergedIntoId: null, ...(excludeId ? { id: { not: excludeId } } : {}), OR: [...(e ? [{ emailNormalized: e }] : []), ...(p ? [{ phoneNormalized: p }] : [])] },
    take: 10,
  });
  return rows.map((r) => ({
    id: r.id, name: fullName(r), email: r.email, phone: r.phone, assignedToId: r.assignedToId,
    reasons: [...(e && r.emailNormalized === e ? ['email'] : []), ...(p && r.phoneNormalized === p ? ['phone'] : [])],
  }));
}

// ── assignment ──
export async function pickAssignee(ctx: Ctx, lead: { sourceId?: string | null; priorityId?: string | null; campaign?: string | null; companyName?: string | null }): Promise<{ userId: string; method: string } | null> {
  const mode = ctx.org.autoAssignMode;
  if (mode === 'NONE') return null;
  const eligible = await db().membership.findMany({ where: { organizationId: ctx.orgId, status: 'ACTIVE', isAssignable: true }, orderBy: { joinedAt: 'asc' }, select: { userId: true } });
  const eligibleIds = eligible.map((e) => e.userId);
  if (mode === 'ROUND_ROBIN') {
    if (!eligibleIds.length) return null;
    const [row] = await db().$queryRaw<{ rr_cursor: number }[]>`UPDATE organizations SET rr_cursor = rr_cursor + 1 WHERE id = ${ctx.orgId}::uuid RETURNING rr_cursor`;
    return { userId: eligibleIds[((row?.rr_cursor ?? 1) - 1) % eligibleIds.length]!, method: 'ROUND_ROBIN' };
  }
  const rules = await db().assignmentRule.findMany({ where: { organizationId: ctx.orgId, isActive: true }, orderBy: { position: 'asc' } });
  for (const r of rules) {
    const c = (r.conditions ?? {}) as { sourceIds?: string[]; priorityIds?: string[]; campaignContains?: string; companyContains?: string };
    if (c.sourceIds?.length && !(lead.sourceId && c.sourceIds.includes(lead.sourceId))) continue;
    if (c.priorityIds?.length && !(lead.priorityId && c.priorityIds.includes(lead.priorityId))) continue;
    if (c.campaignContains && !(lead.campaign ?? '').toLowerCase().includes(c.campaignContains.toLowerCase())) continue;
    if (c.companyContains && !(lead.companyName ?? '').toLowerCase().includes(c.companyContains.toLowerCase())) continue;
    const pool = r.assigneeIds.filter((id) => eligibleIds.includes(id));
    if (!pool.length) continue;
    const [row] = await db().$queryRaw<{ cursor: number }[]>`UPDATE assignment_rules SET cursor = cursor + 1 WHERE id = ${r.id}::uuid RETURNING cursor`;
    return { userId: pool[((row?.cursor ?? 1) - 1) % pool.length]!, method: 'RULE' };
  }
  return null;
}

export async function assignLead(ctx: Ctx, lead: Lead, toUserId: string | null, opts: { method?: string; note?: string | null; silent?: boolean } = {}) {
  if (lead.assignedToId === toUserId) return lead;
  if (toUserId) await assertActiveMember(ctx, toUserId, 'Assignee');
  const method = opts.method ?? 'MANUAL';
  const updated = await db().lead.update({ where: { id: lead.id }, data: { assignedToId: toUserId, assignedAt: toUserId ? new Date() : null, lastActivityAt: new Date() } });
  await db().leadAssignment.create({ data: { organizationId: ctx.orgId, leadId: lead.id, fromUserId: lead.assignedToId, toUserId, assignedById: ctx.userId, method, note: opts.note ?? null } });
  const names = await usersById([toUserId, lead.assignedToId]);
  const toName = toUserId ? names.get(toUserId)?.name ?? 'user' : null;
  const reassign = !!lead.assignedToId;
  await logActivity({
    leadId: lead.id, type: reassign ? 'LEAD_REASSIGNED' : 'LEAD_ASSIGNED',
    title: toUserId ? (reassign ? `Reassigned from ${names.get(lead.assignedToId!)?.name ?? 'previous owner'} to ${toName}` : `Assigned to ${toName}`) : `Unassigned (was ${names.get(lead.assignedToId!)?.name ?? 'owner'})`,
    body: opts.note ?? null, metadata: { from: lead.assignedToId, to: toUserId, method },
  });
  if (!opts.silent) {
    if (toUserId) {
      await notify({ userIds: [toUserId], type: reassign ? 'LEAD_REASSIGNED' : 'LEAD_ASSIGNED', title: reassign ? `Lead reassigned to you: ${fullName(lead)}` : `New lead assigned: ${fullName(lead)}`, body: lead.companyName ?? undefined, link: `/leads/${lead.id}`, entityType: 'lead', entityId: lead.id, exceptUserId: ctx.userId });
    }
    if (reassign && lead.assignedToId && lead.assignedToId !== toUserId) {
      await notify({ userIds: [lead.assignedToId], type: 'LEAD_REASSIGNED', title: `Lead reassigned away from you: ${fullName(lead)}`, link: `/leads/${lead.id}`, entityType: 'lead', entityId: lead.id, exceptUserId: ctx.userId });
    }
    if (toUserId) await emitTrigger('LEAD_ASSIGNED', { type: 'lead', id: lead.id, leadId: lead.id }, `LEAD_ASSIGNED:${lead.id}:${toUserId}:${Date.now()}`);
  }
  return updated;
}

// ── create / update ──
export async function createLead(ctx: Ctx, input: LeadInput, opts: { method?: string; skipCapacity?: boolean } = {}) {
  await assertRefs(ctx, input);
  if (!opts.skipCapacity) await assertLeadCapacity(ctx, 1);
  const custom = await validateCustomFields(ctx, input.customFields);
  if (!input.allowDuplicate) {
    const dups = await findDuplicates(ctx.orgId, input.email, input.phone);
    if (dups.length) throw conflict('A lead with the same email or phone already exists', { matches: dups }, 'DUPLICATE_LEAD');
  }
  let assignedToId = input.assignedToId ?? null;
  if (assignedToId && assignedToId !== ctx.userId && !ctx.can('leads.assign')) throw forbidden('You can only assign leads to yourself', 'MISSING_PERMISSION');
  let method = opts.method ?? 'MANUAL';
  if (!assignedToId && !ctx.can('leads.view_all')) assignedToId = ctx.userId; // agents own what they create
  if (!assignedToId) {
    const pick = await pickAssignee(ctx, input);
    if (pick) { assignedToId = pick.userId; method = pick.method; }
  }
  if (assignedToId) await assertActiveMember(ctx, assignedToId, 'Assignee');
  const priorityId = input.priorityId ?? (await db().leadPriority.findFirst({ where: { organizationId: ctx.orgId, name: 'Warm' } }))?.id ?? null;
  const lead = await db().lead.create({
    data: {
      organizationId: ctx.orgId, firstName: input.firstName.trim(), lastName: input.lastName ?? null,
      email: input.email?.trim() ?? null, emailNormalized: normalizeEmail(input.email), phone: input.phone?.trim() ?? null, phoneNormalized: normalizePhone(input.phone),
      companyName: input.companyName ?? null, jobTitle: input.jobTitle ?? null, sourceId: input.sourceId ?? null, campaign: input.campaign ?? null,
      priorityId, description: input.description ?? null, customFields: custom, createdById: ctx.userId,
      assignedToId, assignedAt: assignedToId ? new Date() : null,
    },
  });
  if (input.tagIds?.length) await db().leadTag.createMany({ data: [...new Set(input.tagIds)].map((tagId) => ({ organizationId: ctx.orgId, leadId: lead.id, tagId })) });
  await logActivity({ leadId: lead.id, type: 'LEAD_CREATED', title: 'Lead created', metadata: { sourceId: lead.sourceId } });
  if (assignedToId) {
    await db().leadAssignment.create({ data: { organizationId: ctx.orgId, leadId: lead.id, toUserId: assignedToId, assignedById: ctx.userId, method } });
    const names = await usersById([assignedToId]);
    await logActivity({ leadId: lead.id, type: 'LEAD_ASSIGNED', title: `Assigned to ${names.get(assignedToId)?.name ?? 'user'}`, metadata: { to: assignedToId, method } });
    await notify({ userIds: [assignedToId], type: 'LEAD_ASSIGNED', title: `New lead assigned: ${fullName(lead)}`, body: lead.companyName ?? undefined, link: `/leads/${lead.id}`, entityType: 'lead', entityId: lead.id, exceptUserId: ctx.userId });
    await emitTrigger('LEAD_ASSIGNED', { type: 'lead', id: lead.id, leadId: lead.id }, `LEAD_ASSIGNED:${lead.id}:${assignedToId}:init`);
  }
  await emitTrigger('LEAD_CREATED', { type: 'lead', id: lead.id, leadId: lead.id });
  return lead;
}

const TRACKED: Array<keyof Lead> = ['firstName', 'lastName', 'email', 'phone', 'companyName', 'jobTitle', 'sourceId', 'campaign', 'priorityId', 'description', 'status'];

export async function updateLead(ctx: Ctx, lead: Lead, input: z.infer<typeof import('@leadflow/shared').leadUpdateSchema>) {
  await assertRefs(ctx, input);
  const data: Prisma.LeadUncheckedUpdateInput = {};
  const { tagIds, customFields, status, lostReasonId, ...rest } = input;
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) (data as Record<string, unknown>)[k] = v;
  const nextEmail = 'email' in rest && rest.email !== undefined ? rest.email : lead.email;
  const nextPhone = 'phone' in rest && rest.phone !== undefined ? rest.phone : lead.phone;
  if (!nextEmail && !nextPhone) throw badRequest('A lead needs at least an email or a phone number', { fields: { email: 'Provide an email or phone' } });
  if ('email' in rest && rest.email !== undefined) data.emailNormalized = normalizeEmail(rest.email);
  if ('phone' in rest && rest.phone !== undefined) data.phoneNormalized = normalizePhone(rest.phone);
  if (customFields) data.customFields = { ...(lead.customFields as object), ...(await validateCustomFields(ctx, customFields, true)) };
  if (status && status !== lead.status) {
    if (lead.status === 'CONVERTED') throw conflict('This lead is converted (won). Change its opportunities instead.', undefined, 'LEAD_CONVERTED');
    data.status = status;
    if (status === 'LOST') {
      if (!lostReasonId) throw badRequest('Select a lost reason', { fields: { lostReasonId: 'Select a lost reason' } });
      const reason = await db().lostReason.findFirst({ where: { id: lostReasonId, organizationId: ctx.orgId } });
      if (!reason) throw badRequest('Unknown lost reason');
      data.lostAt = new Date(); data.lostReasonId = lostReasonId;
    } else { data.lostAt = null; data.lostReasonId = null; }
  }
  const updated = await db().lead.update({ where: { id: lead.id }, data: { ...data, lastActivityAt: new Date() } });
  if (tagIds) {
    await db().leadTag.deleteMany({ where: { leadId: lead.id, organizationId: ctx.orgId } });
    if (tagIds.length) await db().leadTag.createMany({ data: [...new Set(tagIds)].map((tagId) => ({ organizationId: ctx.orgId, leadId: lead.id, tagId })) });
  }
  const changes: Record<string, [unknown, unknown]> = {};
  for (const k of TRACKED) if (updated[k] !== lead[k]) changes[k] = [lead[k], updated[k]];
  if (tagIds) changes.tags = [null, tagIds.length];
  if (customFields) changes.customFields = [null, Object.keys(customFields).length];
  if (status && status !== lead.status) {
    await logActivity({ leadId: lead.id, type: 'STATUS_CHANGED', title: `Status changed to ${status.toLowerCase()}`, metadata: { from: lead.status, to: status, lostReasonId: lostReasonId ?? null } });
  }
  const rest2 = Object.keys(changes).filter((k) => k !== 'status');
  if (rest2.length) await logActivity({ leadId: lead.id, type: 'LEAD_UPDATED', title: `Updated ${rest2.map(humanize).join(', ')}`, metadata: { changes } as never });
  return updated;
}
const humanize = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/Id$/, '').toLowerCase().trim();

export async function archiveLead(ctx: Ctx, lead: Lead) {
  const u = await db().lead.update({ where: { id: lead.id }, data: { archivedAt: new Date() } });
  await logActivity({ leadId: lead.id, type: 'LEAD_ARCHIVED', title: 'Lead archived' });
  return u;
}
export async function restoreLead(ctx: Ctx, lead: Lead) {
  if (lead.mergedIntoId) throw conflict('This lead was merged into another lead and cannot be restored.', undefined, 'LEAD_MERGED');
  await assertLeadCapacity(ctx, 1);
  const u = await db().lead.update({ where: { id: lead.id }, data: { archivedAt: null } });
  await logActivity({ leadId: lead.id, type: 'LEAD_RESTORED', title: 'Lead restored' });
  return u;
}

export async function mergeLeads(ctx: Ctx, sourceId: string, targetId: string, overrides: Record<string, unknown> = {}) {
  if (sourceId === targetId) throw badRequest('Choose two different leads to merge');
  const [source, target] = await Promise.all([getLeadOr404(ctx, sourceId), getLeadOr404(ctx, targetId)]);
  const fill: Prisma.LeadUncheckedUpdateInput = {};
  for (const k of ['email', 'phone', 'companyName', 'jobTitle', 'sourceId', 'campaign', 'priorityId', 'description', 'assignedToId'] as const) {
    const useSource = overrides[k] === 'source' || (target[k] == null && source[k] != null);
    if (useSource) (fill as Record<string, unknown>)[k] = source[k];
  }
  if (fill.email) fill.emailNormalized = normalizeEmail(fill.email as string);
  if (fill.phone) fill.phoneNormalized = normalizePhone(fill.phone as string);
  if (!target.assignedToId && source.assignedToId) fill.assignedAt = source.assignedAt;
  fill.customFields = { ...(source.customFields as object), ...(target.customFields as object) };
  const earliest = [source.firstContactedAt, target.firstContactedAt].filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const moved = {
    activities: (await db().activity.updateMany({ where: { leadId: source.id, organizationId: ctx.orgId }, data: { leadId: target.id } })).count,
    followUps: (await db().followUp.updateMany({ where: { leadId: source.id, organizationId: ctx.orgId }, data: { leadId: target.id } })).count,
    tasks: (await db().task.updateMany({ where: { leadId: source.id, organizationId: ctx.orgId }, data: { leadId: target.id } })).count,
    opportunities: (await db().opportunity.updateMany({ where: { leadId: source.id, organizationId: ctx.orgId }, data: { leadId: target.id } })).count,
    attachments: (await db().leadAttachment.updateMany({ where: { leadId: source.id, organizationId: ctx.orgId }, data: { leadId: target.id } })).count,
  };
  const srcTags = await db().leadTag.findMany({ where: { leadId: source.id, organizationId: ctx.orgId } });
  if (srcTags.length) await db().leadTag.createMany({ data: srcTags.map((t) => ({ organizationId: ctx.orgId, leadId: target.id, tagId: t.tagId })), skipDuplicates: true });
  await db().leadTag.deleteMany({ where: { leadId: source.id, organizationId: ctx.orgId } });
  const merged = await db().lead.update({ where: { id: target.id }, data: { ...fill, firstContactedAt: earliest, lastActivityAt: new Date() } });
  await db().lead.update({ where: { id: source.id }, data: { archivedAt: new Date(), mergedIntoId: target.id } });
  await logActivity({ leadId: target.id, type: 'LEAD_MERGED', title: `Merged duplicate lead "${fullName(source)}"`, metadata: { sourceId: source.id, moved } });
  await db().leadAssignment.create({ data: { organizationId: ctx.orgId, leadId: target.id, toUserId: merged.assignedToId, assignedById: ctx.userId, method: 'MERGE', note: `Merged from ${fullName(source)}` } });
  return { lead: merged, moved };
}

/** Recompute lead lifecycle status from its opportunities (called after opportunity state changes). */
export async function syncLeadFromOpportunities(leadId: string) {
  const lead = await db().lead.findUnique({ where: { id: leadId } });
  if (!lead) return;
  const opps = await db().opportunity.findMany({ where: { leadId, archivedAt: null }, select: { status: true, wonAt: true } });
  if (!opps.length) return;
  const won = opps.filter((o) => o.status === 'WON');
  const open = opps.filter((o) => o.status === 'OPEN');
  let status = lead.status;
  const data: Prisma.LeadUncheckedUpdateInput = {};
  if (won.length) {
    status = 'CONVERTED';
    data.convertedAt = lead.convertedAt ?? won.map((o) => o.wonAt!).sort((a, b) => a.getTime() - b.getTime())[0];
    data.lostAt = null; data.lostReasonId = null;
  } else if (open.length) {
    if (lead.status === 'CONVERTED' || lead.status === 'LOST' || lead.status === 'NEW' || lead.status === 'CONTACTED') status = 'QUALIFIED';
    if (lead.status === 'CONVERTED') data.convertedAt = null;
    data.lostAt = null; data.lostReasonId = null;
  } else {
    status = 'LOST'; data.lostAt = lead.lostAt ?? new Date();
    if (lead.status === 'CONVERTED') data.convertedAt = null;
  }
  if (status !== lead.status || Object.keys(data).length) await db().lead.update({ where: { id: leadId }, data: { ...data, status } });
  return { previous: lead.status, next: status };
}

export { AppError };
