import { planAdminSchema, recordPaymentSchema } from '@leadflow/shared';
import type { Prisma } from '@leadflow/database';
import { z } from 'zod';
import os from 'node:os';
import { platformPrisma as pdb, prisma } from '../../db';
import { AppError, notFound } from '../../lib/errors';
import { defineRoutes, paged, created, type SessionUser } from '../../http';
import { pageMeta, paginate, pageQuery } from '../../lib/pagination';
import { applyPayment } from '../subscriptions/lifecycle';
import { periodEnd } from '../subscriptions/service';
import { QUEUE_NAME, redisConnection, redisHealthy } from '../../lib/queue';
import { config } from '../../config';

export const platform = defineRoutes('Platform administration', '/platform');
const SUPPORT = ['SUPER_ADMIN', 'SUPPORT_ADMIN'] as const;
const BILLING = ['SUPER_ADMIN', 'BILLING_ADMIN'] as const;
const SUPER = ['SUPER_ADMIN'] as const;
const num = (v: unknown) => Number(v ?? 0);

async function paudit(actor: SessionUser, action: string, entityType?: string, entityId?: string, metadata: Prisma.InputJsonValue = {}, organizationId?: string) {
  await pdb.auditLog.create({ data: { organizationId: organizationId ?? null, actorId: actor.id, actorEmail: actor.email, scope: 'PLATFORM', action, entityType, entityId, metadata } });
}

platform.get('/dashboard', { auth: 'platform', summary: 'Platform KPIs' }, async () => {
  const day30 = new Date(Date.now() - 30 * 86_400_000);
  const [orgs, active, suspended, users, newOrgs, subs, plans, openInv, failedInv, paidInv, signups, overview] = await Promise.all([
    pdb.organization.count(), pdb.organization.count({ where: { status: 'ACTIVE' } }), pdb.organization.count({ where: { status: 'SUSPENDED' } }),
    pdb.user.count(), pdb.organization.count({ where: { createdAt: { gte: day30 } } }),
    pdb.subscription.findMany({ include: { plan: true } }),
    pdb.subscriptionPlan.findMany({ orderBy: { sortOrder: 'asc' } }),
    pdb.invoice.aggregate({ where: { status: 'OPEN' }, _sum: { amount: true }, _count: true }),
    pdb.invoice.aggregate({ where: { status: 'FAILED' }, _sum: { amount: true }, _count: true }),
    pdb.invoice.aggregate({ where: { status: 'PAID', paidAt: { gte: day30 } }, _sum: { amount: true }, _count: true }),
    pdb.$queryRaw<Array<{ day: string; orgs: bigint }>>`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*) AS orgs FROM organizations WHERE created_at >= ${day30} GROUP BY 1 ORDER BY 1`,
    pdb.$queryRaw<Array<{ leads: bigint; opps: bigint; seats: bigint }>>`SELECT COALESCE(sum(lead_count), 0) AS leads, COALESCE(sum(opportunity_count), 0) AS opps, COALESCE(sum(seat_count), 0) AS seats FROM platform_org_overview`,
  ]);
  const paying = subs.filter((s) => s.plan.code !== 'free' && ['ACTIVE', 'PAST_DUE'].includes(s.status));
  const mrr = paying.reduce((a, s) => a + (s.interval === 'YEARLY' ? num(s.plan.priceYearly) / 12 : num(s.plan.priceMonthly)), 0);
  const byStatus: Record<string, number> = {};
  for (const s of subs) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
  return {
    organizations: { total: orgs, active, suspended, newLast30Days: newOrgs }, users, mrr: Math.round(mrr * 100) / 100, payingOrganizations: paying.length,
    subscriptionsByStatus: byStatus, planDistribution: plans.map((p) => ({ code: p.code, name: p.name, count: subs.filter((s) => s.planId === p.id).length })),
    invoices: { open: { count: openInv._count, amount: num(openInv._sum.amount) }, failed: { count: failedInv._count, amount: num(failedInv._sum.amount) }, paidLast30Days: { count: paidInv._count, amount: num(paidInv._sum.amount) } },
    signups: signups.map((s) => ({ day: s.day, orgs: num(s.orgs) })),
    totals: { leads: num(overview[0]?.leads), opportunities: num(overview[0]?.opps), seats: num(overview[0]?.seats), note: 'Aggregate counts only — platform administrators cannot read customer lead records.' },
  };
});

