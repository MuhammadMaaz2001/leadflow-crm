import type { AutomationTrigger } from '@leadflow/database';
import { afterCommit, currentStore, db } from '../../db';
import { enqueue } from '../../lib/queue';

interface Conditions { sourceIds?: string[]; priorityIds?: string[] }

/**
 * Domain event → automation executions. Rows are created inside the business transaction (so they
 * commit atomically with the change) and jobs are queued only after commit. (rule,eventKey) is unique,
 * so an event can never fire the same rule twice.
 */
export async function emitTrigger(
  trigger: AutomationTrigger,
  entity: { type: 'lead' | 'followup'; id: string; leadId: string },
  eventKey?: string,
  onlyRuleId?: string,
) {
  const orgId = currentStore()?.orgId;
  if (!orgId) return;
  const rules = await db().automationRule.findMany({ where: { organizationId: orgId, trigger, isEnabled: true, ...(onlyRuleId ? { id: onlyRuleId } : {}) } });
  if (!rules.length) return;
  const lead = await db().lead.findUnique({ where: { id: entity.leadId }, select: { sourceId: true, priorityId: true } });
  const key = eventKey ?? `${trigger}:${entity.id}`;
  for (const rule of rules) {
    const c = (rule.conditions ?? {}) as Conditions;
    if (c.sourceIds?.length && !(lead?.sourceId && c.sourceIds.includes(lead.sourceId))) continue;
    if (c.priorityIds?.length && !(lead?.priorityId && c.priorityIds.includes(lead.priorityId))) continue;
    const exists = await db().automationExecution.findUnique({ where: { ruleId_eventKey: { ruleId: rule.id, eventKey: key } } });
    if (exists) continue;
    const ex = await db().automationExecution.create({
      data: { organizationId: orgId, ruleId: rule.id, entityType: entity.type, entityId: entity.id, eventKey: key, result: { leadId: entity.leadId } },
    });
    afterCommit(() => enqueue('automation.execute', { orgId, executionId: ex.id }, { jobId: `ex-${ex.id}-${Date.now()}` }));
  }
}
