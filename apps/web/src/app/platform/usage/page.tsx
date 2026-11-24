'use client';
import * as React from 'react';
import { Gauge } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Card, EmptyState, PageHeader, Pagination } from '@/components/ui/data';
import { DataTable, type Column } from '@/components/ui/table';

interface U { id: string; name: string; plan: string | null; leads: number; maxLeads: number; seats: number; maxSeats: number; opportunities: number; leadUtilization: number; seatUtilization: number }
const Bar = ({ v }: { v: number }) => <div className="flex items-center gap-2"><div className="h-1.5 w-24 overflow-hidden rounded-full bg-subtle"><div className={cn('h-full rounded-full', v >= 100 ? 'bg-bad' : v >= 80 ? 'bg-warn' : 'bg-accent')} style={{ width: `${Math.min(100, v)}%` }} /></div><span className="tnum w-9 text-xs text-ink-2">{v}%</span></div>;

export default function UsagePage() {
  const [page, setPage] = React.useState(1);
  const q = useQuery({ queryKey: ['platform', 'usage', page], queryFn: () => api.page<U>('/platform/usage', { page, pageSize: 25 }), placeholderData: (p) => p });
  const columns: Column<U>[] = [
    { key: 'name', header: 'Organization', primary: true, cell: (u) => <span className="font-medium">{u.name}</span> },
    { key: 'plan', header: 'Plan', cell: (u) => u.plan ?? '—' },
    { key: 'leads', header: 'Leads', cell: (u) => <div><span className="tnum text-[13px]">{u.leads.toLocaleString()} / {u.maxLeads.toLocaleString()}</span><Bar v={u.leadUtilization} /></div> },
    { key: 'seats', header: 'Seats', cell: (u) => <div><span className="tnum text-[13px]">{u.seats} / {u.maxSeats}</span><Bar v={u.seatUtilization} /></div> },
    { key: 'opps', header: 'Opportunities', className: 'text-right', hideBelow: 'md', cell: (u) => <span className="tnum">{u.opportunities.toLocaleString()}</span> },
  ];
  return (
    <>
      <PageHeader title="Usage statistics" description="Lead and seat consumption against plan limits. Organizations nearest their limits appear first." />
      <Card><DataTable columns={columns} rows={q.data?.data} loading={q.isLoading} empty={<EmptyState icon={<Gauge />} title="No usage yet" />} />{(q.data?.meta.total ?? 0) > 0 && <Pagination page={page} pageSize={25} total={q.data!.meta.total} noun="organizations" onPage={setPage} />}</Card>
    </>
  );
}
