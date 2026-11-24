import type { Prisma } from '@leadflow/database';
import { addDays } from 'date-fns';
import { db } from '../../db';
import { notify } from '../notifications/service';
import { GRACE_PERIOD_DAYS, nextInvoiceNumber, periodEnd, recordSubscriptionEvent } from './service';

async function ownerIds(orgId: string) {
  const rows = await db().membership.findMany({ where: { organizationId: orgId, status: 'ACTIVE', role: { permissions: { has: 'billing.manage' } } }, select: { userId: true } });
  return rows.map((r) => r.userId);
}

export async function createRenewalInvoice(orgId: string, planId: string, interval: 'MONTHLY' | 'YEARLY', start: Date) {
  const plan = await db().subscriptionPlan.findUniqueOrThrow({ where: { id: planId } });
  const amount = interval === 'YEARLY' ? plan.priceYearly : plan.priceMonthly;
  const end = periodEnd(start, interval);
  return db().invoice.create({
    data: {
      organizationId: orgId, number: await nextInvoiceNumber(), planId, interval, description: `${plan.name} plan — ${interval === 'YEARLY' ? 'annual' : 'monthly'} renewal`, status: 'OPEN',
      amount, currency: plan.currency, periodStart: start, periodEnd: end, dueAt: start,
    },
  });
}

/** Applies lifecycle transitions: trial end, renewals, grace period, expiry. Idempotent. */
export async function runSubscriptionLifecycle(orgId: string, now = new Date()) {
  const sub = await db().subscription.findUnique({ where: { organizationId: orgId }, include: { plan: true } });
  if (!sub) return;
  const free = await db().subscriptionPlan.findUnique({ where: { code: 'free' } });
  const owners = await ownerIds(orgId);

  if (sub.status === 'TRIALING' && sub.trialEndsAt && sub.trialEndsAt <= now && free) {
    await db().subscription.update({ where: { id: sub.id }, data: { planId: free.id, status: 'ACTIVE', trialEndsAt: null, currentPeriodStart: now, currentPeriodEnd: addDays(now, 36500), interval: 'MONTHLY' } });
    await recordSubscriptionEvent(orgId, { type: 'TRIAL_ENDED', fromPlanCode: sub.plan.code, toPlanCode: 'free', status: 'ACTIVE', note: 'Trial ended without payment — moved to the Free plan' });
    await notify({ userIds: owners, type: 'BILLING', title: 'Your trial has ended', body: 'You are now on the Free plan. Upgrade to restore paid features.', link: '/billing' });
    return;
  }
  if (sub.status === 'ACTIVE' && sub.plan.code !== 'free' && sub.currentPeriodEnd <= now) {
    const pending = sub.pendingPlanId ? await db().subscriptionPlan.findUnique({ where: { id: sub.pendingPlanId } }) : null;
    const nextPlan = pending ?? sub.plan;
    const interval = sub.pendingInterval ?? sub.interval;
    if ((sub.cancelAtPeriodEnd || nextPlan.code === 'free') && free) {
      await db().subscription.update({ where: { id: sub.id }, data: { planId: free.id, status: 'ACTIVE', cancelAtPeriodEnd: false, pendingPlanId: null, pendingInterval: null, currentPeriodStart: now, currentPeriodEnd: addDays(now, 36500), canceledAt: sub.cancelAtPeriodEnd ? now : null } });
      await recordSubscriptionEvent(orgId, { type: sub.cancelAtPeriodEnd ? 'CANCELED' : 'PLAN_CHANGED', fromPlanCode: sub.plan.code, toPlanCode: 'free', status: 'ACTIVE', note: 'Applied at period end' });
      await notify({ userIds: owners, type: 'BILLING', title: 'Your subscription has ended', body: 'The workspace is now on the Free plan.', link: '/billing' });
      return;
    }
    const open = await db().invoice.findFirst({ where: { organizationId: orgId, status: 'OPEN', periodStart: { gte: sub.currentPeriodEnd } } });
    if (!open) await createRenewalInvoice(orgId, nextPlan.id, interval, sub.currentPeriodEnd);
    await db().subscription.update({ where: { id: sub.id }, data: { status: 'PAST_DUE', graceEndsAt: addDays(sub.currentPeriodEnd, GRACE_PERIOD_DAYS) } });
    await recordSubscriptionEvent(orgId, { type: 'PAYMENT_DUE', fromPlanCode: sub.plan.code, toPlanCode: nextPlan.code, status: 'PAST_DUE', note: `Renewal invoice issued; ${GRACE_PERIOD_DAYS}-day grace period started` });
    await notify({ userIds: owners, type: 'BILLING', title: 'Payment required', body: `Your renewal invoice is unpaid. Access continues until ${addDays(sub.currentPeriodEnd, GRACE_PERIOD_DAYS).toDateString()}.`, link: '/billing', dedupeKey: `past-due:${sub.id}:${sub.currentPeriodEnd.getTime()}` });
    return;
  }
  if (sub.status === 'PAST_DUE' && sub.graceEndsAt && sub.graceEndsAt <= now) {
    await db().subscription.update({ where: { id: sub.id }, data: { status: 'EXPIRED' } });
    await db().invoice.updateMany({ where: { organizationId: orgId, status: 'OPEN' }, data: { status: 'FAILED', failedAt: now, failureReason: 'Not paid within the grace period' } });
    await recordSubscriptionEvent(orgId, { type: 'EXPIRED', fromPlanCode: sub.plan.code, status: 'EXPIRED', note: 'Grace period ended without payment; workspace is read-only' });
    await notify({ userIds: owners, type: 'BILLING', title: 'Subscription expired', body: 'Your workspace is now read-only. Pay the outstanding invoice to restore access.', link: '/billing', dedupeKey: `expired:${sub.id}:${sub.graceEndsAt.getTime()}` });
  }
}

