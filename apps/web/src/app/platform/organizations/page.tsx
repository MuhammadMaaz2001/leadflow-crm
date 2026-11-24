'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Building2, Search } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { fmtDate, titleCase } from '@/lib/format';
import { useDebounced } from '@/lib/use-url-state';
import { Input, Select } from '@/components/ui/form';
import { Badge, Card, EmptyState, PageHeader, Pagination } from '@/components/ui/data';
import { DataTable, type Column } from '@/components/ui/table';

interface Org { id: string; name: string; slug: string; industry: string | null; status: string; createdAt: string; plan: { code: string; name: string } | null; subscriptionStatus: string | null; leads: number; seats: number; maxLeads: number; maxSeats: number }
export const subTone = (s?: string | null) => ({ ACTIVE: 'ok', TRIALING: 'info', PAST_DUE: 'warn', EXPIRED: 'bad', CANCELED: 'bad', SUSPENDED: 'bad' } as Record<string, 'ok' | 'info' | 'warn' | 'bad'>)[s ?? ''] ?? 'neutral';

export default function OrgsPage() {
  const router = useRouter();
  const [q, setQ] = React.useState(''); const dq = useDebounced(q);
  const [status, setStatus] = React.useState(''); const [plan, setPlan] = React.useState(''); const [page, setPage] = React.useState(1);
  const res = useQuery({ queryKey: ['platform', 'orgs', dq, status, plan, page], queryFn: () => api.page<Org>('/platform/organizations', { q: dq || undefined, status: status || undefined, plan: plan || undefined, page, pageSize: 25 }, ), placeholderData: (p) => p });
  const columns: Column<Org>[] = [
    { key: 'name', header: 'Organization', primary: true, cell: (o) => <div><p className="font-medium">{o.name}</p><p className="text-xs text-ink-3">{o.industry ?? o.slug}</p></div> },
    { key: 'status', header: 'Status', cell: (o) => <Badge tone={o.status === 'ACTIVE' ? 'ok' : 'bad'}>{titleCase(o.status)}</Badge> },
    { key: 'plan', header: 'Plan', cell: (o) => <span className="flex items-center gap-1.5">{o.plan?.name ?? '—'}{o.subscriptionStatus && <Badge tone={subTone(o.subscriptionStatus)}>{titleCase(o.subscriptionStatus)}</Badge>}</span> },
    { key: 'leads', header: 'Leads', className: 'text-right', hideBelow: 'md', cell: (o) => <span className="tnum">{o.leads.toLocaleString()} <span className="text-ink-3">/ {o.maxLeads.toLocaleString()}</span></span> },
    { key: 'seats', header: 'Seats', className: 'text-right', hideBelow: 'md', cell: (o) => <span className="tnum">{o.seats} <span className="text-ink-3">/ {o.maxSeats}</span></span> },
    { key: 'created', header: 'Registered', hideBelow: 'lg', cell: (o) => <span className="text-ink-2">{fmtDate(o.createdAt)}</span> },
  ];
  return (
    <>
      <PageHeader title="Organizations" count={res.data?.meta.total} description="Every registered workspace. Customer lead data is not visible here." />
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <div className="relative min-w-[200px] max-w-xs flex-1"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" /><Input aria-label="Search organizations" placeholder="Search name or slug…" className="pl-8" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div>
          <div className="w-36"><Select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">Any status</option><option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option></Select></div>
          <div className="w-36"><Select aria-label="Plan" value={plan} onChange={(e) => { setPlan(e.target.value); setPage(1); }}><option value="">Any plan</option><option value="free">Free</option><option value="starter">Starter</option><option value="professional">Professional</option></Select></div>
        </div>
        <DataTable columns={columns} rows={res.data?.data} loading={res.isLoading} onRowClick={(o) => router.push(`/platform/organizations/${o.id}`)} empty={<EmptyState icon={<Building2 />} title="No organizations match" />} />
        {(res.data?.meta.total ?? 0) > 0 && <Pagination page={page} pageSize={25} total={res.data!.meta.total} noun="organizations" onPage={setPage} />}
      </Card>
    </>
  );
}
