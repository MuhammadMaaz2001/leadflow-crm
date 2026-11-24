'use client';
import * as React from 'react';
import Link from 'next/link';
import { DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, closestCorners, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent, type DragOverEvent } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CalendarDays, GripVertical, List, Plus, Search, Trophy, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useMembers, usePipelines } from '@/lib/hooks';
import { errMsg, useOrg, useT, useWorkspace } from '@/lib/session';
import { useQueryClient } from '@tanstack/react-query';
import { fmtDate, money, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/form';
import { Avatar, Card as UiCard, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/data';
import { LostReasonDialog, OpportunityDialog } from '@/components/dialogs';
import { OpportunitySheet, type Opp } from '@/components/opportunity-sheet';
import { useDebounced } from '@/lib/use-url-state';

interface Col { id: string; name: string; color: string; kind: 'OPEN' | 'WON' | 'LOST'; probability: number; count: number; totalValue: number; opportunities: Opp[] }
interface Board { pipeline: { id: string; name: string }; stages: Col[] }

function Card({ opp, currency, onOpen, overlay }: { opp: Opp; currency: string; onOpen?: () => void; overlay?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: opp.id, data: { stageId: opp.stage.id } });
  const overdue = opp.status === 'OPEN' && opp.expectedCloseDate && new Date(opp.expectedCloseDate) < new Date();
  return (
    <div ref={overlay ? undefined : setNodeRef} style={overlay ? undefined : { transform: CSS.Transform.toString(transform), transition }} {...(overlay ? {} : attributes)} {...(overlay ? {} : listeners)}
      onClick={onOpen} role="button" aria-label={`Opportunity ${opp.name}. Press space to pick up and drag.`}
      className={cn('group cursor-grab touch-manipulation rounded-lg border border-line bg-surface p-3 text-left shadow-card transition-shadow hover:shadow-pop active:cursor-grabbing', isDragging && 'opacity-30', overlay && 'rotate-1 cursor-grabbing shadow-pop')}>
      <div className="flex items-start justify-between gap-2"><p className="line-clamp-2 text-[13px] font-medium leading-[18px]">{opp.name}</p><GripVertical className="mt-0.5 size-3.5 shrink-0 text-ink-3 opacity-0 group-hover:opacity-100" /></div>
      <p className="mt-1 truncate text-xs text-ink-3">{opp.lead.name}{opp.lead.companyName ? ` · ${opp.lead.companyName}` : ''}</p>
      <div className="mt-2.5 flex items-center justify-between">
        <span className="tnum text-[13px] font-semibold">{money(opp.value, currency, true)}</span>
        <span className="flex items-center gap-2">
          {opp.expectedCloseDate && <span className={cn('inline-flex items-center gap-1 text-[11px]', overdue ? 'text-bad' : 'text-ink-3')}><CalendarDays className="size-3" />{fmtDate(opp.expectedCloseDate, 'MMM d')}</span>}
          {opp.owner && <Avatar name={opp.owner.name} size="xs" />}
        </span>
      </div>
      {opp.status === 'OPEN' && <p className="mt-1.5 text-[10px] text-ink-3">{timeAgo(opp.stageEnteredAt).replace(' ago', '')} in stage</p>}
    </div>
  );
}

/** Pinned drop targets shown while dragging, so Won / Lost are reachable even when their columns are off-screen. */
function OutcomeDock({ cols, overCol }: { cols: Col[]; overCol: string | null }) {
  const outcomes = cols.filter((c) => c.kind !== 'OPEN');
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-3">
      <div className="animate-lf-pop pointer-events-auto flex gap-3 rounded-2xl border border-line bg-surface/95 p-2 shadow-pop backdrop-blur">
        {outcomes.map((c) => <DockTarget key={c.id} col={c} over={overCol === c.id} />)}
      </div>
    </div>
  );
}
function DockTarget({ col, over }: { col: Col; over: boolean }) {
  const { setNodeRef } = useDroppable({ id: `dock:${col.id}` });   // distinct id: the real column stays a valid drop target while the dock is shown
  const won = col.kind === 'WON';
  return (
    <div ref={setNodeRef} data-testid={`dock-${col.kind.toLowerCase()}`} className={cn('flex min-w-[150px] items-center justify-center gap-2 rounded-xl border-2 border-dashed px-5 py-4 text-[13px] font-semibold transition-colors', won ? 'border-ok/40 text-ok' : 'border-bad/40 text-bad', over && (won ? 'border-ok bg-ok-soft' : 'border-bad bg-bad-soft'))}>
      {won ? <Trophy className="size-4" /> : <XCircle className="size-4" />}Drop to mark {col.name.toLowerCase()}
    </div>
  );
}

