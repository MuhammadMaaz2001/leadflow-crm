import type { AutomationTrigger, NotificationType, Prisma } from '@leadflow/database';
import { fullName } from '@leadflow/shared';
import { currentStore, db, withContext } from '../../db';
import { managerIds, notify } from '../notifications/service';
import { logActivity } from '../activities/service';
import { usersById } from '../../lib/users';

type Action =
  | { type: 'NOTIFY'; recipient: 'OWNER' | 'MANAGERS' | 'USER'; userId?: string; message?: string }
  | { type: 'CREATE_TASK'; title: string; assignee?: 'OWNER' | 'MANAGERS' | 'USER'; userId?: string; dueInHours?: number; priority?: 'LOW' | 'MEDIUM' | 'HIGH' }
  | { type: 'SET_PRIORITY'; priorityId: string }
  | { type: 'ASSIGN_LEAD'; mode: 'USER' | 'ROUND_ROBIN'; userId?: string; onlyIfUnassigned?: boolean }
  | { type: 'CREATE_FOLLOWUP'; followUpType?: 'CALL' | 'WHATSAPP' | 'EMAIL' | 'MEETING' | 'VIDEO_CALL' | 'OTHER'; assignee?: 'OWNER' | 'MANAGERS' | 'USER'; userId?: string; dueInHours?: number; notes?: string };

const NOTIF_TYPE: Record<AutomationTrigger, NotificationType> = {
  LEAD_CREATED: 'NEW_LEAD', LEAD_ASSIGNED: 'LEAD_ASSIGNED', LEAD_NOT_CONTACTED: 'REMINDER', FOLLOWUP_OVERDUE: 'FOLLOWUP_OVERDUE', LEAD_INACTIVE: 'LEAD_INACTIVE', LEAD_CONVERTED: 'LEAD_CONVERTED',
};
const TITLE: Record<AutomationTrigger, (n: string) => string> = {
  LEAD_CREATED: (n) => `New lead received: ${n}`, LEAD_ASSIGNED: (n) => `Lead assigned: ${n}`, LEAD_NOT_CONTACTED: (n) => `Lead not contacted yet: ${n}`,
  FOLLOWUP_OVERDUE: (n) => `Overdue follow-up: ${n}`, LEAD_INACTIVE: (n) => `Inactive lead: ${n}`, LEAD_CONVERTED: (n) => `Lead converted: ${n}`,
};