platform.get('/organizations', { auth: 'platform', query: z.object({ ...pageQuery, q: z.string().optional(), status: z.string().optional(), plan: z.string().optional() }), summary: 'Registered organizations' }, async ({ query }) => {
  const where: Prisma.OrganizationWhereInput = {
    ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { slug: { contains: query.q, mode: 'insensitive' } }] } : {}),
    ...(query.status ? { status: query.status as never } : {}), ...(query.plan ? { subscription: { plan: { code: query.plan } } } : {}),
  };
  const [total, rows] = await Promise.all([pdb.organization.count({ where }), pdb.organization.findMany({ where, include: { subscription: { include: { plan: true } } }, orderBy: { createdAt: 'desc' }, ...paginate(query) })]);
  const usage = await pdb.$queryRaw<Array<{ organization_id: string; lead_count: number; seat_count: number; opportunity_count: number; last_lead_at: Date | null }>>`SELECT * FROM platform_org_overview WHERE organization_id = ANY(${rows.map((r) => r.id)}::uuid[])`;
  const um = new Map(usage.map((u) => [u.organization_id, u]));
  return paged(rows.map((o) => ({ id: o.id, name: o.name, slug: o.slug, industry: o.industry, status: o.status, createdAt: o.createdAt, plan: o.subscription ? { code: o.subscription.plan.code, name: o.subscription.plan.name } : null, subscriptionStatus: o.subscription?.status ?? null, leads: um.get(o.id)?.lead_count ?? 0, seats: um.get(o.id)?.seat_count ?? 0, maxLeads: o.subscription?.plan.maxLeads ?? 0, maxSeats: o.subscription?.plan.maxSeats ?? 0 })), pageMeta(query, total));
});

platform.get('/organizations/:id', { auth: 'platform', summary: 'Organization details (no lead data)' }, async ({ params }) => {
  const o = await pdb.organization.findUnique({ where: { id: params.id }, include: { subscription: { include: { plan: true } } } });
  if (!o) throw notFound('Organization');
  const [members, invoices, events, usage, logs, overview] = await Promise.all([
    pdb.membership.findMany({ where: { organizationId: o.id }, include: { user: { select: { id: true, name: true, email: true, isActive: true, lastLoginAt: true } }, role: { select: { name: true, systemKey: true } } }, orderBy: { joinedAt: 'asc' } }),
    pdb.invoice.findMany({ where: { organizationId: o.id }, orderBy: { issuedAt: 'desc' }, take: 20 }),
    pdb.subscriptionEvent.findMany({ where: { organizationId: o.id }, orderBy: { createdAt: 'desc' }, take: 30 }),
    pdb.usageRecord.findMany({ where: { organizationId: o.id }, orderBy: { day: 'desc' }, take: 30 }),
    pdb.auditLog.findMany({ where: { organizationId: o.id }, orderBy: { createdAt: 'desc' }, take: 30 }),
    pdb.$queryRaw<Array<{ lead_count: number; opportunity_count: number; seat_count: number; last_lead_at: Date | null }>>`SELECT * FROM platform_org_overview WHERE organization_id = ${o.id}::uuid`,
  ]);
  return {
    organization: { id: o.id, name: o.name, slug: o.slug, industry: o.industry, website: o.website, contactEmail: o.contactEmail, country: o.country, timezone: o.timezone, currency: o.currency, status: o.status, suspendedAt: o.suspendedAt, suspendedReason: o.suspendedReason, createdAt: o.createdAt, onboarded: !!o.onboardingCompletedAt },
    subscription: o.subscription && { ...o.subscription, plan: { ...o.subscription.plan, priceMonthly: num(o.subscription.plan.priceMonthly), priceYearly: num(o.subscription.plan.priceYearly) } },
    usage: { leads: overview[0]?.lead_count ?? 0, opportunities: overview[0]?.opportunity_count ?? 0, seats: overview[0]?.seat_count ?? 0, lastLeadAt: overview[0]?.last_lead_at ?? null, history: usage },
    members: members.map((m) => ({ id: m.id, userId: m.userId, name: m.user.name, email: m.user.email, role: m.role.name, roleKey: m.role.systemKey, status: m.status, isActive: m.user.isActive, lastLoginAt: m.user.lastLoginAt })),
    invoices: invoices.map((i) => ({ ...i, amount: num(i.amount) })), events, auditLogs: logs,
    privacy: 'Lead, opportunity, follow-up and activity data is intentionally not accessible from the platform area.',
  };
});

