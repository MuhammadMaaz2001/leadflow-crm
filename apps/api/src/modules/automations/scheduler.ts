import { addHours, addMinutes } from 'date-fns';
import { fullName } from '@leadflow/shared';
import { db, forEachOrg } from '../../db';
import { notify } from '../notifications/service';
import { emitTrigger } from './events';
import { runSubscriptionLifecycle } from '../subscriptions/lifecycle';

/**
 * Periodic background processing (BullMQ repeatable job, every minute). All work is idempotent:
 * reminders are de-duplicated via notification dedupe keys and automation executions via (rule,eventKey).
 */
export async function runSchedulerTick(now = new Date()) {
  await forEachOrg(async (orgId) => {
    await followUpReminders(orgId, now);
    await taskReminders(orgId, now);
    await automationScans(orgId, now);
    await runSubscriptionLifecycle(orgId, now);
    await usageSnapshot(orgId, now);
  });
}

async function followUpReminders(orgId: string, now: Date) {
  const soon = await db().followUp.findMany({ where: { organizationId: orgId, status: 'PENDING', reminderSentAt: null, dueAt: { gt: now, lte: addMinutes(now, 15) } }, include: { lead: true }, take: 500 });
  for (const f of soon) {
    await notify({ userIds: [f.assignedToId], type: 'FOLLOWUP_DUE', title: `Follow-up due soon: ${fullName(f.lead)}`, body: `${f.type.toLowerCase().replace('_', ' ')} at ${f.dueAt.toISOString()}`, link: `/leads/${f.leadId}`, entityType: 'followup', entityId: f.id, dedupeKey: `fu-due:${f.id}:${f.dueAt.getTime()}` });
    await db().followUp.update({ where: { id: f.id }, data: { reminderSentAt: now } });
  }
  const overdue = await db().followUp.findMany({ where: { organizationId: orgId, status: 'PENDING', overdueNotifiedAt: null, dueAt: { lte: now } }, include: { lead: true }, take: 500 });
  for (const f of overdue) {
    await notify({ userIds: [f.assignedToId], type: 'FOLLOWUP_OVERDUE', title: `Follow-up overdue: ${fullName(f.lead)}`, body: `Was due ${f.dueAt.toISOString()}`, link: `/leads/${f.leadId}`, entityType: 'followup', entityId: f.id, dedupeKey: `fu-overdue:${f.id}:${f.dueAt.getTime()}` });
    await db().followUp.update({ where: { id: f.id }, data: { overdueNotifiedAt: now, reminderSentAt: f.reminderSentAt ?? now } });
  }
}

async function taskReminders(orgId: string, now: Date) {
  const tasks = await db().task.findMany({ where: { organizationId: orgId, status: { in: ['TODO', 'IN_PROGRESS'] }, reminderSentAt: null, dueAt: { not: null, lte: addHours(now, 2) }, assignedToId: { not: null } }, take: 500 });
  for (const t of tasks) {
    const late = t.dueAt! <= now;
    await notify({ userIds: [t.assignedToId], type: 'TASK_DEADLINE', title: late ? `Task overdue: ${t.title}` : `Task deadline approaching: ${t.title}`, body: `Due ${t.dueAt!.toISOString()}`, link: '/tasks', entityType: 'task', entityId: t.id, dedupeKey: `task-due:${t.id}:${t.dueAt!.getTime()}` });
    await db().task.update({ where: { id: t.id }, data: { reminderSentAt: now } });
  }
}

async function automationScans(orgId: string, now: Date) {
  const org = await db().organization.findUniqueOrThrow({ where: { id: orgId } });
  const rules = await db().automationRule.findMany({ where: { organizationId: orgId, isEnabled: true, trigger: { in: ['LEAD_NOT_CONTACTED', 'LEAD_INACTIVE', 'FOLLOWUP_OVERDUE'] } } });
  for (const r of rules) {
    const c = (r.conditions ?? {}) as { afterHours?: number; afterDays?: number };
    if (r.trigger === 'LEAD_NOT_CONTACTED') {
      const cutoff = addHours(now, -(c.afterHours ?? org.notContactedHours));
      const leads = await db().lead.findMany({ where: { organizationId: orgId, archivedAt: null, mergedIntoId: null, firstContactedAt: null, status: 'NEW', createdAt: { lte: cutoff } }, select: { id: true }, take: 200 });
      for (const l of leads) await emitTrigger('LEAD_NOT_CONTACTED', { type: 'lead', id: l.id, leadId: l.id }, `LEAD_NOT_CONTACTED:${l.id}`, r.id);
    } else if (r.trigger === 'LEAD_INACTIVE') {
      const cutoff = addHours(now, -24 * (c.afterDays ?? org.inactiveDays));
      const leads = await db().lead.findMany({ where: { organizationId: orgId, archivedAt: null, mergedIntoId: null, status: { in: ['NEW', 'CONTACTED', 'QUALIFIED'] }, lastActivityAt: { lte: cutoff } }, select: { id: true, lastActivityAt: true }, take: 200 });
      for (const l of leads) await emitTrigger('LEAD_INACTIVE', { type: 'lead', id: l.id, leadId: l.id }, `LEAD_INACTIVE:${l.id}:${l.lastActivityAt.getTime()}`, r.id);
    } else if (r.trigger === 'FOLLOWUP_OVERDUE') {
      const fus = await db().followUp.findMany({ where: { organizationId: orgId, status: 'PENDING', dueAt: { lt: now } }, select: { id: true, leadId: true, dueAt: true }, take: 200 });
      for (const f of fus) await emitTrigger('FOLLOWUP_OVERDUE', { type: 'followup', id: f.id, leadId: f.leadId }, `FOLLOWUP_OVERDUE:${f.id}:${f.dueAt.getTime()}`, r.id);
    }
  }
}

async function usageSnapshot(orgId: string, now: Date) {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const existing = await db().usageRecord.findUnique({ where: { organizationId_day: { organizationId: orgId, day } } });
  if (existing && now.getTime() - existing.recordedAt.getTime() < 15 * 60_000) return;
  const [leads, seats, opportunities, followUps] = await Promise.all([
    db().lead.count({ where: { organizationId: orgId, archivedAt: null, mergedIntoId: null } }),
    db().membership.count({ where: { organizationId: orgId, status: 'ACTIVE' } }),
    db().opportunity.count({ where: { organizationId: orgId, archivedAt: null } }),
    db().followUp.count({ where: { organizationId: orgId } }),
  ]);
  await db().usageRecord.upsert({
    where: { organizationId_day: { organizationId: orgId, day } },
    update: { leads, seats, opportunities, followUps, recordedAt: now }, create: { organizationId: orgId, day, leads, seats, opportunities, followUps },
  });
}
