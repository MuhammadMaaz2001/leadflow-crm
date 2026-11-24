import { followUpCancelSchema, followUpCompleteSchema, followUpRescheduleSchema, followUpSchema, followUpUpdateSchema, fullName } from '@leadflow/shared';
import { z } from 'zod';
import type { Prisma } from '@leadflow/database';
import { db } from '../../db';
import { created, defineRoutes, paged } from '../../http';
import { csvEnum, csvUuids, pageMeta, paginate, pageQuery } from '../../lib/pagination';
import { addDaysSafe, resolveRange } from '../../lib/dates-util';
import { lite, usersById } from '../../lib/users';
import { notify } from '../notifications/service';
import { assertActiveMember } from '../leads/service';
import { cancelFollowUp, completeFollowUp, followUpScope, getFollowUpOr404, rescheduleFollowUp, scheduleFollowUp, typeLabel } from './service';

export const followups = defineRoutes('Follow-ups', '');

const listQuery = z.object({
  ...pageQuery, view: z.enum(['today', 'upcoming', 'overdue', 'completed', 'canceled', 'pending', 'all']).default('pending'),
  assignedToId: csvUuids('me'), leadId: z.string().uuid().optional(), type: csvEnum(['CALL', 'WHATSAPP', 'EMAIL', 'MEETING', 'VIDEO_CALL', 'OTHER']), priority: csvEnum(['LOW', 'MEDIUM', 'HIGH']), q: z.string().trim().max(100).optional(),
  from: z.coerce.date().optional(), to: z.coerce.date().optional(),
});

function viewWhere(view: string, tz: string): Prisma.FollowUpWhereInput {
  const now = new Date();
  const today = resolveRange('today', tz);
  switch (view) {
    case 'today': return { status: 'PENDING', dueAt: { gte: today.from, lt: today.to } };
    case 'upcoming': return { status: 'PENDING', dueAt: { gte: today.to } };
    case 'overdue': return { status: 'PENDING', dueAt: { lt: now } };
    case 'completed': return { status: 'COMPLETED' };
    case 'canceled': return { status: 'CANCELED' };
    case 'pending': return { status: 'PENDING' };
    default: return {};
  }
}

const leadSel = { select: { id: true, firstName: true, lastName: true, companyName: true, phone: true, email: true } } as const;

followups.get('/followups', { query: listQuery, summary: 'List follow-ups (today / upcoming / overdue / history)' }, async ({ ctx, query }) => {
  const and: Prisma.FollowUpWhereInput[] = [followUpScope(ctx), viewWhere(query.view, ctx.org.timezone)];
  if (query.assignedToId?.length) and.push({ assignedToId: { in: query.assignedToId.map((i) => (i === 'me' ? ctx.userId : i)) } });
  if (query.type?.length) and.push({ type: { in: query.type as never } });
  if (query.priority?.length) and.push({ priority: { in: query.priority as never } });
  if (query.from) and.push({ dueAt: { gte: query.from } });
  if (query.to) and.push({ dueAt: { lte: query.to } });
  if (query.q) and.push({ lead: { OR: [{ firstName: { contains: query.q, mode: 'insensitive' } }, { lastName: { contains: query.q, mode: 'insensitive' } }, { companyName: { contains: query.q, mode: 'insensitive' } }] } });
  const where: Prisma.FollowUpWhereInput = { organizationId: ctx.orgId, ...(query.leadId ? { leadId: query.leadId } : {}), AND: and };
  const desc = query.view === 'completed' || query.view === 'canceled';
  const [total, rows] = await Promise.all([
    db().followUp.count({ where }),
    db().followUp.findMany({ where, include: { lead: leadSel }, orderBy: { dueAt: desc ? 'desc' : 'asc' }, ...paginate(query) }),
  ]);
  const u = await usersById(rows.flatMap((r) => [r.assignedToId, r.completedById]));
  const now = Date.now();
  return paged(rows.map((r) => ({
    id: r.id, type: r.type, title: r.title, dueAt: r.dueAt, priority: r.priority, notes: r.notes, status: r.status, outcome: r.outcome, outcomeNotes: r.outcomeNotes,
    completedAt: r.completedAt, rescheduleCount: r.rescheduleCount, isOverdue: r.status === 'PENDING' && r.dueAt.getTime() < now,
    lead: { id: r.lead.id, name: fullName(r.lead), companyName: r.lead.companyName, phone: r.lead.phone, email: r.lead.email },
    assignedTo: lite(u, r.assignedToId), completedBy: lite(u, r.completedById), createdAt: r.createdAt,
  })), pageMeta(query, total));
});

