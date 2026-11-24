'use client';
import * as React from 'react';
import { AlertTriangle, Check, CreditCard, Download, FileText, Info, Lock, ReceiptText } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { errMsg, useAct, useOrg, useT } from '@/lib/session';
import { fmtDate, fmtDateTime, money, num, titleCase } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/form';
import { Badge, Card, CardHeader, EmptyState, PageHeader, Skeleton } from '@/components/ui/data';
import { Dialog, useConfirm } from '@/components/ui/overlay';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/menu';

interface Plan { id: string; code: string; name: string; description: string | null; priceMonthly: number; priceYearly: number; currency: string; trialDays: number; maxLeads: number; maxSeats: number; features: string[] }
interface Invoice { id: string; number: string; description: string; status: string; amount: number; currency: string; issuedAt: string; dueAt: string; paidAt: string | null; paymentMethod: string | null; paymentReference: string | null; failureReason: string | null; periodStart: string | null; periodEnd: string | null; plan?: { name: string } | null; billTo?: { name: string; email: string | null; address: string | null } }
interface Billing {
  subscription: { status: string; interval: string; trialEndsAt: string | null; currentPeriodEnd: string; graceEndsAt: string | null; cancelAtPeriodEnd: boolean; pendingPlan: { name: string } | null; plan: Plan };
  usage: { leads: number; seats: number; pendingInvites: number; opportunities: number; maxLeads: number; maxSeats: number }; graceDays: number;
  invoices: Invoice[]; events: Array<{ id: string; type: string; fromPlanCode: string | null; toPlanCode: string | null; status: string | null; note: string | null; createdAt: string }>;
  plans: Plan[]; features: Array<{ key: string; label: string }>; paymentNote: string;
}
const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info' | 'neutral'> = { ACTIVE: 'ok', TRIALING: 'info', PAST_DUE: 'warn', EXPIRED: 'bad', CANCELED: 'bad', PAID: 'ok', OPEN: 'warn', FAILED: 'bad', VOID: 'neutral', DRAFT: 'neutral' };

function Meter({ label, used, max, extra }: { label: string; used: number; max: number; extra?: string }) {
  const p = Math.min(100, Math.round((used / max) * 100));
  return <div><div className="mb-1 flex items-baseline justify-between text-[13px]"><span className="font-medium">{label}</span><span className="tnum text-ink-2"><b className="text-ink">{num(used)}</b> / {num(max)}{extra}</span></div><div className="h-2 overflow-hidden rounded-full bg-subtle" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label={label}><div className={cn('h-full rounded-full transition-all', p >= 100 ? 'bg-bad' : p >= 80 ? 'bg-warn' : 'bg-accent')} style={{ width: `${p}%` }} /></div></div>;
}