function Column({ col, currency, onOpen, over }: { col: Col; currency: string; onOpen: (id: string) => void; over: boolean }) {
  const { setNodeRef } = useDroppable({ id: `col:${col.id}` });
  return (
    <section aria-label={`${col.name} stage`} className={cn('flex w-[286px] shrink-0 flex-col rounded-xl border bg-subtle/70 transition-colors', over ? 'border-accent bg-accent-soft/50' : 'border-line')}>
      <header className="flex items-center justify-between px-3 pb-2 pt-3">
        <div className="flex min-w-0 items-center gap-2"><span className="size-2.5 shrink-0 rounded-full" style={{ background: col.color }} /><h3 className="truncate text-[13px] font-semibold">{col.name}</h3>{col.kind === 'WON' && <Trophy className="size-3 text-ok" />}{col.kind === 'LOST' && <XCircle className="size-3 text-bad" />}<span className="tnum rounded-full bg-surface px-1.5 text-[11px] font-medium text-ink-2">{col.count}</span></div>
        <span className="tnum text-xs text-ink-3">{money(col.totalValue, currency, true)}</span>
      </header>
      <div ref={setNodeRef} className="scroll-thin flex min-h-[120px] flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2" style={{ maxHeight: 'calc(100dvh - 270px)' }}>
        <SortableContext items={col.opportunities.map((o) => o.id)} strategy={verticalListSortingStrategy}>
          {col.opportunities.map((o) => <Card key={o.id} opp={o} currency={currency} onOpen={() => onOpen(o.id)} />)}
        </SortableContext>
        {col.opportunities.length === 0 && <p className="rounded-lg border border-dashed border-line-strong/70 px-3 py-6 text-center text-xs text-ink-3">{col.kind === 'OPEN' ? 'Drop deals here' : col.kind === 'WON' ? 'Won deals land here' : 'Lost deals land here'}</p>}
        {col.count > col.opportunities.length && <Link href={`/opportunities?stageId=${col.id}`} className="py-1 text-center text-xs text-accent-ink hover:underline">View all {col.count}</Link>}
      </div>
    </section>
  );
}