platform.post('/organizations/:id/suspend', { auth: 'platform', platformRoles: [...SUPPORT], body: z.object({ reason: z.string().trim().min(3, 'Give a reason').max(300) }), summary: 'Suspend an organization' }, async ({ user, params, body }) => {
  const o = await pdb.organization.findUnique({ where: { id: params.id } });
  if (!o) throw notFound('Organization');
  await pdb.organization.update({ where: { id: o.id }, data: { status: 'SUSPENDED', suspendedAt: new Date(), suspendedReason: body.reason } });
  await pdb.subscriptionEvent.create({ data: { organizationId: o.id, type: 'SUSPENDED', status: 'SUSPENDED', actorId: user.id, note: body.reason } });
  await paudit(user, 'organization.suspended', 'organization', o.id, { reason: body.reason }, o.id);
  return { status: 'SUSPENDED' };
});
platform.post('/organizations/:id/activate', { auth: 'platform', platformRoles: [...SUPPORT], summary: 'Re-activate a suspended organization' }, async ({ user, params }) => {
  const o = await pdb.organization.findUnique({ where: { id: params.id } });
  if (!o) throw notFound('Organization');
  await pdb.organization.update({ where: { id: o.id }, data: { status: 'ACTIVE', suspendedAt: null, suspendedReason: null } });
  await pdb.subscriptionEvent.create({ data: { organizationId: o.id, type: 'REACTIVATED', status: 'ACTIVE', actorId: user.id, note: 'Workspace re-activated by platform administrator' } });
  await paudit(user, 'organization.activated', 'organization', o.id, {}, o.id);
  return { status: 'ACTIVE' };
});

platform.get('/users', { auth: 'platform', query: z.object({ ...pageQuery, q: z.string().optional() }), summary: 'All users' }, async ({ query }) => {
  const where: Prisma.UserWhereInput = query.q ? { OR: [{ email: { contains: query.q, mode: 'insensitive' } }, { name: { contains: query.q, mode: 'insensitive' } }] } : {};
  const [total, rows] = await Promise.all([pdb.user.count({ where }), pdb.user.findMany({ where, include: { memberships: { include: { organization: { select: { id: true, name: true } }, role: { select: { name: true } } } } }, orderBy: { createdAt: 'desc' }, ...paginate(query) })]);
  return paged(rows.map((u) => ({ id: u.id, name: u.name, email: u.email, isActive: u.isActive, emailVerified: !!u.emailVerifiedAt, platformRole: u.platformRole, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt, workspaces: u.memberships.map((m) => ({ id: m.organization.id, name: m.organization.name, role: m.role.name, status: m.status })) })), pageMeta(query, total));
});
platform.post('/users/:id/status', { auth: 'platform', platformRoles: [...SUPPORT], body: z.object({ isActive: z.boolean() }), summary: 'Activate / deactivate a user account (revokes sessions)' }, async ({ user, params, body }) => {
  if (params.id === user.id) throw new AppError(409, 'SELF', 'You cannot change your own account status.');
  const u = await pdb.user.findUnique({ where: { id: params.id } });
  if (!u) throw notFound('User');
  await pdb.user.update({ where: { id: u.id }, data: { isActive: body.isActive } });
  if (!body.isActive) await pdb.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await paudit(user, body.isActive ? 'user.activated' : 'user.deactivated', 'user', u.id, { email: u.email });
  return { isActive: body.isActive };
});
platform.post('/users/:id/platform-role', { auth: 'platform', platformRoles: [...SUPER], body: z.object({ role: z.enum(['SUPER_ADMIN', 'SUPPORT_ADMIN', 'BILLING_ADMIN']).nullable() }), summary: 'Grant / revoke a platform administrator role' }, async ({ user, params, body }) => {
  if (params.id === user.id) throw new AppError(409, 'SELF', 'You cannot change your own platform role.');
  const u = await pdb.user.findUnique({ where: { id: params.id } });
  if (!u) throw notFound('User');
  await pdb.user.update({ where: { id: u.id }, data: { platformRole: body.role } });
  await paudit(user, 'user.platform_role_changed', 'user', u.id, { email: u.email, role: body.role });
  return { platformRole: body.role };
});

