import { DEFAULT_LOST_REASONS, DEFAULT_PRIORITIES, DEFAULT_SOURCES, DEFAULT_STAGES, SYSTEM_ROLES } from '@leadflow/shared';
import type { Prisma } from '@leadflow/database';
import { db } from '../../db';

/** Seeds a brand-new workspace with sensible defaults: roles, sources, priorities, lost reasons, pipeline, automation templates. */
export async function bootstrapWorkspace(orgId: string) {
  const tx = db();
  const roles: Record<string, string> = {};
  for (const r of SYSTEM_ROLES) {
    const row = await tx.role.create({ data: { organizationId: orgId, name: r.name, description: r.description, permissions: r.permissions, isSystem: true, systemKey: r.key } });
    roles[r.key] = row.id;
  }
  await tx.leadSource.createMany({ data: DEFAULT_SOURCES.map(([name, color], i) => ({ organizationId: orgId, name, color, position: i })) });
  await tx.leadPriority.createMany({ data: DEFAULT_PRIORITIES.map(([name, color], i) => ({ organizationId: orgId, name, color, position: i })) });
  await tx.lostReason.createMany({ data: DEFAULT_LOST_REASONS.map((name, i) => ({ organizationId: orgId, name, position: i })) });
  const pipeline = await tx.pipeline.create({ data: { organizationId: orgId, name: 'Sales Pipeline', isDefault: true, position: 0 } });
  await tx.pipelineStage.createMany({
    data: DEFAULT_STAGES.map((s, i) => ({ organizationId: orgId, pipelineId: pipeline.id, name: s.name, kind: s.kind, probability: s.probability, color: s.color, position: i })),
  });
  const templates: Array<Omit<Prisma.AutomationRuleCreateManyInput, 'organizationId'>> = [
      { name: 'Notify managers of new leads', description: 'New lead → notify managers', trigger: 'LEAD_CREATED', actions: [{ type: 'NOTIFY', recipient: 'MANAGERS' }], isSystem: true },
      { name: 'Remind owner when a lead is not contacted', description: 'Lead not contacted within the configured time → create reminder task', trigger: 'LEAD_NOT_CONTACTED', conditions: { afterHours: 24 },
        actions: [{ type: 'CREATE_TASK', title: 'Contact this lead — no contact has been recorded yet', assignee: 'OWNER', dueInHours: 4, priority: 'HIGH' }, { type: 'NOTIFY', recipient: 'OWNER', message: 'This lead has not been contacted yet.' }], isSystem: true },
      { name: 'Re-engage inactive leads', description: 'Lead inactive for 7 days → create re-engagement task', trigger: 'LEAD_INACTIVE', conditions: { afterDays: 7 },
        actions: [{ type: 'CREATE_TASK', title: 'Re-engage: no activity for 7 days', assignee: 'OWNER', dueInHours: 24, priority: 'MEDIUM' }, { type: 'NOTIFY', recipient: 'OWNER' }], isSystem: true },
      { name: 'Notify management on conversion', description: 'Lead converted → notify management', trigger: 'LEAD_CONVERTED', actions: [{ type: 'NOTIFY', recipient: 'MANAGERS' }], isSystem: true },
      { name: 'Escalate overdue follow-ups to managers', description: 'Follow-up overdue → notify managers (owner is always notified)', trigger: 'FOLLOWUP_OVERDUE', actions: [{ type: 'NOTIFY', recipient: 'MANAGERS' }], isSystem: true, isEnabled: false },
  ];
  await tx.automationRule.createMany({ data: templates.map((r) => ({ ...r, organizationId: orgId })) });
  return { roles, pipelineId: pipeline.id };
}
