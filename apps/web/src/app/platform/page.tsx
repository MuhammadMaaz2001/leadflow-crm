'use client';
import { Building2, CreditCard, FileWarning, Info, Users, Wallet } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { money, num } from '@/lib/format';
import { Card, CardHeader, PageHeader, Skeleton, StatCard } from '@/components/ui/data';
import { Donut, Legend2, TrendChart, PALETTE } from '@/components/charts';

interface Dash { organizations: { total: number; active: number; suspended: number; newLast30Days: number }; users: number; mrr: number; payingOrganizations: number; subscriptionsByStatus: Record<string, number>; planDistribution: Array<{ code: string; name: string; count: number }>; invoices: { open: { count: number; amount: number }; failed: { count: number; amount: number }; paidLast30Days: { count: number; amount: number } }; signups: Array<{ day: string; orgs: number }>; totals: { leads: number; opportunities: number; seats: number; note: string } }

export default function PlatformDashboard() {
  const q = useQuery({ queryKey: ['platform', 'dashboard'], queryFn: () => api.get<Dash>('/platform/dashboard', undefined, { tenant: false }) });
  const d = q.data;
  return (
    <>
      <PageHeader title="Platform overview" description="Health of the LeadFlow business across all organizations." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Organizations" value={num(d?.organizations.total)} hint={`${d?.organizations.active ?? 0} active · ${d?.organizations.suspended ?? 0} suspended`} icon={<Building2 />} loading={q.isLoading} />
        <StatCard label="New (30 days)" value={num(d?.organizations.newLast30Days)} icon={<Building2 />} tone="accent" loading={q.isLoading} />
        <StatCard label="Registered users" value={num(d?.users)} icon={<Users />} loading={q.isLoading} />
        <StatCard label="Monthly recurring revenue" value={money(d?.mrr ?? 0, 'USD')} hint={`${d?.payingOrganizations ?? 0} paying organizations`} icon={<Wallet />} tone="ok" loading={q.isLoading} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2"><CardHeader title="New organizations" description="Last 30 days" /><div className="px-2 pb-3 pt-2">{q.isLoading || !d ? <Skeleton className="m-3 h-[220px]" /> : <TrendChart height={220} data={d.signups.map((s) => ({ bucket: s.day, orgs: s.orgs }))} series={[{ key: 'orgs', name: 'Organizations', color: '#5558e3' }]} />}</div></Card>
        <Card><CardHeader title="Plan distribution" /><div className="px-4 pb-4">{d && <><Donut height={150} data={d.planDistribution.map((p, i) => ({ name: p.name, value: p.count, color: PALETTE[i % PALETTE.length] }))} center={<><span className="tnum text-xl font-semibold">{d.organizations.total}</span><span className="text-[10px] text-ink-3">orgs</span></>} /><div className="mt-3"><Legend2 items={d.planDistribution.map((p, i) => ({ name: p.name, value: p.count, color: PALETTE[i % PALETTE.length]! }))} /></div></>}</div></Card>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <Card className="p-4"><p className="flex items-center gap-1.5 text-xs font-medium text-ink-2"><FileWarning className="size-3.5 text-warn" />Open invoices</p><p className="tnum mt-1 text-2xl font-semibold">{d?.invoices.open.count ?? 0}</p><p className="text-xs text-ink-3">{money(d?.invoices.open.amount ?? 0, 'USD')} outstanding</p></Card>
        <Card className="p-4"><p className="flex items-center gap-1.5 text-xs font-medium text-ink-2"><FileWarning className="size-3.5 text-bad" />Failed payments</p><p className="tnum mt-1 text-2xl font-semibold">{d?.invoices.failed.count ?? 0}</p><p className="text-xs text-ink-3">{money(d?.invoices.failed.amount ?? 0, 'USD')} at risk</p></Card>
        <Card className="p-4"><p className="flex items-center gap-1.5 text-xs font-medium text-ink-2"><CreditCard className="size-3.5 text-ok" />Collected (30 days)</p><p className="tnum mt-1 text-2xl font-semibold">{money(d?.invoices.paidLast30Days.amount ?? 0, 'USD')}</p><p className="text-xs text-ink-3">{d?.invoices.paidLast30Days.count ?? 0} invoices recorded paid</p></Card>
      </div>
      <Card className="mt-4 p-4"><div className="flex items-start gap-3"><Info className="mt-0.5 size-4 text-ink-3" /><div><p className="text-[13px] font-medium">Platform-wide usage</p><p className="text-xs text-ink-2">{num(d?.totals.leads)} leads · {num(d?.totals.opportunities)} opportunities · {num(d?.totals.seats)} seats across all workspaces. {d?.totals.note}</p></div></div></Card>
    </>
  );
}