followups.get('/followups/summary', { query: z.object({ assignedToId: z.union([z.literal('me'), z.string().uuid()]).optional() }), summary: 'Follow-up counters (overdue / today / upcoming / completed today)' }, async ({ ctx, query }) => {
  const today = resolveRange('today', ctx.org.timezone);
  const base: Prisma.FollowUpWhereInput = { organizationId: ctx.orgId, AND: [followUpScope(ctx), ...(query.assignedToId ? [{ assignedToId: query.assignedToId === 'me' ? ctx.userId : query.assignedToId }] : [])] };
  const now = new Date();
  const [overdue, dueToday, upcoming, completedToday] = await Promise.all([
    db().followUp.count({ where: { ...base, status: 'PENDING', dueAt: { lt: now } } }),
    db().followUp.count({ where: { ...base, status: 'PENDING', dueAt: { gte: today.from, lt: today.to } } }),
    db().followUp.count({ where: { ...base, status: 'PENDING', dueAt: { gte: today.to, lt: addDaysSafe(today.to, 7) } } }),
    db().followUp.count({ where: { ...base, status: 'COMPLETED', completedAt: { gte: today.from, lt: today.to } } }),
  ]);
  return { overdue, dueToday, upcoming, completedToday };
});

followups.post('/followups', { perm: 'followups.manage', body: followUpSchema, summary: 'Schedule a follow-up' }, async ({ ctx, body }) => {
  const f = await scheduleFollowUp(ctx, body);
  return created({ id: f.id, dueAt: f.dueAt });
});

followups.get('/followups/:id', { summary: 'Follow-up detail with full history' }, async ({ ctx, params }) => {
  const f = await getFollowUpOr404(ctx, params.id);
  const [lead, events] = await Promise.all([
    db().lead.findUniqueOrThrow({ where: { id: f.leadId }, select: leadSel.select }),
    db().followUpEvent.findMany({ where: { followUpId: f.id, organizationId: ctx.orgId }, orderBy: { createdAt: 'asc' } }),
  ]);
  const u = await usersById([f.assignedToId, f.createdById, f.completedById, ...events.map((e) => e.actorId)]);
  return {
    ...f, lead: { id: lead.id, name: fullName(lead), companyName: lead.companyName, phone: lead.phone, email: lead.email },
    assignedTo: lite(u, f.assignedToId), createdBy: lite(u, f.createdById), completedBy: lite(u, f.completedById),
    isOverdue: f.status === 'PENDING' && f.dueAt.getTime() < Date.now(),
    events: events.map((e) => ({ id: e.id, type: e.type, fromDueAt: e.fromDueAt, toDueAt: e.toDueAt, note: e.note, actor: lite(u, e.actorId), createdAt: e.createdAt })),
  };
});

followups.patch('/followups/:id', { perm: 'followups.manage', body: followUpUpdateSchema, summary: 'Edit / reassign a pending follow-up' }, async ({ ctx, params, body }) => {
  const f = await getFollowUpOr404(ctx, params.id);
  if (f.status !== 'PENDING') throw new (await import('../../lib/errors')).AppError(400, 'NOT_PENDING', 'Only pending follow-ups can be edited.');
  if (body.assignedToId && body.assignedToId !== f.assignedToId) {
    await assertActiveMember(ctx, body.assignedToId, 'Assignee');
    await db().followUpEvent.create({ data: { organizationId: ctx.orgId, followUpId: f.id, type: 'REASSIGNED', actorId: ctx.userId, note: `Reassigned` } });
    await notify({ userIds: [body.assignedToId], type: 'REMINDER', title: `Follow-up assigned to you: ${typeLabel(f.type)}`, link: `/leads/${f.leadId}`, entityType: 'followup', entityId: f.id, exceptUserId: ctx.userId });
  }
  await db().followUp.update({ where: { id: f.id }, data: body });
  return { id: f.id };
});

