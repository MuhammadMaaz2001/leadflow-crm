'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, ClipboardCheck, MessageSquare, Pencil, Plus, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { useAct, useOrg, useT } from '@/lib/session';
import { fmtDateTime, fmtRelativeDay, timeAgo } from '@/lib/format';
import { PRIORITY_TONE, TASK_STATUS_META } from '@/lib/lead-utils';
import { useUrlState } from '@/lib/use-url-state';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/form';
import { Avatar, Badge, Card, EmptyState, PageHeader, Pagination, Skeleton, UserChip } from '@/components/ui/data';
import { Sheet } from '@/components/ui/overlay';
import { DataTable, type Column } from '@/components/ui/table';
import { MemberSelect } from '@/components/filters';
import { CalendarView, type CalEvent } from '@/components/calendar';
import { CompleteFollowUpDialog, TaskDialog, type TaskEditable } from '@/components/dialogs';
import { TASK_STATUSES } from '@leadflow/shared';

interface Task extends TaskEditable { status: string; isOverdue: boolean; isAutomated: boolean; commentCount: number; assignedTo: { id: string; name: string } | null; createdBy: { name: string } | null; completedBy: { name: string } | null; completedAt: string | null; lead: { id: string; name: string } | null; opportunity: { id: string; name: string } | null }
interface TaskFull extends Task { comments: Array<{ id: string; body: string; author: { name: string } | null; createdAt: string }> }

function TaskSheet({ id, onClose, onEdit }: { id: string | null; onClose: () => void; onEdit: (t: Task) => void }) {
  const { can } = useOrg();
  const q = useT(['task', id], () => api.get<TaskFull>(`/tasks/${id}`), { enabled: !!id });
  const [comment, setComment] = React.useState('');
  const setStatus = useAct((status: string) => api.patch(`/tasks/${id}`, { status }), { success: 'Task updated' });
  const add = useAct(() => api.post(`/tasks/${id}/comments`, { body: comment }), { onSuccess: () => setComment(''), invalidate: ['task', 'tasks'] });
  const t = q.data;
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()} title={t?.title ?? 'Task'} description={t ? `Created by ${t.createdBy?.name ?? "system"}` : undefined}>
      {!t ? <Skeleton className="h-40" /> : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2"><Badge tone={TASK_STATUS_META[t.status]?.tone}>{TASK_STATUS_META[t.status]?.label}</Badge><Badge tone={PRIORITY_TONE[t.priority]}>{t.priority.toLowerCase()} priority</Badge>{t.isOverdue && <Badge tone="bad">Overdue</Badge>}{t.isAutomated && <Badge>Automated</Badge>}</div>
          {t.description && <p className="whitespace-pre-wrap text-[13px] text-ink-2">{t.description}</p>}
          <dl className="divide-y divide-line rounded-lg border border-line px-3 text-[13px]">
            <div className="flex justify-between py-2"><dt className="text-ink-3">Deadline</dt><dd className={cn(t.isOverdue && 'text-bad')}>{t.dueAt ? fmtDateTime(t.dueAt) : 'None'}</dd></div>
            <div className="flex justify-between py-2"><dt className="text-ink-3">Assigned to</dt><dd><UserChip user={t.assignedTo} /></dd></div>
            {t.lead && <div className="flex justify-between py-2"><dt className="text-ink-3">Lead</dt><dd><Link className="text-accent-ink hover:underline" href={`/leads/${t.lead.id}`}>{t.lead.name}</Link></dd></div>}
            {t.opportunity && <div className="flex justify-between py-2"><dt className="text-ink-3">Opportunity</dt><dd><Link className="text-accent-ink hover:underline" href={`/opportunities?open=${t.opportunity.id}`}>{t.opportunity.name}</Link></dd></div>}
            {t.completedAt && <div className="flex justify-between py-2"><dt className="text-ink-3">Completed</dt><dd>{fmtDateTime(t.completedAt)} by {t.completedBy?.name}</dd></div>}
          </dl>
          {can('tasks.manage') && (
            <div className="flex flex-wrap gap-2">
              {t.status !== 'DONE' ? <Button variant="primary" size="sm" onClick={() => setStatus.mutate('DONE')}><Check className="size-3.5" />Mark done</Button> : <Button size="sm" onClick={() => setStatus.mutate('TODO')}>Reopen</Button>}
              {t.status === 'TODO' && <Button size="sm" onClick={() => setStatus.mutate('IN_PROGRESS')}>Start</Button>}
              <Button size="sm" onClick={() => onEdit(t)}><Pencil className="size-3.5" />Edit</Button>
              {t.status !== 'CANCELED' && <Button size="sm" variant="dangerGhost" onClick={() => setStatus.mutate('CANCELED')}>Cancel task</Button>}
            </div>
          )}
          <div>
            <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold"><MessageSquare className="size-3.5" />Comments ({t.comments.length})</h3>
            <ul className="space-y-3">{t.comments.map((c) => <li key={c.id} className="flex gap-2.5"><Avatar name={c.author?.name} size="sm" /><div className="min-w-0 flex-1 rounded-lg bg-subtle px-3 py-2"><p className="text-xs"><b>{c.author?.name}</b> <span className="text-ink-3">· {timeAgo(c.createdAt)}</span></p><p className="mt-0.5 whitespace-pre-wrap text-[13px] text-ink-2">{c.body}</p></div></li>)}</ul>
            {can('tasks.manage') && (
              <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (comment.trim()) add.mutate(); }}>
                <Textarea aria-label="Add a comment" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Write a comment…" className="min-h-[40px]" />
                <Button type="submit" variant="primary" size="icon" aria-label="Post comment" loading={add.isPending} disabled={!comment.trim()}><Send className="size-4" /></Button>
              </form>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
}

