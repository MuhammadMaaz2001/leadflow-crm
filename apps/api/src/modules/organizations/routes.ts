import { createOrgSchema, onboardingSchema, orgProfileSchema, slugify, SYSTEM_ROLES } from '@leadflow/shared';
import { z } from 'zod';
import { db, setOrg } from '../../db';
import { uuid, randomToken } from '../../lib/crypto';
import { audit } from '../../lib/audit';
import { created, defineRoutes } from '../../http';
import { startTrial, getUsage } from '../subscriptions/service';
import { bootstrapWorkspace } from './bootstrap';
import { validateLogo } from '../../lib/upload';
import { workspacesFor } from '../auth/routes';

export const orgs = defineRoutes('Workspaces', '/organizations');

orgs.post('/', { auth: 'user', body: createOrgSchema, summary: 'Create a workspace (caller becomes Owner)' }, async ({ user, body }) => {
  const id = uuid();
  await setOrg(id);
  const slug = `${slugify(body.name)}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
  await db().organization.create({ data: { id, name: body.name, slug, industry: body.industry, createdById: user.id } });
  const { roles } = await bootstrapWorkspace(id);
  await db().membership.create({ data: { organizationId: id, userId: user.id, roleId: roles['OWNER']! } });
  await startTrial(id, user.id);
  await db().auditLog.create({ data: { organizationId: id, actorId: user.id, actorEmail: user.email, action: 'workspace.created', entityType: 'organization', entityId: id, metadata: { name: body.name } } });
  const workspaces = await workspacesFor(user.id);
  return created({ id, workspaces });
});

orgs.get('/current', { allowSuspended: true, summary: 'Current workspace details, plan and usage' }, async ({ ctx }) => {
  const org = await db().organization.findUniqueOrThrow({ where: { id: ctx.orgId } });
  const sub = await db().subscription.findUnique({ where: { organizationId: ctx.orgId }, include: { plan: true } });
  const usage = await getUsage(ctx);
  return {
    organization: { ...org, createdAt: org.createdAt },
    role: { id: ctx.roleId, key: ctx.roleKey }, permissions: ctx.permissions,
    subscription: sub && { status: sub.status, planCode: sub.plan.code, planName: sub.plan.name, features: sub.plan.features, trialEndsAt: sub.trialEndsAt, currentPeriodEnd: sub.currentPeriodEnd, graceEndsAt: sub.graceEndsAt, interval: sub.interval },
    usage,
  };
});

orgs.patch('/current', { perm: 'settings.manage', body: orgProfileSchema.partial(), summary: 'Update company profile & workspace configuration' }, async ({ ctx, body }) => {
  const { autoAssignMode, logoData, ...rest } = body;
  if (autoAssignMode && autoAssignMode !== 'NONE' && !ctx.plan.features.includes('rule_assignment') && autoAssignMode === 'RULES') {
    const { paymentRequired } = await import('../../lib/errors');
    throw paymentRequired('Rule-based assignment requires the Professional plan.', 'FEATURE_NOT_IN_PLAN');
  }
  const org = await db().organization.update({ where: { id: ctx.orgId }, data: { ...rest, autoAssignMode, ...(logoData !== undefined ? { logoData: validateLogo(logoData) } : {}) } });
  await audit(ctx, 'workspace.updated', 'organization', ctx.orgId, { fields: Object.keys(body) });
  return org;
});

orgs.post('/current/onboarding', { perm: 'settings.manage', body: onboardingSchema, summary: 'Save onboarding wizard step / complete onboarding' }, async ({ ctx, body }) => {
  const { complete, logoData, ...rest } = body;
  const org = await db().organization.update({ where: { id: ctx.orgId }, data: { ...rest, ...(logoData !== undefined ? { logoData: validateLogo(logoData) } : {}), ...(complete ? { onboardingCompletedAt: new Date() } : {}) } });
  if (complete) await audit(ctx, 'workspace.onboarded', 'organization', ctx.orgId);
  return org;
});

orgs.get('/current/roles-summary', { summary: 'Role keys' }, async () => SYSTEM_ROLES.map((r) => ({ key: r.key, name: r.name })));
void z;
