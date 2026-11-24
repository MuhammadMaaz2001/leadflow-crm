import type { FollowUp, FollowUpOutcome, FollowUpType, Prisma, Priority } from '@leadflow/database';
import { FOLLOWUP_OUTCOMES, FOLLOWUP_TYPES, fullName } from '@leadflow/shared';
import { db } from '../../db';
import { badRequest, notFound } from '../../lib/errors';
import type { Ctx } from '../../http';
import { logActivity, markContacted } from '../activities/service';
import { assertActiveMember, getLeadOr404 } from '../leads/service';
import { notify } from '../notifications/service';

export function followUpScope(ctx: Ctx): Prisma.FollowUpWhereInput {
  return ctx.can('followups.view_all') ? {} : { OR: [{ assignedToId: ctx.userId }, { createdById: ctx.userId }] };
}
export async function getFollowUpOr404(ctx: Ctx, id: string) {
  const f = await db().followUp.findFirst({ where: { id, organizationId: ctx.orgId, AND: [followUpScope(ctx)] } });
  if (!f) throw notFound('Follow-up');
  return f;
}
const typeLabel = (t: string) => FOLLOWUP_TYPES.find((x) => x.value === t)?.label ?? t;
const outcomeLabel = (o: string) => FOLLOWUP_OUTCOMES.find((x) => x.value === o)?.label ?? o;
export { typeLabel, outcomeLabel };

function assertFuture(d: Date, field = 'dueAt') {
  if (d.getTime() < Date.now() - 60_000) throw badRequest('Choose a date and time in the future', { fields: { [field]: 'Must be in the future' } });
}

export async function scheduleFollowUp(ctx: Ctx, input: { leadId: string; opportunityId?: string | null; type: FollowUpType; title?: string | null; dueAt: Date; assignedToId?: string; priority: Priority; notes?: string | null; previousId?: string | null }) {
  const lead = await getLeadOr404(ctx, input.leadId);
  assertFuture(input.dueAt);
  if (input.opportunityId) {
    const o = await db().opportunity.findFirst({ where: { id: input.opportunityId, organizationId: ctx.orgId, leadId: lead.id } });
    if (!o) throw badRequest('That opportunity does not belong to this lead', { fields: { opportunityId: 'Invalid opportunity' } });
  }
  const assignedToId = input.assignedToId ?? lead.assignedToId ?? ctx.userId;
  await assertActiveMember(ctx, assignedToId, 'Assignee');
  const f = await db().followUp.create({
    data: { organizationId: ctx.orgId, leadId: lead.id, opportunityId: input.opportunityId ?? null, type: input.type, title: input.title ?? null, dueAt: input.dueAt, assignedToId, createdById: ctx.userId, priority: input.priority, notes: input.notes ?? null, previousId: input.previousId ?? null },
  });
  await db().followUpEvent.create({ data: { organizationId: ctx.orgId, followUpId: f.id, type: 'CREATED', toDueAt: f.dueAt, actorId: ctx.userId } });
  await logActivity({ leadId: lead.id, type: 'FOLLOWUP_SCHEDULED', title: `${typeLabel(f.type)} scheduled`, body: f.notes, metadata: { followUpId: f.id, dueAt: f.dueAt.toISOString(), assignedToId } });
  if (assignedToId !== ctx.userId) {
    await notify({ userIds: [assignedToId], type: 'REMINDER', title: `Follow-up assigned: ${typeLabel(f.type)} with ${fullName(lead)}`, body: `Due ${f.dueAt.toISOString()}`, link: `/leads/${lead.id}`, entityType: 'followup', entityId: f.id });
  }
  return f;
}

export async function completeFollowUp(ctx: Ctx, f: FollowUp, input: { outcome: FollowUpOutcome; outcomeNotes?: string | null; next?: { dueAt: Date; type: FollowUpType; notes?: string | null; assignedToId?: string } }) {
  if (f.status !== 'PENDING') throw badRequest(`This follow-up is already ${f.status.toLowerCase()}.`, undefined, 'NOT_PENDING');
  if (input.next) assertFuture(input.next.dueAt, 'next.dueAt');
  const now = new Date();
  const updated = await db().followUp.update({ where: { id: f.id }, data: { status: 'COMPLETED', completedAt: now, completedById: ctx.userId, outcome: input.outcome, outcomeNotes: input.outcomeNotes ?? null } });
  await db().followUpEvent.create({ data: { organizationId: ctx.orgId, followUpId: f.id, type: 'COMPLETED', actorId: ctx.userId, note: `${outcomeLabel(input.outcome)}${input.outcomeNotes ? ` — ${input.outcomeNotes}` : ''}` } });
  await logActivity({
    leadId: f.leadId, type: 'FOLLOWUP_COMPLETED', title: `${typeLabel(f.type)} completed — ${outcomeLabel(input.outcome)}`, body: input.outcomeNotes ?? null, occurredAt: now,
    metadata: { followUpId: f.id, outcome: input.outcome, dueAt: f.dueAt.toISOString(), onTime: now <= f.dueAt },
  });
  if (f.type !== 'OTHER') await markContacted(f.leadId, now);
  let next: FollowUp | null = null;
  if (input.next) {
    next = await scheduleFollowUp(ctx, { leadId: f.leadId, opportunityId: f.opportunityId, type: input.next.type, dueAt: input.next.dueAt, assignedToId: input.next.assignedToId ?? f.assignedToId, priority: f.priority, notes: input.next.notes ?? null, previousId: f.id });
  }
  return { followUp: updated, next };
}

export async function rescheduleFollowUp(ctx: Ctx, f: FollowUp, dueAt: Date, reason?: string | null) {
  if (f.status !== 'PENDING') throw badRequest('Only pending follow-ups can be rescheduled.', undefined, 'NOT_PENDING');
  assertFuture(dueAt);
  const updated = await db().followUp.update({ where: { id: f.id }, data: { dueAt, rescheduleCount: { increment: 1 }, reminderSentAt: null, overdueNotifiedAt: null } });
  await db().followUpEvent.create({ data: { organizationId: ctx.orgId, followUpId: f.id, type: 'RESCHEDULED', fromDueAt: f.dueAt, toDueAt: dueAt, actorId: ctx.userId, note: reason ?? null } });
  await logActivity({ leadId: f.leadId, type: 'FOLLOWUP_RESCHEDULED', title: `${typeLabel(f.type)} rescheduled`, body: reason ?? null, metadata: { followUpId: f.id, from: f.dueAt.toISOString(), to: dueAt.toISOString() } });
  return updated;
}

export async function cancelFollowUp(ctx: Ctx, f: FollowUp, reason?: string | null) {
  if (f.status !== 'PENDING') throw badRequest('Only pending follow-ups can be canceled.', undefined, 'NOT_PENDING');
  const updated = await db().followUp.update({ where: { id: f.id }, data: { status: 'CANCELED', canceledAt: new Date(), canceledById: ctx.userId, cancelReason: reason ?? null } });
  await db().followUpEvent.create({ data: { organizationId: ctx.orgId, followUpId: f.id, type: 'CANCELED', actorId: ctx.userId, note: reason ?? null } });
  await logActivity({ leadId: f.leadId, type: 'FOLLOWUP_CANCELED', title: `${typeLabel(f.type)} canceled`, body: reason ?? null, metadata: { followUpId: f.id } });
  return updated;
}
