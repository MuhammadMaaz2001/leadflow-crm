'use client';
import * as React from 'react';
import { ScrollText } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useDebounced } from '@/lib/use-url-state';
import { Input, Select } from '@/components/ui/form';
import { Badge, Card, EmptyState, PageHeader, Pagination } from '@/components/ui/data';

interface L { id: string; scope: string; action: string; entityType: string | null; actorEmail: string | null; organization: string | null; metadata: Record<string, unknown>; createdAt: string }

export default function AuditPage() {
  const [scope, setScope] = React.useState('ALL'); const [action, setAction] = React.useState(''); const da = useDebounced(action); const [page, setPage] = React.useState(1);
  const q = useQuery({ queryKey: ['platform', 'audit', scope, da, page], queryFn: () => api.page<L>('/platform/audit-logs', { scope, action: da || undefined, page, pageSize: 30 }), placeholderData: (p) => p });
  return (
    <>
      <PageHeader title="Platform audit logs" description="Sensitive operations by platform administrators and by workspace users." />
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-line p-3"><div className="w-40"><Select aria-label="Scope" value={scope} onChange={(e) => { setScope(e.target.value); setPage(1); }}><option value="ALL">All logs</option><option value="PLATFORM">Platform actions</option><option value="TENANT">Workspace actions</option></Select></div><Input aria-label="Filter by action" placeholder="Filter action, e.g. invoice, suspended…" className="max-w-xs" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} /></div>
        {!q.data?.data.length ? <EmptyState icon={<ScrollText />} title="No log entries" /> : (
          <div className="scroll-thin overflow-x-auto"><table className="w-full min-w-[720px] text-left text-[13px]"><thead><tr className="border-b border-line bg-subtle/60 text-[11px] font-medium uppercase tracking-wide text-ink-3"><th className="px-4 py-2">When</th><th className="px-4 py-2">Actor</th><th className="px-4 py-2">Action</th><th className="px-4 py-2">Organization</th><th className="px-4 py-2">Details</th></tr></thead>
            <tbody className="divide-y divide-line">{q.data.data.map((l) => <tr key={l.id}><td className="whitespace-nowrap px-4 py-2 text-xs text-ink-2">{fmtDateTime(l.createdAt)}</td><td className="px-4 py-2 text-xs">{l.actorEmail ?? 'system'}</td><td className="px-4 py-2"><Badge tone={l.scope === 'PLATFORM' ? 'warn' : 'neutral'}>{l.scope.toLowerCase()}</Badge> <code className="ml-1 rounded bg-subtle px-1.5 py-0.5 text-xs">{l.action}</code></td><td className="px-4 py-2 text-xs">{l.organization ?? '—'}</td><td className="max-w-[300px] truncate px-4 py-2 text-xs text-ink-3">{Object.keys(l.metadata ?? {}).length ? JSON.stringify(l.metadata) : '—'}</td></tr>)}</tbody></table></div>
        )}
        {(q.data?.meta.total ?? 0) > 0 && <Pagination page={page} pageSize={30} total={q.data!.meta.total} noun="entries" onPage={setPage} />}
      </Card>
    </>
  );
}
