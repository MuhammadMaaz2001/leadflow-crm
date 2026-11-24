'use client';
import * as React from 'react';
import { Check, Pencil, Plus } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PLAN_FEATURES } from '@leadflow/shared';
import { api } from '@/lib/api';
import { errMsg, useMe } from '@/lib/session';
import { money } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, FormError, Input, Switch, Textarea } from '@/components/ui/form';
import { Badge, Card, PageHeader, Skeleton } from '@/components/ui/data';
import { Dialog, useConfirm } from '@/components/ui/overlay';

interface Plan { id: string; code: string; name: string; description: string | null; priceMonthly: number; priceYearly: number; trialDays: number; maxLeads: number; maxSeats: number; features: string[]; isPublic: boolean; isActive: boolean; sortOrder: number; subscribers: number }

function PlanDialog({ plan, onClose }: { plan: Plan | 'new'; onClose: () => void }) {
  const qc = useQueryClient();
  const p = plan === 'new' ? null : plan;
  const [f, setF] = React.useState({ code: p?.code ?? '', name: p?.name ?? '', description: p?.description ?? '', priceMonthly: String(p?.priceMonthly ?? 0), priceYearly: String(p?.priceYearly ?? 0), trialDays: String(p?.trialDays ?? 0), maxLeads: String(p?.maxLeads ?? 100), maxSeats: String(p?.maxSeats ?? 3), features: p?.features ?? [], isPublic: p?.isPublic ?? true, isActive: p?.isActive ?? true, sortOrder: String(p?.sortOrder ?? 10) });
  const [error, setError] = React.useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => { const body = { ...f, description: f.description || null, priceMonthly: Number(f.priceMonthly), priceYearly: Number(f.priceYearly), trialDays: Number(f.trialDays), maxLeads: Number(f.maxLeads), maxSeats: Number(f.maxSeats), sortOrder: Number(f.sortOrder) }; if (p) { const { code: _c, ...rest } = body; void _c; return api.patch(`/platform/plans/${p.id}`, rest); } return api.post('/platform/plans', body, { tenant: false }); },
    onSuccess: () => { toast.success('Plan saved'); qc.invalidateQueries({ queryKey: ['platform', 'plans'] }); onClose(); }, onError: (e) => setError(errMsg(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="lg" title={p ? `Edit ${p.name}` : 'New plan'} description="Limit and feature changes apply to existing subscribers immediately." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save plan</Button></>}>
      <div className="space-y-4"><FormError message={error} />
        <div className="grid gap-3 sm:grid-cols-3"><Field label="Code" required hint="Lowercase, immutable"><Input aria-label="Code" value={f.code} disabled={!!p} onChange={(e) => setF({ ...f, code: e.target.value.toLowerCase() })} /></Field><Field label="Name" required><Input aria-label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label="Sort order"><Input aria-label="Sort order" type="number" value={f.sortOrder} onChange={(e) => setF({ ...f, sortOrder: e.target.value })} /></Field></div>
        <Field label="Description"><Textarea aria-label="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} className="min-h-[56px]" /></Field>
        <div className="grid gap-3 sm:grid-cols-3"><Field label="Monthly price (USD)"><Input aria-label="Monthly price" type="number" min={0} step="0.01" value={f.priceMonthly} onChange={(e) => setF({ ...f, priceMonthly: e.target.value })} /></Field><Field label="Yearly price (USD)"><Input aria-label="Yearly price" type="number" min={0} step="0.01" value={f.priceYearly} onChange={(e) => setF({ ...f, priceYearly: e.target.value })} /></Field><Field label="Trial days"><Input aria-label="Trial days" type="number" min={0} value={f.trialDays} onChange={(e) => setF({ ...f, trialDays: e.target.value })} /></Field><Field label="Lead limit"><Input aria-label="Lead limit" type="number" min={1} value={f.maxLeads} onChange={(e) => setF({ ...f, maxLeads: e.target.value })} /></Field><Field label="Seat limit"><Input aria-label="Seat limit" type="number" min={1} value={f.maxSeats} onChange={(e) => setF({ ...f, maxSeats: e.target.value })} /></Field></div>
        <fieldset className="rounded-lg border border-line p-3"><legend className="px-1 text-xs font-semibold text-ink-2">Features</legend><div className="grid gap-2 sm:grid-cols-2">{PLAN_FEATURES.map((x) => <label key={x.key} className="flex items-center gap-2 text-[13px]"><Checkbox aria-label={x.label} checked={f.features.includes(x.key)} onCheckedChange={(v) => setF({ ...f, features: v ? [...f.features, x.key] : f.features.filter((k) => k !== x.key) })} />{x.label}</label>)}</div></fieldset>
        <div className="flex gap-6 text-[13px]"><label className="flex items-center gap-2"><Switch aria-label="Public" checked={f.isPublic} onCheckedChange={(v) => setF({ ...f, isPublic: v })} />Visible to customers</label><label className="flex items-center gap-2"><Switch aria-label="Active" checked={f.isActive} onCheckedChange={(v) => setF({ ...f, isActive: v })} />Available for new subscriptions</label></div>
      </div>
    </Dialog>
  );
}

