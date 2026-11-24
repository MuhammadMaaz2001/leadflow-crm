import { Prisma } from '@leadflow/database';
import { platformPrisma } from '../../db';
import { config } from '../../config';
import { log } from '../../lib/logger';
import { applyPayment } from './lifecycle';

/**
 * Provider-independent payment interface.
 *
 * NO payment processor is integrated: `PAYMENT_PROVIDER=manual` is the only supported value, and a provider adapter must be
 * written, credentialed and explicitly configured before real payments can exist. What exists today is the contract an adapter
 * has to fulfil and — more importantly — the single, defensive place where a provider's claim "invoice X was paid" is turned into
 * a state change (`settleFromProviderEvent`). It never trusts an event blindly:
 *   • events are authenticated by the adapter (`parseWebhook` verifies the provider signature and throws otherwise),
 *   • each (provider, eventId) is applied at most once (database unique constraint),
 *   • amount and currency must match the invoice exactly, the invoice must be payable,
 *   • a success is only ever recorded for a real, verified event — there is no code path that fabricates one.
 */
export interface PaymentRequest { invoiceId: string; number: string; amount: string; currency: string; description: string; customerEmail: string | null; returnUrl: string }
export interface PaymentSession { providerPaymentId: string; status: 'requires_action' | 'pending'; redirectUrl?: string }
export interface ProviderPaymentEvent {
  eventId: string;            // unique per provider event; used for idempotency
  type: 'payment.succeeded' | 'payment.failed' | 'payment.refunded';
  invoiceId: string;
  providerPaymentId: string;
  amount: string;             // decimal string, e.g. "49.00"
  currency: string;
  failureReason?: string;
}
export interface PaymentProvider {
  readonly name: string;
  /** Starts collecting payment (hosted checkout / payment link). It must NOT mark anything as paid. */
  createPayment(req: PaymentRequest): Promise<PaymentSession>;
  /** Verifies the webhook signature against the RAW body and returns normalised events; throws on any verification failure. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): Promise<ProviderPaymentEvent[]>;
}

const registry = new Map<string, PaymentProvider>();
/** Adapters register themselves here (only after being configured with real credentials). */
export const registerPaymentProvider = (p: PaymentProvider) => { registry.set(p.name, p); };
export const unregisterPaymentProvider = (name: string) => { registry.delete(name); };
/** `manual` has no online provider; returns null so callers show "awaiting payment" instead of pretending. */
export function getPaymentProvider(): PaymentProvider | null {
  return config.paymentProvider === 'manual' ? null : registry.get(config.paymentProvider) ?? null;
}

export type SettleOutcome = { outcome: 'APPLIED' | 'IGNORED' | 'REJECTED'; reason?: string };

export async function settleFromProviderEvent(providerName: string, ev: ProviderPaymentEvent): Promise<SettleOutcome> {
  return platformPrisma.$transaction(async (tx) => {
    // exactly-once: the unique (provider, event_id) row is the idempotency key
    const first = await tx.paymentEvent.createMany({ data: [{ provider: providerName, eventId: ev.eventId, eventType: ev.type, outcome: 'IGNORED', detail: 'processing' }], skipDuplicates: true });
    if (first.count === 0) return { outcome: 'IGNORED' as const, reason: 'duplicate event' };
    const done = async (outcome: SettleOutcome['outcome'], detail?: string, invoiceId?: string | null): Promise<SettleOutcome> => {
      await tx.paymentEvent.update({ where: { provider_eventId: { provider: providerName, eventId: ev.eventId } }, data: { outcome, detail: detail?.slice(0, 300), invoiceId: invoiceId ?? null } });
      return { outcome, reason: detail };
    };
    const inv = await tx.invoice.findUnique({ where: { id: ev.invoiceId } });
    if (!inv) return done('REJECTED', 'unknown invoice');
    if (ev.type === 'payment.failed') {
      if (inv.status === 'OPEN') await tx.invoice.updateMany({ where: { id: inv.id, status: 'OPEN' }, data: { status: 'FAILED', failedAt: new Date(), failureReason: (ev.failureReason ?? 'Payment failed').slice(0, 200) } });
      return done('APPLIED', 'payment failure recorded', inv.id);
    }
    if (ev.type !== 'payment.succeeded') return done('IGNORED', `event type ${ev.type} is not handled automatically`, inv.id);
    if (inv.currency.toUpperCase() !== ev.currency.toUpperCase() || !new Prisma.Decimal(ev.amount).equals(inv.amount)) {
      log.error('payment event rejected: amount/currency mismatch', { provider: providerName, eventId: ev.eventId, invoiceId: inv.id });
      return done('REJECTED', 'amount or currency does not match the invoice', inv.id);
    }
    if (inv.status !== 'OPEN' && inv.status !== 'FAILED') return done('IGNORED', `invoice is ${inv.status.toLowerCase()}`, inv.id);
    await applyPayment(inv.id, { actorId: null, reference: ev.providerPaymentId, method: `PROVIDER_${providerName.toUpperCase()}` }, tx);
    return done('APPLIED', undefined, inv.id);
  });
}
