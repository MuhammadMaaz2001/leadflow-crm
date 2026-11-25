'use client';
import * as React from 'react';
import { CalendarClock, CircleDollarSign, Clock, RotateCcw, Undo2 } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PAYMENT_METHODS } from '@leadflow/shared';
import { api } from '@/lib/api';
import { errMsg } from '@/lib/session';
import { fmtDate, fmtDateTime, money, titleCase } from '@/lib/format';
import { useDebounced } from '@/lib/use-url-state';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select, Textarea } from '@/components/ui/form';
import { Badge, Card, CardHeader, KeyValue } from '@/components/ui/data';
import { Dialog } from '@/components/ui/overlay';

export interface BillingDetail {
  organization: { id: string; name: string; timezone: string; currency: string; status: string };
  subscription: { id: string; status: string; interval: string; plan: { code: string; name: string; currency: string }; currentPeriodStart: string; currentPeriodEnd: string; trialEndsAt: string | null; graceEndsAt: string | null; cancelAtPeriodEnd: boolean };
  plans: Array<{ code: string; name: string; currency: string; priceMonthly: number; priceYearly: number }>;
  invoices: Array<{ id: string; number: string; status: string; amount: number; currency: string; issuedAt: string; paidAt: string | null; description: string; plan: { name: string } | null; paymentReference: string | null }>;
  payments: Array<{ id: string; receiptNumber: string; status: string; amount: number; currency: string; method: string; reference: string; receivedAt: string; note: string | null; internalNote: string | null; extension: string; previousExpiry: string | null; newExpiry: string; recordedBy: { name: string; email: string } | null; reversedAt: string | null; reversalReason: string | null; invoiceGenerated: boolean }>;
  events: Array<{ id: string; type: string; fromPlanCode: string | null; toPlanCode: string | null; note: string | null; createdAt: string; actor: { name: string; email: string } | null }>;
}
interface Preview { previousExpiry: string; newExpiry: string; newStart: string; base: string; planChange: boolean; fromPlan: string; toPlan: string; extension: string; amount: string | null; currency: string; invoiceNumber: string | null; timezone: string; statusBefore: string }

