'use client';
import * as React from 'react';
import Link from 'next/link';
import { Receipt } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { fmtDate, titleCase } from '@/lib/format';
import { Select } from '@/components/ui/form';
import { Badge, Card, EmptyState, PageHeader, Pagination } from '@/components/ui/data';
import { DataTable, type Column } from '@/components/ui/table';
import { subTone } from '../organizations/page';

interface S { id: string; organization: { id: string; name: string; status: string }; plan: { code: string; name: string }; interval: string; status: string; trialEndsAt: string | null; currentPeriodEnd: string; graceEndsAt: string | null; cancelAtPeriodEnd: boolean }

export default function SubscriptionsPage() {
  const [status, setStatus] = React.useState(''); const [plan, setPlan] = React.useState(''); const [page, setPage] = React.useState(1);
  const q = useQuery({ queryKey: ['platform', 'subs', status, plan, page], queryFn: () => api.page<S>('/platform/subscriptions', { status: status || undefined, plan: plan || undefined, page, pageSize: 25 }), placeholderData: (p) => p });
  const columns: Column<S>[] = [
    { key: 'org', header: 'Organization', primary: true, cell: (s) => <Link href={`/platform/organizations/${s.organization.id}`} className="font-medium text-accent-ink hover:underline">{s.organization.name}</Link> },
    { key: 'plan', header: 'Plan', cell: (s) => `${s.plan.name} · ${titleCase(s.interval)}` },
    { key: 'status', header: 'Status', cell: (s) => <span className="flex gap-1"><Badge tone={subTone(s.status)}>{titleCase(s.status)}</Badge>{s.cancelAtPeriodEnd && <Badge>Cancels at end</Badge>}{s.organization.status === 'SUSPENDED' && <Badge tone="bad">Suspended</Badge>}</span> },
    { key: 'end', header: 'Period / trial ends', hideBelow: 'md', cell: (s) => fmtDate(s.trialEndsAt ?? s.currentPeriodEnd) },
    { key: 'grace', header: 'Grace ends', hideBelow: 'lg', cell: (s) => s.graceEndsAt ? <span className="text-warn">{fmtDate(s.graceEndsAt)}</span> : '—' },
  ];
  return (
    <>
      <PageHeader title="Subscriptions" count={q.data?.meta.total} description="Monitor trials, renewals, grace periods and expirations." />
      <Card>
        <div className="flex gap-2 border-b border-line p-3"><div className="w-40"><Select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">Any status</option>{['TRIALING', 'ACTIVE', 'PAST_DUE', 'EXPIRED', 'CANCELED'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select></div><div className="w-40"><Select aria-label="Plan" value={plan} onChange={(e) => { setPlan(e.target.value); setPage(1); }}><option value="">Any plan</option><option value="free">Free</option><option value="starter">Starter</option><option value="professional">Professional</option></Select></div></div>
        <DataTable columns={columns} rows={q.data?.data} loading={q.isLoading} error={q.error} onRetry={() => q.refetch()} empty={<EmptyState icon={<Receipt />} title="No subscriptions" />} />
        {(q.data?.meta.total ?? 0) > 0 && <Pagination page={page} pageSize={25} total={q.data!.meta.total} noun="subscriptions" onPage={setPage} />}
      </Card>
    </>
  );
}
