'use client';
import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Ban, CheckCircle2, Lock, Pencil } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { errMsg, useMe } from '@/lib/session';
import { fmtDate, fmtDateTime, money, timeAgo, titleCase } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select, Textarea } from '@/components/ui/form';
import { Badge, Card, CardHeader, KeyValue, PageHeader, Skeleton } from '@/components/ui/data';
import { Dialog } from '@/components/ui/overlay';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/menu';
import { subTone } from '../page';

interface Detail {
  organization: { id: string; name: string; slug: string; industry: string | null; website: string | null; contactEmail: string | null; country: string | null; timezone: string; currency: string; status: string; suspendedAt: string | null; suspendedReason: string | null; createdAt: string; onboarded: boolean };
  subscription: { id: string; status: string; interval: string; trialEndsAt: string | null; currentPeriodEnd: string; graceEndsAt: string | null; cancelAtPeriodEnd: boolean; plan: { code: string; name: string; maxLeads: number; maxSeats: number } } | null;
  usage: { leads: number; opportunities: number; seats: number; lastLeadAt: string | null };
  members: Array<{ id: string; name: string; email: string; role: string; status: string; isActive: boolean; lastLoginAt: string | null }>;
  invoices: Array<{ id: string; number: string; status: string; amount: number; currency: string; issuedAt: string; description: string }>;
  events: Array<{ id: string; type: string; fromPlanCode: string | null; toPlanCode: string | null; note: string | null; createdAt: string }>;
  auditLogs: Array<{ id: string; action: string; actorEmail: string | null; scope: string; createdAt: string }>;
  privacy: string;
}

