import { changePlanSchema, PLAN_FEATURES } from '@leadflow/shared';
import { db } from '../../db';
import { AppError, notFound } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { defineRoutes } from '../../http';
import { createRenewalInvoice } from './lifecycle';
import { publicPayment } from './manual-billing';
import { GRACE_PERIOD_DAYS, getUsage, nextInvoiceNumber, periodEnd, recordSubscriptionEvent } from './service';

export const billing = defineRoutes('Billing', '/billing');

const money = (v: unknown) => Number(v);
const price = (p: { priceMonthly: unknown; priceYearly: unknown }, i: 'MONTHLY' | 'YEARLY') => money(i === 'YEARLY' ? p.priceYearly : p.priceMonthly);

billing.get('/', { perm: ['billing.view', 'billing.manage'], allowExpired: true, allowSuspended: true, summary: 'Subscription, usage, invoices and history' }, async ({ ctx }) => {
  const [sub, usage, invoices, events, plans, payments] = await Promise.all([
    db().subscription.findUnique({ where: { organizationId: ctx.orgId }, include: { plan: true } }),
    getUsage(ctx),
    db().invoice.findMany({ where: { organizationId: ctx.orgId }, orderBy: { issuedAt: 'desc' }, take: 50, include: { plan: { select: { code: true, name: true } } } }),
    db().subscriptionEvent.findMany({ where: { organizationId: ctx.orgId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    db().subscriptionPlan.findMany({ where: { isActive: true, isPublic: true }, orderBy: { sortOrder: 'asc' } }),
    db().payment.findMany({ where: { organizationId: ctx.orgId }, orderBy: { receivedAt: 'desc' }, take: 100 }),
  ]);
  const pendingPlan = sub?.pendingPlanId ? plans.find((p) => p.id === sub.pendingPlanId) ?? (await db().subscriptionPlan.findUnique({ where: { id: sub.pendingPlanId } })) : null;
  return {
    subscription: sub && { id: sub.id, status: sub.status, interval: sub.interval, trialEndsAt: sub.trialEndsAt, currentPeriodStart: sub.currentPeriodStart, currentPeriodEnd: sub.currentPeriodEnd, graceEndsAt: sub.graceEndsAt, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, pendingPlan: pendingPlan ? { code: pendingPlan.code, name: pendingPlan.name } : null, plan: { ...sub.plan, priceMonthly: money(sub.plan.priceMonthly), priceYearly: money(sub.plan.priceYearly) } },
    usage, graceDays: GRACE_PERIOD_DAYS,
    invoices: invoices.map((i) => ({ ...i, amount: money(i.amount) })),
    events,
    payments: payments.map(publicPayment),
    plans: plans.map((p) => ({ ...p, priceMonthly: money(p.priceMonthly), priceYearly: money(p.priceYearly) })),
    features: PLAN_FEATURES,
    paymentNote: 'Payments are confirmed manually by LeadFlow billing after the money has been received. Your plan and expiry date change only when a payment is confirmed; you cannot mark invoices as paid yourself.',
  };
});

billing.post('/change-plan', { perm: 'billing.manage', allowExpired: true, body: changePlanSchema, summary: 'Upgrade / downgrade. Upgrades issue an invoice that activates when paid; downgrades apply at period end.' }, async ({ ctx, body }) => {
  const sub = await db().subscription.findUniqueOrThrow({ where: { organizationId: ctx.orgId }, include: { plan: true } });
  const target = await db().subscriptionPlan.findFirst({ where: { code: body.planCode, isActive: true } });
  if (!target) throw notFound('Plan');
  const usage = await getUsage(ctx);
  if (usage.seats > target.maxSeats) throw new AppError(409, 'PLAN_USAGE_EXCEEDS', `You have ${usage.seats} active members but ${target.name} allows ${target.maxSeats}. Deactivate members first.`);
  if (usage.leads > target.maxLeads) throw new AppError(409, 'PLAN_USAGE_EXCEEDS', `You have ${usage.leads} active leads but ${target.name} allows ${target.maxLeads}. Archive leads first.`);
  if (target.id === sub.planId && body.interval === sub.interval && sub.status !== 'EXPIRED' && sub.status !== 'PAST_DUE') throw new AppError(409, 'NO_CHANGE', 'You are already on this plan and billing cycle.');

  const currentPaid = sub.plan.code !== 'free' && sub.status === 'ACTIVE';
  const newPrice = price(target, body.interval);
  const curPrice = price(sub.plan, sub.interval);
  const isUpgrade = target.code !== 'free' && (!currentPaid || newPrice > curPrice || sub.status === 'EXPIRED' || sub.status === 'PAST_DUE');

  if (target.code === 'free' || !isUpgrade) {
    if (!currentPaid) {
      // trial / free → free: immediate
      const free = target;
      await db().subscription.update({ where: { id: sub.id }, data: { planId: free.id, status: 'ACTIVE', trialEndsAt: null, interval: 'MONTHLY', pendingPlanId: null } });
      await recordSubscriptionEvent(ctx.orgId, { type: 'PLAN_CHANGED', fromPlanCode: sub.plan.code, toPlanCode: free.code, status: 'ACTIVE', actorId: ctx.userId });
      await audit(ctx, 'billing.plan_changed', 'subscription', sub.id, { to: free.code });
      return { applied: 'immediately' };
    }
    await db().subscription.update({ where: { id: sub.id }, data: { pendingPlanId: target.id, pendingInterval: body.interval } });
    await recordSubscriptionEvent(ctx.orgId, { type: 'DOWNGRADE_SCHEDULED', fromPlanCode: sub.plan.code, toPlanCode: target.code, status: sub.status, actorId: ctx.userId, note: `Takes effect ${sub.currentPeriodEnd.toISOString().slice(0, 10)}` });
    await audit(ctx, 'billing.downgrade_scheduled', 'subscription', sub.id, { to: target.code });
    return { applied: 'at_period_end', effectiveAt: sub.currentPeriodEnd };
  }
  await db().invoice.updateMany({ where: { organizationId: ctx.orgId, status: 'OPEN' }, data: { status: 'VOID' } });
  const start = new Date();
  const inv = await db().invoice.create({
    data: { organizationId: ctx.orgId, number: await nextInvoiceNumber(), planId: target.id, interval: body.interval, description: `${target.name} plan — ${body.interval === 'YEARLY' ? 'annual' : 'monthly'} subscription`, status: 'OPEN', amount: newPrice, currency: target.currency, periodStart: start, periodEnd: periodEnd(start, body.interval), dueAt: new Date(start.getTime() + 7 * 86_400_000) },
  });
  await recordSubscriptionEvent(ctx.orgId, { type: 'UPGRADE_INVOICED', fromPlanCode: sub.plan.code, toPlanCode: target.code, status: sub.status, actorId: ctx.userId, note: `Invoice ${inv.number} issued; plan activates once payment is recorded` });
  await audit(ctx, 'billing.upgrade_invoiced', 'invoice', inv.id, { to: target.code, amount: newPrice });
  return { applied: 'pending_payment', invoiceId: inv.id, invoiceNumber: inv.number };
});

billing.post('/cancel', { perm: 'billing.manage', summary: 'Cancel at period end' }, async ({ ctx }) => {
  const sub = await db().subscription.findUniqueOrThrow({ where: { organizationId: ctx.orgId }, include: { plan: true } });
  if (sub.plan.code === 'free') throw new AppError(409, 'ALREADY_FREE', 'The Free plan has nothing to cancel.');
  await db().subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
  await recordSubscriptionEvent(ctx.orgId, { type: 'CANCEL_SCHEDULED', fromPlanCode: sub.plan.code, status: sub.status, actorId: ctx.userId });
  await audit(ctx, 'billing.cancel_scheduled', 'subscription', sub.id);
  return { cancelAtPeriodEnd: true };
});
billing.post('/reactivate', { perm: 'billing.manage', allowExpired: true, summary: 'Undo a scheduled cancellation / downgrade; for an expired workspace issue a renewal invoice' }, async ({ ctx }) => {
  const sub = await db().subscription.findUniqueOrThrow({ where: { organizationId: ctx.orgId }, include: { plan: true } });
  if (sub.status === 'EXPIRED' && sub.plan.code !== 'free') {
    const open = await db().invoice.findFirst({ where: { organizationId: ctx.orgId, status: { in: ['OPEN', 'FAILED'] } }, orderBy: { issuedAt: 'desc' } });
    if (open) return { invoiceId: open.id, invoiceNumber: open.number, applied: 'pending_payment' };
    const inv = await createRenewalInvoice(ctx.orgId, sub.planId, sub.interval, new Date());
    return { invoiceId: inv.id, invoiceNumber: inv.number, applied: 'pending_payment' };
  }
  await db().subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: false, pendingPlanId: null, pendingInterval: null } });
  await recordSubscriptionEvent(ctx.orgId, { type: 'REACTIVATED', toPlanCode: sub.plan.code, status: sub.status, actorId: ctx.userId });
  return { cancelAtPeriodEnd: false };
});

billing.get('/invoices/:id', { perm: ['billing.view', 'billing.manage'], allowExpired: true, allowSuspended: true, summary: 'Invoice detail' }, async ({ ctx, params }) => {
  const inv = await db().invoice.findFirst({ where: { id: params.id, organizationId: ctx.orgId }, include: { plan: { select: { code: true, name: true } } } });
  if (!inv) throw notFound('Invoice');
  const org = await db().organization.findUniqueOrThrow({ where: { id: ctx.orgId } });
  return { ...inv, amount: money(inv.amount), billTo: { name: org.name, email: org.contactEmail, address: org.address, country: org.country } };
});

// NOTE: there is intentionally NO endpoint for a workspace to mark an invoice paid or to change its expiry. Payments are confirmed
// by a platform administrator (modules/platform-admin) after the money was actually received; the database additionally refuses
// such changes from the application role (triggers invoices_paid_guard / subscriptions_change_guard, payments is read-only).
