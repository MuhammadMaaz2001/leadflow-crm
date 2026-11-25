import { beforeAll, describe, expect, it } from 'vitest';
import { addDays } from 'date-fns';
import { addExtension } from '../src/modules/subscriptions/manual-billing';
import { prisma } from '../src/db';
import { addMember, boot, createWorkspace, makePlatformAdmin, ownerPrisma, signUp, uniq, type Actor } from './helpers';

let admin: Actor, support: Actor, superAdmin: Actor;
beforeAll(async () => { await boot(); admin = await makePlatformAdmin('BILLING_ADMIN'); support = await makePlatformAdmin('SUPPORT_ADMIN'); superAdmin = await makePlatformAdmin('SUPER_ADMIN'); });

const pay = (a: Actor, orgId: string, body: Record<string, unknown>) => a.agent.post(`/api/platform/subscriptions/${orgId}/payments`).send({ method: 'BANK_TRANSFER', reference: `REF-${uniq('r')}`, ...body });
const sub = (orgId: string) => ownerPrisma.subscription.findUniqueOrThrow({ where: { organizationId: orgId }, include: { plan: true } });
const ymd = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
async function workspace(label = 'Bill') { const owner = await createWorkspace(await signUp(`${label} Owner`), `${label} ${uniq()}`); return owner; }
/** Puts the workspace on a paid plan with a given expiry/status, the way a past payment would have. */
async function setPaid(orgId: string, over: { code?: string; status?: 'ACTIVE' | 'PAST_DUE' | 'EXPIRED' | 'TRIALING'; end: Date; grace?: Date | null }) {
  const plan = await ownerPrisma.subscriptionPlan.findUniqueOrThrow({ where: { code: over.code ?? 'starter' } });
  await ownerPrisma.subscription.update({ where: { organizationId: orgId }, data: { planId: plan.id, status: over.status ?? 'ACTIVE', trialEndsAt: over.status === 'TRIALING' ? over.end : null, currentPeriodStart: addDays(over.end, -30), currentPeriodEnd: over.end, graceEndsAt: over.grace ?? null } });
}

describe('extension arithmetic (calendar months in the workspace timezone)', () => {
  it('clamps month ends, keeps wall-clock time across daylight-saving changes and supports custom day counts', () => {
    expect(addExtension(new Date('2026-01-31T10:00:00Z'), { months: 1 }, 'UTC').toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addExtension(new Date('2028-01-31T10:00:00Z'), { months: 1 }, 'UTC').toISOString()).toBe('2028-02-29T10:00:00.000Z');          // leap year
    // New York: 12:00 EST on 7 March → 12:00 EDT on 7 April (UTC offset changes from -5 to -4): the instant moves by 1 h less
    expect(addExtension(new Date('2026-03-07T17:00:00Z'), { months: 1 }, 'America/New_York').toISOString()).toBe('2026-04-07T16:00:00.000Z');
    expect(addExtension(new Date('2026-12-15T00:00:00Z'), { months: 12 }, 'UTC').toISOString()).toBe('2027-12-15T00:00:00.000Z');
    expect(addExtension(new Date('2026-06-01T00:00:00Z'), { days: 45 }, 'UTC').toISOString()).toBe('2026-07-16T00:00:00.000Z');
    // a late evening in Auckland is already "tomorrow" in UTC: month arithmetic follows the workspace's calendar, not UTC's
    expect(addExtension(new Date('2026-01-30T12:00:00Z'), { months: 1 }, 'Pacific/Auckland').toISOString()).toBe('2026-02-27T12:00:00.000Z'); // 31 Jan 01:00 NZDT → 28 Feb 01:00 NZDT
  });
});