export default function OrgDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const me = useMe();
  const role = me.data?.user.platformRole;
  const canSupport = role === 'SUPER_ADMIN' || role === 'SUPPORT_ADMIN';
  const canBilling = role === 'SUPER_ADMIN' || role === 'BILLING_ADMIN';
  const q = useQuery({ queryKey: ['platform', 'org', id], queryFn: () => api.get<Detail>(`/platform/organizations/${id}`, undefined, { tenant: false }) });
  const [suspend, setSuspend] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [adjust, setAdjust] = React.useState(false);
  const [adj, setAdj] = React.useState({ planCode: '', interval: '', status: '', extendDays: '', note: '' });
  const [error, setError] = React.useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['platform'] });
  const doSuspend = useMutation({ mutationFn: () => api.post(`/platform/organizations/${id}/suspend`, { reason }, { tenant: false }), onSuccess: () => { toast.success('Organization suspended'); setSuspend(false); refresh(); }, onError: (e) => setError(errMsg(e)) });
  const activate = useMutation({ mutationFn: () => api.post(`/platform/organizations/${id}/activate`, {}, { tenant: false }), onSuccess: () => { toast.success('Organization re-activated'); refresh(); }, onError: (e) => toast.error(errMsg(e)) });
  const doAdjust = useMutation({ mutationFn: () => api.post(`/platform/subscriptions/${id}/adjust`, { planCode: adj.planCode || undefined, interval: adj.interval || undefined, status: adj.status || undefined, extendDays: adj.extendDays ? Number(adj.extendDays) : undefined, note: adj.note || undefined }, { tenant: false }), onSuccess: () => { toast.success('Subscription adjusted'); setAdjust(false); refresh(); }, onError: (e) => setError(errMsg(e)) });
  const plans = useQuery({ queryKey: ['platform', 'plans'], queryFn: () => api.get<Array<{ code: string; name: string }>>('/platform/plans', undefined, { tenant: false }) });
  const d = q.data;
  if (!d) return <Skeleton className="h-96" />;
  const o = d.organization, s = d.subscription;
  return (
    <>
      <Link href="/platform/organizations" className="mb-3 inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink"><ArrowLeft className="size-3" />All organizations</Link>
      <PageHeader title={o.name} description={`${o.industry ?? 'No industry'} · registered ${fmtDate(o.createdAt)} · ${o.slug}`}
        actions={<>{o.status === 'ACTIVE' ? <Button variant="dangerGhost" disabled={!canSupport} onClick={() => { setReason(''); setError(null); setSuspend(true); }}><Ban className="size-3.5" />Suspend</Button> : <Button variant="primary" disabled={!canSupport} onClick={() => activate.mutate()}><CheckCircle2 className="size-3.5" />Re-activate</Button>}<Button disabled={!canBilling || !s} onClick={() => { setAdj({ planCode: '', interval: '', status: '', extendDays: '', note: '' }); setError(null); setAdjust(true); }}><Pencil className="size-3.5" />Adjust subscription</Button></>} />
      {o.status === 'SUSPENDED' && <div className="mb-4 rounded-xl border border-bad/30 bg-bad-soft p-3 text-[13px] text-bad"><b>Suspended</b> {o.suspendedAt && `on ${fmtDateTime(o.suspendedAt)}`} — {o.suspendedReason}</div>}
      {(!canSupport || !canBilling) && <p className="mb-3 flex items-center gap-1.5 text-xs text-ink-3"><Lock className="size-3" />Some actions are restricted for your platform role ({role?.replace('_', ' ').toLowerCase()}).</p>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card><CardHeader title="Subscription" /><dl className="divide-y divide-line px-4 pb-3"><KeyValue label="Plan">{s?.plan.name ?? '—'}</KeyValue><KeyValue label="Status"><Badge tone={subTone(s?.status)}>{titleCase(s?.status ?? 'none')}</Badge></KeyValue><KeyValue label="Billing">{s ? titleCase(s.interval) : '—'}</KeyValue><KeyValue label={s?.status === 'TRIALING' ? 'Trial ends' : 'Period ends'}>{fmtDate(s?.trialEndsAt ?? s?.currentPeriodEnd)}</KeyValue>{s?.graceEndsAt && <KeyValue label="Grace ends">{fmtDate(s.graceEndsAt)}</KeyValue>}</dl></Card>
        <Card><CardHeader title="Usage" description="Aggregate counts only" /><dl className="divide-y divide-line px-4 pb-3"><KeyValue label="Leads">{d.usage.leads.toLocaleString()} / {s?.plan.maxLeads.toLocaleString()}</KeyValue><KeyValue label="Seats">{d.usage.seats} / {s?.plan.maxSeats}</KeyValue><KeyValue label="Opportunities">{d.usage.opportunities.toLocaleString()}</KeyValue><KeyValue label="Last lead created">{d.usage.lastLeadAt ? timeAgo(d.usage.lastLeadAt) : 'never'}</KeyValue></dl></Card>
        <Card><CardHeader title="Company" /><dl className="divide-y divide-line px-4 pb-3"><KeyValue label="Contact">{o.contactEmail ?? '—'}</KeyValue><KeyValue label="Country">{o.country ?? '—'}</KeyValue><KeyValue label="Timezone">{o.timezone}</KeyValue><KeyValue label="Currency">{o.currency}</KeyValue><KeyValue label="Onboarded">{o.onboarded ? 'Yes' : 'Not yet'}</KeyValue></dl></Card>
      </div>
      <Tabs defaultValue="members" className="mt-5">
        <TabsList><TabsTrigger value="members">Members ({d.members.length})</TabsTrigger><TabsTrigger value="invoices">Invoices</TabsTrigger><TabsTrigger value="history">Subscription history</TabsTrigger><TabsTrigger value="audit">Audit</TabsTrigger></TabsList>
        <TabsContent value="members" className="pt-4"><Card><ul className="divide-y divide-line">{d.members.map((m) => <li key={m.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]"><div className="min-w-0 flex-1"><p className="font-medium">{m.name}</p><p className="text-xs text-ink-3">{m.email}</p></div><Badge tone="accent">{m.role}</Badge>{m.status !== 'ACTIVE' && <Badge tone="bad">deactivated</Badge>}<span className="hidden text-xs text-ink-3 sm:block">{m.lastLoginAt ? `seen ${timeAgo(m.lastLoginAt)}` : 'never signed in'}</span></li>)}</ul></Card></TabsContent>
        <TabsContent value="invoices" className="pt-4"><Card>{!d.invoices.length ? <p className="p-6 text-center text-xs text-ink-3">No invoices</p> : <ul className="divide-y divide-line">{d.invoices.map((i) => <li key={i.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]"><span className="font-medium">{i.number}</span><span className="min-w-0 flex-1 truncate text-ink-2">{i.description}</span><span className="text-xs text-ink-3">{fmtDate(i.issuedAt)}</span><span className="tnum font-medium">{money(i.amount, i.currency)}</span><Badge tone={i.status === 'PAID' ? 'ok' : i.status === 'OPEN' ? 'warn' : i.status === 'FAILED' ? 'bad' : 'neutral'}>{titleCase(i.status)}</Badge></li>)}</ul>}</Card></TabsContent>
        <TabsContent value="history" className="pt-4"><Card className="p-4"><ol className="space-y-3 border-l border-line pl-5">{d.events.map((e) => <li key={e.id} className="relative"><span className="absolute -left-[26px] top-1 size-2.5 rounded-full bg-accent" /><p className="text-[13px] font-medium">{titleCase(e.type)}{e.toPlanCode ? ` · ${e.fromPlanCode ? `${e.fromPlanCode} → ` : ''}${e.toPlanCode}` : ''}</p><p className="text-xs text-ink-3">{fmtDateTime(e.createdAt)}{e.note ? ` · ${e.note}` : ''}</p></li>)}</ol></Card></TabsContent>
        <TabsContent value="audit" className="pt-4"><Card><ul className="divide-y divide-line">{d.auditLogs.map((a) => <li key={a.id} className="flex items-center gap-3 px-4 py-2 text-[13px]"><code className="rounded bg-subtle px-1.5 text-xs">{a.action}</code><span className="flex-1 text-xs text-ink-3">{a.actorEmail ?? 'system'}</span><Badge>{a.scope.toLowerCase()}</Badge><span className="text-xs text-ink-3">{timeAgo(a.createdAt)}</span></li>)}</ul></Card></TabsContent>
      </Tabs>
      <p className="mt-4 text-xs text-ink-3">{d.privacy}</p>

      <Dialog open={suspend} onOpenChange={setSuspend} size="sm" title={`Suspend ${o.name}?`} description="All members lose access immediately. Data is retained." footer={<><Button onClick={() => setSuspend(false)}>Cancel</Button><Button variant="danger" loading={doSuspend.isPending} disabled={reason.trim().length < 3} onClick={() => doSuspend.mutate()}>Suspend organization</Button></>}>
        <div className="space-y-3"><FormError message={error} /><Field label="Reason" required hint="Recorded in the platform audit log."><Textarea aria-label="Suspension reason" value={reason} onChange={(e) => setReason(e.target.value)} /></Field></div>
      </Dialog>
      <Dialog open={adjust} onOpenChange={setAdjust} title="Adjust subscription" description="Manual changes are written to the subscription history and the platform audit log." footer={<><Button onClick={() => setAdjust(false)}>Cancel</Button><Button variant="primary" loading={doAdjust.isPending} onClick={() => doAdjust.mutate()}>Apply</Button></>}>
        <div className="space-y-4"><FormError message={error} />
          <div className="grid gap-3 sm:grid-cols-2"><Field label="Plan"><Select aria-label="Plan" value={adj.planCode} onChange={(e) => setAdj({ ...adj, planCode: e.target.value })}><option value="">Keep current ({s?.plan.name})</option>{plans.data?.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</Select></Field>
            <Field label="Billing cycle"><Select aria-label="Interval" value={adj.interval} onChange={(e) => setAdj({ ...adj, interval: e.target.value })}><option value="">Keep current</option><option value="MONTHLY">Monthly</option><option value="YEARLY">Yearly</option></Select></Field>
            <Field label="Status"><Select aria-label="Status" value={adj.status} onChange={(e) => setAdj({ ...adj, status: e.target.value })}><option value="">Keep current ({s?.status})</option>{['TRIALING', 'ACTIVE', 'PAST_DUE', 'EXPIRED', 'CANCELED'].map((x) => <option key={x} value={x}>{titleCase(x)}</option>)}</Select></Field>
            <Field label="Extend by (days)"><Input aria-label="Extend days" type="number" min={1} value={adj.extendDays} onChange={(e) => setAdj({ ...adj, extendDays: e.target.value })} /></Field></div>
          <Field label="Note"><Input aria-label="Note" value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} placeholder="Why is this adjustment being made?" /></Field></div>
      </Dialog>
    </>
  );
}