// ── Plans ──
platform.get('/plans', { auth: 'platform', summary: 'Subscription plans' }, async () => {
  const plans = await pdb.subscriptionPlan.findMany({ orderBy: { sortOrder: 'asc' }, include: { _count: { select: { subscriptions: true } } } });
  return plans.map((p) => ({ ...p, priceMonthly: num(p.priceMonthly), priceYearly: num(p.priceYearly), subscribers: p._count.subscriptions }));
});
platform.post('/plans', { auth: 'platform', platformRoles: [...BILLING], body: planAdminSchema, summary: 'Create a plan' }, async ({ user, body }) => {
  const p = await pdb.subscriptionPlan.create({ data: { ...body, description: body.description ?? null } });
  await paudit(user, 'plan.created', 'plan', p.id, { code: p.code });
  return created(p);
});
platform.patch('/plans/:id', { auth: 'platform', platformRoles: [...BILLING], body: planAdminSchema.partial().omit({ code: true }), summary: 'Update a plan (existing subscribers pick up new limits immediately)' }, async ({ user, params, body }) => {
  const p = await pdb.subscriptionPlan.findUnique({ where: { id: params.id } });
  if (!p) throw notFound('Plan');
  const u = await pdb.subscriptionPlan.update({ where: { id: p.id }, data: body });
  await paudit(user, 'plan.updated', 'plan', p.id, { fields: Object.keys(body) });
  return u;
});
platform.delete('/plans/:id', { auth: 'platform', platformRoles: [...BILLING], summary: 'Retire a plan (hidden for new subscriptions)' }, async ({ user, params }) => {
  const p = await pdb.subscriptionPlan.findUnique({ where: { id: params.id }, include: { _count: { select: { subscriptions: true } } } });
  if (!p) throw notFound('Plan');
  if (p.code === 'free') throw new AppError(409, 'PROTECTED', 'The Free plan is required and cannot be retired.');
  await pdb.subscriptionPlan.update({ where: { id: p.id }, data: { isActive: false, isPublic: false } });
  await paudit(user, 'plan.retired', 'plan', p.id);
  return { retired: true, subscribers: p._count.subscriptions };
});

// ── Subscriptions ──
platform.get('/subscriptions', { auth: 'platform', query: z.object({ ...pageQuery, status: z.string().optional(), plan: z.string().optional() }), summary: 'Subscription monitoring' }, async ({ query }) => {
  const where: Prisma.SubscriptionWhereInput = { ...(query.status ? { status: query.status as never } : {}), ...(query.plan ? { plan: { code: query.plan } } : {}) };
  const [total, rows] = await Promise.all([pdb.subscription.count({ where }), pdb.subscription.findMany({ where, include: { plan: true, organization: { select: { id: true, name: true, status: true } } }, orderBy: { currentPeriodEnd: 'asc' }, ...paginate(query) })]);
  return paged(rows.map((s) => ({ id: s.id, organization: s.organization, plan: { code: s.plan.code, name: s.plan.name }, interval: s.interval, status: s.status, trialEndsAt: s.trialEndsAt, currentPeriodEnd: s.currentPeriodEnd, graceEndsAt: s.graceEndsAt, cancelAtPeriodEnd: s.cancelAtPeriodEnd })), pageMeta(query, total));
});
platform.post('/subscriptions/:orgId/adjust', { auth: 'platform', platformRoles: [...BILLING], body: z.object({ planCode: z.string().optional(), interval: z.enum(['MONTHLY', 'YEARLY']).optional(), status: z.enum(['TRIALING', 'ACTIVE', 'PAST_DUE', 'EXPIRED', 'CANCELED']).optional(), extendDays: z.coerce.number().int().min(1).max(365).optional(), note: z.string().max(300).optional() }), summary: 'Manual subscription adjustment (audited)' }, async ({ user, params, body }) => {
  const sub = await pdb.subscription.findUnique({ where: { organizationId: params.orgId }, include: { plan: true } });
  if (!sub) throw notFound('Subscription');
  const data: Prisma.SubscriptionUncheckedUpdateInput = {};
  let toPlan = sub.plan.code;
  if (body.planCode) { const plan = await pdb.subscriptionPlan.findUnique({ where: { code: body.planCode } }); if (!plan) throw notFound('Plan'); data.planId = plan.id; toPlan = plan.code; }
  const interval = body.interval ?? sub.interval;
  if (body.interval) data.interval = body.interval;
  if (body.status) { data.status = body.status; if (body.status === 'ACTIVE' || body.status === 'TRIALING') data.graceEndsAt = null; }
  if (body.extendDays) {
    const base = sub.status === 'TRIALING' && sub.trialEndsAt ? sub.trialEndsAt : sub.currentPeriodEnd;
    const end = new Date(Math.max(base.getTime(), Date.now()) + body.extendDays * 86_400_000);
    data.currentPeriodEnd = end; if (sub.status === 'TRIALING') data.trialEndsAt = end;
  } else if (body.planCode && toPlan !== 'free') { data.currentPeriodStart = new Date(); data.currentPeriodEnd = periodEnd(new Date(), interval); }
  const u = await pdb.subscription.update({ where: { id: sub.id }, data });
  await pdb.subscriptionEvent.create({ data: { organizationId: sub.organizationId, type: 'MANUAL_ADJUSTMENT', fromPlanCode: sub.plan.code, toPlanCode: toPlan, status: u.status, actorId: user.id, note: body.note ?? 'Adjusted by platform administrator' } });
  await paudit(user, 'subscription.adjusted', 'subscription', sub.id, { ...body }, sub.organizationId);
  return { status: u.status };
});