describe('confirming a manual payment extends the subscription under a clear policy', () => {
  it('extends from the CURRENT expiry (never resets from today), records previous/new expiry, receipt, invoice and history — all visible to the owner without internal notes', async () => {
    const owner = await workspace();
    const end = addDays(new Date(), 20);
    await setPaid(owner.orgId!, { end });
    const preview = await admin.agent.post(`/api/platform/subscriptions/${owner.orgId}/payments/preview`).send({ extension: { months: 3 }, amount: 87 });
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({ base: 'CURRENT_EXPIRY', planChange: false, extension: '3 months' });
    expect(ymd(preview.body.data.previousExpiry)).toBe(ymd(end));
    expect(await ownerPrisma.payment.count({ where: { organizationId: owner.orgId! } })).toBe(0);   // preview writes nothing

    const r = await pay(admin, owner.orgId!, { amount: 87, extension: { months: 3 }, reference: 'WIRE-1001', note: 'Q4 payment', internalNote: 'checked against bank statement', receivedAt: ymd(new Date()) });
    expect(r.status).toBe(200);
    const s = await sub(owner.orgId!);
    expect(ymd(s.currentPeriodEnd)).toBe(ymd(addExtension(end, { months: 3 }, 'UTC')));          // 20 days + 3 months from today, not "3 months from today"
    expect(s.status).toBe('ACTIVE'); expect(s.graceEndsAt).toBeNull();
    const p = await ownerPrisma.payment.findFirstOrThrow({ where: { organizationId: owner.orgId! } });
    expect(p).toMatchObject({ status: 'CONFIRMED', method: 'BANK_TRANSFER', reference: 'WIRE-1001', extensionBase: 'CURRENT_EXPIRY', invoiceGenerated: true, currency: 'USD' });
    expect(Number(p.amount)).toBe(87);
    expect(ymd(p.previousPeriodEnd!)).toBe(ymd(end)); expect(ymd(p.newPeriodEnd)).toBe(ymd(s.currentPeriodEnd));
    expect(p.receiptNumber).toMatch(/^RC-\d{4}-[0-9A-F]{4}-0001$/); expect(p.recordedById).toBe(admin.userId);
    const inv = await ownerPrisma.invoice.findUniqueOrThrow({ where: { id: p.invoiceId! } });
    expect(inv).toMatchObject({ status: 'PAID', paymentReference: 'WIRE-1001' });
    const ev = await ownerPrisma.subscriptionEvent.findFirstOrThrow({ where: { organizationId: owner.orgId!, type: 'RENEWED' }, orderBy: { createdAt: 'desc' } });
    expect(ev.actorId).toBe(admin.userId); expect(ev.note).toContain(p.receiptNumber); expect(ev.note).toContain(ymd(end));
    expect(await ownerPrisma.auditLog.count({ where: { organizationId: owner.orgId!, action: 'billing.payment_confirmed', actorId: admin.userId } })).toBe(1);
    // the workspace owner sees plan, expiry, invoices, receipts and history — but not the administrator's internal note
    const billing = (await owner.get('/billing')).body.data;
    expect(billing.payments).toHaveLength(1);
    expect(billing.payments[0]).toMatchObject({ receiptNumber: p.receiptNumber, reference: 'WIRE-1001', note: 'Q4 payment', extension: '3 months' });
    expect(JSON.stringify(billing)).not.toContain('checked against bank statement');
    expect(ymd(billing.subscription.currentPeriodEnd)).toBe(ymd(s.currentPeriodEnd));
    // the platform view carries the internal note and who recorded it
    const detail = (await admin.get(`/platform/organizations/${owner.orgId}/billing`)).body.data;
    expect(detail.payments[0]).toMatchObject({ internalNote: 'checked against bank statement', recordedBy: { email: admin.email } });
    expect(detail.events[0].actor.email).toBe(admin.email);
  });

  it('expired beyond the grace period restarts at the confirmation moment; inside the grace period continues from the old expiry', async () => {
    const expired = await workspace('Exp');
    const longAgo = addDays(new Date(), -40);
    await setPaid(expired.orgId!, { status: 'EXPIRED', end: longAgo });
    expect((await pay(admin, expired.orgId!, { amount: 29, extension: { months: 1 } })).status).toBe(200);
    const a = await sub(expired.orgId!);
    expect(a.currentPeriodEnd.getTime()).toBeGreaterThan(addDays(new Date(), 25).getTime());        // ≈ now + 1 month, NOT old expiry + 1 month (which is still in the past)
    expect(a.currentPeriodEnd.getTime()).toBeLessThan(addDays(new Date(), 32).getTime());
    expect((await ownerPrisma.payment.findFirstOrThrow({ where: { organizationId: expired.orgId! } })).extensionBase).toBe('PAYMENT_DATE');

    const grace = await workspace('Grace');
    const endedThreeDaysAgo = addDays(new Date(), -3);
    await setPaid(grace.orgId!, { status: 'PAST_DUE', end: endedThreeDaysAgo, grace: addDays(endedThreeDaysAgo, 7) });
    expect((await pay(admin, grace.orgId!, { amount: 29, extension: { months: 1 } })).status).toBe(200);
    const g = await sub(grace.orgId!);
    expect(ymd(g.currentPeriodEnd)).toBe(ymd(addExtension(endedThreeDaysAgo, { months: 1 }, 'UTC')));  // no gap, no free days
    expect(g.status).toBe('ACTIVE'); expect(g.graceEndsAt).toBeNull();
    expect((await ownerPrisma.payment.findFirstOrThrow({ where: { organizationId: grace.orgId! } })).extensionBase).toBe('CURRENT_EXPIRY');
  });

  it('a trial converts at its end, a different plan restarts without proration, and the Free plan cannot be paid for', async () => {
    const trial = await workspace('Trial');
    const t0 = await sub(trial.orgId!);
    expect(t0.status).toBe('TRIALING');
    const prof = await ownerPrisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'professional' } });
    expect(t0.planId).toBe(prof.id);
    expect((await pay(admin, trial.orgId!, { amount: 79, extension: { months: 1 } })).status).toBe(200);
    const t1 = await sub(trial.orgId!);
    expect(t1.status).toBe('ACTIVE'); expect(t1.trialEndsAt).toBeNull();
    expect(ymd(t1.currentPeriodEnd)).toBe(ymd(addExtension(t0.trialEndsAt!, { months: 1 }, 'UTC')));
    // upgrade to a different plan while paid: new period starts now
    const other = await workspace('Switch');
    await setPaid(other.orgId!, { code: 'starter', end: addDays(new Date(), 15) });
    expect((await pay(admin, other.orgId!, { planCode: 'professional', amount: 79, extension: { months: 1 } })).status).toBe(200);
    const s = await sub(other.orgId!);
    expect(s.plan.code).toBe('professional');
    expect(s.currentPeriodEnd.getTime()).toBeGreaterThan(addDays(new Date(), 27).getTime());
    expect((await ownerPrisma.payment.findFirstOrThrow({ where: { organizationId: other.orgId! } })).extensionBase).toBe('PLAN_CHANGE');
    // free plan
    const free = await workspace('Free');
    await ownerPrisma.subscription.update({ where: { organizationId: free.orgId! }, data: { planId: (await ownerPrisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'free' } })).id, status: 'ACTIVE', trialEndsAt: null } });
    expect((await pay(admin, free.orgId!, { planCode: 'free', amount: 1, extension: { months: 1 } })).status).toBe(422);
  });

  it('an invoice alone never extends anything; paying it does, using its plan, amount and period', async () => {
    const owner = await workspace('Inv');
    await ownerPrisma.subscription.update({ where: { organizationId: owner.orgId! }, data: { planId: (await ownerPrisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'free' } })).id, status: 'ACTIVE', trialEndsAt: null } });
    const before = await sub(owner.orgId!);
    const up = await owner.post('/billing/change-plan', { planCode: 'starter', interval: 'YEARLY' });
    expect(up.body.data.applied).toBe('pending_payment');
    const after = await sub(owner.orgId!);
    expect(after.plan.code).toBe('free'); expect(after.currentPeriodEnd.getTime()).toBe(before.currentPeriodEnd.getTime());
    const invId = up.body.data.invoiceId as string;
    // wrong amount → refused unless explicitly confirmed with an internal note
    expect((await pay(admin, owner.orgId!, { invoiceId: invId, amount: 1 })).body.error.code).toBe('AMOUNT_MISMATCH');
    const ok = await pay(admin, owner.orgId!, { invoiceId: invId });                                // amount defaults to the invoice, 12 months to its interval
    expect(ok.status).toBe(200);
    const s = await sub(owner.orgId!);
    expect(s.plan.code).toBe('starter'); expect(s.interval).toBe('YEARLY');
    expect(s.currentPeriodEnd.getTime()).toBeGreaterThan(addDays(new Date(), 360).getTime());
    const inv = await ownerPrisma.invoice.findUniqueOrThrow({ where: { id: invId } });
    expect(inv.status).toBe('PAID'); expect(inv.paidAt).not.toBeNull();
    expect(await ownerPrisma.payment.count({ where: { organizationId: owner.orgId! } })).toBe(1);   // the existing invoice was used, no second invoice generated
    expect((await ownerPrisma.payment.findFirstOrThrow({ where: { organizationId: owner.orgId! } })).invoiceGenerated).toBe(false);
  });
});