const BASIS: Record<string, string> = {
  CURRENT_EXPIRY: 'The subscription is still running (or only just lapsed), so the new period is added to the CURRENT expiry date.',
  TRIAL_END: 'The trial is still running: the paid period starts when the trial would have ended.',
  PAYMENT_DATE: 'The subscription had lapsed, so the new period starts now (the lapsed time is not back-billed).',
  PLAN_CHANGE: 'The plan is changing: the new plan starts now, without proration of the old plan.',
};
const METHOD_LABEL: Record<string, string> = { BANK_TRANSFER: 'Bank transfer', CASH: 'Cash', CARD_OFFLINE: 'Card (offline terminal)', CHEQUE: 'Cheque', MOBILE_MONEY: 'Mobile money', OTHER: 'Other' };
const PRESETS = [['1', '1 month'], ['3', '3 months'], ['6', '6 months'], ['12', '12 months'], ['custom', 'Custom (days)']] as const;
const inTz = (iso: string, tz: string) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(iso));
const today = () => new Date().toISOString().slice(0, 10);
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Confirm a payment received OUTSIDE the system. Shows the previous and the resulting expiry before anything is written. */
export function PaymentDialog({ orgId, open, onClose, invoice, billing }: { orgId: string; open: boolean; onClose: () => void; invoice?: { id: string; number: string; amount: number; currency: string; interval?: string | null } | null; billing?: BillingDetail }) {
  const qc = useQueryClient();
  const key = React.useRef(newKey());
  const detail = useQuery({ queryKey: ['platform', 'billing', orgId], queryFn: () => api.get<BillingDetail>(`/platform/organizations/${orgId}/billing`, undefined, { tenant: false }), enabled: open && !billing });
  const b = billing ?? detail.data;
  const blank = { planCode: '', amount: '', currency: '', method: 'BANK_TRANSFER', reference: '', receivedAt: today(), preset: invoice ? (invoice.interval === 'YEARLY' ? '12' : '1') : '1', days: '', note: '', internalNote: '', mismatch: false };
  const [f, setF] = React.useState(blank);
  const [error, setError] = React.useState<string | null>(null);
  const defaultPreset = blank.preset;
  React.useEffect(() => { if (open) { key.current = newKey(); setF({ planCode: '', amount: '', currency: '', method: 'BANK_TRANSFER', reference: '', receivedAt: today(), preset: defaultPreset, days: '', note: '', internalNote: '', mismatch: false }); setError(null); } }, [open, invoice?.id, defaultPreset]);
  const ext = f.preset === 'custom' ? (f.days ? { days: Number(f.days) } : undefined) : { months: Number(f.preset) };
  const payload = { ...(invoice ? { invoiceId: invoice.id } : { planCode: f.planCode || undefined }), amount: f.amount ? Number(f.amount) : undefined, currency: f.currency || undefined, extension: ext, receivedAt: f.receivedAt || undefined, allowAmountMismatch: f.mismatch || undefined, internalNote: f.internalNote || undefined };
  const dp = useDebounced(JSON.stringify(payload), 350);
  const preview = useQuery({ queryKey: ['platform', 'billing-preview', orgId, dp], queryFn: () => api.post<Preview>(`/platform/subscriptions/${orgId}/payments/preview`, JSON.parse(dp), { tenant: false }), enabled: open && !!ext && (!!invoice || !!f.amount), retry: false });
  const confirm = useMutation({
    mutationFn: () => api.post<{ duplicate: boolean; payment: { receiptNumber: string; newExpiry: string } }>(`/platform/subscriptions/${orgId}/payments`, { ...payload, method: f.method, reference: f.reference, note: f.note || undefined, idempotencyKey: key.current }, { tenant: false }),
    onSuccess: (r) => { toast.success(r.duplicate ? 'This payment was already recorded' : `Payment confirmed — receipt ${r.payment.receiptNumber}`); qc.invalidateQueries({ queryKey: ['platform'] }); onClose(); },
    onError: (e) => setError(errMsg(e)),
  });
  const p = preview.data; const tz = b?.organization.timezone ?? 'UTC';
  const amountMismatch = invoice && f.amount && (Number(f.amount) !== invoice.amount || (f.currency && f.currency !== invoice.currency));
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} size="lg" title={invoice ? `Confirm payment for ${invoice.number}` : 'Record a payment received'} description="Use this only after the money has actually arrived (bank transfer, cash…). Nothing is charged by LeadFlow."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={confirm.isPending} disabled={!f.reference.trim() || !ext || (!invoice && !f.amount) || !!preview.error} onClick={() => { setError(null); confirm.mutate(); }}>Confirm payment &amp; extend</Button></>}>
      <div className="space-y-4">
        <FormError message={error} />
        {b && <p className="rounded-lg bg-subtle p-2.5 text-xs text-ink-2">Current: <b>{b.subscription.plan.name}</b> · {titleCase(b.subscription.status)} · expires <b>{inTz(b.subscription.currentPeriodEnd, tz)}</b> <span className="text-ink-3">({tz})</span></p>}
        <div className="grid gap-3 sm:grid-cols-2">
          {!invoice && <Field label="Plan" hint="Choosing a different plan switches the plan."><Select aria-label="Plan" value={f.planCode} onChange={(e) => setF({ ...f, planCode: e.target.value })}><option value="">Keep current ({b?.subscription.plan.name ?? '…'})</option>{b?.plans.filter((x) => x.code !== 'free' && x.code !== b.subscription.plan.code).map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</Select></Field>}
          <Field label="Amount received" required={!invoice} hint={invoice ? `Invoice amount ${money(invoice.amount, invoice.currency)}` : undefined}><Input aria-label="Amount received" type="number" min="0" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder={invoice ? String(invoice.amount) : '0.00'} /></Field>
          <Field label="Currency"><Input aria-label="Currency" value={f.currency} maxLength={3} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} placeholder={invoice?.currency ?? b?.subscription.plan.currency ?? 'USD'} /></Field>
          <Field label="Payment method" required><Select aria-label="Payment method" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</Select></Field>
          <Field label="Payment reference" required hint="Bank transaction id, receipt no. … Must be unique per workspace."><Input aria-label="Payment reference" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
          <Field label="Date received" hint={`Workspace timezone: ${tz}`}><Input aria-label="Date received" type="date" max={today()} value={f.receivedAt} onChange={(e) => setF({ ...f, receivedAt: e.target.value })} /></Field>
        </div>
        <Field label="Extend the subscription by" required>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Extension period">
            {PRESETS.map(([v, l]) => <button key={v} type="button" aria-pressed={f.preset === v} onClick={() => setF({ ...f, preset: v })} className={`rounded-lg border px-3 py-1.5 text-[13px] ${f.preset === v ? 'border-accent bg-accent-soft font-medium text-accent-ink' : 'border-line bg-surface hover:bg-subtle'}`}>{l}</button>)}
            {f.preset === 'custom' && <Input aria-label="Custom days" className="w-28" type="number" min={1} max={1100} value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} placeholder="days" />}
          </div>
        </Field>
        {amountMismatch && <label className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn-soft p-2.5 text-xs text-warn"><input type="checkbox" className="mt-0.5" checked={f.mismatch} onChange={(e) => setF({ ...f, mismatch: e.target.checked })} />The amount or currency differs from the invoice. I confirm the difference is intentional (an internal note is required).</label>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Receipt note" hint="Visible to the workspace owner."><Textarea aria-label="Receipt note" rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
          <Field label="Internal note" hint="Administrators only."><Textarea aria-label="Internal note" rows={2} value={f.internalNote} onChange={(e) => setF({ ...f, internalNote: e.target.value })} /></Field>
        </div>
        <div className="rounded-xl border border-line p-3" aria-live="polite">
          <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-ink-2"><CalendarClock className="size-3.5" />Result</p>
          {preview.error ? <p className="text-xs text-bad">{errMsg(preview.error)}</p> : !p ? <p className="text-xs text-ink-3">Enter the amount and period to see the new expiry date.</p> : (
            <div className="space-y-1 text-[13px]">
              <p><span className="text-ink-3">Previous expiry</span> <b>{inTz(p.previousExpiry, tz)}</b> → <span className="text-ink-3">new expiry</span> <b className="text-ok">{inTz(p.newExpiry, tz)}</b></p>
              <p className="text-xs text-ink-3">{p.planChange ? `${p.fromPlan} → ${p.toPlan}. ` : `${p.toPlan}. `}{p.extension}. {BASIS[p.base]}</p>
              {p.invoiceNumber ? <p className="text-xs text-ink-3">Invoice {p.invoiceNumber} will be marked paid.</p> : <p className="text-xs text-ink-3">A paid invoice / receipt record will be generated.</p>}
            </div>)}
        </div>
      </div>
    </Dialog>
  );
}