export default function PlansPage() {
  const me = useMe(); const role = me.data?.user.platformRole; const canEdit = role === 'SUPER_ADMIN' || role === 'BILLING_ADMIN';
  const confirm = useConfirm(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['platform', 'plans'], queryFn: () => api.get<Plan[]>('/platform/plans', undefined, { tenant: false }) });
  const [edit, setEdit] = React.useState<Plan | 'new' | null>(null);
  const retire = useMutation({ mutationFn: (id: string) => api.del(`/platform/plans/${id}`), onSuccess: () => { toast.success('Plan retired'); qc.invalidateQueries({ queryKey: ['platform', 'plans'] }); }, onError: (e) => toast.error(errMsg(e)) });
  return (
    <>
      <PageHeader title="Subscription plans" description="Pricing, limits and feature flags that the backend enforces." actions={canEdit && <Button variant="primary" onClick={() => setEdit('new')}><Plus className="size-3.5" />New plan</Button>} />
      {q.isLoading ? <Skeleton className="h-72" /> : (
        <div className="grid gap-4 lg:grid-cols-3">{q.data?.map((p) => (
          <Card key={p.id} className="flex flex-col p-5">
            <div className="flex items-start justify-between"><div><h3 className="text-[15px] font-semibold">{p.name}</h3><code className="text-xs text-ink-3">{p.code}</code></div><div className="flex gap-1">{!p.isActive && <Badge tone="bad">Retired</Badge>}{!p.isPublic && <Badge>Hidden</Badge>}</div></div>
            <p className="mt-1 text-xs text-ink-2">{p.description}</p>
            <p className="tnum mt-3 text-2xl font-semibold">{money(p.priceMonthly, 'USD')}<span className="text-sm font-normal text-ink-3"> / mo</span></p><p className="text-xs text-ink-3">{money(p.priceYearly, 'USD')} / yr · {p.trialDays}-day trial</p>
            <ul className="mt-3 flex-1 space-y-1.5 text-[13px]"><li><b>{p.maxLeads.toLocaleString()}</b> leads · <b>{p.maxSeats}</b> seats</li>{p.features.map((f) => <li key={f} className="flex items-center gap-1.5 text-ink-2"><Check className="size-3.5 text-ok" />{PLAN_FEATURES.find((x) => x.key === f)?.label ?? f}</li>)}</ul>
            <div className="mt-4 flex items-center justify-between border-t border-line pt-3"><span className="text-xs text-ink-3">{p.subscribers} subscriber{p.subscribers === 1 ? '' : 's'}</span>{canEdit && <div className="flex gap-1.5"><Button size="sm" onClick={() => setEdit(p)}><Pencil className="size-3.5" />Edit</Button>{p.code !== 'free' && p.isActive && <Button size="sm" variant="dangerGhost" onClick={async () => { if (await confirm({ title: `Retire ${p.name}?`, description: 'Hidden for new subscriptions. Existing subscribers keep it.', confirmLabel: 'Retire', destructive: true })) retire.mutate(p.id); }}>Retire</Button>}</div>}</div>
          </Card>))}</div>
      )}
      {edit && <PlanDialog plan={edit} onClose={() => setEdit(null)} />}
    </>
  );
}