/** Executes one automation execution inside its workspace context. Throws on failure so the job can be retried. */
export async function executeAutomation(orgId: string, executionId: string) {
  let failure: Error | null = null;
  try {
    await withContext({ orgId }, async () => {
      currentStore()!.suppressTriggers = true;   // nothing this execution does may start another automation
      // Exactly-once effects: the row lock serialises concurrent runners (stalled-job redelivery, duplicate enqueue,
      // manual retry); the loser waits for the winner's commit and then sees SUCCESS/SKIPPED below.
      await db().$queryRaw`SELECT id FROM automation_executions WHERE id = ${executionId}::uuid FOR UPDATE`;
      const ex = await db().automationExecution.findFirst({ where: { id: executionId, organizationId: orgId }, include: { rule: true } });
      if (!ex || ex.status === 'SUCCESS' || ex.status === 'SKIPPED') return;
      await db().automationExecution.update({ where: { id: ex.id }, data: { attempts: { increment: 1 }, status: 'PENDING', error: null } });
      const sub = await db().subscription.findUnique({ where: { organizationId: orgId }, include: { plan: true } });
      const org = await db().organization.findUniqueOrThrow({ where: { id: orgId } });
      const skip = async (reason: string) => { await db().automationExecution.update({ where: { id: ex.id }, data: { status: 'SKIPPED', finishedAt: new Date(), result: { reason } } }); };
      if (org.status !== 'ACTIVE') return skip('Workspace suspended');
      if (!sub?.plan.features.includes('automations') || sub.status === 'EXPIRED') return skip('Automations are not included in the current plan');
      if (!ex.rule.isEnabled) return skip('Rule disabled');

      const leadId = ((ex.result ?? {}) as { leadId?: string }).leadId ?? ex.entityId;
      const lead = await db().lead.findFirst({ where: { id: leadId, organizationId: orgId } });
      if (!lead || lead.archivedAt) return skip('Lead is no longer active');
      const followUp = ex.entityType === 'followup' ? await db().followUp.findFirst({ where: { id: ex.entityId, organizationId: orgId } }) : null;
      if (ex.rule.trigger === 'FOLLOWUP_OVERDUE' && (!followUp || followUp.status !== 'PENDING')) return skip('Follow-up is no longer pending');
      if ((ex.rule.trigger === 'LEAD_NOT_CONTACTED' && lead.firstContactedAt) || (ex.rule.trigger === 'LEAD_INACTIVE' && ['CONVERTED', 'LOST'].includes(lead.status))) return skip('Condition no longer applies');

      const ownerId = followUp?.assignedToId ?? lead.assignedToId;
      const managers = await managerIds();
      const resolve = (r: 'OWNER' | 'MANAGERS' | 'USER' | undefined, userId?: string) => r === 'USER' ? (userId ? [userId] : []) : r === 'MANAGERS' ? managers : ownerId ? [ownerId] : managers;
      const name = fullName(lead);
      const log: Array<Record<string, unknown>> = [];
      const actions = (ex.rule.actions as unknown as Action[]) ?? [];
      for (const [i, a] of actions.entries()) {
        if (a.type === 'NOTIFY') {
          const to = resolve(a.recipient, a.userId);
          const n = await notify({ userIds: to, type: NOTIF_TYPE[ex.rule.trigger], title: TITLE[ex.rule.trigger](name), body: a.message ?? `Automation: ${ex.rule.name}`, link: `/leads/${lead.id}`, entityType: 'lead', entityId: lead.id, dedupeKey: `auto:${ex.id}:${i}` });
          log.push({ action: 'NOTIFY', recipients: to.length, delivered: n });
        } else if (a.type === 'CREATE_TASK') {
          const assignee = resolve(a.assignee, a.userId)[0] ?? null;
          const task = await db().task.create({ data: { organizationId: orgId, title: a.title, description: `Created by automation "${ex.rule.name}"`, priority: a.priority ?? 'MEDIUM', dueAt: new Date(Date.now() + (a.dueInHours ?? 24) * 3_600_000), assignedToId: assignee, leadId: lead.id, isAutomated: true } });
          await logActivity({ leadId: lead.id, type: 'TASK_CREATED', title: `Task created by automation: ${a.title}`, actorId: null, touch: false, metadata: { taskId: task.id, automationRuleId: ex.ruleId } });
          if (assignee) await notify({ userIds: [assignee], type: 'TASK_ASSIGNED', title: `New task: ${a.title}`, body: `For ${name}`, link: '/tasks', entityType: 'task', entityId: task.id, dedupeKey: `auto-task:${ex.id}:${i}` });
          log.push({ action: 'CREATE_TASK', taskId: task.id, assignee });
        } else if (a.type === 'SET_PRIORITY') {
          const p = await db().leadPriority.findFirst({ where: { id: a.priorityId, organizationId: orgId } });
          if (p) { await db().lead.update({ where: { id: lead.id }, data: { priorityId: p.id } }); log.push({ action: 'SET_PRIORITY', priority: p.name }); }
        } else if (a.type === 'ASSIGN_LEAD') {
          if (lead.assignedToId && a.onlyIfUnassigned !== false) { log.push({ action: 'ASSIGN_LEAD', skipped: 'lead already has an owner' }); continue; }
          let target: string | null = null;
          if (a.mode === 'USER') {
            const m = a.userId ? await db().membership.findFirst({ where: { organizationId: orgId, userId: a.userId, status: 'ACTIVE' } }) : null;
            if (!m) throw new Error('The automation assigns to a member who is no longer active in this workspace. Edit the rule.');
            target = m.userId;
          } else {
            const eligible = await db().membership.findMany({ where: { organizationId: orgId, status: 'ACTIVE', isAssignable: true }, orderBy: { joinedAt: 'asc' }, select: { userId: true } });
            if (!eligible.length) { log.push({ action: 'ASSIGN_LEAD', skipped: 'nobody is available for automatic assignment' }); continue; }
            const [row] = await db().$queryRaw<{ rr_cursor: number }[]>`UPDATE organizations SET rr_cursor = rr_cursor + 1 WHERE id = ${orgId}::uuid RETURNING rr_cursor`;
            target = eligible[((row?.rr_cursor ?? 1) - 1) % eligible.length]!.userId;
          }
          if (target === lead.assignedToId) { log.push({ action: 'ASSIGN_LEAD', skipped: 'already assigned to that member' }); continue; }
          const names = await usersById([target, lead.assignedToId]);
          await db().lead.update({ where: { id: lead.id }, data: { assignedToId: target, assignedAt: new Date() } });
          await db().leadAssignment.create({ data: { organizationId: orgId, leadId: lead.id, fromUserId: lead.assignedToId, toUserId: target, assignedById: null, method: 'AUTOMATION', note: `Automation "${ex.rule.name}"` } });
          await logActivity({ leadId: lead.id, type: lead.assignedToId ? 'LEAD_REASSIGNED' : 'LEAD_ASSIGNED', title: `${lead.assignedToId ? 'Reassigned' : 'Assigned'} to ${names.get(target)?.name ?? 'a colleague'} by automation "${ex.rule.name}"`, actorId: null, touch: false, metadata: { to: target, method: 'AUTOMATION', automationRuleId: ex.ruleId } });
          await notify({ userIds: [target], type: 'LEAD_ASSIGNED', title: `Lead assigned to you: ${name}`, body: `Automation: ${ex.rule.name}`, link: `/leads/${lead.id}`, entityType: 'lead', entityId: lead.id, dedupeKey: `auto-assign:${ex.id}:${i}` });
          lead.assignedToId = target;
          log.push({ action: 'ASSIGN_LEAD', assignedTo: target });
        } else if (a.type === 'CREATE_FOLLOWUP') {
          const assignee = resolve(a.assignee, a.userId)[0] ?? null;
          if (!assignee) { log.push({ action: 'CREATE_FOLLOWUP', skipped: 'no one to assign the follow-up to' }); continue; }
          const dueAt = new Date(Date.now() + (a.dueInHours ?? 24) * 3_600_000);
          const fu = await db().followUp.create({ data: { organizationId: orgId, leadId: lead.id, type: a.followUpType ?? 'CALL', title: `Automated: ${ex.rule.name}`, dueAt, assignedToId: assignee, createdById: assignee, priority: 'MEDIUM', notes: a.notes ?? null } });
          await db().followUpEvent.create({ data: { organizationId: orgId, followUpId: fu.id, type: 'CREATED', toDueAt: dueAt, actorId: null } });
          await logActivity({ leadId: lead.id, type: 'FOLLOWUP_SCHEDULED', title: `Follow-up scheduled by automation "${ex.rule.name}"`, actorId: null, touch: false, metadata: { followUpId: fu.id, dueAt: dueAt.toISOString(), assignedToId: assignee } });
          await notify({ userIds: [assignee], type: 'FOLLOWUP_DUE', title: `New follow-up: ${name}`, body: `Due ${dueAt.toISOString()}`, link: `/leads/${lead.id}`, entityType: 'followup', entityId: fu.id, dedupeKey: `auto-fu:${ex.id}:${i}` });
          log.push({ action: 'CREATE_FOLLOWUP', followUpId: fu.id, assignee });
        }
      }
      await db().automationExecution.update({ where: { id: ex.id }, data: { status: 'SUCCESS', finishedAt: new Date(), result: { leadId, actions: log } as Prisma.InputJsonValue } });
    });
  } catch (e) {
    failure = e as Error;
  }
  if (failure) {
    await withContext({ orgId }, async () => {
      await db().automationExecution.updateMany({ where: { id: executionId, organizationId: orgId }, data: { status: 'FAILED', error: failure!.message.slice(0, 500), finishedAt: new Date(), attempts: { increment: 1 } } });
    });
    throw failure;
  }
}