export function ExtendDialog({ orgId, open, onClose, billing }: { orgId: string; open: boolean; onClose: () => void; billing: BillingDetail }) {
  const qc = useQueryClient();
  const [preset, setPreset] = React.useState('1'); const [days, setDays] = React.useState(''); const [reason, setReason] = React.useState(''); const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => { if (open) { setPreset('1'); setDays(''); setReason(''); setError(null); } }, [open]);
  const ext = preset === 'custom' ? (days ? { days: Number(days) } : undefined) : { months: Number(preset) };
  const m = useMutation({ mutationFn: () => api.post(`/platform/subscriptions/${orgId}/extend`, { extension: ext, reason }, { tenant: false }), onSuccess: () => { toast.success('Subscription extended'); qc.invalidateQueries({ queryKey: ['platform'] }); onClose(); }, onError: (e) => setError(errMsg(e)) });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} size="sm" title="Extend without a payment" description="Goodwill or correction. No payment, invoice or receipt is created; the reason is recorded in the history and audit log."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!ext || reason.trim().length < 5} onClick={() => m.mutate()}>Extend</Button></>}>
      <div className="space-y-3"><FormError message={error} />
        {billing.subscription.plan.code === 'free' && <p className="rounded-lg bg-warn-soft p-2 text-xs text-warn">The Free plan has no expiry; this will be refused.</p>}
        <Field label="Extend by" required><div className="flex flex-wrap items-center gap-2" role="group" aria-label="Extension length">{PRESETS.map(([v, l]) => <button key={v} type="button" aria-pressed={preset === v} onClick={() => setPreset(v)} className={`rounded-lg border px-3 py-1.5 text-[13px] ${preset === v ? 'border-accent bg-accent-soft font-medium text-accent-ink' : 'border-line bg-surface hover:bg-subtle'}`}>{l}</button>)}{preset === 'custom' && <Input aria-label="Extension days" className="w-28" type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} placeholder="days" />}</div></Field>
        <Field label="Reason" required><Textarea aria-label="Extension reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Compensation for the outage on 12 March" /></Field>
      </div>
    </Dialog>
  );
}

