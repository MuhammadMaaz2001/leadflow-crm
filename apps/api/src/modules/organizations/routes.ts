import { createOrgSchema, onboardingSchema, orgProfileSchema, slugify, SYSTEM_ROLES } from '@leadflow/shared';
import { z } from 'zod';
import { db, setOrg } from '../../db';
import { config } from '../../config';
import { uuid, randomToken } from '../../lib/crypto';
import { audit } from '../../lib/audit';
import { created, defineRoutes, RawReply } from '../../http';
import { notFound } from '../../lib/errors';
import { isOwnLogoUrl, presentLogo, readStoredLogo, storeLogo } from '../../lib/storage';
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
    organization: { ...org, createdAt: org.createdAt, logoData: presentLogo(org.id, org.logoData) },
    role: { id: ctx.roleId, key: ctx.roleKey }, permissions: ctx.permissions,
    subscription: sub && { status: sub.status, planCode: sub.plan.code, planName: sub.plan.name, features: sub.plan.features, trialEndsAt: sub.trialEndsAt, currentPeriodEnd: sub.currentPeriodEnd, graceEndsAt: sub.graceEndsAt, interval: sub.interval },
    usage,
    // In production invoices are settled by the platform (or a payment provider); tenants cannot mark their own invoices paid.
    billing: { selfServiceManualPayment: config.devTools },
  };
});

orgs.patch('/current', { perm: 'settings.manage', body: orgProfileSchema.partial(), summary: 'Update company profile & workspace configuration' }, async ({ ctx, body }) => {
  const { autoAssignMode, logoData, ...rest } = body;
  if (autoAssignMode && autoAssignMode !== 'NONE' && !ctx.plan.features.includes('rule_assignment') && autoAssignMode === 'RULES') {
    const { paymentRequired } = await import('../../lib/errors');
    throw paymentRequired('Rule-based assignment requires the Professional plan.', 'FEATURE_NOT_IN_PLAN');
  }
  const logo = await nextLogo(ctx.orgId, logoData);
  const org = await db().organization.update({ where: { id: ctx.orgId }, data: { ...rest, autoAssignMode, ...logo } });
  await audit(ctx, 'workspace.updated', 'organization', ctx.orgId, { fields: Object.keys(body) });
  return { ...org, logoData: presentLogo(org.id, org.logoData) };
});

orgs.post('/current/onboarding', { perm: 'settings.manage', body: onboardingSchema, summary: 'Save onboarding wizard step / complete onboarding' }, async ({ ctx, body }) => {
  const { complete, logoData, ...rest } = body;
  const logo = await nextLogo(ctx.orgId, logoData);
  const org = await db().organization.update({ where: { id: ctx.orgId }, data: { ...rest, ...logo, ...(complete ? { onboardingCompletedAt: new Date() } : {}) } });
  if (complete) await audit(ctx, 'workspace.onboarded', 'organization', ctx.orgId);
  return { ...org, logoData: presentLogo(org.id, org.logoData) };
});

/** Validates and stores a submitted logo. Our own logo URL echoed back by the UI means "unchanged". */
async function nextLogo(orgId: string, submitted: string | null | undefined): Promise<{ logoData?: string | null }> {
  if (submitted === undefined || isOwnLogoUrl(submitted)) return {};
  const valid = validateLogo(submitted);
  const prev = (await db().organization.findUniqueOrThrow({ where: { id: orgId }, select: { logoData: true } })).logoData;
  return { logoData: await storeLogo(orgId, valid, prev) };
}

/** Serves a stored logo to members of that workspace only (the bucket itself stays private). */
orgs.get('/:orgId/logo', { auth: 'user', summary: 'Workspace logo (object storage)' }, async ({ user, params }) => {
  if (!/^[0-9a-f-]{36}$/.test(params.orgId!)) throw notFound('Logo');
  const m = await db().membership.findFirst({ where: { organizationId: params.orgId, userId: user.id, status: 'ACTIVE' }, select: { organization: { select: { logoData: true } } } });
  const obj = m ? await readStoredLogo(m.organization.logoData) : null;
  if (!obj) throw notFound('Logo');
  return new RawReply(obj.contentType, obj.body, { 'Cache-Control': 'private, max-age=86400', 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff' });
});

orgs.get('/current/roles-summary', { summary: 'Role keys' }, async () => SYSTEM_ROLES.map((r) => ({ key: r.key, name: r.name })));
void z;