function InvoiceDialog({ id, onClose, canPay }: { id: string | null; onClose: () => void; canPay: boolean }) {
  const q = useT(['invoice', id], () => api.get<Invoice>(`/billing/invoices/${id}`), { enabled: !!id });
  const [ref, setRef] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => { setRef(''); setError(null); }, [id]);
  const pay = useAct(() => api.post(`/billing/invoices/${id}/record-payment`, { reference: ref }), { success: 'Payment recorded — plan updated', silent: true, onSuccess: onClose, onError: (e) => setError(errMsg(e)) });
  const i = q.data;
  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()} title={i ? `Invoice ${i.number}` : 'Invoice'} description={i?.description}
      footer={i && canPay && (i.status === 'OPEN' || i.status === 'FAILED') ? <><Button onClick={onClose}>Close</Button><Button variant="primary" loading={pay.isPending} disabled={!ref.trim()} onClick={() => pay.mutate()}>Record manual payment</Button></> : <Button onClick={onClose}>Close</Button>}>
      {!i ? <Skeleton className="h-40" /> : (
        <div className="space-y-4">
          <div className="flex items-start justify-between"><div><p className="text-xs text-ink-3">Bill to</p><p className="text-[13px] font-medium">{i.billTo?.name}</p>{i.billTo?.email && <p className="text-xs text-ink-2">{i.billTo.email}</p>}</div><div className="text-right"><Badge tone={STATUS_TONE[i.status]}>{titleCase(i.status)}</Badge><p className="tnum mt-1 text-2xl font-semibold">{money(i.amount, i.currency)}</p></div></div>
          <dl className="divide-y divide-line rounded-lg border border-line px-3 text-[13px]">
            {[['Issued', fmtDate(i.issuedAt)], ['Due', fmtDate(i.dueAt)], ['Period', i.periodStart ? `${fmtDate(i.periodStart)} – ${fmtDate(i.periodEnd)}` : '—'], ...(i.paidAt ? [['Paid', fmtDateTime(i.paidAt)], ['Method', i.paymentMethod === 'MANUAL_DEV' ? 'Manually recorded (development)' : i.paymentMethod === 'MANUAL_PLATFORM' ? 'Manually recorded by platform admin' : i.paymentMethod ?? '—'], ['Reference', i.paymentReference ?? '—']] : []), ...(i.failureReason ? [['Failure', i.failureReason]] : [])].map(([l, v]) => <div key={l} className="flex justify-between py-2"><dt className="text-ink-3">{l}</dt><dd className="text-right">{v}</dd></div>)}
          </dl>
          {!canPay && (i.status === 'OPEN' || i.status === 'FAILED') && (
            <div className="rounded-lg border border-line bg-subtle p-3"><p className="flex items-center gap-1.5 text-xs font-semibold"><Info className="size-3.5" />Awaiting payment</p><p className="mt-1 text-xs text-ink-2">Online card payment is not available yet. Pay this invoice using the instructions from LeadFlow billing; the plan is activated as soon as the payment is confirmed. You do not need to do anything else in the app.</p></div>
          )}
          {canPay && (i.status === 'OPEN' || i.status === 'FAILED') && (
            <div className="rounded-lg border border-warn/30 bg-warn-soft p-3"><p className="flex items-center gap-1.5 text-xs font-semibold text-warn"><Info className="size-3.5" />Development / manual payment</p><p className="mt-1 text-xs text-warn/90">No payment processor is connected. If this invoice was settled outside LeadFlow (bank transfer, cash…), enter the reference. This is recorded under your name in the audit log.</p><div className="mt-2"><FormError message={error} /><Field label="Payment reference" required><Input aria-label="Payment reference" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. Bank transfer #4821" /></Field></div></div>
          )}
        </div>
      )}
    </Dialog>
  );
}

