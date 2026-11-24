'use client';
import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Archive, ArrowLeft, Building2, CalendarClock, CalendarPlus, Check, CheckCircle2, ChevronDown, Clock, Handshake, Mail, MoreHorizontal, Pencil, Phone, Plus, RotateCcw, StickyNote, Trophy, UserPlus, XCircle } from 'lucide-react';
import { ACTIVITY_LABELS } from '@leadflow/shared';
import { api } from '@/lib/api';
import { useAct, useOrg, useT } from '@/lib/session';
import { dueLabel, fmtDate, fmtDateTime, fmtRelativeDay, money, timeAgo, titleCase } from '@/lib/format';
import { PRIORITY_TONE, TASK_STATUS_META } from '@/lib/lead-utils';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Avatar, Badge, Card, CardHeader, EmptyState, KeyValue, Skeleton, UserChip } from '@/components/ui/data';
import { Tabs, TabsContent, TabsList, TabsTrigger, DropdownContent, DropdownItem, DropdownMenu, DropdownSeparator, DropdownTrigger, Tooltip } from '@/components/ui/menu';
import { useConfirm } from '@/components/ui/overlay';
import { PriorityDot, SourceTag, StatusBadge, followUpIcon } from '@/components/badges';
import { TagChip } from '@/components/tag-picker';
import { LeadFormSheet } from '@/components/lead-form';
import { AssignDialog, CancelFollowUpDialog, CompleteFollowUpDialog, LogActivityDialog, LostReasonDialog, OpportunityDialog, RescheduleDialog, ScheduleFollowUpDialog, TaskDialog } from '@/components/dialogs';
import { useCustomFields } from '@/lib/hooks';
import type { LeadRow } from '../page';

interface LeadDetail extends LeadRow {
  firstContactedAt: string | null; createdBy: { name: string } | null; assignedAt: string | null; mergedIntoId: string | null; lostReason: { name: string } | null; convertedAt: string | null; description: string | null; campaign: string | null; jobTitle: string | null;
  opportunities: Array<{ id: string; name: string; value: number; status: string; stage: { name: string; color: string; kind: string }; pipeline: { name: string }; expectedCloseDate: string | null; owner: { name: string } | null; lostReason: string | null; wonAt: string | null; lostAt: string | null }>;
  counts: { openTasks: number; pendingFollowUps: number };
}
interface Act { id: string; type: string; title: string; body: string | null; metadata: Record<string, unknown>; actor: { name: string } | null; occurredAt: string }
interface FU { id: string; type: string; dueAt: string; priority: string; notes: string | null; status: string; outcome: string | null; outcomeNotes: string | null; completedAt: string | null; completedBy: { name: string } | null; assignedTo: { name: string } | null; rescheduleCount: number; isOverdue: boolean }
interface TaskRow { id: string; title: string; status: string; priority: string; dueAt: string | null; isOverdue: boolean; assignedTo: { name: string } | null; isAutomated: boolean; description: string | null; lead: { id: string; name: string } | null }

const ACT_STYLE: Record<string, string> = {
  CALL: 'bg-info-soft text-info', EMAIL: 'bg-info-soft text-info', WHATSAPP: 'bg-ok-soft text-ok', MEETING: 'bg-accent-soft text-accent-ink', NOTE: 'bg-warn-soft text-warn',
  OPPORTUNITY_WON: 'bg-ok-soft text-ok', OPPORTUNITY_LOST: 'bg-bad-soft text-bad', FOLLOWUP_COMPLETED: 'bg-ok-soft text-ok', FOLLOWUP_CANCELED: 'bg-bad-soft text-bad',
};
const actIcon = (t: string) => ({ CALL: <Phone />, EMAIL: <Mail />, WHATSAPP: followUpIcon('WHATSAPP', 'size-3.5'), MEETING: followUpIcon('MEETING', 'size-3.5'), NOTE: <StickyNote />, OPPORTUNITY_WON: <Trophy />, OPPORTUNITY_LOST: <XCircle />, FOLLOWUP_COMPLETED: <CheckCircle2 />, FOLLOWUP_SCHEDULED: <CalendarClock />, FOLLOWUP_RESCHEDULED: <CalendarClock />, FOLLOWUP_CANCELED: <XCircle />, OPPORTUNITY_CREATED: <Handshake />, STAGE_CHANGED: <Handshake /> } as Record<string, React.ReactNode>)[t] ?? <Clock />;

