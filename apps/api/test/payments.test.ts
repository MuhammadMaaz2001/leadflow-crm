import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { settleFromProviderEvent, getPaymentProvider, type ProviderPaymentEvent } from '../src/modules/subscriptions/payment-provider';
import { boot, createWorkspace, makePlatformAdmin, ownerPrisma, signUp, uniq, type Actor } from './helpers';

beforeAll(async () => { await boot(); });

async function openInvoice(owner: Actor) {
  const up = await owner.post('/billing/change-plan', { planCode: 'starter', interval: 'MONTHLY' });
  expect(up.status).toBe(200);
  const inv = await ownerPrisma.invoice.findUniqueOrThrow({ where: { id: up.body.data.invoiceId } });
  expect(inv.status).toBe('OPEN');
  return inv;
}
const ev = (inv: { id: string; amount: unknown; currency: string }, over: Partial<ProviderPaymentEvent> = {}): ProviderPaymentEvent =>
  ({ eventId: `evt_${uniq()}`, type: 'payment.succeeded', invoiceId: inv.id, providerPaymentId: `pay_${uniq()}`, amount: String(inv.amount), currency: inv.currency, ...over });
const planOf = async (orgId: string) => (await ownerPrisma.subscription.findUniqueOrThrow({ where: { organizationId: orgId }, include: { plan: true } })).plan.code;

describe('payments: no provider is configured, and nothing can be marked paid without proof', () => {
  it('manual is the only provider; no online provider object exists', () => {
    expect(config.paymentProvider).toBe('manual');
    expect(getPaymentProvider()).toBeNull();
  });

  it('a workspace cannot declare its own invoice paid outside development', async () => {
    const owner = await createWorkspace(await signUp('Pay Owner'), `Pay ${uniq()}`);
    const inv = await openInvoice(owner);
    const original = config.devTools;
    (config as { devTools: boolean }).devTools = false;     // as in production
    try {
      const r = await owner.post(`/billing/invoices/${inv.id}/record-payment`, { reference: 'I-PROMISE-I-PAID' });
      expect(r.status).toBe(403); expect(r.body.error.code).toBe('SELF_PAYMENT_DISABLED');
      expect((await owner.get('/organizations/current')).body.data.billing.selfServiceManualPayment).toBe(false);
    } finally { (config as { devTools: boolean }).devTools = original; }
    expect((await ownerPrisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('OPEN');
    expect(await planOf(owner.orgId!)).not.toBe('starter');
  });

  it('platform billing admins can record a payment; a concurrent double recording extends the subscription once', async () => {
    const owner = await createWorkspace(await signUp('Pay Owner 2'), `Pay2 ${uniq()}`);
    const inv = await openInvoice(owner);
    const admin = await makePlatformAdmin('BILLING_ADMIN');
    const rs = await Promise.all(Array.from({ length: 4 }, () => admin.agent.post(`/api/platform/invoices/${inv.id}/mark-paid`).send({ reference: 'BANK-1' })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(3);
    const events = await ownerPrisma.subscriptionEvent.findMany({ where: { organizationId: owner.orgId!, type: { in: ['PLAN_CHANGED', 'RENEWED'] } } });
    expect(events.filter((e) => e.toPlanCode === 'starter')).toHaveLength(1);
    expect(await planOf(owner.orgId!)).toBe('starter');
  });
});

describe('settling invoices from provider events (adapter contract, exercised with a test double)', () => {
  it('applies a verified, matching success exactly once — also under concurrent duplicate delivery', async () => {
    const owner = await createWorkspace(await signUp('Evt Owner'), `Evt ${uniq()}`);
    const inv = await openInvoice(owner);
    const e = ev(inv);
    const results = await Promise.all(Array.from({ length: 5 }, () => settleFromProviderEvent('testpay', e)));
    expect(results.filter((r) => r.outcome === 'APPLIED')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'IGNORED')).toHaveLength(4);
    const after = await ownerPrisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.status).toBe('PAID'); expect(after.paymentMethod).toBe('PROVIDER_TESTPAY'); expect(after.paymentReference).toBe(e.providerPaymentId);
    expect(await planOf(owner.orgId!)).toBe('starter');
    expect(await ownerPrisma.paymentEvent.count({ where: { provider: 'testpay', eventId: e.eventId } })).toBe(1);
    // a different event for the already-paid invoice changes nothing
    expect((await settleFromProviderEvent('testpay', ev(inv))).outcome).toBe('IGNORED');
  });

  it('rejects wrong amount, wrong currency and unknown invoices without touching the subscription', async () => {
    const owner = await createWorkspace(await signUp('Evt Owner 2'), `Evt2 ${uniq()}`);
    const inv = await openInvoice(owner);
    for (const bad of [{ amount: '0.01' }, { amount: String(Number(inv.amount) + 1) }, { currency: 'EUR' }, { invoiceId: '00000000-0000-4000-8000-000000000000' }]) {
      expect((await settleFromProviderEvent('testpay', ev(inv, bad))).outcome).toBe('REJECTED');
    }
    const after = await ownerPrisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.status).toBe('OPEN'); expect(after.paidAt).toBeNull();
    expect(await planOf(owner.orgId!)).not.toBe('starter');
  });

  it('a failure event marks the open invoice failed; the invoice can still be paid later', async () => {
    const owner = await createWorkspace(await signUp('Evt Owner 3'), `Evt3 ${uniq()}`);
    const inv = await openInvoice(owner);
    expect((await settleFromProviderEvent('testpay', ev(inv, { type: 'payment.failed', failureReason: 'card declined' }))).outcome).toBe('APPLIED');
    expect((await ownerPrisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('FAILED');
    expect((await settleFromProviderEvent('testpay', ev(inv))).outcome).toBe('APPLIED');
    expect((await ownerPrisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('PAID');
  });

  it('the same event id from different providers is independent', async () => {
    const owner = await createWorkspace(await signUp('Evt Owner 4'), `Evt4 ${uniq()}`);
    const inv = await openInvoice(owner);
    const e = ev(inv, { type: 'payment.refunded' });
    expect((await settleFromProviderEvent('a', e)).outcome).toBe('IGNORED');
    expect((await settleFromProviderEvent('b', e)).outcome).toBe('IGNORED');
    expect(await ownerPrisma.paymentEvent.count({ where: { eventId: e.eventId } })).toBe(2);
  });
});