// ── Invoices ──
platform.get('/invoices', { auth: 'platform', query: z.object({ ...pageQuery, status: z.string().optional(), q: z.string().optional() }), summary: 'Invoices across organizations' }, async ({ query }) => {
  const where: Prisma.InvoiceWhereInput = { ...(query.status ? { status: query.status as never } : {}), ...(query.q ? { OR: [{ number: { contains: query.q, mode: 'insensitive' } }, { organization: { name: { contains: query.q, mode: 'insensitive' } } }] } : {}) };
  const [total, rows, agg] = await Promise.all([pdb.invoice.count({ where }), pdb.invoice.findMany({ where, include: { organization: { select: { id: true, name: true } }, plan: { select: { name: true } } }, orderBy: { issuedAt: 'desc' }, ...paginate(query) }), pdb.invoice.aggregate({ where, _sum: { amount: true } })]);
  return paged(rows.map((i) => ({ ...i, amount: num(i.amount) })), { ...pageMeta(query, total), totalAmount: num(agg._sum.amount) });
});
platform.post('/invoices/:id/mark-paid', { auth: 'platform', platformRoles: [...BILLING], body: recordPaymentSchema, summary: 'MANUAL: record a payment received outside the system' }, async ({ user, params, body }) => {
  const inv = await pdb.invoice.findUnique({ where: { id: params.id } });
  if (!inv) throw notFound('Invoice');
  if (inv.status === 'PAID' || inv.status === 'VOID') throw new AppError(409, 'NOT_PAYABLE', `Invoice is already ${inv.status.toLowerCase()}.`);
  await pdb.$transaction(async (tx) => { await applyPayment(inv.id, { actorId: user.id, reference: body.reference, method: 'MANUAL_PLATFORM', note: body.note }, tx); });
  await paudit(user, 'invoice.marked_paid', 'invoice', inv.id, { number: inv.number, reference: body.reference }, inv.organizationId);
  return { paid: true };
});
platform.post('/invoices/:id/mark-failed', { auth: 'platform', platformRoles: [...BILLING], body: z.object({ reason: z.string().trim().min(3).max(300) }), summary: 'Record a failed payment' }, async ({ user, params, body }) => {
  const inv = await pdb.invoice.findUnique({ where: { id: params.id } });
  if (!inv) throw notFound('Invoice');
  if (inv.status === 'PAID' || inv.status === 'VOID') throw new AppError(409, 'NOT_PAYABLE', `Invoice is already ${inv.status.toLowerCase()}.`);
  await pdb.invoice.update({ where: { id: inv.id }, data: { status: 'FAILED', failedAt: new Date(), failureReason: body.reason } });
  const sub = await pdb.subscription.findUnique({ where: { organizationId: inv.organizationId } });
  if (sub && sub.status === 'ACTIVE' && sub.planId) {
    await pdb.subscription.update({ where: { id: sub.id }, data: { status: 'PAST_DUE', graceEndsAt: new Date(Date.now() + 7 * 86_400_000) } });
    await pdb.subscriptionEvent.create({ data: { organizationId: inv.organizationId, type: 'PAYMENT_FAILED', status: 'PAST_DUE', actorId: user.id, note: body.reason } });
  }
  await paudit(user, 'invoice.marked_failed', 'invoice', inv.id, { number: inv.number, reason: body.reason }, inv.organizationId);
  return { failed: true };
});
platform.post('/invoices/:id/void', { auth: 'platform', platformRoles: [...BILLING], summary: 'Void an unpaid invoice' }, async ({ user, params }) => {
  const inv = await pdb.invoice.findUnique({ where: { id: params.id } });
  if (!inv) throw notFound('Invoice');
  if (inv.status === 'PAID') throw new AppError(409, 'PAID', 'Paid invoices cannot be voided.');
  await pdb.invoice.update({ where: { id: inv.id }, data: { status: 'VOID' } });
  await paudit(user, 'invoice.voided', 'invoice', inv.id, { number: inv.number }, inv.organizationId);
  return { voided: true };
});