/** Mark an invoice paid (manual / development payment) and apply the plan it bought. */
export async function applyPayment(invoiceId: string, opts: { actorId: string | null; reference: string; method?: string; note?: string }, client: Prisma.TransactionClient = db()) {
  const inv = await client.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const now = new Date();
  await client.invoice.update({ where: { id: inv.id }, data: { status: 'PAID', paidAt: now, paymentMethod: opts.method ?? 'MANUAL_DEV', paymentReference: opts.reference, recordedById: opts.actorId, failedAt: null, failureReason: null } });
  if (inv.planId && inv.periodStart && inv.periodEnd) {
    const sub = await client.subscription.findUnique({ where: { organizationId: inv.organizationId }, include: { plan: true } });
    const plan = await client.subscriptionPlan.findUniqueOrThrow({ where: { id: inv.planId } });
    if (sub) {
      // an upgrade starts a fresh period now; a renewal continues from the previous period end
      const start = inv.periodStart > now ? now : inv.periodStart;
      const isRenewal = sub.planId === inv.planId && sub.currentPeriodEnd <= now;
      const s = isRenewal ? inv.periodStart : now;
      void start;
      const e = isRenewal ? inv.periodEnd : periodEnd(now, inv.interval ?? 'MONTHLY');
      await client.subscription.update({ where: { id: sub.id }, data: { planId: plan.id, interval: inv.interval ?? 'MONTHLY', status: 'ACTIVE', trialEndsAt: null, currentPeriodStart: s, currentPeriodEnd: e, graceEndsAt: null, pendingPlanId: null, pendingInterval: null, cancelAtPeriodEnd: false } });
      await client.subscriptionEvent.create({ data: { organizationId: inv.organizationId, type: sub.planId === plan.id ? 'RENEWED' : 'PLAN_CHANGED', fromPlanCode: sub.plan.code, toPlanCode: plan.code, status: 'ACTIVE', actorId: opts.actorId, note: `Invoice ${inv.number} recorded as paid (${opts.method ?? 'MANUAL_DEV'}, ref ${opts.reference})` } });
    }
  }
  return inv;
}
