'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CalendarCheck, CalendarClock, CalendarPlus, Check, Clock, History, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useOrg, useT } from '@/lib/session';
import { dueLabel, fmtDateTime, fmtRelativeDay, titleCase } from '@/lib/format';
import { PRIORITY_TONE } from '@/lib/lead-utils';
import { useUrlState } from '@/lib/use-url-state';
import { FOLLOWUP_OUTCOMES, FOLLOWUP_TYPES } from '@leadflow/shared';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/form';
import { Avatar, Badge, Card, EmptyState, PageHeader, Pagination, UserChip } from '@/components/ui/data';
import { DataTable, type Column } from '@/components/ui/table';
import { MemberSelect } from '@/components/filters';
import { followUpIcon } from '@/components/badges';
import { CalendarView, type CalEvent } from '@/components/calendar';
import { CancelFollowUpDialog, CompleteFollowUpDialog, RescheduleDialog, ScheduleFollowUpDialog } from '@/components/dialogs';

interface FU { id: string; type: string; dueAt: string; priority: string; notes: string | null; status: string; outcome: string | null; outcomeNotes: string | null; completedAt: string | null; isOverdue: boolean; rescheduleCount: number; lead: { id: string; name: string; companyName: string | null; phone: string | null }; assignedTo: { id: string; name: string } | null; completedBy: { name: string } | null }
const VIEWS = [['overdue', 'Overdue', AlertTriangle], ['today', 'Today', Clock], ['upcoming', 'Upcoming', CalendarClock], ['completed', 'Completed', Check], ['calendar', 'Calendar', CalendarCheck]] as const;
const DEFAULTS = { view: 'today', assignedToId: '', type: '', page: '1', pageSize: '25' };