/** The workspace billing panel of the platform organisation page. */
export function BillingPanel({ orgId, canBill }: { orgId: string; canBill: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['platform', 'billing', orgId], queryFn: () => api.get<BillingDetail>(`/platform/organizations/${orgId}/billing`, undefined, { tenant: false }) });
  const [pay, setPay] = React.useState<null | { invoice?: NonNullable<BillingDetail['invoices']>[number] }>(null); const [ext, setExt] = React.useState(false);
  const reverse = useMutation({ mutationFn: (v: { id: string; reason: string }) => api.post(`/platform/payments/${v.id}/reverse`, { reason: v.reason }, { tenant: false }), onSuccess: () => { toast.success('Payment reversed'); qc.invalidateQueries({ queryKey: ['platform'] }); }, onError: (e) => toast.error(errMsg(e)) });
  const [reversing, setReversing] = React.useState<BillingDetail['payments'][number] | null>(null); const [why, setWhy] = React.useState('');
  const b = q.data;
  if (!b) return <Card className="p-6 text-center text-xs text-ink-3">{q.error ? errMsg(q.error) : 'Loading billing…'}</Card>;
  const s = b.subscription, tz = b.organization.timezone;
  const latest = b.payments.find((p) => p.status === 'CONFIRMED');
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Subscription" description={`Dates are shown in the workspace timezone (${tz}).`} />
        {canBill && <div className="flex flex-wrap gap-2 px-4 pb-3"><Button variant="primary" size="sm" onClick={() => setPay({})}><CircleDollarSign className="size-3.5" />Record payment &amp; extend</Button><Button size="sm" onClick={() => setExt(true)}><Clock className="size-3.5" />Extend without payment</Button></div>}
        <dl className="grid divide-y divide-line px-4 pb-3 sm:grid-cols-2 sm:gap-x-8 sm:divide-y-0">
          <div className="divide-y divide-line"><KeyValue label="Plan">{s.plan.name}</KeyValue><KeyValue label="Status"><Badge tone={s.status === 'ACTIVE' ? 'ok' : s.status === 'TRIALING' ? 'info' : s.status === 'PAST_DUE' ? 'warn' : 'bad'}>{titleCase(s.status)}</Badge></KeyValue><KeyValue label="Billing cycle">{titleCase(s.interval)}</KeyValue></div>
          <div className="divide-y divide-line"><KeyValue label="Period start">{inTz(s.currentPeriodStart, tz)}</KeyValue><KeyValue label={s.status === 'TRIALING' ? 'Trial ends' : 'Expires'}>{inTz(s.currentPeriodEnd, tz)}</KeyValue><KeyValue label="Grace period ends">{s.graceEndsAt ? inTz(s.graceEndsAt, tz) : '—'}</KeyValue></div>
        </dl>
      </Card>
      <Card>
        <CardHeader title="Payments & receipts" description="Every confirmed payment with the expiry it moved." />
        {!b.payments.length ? <p className="p-6 text-center text-xs text-ink-3">No payments recorded yet.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-[13px]"><thead><tr className="border-y border-line text-left text-xs text-ink-3"><th className="px-4 py-2 font-medium">Receipt</th><th className="px-2 py-2 font-medium">Received</th><th className="px-2 py-2 text-right font-medium">Amount</th><th className="px-2 py-2 font-medium">Method · reference</th><th className="px-2 py-2 font-medium">Expiry change</th><th className="px-2 py-2 font-medium">Recorded by</th><th className="px-4 py-2" /></tr></thead>
            <tbody className="divide-y divide-line">{b.payments.map((p) => (
              <tr key={p.id} className={p.status === 'REVERSED' ? 'opacity-60' : ''}>
                <td className="px-4 py-2"><p className="font-medium">{p.receiptNumber}</p>{p.status === 'REVERSED' && <Badge tone="bad">Reversed</Badge>}</td>
                <td className="px-2 py-2 text-ink-2">{fmtDate(p.receivedAt)}</td>
                <td className="tnum px-2 py-2 text-right font-medium">{money(p.amount, p.currency)}</td>
                <td className="px-2 py-2"><p>{METHOD_LABEL[p.method] ?? p.method}</p><p className="text-xs text-ink-3">{p.reference}</p></td>
                <td className="px-2 py-2 text-xs text-ink-2">{p.previousExpiry ? fmtDate(p.previousExpiry) : '—'} → <b>{fmtDate(p.newExpiry)}</b><p className="text-ink-3">+{p.extension}</p></td>
                <td className="px-2 py-2 text-xs text-ink-2">{p.recordedBy?.name ?? '—'}{p.internalNote && <p className="max-w-[200px] truncate text-ink-3" title={p.internalNote}>Note: {p.internalNote}</p>}{p.reversalReason && <p className="text-bad">Reversed: {p.reversalReason}</p>}</td>
                <td className="px-4 py-2 text-right">{canBill && latest?.id === p.id && <Button size="sm" variant="ghost" onClick={() => { setWhy(''); setReversing(p); }}><Undo2 className="size-3.5" />Reverse</Button>}</td>
              </tr>))}</tbody></table></div>)}
      </Card>
      <Card>
        <CardHeader title="Invoices" />
        {!b.invoices.length ? <p className="p-6 text-center text-xs text-ink-3">No invoices.</p> : <ul className="divide-y divide-line">{b.invoices.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[13px]"><div className="min-w-0 flex-1"><p className="font-medium">{i.number}</p><p className="truncate text-xs text-ink-3">{i.description} · issued {fmtDate(i.issuedAt)}{i.paidAt ? ` · paid ${fmtDate(i.paidAt)}` : ''}</p></div>
            <span className="tnum font-medium">{money(i.amount, i.currency)}</span><Badge tone={i.status === 'PAID' ? 'ok' : i.status === 'OPEN' ? 'warn' : i.status === 'FAILED' ? 'bad' : 'neutral'}>{titleCase(i.status)}</Badge>
            {canBill && (i.status === 'OPEN' || i.status === 'FAILED') && <Button size="sm" variant="primary" onClick={() => setPay({ invoice: i })}>Confirm payment</Button>}</li>))}</ul>}
      </Card>
      <Card className="p-4">
        <p className="mb-3 flex items-center gap-1.5 text-[13px] font-semibold"><RotateCcw className="size-3.5" />Subscription history</p>
        <ol className="space-y-3 border-l border-line pl-5">{b.events.map((e) => <li key={e.id} className="relative"><span className="absolute -left-[26px] top-1 size-2.5 rounded-full bg-accent" /><p className="text-[13px] font-medium">{titleCase(e.type)}{e.fromPlanCode && e.toPlanCode && e.fromPlanCode !== e.toPlanCode ? ` · ${e.fromPlanCode} → ${e.toPlanCode}` : ''}</p>{e.note && <p className="text-xs text-ink-2">{e.note}</p>}<p className="text-xs text-ink-3">{fmtDateTime(e.createdAt)}{e.actor ? ` · ${e.actor.name}` : ' · system'}</p></li>)}</ol>
      </Card>
      {pay && <PaymentDialog orgId={orgId} open onClose={() => setPay(null)} billing={b} invoice={pay.invoice ? { id: pay.invoice.id, number: pay.invoice.number, amount: pay.invoice.amount, currency: pay.invoice.currency, interval: pay.invoice.description.includes('annual') ? 'YEARLY' : 'MONTHLY' } : null} />}
      {ext && <ExtendDialog orgId={orgId} open onClose={() => setExt(false)} billing={b} />}
      <Dialog open={!!reversing} onOpenChange={(o) => !o && setReversing(null)} size="sm" title={`Reverse ${reversing?.receiptNumber}?`} description="Restores the previous expiry and plan. Only the most recent payment can be reversed." footer={<><Button onClick={() => setReversing(null)}>Cancel</Button><Button variant="danger" loading={reverse.isPending} disabled={why.trim().length < 5} onClick={() => reverse.mutate({ id: reversing!.id, reason: why }, { onSuccess: () => setReversing(null) })}>Reverse payment</Button></>}>
        <Field label="Reason" required><Textarea aria-label="Reversal reason" rows={3} value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
      </Dialog>
    </div>
  );
}
