import type { Prisma } from '@leadflow/database';
import { DEFAULT_PLANS } from '@leadflow/shared';
import { addDays, addMonths, addYears } from 'date-fns';
import { currentStore, db, platformPrisma } from '../../db';
import { AppError, paymentRequired } from '../../lib/errors';
import type { Ctx } from '../../http';

/** Idempotently makes sure the default plan catalogue exists (platform role owns plan writes). */
export async function ensurePlans() {
  for (const p of DEFAULT_PLANS) {
    await platformPrisma.subscriptionPlan.upsert({
      where: { code: p.code },
      update: {},
      create: { code: p.code, name: p.name, description: p.description, priceMonthly: p.priceMonthly, priceYearly: p.priceYearly, trialDays: p.trialDays, maxLeads: p.maxLeads, maxSeats: p.maxSeats, features: [...p.features], sortOrder: p.sortOrder },
    });
  }
}

export const periodEnd = (start: Date, interval: 'MONTHLY' | 'YEARLY') => (interval === 'YEARLY' ? addYears(start, 1) : addMonths(start, 1));
const GRACE_DAYS = 7;
export const GRACE_PERIOD_DAYS = GRACE_DAYS;

export async function nextInvoiceNumber(): Promise<string> {
  const y = new Date().getUTCFullYear();
  const r = await db().$queryRaw<{ n: bigint }[]>`SELECT (count(*) + 1)::bigint AS n FROM invoices WHERE organization_id = app_org_id()`;
  const orgPart = currentStore()!.orgId!.slice(0, 4).toUpperCase();
  return `LF-${y}-${orgPart}-${String(r[0]?.n ?? 1n).padStart(4, '0')}`;
}

/** New workspaces start a Professional trial (falls back to Free if the plan catalogue lacks it). */
export async function startTrial(orgId: string, actorId: string | null) {
  const plan = (await db().subscriptionPlan.findUnique({ where: { code: 'professional' } })) ?? (await db().subscriptionPlan.findUnique({ where: { code: 'free' } }));
  if (!plan) throw new AppError(500, 'NO_PLANS', 'Plan catalogue is not initialised');
  const now = new Date();
  const trialDays = plan.trialDays || 14;
  const isTrial = plan.code !== 'free';
  const end = isTrial ? addDays(now, trialDays) : addYears(now, 100);
  const sub = await db().subscription.create({
    data: { organizationId: orgId, planId: plan.id, interval: 'MONTHLY', status: isTrial ? 'TRIALING' : 'ACTIVE', trialEndsAt: isTrial ? end : null, currentPeriodStart: now, currentPeriodEnd: end },
  });
  await db().subscriptionEvent.create({
    data: { organizationId: orgId, type: isTrial ? 'TRIAL_STARTED' : 'PLAN_ASSIGNED', toPlanCode: plan.code, status: sub.status, actorId, note: isTrial ? `${trialDays}-day trial` : 'Free plan' },
  });
  return sub;
}

export interface Usage { leads: number; seats: number; pendingInvites: number; opportunities: number; followUps: number; maxLeads: number; maxSeats: number }

export async function getUsage(ctx: Pick<Ctx, 'orgId' | 'plan'>): Promise<Usage> {
  const [leads, seats, pendingInvites, opportunities, followUps] = await Promise.all([
    db().lead.count({ where: { organizationId: ctx.orgId, archivedAt: null, mergedIntoId: null } }),
    db().membership.count({ where: { organizationId: ctx.orgId, status: 'ACTIVE' } }),
    db().invitation.count({ where: { organizationId: ctx.orgId, status: 'PENDING', expiresAt: { gt: new Date() } } }),
    db().opportunity.count({ where: { organizationId: ctx.orgId, archivedAt: null } }),
    db().followUp.count({ where: { organizationId: ctx.orgId, status: 'PENDING' } }),
  ]);
  return { leads, seats, pendingInvites, opportunities, followUps, maxLeads: ctx.plan.maxLeads, maxSeats: ctx.plan.maxSeats };
}

/** Backend enforcement of the lead cap — never trust the UI. */
export async function assertLeadCapacity(ctx: Ctx, adding = 1) {
  const used = await db().lead.count({ where: { organizationId: ctx.orgId, archivedAt: null, mergedIntoId: null } });
  if (used + adding > ctx.plan.maxLeads) {
    throw paymentRequired(`Your ${ctx.plan.name} plan allows ${ctx.plan.maxLeads.toLocaleString()} leads (${used.toLocaleString()} used). Upgrade to add more.`, 'LEAD_LIMIT_REACHED');
  }
}

export async function assertSeatCapacity(ctx: Pick<Ctx, 'orgId' | 'plan'>, includePending = true) {
  const u = await getUsage(ctx);
  const used = u.seats + (includePending ? u.pendingInvites : 0);
  if (used + 1 > ctx.plan.maxSeats) {
    throw paymentRequired(`Your ${ctx.plan.name} plan includes ${ctx.plan.maxSeats} user seat${ctx.plan.maxSeats === 1 ? '' : 's'}. Upgrade to add more team members.`, 'SEAT_LIMIT_REACHED');
  }
}

export async function recordSubscriptionEvent(orgId: string, data: Omit<Prisma.SubscriptionEventUncheckedCreateInput, 'organizationId'>) {
  return db().subscriptionEvent.create({ data: { ...data, organizationId: orgId } });
}