const TABS = [['mine', 'My tasks'], ['team', 'Team tasks'], ['overdue', 'Overdue'], ['completed', 'Completed'], ['calendar', 'Calendar']] as const;
const DEFAULTS = { scope: 'mine', assignedToId: '', priority: '', status: '', q: '', page: '1', pageSize: '25' };

function Inner() {
  const { can } = useOrg();
  const router = useRouter();
  const [f, setF] = useUrlState(DEFAULTS);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<Task | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [fuOpen, setFuOpen] = React.useState<{ id: string; type: string; lead: { name: string } } | null>(null);
  const tabs = TABS.filter(([v]) => v !== 'team' || can('tasks.view_all'));
  const isCal = f.scope === 'calendar';
  const q = useT(['tasks', f], () => api.page<Task>('/tasks', { scope: f.scope, assignedToId: f.assignedToId || undefined, priority: f.priority || undefined, status: f.status || undefined, q: f.q || undefined, page: Number(f.page), pageSize: Number(f.pageSize) }), { enabled: !isCal, keep: true });
  const toggle = useAct((t: Task) => api.patch(`/tasks/${t.id}`, { status: t.status === 'DONE' ? 'TODO' : 'DONE' }), { success: 'Task updated' });
  const total = q.data?.meta.total ?? 0;

  const columns: Column<Task>[] = [
    { key: 'title', header: 'Task', primary: true, cell: (t) => (
      <div className="flex items-center gap-3"><button aria-label={t.status === 'DONE' ? `Reopen ${t.title}` : `Complete ${t.title}`} disabled={!can('tasks.manage')} onClick={(e) => { e.stopPropagation(); toggle.mutate(t); }} className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors', t.status === 'DONE' ? 'border-ok bg-ok text-white' : 'border-line-strong hover:border-accent')}>{t.status === 'DONE' && <Check className="size-3" />}</button>
        <div className="min-w-0"><p className={cn('truncate font-medium', t.status === 'DONE' && 'text-ink-3 line-through')}>{t.title}{t.isAutomated && <Badge className="ml-2">Auto</Badge>}</p>{t.lead && <p className="truncate text-xs text-ink-3">{t.lead.name}</p>}</div></div>) },
    { key: 'status', header: 'Status', hideBelow: 'md', cell: (t) => <Badge tone={TASK_STATUS_META[t.status]?.tone}>{TASK_STATUS_META[t.status]?.label}</Badge> },
    { key: 'priority', header: 'Priority', hideBelow: 'md', cell: (t) => <Badge tone={PRIORITY_TONE[t.priority]}>{t.priority.toLowerCase()}</Badge> },
    { key: 'due', header: 'Deadline', cell: (t) => t.dueAt ? <span className={cn(t.isOverdue ? 'font-medium text-bad' : 'text-ink-2')}>{fmtRelativeDay(t.dueAt)}</span> : <span className="text-ink-3">—</span> },
    { key: 'assignee', header: 'Assignee', hideBelow: 'sm', cell: (t) => <UserChip user={t.assignedTo} /> },
    { key: 'comments', header: '', hideBelow: 'lg', cell: (t) => t.commentCount ? <span className="inline-flex items-center gap-1 text-xs text-ink-3"><MessageSquare className="size-3" />{t.commentCount}</span> : null },
  ];
  const openEvent = (e: CalEvent) => { if (e.kind === 'task') setOpenId(e.id); else if (e.leadId) router.push(`/leads/${e.leadId}`); };

  return (
    <>
      <PageHeader title="Tasks & Calendar" description="Work to be done, plus every follow-up and deadline on one calendar." actions={can('tasks.manage') && <Button variant="primary" onClick={() => setCreating(true)}><Plus className="size-3.5" />New task</Button>} />
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 pt-2">
          <div role="tablist" aria-label="Task views" className="flex gap-1 overflow-x-auto">{tabs.map(([v, l]) => <button key={v} role="tab" aria-selected={f.scope === v} onClick={() => setF({ scope: v })} className={cn('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium', f.scope === v ? 'border-accent text-ink' : 'border-transparent text-ink-2 hover:text-ink')}>{l}</button>)}</div>
          {!isCal && (
            <div className="mb-2 flex flex-wrap gap-2">
              <Input aria-label="Search tasks" placeholder="Search tasks…" className="w-[170px]" value={f.q} onChange={(e) => setF({ q: e.target.value })} />
              {(f.scope === 'team' || f.scope === 'overdue') && can('tasks.view_all') && <div className="w-[150px]"><MemberSelect aria-label="Assignee filter" allowEmpty placeholder="Anyone" value={f.assignedToId} onChange={(v) => setF({ assignedToId: v })} /></div>}
              <div className="w-[120px]"><Select aria-label="Priority filter" value={f.priority} onChange={(e) => setF({ priority: e.target.value })}><option value="">Any priority</option><option value="HIGH">High</option><option value="MEDIUM">Medium</option><option value="LOW">Low</option></Select></div>
              {f.scope === 'team' && <div className="w-[130px]"><Select aria-label="Status filter" value={f.status} onChange={(e) => setF({ status: e.target.value })}><option value="">Open</option>{TASK_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select></div>}
            </div>
          )}
        </div>
        {isCal ? <div className="p-4"><CalendarView onOpen={openEvent} onCreate={can('tasks.manage') ? () => setCreating(true) : undefined} /></div> : (
          <>
            <DataTable columns={columns} rows={q.data?.data} loading={q.isLoading} onRowClick={(t) => setOpenId(t.id)}
              empty={<EmptyState icon={<ClipboardCheck />} title={f.scope === 'completed' ? 'No completed tasks yet' : f.scope === 'overdue' ? 'No overdue tasks' : 'No tasks here'} description="Create tasks to track work that isn't a scheduled conversation." action={can('tasks.manage') ? <Button variant="primary" onClick={() => setCreating(true)}><Plus className="size-3.5" />New task</Button> : undefined} />} />
            {total > 0 && <Pagination page={Number(f.page)} pageSize={Number(f.pageSize)} total={total} noun="tasks" onPage={(p) => setF({ page: String(p) }, false)} onPageSize={(n) => setF({ pageSize: String(n) })} />}
          </>
        )}
      </Card>
      <TaskSheet id={openId} onClose={() => setOpenId(null)} onEdit={(t) => { setEditing(t); }} />
      <TaskDialog open={creating || !!editing} onOpenChange={(o) => { if (!o) { setCreating(false); setEditing(null); } }} task={editing} />
      <CompleteFollowUpDialog followUp={fuOpen} onOpenChange={(o) => !o && setFuOpen(null)} />
    </>
  );
}
export default function Page() { return <React.Suspense><Inner /></React.Suspense>; }
