import type { AutomationTrigger } from '@leadflow/database';
import { afterCommit, currentStore, db } from '../../db';
import { enqueue } from '../../lib/queue';
import { config } from '../../config';
import { log } from '../../lib/logger';

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
  const store = currentStore();
  const orgId = store?.orgId;
  if (!orgId) return;
  // Loop protection: whatever an automation does (assign, create tasks/follow-ups, change priority…) can never start another automation.
  if (store?.suppressTriggers) return;
  const rules = await db().automationRule.findMany({ where: { organizationId: orgId, trigger, isEnabled: true, ...(onlyRuleId ? { id: onlyRuleId } : {}) } });
  if (!rules.length) return;
  let budget = Number.POSITIVE_INFINITY;
  // Volume protection: a runaway rule set (or a huge import) cannot flood a workspace with executions.
  if (config.automationMaxPerHour > 0) {
    const recent = await db().automationExecution.count({ where: { organizationId: orgId, createdAt: { gt: new Date(Date.now() - 3_600_000) } } });
    budget = config.automationMaxPerHour - recent;
    if (budget <= 0) { log.warn('automation hourly cap reached; event not processed', { orgId, trigger, cap: config.automationMaxPerHour }); return; }
  }
  const lead = await db().lead.findUnique({ where: { id: entity.leadId }, select: { sourceId: true, priorityId: true } });
  const key = eventKey ?? `${trigger}:${entity.id}`;
  for (const rule of rules) {
    const c = (rule.conditions ?? {}) as Conditions;
    if (c.sourceIds?.length && !(lead?.sourceId && c.sourceIds.includes(lead.sourceId))) continue;
    if (c.priorityIds?.length && !(lead?.priorityId && c.priorityIds.includes(lead.priorityId))) continue;
    if (budget <= 0) { log.warn('automation hourly cap reached mid-event', { orgId, trigger }); break; }
    // INSERT … ON CONFLICT DO NOTHING: safe when two scheduler instances / requests emit the same event concurrently
    // (a failed INSERT inside a PostgreSQL transaction would abort the whole transaction).
    const inserted = await db().automationExecution.createMany({
      data: [{ organizationId: orgId, ruleId: rule.id, entityType: entity.type, entityId: entity.id, eventKey: key, result: { leadId: entity.leadId } }],
      skipDuplicates: true,
    });
    if (inserted.count === 0) continue;
    budget -= 1;
    const ex = await db().automationExecution.findUniqueOrThrow({ where: { ruleId_eventKey: { ruleId: rule.id, eventKey: key } } });
    afterCommit(() => enqueue('automation.execute', { orgId, executionId: ex.id }, { jobId: `ex-${ex.id}` }));
  }
}