describe('duplicate protection, validation and atomicity', () => {
  it('idempotency key, reference uniqueness and parallel confirmations never extend twice', async () => {
    const owner = await workspace();
    const end = addDays(new Date(), 10);
    await setPaid(owner.orgId!, { end });
    const key = `idem-${uniq('k')}`;
    const same = await Promise.all(Array.from({ length: 5 }, () => pay(admin, owner.orgId!, { amount: 29, extension: { months: 1 }, reference: 'SAME-KEY', idempotencyKey: key })));
    expect(same.filter((r) => r.status === 200 && r.body.data.duplicate === false)).toHaveLength(1);
    expect(same.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect(await ownerPrisma.payment.count({ where: { organizationId: owner.orgId! } })).toBe(1);
    expect(ymd((await sub(owner.orgId!)).currentPeriodEnd)).toBe(ymd(addExtension(end, { months: 1 }, 'UTC')));
    // same reference again (a different key, e.g. page refresh) is refused and extends nothing
    const dup = await pay(admin, owner.orgId!, { amount: 29, extension: { months: 1 }, reference: 'same-key' });
    expect(dup.status).toBe(409); expect(dup.body.error.code).toBe('DUPLICATE_PAYMENT_REFERENCE');
    // three legitimate, different payments confirmed in parallel serialise: exactly +3 months in total
    const base = (await sub(owner.orgId!)).currentPeriodEnd;
    const par = await Promise.all([1, 2, 3].map((i) => pay(admin, owner.orgId!, { amount: 29, extension: { months: 1 }, reference: `PAR-${i}-${uniq('p')}` })));
    expect(par.every((r) => r.status === 200)).toBe(true);
    expect(ymd((await sub(owner.orgId!)).currentPeriodEnd)).toBe(ymd(addExtension(base, { months: 3 }, 'UTC')));
    const receipts = (await ownerPrisma.payment.findMany({ where: { organizationId: owner.orgId! } })).map((p) => p.receiptNumber);
    expect(new Set(receipts).size).toBe(receipts.length);
  });

  it('rejects incomplete, nonsensical and cross-tenant requests without changing anything', async () => {
    const a = await workspace('A'), b = await workspace('B');
    await setPaid(a.orgId!, { end: addDays(new Date(), 5) });
    const before = (await sub(a.orgId!)).currentPeriodEnd.getTime();
    const bad: Array<[Record<string, unknown>, number]> = [
      [{ extension: { months: 1 } }, 422],                                                  // no amount
      [{ amount: 29 }, 422],                                                                // no extension
      [{ amount: 29, extension: { months: 1, days: 3 } }, 400],                             // both months and days
      [{ amount: 29, extension: { months: 0 } }, 400], [{ amount: 29, extension: { months: 99 } }, 400],
      [{ amount: -5, extension: { months: 1 } }, 400], [{ amount: 29, extension: { months: 1 }, method: 'BITCOIN' }, 400],
      [{ amount: 29, extension: { months: 1 }, receivedAt: '2999-01-01' }, 422],            // future date
      [{ amount: 29, extension: { months: 1 }, receivedAt: 'not-a-date' }, 422],
      [{ amount: 29, extension: { months: 1 }, planCode: 'no-such-plan' }, 404],
      [{ amount: 29, extension: { months: 1 }, reference: '   ' }, 400],
    ];
    for (const [body, status] of bad) expect((await pay(admin, a.orgId!, body)).status, JSON.stringify(body)).toBe(status);
    // an invoice of ANOTHER workspace cannot be used
    const up = await b.post('/billing/change-plan', { planCode: 'starter', interval: 'MONTHLY' });
    await ownerPrisma.subscription.update({ where: { organizationId: b.orgId! }, data: { status: 'ACTIVE' } }).catch(() => undefined);
    const foreign = await pay(admin, a.orgId!, { invoiceId: up.body.data.invoiceId, amount: 29 });
    expect(foreign.status).toBe(404);
    expect((await pay(admin, '00000000-0000-4000-8000-000000000000', { amount: 29, extension: { months: 1 } })).status).toBe(404);
    expect((await sub(a.orgId!)).currentPeriodEnd.getTime()).toBe(before);
    expect(await ownerPrisma.payment.count({ where: { organizationId: a.orgId! } })).toBe(0);
    expect(await ownerPrisma.invoice.count({ where: { organizationId: a.orgId!, status: 'PAID' } })).toBe(0);   // atomic: no half-created invoice left behind
  });

  it('a failure after the invoice was marked paid rolls everything back (atomicity)', async () => {
    const owner = await workspace('Atomic');
    await setPaid(owner.orgId!, { end: addDays(new Date(), 5) });
    const up = await owner.post('/billing/change-plan', { planCode: 'professional', interval: 'MONTHLY' });
    // force the LAST step of the transaction (the audit log insert) to fail with a one-off constraint
    await ownerPrisma.$executeRawUnsafe(`ALTER TABLE audit_logs ADD CONSTRAINT zz_block_payment_audit CHECK (action <> 'billing.payment_confirmed') NOT VALID`);
    try {
      const r = await admin.agent.post(`/api/platform/invoices/${up.body.data.invoiceId}/mark-paid`).send({ method: 'CASH', reference: `ATOM-${uniq('a')}` });
      expect(r.status).toBeGreaterThanOrEqual(400);
    } finally { await ownerPrisma.$executeRawUnsafe(`ALTER TABLE audit_logs DROP CONSTRAINT zz_block_payment_audit`); }
    expect((await ownerPrisma.invoice.findUniqueOrThrow({ where: { id: up.body.data.invoiceId } })).status).toBe('OPEN');
    expect(await ownerPrisma.payment.count({ where: { organizationId: owner.orgId! } })).toBe(0);
    expect((await sub(owner.orgId!)).plan.code).toBe('starter');
  });
});

describe('extension without payment, reversal and authorization', () => {
  it('goodwill extensions need a reason, create no payment or invoice, and are audited with previous and new expiry', async () => {
    const owner = await workspace('Good');
    const end = addDays(new Date(), 4);
    await setPaid(owner.orgId!, { end });
    const url = `/api/platform/subscriptions/${owner.orgId}/extend`;
    expect((await admin.agent.post(url).send({ extension: { days: 10 } })).status).toBe(400);               // reason required
    expect((await admin.agent.post(url).send({ extension: { days: 10 }, reason: 'ok' })).status).toBe(400); // too short to be a reason
    const r = await admin.agent.post(url).send({ extension: { days: 10 }, reason: 'Service outage compensation' });
    expect(r.status).toBe(200);
    expect(ymd((await sub(owner.orgId!)).currentPeriodEnd)).toBe(ymd(addExtension(end, { days: 10 }, 'UTC')));
    expect(await ownerPrisma.payment.count({ where: { organizationId: owner.orgId! } })).toBe(0);
    const ev = await ownerPrisma.subscriptionEvent.findFirstOrThrow({ where: { organizationId: owner.orgId!, type: 'MANUAL_EXTENSION' } });
    expect(ev.note).toContain('WITHOUT a payment'); expect(ev.note).toContain('Service outage compensation'); expect(ev.note).toContain(ymd(end)); expect(ev.actorId).toBe(admin.userId);
    expect(await ownerPrisma.auditLog.count({ where: { organizationId: owner.orgId!, action: 'billing.extended_without_payment' } })).toBe(1);
    // free plans have nothing to extend
    const free = await workspace('FreeExt');
    await ownerPrisma.subscription.update({ where: { organizationId: free.orgId! }, data: { planId: (await ownerPrisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'free' } })).id, status: 'ACTIVE', trialEndsAt: null } });
    expect((await admin.agent.post(`/api/platform/subscriptions/${free.orgId}/extend`).send({ extension: { days: 5 }, reason: 'testing free plan' })).status).toBe(409);
  });

  it('the most recent payment can be reversed (restoring expiry, status and invoice); older or already reversed ones cannot', async () => {
    const owner = await workspace('Rev');
    const end = addDays(new Date(), 8);
    await setPaid(owner.orgId!, { end });
    const first = await pay(admin, owner.orgId!, { amount: 29, extension: { months: 1 } });
    const second = await pay(admin, owner.orgId!, { amount: 29, extension: { months: 2 } });
    const id1 = first.body.data.payment.id as string, id2 = second.body.data.payment.id as string;
    expect((await admin.agent.post(`/api/platform/payments/${id1}/reverse`).send({ reason: 'entered twice by mistake' })).body.error.code).toBe('NOT_REVERSIBLE');   // not the latest
    expect((await support.agent.post(`/api/platform/payments/${id2}/reverse`).send({ reason: 'entered twice by mistake' })).status).toBe(403);
    expect((await admin.agent.post(`/api/platform/payments/${id2}/reverse`).send({ reason: 'x' })).status).toBe(400);
    const afterFirst = ymd(addExtension(end, { months: 1 }, 'UTC'));
    expect((await admin.agent.post(`/api/platform/payments/${id2}/reverse`).send({ reason: 'entered twice by mistake' })).status).toBe(200);
    expect(ymd((await sub(owner.orgId!)).currentPeriodEnd)).toBe(afterFirst);
    const p2 = await ownerPrisma.payment.findUniqueOrThrow({ where: { id: id2 } });
    expect(p2).toMatchObject({ status: 'REVERSED', reversedById: admin.userId, reversalReason: 'entered twice by mistake' });
    expect((await ownerPrisma.invoice.findUniqueOrThrow({ where: { id: p2.invoiceId! } })).status).toBe('VOID');
    expect((await admin.agent.post(`/api/platform/payments/${id2}/reverse`).send({ reason: 'again, to be sure' })).body.error.code).toBe('ALREADY_REVERSED');
    // the reference of a reversed payment can be entered again (correctly this time)
    expect((await pay(admin, owner.orgId!, { amount: 29, extension: { months: 2 }, reference: p2.reference })).status).toBe(200);
    // the history shows both the payment and its reversal
    const types = (await ownerPrisma.subscriptionEvent.findMany({ where: { organizationId: owner.orgId! } })).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['RENEWED', 'PAYMENT_REVERSED']));
  });

  it('only billing-capable platform administrators can touch billing; workspace owners and support staff cannot', async () => {
    const owner = await workspace('Auth');
    const agent = await addMember(owner, 'SALES_AGENT');
    await setPaid(owner.orgId!, { end: addDays(new Date(), 10) });
    const attempts: Array<[string, Record<string, unknown>]> = [
      [`/subscriptions/${owner.orgId}/payments`, { method: 'CASH', reference: 'X1', amount: 29, extension: { months: 1 } }],
      [`/subscriptions/${owner.orgId}/extend`, { extension: { days: 30 }, reason: 'I would like more time' }],
      [`/subscriptions/${owner.orgId}/adjust`, { status: 'ACTIVE', note: 'self service please' }],
      [`/subscriptions/${owner.orgId}/payments/preview`, { extension: { months: 1 }, amount: 29 }],
    ];
    const before = (await sub(owner.orgId!)).currentPeriodEnd.getTime();
    for (const [path, body] of attempts) {
      for (const who of [owner, agent]) expect((await who.agent.post(`/api/platform${path}`).send(body)).status, `tenant user on ${path}`).toBe(403);
      expect((await support.agent.post(`/api/platform${path}`).send(body)).status, `support admin on ${path}`).toBe(403);
    }
    expect((await support.get(`/platform/organizations/${owner.orgId}/billing`)).status).toBe(200);   // read-only visibility is fine
    expect((await superAdmin.agent.post(`/api/platform/subscriptions/${owner.orgId}/extend`).send({ extension: { days: 1 }, reason: 'super admin check' })).status).toBe(200);
    expect((await sub(owner.orgId!)).currentPeriodEnd.getTime()).toBeGreaterThan(before);
    // a tenant cannot read another tenant's payments either
    await pay(admin, owner.orgId!, { amount: 29, extension: { months: 1 } });
    const stranger = await workspace('Stranger');
    expect((await stranger.get('/billing')).body.data.payments).toHaveLength(0);
    const rows = await prisma.$transaction(async (tx) => { await tx.$executeRaw`SELECT set_config('app.org_id', ${stranger.orgId!}, true)`; return tx.$queryRaw<unknown[]>`SELECT id FROM payments`; });
    expect(rows).toHaveLength(0);                                                       // row level security hides them even from a query without a filter
  });
});