export default function PipelinePage() {
  const { can, currency } = useOrg();
  const { current } = useWorkspace();
  const qc = useQueryClient();
  const pipelines = usePipelines();
  const members = useMembers(can('opportunities.view_all'));
  const [pipelineId, setPipelineId] = React.useState('');
  const [ownerId, setOwnerId] = React.useState('');
  const [search, setSearch] = React.useState('');
  const dsearch = useDebounced(search, 300);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [newOpp, setNewOpp] = React.useState(false);
  const q = useT(['board', pipelineId, ownerId, dsearch], () => api.get<Board>('/opportunities/board', { pipelineId: pipelineId || undefined, ownerId: ownerId || undefined, q: dsearch || undefined }), { keep: true });
  const [cols, setCols] = React.useState<Col[]>([]);
  React.useEffect(() => { if (q.data) setCols(q.data.stages); }, [q.data]);
  const [active, setActive] = React.useState<Opp | null>(null);
  const [overCol, setOverCol] = React.useState<string | null>(null);
  const [pendingLost, setPendingLost] = React.useState<{ opp: Opp; stageId: string; beforeId: string | null; prev: Col[] } | null>(null);
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const colOf = (cid: string | number | undefined) => { const s = String(cid ?? ''); return s.startsWith('col:') ? cols.find((c) => c.id === s.slice(4)) : s.startsWith('dock:') ? cols.find((c) => c.id === s.slice(5)) : cols.find((c) => c.opportunities.some((o) => o.id === s)); };

  async function persist(opp: Opp, stageId: string, beforeId: string | null, prev: Col[], reason?: { id: string; note?: string }) {
    try {
      await api.post(`/opportunities/${opp.id}/move`, { stageId, beforeId: beforeId ?? undefined, lostReasonId: reason?.id, lostNote: reason?.note });
      const target = cols.find((c) => c.id === stageId);
      if (target?.kind === 'WON') toast.success(`🎉 ${opp.name} won`); else if (stageId !== opp.stage.id) toast.success(`Moved to ${target?.name}`);
    } catch (e) { setCols(prev); toast.error(errMsg(e)); }
    qc.invalidateQueries({ predicate: (k) => k.queryKey[0] === current?.organization.id });
  }
  function onDragStart(e: DragStartEvent) { setActive(cols.flatMap((c) => c.opportunities).find((o) => o.id === e.active.id) ?? null); }
  function onDragOver(e: DragOverEvent) { setOverCol(colOf(e.over?.id)?.id ?? null); }
  function onDragEnd(e: DragEndEvent) {
    setActive(null); setOverCol(null);
    const { active: a, over } = e;
    if (!over || !can('opportunities.manage')) return;
    const from = colOf(a.id), to = colOf(over.id);
    if (!from || !to) return;
    const opp = from.opportunities.find((o) => o.id === a.id)!;
    const overIsCard = !/^(col|dock):/.test(String(over.id));
    if (from.id === to.id && (!overIsCard || over.id === a.id)) return;
    const prev = cols;
    const beforeId = overIsCard && over.id !== a.id ? String(over.id) : null;
    const without = cols.map((c) => (c.id === from.id ? { ...c, opportunities: c.opportunities.filter((o) => o.id !== opp.id), count: c.count - 1, totalValue: c.totalValue - opp.value } : c));
    const moved = { ...opp, stage: { ...opp.stage, id: to.id, name: to.name, color: to.color, kind: to.kind } };
    const next = without.map((c) => {
      if (c.id !== to.id) return c;
      const list = [...c.opportunities];
      const idx = beforeId ? list.findIndex((o) => o.id === beforeId) : list.length;
      list.splice(idx < 0 ? list.length : idx, 0, moved);
      return { ...c, opportunities: list, count: c.count + 1, totalValue: c.totalValue + opp.value };
    });
    if (to.kind === 'LOST' && from.id !== to.id) { setPendingLost({ opp, stageId: to.id, beforeId, prev }); setCols(next); return; }
    setCols(next);
    persist(opp, to.id, beforeId, prev);
  }

  return (
    <>
      <PageHeader title="Sales Pipeline" description="Drag deals between stages. Every move is recorded in the stage history."
        actions={<>
          <Link href="/opportunities"><Button><List className="size-3.5" />Table view</Button></Link>
          {can('opportunities.manage') && <Button variant="primary" onClick={() => setNewOpp(true)}><Plus className="size-3.5" />New opportunity</Button>}
        </>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(pipelines.data?.length ?? 0) > 1 && <div className="w-[190px]"><Select aria-label="Pipeline" value={pipelineId || q.data?.pipeline.id || ''} onChange={(e) => setPipelineId(e.target.value)}>{pipelines.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></div>}
        {can('opportunities.view_all') && <div className="w-[170px]"><Select aria-label="Owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}><option value="">All owners</option>{members.data?.filter((m) => m.status === 'ACTIVE').map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</Select></div>}
        <div className="relative w-[240px]"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search deals or leads…" aria-label="Search deals" className="pl-8" /></div>
        {q.data && <p className="ml-auto text-xs text-ink-3">{cols.filter((c) => c.kind === 'OPEN').reduce((a, c) => a + c.count, 0)} open · {money(cols.filter((c) => c.kind === 'OPEN').reduce((a, c) => a + c.totalValue, 0), currency)} in pipeline</p>}
      </div>
      {q.data && cols.every((c) => c.count === 0) && !dsearch && !ownerId && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-line-strong bg-surface p-4"><div><p className="text-[13px] font-semibold">Your pipeline is empty</p><p className="text-xs text-ink-2">Open a lead and choose “New opportunity” — or create one here — then drag it across the stages.</p></div>{can('opportunities.manage') && <Button variant="primary" onClick={() => setNewOpp(true)}><Plus className="size-3.5" />New opportunity</Button>}</div>
      )}
      {q.isError && <UiCard><ErrorState error={q.error} onRetry={() => q.refetch()} /></UiCard>}
      {q.isLoading ? <div className="flex gap-3 overflow-hidden">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-[420px] w-[286px] shrink-0" />)}</div> : cols.length === 0 ? <EmptyState title="No pipeline found" /> : (
        <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => { setActive(null); setOverCol(null); }}>
          <div className="scroll-thin -mx-3 flex items-start gap-3 overflow-x-auto px-3 pb-3 sm:-mx-6 sm:px-6" data-testid="kanban">
            {cols.map((c) => <Column key={c.id} col={c} currency={currency} onOpen={setOpenId} over={overCol === c.id && active?.stage.id !== c.id} />)}
          </div>
          {active && active.status === 'OPEN' && <OutcomeDock cols={cols} overCol={overCol} />}
          <DragOverlay dropAnimation={{ duration: 180 }}>{active ? <Card opp={active} currency={currency} overlay /> : null}</DragOverlay>
        </DndContext>
      )}
      <OpportunitySheet id={openId} onClose={() => setOpenId(null)} />
      <OpportunityDialog open={newOpp} onOpenChange={setNewOpp} />
      <LostReasonDialog open={!!pendingLost} onOpenChange={(v) => { if (!v && pendingLost) { setCols(pendingLost.prev); setPendingLost(null); } }}
        onConfirm={(reasonId, note) => { const p = pendingLost!; setPendingLost(null); persist(p.opp, p.stageId, p.beforeId, p.prev, { id: reasonId, note }); }} />
    </>
  );
}
