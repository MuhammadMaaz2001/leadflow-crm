import type { AutomationTrigger, NotificationType, Prisma } from '@leadflow/database';
import { fullName } from '@leadflow/shared';
import { db, withContext } from '../../db';
import { managerIds, notify } from '../notifications/service';
import { logActivity } from '../activities/service';

type Action =
  | { type: 'NOTIFY'; recipient: 'OWNER' | 'MANAGERS' | 'USER'; userId?: string; message?: string }
  | { type: 'CREATE_TASK'; title: string; assignee?: 'OWNER' | 'MANAGERS' | 'USER'; userId?: string; dueInHours?: number; priority?: 'LOW' | 'MEDIUM' | 'HIGH' }
  | { type: 'SET_PRIORITY'; priorityId: string };

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
          await logActivity({ leadId: lead.id, type: 'TASK_CREATED', title: `Task created by automation: ${a.title}`, actorId: null, metadata: { taskId: task.id, automationRuleId: ex.ruleId } });
          if (assignee) await notify({ userIds: [assignee], type: 'TASK_ASSIGNED', title: `New task: ${a.title}`, body: `For ${name}`, link: '/tasks', entityType: 'task', entityId: task.id, dedupeKey: `auto-task:${ex.id}:${i}` });
          log.push({ action: 'CREATE_TASK', taskId: task.id, assignee });
        } else if (a.type === 'SET_PRIORITY') {
          const p = await db().leadPriority.findFirst({ where: { id: a.priorityId, organizationId: orgId } });
          if (p) { await db().lead.update({ where: { id: lead.id }, data: { priorityId: p.id } }); log.push({ action: 'SET_PRIORITY', priority: p.name }); }
        }
      }
      await db().automationExecution.update({ where: { id: ex.id }, data: { status: 'SUCCESS', finishedAt: new Date(), result: { leadId, actions: log } as Prisma.InputJsonValue } });
    });
  } catch (e) {
    failure = e as Error;
  }
  if (failure) {
    await withContext({ orgId }, async () => {
      await db().automationExecution.updateMany({ where: { id: executionId, organizationId: orgId }, data: { status: 'FAILED', error: failure!.message.slice(0, 500), finishedAt: new Date() } });
    });
    throw failure;
  }
}
