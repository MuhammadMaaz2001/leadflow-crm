import { calendarRescheduleSchema, fullName } from '@leadflow/shared';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { db } from '../../db';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors';
import { defineRoutes } from '../../http';
import { audit } from '../../lib/audit';
import { notify } from '../notifications/service';
import { followUpScope, rescheduleFollowUp, typeLabel } from './service';
import { taskScope } from '../tasks/routes';

export const calendar = defineRoutes('Calendar', '/calendar');

/**
 * Resolves the requested new due instant. A calendar `date` (and optional `time`) is interpreted in the WORKSPACE timezone — never the
 * browser's — and keeps the item's current wall-clock time when no `time` is given, so "move to Friday" never silently shifts the hour,
 * including across daylight-saving changes.
 */
export function resolveNewStart(tz: string, current: Date, v: { start?: Date; date?: string; time?: string }): Date {
  if (v.start) return v.start;
  const time = v.time ?? formatInTimeZone(current, tz, 'HH:mm');
  const d = fromZonedTime(`${v.date}T${time}:00`, tz);
  // reject impossible dates such as 2026-02-30 (they would otherwise roll over silently)
  if (Number.isNaN(d.getTime()) || !new Date(`${v.date}T00:00:00Z`).toISOString().startsWith(v.date!)) throw badRequest('That is not a valid date', { fields: { date: 'Invalid date' } });
  return d;
}

function assertAcceptable(d: Date) {
  if (Number.isNaN(d.getTime())) throw badRequest('Invalid date');
  if (d.getTime() < Date.now() - 60_000) throw badRequest('Choose a date and time in the future', { fields: { date: 'Must be in the future' } }, 'IN_THE_PAST');
  if (d.getTime() > Date.now() + 5 * 366 * 86_400_000) throw badRequest('That date is too far in the future', { fields: { date: 'Too far ahead' } });
}
const stale = (current: Date) => new AppError(409, 'STALE_EVENT', 'This item was changed by someone else. The calendar has been refreshed.', { currentStart: current.toISOString() });

calendar.post('/reschedule', { body: calendarRescheduleSchema, summary: 'Move a follow-up or task to another day / time (assignee or a manager; pending follow-ups and open tasks only)' }, async ({ ctx, body }) => {
  const tz = ctx.org.timezone;
  if (body.kind === 'followup') {
    if (!ctx.can('followups.manage')) throw forbidden('Missing permission: followups.manage', 'MISSING_PERMISSION');
    await db().$queryRaw`SELECT id FROM follow_ups WHERE id = ${body.id}::uuid AND organization_id = ${ctx.orgId}::uuid FOR UPDATE`;   // serialise duplicate / racing drops
    const f = await db().followUp.findFirst({ where: { id: body.id, organizationId: ctx.orgId, AND: [followUpScope(ctx)] } });
    if (!f) throw notFound('Follow-up');
    if (f.assignedToId !== ctx.userId && !ctx.can('followups.view_all')) throw forbidden('Only the assignee or a manager can reschedule this follow-up.', 'NOT_ASSIGNEE');
    if (f.status !== 'PENDING') throw new AppError(409, 'NOT_RESCHEDULABLE', `A ${f.status.toLowerCase()} follow-up cannot be rescheduled.`);
    if (body.expectedStart && Math.abs(body.expectedStart.getTime() - f.dueAt.getTime()) > 1000) throw stale(f.dueAt);
    const next = resolveNewStart(tz, f.dueAt, body);
    if (Math.abs(next.getTime() - f.dueAt.getTime()) < 1000) return { kind: 'followup', id: f.id, start: f.dueAt, changed: false };
    assertAcceptable(next);
    const u = await rescheduleFollowUp(ctx, f, next, body.reason ?? 'Moved on the calendar');
    if (f.assignedToId !== ctx.userId) {
      const lead = await db().lead.findUnique({ where: { id: f.leadId }, select: { firstName: true, lastName: true } });
      await notify({ userIds: [f.assignedToId], type: 'REMINDER', title: `${ctx.user.name} rescheduled your ${typeLabel(f.type).toLowerCase()} with ${lead ? fullName(lead) : 'a lead'}`, body: `Now due ${u.dueAt.toISOString()}`, link: `/leads/${f.leadId}`, entityType: 'followup', entityId: f.id });
    }
    return { kind: 'followup', id: u.id, start: u.dueAt, changed: true };
  }
  if (!ctx.can('tasks.manage')) throw forbidden('Missing permission: tasks.manage', 'MISSING_PERMISSION');
  await db().$queryRaw`SELECT id FROM tasks WHERE id = ${body.id}::uuid AND organization_id = ${ctx.orgId}::uuid FOR UPDATE`;
  const t = await db().task.findFirst({ where: { id: body.id, organizationId: ctx.orgId, AND: [taskScope(ctx)] } });
  if (!t) throw notFound('Task');
  if (t.assignedToId !== ctx.userId && !ctx.can('tasks.view_all')) throw forbidden('Only the assignee or a manager can reschedule this task.', 'NOT_ASSIGNEE');
  if (!['TODO', 'IN_PROGRESS'].includes(t.status)) throw new AppError(409, 'NOT_RESCHEDULABLE', `A ${t.status === 'DONE' ? 'completed' : 'canceled'} task cannot be rescheduled.`);
  if (!t.dueAt) throw new AppError(409, 'NOT_RESCHEDULABLE', 'This task has no due date; edit the task to give it one.');
  if (body.expectedStart && Math.abs(body.expectedStart.getTime() - t.dueAt.getTime()) > 1000) throw stale(t.dueAt);
  const next = resolveNewStart(tz, t.dueAt, body);
  if (Math.abs(next.getTime() - t.dueAt.getTime()) < 1000) return { kind: 'task', id: t.id, start: t.dueAt, changed: false };
  assertAcceptable(next);
  // a new due date re-arms the "due soon" reminder and the overdue notice (same rule as editing the task)
  const u = await db().task.update({ where: { id: t.id }, data: { dueAt: next, reminderSentAt: null, overdueNotifiedAt: null } });
  await audit(ctx, 'task.rescheduled', 'task', t.id, { from: t.dueAt.toISOString(), to: next.toISOString() });
  if (t.assignedToId && t.assignedToId !== ctx.userId) await notify({ userIds: [t.assignedToId], type: 'TASK_DEADLINE', title: `${ctx.user.name} moved the due date of "${t.title}"`, body: `Now due ${next.toISOString()}`, link: '/tasks', entityType: 'task', entityId: t.id });
  return { kind: 'task', id: u.id, start: u.dueAt, changed: true };
});
