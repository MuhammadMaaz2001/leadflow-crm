import { Prisma } from '@leadflow/database';
import { addDays, addMonths } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import type { ManualPaymentInput } from '@leadflow/shared';
import { platformPrisma as pdb, withContext } from '../../db';
import { AppError, notFound } from '../../lib/errors';
import { log } from '../../lib/logger';
import { notify } from '../notifications/service';
import { GRACE_PERIOD_DAYS } from './service';

/**
 * Manual billing — the only active payment workflow. A platform administrator confirms a payment that was received OUTSIDE the
 * system (bank transfer, cash …); only then is a subscription extended. Everything happens in ONE database transaction that holds a
 * row lock on the workspace's subscription, so confirming a payment, extending the period, marking the invoice paid, writing the
 * receipt and the history entry either all happen or none does, and two administrators can never extend the same workspace twice
 * by accident (idempotency key + unique payment reference + the lock).
 *
 * EXTENSION POLICY (documented in ARCHITECTURE.md / DEPLOYMENT.md, covered by tests):
 *  1. Same paid plan, still running (expiry in the future)            → extend FROM THE CURRENT EXPIRY (never reset from today).
 *  2. Same paid plan, expired less than the grace period (7 days) ago → continue from the old expiry (no gap is billed or lost).
 *  3. Trial still running                                             → paid period starts when the trial would have ended.
 *  4. Everything else: expired beyond grace, canceled, Free → paid, or a DIFFERENT plan (upgrade/downgrade)
 *                                                                      → the new period starts at the confirmation moment, no proration.
 *  Months are calendar months in the WORKSPACE timezone (wall-clock time is preserved across DST; Jan 31 + 1 month = Feb 28/29);
 *  a custom extension is a number of days. Creating an invoice never extends anything; only a confirmed payment (or an explicit,
 *  reasoned, audited extension without payment) does.
 */
export interface Extension { months?: number; days?: number }
export type ExtensionBase = 'CURRENT_EXPIRY' | 'TRIAL_END' | 'PAYMENT_DATE' | 'PLAN_CHANGE';
type Db = Prisma.TransactionClient;
type PlanRow = { id: string; code: string; name: string; currency: string; priceMonthly: Prisma.Decimal; priceYearly: Prisma.Decimal; isActive: boolean };
type SubRow = { id: string; organizationId: string; planId: string; status: string; interval: 'MONTHLY' | 'YEARLY'; trialEndsAt: Date | null; currentPeriodStart: Date; currentPeriodEnd: Date; graceEndsAt: Date | null; plan: PlanRow };

export function addExtension(from: Date, ext: Extension, tz: string): Date {
  const local = toZonedTime(from, tz);
  return fromZonedTime(ext.months ? addMonths(local, ext.months) : addDays(local, ext.days!), tz);
}
export const describeExtension = (e: Extension) => (e.months ? `${e.months} month${e.months === 1 ? '' : 's'}` : `${e.days} day${e.days === 1 ? '' : 's'}`);
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : '—');

export interface PeriodPlan { start: Date; end: Date; base: ExtensionBase; previousEnd: Date; keepStatus: 'TRIALING' | null }
export function computePeriod(sub: SubRow, target: { id: string; code: string }, ext: Extension, now: Date, tz: string): PeriodPlan {
  const samePaidPlan = sub.planId === target.id && sub.plan.code !== 'free';
  let start = now, base: ExtensionBase = sub.planId === target.id ? 'PAYMENT_DATE' : 'PLAN_CHANGE', from = now;
  if (samePaidPlan && (sub.status === 'ACTIVE' || sub.status === 'PAST_DUE')) {
    if (sub.currentPeriodEnd > now) { from = sub.currentPeriodEnd; start = sub.currentPeriodStart; base = 'CURRENT_EXPIRY'; }
    else if (now.getTime() - sub.currentPeriodEnd.getTime() < GRACE_PERIOD_DAYS * 86_400_000) { from = sub.currentPeriodEnd; start = sub.currentPeriodEnd; base = 'CURRENT_EXPIRY'; }
  } else if (sub.status === 'TRIALING' && sub.trialEndsAt && sub.trialEndsAt > now && sub.planId === target.id) {
    from = sub.trialEndsAt; start = now; base = 'TRIAL_END';
  }
  const end = addExtension(from, ext, tz);
  if (end <= now) throw new AppError(422, 'EXTENSION_TOO_SHORT', 'This extension does not reach beyond today. Choose a longer period.');
  return { start, end, base, previousEnd: sub.currentPeriodEnd, keepStatus: null };
}

