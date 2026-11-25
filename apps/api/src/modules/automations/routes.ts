import { AUTOMATION_TRIGGERS, assignmentRuleSchema, automationSchema } from '@leadflow/shared';
import { z } from 'zod';
import { db } from '../../db';
import { AppError, notFound } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { enqueue } from '../../lib/queue';
import { created, defineRoutes, paged } from '../../http';
import { pageMeta, paginate, pageQuery } from '../../lib/pagination';
import { assertActiveMember } from '../leads/service';
import { config } from '../../config';

export const automations = defineRoutes('Automations', '');

automations.get('/automations', { perm: ['automations.manage', 'settings.manage'], summary: 'List automation rules' }, async ({ ctx }) => {
  const rules = await db().automationRule.findMany({ where: { organizationId: ctx.orgId }, orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }] });
  const lastHour = config.automationMaxPerHour > 0 ? await db().automationExecution.count({ where: { organizationId: ctx.orgId, createdAt: { gt: new Date(Date.now() - 3_600_000) } } }) : 0;
  const stats = await db().automationExecution.groupBy({ by: ['ruleId', 'status'], where: { organizationId: ctx.orgId }, _count: true });
  const last = await db().automationExecution.groupBy({ by: ['ruleId'], where: { organizationId: ctx.orgId }, _max: { createdAt: true } });
  const lm = new Map(last.map((l) => [l.ruleId, l._max.createdAt]));
  return {
    featureEnabled: ctx.plan.features.includes('automations'),
    throttled: config.automationMaxPerHour > 0 && lastHour >= config.automationMaxPerHour, hourlyCap: config.automationMaxPerHour, executionsLastHour: lastHour,
    triggers: AUTOMATION_TRIGGERS,
    rules: rules.map((r) => ({ ...r, stats: Object.fromEntries(stats.filter((s) => s.ruleId === r.id).map((s) => [s.status, s._count])), lastRunAt: lm.get(r.id) ?? null })),
  };
});

async function validateRefs(ctx: Parameters<typeof assertActiveMember>[0], body: z.infer<typeof automationSchema>) {
  for (const a of body.actions) {
    if (a.type === 'ASSIGN_LEAD' && a.mode === 'USER' && !a.userId) throw new AppError(400, 'VALIDATION_ERROR', 'Choose who the lead is assigned to');
    if ((a.type === 'NOTIFY' && a.recipient === 'USER') || ((a.type === 'CREATE_TASK' || a.type === 'CREATE_FOLLOWUP') && a.assignee === 'USER') || (a.type === 'ASSIGN_LEAD' && a.mode === 'USER')) {
      const uid = a.userId;
      if (!uid) throw new AppError(400, 'VALIDATION_ERROR', 'Choose a user for the action');
      await assertActiveMember(ctx, uid, 'Action recipient');
    }
    if (a.type === 'SET_PRIORITY' && !(await db().leadPriority.findFirst({ where: { id: a.priorityId, organizationId: ctx.orgId } }))) throw new AppError(400, 'VALIDATION_ERROR', 'Unknown priority');
  }
  const trig = AUTOMATION_TRIGGERS.find((t) => t.value === body.trigger)!;
  if (trig.hasDelay && !body.conditions.afterHours && !body.conditions.afterDays) throw new AppError(400, 'VALIDATION_ERROR', `Set how long to wait (${trig.delayUnit}) for this trigger`);
}

automations.post('/automations', { perm: 'automations.manage', feature: 'automations', body: automationSchema, summary: 'Create an automation rule' }, async ({ ctx, body }) => {
  if ((await db().automationRule.count({ where: { organizationId: ctx.orgId } })) >= config.automationMaxRules) throw new AppError(409, 'TOO_MANY_RULES', `A workspace can have up to ${config.automationMaxRules} automation rules.`);
  await validateRefs(ctx, body);
  const r = await db().automationRule.create({ data: { organizationId: ctx.orgId, name: body.name, description: body.description ?? null, trigger: body.trigger, conditions: body.conditions, actions: body.actions, isEnabled: body.isEnabled ?? true, createdById: ctx.userId } });
  await audit(ctx, 'automation.created', 'automation_rule', r.id, { name: r.name });
  return created(r);
});
automations.patch('/automations/:id', { perm: 'automations.manage', feature: 'automations', body: automationSchema.partial(), summary: 'Update an automation rule' }, async ({ ctx, params, body }) => {
  const r = await db().automationRule.findFirst({ where: { id: params.id, organizationId: ctx.orgId } });
  if (!r) throw notFound('Automation');
  const merged = automationSchema.parse({ name: r.name, description: r.description, trigger: r.trigger, conditions: r.conditions, actions: r.actions, ...body });
  await validateRefs(ctx, merged);
  const u = await db().automationRule.update({ where: { id: r.id }, data: { name: merged.name, description: merged.description ?? null, trigger: merged.trigger, conditions: merged.conditions, actions: merged.actions, isEnabled: body.isEnabled } });
  await audit(ctx, 'automation.updated', 'automation_rule', r.id);
  return u;
});
automations.post('/automations/:id/toggle', { perm: 'automations.manage', summary: 'Enable / disable a rule' }, async ({ ctx, params }) => {
  const r = await db().automationRule.findFirst({ where: { id: params.id, organizationId: ctx.orgId } });
  if (!r) throw notFound('Automation');
  if (!r.isEnabled && !ctx.plan.features.includes('automations')) throw new AppError(402, 'FEATURE_NOT_IN_PLAN', 'Your plan does not include automations. Upgrade to enable rules.');
  const u = await db().automationRule.update({ where: { id: r.id }, data: { isEnabled: !r.isEnabled } });
  await audit(ctx, u.isEnabled ? 'automation.enabled' : 'automation.disabled', 'automation_rule', r.id);
  return { isEnabled: u.isEnabled };
});
automations.delete('/automations/:id', { perm: 'automations.manage', summary: 'Delete a custom rule (system templates can only be disabled)' }, async ({ ctx, params }) => {
  const r = await db().automationRule.findFirst({ where: { id: params.id, organizationId: ctx.orgId } });
  if (!r) throw notFound('Automation');
  if (r.isSystem) throw new AppError(409, 'SYSTEM_RULE', 'Built-in rules cannot be deleted; disable them instead.');
  await db().automationRule.delete({ where: { id: r.id } });
  await audit(ctx, 'automation.deleted', 'automation_rule', r.id);
  return { deleted: true };
});

