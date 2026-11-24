'use client';
import * as React from 'react';
import Link from 'next/link';
import { Activity as ActivityIcon, ScrollText } from 'lucide-react';
import { ACTIVITY_LABELS } from '@leadflow/shared';
import { api } from '@/lib/api';
import { useOrg, useT } from '@/lib/session';
import { fmtDateTime, timeAgo } from '@/lib/format';
import { useUrlState } from '@/lib/use-url-state';
import { Input, Select } from '@/components/ui/form';
import { Avatar, Badge, Card, EmptyState, PageHeader, Pagination, Skeleton } from '@/components/ui/data';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/menu';
import { MemberSelect } from '@/components/filters';
import { useDebounced } from '@/lib/use-url-state';

const DEFAULTS = { type: '', actorId: '', from: '', to: '', page: '1', pageSize: '25', apage: '1', action: '' };
const TYPE_GROUPS: Array<[string, string]> = [['', 'All activity'], ['CALL,EMAIL,WHATSAPP,MEETING', 'Calls, emails & meetings'], ['NOTE', 'Notes'], ['LEAD_CREATED,LEAD_UPDATED,LEAD_ARCHIVED,LEAD_RESTORED,LEAD_MERGED,STATUS_CHANGED', 'Lead changes'], ['LEAD_ASSIGNED,LEAD_REASSIGNED', 'Assignments'], ['FOLLOWUP_SCHEDULED,FOLLOWUP_COMPLETED,FOLLOWUP_RESCHEDULED,FOLLOWUP_CANCELED', 'Follow-ups'], ['TASK_CREATED,TASK_COMPLETED', 'Tasks'], ['OPPORTUNITY_CREATED,STAGE_CHANGED,OPPORTUNITY_WON,OPPORTUNITY_LOST', 'Pipeline']];

function Inner() {
  const { can } = useOrg();
  const [f, setF] = useUrlState(DEFAULTS);
  const q = useT(['activity-feed', f], () => api.page<{ id: string; type: string; label: string; title: string; body: string | null; occurredAt: string; actor: { name: string } | null; lead: { id: string; name: string } | null }>('/activities', { type: f.type || undefined, actorId: f.actorId || undefined, from: f.from ? new Date(f.from).toISOString() : undefined, to: f.to ? new Date(`${f.to}T23:59:59`).toISOString() : undefined, page: Number(f.page), pageSize: Number(f.pageSize) }), { keep: true });
  const audit = useT(['audit', f.apage, f.action], () => api.page<{ id: string; action: string; entityType: string | null; metadata: Record<string, unknown>; actor: { name: string } | null; ip: string | null; createdAt: string }>('/audit-logs', { page: Number(f.apage), pageSize: 25, action: f.action || undefined }), { enabled: can('settings.manage'), keep: true });
  const [action, setAction] = React.useState(f.action);
  const da = useDebounced(action, 300);
  React.useEffect(() => { if (da !== f.action) setF({ action: da, apage: '1' }); }, [da]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <PageHeader title="Activity logs" description={can('activity.view_all') ? 'Everything that happened across the workspace.' : 'Activity on your leads and actions you took.'} />
      <Tabs defaultValue="activity">
        <TabsList><TabsTrigger value="activity">Activity</TabsTrigger>{can('settings.manage') && <TabsTrigger value="audit">Audit trail</TabsTrigger>}</TabsList>
        <TabsContent value="activity" className="pt-4">
          <Card>
            <div className="flex flex-wrap gap-2 border-b border-line p-3">
              <div className="w-[220px]"><Select aria-label="Activity type" value={f.type} onChange={(e) => setF({ type: e.target.value })}>{TYPE_GROUPS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}</Select></div>
              {can('activity.view_all') && <div className="w-[170px]"><MemberSelect aria-label="Actor" allowEmpty placeholder="Anyone" value={f.actorId} onChange={(v) => setF({ actorId: v })} /></div>}
              <Input type="date" aria-label="From" className="w-[140px]" value={f.from} onChange={(e) => setF({ from: e.target.value })} /><Input type="date" aria-label="To" className="w-[140px]" value={f.to} onChange={(e) => setF({ to: e.target.value })} />
            </div>
            {q.isLoading ? <div className="space-y-3 p-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div> : !q.data?.data.length ? <EmptyState icon={<ActivityIcon />} title="No activity found" description="Adjust the filters or log some activity on a lead." /> : (
              <ul className="divide-y divide-line">{q.data.data.map((a) => (
                <li key={a.id} className="flex items-start gap-3 px-4 py-3"><Avatar name={a.actor?.name ?? 'System'} size="sm" /><div className="min-w-0 flex-1"><p className="text-[13px]"><b>{a.actor?.name ?? 'System'}</b> <span className="text-ink-2">{a.title}</span>{a.lead && <> · <Link href={`/leads/${a.lead.id}`} className="font-medium text-accent-ink hover:underline">{a.lead.name}</Link></>}</p>{a.body && <p className="mt-0.5 line-clamp-2 text-xs text-ink-3">{a.body}</p>}</div><div className="text-right"><Badge>{a.label}</Badge><p className="mt-1 text-[11px] text-ink-3" title={fmtDateTime(a.occurredAt)}>{timeAgo(a.occurredAt)}</p></div></li>))}</ul>
            )}
            {(q.data?.meta.total ?? 0) > 0 && <Pagination page={Number(f.page)} pageSize={Number(f.pageSize)} total={q.data!.meta.total} noun="events" onPage={(p) => setF({ page: String(p) }, false)} />}
          </Card>
        </TabsContent>
        {can('settings.manage') && (
          <TabsContent value="audit" className="pt-4">
            <Card>
              <div className="border-b border-line p-3"><Input aria-label="Filter audit actions" placeholder="Filter by action, e.g. billing, role, lead.imported…" className="max-w-sm" value={action} onChange={(e) => setAction(e.target.value)} /></div>
              {!audit.data?.data.length ? <EmptyState icon={<ScrollText />} title="No audit entries" /> : (
                <div className="scroll-thin overflow-x-auto"><table className="w-full min-w-[620px] text-left text-[13px]"><thead><tr className="border-b border-line bg-subtle/60 text-[11px] font-medium uppercase tracking-wide text-ink-3"><th className="px-4 py-2">When</th><th className="px-4 py-2">Who</th><th className="px-4 py-2">Action</th><th className="px-4 py-2">Details</th></tr></thead>
                  <tbody className="divide-y divide-line">{audit.data.data.map((a) => <tr key={a.id}><td className="whitespace-nowrap px-4 py-2 text-xs text-ink-2">{fmtDateTime(a.createdAt)}</td><td className="px-4 py-2">{a.actor?.name ?? 'System'}</td><td className="px-4 py-2"><code className="rounded bg-subtle px-1.5 py-0.5 text-xs">{a.action}</code></td><td className="max-w-[320px] truncate px-4 py-2 text-xs text-ink-3">{Object.keys(a.metadata ?? {}).length ? JSON.stringify(a.metadata) : '—'}</td></tr>)}</tbody></table></div>
              )}
              {(audit.data?.meta.total ?? 0) > 0 && <Pagination page={Number(f.apage)} pageSize={25} total={audit.data!.meta.total} noun="entries" onPage={(p) => setF({ apage: String(p) }, false)} />}
            </Card>
          </TabsContent>
        )}
      </Tabs>
    </>
  );
}
export default function Page() { return <React.Suspense><Inner /></React.Suspense>; }