function Inner() {
  const router = useRouter();
  const { can } = useOrg();
  const [f, setF] = useUrlState(DEFAULTS);
  const [schedule, setSchedule] = React.useState<Date | boolean>(false);
  const [complete, setComplete] = React.useState<FU | null>(null);
  const [resched, setResched] = React.useState<FU | null>(null);
  const [cancel, setCancel] = React.useState<FU | null>(null);
  const summary = useT(['followups-summary', f.assignedToId], () => api.get<{ overdue: number; dueToday: number; upcoming: number; completedToday: number }>('/followups/summary', { assignedToId: f.assignedToId || undefined }));
  const isCal = f.view === 'calendar';
  const q = useT(['followups', f], () => api.page<FU>('/followups', { view: f.view, assignedToId: f.assignedToId || undefined, type: f.type || undefined, page: Number(f.page), pageSize: Number(f.pageSize) }), { enabled: !isCal, keep: true });
  const counts: Record<string, number | undefined> = { overdue: summary.data?.overdue, today: summary.data?.dueToday, upcoming: summary.data?.upcoming, completed: summary.data?.completedToday };
  const total = q.data?.meta.total ?? 0;

  const columns: Column<FU>[] = [
    { key: 'type', header: 'Follow-up', primary: true, cell: (r) => <div className="flex items-center gap-3"><span className={cn('flex size-8 shrink-0 items-center justify-center rounded-full', r.isOverdue ? 'bg-bad-soft text-bad' : r.status === 'COMPLETED' ? 'bg-ok-soft text-ok' : 'bg-accent-soft text-accent')}>{followUpIcon(r.type)}</span><div className="min-w-0"><p className="font-medium">{titleCase(r.type)} <Badge tone={PRIORITY_TONE[r.priority]} className="ml-1">{titleCase(r.priority)}</Badge></p>{r.notes && <p className="max-w-[300px] truncate text-xs text-ink-3">{r.notes}</p>}</div></div> },
    { key: 'lead', header: 'Lead', cell: (r) => <Link href={`/leads/${r.lead.id}`} onClick={(e) => e.stopPropagation()} className="flex min-w-0 items-center gap-2 hover:underline"><Avatar name={r.lead.name} size="sm" /><span className="min-w-0"><span className="block truncate font-medium">{r.lead.name}</span><span className="block truncate text-xs text-ink-3">{r.lead.companyName ?? r.lead.phone ?? ''}</span></span></Link> },
    { key: 'due', header: 'Due', cell: (r) => <div><p className={cn(r.isOverdue && 'font-medium text-bad')}>{fmtRelativeDay(r.dueAt)}</p><p className={cn('text-xs', r.isOverdue ? 'text-bad' : 'text-ink-3')}>{r.status === 'PENDING' ? dueLabel(r.dueAt) : r.status === 'COMPLETED' ? `${titleCase(r.outcome ?? '')} · ${fmtDateTime(r.completedAt)}` : 'Canceled'}{r.rescheduleCount ? ` · rescheduled ${r.rescheduleCount}×` : ''}</p></div> },
    { key: 'owner', header: 'Owner', hideBelow: 'md', cell: (r) => <UserChip user={r.assignedTo} /> },
    { key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right', mobileLabel: '', cell: (r) => r.status === 'PENDING' && can('followups.manage') ? (
      <div className="flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}><Button size="sm" variant="primary" onClick={() => setComplete(r)}><Check className="size-3.5" />Complete</Button><Button size="sm" onClick={() => setResched(r)}>Reschedule</Button><Button size="sm" variant="ghost" onClick={() => setCancel(r)}>Cancel</Button></div>
    ) : r.status === 'COMPLETED' ? <Badge tone="ok">Completed</Badge> : <Badge tone="bad">Canceled</Badge> },
  ];
  const openEvent = (e: CalEvent) => { if (e.leadId) router.push(`/leads/${e.leadId}`); };

  return (
    <>
      <PageHeader title="Follow-ups" description="Scheduled conversations, with owners, due dates and recorded outcomes." actions={can('followups.manage') && <Button variant="primary" onClick={() => setSchedule(true)}><CalendarPlus className="size-3.5" />Schedule follow-up</Button>} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[['overdue', 'Overdue', summary.data?.overdue, 'text-bad'], ['today', 'Due today', summary.data?.dueToday, 'text-warn'], ['upcoming', 'Next 7 days', summary.data?.upcoming, 'text-info'], ['completed', 'Completed today', summary.data?.completedToday, 'text-ok']].map(([v, l, n, tone]) => (
          <button key={String(v)} type="button" onClick={() => setF({ view: String(v) })} className={cn('rounded-xl border bg-surface p-3.5 text-left shadow-card transition-colors hover:border-line-strong', f.view === v ? 'border-accent ring-1 ring-accent/30' : 'border-line')}>
            <p className="text-xs font-medium text-ink-2">{l as string}</p><p className={cn('tnum mt-1 text-2xl font-semibold', Number(n) > 0 ? (tone as string) : 'text-ink')}>{n === undefined ? '–' : String(n)}</p>
          </button>
        ))}
      </div>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 pt-2">
          <div role="tablist" aria-label="Follow-up views" className="flex gap-1 overflow-x-auto">
            {VIEWS.map(([v, l, Icon]) => <button key={v} role="tab" aria-selected={f.view === v} onClick={() => setF({ view: v })} className={cn('-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium', f.view === v ? 'border-accent text-ink' : 'border-transparent text-ink-2 hover:text-ink')}><Icon className="size-3.5" />{l}{counts[v] ? <span className="tnum rounded-full bg-subtle px-1.5 text-[10px]">{counts[v]}</span> : null}</button>)}
            <button role="tab" aria-selected={f.view === 'all'} onClick={() => setF({ view: 'all' })} className={cn('-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium', f.view === 'all' ? 'border-accent text-ink' : 'border-transparent text-ink-2 hover:text-ink')}><History className="size-3.5" />History</button>
          </div>
          <div className="mb-2 flex gap-2">
            {can('followups.view_all') && <div className="w-[160px]"><MemberSelect aria-label="Owner filter" allowEmpty placeholder="All owners" value={f.assignedToId} onChange={(v) => setF({ assignedToId: v })} /></div>}
            {!isCal && <div className="w-[130px]"><Select aria-label="Type filter" value={f.type} onChange={(e) => setF({ type: e.target.value })}><option value="">All types</option>{FOLLOWUP_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select></div>}
          </div>
        </div>
        {isCal ? <div className="p-4"><CalendarView kinds="followup" assignedToId={f.assignedToId || undefined} onOpen={openEvent} onCreate={can('followups.manage') ? (d) => setSchedule(d) : undefined} /></div> : (
          <>
            <DataTable columns={columns} rows={q.data?.data} loading={q.isLoading} error={q.error} onRetry={() => q.refetch()} onRowClick={(r) => router.push(`/leads/${r.lead.id}`)}
              empty={<EmptyState icon={f.view === 'overdue' ? <Check /> : <CalendarCheck />} title={f.view === 'overdue' ? 'Nothing overdue — nice work' : f.view === 'today' ? 'No follow-ups due today' : 'No follow-ups here'} description="Schedule a follow-up from any lead to keep deals moving." action={can('followups.manage') ? <Button variant="primary" onClick={() => setSchedule(true)}><Plus className="size-3.5" />Schedule follow-up</Button> : undefined} />} />
            {total > 0 && <Pagination page={Number(f.page)} pageSize={Number(f.pageSize)} total={total} noun="follow-ups" onPage={(p) => setF({ page: String(p) }, false)} onPageSize={(n) => setF({ pageSize: String(n) })} />}
          </>
        )}
      </Card>
      <ScheduleFollowUpDialog open={!!schedule} onOpenChange={(o) => !o && setSchedule(false)} />
      <CompleteFollowUpDialog followUp={complete ? { id: complete.id, type: complete.type, lead: { name: complete.lead.name } } : null} onOpenChange={(o) => !o && setComplete(null)} />
      <RescheduleDialog followUp={resched} onOpenChange={(o) => !o && setResched(null)} />
      <CancelFollowUpDialog followUp={cancel} onOpenChange={(o) => !o && setCancel(null)} />
    </>
  );
}
void FOLLOWUP_OUTCOMES;
export default function Page() { return <React.Suspense><Inner /></React.Suspense>; }