describe('database-level protection of billing state', () => {
  it('the application role cannot create payments, mark invoices paid, lengthen a paid subscription or upgrade without payment', async () => {
    const owner = await workspace('Guard');
    await setPaid(owner.orgId!, { end: addDays(new Date(), 10) });
    const up = await owner.post('/billing/change-plan', { planCode: 'professional', interval: 'MONTHLY' });
    const run = (sql: string) => prisma.$transaction(async (tx) => { await tx.$executeRaw`SELECT set_config('app.org_id', ${owner.orgId!}, true)`; await tx.$executeRawUnsafe(sql); });
    await expect(run(`INSERT INTO payments (organization_id, receipt_number, amount, currency, method, reference, received_at, new_period_start, new_period_end, extension_base, recorded_by_id) VALUES ('${owner.orgId}', 'RC-X', 1, 'USD', 'CASH', 'x', now(), now(), now() + interval '1 day', 'X', '${owner.userId}')`)).rejects.toThrow(/permission denied/);
    await expect(run(`UPDATE invoices SET status = 'PAID', paid_at = now() WHERE id = '${up.body.data.invoiceId}'`)).rejects.toThrow(/marked paid by platform billing/);
    await expect(run(`UPDATE subscriptions SET current_period_end = current_period_end + interval '1 year'`)).rejects.toThrow(/extended by platform billing/);
    await expect(run(`UPDATE subscriptions SET plan_id = (SELECT id FROM subscription_plans WHERE code = 'professional')`)).rejects.toThrow(/upgrades are applied by platform billing/);
    await expect(run(`UPDATE subscriptions SET status = 'EXPIRED'`)).resolves.toBeUndefined();            // legitimate lifecycle transitions are still possible…
    await expect(run(`UPDATE subscriptions SET status = 'ACTIVE'`)).rejects.toThrow(/activated by platform billing/);   // …but reactivating a paid plan is not
    expect(await ownerPrisma.payment.count({ where: { organizationId: owner.orgId! } })).toBe(0);
  });
});