platform.get('/usage', { auth: 'platform', query: z.object(pageQuery), summary: 'Usage vs plan limits per organization' }, async ({ query }) => {
  const rows = await pdb.$queryRaw<Array<{ id: string; name: string; plan: string; max_leads: number; max_seats: number; lead_count: number; seat_count: number; opportunity_count: number }>>`
    SELECT o.id, o.name, p.name AS plan, p.max_leads, p.max_seats, v.lead_count, v.seat_count, v.opportunity_count FROM organizations o
    JOIN platform_org_overview v ON v.organization_id = o.id LEFT JOIN subscriptions s ON s.organization_id = o.id LEFT JOIN subscription_plans p ON p.id = s.plan_id
    ORDER BY (v.lead_count::float / NULLIF(p.max_leads, 0)) DESC NULLS LAST LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`;
  const total = await pdb.organization.count();
  return paged(rows.map((r) => ({ id: r.id, name: r.name, plan: r.plan, leads: r.lead_count, maxLeads: r.max_leads, seats: r.seat_count, maxSeats: r.max_seats, opportunities: r.opportunity_count, leadUtilization: r.max_leads ? Math.round((r.lead_count / r.max_leads) * 100) : 0, seatUtilization: r.max_seats ? Math.round((r.seat_count / r.max_seats) * 100) : 0 })), pageMeta(query, total));
});

platform.get('/audit-logs', { auth: 'platform', query: z.object({ ...pageQuery, scope: z.enum(['PLATFORM', 'TENANT', 'ALL']).default('ALL'), organizationId: z.string().uuid().optional(), action: z.string().optional() }), summary: 'Platform audit trail' }, async ({ query }) => {
  const where: Prisma.AuditLogWhereInput = { ...(query.scope !== 'ALL' ? { scope: query.scope } : {}), ...(query.organizationId ? { organizationId: query.organizationId } : {}), ...(query.action ? { action: { contains: query.action } } : {}) };
  const [total, rows] = await Promise.all([pdb.auditLog.count({ where }), pdb.auditLog.findMany({ where, include: { organization: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, ...paginate(query) })]);
  return paged(rows.map((r) => ({ id: r.id, scope: r.scope, action: r.action, entityType: r.entityType, entityId: r.entityId, actorEmail: r.actorEmail, organization: r.organization?.name ?? null, metadata: r.metadata, createdAt: r.createdAt })), pageMeta(query, total));
});

platform.get('/health', { auth: 'platform', summary: 'System health' }, async () => {
  const t0 = Date.now();
  let db = false; let dbMs = 0;
  try { await prisma.$queryRaw`SELECT 1`; db = true; dbMs = Date.now() - t0; } catch { db = false; }
  const redis = await redisHealthy();
  let queue: Record<string, number> | null = null;
  if (redis) {
    try { const { Queue } = await import('bullmq'); const q = new Queue(QUEUE_NAME, { connection: redisConnection() }); queue = await q.getJobCounts('waiting', 'active', 'failed', 'delayed', 'completed'); await q.close(); } catch { queue = null; }
  }
  const [migrations] = await pdb.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL`.catch(() => [{ n: 0n }]);
  return {
    status: db && redis ? 'healthy' : db ? 'degraded' : 'down',
    checks: { database: { ok: db, latencyMs: dbMs }, redis: { ok: redis }, queue: { ok: !!queue, counts: queue } },
    system: { node: process.version, uptimeSeconds: Math.round(process.uptime()), memoryMb: Math.round(process.memoryUsage().rss / 1048576), loadAvg: os.loadavg().map((l) => Math.round(l * 100) / 100), env: config.env, appliedMigrations: Number(migrations?.n ?? 0) },
    jobsMode: config.jobsInline ? 'inline' : 'bullmq',
  };
});