export default function BillingPage() {
  const { can, org } = useOrg();
  const confirm = useConfirm();
  const q = useT(['billing'], () => api.get<Billing>('/billing'));
  const [interval, setIntervalV] = React.useState<'MONTHLY' | 'YEARLY'>('MONTHLY');
  const [invoiceId, setInvoiceId] = React.useState<string | null>(null);
  const manage = can('billing.manage');
  const change = useAct((v: { planCode: string; interval: string }) => api.post<{ applied: string; invoiceId?: string }>('/billing/change-plan', v), {
    onSuccess: (r) => { if (r.applied === 'pending_payment' && r.invoiceId) { toast.success('Invoice created — record payment to activate the plan'); setInvoiceId(r.invoiceId); } else if (r.applied === 'at_period_end') toast.success('Downgrade scheduled for the end of the billing period'); else toast.success('Plan updated'); },
  });
  const cancel = useAct(() => api.post('/billing/cancel'), { success: 'Cancellation scheduled for period end' });
  const reactivate = useAct(() => api.post<{ applied?: string; invoiceId?: string }>('/billing/reactivate'), { success: 'Subscription updated', onSuccess: (r) => r.invoiceId && setInvoiceId(r.invoiceId) });
  const d = q.data;
  const s = d?.subscription;
  if (q.isLoading || !d || !s) return <><PageHeader title="Subscription & billing" /><Skeleton className="h-96" /></>;
  const openInvoice = d.invoices.find((i) => i.status === 'OPEN' || i.status === 'FAILED');
  return (
    <>
      <PageHeader title="Subscription & billing" description="Plans, usage limits and invoices for this workspace." />
      {(s.status === 'PAST_DUE' || s.status === 'EXPIRED') && (
        <div className={cn('mb-4 flex flex-wrap items-center gap-3 rounded-xl border p-4 text-[13px]', s.status === 'EXPIRED' ? 'border-bad/30 bg-bad-soft text-bad' : 'border-warn/30 bg-warn-soft text-warn')}>
          <AlertTriangle className="size-5 shrink-0" /><div className="flex-1"><p className="font-semibold">{s.status === 'EXPIRED' ? 'Subscription expired — workspace is read-only' : 'Payment overdue'}</p><p className="text-xs opacity-90">{s.status === 'EXPIRED' ? 'You can view everything, but creating or editing is paused until the outstanding invoice is paid.' : `Full access continues during the ${d.graceDays}-day grace period, until ${fmtDate(s.graceEndsAt)}.`}</p></div>
          {openInvoice && <Button variant="primary" onClick={() => setInvoiceId(openInvoice.id)}>View invoice {openInvoice.number}</Button>}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Current plan" />
          <div className="flex flex-wrap items-start justify-between gap-4 px-4 pb-4 pt-2">
            <div><div className="flex items-center gap-2"><h2 className="text-2xl font-semibold">{s.plan.name}</h2><Badge tone={STATUS_TONE[s.status]}>{titleCase(s.status)}</Badge></div>
              <p className="mt-1 text-[13px] text-ink-2">{s.plan.code === 'free' ? 'Free forever' : `${money(s.interval === 'YEARLY' ? s.plan.priceYearly : s.plan.priceMonthly, s.plan.currency)} / ${s.interval === 'YEARLY' ? 'year' : 'month'}`}</p>
              <p className="mt-2 text-xs text-ink-3">{s.status === 'TRIALING' ? `Trial ends ${fmtDate(s.trialEndsAt)}` : s.plan.code === 'free' ? 'No renewal' : s.cancelAtPeriodEnd ? `Ends ${fmtDate(s.currentPeriodEnd)} (canceled)` : `Renews ${fmtDate(s.currentPeriodEnd)}`}{s.pendingPlan && ` · moving to ${s.pendingPlan.name} on renewal`}</p></div>
            {manage && s.plan.code !== 'free' && <div className="flex gap-2">{(s.cancelAtPeriodEnd || s.pendingPlan) ? <Button onClick={() => reactivate.mutate()}>Keep current plan</Button> : <Button variant="dangerGhost" onClick={async () => { if (await confirm({ title: 'Cancel at period end?', description: 'You keep access until the end of the billing period, then move to the Free plan.', confirmLabel: 'Cancel subscription', destructive: true })) cancel.mutate(); }}>Cancel subscription</Button>}</div>}
          </div>
          <div className="grid gap-5 border-t border-line p-4 sm:grid-cols-2">
            <Meter label="Active leads" used={d.usage.leads} max={d.usage.maxLeads} />
            <Meter label="User seats" used={d.usage.seats} max={d.usage.maxSeats} extra={d.usage.pendingInvites ? ` (+${d.usage.pendingInvites} invited)` : ''} />
          </div>
        </Card>
        <Card>
          <CardHeader title="Included features" />
          <ul className="space-y-2 px-4 pb-4 pt-2 text-[13px]">{d.features.map((f) => { const on = s.plan.features.includes(f.key); return <li key={f.key} className={cn('flex items-center gap-2', !on && 'text-ink-3')}>{on ? <Check className="size-4 text-ok" /> : <Lock className="size-3.5" />}{f.label}</li>; })}</ul>
        </Card>
      </div>

      <div className="mt-6 flex items-center justify-between"><h2 className="text-[15px] font-semibold">Plans</h2>
        <div role="group" aria-label="Billing cycle" className="flex rounded-lg bg-subtle p-0.5">{(['MONTHLY', 'YEARLY'] as const).map((i) => <button key={i} aria-pressed={interval === i} onClick={() => setIntervalV(i)} className={cn('rounded-md px-3 py-1 text-xs font-medium', interval === i ? 'bg-surface shadow-card' : 'text-ink-2')}>{i === 'MONTHLY' ? 'Monthly' : 'Yearly'}{i === 'YEARLY' && <span className="ml-1 text-ok">2 months free</span>}</button>)}</div></div>
      <div className="mt-3 grid gap-4 md:grid-cols-3">
        {d.plans.map((p) => {
          const current = p.code === s.plan.code && (p.code === 'free' || s.interval === interval);
          const price = interval === 'YEARLY' ? p.priceYearly : p.priceMonthly;
          const higher = p.priceMonthly > s.plan.priceMonthly || (p.code === s.plan.code && s.plan.code !== 'free');
          return (
            <Card key={p.id} className={cn('flex flex-col p-5', current && 'border-accent ring-1 ring-accent/30')}>
              <div className="flex items-center justify-between"><h3 className="text-[15px] font-semibold">{p.name}</h3>{current && <Badge tone="accent">Current</Badge>}</div>
              <p className="mt-1 text-xs text-ink-2">{p.description}</p>
              <p className="tnum mt-4 text-3xl font-semibold">{p.code === 'free' ? 'Free' : money(price, p.currency)}{p.code !== 'free' && <span className="text-sm font-normal text-ink-3"> / {interval === 'YEARLY' ? 'yr' : 'mo'}</span>}</p>
              <ul className="mt-4 flex-1 space-y-2 text-[13px]">
                <li className="flex items-center gap-2"><Check className="size-4 text-ok" /><span>Up to <b>{num(p.maxLeads)}</b> leads</span></li>
                <li className="flex items-center gap-2"><Check className="size-4 text-ok" /><span><b>{p.maxSeats}</b> user seats</span></li>
                {d.features.map((f) => <li key={f.key} className={cn('flex items-center gap-2', !p.features.includes(f.key) && 'text-ink-3 line-through decoration-ink-3/40')}>{p.features.includes(f.key) ? <Check className="size-4 text-ok" /> : <Lock className="size-3.5" />}{f.label}</li>)}
              </ul>
              {manage && <Button className="mt-5" variant={higher && !current ? 'primary' : 'secondary'} disabled={current} loading={change.isPending && change.variables?.planCode === p.code}
                onClick={async () => { if (!higher && !(await confirm({ title: `Switch to ${p.name}?`, description: s.status === 'TRIALING' ? 'An invoice is issued now. The new plan only starts once a payment has been recorded — until then your trial continues.' : p.code === 'free' ? 'You move to the Free plan at the end of the current billing period.' : 'The change takes effect at the end of the current billing period.', confirmLabel: 'Switch plan' }))) return; change.mutate({ planCode: p.code, interval }); }}>{current ? 'Current plan' : higher ? `Upgrade to ${p.name}` : `Switch to ${p.name}`}</Button>}
            </Card>
          );
        })}
      </div>
      {!manage && <p className="mt-3 text-xs text-ink-3">Only workspace owners can change the plan.</p>}

      <Tabs defaultValue="invoices" className="mt-6">
        <TabsList><TabsTrigger value="invoices">Invoices</TabsTrigger><TabsTrigger value="history">Subscription history</TabsTrigger></TabsList>
        <TabsContent value="invoices" className="pt-4"><Card>
          {!d.invoices.length ? <EmptyState icon={<ReceiptText />} title="No invoices yet" description="Invoices appear when you upgrade or renew." /> : (
            <div className="scroll-thin overflow-x-auto"><table className="w-full min-w-[620px] text-left text-[13px]"><thead><tr className="border-b border-line bg-subtle/60 text-[11px] font-medium uppercase tracking-wide text-ink-3"><th className="px-4 py-2">Invoice</th><th className="px-4 py-2">Description</th><th className="px-4 py-2">Issued</th><th className="px-4 py-2 text-right">Amount</th><th className="px-4 py-2">Status</th><th className="px-4 py-2" /></tr></thead>
              <tbody className="divide-y divide-line">{d.invoices.map((i) => <tr key={i.id} className="hover:bg-subtle/50"><td className="px-4 py-2 font-medium">{i.number}</td><td className="max-w-[260px] truncate px-4 py-2 text-ink-2">{i.description}</td><td className="px-4 py-2 text-ink-2">{fmtDate(i.issuedAt)}</td><td className="tnum px-4 py-2 text-right font-medium">{money(i.amount, i.currency)}</td><td className="px-4 py-2"><Badge tone={STATUS_TONE[i.status]}>{titleCase(i.status)}</Badge></td><td className="px-4 py-2 text-right"><Button size="sm" onClick={() => setInvoiceId(i.id)}><FileText className="size-3.5" />{(i.status === 'OPEN' || i.status === 'FAILED') && manage ? 'Pay / view' : 'View'}</Button></td></tr>)}</tbody></table></div>
          )}
          <p className="border-t border-line px-4 py-3 text-xs text-ink-3"><CreditCard className="mr-1 inline size-3.5" />{d.paymentNote}</p>
        </Card></TabsContent>
        <TabsContent value="history" className="pt-4"><Card className="p-4"><ol className="space-y-4 border-l border-line pl-5">{d.events.map((e) => <li key={e.id} className="relative"><span className="absolute -left-[26px] top-1 size-2.5 rounded-full bg-accent" /><p className="text-[13px] font-medium">{titleCase(e.type)}{e.fromPlanCode && e.toPlanCode && e.fromPlanCode !== e.toPlanCode ? ` · ${e.fromPlanCode} → ${e.toPlanCode}` : e.toPlanCode ? ` · ${e.toPlanCode}` : ''}</p><p className="text-xs text-ink-3">{fmtDateTime(e.createdAt)}{e.note ? ` · ${e.note}` : ''}</p></li>)}</ol></Card></TabsContent>
      </Tabs>
      <InvoiceDialog id={invoiceId} onClose={() => setInvoiceId(null)} canPay={manage && !!org?.billing?.selfServiceManualPayment} />
    </>
  );
}
void Download;