const FIELDS = { subscription: { include: { plan: true } } } as const;
async function lockSubscription(tx: Db, orgId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM subscriptions WHERE organization_id = ${orgId}::uuid FOR UPDATE`;
  if (!rows.length) throw notFound('Subscription');
  const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { id: true, name: true, timezone: true, currency: true } });
  const sub = (await tx.subscription.findUniqueOrThrow({ where: { organizationId: orgId }, include: FIELDS.subscription.include })) as unknown as SubRow;
  return { org, sub };
}

const invoiceExtension = (interval: string | null): Extension => (interval === 'YEARLY' ? { months: 12 } : { months: 1 });
function parseReceivedAt(v: string | undefined, tz: string, now: Date): Date {
  if (!v) return now;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? fromZonedTime(`${v}T00:00:00`, tz) : new Date(v);
  if (Number.isNaN(d.getTime())) throw new AppError(422, 'INVALID_DATE', 'The payment date is not valid.');
  if (d.getTime() > now.getTime() + 86_400_000) throw new AppError(422, 'INVALID_DATE', 'The payment date cannot be in the future.');
  if (d.getTime() < now.getTime() - 3 * 366 * 86_400_000) throw new AppError(422, 'INVALID_DATE', 'The payment date is more than three years in the past.');
  return d;
}

async function resolve(tx: Db, orgId: string, input: Pick<ManualPaymentInput, 'invoiceId' | 'planCode' | 'amount' | 'currency' | 'extension' | 'receivedAt' | 'allowAmountMismatch' | 'internalNote'>, now: Date) {
  const { org, sub } = await lockSubscription(tx, orgId);
  let invoice = null as Awaited<ReturnType<Db['invoice']['findFirst']>>;
  let plan: PlanRow;
  if (input.invoiceId) {
    invoice = await tx.invoice.findFirst({ where: { id: input.invoiceId, organizationId: orgId } });
    if (!invoice) throw notFound('Invoice');
    if (invoice.status !== 'OPEN' && invoice.status !== 'FAILED') throw new AppError(409, 'NOT_PAYABLE', `Invoice ${invoice.number} is ${invoice.status.toLowerCase()} and cannot be paid.`);
    if (!invoice.planId) throw new AppError(422, 'NO_PLAN_ON_INVOICE', 'This invoice is not linked to a plan; record the payment without selecting an invoice.');
    plan = (await tx.subscriptionPlan.findUniqueOrThrow({ where: { id: invoice.planId } })) as PlanRow;
  } else {
    plan = input.planCode ? ((await tx.subscriptionPlan.findUnique({ where: { code: input.planCode } })) as PlanRow | null) ?? (() => { throw notFound('Plan'); })() : sub.plan;
    if (plan.id !== sub.planId && !plan.isActive) throw new AppError(422, 'PLAN_RETIRED', 'This plan is retired and cannot be sold.');
  }
  if (plan.code === 'free') throw new AppError(422, 'FREE_PLAN', 'The Free plan has no payments.');
  const extension = input.extension ?? (invoice ? invoiceExtension(invoice.interval) : undefined);
  if (!extension) throw new AppError(422, 'EXTENSION_REQUIRED', 'Select how long the subscription is extended.');
  const amount = new Prisma.Decimal(input.amount ?? invoice?.amount ?? 0);
  if (amount.lte(0)) throw new AppError(422, 'AMOUNT_REQUIRED', 'Enter the amount received.');
  const currency = (input.currency ?? invoice?.currency ?? plan.currency).toUpperCase();
  if (invoice && (!amount.equals(invoice.amount) || currency !== invoice.currency.toUpperCase())) {
    if (!input.allowAmountMismatch || !input.internalNote) throw new AppError(409, 'AMOUNT_MISMATCH', `The invoice is for ${invoice.currency} ${invoice.amount}; you entered ${currency} ${amount}. Confirm the difference explicitly and add an internal note.`);
  }
  const receivedAt = parseReceivedAt(input.receivedAt, org.timezone, now);
  const period = computePeriod(sub, plan, extension, now, org.timezone);
  return { org, sub, plan, invoice, extension, amount, currency, receivedAt, period };
}

export interface PaymentPreview { previousExpiry: string; newExpiry: string; newStart: string; base: ExtensionBase; planChange: boolean; fromPlan: string; toPlan: string; extension: string; amount: string | null; currency: string; invoiceNumber: string | null; timezone: string; statusBefore: string }
export async function previewManualPayment(orgId: string, input: Parameters<typeof resolve>[2]): Promise<PaymentPreview> {
  const r = await pdb.$transaction((tx) => resolve(tx, orgId, { ...input, receivedAt: input.receivedAt }, new Date()));
  return { previousExpiry: r.sub.currentPeriodEnd.toISOString(), newExpiry: r.period.end.toISOString(), newStart: r.period.start.toISOString(), base: r.period.base, planChange: r.plan.id !== r.sub.planId, fromPlan: r.sub.plan.name, toPlan: r.plan.name, extension: describeExtension(r.extension), amount: r.amount.toFixed(2), currency: r.currency, invoiceNumber: r.invoice?.number ?? null, timezone: r.org.timezone, statusBefore: r.sub.status };
}

export interface Actor { id: string; email: string }
async function audit(tx: Db, actor: Actor, action: string, orgId: string, entityId: string, metadata: Prisma.InputJsonValue) {
  await tx.auditLog.create({ data: { organizationId: orgId, actorId: actor.id, actorEmail: actor.email, scope: 'PLATFORM', action, entityType: 'payment', entityId, metadata } });
}
const seq = async (tx: Db, table: 'payments' | 'invoices', orgId: string) => (table === 'payments' ? await tx.payment.count({ where: { organizationId: orgId } }) : await tx.invoice.count({ where: { organizationId: orgId } })) + 1;

async function notifyOwners(orgId: string, title: string, body: string) {
  try {
    await withContext({ orgId }, async () => {
      const { db } = await import('../../db');
      const rows = await db().membership.findMany({ where: { organizationId: orgId, status: 'ACTIVE', role: { permissions: { has: 'billing.manage' } } }, select: { userId: true } });
      await notify({ userIds: rows.map((r) => r.userId), type: 'BILLING', title, body, link: '/billing' });
    });
  } catch (e) { log.warn('could not notify workspace owners about a billing change', { orgId, error: (e as Error).message }); }
}

export async function confirmManualPayment(actor: Actor, orgId: string, input: ManualPaymentInput) {
  const out = await pdb.$transaction((tx) => confirmInTx(tx, actor, orgId, input), { timeout: 30_000 });
  if (!out.duplicate) await notifyOwners(orgId, `Payment received — ${out.payment.receiptNumber}`, `Your ${out.planName} subscription now runs until ${day(out.payment.newPeriodEnd)}.`);
  return out;
}

/** The atomic core. Also used by the payment-provider settlement routine (inside its own transaction). */
export async function confirmInTx(tx: Db, actor: Actor, orgId: string, input: ManualPaymentInput) {
  const now = new Date();
  {
    // the lock is taken first (inside resolve), so concurrent confirmations for one workspace run one after the other
    if (input.idempotencyKey) {
      const prior = await tx.payment.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (prior) { if (prior.organizationId !== orgId) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key belongs to another workspace.'); return { payment: prior, duplicate: true as const, planName: '', period: null }; }
    }
    const r = await resolve(tx, orgId, input, now);
    const dupRef = await tx.payment.findFirst({ where: { organizationId: orgId, status: 'CONFIRMED', reference: { equals: input.reference.trim(), mode: 'insensitive' } } });
    if (dupRef) throw new AppError(409, 'DUPLICATE_PAYMENT_REFERENCE', `A payment with reference "${input.reference}" was already confirmed for this workspace (${dupRef.receiptNumber}). Nothing was extended.`);
    const orgPart = orgId.slice(0, 4).toUpperCase();
    const interval = r.extension.months === 12 ? 'YEARLY' : 'MONTHLY';
    let invoiceId: string;
    let generated = false;
    if (r.invoice) {
      const claimed = await tx.invoice.updateMany({ where: { id: r.invoice.id, status: { in: ['OPEN', 'FAILED'] } }, data: { status: 'PAID', paidAt: r.receivedAt, paymentMethod: input.method, paymentReference: input.reference.trim(), recordedById: actor.id, failedAt: null, failureReason: null, periodStart: r.period.start, periodEnd: r.period.end } });
      if (claimed.count !== 1) throw new AppError(409, 'NOT_PAYABLE', 'This invoice was paid or voided by someone else a moment ago.');
      invoiceId = r.invoice.id;
    } else {
      const inv = await tx.invoice.create({ data: { organizationId: orgId, number: `LF-${now.getUTCFullYear()}-${orgPart}-${String(await seq(tx, 'invoices', orgId)).padStart(4, '0')}`, planId: r.plan.id, interval, description: `${r.plan.name} plan — ${describeExtension(r.extension)} (manual payment)`, status: 'PAID', amount: r.amount, currency: r.currency, periodStart: r.period.start, periodEnd: r.period.end, issuedAt: now, dueAt: now, paidAt: r.receivedAt, paymentMethod: input.method, paymentReference: input.reference.trim(), recordedById: actor.id } });
      invoiceId = inv.id; generated = true;
    }
    // other unpaid invoices are now stale (they would charge for the same service again)
    await tx.invoice.updateMany({ where: { organizationId: orgId, status: 'OPEN', id: { not: invoiceId } }, data: { status: 'VOID' } });
    await tx.subscription.update({ where: { id: r.sub.id }, data: { planId: r.plan.id, interval, status: 'ACTIVE', trialEndsAt: null, currentPeriodStart: r.period.start, currentPeriodEnd: r.period.end, graceEndsAt: null, ...(r.plan.id !== r.sub.planId ? { pendingPlanId: null, pendingInterval: null } : {}) } });
    const payment = await tx.payment.create({ data: {
      organizationId: orgId, invoiceId, invoiceGenerated: generated, receiptNumber: `RC-${now.getUTCFullYear()}-${orgPart}-${String(await seq(tx, 'payments', orgId)).padStart(4, '0')}`,
      amount: r.amount, currency: r.currency, method: input.method, reference: input.reference.trim(), receivedAt: r.receivedAt, planId: r.plan.id,
      extensionMonths: r.extension.months ?? null, extensionDays: r.extension.days ?? null,
      previousStatus: r.sub.status, previousPlanId: r.sub.planId, previousPeriodStart: r.sub.currentPeriodStart, previousPeriodEnd: r.sub.currentPeriodEnd, previousGraceEndsAt: r.sub.graceEndsAt, previousTrialEndsAt: r.sub.trialEndsAt,
      newPeriodStart: r.period.start, newPeriodEnd: r.period.end, extensionBase: r.period.base, note: input.note ?? null, internalNote: input.internalNote ?? null, recordedById: actor.id, idempotencyKey: input.idempotencyKey ?? null,
    } });
    await tx.subscriptionEvent.create({ data: { organizationId: orgId, type: r.plan.id === r.sub.planId ? 'RENEWED' : 'PLAN_CHANGED', fromPlanCode: r.sub.plan.code, toPlanCode: r.plan.code, status: 'ACTIVE', actorId: actor.id,
      note: `Payment confirmed (${payment.receiptNumber}, ${r.currency} ${r.amount.toFixed(2)}, ref ${payment.reference}). ${describeExtension(r.extension)}: expiry ${day(r.sub.currentPeriodEnd)} → ${day(r.period.end)} (${r.period.base.replace('_', ' ').toLowerCase()}).` } });
    await audit(tx, actor, 'billing.payment_confirmed', orgId, payment.id, { receipt: payment.receiptNumber, amount: r.amount.toFixed(2), currency: r.currency, method: input.method, reference: payment.reference, previousExpiry: r.sub.currentPeriodEnd.toISOString(), newExpiry: r.period.end.toISOString(), plan: r.plan.code, invoice: r.invoice?.number ?? 'generated' });
    return { payment, duplicate: false as const, planName: r.plan.name, period: r.period };
  }
}

export async function extendWithoutPayment(actor: Actor, orgId: string, ext: Extension, reason: string) {
  const now = new Date();
  const out = await pdb.$transaction(async (tx) => {
    const { org, sub } = await lockSubscription(tx, orgId);
    if (sub.plan.code === 'free') throw new AppError(409, 'FREE_PLAN', 'The Free plan has no expiry to extend.');
    const period = computePeriod(sub, sub.plan, ext, now, org.timezone);
    const trialing = sub.status === 'TRIALING' && sub.trialEndsAt && sub.trialEndsAt > now;
    await tx.subscription.update({ where: { id: sub.id }, data: trialing ? { trialEndsAt: period.end, currentPeriodEnd: period.end } : { status: 'ACTIVE', currentPeriodStart: period.start, currentPeriodEnd: period.end, graceEndsAt: null } });
    await tx.subscriptionEvent.create({ data: { organizationId: orgId, type: 'MANUAL_EXTENSION', fromPlanCode: sub.plan.code, toPlanCode: sub.plan.code, status: trialing ? 'TRIALING' : 'ACTIVE', actorId: actor.id,
      note: `Extended by ${describeExtension(ext)} WITHOUT a payment: expiry ${day(sub.currentPeriodEnd)} → ${day(period.end)}. Reason: ${reason}` } });
    await audit(tx, actor, 'billing.extended_without_payment', orgId, sub.id, { extension: describeExtension(ext), previousExpiry: sub.currentPeriodEnd.toISOString(), newExpiry: period.end.toISOString(), reason });
    return { previousExpiry: sub.currentPeriodEnd, newExpiry: period.end, planName: sub.plan.name };
  }, { timeout: 30_000 });
  await notifyOwners(orgId, 'Your subscription was extended', `Your ${out.planName} subscription now runs until ${day(out.newExpiry)}.`);
  return out;
}

export async function reversePayment(actor: Actor, paymentId: string, reason: string) {
  return pdb.$transaction(async (tx) => {
    const p = await tx.payment.findUnique({ where: { id: paymentId } });
    if (!p) throw notFound('Payment');
    const { sub } = await lockSubscription(tx, p.organizationId);
    const fresh = await tx.payment.findUniqueOrThrow({ where: { id: p.id } });
    if (fresh.status !== 'CONFIRMED') throw new AppError(409, 'ALREADY_REVERSED', 'This payment was already reversed.');
    const later = await tx.payment.count({ where: { organizationId: p.organizationId, status: 'CONFIRMED', createdAt: { gt: p.createdAt } } });
    if (later > 0 || sub.currentPeriodEnd.getTime() !== p.newPeriodEnd.getTime() || sub.planId !== p.planId) {
      throw new AppError(409, 'NOT_REVERSIBLE', 'Only the most recent payment can be reversed, and only while the subscription has not been changed since. Record a correction instead.');
    }
    await tx.subscription.update({ where: { id: sub.id }, data: { planId: p.previousPlanId ?? sub.planId, status: (p.previousStatus ?? 'ACTIVE') as never, currentPeriodStart: p.previousPeriodStart ?? sub.currentPeriodStart, currentPeriodEnd: p.previousPeriodEnd ?? sub.currentPeriodEnd, graceEndsAt: p.previousGraceEndsAt, trialEndsAt: p.previousTrialEndsAt } });
    if (p.invoiceId) await tx.invoice.update({ where: { id: p.invoiceId }, data: p.invoiceGenerated ? { status: 'VOID' } : { status: 'OPEN', paidAt: null, paymentMethod: null, paymentReference: null, recordedById: null } });
    const updated = await tx.payment.update({ where: { id: p.id }, data: { status: 'REVERSED', reversedAt: new Date(), reversedById: actor.id, reversalReason: reason } });
    await tx.subscriptionEvent.create({ data: { organizationId: p.organizationId, type: 'PAYMENT_REVERSED', fromPlanCode: sub.plan.code, status: p.previousStatus ?? sub.status, actorId: actor.id, note: `Payment ${p.receiptNumber} reversed: expiry ${day(p.newPeriodEnd)} → ${day(p.previousPeriodEnd)}. Reason: ${reason}` } });
    await audit(tx, actor, 'billing.payment_reversed', p.organizationId, p.id, { receipt: p.receiptNumber, reason });
    return updated;
  }, { timeout: 30_000 });
}

/** What a workspace member may see about a payment (no internal notes, no administrator identity). */
export const publicPayment = (p: { id: string; receiptNumber: string; status: string; amount: Prisma.Decimal | number; currency: string; method: string; reference: string; receivedAt: Date; note: string | null; invoiceId: string | null; previousPeriodEnd: Date | null; newPeriodEnd: Date; extensionMonths: number | null; extensionDays: number | null; createdAt: Date }) => ({
  id: p.id, receiptNumber: p.receiptNumber, status: p.status, amount: Number(p.amount), currency: p.currency, method: p.method, reference: p.reference, receivedAt: p.receivedAt, note: p.note, invoiceId: p.invoiceId,
  previousExpiry: p.previousPeriodEnd, newExpiry: p.newPeriodEnd, extension: describeExtension({ months: p.extensionMonths ?? undefined, days: p.extensionDays ?? undefined }), createdAt: p.createdAt,
});