followups.post('/followups/:id/complete', { perm: 'followups.manage', body: followUpCompleteSchema, summary: 'Complete with a recorded outcome (never silent); optionally schedule the next one' }, async ({ ctx, params, body }) => {
  const f = await getFollowUpOr404(ctx, params.id);
  const r = await completeFollowUp(ctx, f, body);
  return { id: r.followUp.id, completedAt: r.followUp.completedAt, nextFollowUpId: r.next?.id ?? null };
});
followups.post('/followups/:id/reschedule', { perm: 'followups.manage', body: followUpRescheduleSchema, summary: 'Reschedule (history is preserved)' }, async ({ ctx, params, body }) => {
  const f = await getFollowUpOr404(ctx, params.id);
  const u = await rescheduleFollowUp(ctx, f, body.dueAt, body.reason);
  return { id: u.id, dueAt: u.dueAt };
});
followups.post('/followups/:id/cancel', { perm: 'followups.manage', body: followUpCancelSchema, summary: 'Cancel a follow-up' }, async ({ ctx, params, body }) => {
  const f = await getFollowUpOr404(ctx, params.id);
  await cancelFollowUp(ctx, f, body.reason);
  return { canceled: true };
});

// ── Calendar: follow-ups + tasks as events ──
followups.get('/calendar', { query: z.object({ from: z.coerce.date(), to: z.coerce.date(), assignedToId: z.union([z.literal('me'), z.string().uuid()]).optional(), kinds: z.string().optional() }), summary: 'Calendar events (follow-ups and tasks) for a date window' }, async ({ ctx, query }) => {
  if (query.to.getTime() - query.from.getTime() > 100 * 86_400_000) throw new (await import('../../lib/errors')).AppError(400, 'RANGE_TOO_LARGE', 'Choose a window of at most 100 days');
  const kinds = (query.kinds ?? 'followup,task').split(',');
  const assignee = query.assignedToId ? (query.assignedToId === 'me' ? ctx.userId : query.assignedToId) : undefined;
  const now = Date.now();
  const [fus, tasks] = await Promise.all([
    kinds.includes('followup') ? db().followUp.findMany({ where: { organizationId: ctx.orgId, status: { not: 'CANCELED' }, dueAt: { gte: query.from, lt: query.to }, ...(assignee ? { assignedToId: assignee } : {}), AND: [followUpScope(ctx)] }, include: { lead: leadSel }, take: 1000 }) : [],
    kinds.includes('task') ? db().task.findMany({ where: { organizationId: ctx.orgId, status: { notIn: ['CANCELED'] }, dueAt: { gte: query.from, lt: query.to }, ...(assignee ? { assignedToId: assignee } : {}), AND: [ctx.can('tasks.view_all') ? {} : { OR: [{ assignedToId: ctx.userId }, { createdById: ctx.userId }] }] }, include: { lead: leadSel }, take: 1000 }) : [],
  ]);
  const u = await usersById([...fus.map((f) => f.assignedToId), ...tasks.map((t) => t.assignedToId)]);
  return [
    ...fus.map((f) => ({ id: f.id, kind: 'followup' as const, title: `${typeLabel(f.type)} · ${fullName(f.lead)}`, start: f.dueAt, status: f.status, overdue: f.status === 'PENDING' && f.dueAt.getTime() < now, priority: f.priority, type: f.type, leadId: f.leadId, assignee: lite(u, f.assignedToId) })),
    ...tasks.map((t) => ({ id: t.id, kind: 'task' as const, title: t.title, start: t.dueAt!, status: t.status, overdue: !['DONE', 'CANCELED'].includes(t.status) && t.dueAt!.getTime() < now, priority: t.priority, type: 'TASK', leadId: t.leadId, assignee: lite(u, t.assignedToId) })),
  ].sort((a, b) => a.start.getTime() - b.start.getTime());
});
