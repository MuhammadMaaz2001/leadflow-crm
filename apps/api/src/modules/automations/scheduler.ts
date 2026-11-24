import { addHours, addMinutes } from 'date-fns';
import { fullName } from '@leadflow/shared';
import { afterCommit, db, forEachOrg } from '../../db';
import { enqueue } from '../../lib/queue';
import { notify } from '../notifications/service';
import { emitTrigger } from './events';
import { runSubscriptionLifecycle } from '../subscriptions/lifecycle';
import { config } from '../../config';
import { withLock } from '../../lib/lock';
import { log } from '../../lib/logger';
import { recordSchedulerRun } from '../../lib/health';
import { isShuttingDown } from '../../lib/shutdown';
import { sweepEmailOutbox } from '../../lib/email';

/**
 * Periodic background processing (BullMQ repeatable job, every minute). All work is idempotent:
 * reminders are de-duplicated via notification dedupe keys and automation executions via (rule,eventKey).
 */
export async function runSchedulerTick(now = new Date(), shouldStop: () => boolean = () => false) {
  return forEachOrg(async (orgId) => {
    await followUpReminders(orgId, now);
    await taskReminders(orgId, now);
    await automationScans(orgId, now);
    await requeueStuckExecutions(orgId, now);
    await runSubscriptionLifecycle(orgId, now);
    await usageSnapshot(orgId, now);
  }, shouldStop);
}

/**
 * Cluster-safe tick: at most ONE instance runs the scheduler at a time (Redis lease lock, renewed while running,
 * expiring if the holder crashes). Overlapping ticks (a slow minute) are skipped rather than stacked.
 * Even without the lock a double run is harmless — reminders and executions are idempotent (see header comment).
 */
export async function runLockedSchedulerTick(now = new Date()): Promise<{ ran: boolean; orgs?: number; failed?: number }> {
  const t0 = Date.now();
  const r = await withLock('scheduler:tick', config.schedulerLockMs, async (lease) => {
    const res = await runSchedulerTick(now, () => lease.lost() || isShuttingDown());
    await sweepEmailOutbox(now).catch((e) => log.warn('email sweep failed', { error: (e as Error).message }));
    return res;
  });
  if (!r.ran) { log.debug('scheduler tick skipped: another instance holds the lock'); return { ran: false }; }
  await recordSchedulerRun({ durationMs: Date.now() - t0, orgs: r.value.orgs, failed: r.value.failed }).catch(() => undefined);
  log.info('scheduler tick complete', { durationMs: Date.now() - t0, orgs: r.value.orgs, failed: r.value.failed });
  return { ran: true, ...r.value };
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

/**
 * Safety net for lost jobs: an execution still PENDING five minutes after it was created never reached (or never finished in)
 * the queue — Redis was flushed, the enqueue failed after commit, or a worker crashed. Re-enqueue it. The queue job id contains a
 * 5-minute bucket, so a still-running job is not duplicated, and execution itself is exactly-once (row lock + status check).
 */
async function requeueStuckExecutions(orgId: string, now: Date) {
  const stuck = await db().automationExecution.findMany({ where: { organizationId: orgId, status: 'PENDING', createdAt: { lt: addMinutes(now, -5) } }, select: { id: true }, take: 100, orderBy: { createdAt: 'asc' } });
  for (const ex of stuck) {
    log.warn('re-queueing automation execution that never completed', { orgId, executionId: ex.id });
    afterCommit(() => enqueue('automation.execute', { orgId, executionId: ex.id }, { jobId: `ex-${ex.id}-r${Math.floor(now.getTime() / 300_000)}` }));
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