automations.get('/automations/executions', { perm: ['automations.manage', 'settings.manage'], query: z.object({ ...pageQuery, status: z.string().optional(), ruleId: z.string().uuid().optional() }), summary: 'Execution log' }, async ({ ctx, query }) => {
  const where = { organizationId: ctx.orgId, ...(query.status ? { status: query.status as never } : {}), ...(query.ruleId ? { ruleId: query.ruleId } : {}) };
  const [total, rows] = await Promise.all([db().automationExecution.count({ where }), db().automationExecution.findMany({ where, include: { rule: { select: { id: true, name: true, trigger: true } } }, orderBy: { createdAt: 'desc' }, ...paginate(query) })]);
  return paged(rows, pageMeta(query, total));
});
automations.post('/automations/executions/:id/retry', { perm: 'automations.manage', summary: 'Retry a failed (or skipped) execution' }, async ({ ctx, params }) => {
  const ex = await db().automationExecution.findFirst({ where: { id: params.id, organizationId: ctx.orgId } });
  if (!ex) throw notFound('Execution');
  if (ex.status === 'SUCCESS' || ex.status === 'PENDING') throw new AppError(409, 'NOT_RETRYABLE', `This execution is ${ex.status.toLowerCase()} and cannot be retried.`);
  await db().automationExecution.update({ where: { id: ex.id }, data: { status: 'PENDING', error: null, finishedAt: null } });
  const { afterCommit } = await import('../../db');
  afterCommit(() => enqueue('automation.execute', { orgId: ctx.orgId, executionId: ex.id }, { jobId: `retry-${ex.id}-${Date.now()}` }));
  await audit(ctx, 'automation.retried', 'automation_execution', ex.id);
  return { queued: true };
});

// ── Assignment rules (round-robin / rule-based) ──
automations.get('/assignment-rules', { perm: ['leads.assign', 'settings.manage'], summary: 'List assignment rules' }, async ({ ctx }) => {
  const rules = await db().assignmentRule.findMany({ where: { organizationId: ctx.orgId }, orderBy: { position: 'asc' } });
  return { mode: ctx.org.autoAssignMode, rules };
});
automations.post('/assignment-rules', { perm: 'settings.manage', feature: 'rule_assignment', body: assignmentRuleSchema, summary: 'Create an assignment rule' }, async ({ ctx, body }) => {
  for (const id of body.assigneeIds) await assertActiveMember(ctx, id, 'Assignee');
  const n = await db().assignmentRule.count({ where: { organizationId: ctx.orgId } });
  const r = await db().assignmentRule.create({ data: { organizationId: ctx.orgId, name: body.name, conditions: body.conditions, assigneeIds: body.assigneeIds, position: body.position ?? n, isActive: body.isActive ?? true } });
  await audit(ctx, 'assignment_rule.created', 'assignment_rule', r.id);
  return created(r);
});
automations.patch('/assignment-rules/:id', { perm: 'settings.manage', feature: 'rule_assignment', body: assignmentRuleSchema.partial(), summary: 'Update an assignment rule' }, async ({ ctx, params, body }) => {
  const r = await db().assignmentRule.findFirst({ where: { id: params.id, organizationId: ctx.orgId } });
  if (!r) throw notFound('Rule');
  if (body.assigneeIds) for (const id of body.assigneeIds) await assertActiveMember(ctx, id, 'Assignee');
  const upd = await db().assignmentRule.update({ where: { id: r.id }, data: body });
  await audit(ctx, 'assignment_rule.updated', 'assignment_rule', r.id, { fields: Object.keys(body) });
  return upd;
});
automations.delete('/assignment-rules/:id', { perm: 'settings.manage', summary: 'Delete an assignment rule' }, async ({ ctx, params }) => {
  const r = await db().assignmentRule.findFirst({ where: { id: params.id, organizationId: ctx.orgId } });
  if (!r) throw notFound('Rule');
  await db().assignmentRule.delete({ where: { id: r.id } });
  await audit(ctx, 'assignment_rule.deleted', 'assignment_rule', r.id);
  return { deleted: true };
});
