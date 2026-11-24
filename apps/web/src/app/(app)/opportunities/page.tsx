'use client';
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { GitBranch, Handshake, Plus, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { useMembers, usePipelines } from '@/lib/hooks';
import { useOrg, useT } from '@/lib/session';
import { fmtDate, money, timeAgo } from '@/lib/format';
import { useDebounced, useUrlState } from '@/lib/use-url-state';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/form';
import { Badge, Card, EmptyState, PageHeader, Pagination, UserChip } from '@/components/ui/data';
import { DataTable, type Column } from '@/components/ui/table';
import { OpportunityDialog } from '@/components/dialogs';
import { OpportunitySheet, type Opp } from '@/components/opportunity-sheet';

const DEFAULTS = { q: '', pipelineId: '', stageId: '', status: '', ownerId: '', sort: 'createdAt', order: 'desc', page: '1', pageSize: '25' };

function Inner() {
  const router = useRouter();
  const params = useSearchParams();
  const { can, currency } = useOrg();
  const [f, setF] = useUrlState(DEFAULTS);
  const [search, setSearch] = React.useState(f.q);
  const ds = useDebounced(search, 300);
  React.useEffect(() => { if (ds !== f.q) setF({ q: ds }); }, [ds]); // eslint-disable-line react-hooks/exhaustive-deps
  const [openId, setOpenId] = React.useState<string | null>(params.get('open'));
  const [newOpen, setNewOpen] = React.useState(false);
  const pipelines = usePipelines();
  const members = useMembers(can('opportunities.view_all'));
  const stages = pipelines.data?.find((p) => p.id === f.pipelineId)?.stages ?? pipelines.data?.flatMap((p) => p.stages) ?? [];
  const q = useT(['opportunities', f], () => api.page<Opp>('/opportunities', { q: f.q || undefined, pipelineId: f.pipelineId || undefined, stageId: f.stageId || undefined, status: f.status || undefined, ownerId: f.ownerId || undefined, sort: f.sort, order: f.order, page: Number(f.page), pageSize: Number(f.pageSize) }), { keep: true });
  const total = q.data?.meta.total ?? 0;
  const columns: Column<Opp>[] = [
    { key: 'name', header: 'Opportunity', sortable: true, primary: true, cell: (o) => <div className="min-w-0"><p className="truncate font-medium">{o.name}</p><p className="truncate text-xs text-ink-3">{o.lead.name}{o.lead.companyName ? ` · ${o.lead.companyName}` : ''}</p></div> },
    { key: 'stage', header: 'Stage', cell: (o) => <Badge dot={o.stage.color}>{o.stage.name}</Badge> },
    { key: 'status', header: 'Status', hideBelow: 'md', cell: (o) => <Badge tone={o.status === 'WON' ? 'ok' : o.status === 'LOST' ? 'bad' : 'neutral'}>{o.status === 'OPEN' ? 'Open' : o.status === 'WON' ? 'Won' : 'Lost'}</Badge> },
    { key: 'value', header: 'Value', sortable: true, className: 'text-right', cell: (o) => <span className="tnum font-medium">{money(o.value, currency)}</span> },
    { key: 'expectedCloseDate', header: 'Expected close', sortable: true, hideBelow: 'md', cell: (o) => <span className={o.status === 'OPEN' && o.expectedCloseDate && new Date(o.expectedCloseDate) < new Date() ? 'text-bad' : 'text-ink-2'}>{fmtDate(o.expectedCloseDate)}</span> },
    { key: 'owner', header: 'Owner', hideBelow: 'sm', cell: (o) => <UserChip user={o.owner} /> },
    { key: 'createdAt', header: 'Created', sortable: true, hideBelow: 'lg', cell: (o) => <span className="text-ink-2">{timeAgo(o.createdAt)}</span> },
  ];
  return (
    <>
      <PageHeader title="Opportunities" count={q.data ? total : undefined} description={q.data?.meta.totalValue !== undefined ? `${money(Number(q.data.meta.totalValue), currency)} total value in this view` : 'Every deal across your pipelines.'}
        actions={<><Button onClick={() => router.push('/pipeline')}><GitBranch className="size-3.5" />Board view</Button>{can('opportunities.manage') && <Button variant="primary" onClick={() => setNewOpen(true)}><Plus className="size-3.5" />New opportunity</Button>}</>} />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <div className="relative min-w-[200px] max-w-xs flex-1"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search deals, leads, companies…" aria-label="Search opportunities" className="pl-8" /></div>
          {(pipelines.data?.length ?? 0) > 1 && <div className="w-[170px]"><Select aria-label="Pipeline" value={f.pipelineId} onChange={(e) => setF({ pipelineId: e.target.value, stageId: '' })}><option value="">All pipelines</option>{pipelines.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></div>}
          <div className="w-[160px]"><Select aria-label="Stage" value={f.stageId} onChange={(e) => setF({ stageId: e.target.value })}><option value="">All stages</option>{stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></div>
          <div className="w-[130px]"><Select aria-label="Status" value={f.status} onChange={(e) => setF({ status: e.target.value })}><option value="">Any status</option><option value="OPEN">Open</option><option value="WON">Won</option><option value="LOST">Lost</option></Select></div>
          {can('opportunities.view_all') && <div className="w-[160px]"><Select aria-label="Owner" value={f.ownerId} onChange={(e) => setF({ ownerId: e.target.value })}><option value="">All owners</option>{members.data?.filter((m) => m.status === 'ACTIVE').map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</Select></div>}
        </div>
        <DataTable columns={columns} rows={q.data?.data} loading={q.isLoading} onRowClick={(o) => setOpenId(o.id)} sort={{ key: f.sort, order: f.order as 'asc' | 'desc' }} onSort={(k) => setF({ sort: k, order: f.sort === k && f.order === 'desc' ? 'asc' : 'desc' })}
          empty={<EmptyState icon={<Handshake />} title="No opportunities found" description="Create an opportunity from a lead when it becomes a real deal." action={can('opportunities.manage') ? <Button variant="primary" onClick={() => setNewOpen(true)}><Plus className="size-3.5" />New opportunity</Button> : undefined} />} />
        {total > 0 && <Pagination page={Number(f.page)} pageSize={Number(f.pageSize)} total={total} noun="opportunities" onPage={(p) => setF({ page: String(p) }, false)} onPageSize={(n) => setF({ pageSize: String(n) })} />}
      </Card>
      <OpportunitySheet id={openId} onClose={() => setOpenId(null)} />
      <OpportunityDialog open={newOpen} onOpenChange={setNewOpen} />
    </>
  );
}
export default function Page() { return <React.Suspense><Inner /></React.Suspense>; }