function Timeline({ leadId }: { leadId: string }) {
  const [page, setPage] = React.useState(1);
  const [filter, setFilter] = React.useState('');
  const q = useT(['lead', leadId, 'activities', page, filter], () => api.page<Act>(`/leads/${leadId}/activities`, { page: 1, pageSize: page * 20, type: filter || undefined }), { keep: true });
  const items = q.data?.data ?? [];
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {[['', 'All'], ['CALL,EMAIL,WHATSAPP,MEETING', 'Conversations'], ['NOTE', 'Notes'], ['FOLLOWUP_SCHEDULED,FOLLOWUP_COMPLETED,FOLLOWUP_RESCHEDULED,FOLLOWUP_CANCELED', 'Follow-ups'], ['OPPORTUNITY_CREATED,STAGE_CHANGED,OPPORTUNITY_WON,OPPORTUNITY_LOST', 'Pipeline'], ['LEAD_ASSIGNED,LEAD_REASSIGNED', 'Assignments']].map(([v, l]) => (
          <button key={l} type="button" onClick={() => { setFilter(v!); setPage(1); }} className={cn('rounded-full border px-2.5 py-0.5 text-xs', filter === v ? 'border-accent bg-accent-soft font-medium text-accent-ink' : 'border-line text-ink-2 hover:bg-subtle')}>{l}</button>
        ))}
      </div>
      {q.isLoading ? <div className="space-y-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div> : items.length === 0 ? <EmptyState className="py-10" icon={<StickyNote />} title="No activity yet" description="Log a call, email or note to start the timeline." /> : (
        <ol className="relative space-y-0">
          {items.map((a, i) => (
            <li key={a.id} className="relative flex gap-3 pb-5 last:pb-0">
              {i < items.length - 1 && <span className="absolute left-[13px] top-7 h-[calc(100%-18px)] w-px bg-line" aria-hidden />}
              <span className={cn('z-10 flex size-7 shrink-0 items-center justify-center rounded-full [&>svg]:size-3.5', ACT_STYLE[a.type] ?? 'bg-subtle text-ink-2')}>{actIcon(a.type)}</span>
              <div className="min-w-0 flex-1 pt-0.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <p className="text-[13px] font-medium leading-5">{a.title}</p>
                  <Tooltip content={fmtDateTime(a.occurredAt)}><time className="text-xs text-ink-3" dateTime={a.occurredAt}>{timeAgo(a.occurredAt)}</time></Tooltip>
                </div>
                {a.body && <p className="mt-1 whitespace-pre-wrap rounded-lg bg-subtle px-3 py-2 text-[13px] leading-5 text-ink-2">{a.body}</p>}
                <p className="mt-0.5 text-xs text-ink-3">{ACTIVITY_LABELS[a.type] ?? a.type} · {a.actor?.name ?? 'System'}{a.metadata?.durationMinutes ? ` · ${String(a.metadata.durationMinutes)} min` : ''}{a.metadata?.direction ? ` · ${titleCase(String(a.metadata.direction))}` : ''}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
      {q.data && q.data.meta.total > items.length && <div className="mt-4 text-center"><Button size="sm" onClick={() => setPage(page + 1)} loading={q.isFetching}>Load older activity ({q.data.meta.total - items.length} more)</Button></div>}
    </div>
  );
}

function FollowUps({ leadId, lead, onSchedule }: { leadId: string; lead: LeadDetail; onSchedule: () => void }) {
  const { can } = useOrg();
  const q = useT(['lead', leadId, 'followups'], () => api.get<FU[]>(`/leads/${leadId}/followups`));
  const [complete, setComplete] = React.useState<FU | null>(null);
  const [resched, setResched] = React.useState<FU | null>(null);
  const [cancel, setCancel] = React.useState<FU | null>(null);
  const pending = q.data?.filter((f) => f.status === 'PENDING') ?? [];
  const history = q.data?.filter((f) => f.status !== 'PENDING') ?? [];
  return (
    <div>
      <div className="mb-3 flex items-center justify-between"><h3 className="text-[13px] font-semibold">Upcoming & overdue</h3>{can('followups.manage') && <Button size="sm" variant="primary" onClick={onSchedule}><CalendarPlus className="size-3.5" />Schedule</Button>}</div>
      {q.isLoading ? <Skeleton className="h-20" /> : pending.length === 0 ? <EmptyState className="rounded-lg border border-dashed py-8" icon={<CalendarClock />} title="No follow-up scheduled" description="Every active lead should have a next step." /> : (
        <ul className="space-y-2">{pending.map((f) => (
          <li key={f.id} className={cn('flex flex-wrap items-center gap-3 rounded-lg border p-3', f.isOverdue ? 'border-bad/30 bg-bad-soft/40' : 'border-line')}>
            <span className={cn('flex size-8 items-center justify-center rounded-full', f.isOverdue ? 'bg-bad-soft text-bad' : 'bg-accent-soft text-accent')}>{followUpIcon(f.type)}</span>
            <div className="min-w-0 flex-1"><p className="text-[13px] font-medium">{titleCase(f.type)} <Badge tone={PRIORITY_TONE[f.priority]}>{titleCase(f.priority)}</Badge>{f.rescheduleCount > 0 && <span className="ml-1.5 text-xs text-ink-3">rescheduled {f.rescheduleCount}×</span>}</p><p className={cn('text-xs', f.isOverdue ? 'font-medium text-bad' : 'text-ink-2')}>{fmtDateTime(f.dueAt)} · {dueLabel(f.dueAt)}{f.assignedTo ? ` · ${f.assignedTo.name}` : ''}</p>{f.notes && <p className="mt-0.5 text-xs text-ink-3">{f.notes}</p>}</div>
            {can('followups.manage') && <div className="flex gap-1.5"><Button size="sm" variant="primary" onClick={() => setComplete(f)}><Check className="size-3.5" />Complete</Button><Button size="sm" onClick={() => setResched(f)}>Reschedule</Button><Button size="sm" variant="dangerGhost" onClick={() => setCancel(f)}>Cancel</Button></div>}
          </li>))}</ul>
      )}
      <h3 className="mb-2 mt-6 text-[13px] font-semibold">History</h3>
      {history.length === 0 ? <p className="text-xs text-ink-3">Completed and canceled follow-ups appear here.</p> : (
        <ul className="divide-y divide-line rounded-lg border border-line">{history.map((f) => (
          <li key={f.id} className="flex items-start gap-3 p-3"><span className="mt-0.5 text-ink-3">{followUpIcon(f.type)}</span><div className="min-w-0 flex-1 text-[13px]"><p className="font-medium">{titleCase(f.type)} · {f.status === 'COMPLETED' ? <span className="text-ok">{titleCase(f.outcome ?? 'completed')}</span> : <span className="text-bad">Canceled</span>}</p><p className="text-xs text-ink-3">Due {fmtDateTime(f.dueAt)}{f.completedAt ? ` · done ${fmtDateTime(f.completedAt)} by ${f.completedBy?.name ?? '—'}` : ''}</p>{f.outcomeNotes && <p className="mt-0.5 text-xs text-ink-2">{f.outcomeNotes}</p>}</div></li>))}</ul>
      )}
      <CompleteFollowUpDialog followUp={complete ? { id: complete.id, type: complete.type, lead: { name: lead.name } } : null} onOpenChange={(o) => !o && setComplete(null)} />
      <RescheduleDialog followUp={resched} onOpenChange={(o) => !o && setResched(null)} />
      <CancelFollowUpDialog followUp={cancel} onOpenChange={(o) => !o && setCancel(null)} />
    </div>
  );
}

export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const confirm = useConfirm();
  const { can, currency } = useOrg();
  const q = useT(['lead', id], () => api.get<LeadDetail>(`/leads/${id}`));
  const customFields = useCustomFields();
  const l = q.data;
  const [edit, setEdit] = React.useState(false);
  const [assign, setAssign] = React.useState(false);
  const [log, setLog] = React.useState<string | null>(null);
  const [followUp, setFollowUp] = React.useState(false);
  const [oppOpen, setOppOpen] = React.useState(false);
  const [taskOpen, setTaskOpen] = React.useState(false);
  const [lostOpen, setLostOpen] = React.useState(false);
  const tasks = useT(['lead', id, 'tasks'], () => api.page<TaskRow>('/tasks', { leadId: id, scope: 'all', pageSize: 50, sort: 'createdAt', order: 'desc' }));
  const assignments = useT(['lead', id, 'assignments'], () => api.get<Array<{ id: string; from: { name: string } | null; to: { name: string } | null; assignedBy: { name: string } | null; method: string; note: string | null; createdAt: string }>>(`/leads/${id}/assignments`));
  const doAssign = useAct(({ userId, note }: { userId: string | null; note?: string }) => api.post(`/leads/${id}/assign`, { assignedToId: userId, note }), { success: 'Lead assigned', onSuccess: () => setAssign(false) });
  const archive = useAct(() => api.post(`/leads/${id}/archive`), { success: 'Lead archived', onSuccess: () => router.push('/leads') });
  const restore = useAct(() => api.post(`/leads/${id}/restore`), { success: 'Lead restored' });
  const setStatus = useAct((b: { status: string; lostReasonId?: string }) => api.patch(`/leads/${id}`, b), { success: 'Status updated', onSuccess: () => setLostOpen(false) });
  const completeTask = useAct((t: string) => api.patch(`/tasks/${t}`, { status: 'DONE' }), { success: 'Task completed' });

  if (q.error) return <EmptyState icon={<Archive />} title="Lead not found" description="It may have been removed or you may not have access to it." action={<Button onClick={() => router.push('/leads')}><ArrowLeft className="size-3.5" />Back to leads</Button>} />;
  const nextFu = undefined;
  void nextFu;
  return (
    <>
      <Link href="/leads" className="mb-3 inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink"><ArrowLeft className="size-3" />All leads</Link>
      {!l ? <div className="space-y-4"><Skeleton className="h-20" /><div className="grid gap-4 lg:grid-cols-3"><Skeleton className="h-96 lg:col-span-2" /><Skeleton className="h-96" /></div></div> : (
        <>
          <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-4">
              <Avatar name={l.name} size="lg" className="size-12 text-base" />
              <div className="min-w-0">
                <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">{l.name}<StatusBadge status={l.status} />{l.archivedAt && <Badge>Archived</Badge>}{l.mergedIntoId && <Badge tone="warn">Merged</Badge>}</h1>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[13px] text-ink-2">{l.jobTitle && <span>{l.jobTitle}</span>}{l.companyName && <span className="inline-flex items-center gap-1"><Building2 className="size-3.5 text-ink-3" />{l.companyName}</span>}<PriorityDot priority={l.priority} /><SourceTag source={l.source} /></p>
                {l.tags.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{l.tags.map((t) => <TagChip key={t.id} tag={t} />)}</div>}
              </div>
            </div>
            {!l.archivedAt && (
              <div className="flex flex-wrap items-center gap-2">
                {can('leads.update') && <Button onClick={() => setLog('CALL')}><Phone className="size-3.5" />Log activity</Button>}
                {can('followups.manage') && <Button onClick={() => setFollowUp(true)}><CalendarPlus className="size-3.5" />Follow-up</Button>}
                {can('opportunities.manage') && <Button variant="primary" onClick={() => setOppOpen(true)}><Handshake className="size-3.5" />New opportunity</Button>}
                <DropdownMenu>
                  <DropdownTrigger asChild><Button size="icon" aria-label="More actions"><MoreHorizontal className="size-4" /></Button></DropdownTrigger>
                  <DropdownContent>
                    {can('leads.update') && <DropdownItem onSelect={() => setEdit(true)} icon={<Pencil />}>Edit lead</DropdownItem>}
                    {can('leads.assign') && <DropdownItem onSelect={() => setAssign(true)} icon={<UserPlus />}>{l.assignedTo ? 'Reassign' : 'Assign'}</DropdownItem>}
                    {can('tasks.manage') && <DropdownItem onSelect={() => setTaskOpen(true)} icon={<Plus />}>New task</DropdownItem>}
                    {can('leads.update') && l.status !== 'CONVERTED' && <><DropdownSeparator />{l.status !== 'QUALIFIED' && <DropdownItem onSelect={() => setStatus.mutate({ status: 'QUALIFIED' })}>Mark as qualified</DropdownItem>}{l.status !== 'LOST' ? <DropdownItem destructive onSelect={() => setLostOpen(true)}>Mark as lost…</DropdownItem> : <DropdownItem onSelect={() => setStatus.mutate({ status: 'CONTACTED' })}>Reopen lead</DropdownItem>}</>}
                    {can('leads.archive') && <><DropdownSeparator /><DropdownItem destructive icon={<Archive />} onSelect={async () => { if (await confirm({ title: 'Archive this lead?', description: 'History is preserved and you can restore it later.', confirmLabel: 'Archive' })) archive.mutate(); }}>Archive</DropdownItem></>}
                  </DropdownContent>
                </DropdownMenu>
              </div>
            )}
            {l.archivedAt && can('leads.archive') && !l.mergedIntoId && <Button onClick={() => restore.mutate()} loading={restore.isPending}><RotateCcw className="size-3.5" />Restore lead</Button>}
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
            <Card className="min-w-0 p-0">
              <Tabs defaultValue="timeline">
                <TabsList className="px-3">
                  <TabsTrigger value="timeline">Timeline</TabsTrigger>
                  <TabsTrigger value="followups">Follow-ups {l.counts.pendingFollowUps > 0 && <Badge tone="accent" className="ml-1">{l.counts.pendingFollowUps}</Badge>}</TabsTrigger>
                  <TabsTrigger value="opps">Opportunities <Badge className="ml-1">{l.opportunities.length}</Badge></TabsTrigger>
                  <TabsTrigger value="tasks">Tasks {l.counts.openTasks > 0 && <Badge tone="warn" className="ml-1">{l.counts.openTasks}</Badge>}</TabsTrigger>
                  <TabsTrigger value="history">Assignments</TabsTrigger>
                </TabsList>
                <div className="p-4 sm:p-5">
                  <TabsContent value="timeline">
                    {can('leads.update') && !l.archivedAt && (
                      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-subtle/60 p-2">
                        <span className="px-1 text-xs text-ink-3">Log:</span>
                        {[['NOTE', 'Note', <StickyNote key="n" className="size-3.5" />], ['CALL', 'Call', <Phone key="c" className="size-3.5" />], ['EMAIL', 'Email', <Mail key="e" className="size-3.5" />], ['WHATSAPP', 'WhatsApp', followUpIcon('WHATSAPP', 'size-3.5')], ['MEETING', 'Meeting', followUpIcon('MEETING', 'size-3.5')]].map(([t, label, icon]) => <Button key={String(t)} size="sm" onClick={() => setLog(String(t))}>{icon as React.ReactNode}{label as string}</Button>)}
                      </div>
                    )}
                    <Timeline leadId={id} />
                  </TabsContent>
                  <TabsContent value="followups"><FollowUps leadId={id} lead={l} onSchedule={() => setFollowUp(true)} /></TabsContent>
                  <TabsContent value="opps">
                    {l.opportunities.length === 0 ? <EmptyState className="py-10" icon={<Handshake />} title="No opportunities yet" description="Create an opportunity when this lead becomes a real deal. A lead can have several." action={can('opportunities.manage') && !l.archivedAt ? <Button variant="primary" onClick={() => setOppOpen(true)}><Plus className="size-3.5" />New opportunity</Button> : undefined} /> : (
                      <ul className="space-y-2">{l.opportunities.map((o) => (
                        <li key={o.id}><Link href={`/opportunities?open=${o.id}`} className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3 hover:bg-subtle">
                          <div className="min-w-0 flex-1"><p className="text-[13px] font-medium">{o.name}</p><p className="text-xs text-ink-3">{o.pipeline.name}{o.expectedCloseDate ? ` · closes ${fmtDate(o.expectedCloseDate)}` : ''}{o.owner ? ` · ${o.owner.name}` : ''}{o.lostReason ? ` · ${o.lostReason}` : ''}</p></div>
                          <Badge dot={o.stage.color}>{o.stage.name}</Badge><span className="tnum text-[13px] font-semibold">{money(o.value, currency)}</span>
                        </Link></li>))}</ul>
                    )}
                  </TabsContent>
                  <TabsContent value="tasks">
                    <div className="mb-3 flex justify-end">{can('tasks.manage') && <Button size="sm" variant="primary" onClick={() => setTaskOpen(true)}><Plus className="size-3.5" />New task</Button>}</div>
                    {!tasks.data?.data.length ? <EmptyState className="py-10" title="No tasks linked to this lead" /> : (
                      <ul className="divide-y divide-line rounded-lg border border-line">{tasks.data.data.map((t) => (
                        <li key={t.id} className="flex items-center gap-3 p-3">
                          <button aria-label={`Complete ${t.title}`} disabled={t.status === 'DONE' || !can('tasks.manage')} onClick={() => completeTask.mutate(t.id)} className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border', t.status === 'DONE' ? 'border-ok bg-ok text-white' : 'border-line-strong hover:border-accent')}>{t.status === 'DONE' && <Check className="size-3" />}</button>
                          <div className="min-w-0 flex-1"><p className={cn('text-[13px] font-medium', t.status === 'DONE' && 'text-ink-3 line-through')}>{t.title}{t.isAutomated && <Badge className="ml-2">Automated</Badge>}</p><p className={cn('text-xs', t.isOverdue ? 'text-bad' : 'text-ink-3')}>{t.dueAt ? `${fmtDateTime(t.dueAt)}${t.isOverdue ? ' · overdue' : ''}` : 'No deadline'} · {t.assignedTo?.name ?? 'Unassigned'}</p></div>
                          <Badge tone={TASK_STATUS_META[t.status]?.tone}>{TASK_STATUS_META[t.status]?.label}</Badge>
                        </li>))}</ul>
                    )}
                  </TabsContent>
                  <TabsContent value="history">
                    {!assignments.data?.length ? <EmptyState className="py-10" title="Never assigned" description="Ownership changes will be recorded here." /> : (
                      <ol className="space-y-3">{assignments.data.map((a) => <li key={a.id} className="flex gap-3 text-[13px]"><UserPlus className="mt-0.5 size-4 shrink-0 text-ink-3" /><div><p>{a.from ? <><b>{a.from.name}</b> → </> : null}{a.to ? <b>{a.to.name}</b> : <b>Unassigned</b>} <Badge className="ml-1">{titleCase(a.method)}</Badge></p><p className="text-xs text-ink-3">{a.assignedBy ? `by ${a.assignedBy.name} · ` : ''}{fmtDateTime(a.createdAt)}{a.note ? ` · ${a.note}` : ''}</p></div></li>)}</ol>
                    )}
                  </TabsContent>
                </div>
              </Tabs>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader title="Owner & next step" />
                <div className="space-y-3 px-4 pb-4 pt-2">
                  <div className="flex items-center justify-between"><UserChip user={l.assignedTo} size="sm" />{can('leads.assign') && !l.archivedAt && <Button size="sm" onClick={() => setAssign(true)}>{l.assignedTo ? 'Reassign' : 'Assign'}</Button>}</div>
                  {l.assignedAt && <p className="text-xs text-ink-3">Assigned {timeAgo(l.assignedAt)}</p>}
                  <div className={cn('rounded-lg border p-3', l.nextFollowUpAt && new Date(l.nextFollowUpAt) < new Date() ? 'border-bad/30 bg-bad-soft/50' : 'border-line bg-subtle/60')}>
                    <p className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Next follow-up</p>
                    {l.nextFollowUpAt ? <p className={cn('mt-0.5 text-[13px] font-medium', new Date(l.nextFollowUpAt) < new Date() && 'text-bad')}>{fmtRelativeDay(l.nextFollowUpAt)}<span className="block text-xs font-normal opacity-80">{dueLabel(l.nextFollowUpAt)}</span></p> : <p className="mt-0.5 text-[13px] text-ink-2">None scheduled</p>}
                  </div>
                  {l.status === 'LOST' && <div className="rounded-lg bg-bad-soft p-3 text-xs text-bad">Lost{l.lostReason ? ` — ${l.lostReason.name}` : ''}</div>}
                </div>
              </Card>
              <Card>
                <CardHeader title="Details" actions={can('leads.update') && !l.archivedAt ? <Button size="iconSm" variant="ghost" aria-label="Edit lead" onClick={() => setEdit(true)}><Pencil className="size-3.5" /></Button> : undefined} />
                <dl className="divide-y divide-line px-4 pb-3 pt-1">
                  <KeyValue label="Email">{l.email ? <a href={`mailto:${l.email}`} className="break-all text-accent-ink hover:underline">{l.email}</a> : '—'}</KeyValue>
                  <KeyValue label="Phone">{l.phone ? <a href={`tel:${l.phone}`} className="text-accent-ink hover:underline">{l.phone}</a> : '—'}</KeyValue>
                  <KeyValue label="Company">{l.companyName ?? '—'}</KeyValue>
                  <KeyValue label="Job title">{l.jobTitle ?? '—'}</KeyValue>
                  <KeyValue label="Source"><SourceTag source={l.source} /></KeyValue>
                  <KeyValue label="Campaign">{l.campaign ?? '—'}</KeyValue>
                  <KeyValue label="Created">{fmtDate(l.createdAt)}{l.createdBy ? ` · ${l.createdBy.name}` : ''}</KeyValue>
                  <KeyValue label="First contact">{l.firstContactedAt ? fmtDateTime(l.firstContactedAt) : <span className="text-warn">Not yet</span>}</KeyValue>
                  <KeyValue label="Last activity">{timeAgo(l.lastActivityAt)}</KeyValue>
                  {customFields.data?.filter((f) => f.isActive && l.customFields && f.key in (l.customFields as object)).map((f) => <KeyValue key={f.id} label={f.label}>{String((l.customFields as Record<string, unknown>)[f.key] ?? '—')}</KeyValue>)}
                </dl>
                {l.description && <div className="border-t border-line px-4 py-3"><p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-3">Description</p><p className="whitespace-pre-wrap text-[13px] text-ink-2">{l.description}</p></div>}
              </Card>
            </div>
          </div>

          <LeadFormSheet open={edit} onOpenChange={setEdit} lead={l} />
          <AssignDialog open={assign} onOpenChange={setAssign} current={l.assignedTo?.id} loading={doAssign.isPending} title={l.assignedTo ? 'Reassign lead' : 'Assign lead'} onConfirm={(userId, note) => doAssign.mutate({ userId, note })} />
          {log && <LogActivityDialog open onOpenChange={(o) => !o && setLog(null)} leadId={id} leadName={l.name} initialType={log} />}
          <ScheduleFollowUpDialog open={followUp} onOpenChange={setFollowUp} lead={{ id, name: l.name, assignedTo: l.assignedTo }} />
          <OpportunityDialog open={oppOpen} onOpenChange={setOppOpen} lead={{ id, name: l.name, companyName: l.companyName }} />
          <TaskDialog open={taskOpen} onOpenChange={setTaskOpen} lead={{ id, name: l.name }} />
          <LostReasonDialog open={lostOpen} onOpenChange={setLostOpen} loading={setStatus.isPending} onConfirm={(reasonId) => setStatus.mutate({ status: 'LOST', lostReasonId: reasonId })} />
        </>
      )}
    </>
  );
}
void ChevronDown;
