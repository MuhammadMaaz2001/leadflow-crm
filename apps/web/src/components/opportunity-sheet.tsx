'use client';
import * as React from 'react';
import Link from 'next/link';
import { CalendarPlus, CheckCircle2, ExternalLink, Handshake, Pencil, Plus, Trophy, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { usePipelines } from '@/lib/hooks';
import { useAct, useOrg, useT } from '@/lib/session';
import { fmtDate, fmtDateTime, money, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/overlay';
import { Badge, KeyValue, Skeleton, UserChip } from '@/components/ui/data';
import { LostReasonDialog, OpportunityDialog, ScheduleFollowUpDialog, TaskDialog } from '@/components/dialogs';

export interface Opp {
  id: string; name: string; value: number; status: 'OPEN' | 'WON' | 'LOST'; expectedCloseDate: string | null; stageEnteredAt: string; wonAt: string | null; lostAt: string | null; lostReason: { id: string; name: string } | null; lostNote: string | null; notes: string | null; createdAt: string;
  lead: { id: string; name: string; companyName: string | null; email: string | null; phone: string | null }; stage: { id: string; name: string; color: string; kind: 'OPEN' | 'WON' | 'LOST'; probability: number }; pipeline: { id: string; name: string }; owner: { id: string; name: string; email: string } | null;
}
interface OppDetail extends Opp { history: Array<{ id: string; from: string | null; to: string | null; toColor?: string; changedBy: { name: string } | null; note: string | null; createdAt: string }>; openTasks: number; pendingFollowUps: number }

export function OpportunitySheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can, currency } = useOrg();
  const q = useT(['opportunity', id], () => api.get<OppDetail>(`/opportunities/${id}`), { enabled: !!id });
  const pipelines = usePipelines();
  const [edit, setEdit] = React.useState(false);
  const [lostFor, setLostFor] = React.useState<string | null>(null);
  const [fu, setFu] = React.useState(false);
  const [task, setTask] = React.useState(false);
  const move = useAct((v: { stageId: string; lostReasonId?: string; lostNote?: string }) => api.post(`/opportunities/${id}/move`, v), { success: 'Opportunity moved', onSuccess: () => setLostFor(null) });
  const o = q.data;
  const stages = pipelines.data?.find((p) => p.id === o?.pipeline.id)?.stages ?? [];
  return (
    <>
      <Sheet open={!!id} onOpenChange={(v) => !v && onClose()} title={o?.name ?? 'Opportunity'} description={o ? `${o.pipeline.name} · created ${timeAgo(o.createdAt)}` : undefined} width="max-w-lg">
        {!o ? <div className="space-y-3"><Skeleton className="h-8" /><Skeleton className="h-40" /></div> : (
          <div className="space-y-5">
            <div className="flex items-end justify-between gap-3">
              <div><p className="tnum text-2xl font-semibold">{money(o.value, currency)}</p><div className="mt-1 flex items-center gap-2"><Badge dot={o.stage.color}>{o.stage.name}</Badge>{o.status === 'WON' && <Badge tone="ok"><Trophy className="size-3" />Won {fmtDate(o.wonAt)}</Badge>}{o.status === 'LOST' && <Badge tone="bad"><XCircle className="size-3" />Lost {fmtDate(o.lostAt)}</Badge>}</div></div>
              {can('opportunities.manage') && <Button size="sm" onClick={() => setEdit(true)}><Pencil className="size-3.5" />Edit</Button>}
            </div>

            {can('opportunities.manage') && (
              <div>
                <p className="mb-1.5 text-xs font-medium text-ink-2">Move to stage</p>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Move to stage">
                  {stages.map((s) => (
                    <button key={s.id} type="button" disabled={s.id === o.stage.id || move.isPending} onClick={() => (s.kind === 'LOST' ? setLostFor(s.id) : move.mutate({ stageId: s.id }))}
                      className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors', s.id === o.stage.id ? 'border-transparent font-medium text-white' : 'border-line text-ink-2 hover:bg-subtle')} style={s.id === o.stage.id ? { background: s.color } : undefined}>
                      {s.kind === 'WON' ? <CheckCircle2 className="size-3" /> : s.kind === 'LOST' ? <XCircle className="size-3" /> : null}{s.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <dl className="divide-y divide-line rounded-lg border border-line px-3">
              <KeyValue label="Lead"><Link href={`/leads/${o.lead.id}`} className="inline-flex items-center gap-1 font-medium text-accent-ink hover:underline">{o.lead.name}<ExternalLink className="size-3" /></Link></KeyValue>
              <KeyValue label="Company">{o.lead.companyName ?? '—'}</KeyValue>
              <KeyValue label="Owner"><UserChip user={o.owner} /></KeyValue>
              <KeyValue label="Expected close">{fmtDate(o.expectedCloseDate)}</KeyValue>
              <KeyValue label="Win probability">{o.stage.probability}%</KeyValue>
              <KeyValue label="In this stage">{timeAgo(o.stageEnteredAt).replace(' ago', '')}</KeyValue>
              {o.lostReason && <KeyValue label="Lost reason">{o.lostReason.name}</KeyValue>}
            </dl>
            {o.lostNote && <p className="rounded-lg bg-bad-soft p-3 text-xs text-bad">{o.lostNote}</p>}
            {o.notes && <p className="whitespace-pre-wrap rounded-lg bg-subtle p-3 text-[13px] text-ink-2">{o.notes}</p>}

            {can('followups.manage') && o.status === 'OPEN' && <div className="flex gap-2"><Button size="sm" onClick={() => setFu(true)}><CalendarPlus className="size-3.5" />Schedule follow-up</Button>{can('tasks.manage') && <Button size="sm" onClick={() => setTask(true)}><Plus className="size-3.5" />Task</Button>}</div>}
            <p className="text-xs text-ink-3">{o.pendingFollowUps} pending follow-up(s) · {o.openTasks} open task(s)</p>

            <div>
              <h3 className="mb-2 text-[13px] font-semibold">Stage history</h3>
              <ol className="space-y-3 border-l border-line pl-4">
                {o.history.map((h) => (
                  <li key={h.id} className="relative text-[13px]"><span className="absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-surface" style={{ background: h.toColor ?? '#94a3b8' }} />
                    <p>{h.from ? <>{h.from} <span className="text-ink-3">→</span> </> : 'Created in '}<b>{h.to}</b></p><p className="text-xs text-ink-3">{h.changedBy?.name ?? 'System'} · {fmtDateTime(h.createdAt)}{h.note ? ` · ${h.note}` : ''}</p></li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </Sheet>
      {o && <OpportunityDialog open={edit} onOpenChange={setEdit} opp={o} />}
      <LostReasonDialog open={!!lostFor} onOpenChange={(v) => !v && setLostFor(null)} loading={move.isPending} onConfirm={(reasonId, note) => move.mutate({ stageId: lostFor!, lostReasonId: reasonId, lostNote: note })} />
      {o && <ScheduleFollowUpDialog open={fu} onOpenChange={setFu} lead={{ id: o.lead.id, name: o.lead.name, assignedTo: o.owner }} opportunityId={o.id} />}
      {o && <TaskDialog open={task} onOpenChange={setTask} lead={{ id: o.lead.id, name: o.lead.name }} opportunityId={o.id} />}
    </>
  );
}
void Handshake;
