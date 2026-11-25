'use client';
import * as React from 'react';
import { addDays, addMonths, addWeeks, eachDayOfInterval, endOfMonth, endOfWeek, format, startOfMonth, startOfWeek } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { CalendarClock, CheckSquare, ChevronLeft, ChevronRight, GripVertical, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';
import { errMsg, useOrg, useT, useWorkspace } from '@/lib/session';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/data';
import { Field, FormError, Input } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';

export interface CalEvent {
  id: string; kind: 'followup' | 'task'; title: string; start: string; status: string; overdue: boolean; priority: string; type: string; leadId: string | null;
  assignee: { name: string } | null; assigneeId?: string | null; canReschedule?: boolean;
}
type Mode = 'month' | 'week' | 'day';
const DAY = 'yyyy-MM-dd';
const SLOT_FIRST = 6, SLOT_LAST = 21;                       // day view rows: 06:00 … 21:30 in 30-minute steps

const chipTone = (e: CalEvent) => e.status === 'COMPLETED' || e.status === 'DONE' ? 'bg-ok-soft text-ok line-through decoration-ok/40' : e.overdue ? 'bg-bad-soft text-bad' : e.kind === 'task' ? 'bg-warn-soft text-warn' : 'bg-accent-soft text-accent-ink';
/** Wall clock, read at event time (kept out of render bodies). */
const nowMs = () => Date.now();
const keyOf = (e: CalEvent) => `${e.kind}:${e.id}`;
/** The item currently being dragged with the mouse (dataTransfer cannot carry the full object; it is only readable on drop). */
let dragged: CalEvent | undefined;
const dayDate = (key: string) => new Date(`${key}T12:00:00`);   // a plain calendar day: only its Y-M-D fields are ever used

interface Move { event: CalEvent; date: string; time?: string }
type Mover = (m: Move) => void;

function Chip({ e, tz, onOpen, onMove, onReschedule, compact, startDrag, dragging, step }: {
  e: CalEvent; tz: string; onOpen: (e: CalEvent) => void; onMove: Mover; onReschedule: (e: CalEvent) => void; compact?: boolean;
  startDrag: (e: CalEvent, ev: React.PointerEvent) => void; dragging: boolean; step: (e: CalEvent, key: string) => Move | null;
}) {
  const can = !!e.canReschedule;
  const time = formatInTimeZone(new Date(e.start), tz, 'h:mma').toLowerCase();
  return (
    <div
      className={cn('group/chip relative flex w-full items-center rounded text-[11px] font-medium', chipTone(e), dragging && 'opacity-40')}
      draggable={can}
      data-testid={`cal-event-${e.kind}-${e.id}`}
      onDragStart={(ev) => { if (!can) return; ev.dataTransfer.setData('application/x-leadflow-event', JSON.stringify({ kind: e.kind, id: e.id })); ev.dataTransfer.effectAllowed = 'move'; dragged = e; }}
      onDragEnd={() => { dragged = undefined; }}
      onPointerDown={(ev) => { if (can && ev.pointerType === 'touch') startDrag(e, ev); }}
    >
      <button
        type="button" onClick={(ev) => { ev.stopPropagation(); onOpen(e); }}
        onKeyDown={(ev) => {
          if (!can || !ev.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key)) return;
          ev.preventDefault(); const m = step(e, ev.key); if (m) onMove(m);
        }}
        aria-keyshortcuts={can ? 'Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown' : undefined}
        title={`${time} · ${e.title}${e.assignee ? ` · ${e.assignee.name}` : ''}${can ? ' — drag to reschedule, or press Alt+arrow keys' : ''}`}
        className="flex min-w-0 flex-1 items-center gap-1 truncate rounded px-1.5 py-0.5 text-left touch-manipulation"
      >
        {can && <GripVertical className="size-3 shrink-0 opacity-40 max-sm:hidden" aria-hidden />}
        {e.kind === 'task' ? <CheckSquare className="size-3 shrink-0" /> : <CalendarClock className="size-3 shrink-0" />}
        <span className="tnum shrink-0 opacity-70">{time}</span>
        <span className="truncate">{compact ? e.title.split(' · ')[0] : e.title}</span>
      </button>
      {can && (
        <button
          type="button" aria-label={`Reschedule ${e.title}`} onClick={(ev) => { ev.stopPropagation(); onReschedule(e); }}
          className="mr-0.5 shrink-0 rounded p-0.5 opacity-0 hover:bg-black/10 focus-visible:opacity-100 group-hover/chip:opacity-100 [@media(hover:none)]:opacity-70"
        ><Pencil className="size-3" /></button>
      )}
    </div>
  );
}

export function RescheduleEventDialog({ event, tz, busy, onClose, onSubmit }: { event: CalEvent | null; tz: string; busy: boolean; onClose: () => void; onSubmit: (date: string, time: string) => void }) {
  const [date, setDate] = React.useState(''); const [time, setTime] = React.useState('');
  React.useEffect(() => { if (event) { setDate(formatInTimeZone(new Date(event.start), tz, DAY)); setTime(formatInTimeZone(new Date(event.start), tz, 'HH:mm')); } }, [event, tz]);
  const invalid = !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time);
  const past = !invalid && fromZonedTime(`${date}T${time}:00`, tz).getTime() < nowMs() - 60_000;
  return (
    <Dialog open={!!event} onOpenChange={(o) => !o && onClose()} size="sm" title={`Reschedule ${event?.kind === 'task' ? 'task' : 'follow-up'}`} description={event?.title}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={invalid || past} onClick={() => onSubmit(date, time)}>Move</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!invalid && !past) onSubmit(date, time); }}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date" required htmlFor="rs-date"><Input id="rs-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Time" required htmlFor="rs-time"><Input id="rs-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
        </div>
        <p className="text-xs text-ink-3">Times are in the workspace timezone ({tz.replace('_', ' ')}).</p>
        {past && <FormError message="Choose a date and time in the future." />}
      </form>
    </Dialog>
  );
}

export function CalendarView({ kinds = 'followup,task', assignedToId, onOpen, onCreate }: { kinds?: string; assignedToId?: string; onOpen: (e: CalEvent) => void; onCreate?: (day: Date) => void }) {
  const { org } = useOrg();
  const { current } = useWorkspace();
  const orgId = current?.organization.id;
  const qc = useQueryClient();
  const tz = org?.organization.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [mode, setMode] = React.useState<Mode>('month');
  const [cursorKey, setCursorKey] = React.useState(() => formatInTimeZone(new Date(), tz, DAY));
  const cursor = dayDate(cursorKey);
  const todayKey = formatInTimeZone(new Date(), tz, DAY);
  const [over, setOver] = React.useState<string | null>(null);
  const [resched, setResched] = React.useState<CalEvent | null>(null);
  const [announce, setAnnounce] = React.useState('');
  const pending = React.useRef(new Set<string>());
  const [pendingKeys, setPendingKeys] = React.useState<string[]>([]);
  const [ghost, setGhost] = React.useState<{ e: CalEvent; x: number; y: number } | null>(null);

  const range = React.useMemo(() => {
    let from: Date, to: Date;
    if (mode === 'month') { from = startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 }); to = addDays(endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 }), 1); }
    else if (mode === 'week') { from = startOfWeek(cursor, { weekStartsOn: 1 }); to = addDays(from, 7); }
    else { from = cursor; to = addDays(cursor, 1); }
    return { from, to, fromIso: fromZonedTime(`${format(from, DAY)}T00:00:00`, tz).toISOString(), toIso: fromZonedTime(`${format(to, DAY)}T00:00:00`, tz).toISOString() };
  }, [mode, cursorKey, tz]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = useT(['calendar', kinds, assignedToId, range.fromIso, range.toIso], () => api.get<CalEvent[]>('/calendar', { from: range.fromIso, to: range.toIso, kinds, assignedToId }), { keep: true });
  const events = q.data ?? [];
  const forDay = (key: string) => events.filter((e) => formatInTimeZone(new Date(e.start), tz, DAY) === key);
  const stepNav = (dir: 1 | -1) => setCursorKey(format(mode === 'month' ? addMonths(cursor, dir) : mode === 'week' ? addWeeks(cursor, dir) : addDays(cursor, dir), DAY));
  const title = mode === 'month' ? format(cursor, 'MMMM yyyy') : mode === 'week' ? `${format(range.from, 'MMM d')} – ${format(addDays(range.to, -1), 'MMM d, yyyy')}` : format(cursor, 'EEEE, MMMM d, yyyy');
  const days = eachDayOfInterval({ start: range.from, end: addDays(range.to, -1) }).map((d) => format(d, DAY));

  const patchCache = (fn: (list: CalEvent[]) => CalEvent[]) => {
    const snap = qc.getQueriesData<CalEvent[]>({ predicate: (k) => k.queryKey[0] === orgId && k.queryKey[1] === 'calendar' });
    qc.setQueriesData<CalEvent[]>({ predicate: (k) => k.queryKey[0] === orgId && k.queryKey[1] === 'calendar' }, (old) => (old ? fn(old) : old));
    return () => { for (const [key, data] of snap) qc.setQueryData(key, data); };
  };
  const refreshAll = () => { qc.invalidateQueries({ predicate: (k) => k.queryKey[0] === orgId }); };

  const move: Mover = async ({ event, date, time }) => {
    const k = keyOf(event);
    if (!event.canReschedule || pending.current.has(k)) return;                          // ignore duplicate drops while a request is in flight
    const targetTime = time ?? formatInTimeZone(new Date(event.start), tz, 'HH:mm');
    const guess = fromZonedTime(`${date}T${targetTime}:00`, tz);
    if (Math.abs(guess.getTime() - new Date(event.start).getTime()) < 1000) return;       // dropped where it already is
    if (guess.getTime() < nowMs() - 60_000) { toast.error('You can only move items to a future date and time.'); return; }
    pending.current.add(k); setPendingKeys([...pending.current]);
    const oldStart = event.start;
    const revert = patchCache((list) => list.map((x) => (keyOf(x) === k ? { ...x, start: guess.toISOString(), overdue: false } : x)));   // optimistic
    try {
      const r = await api.post<{ start: string; changed: boolean }>('/calendar/reschedule', { kind: event.kind, id: event.id, ...(time ? { date, time } : { date }), expectedStart: oldStart });
      const label = formatInTimeZone(new Date(r.start), tz, 'EEE, MMM d · h:mm a');
      setAnnounce(`${event.title} moved to ${label}`);
      toast.success(`Moved to ${label}`, { action: { label: 'Undo', onClick: () => void undo(event, r.start, oldStart) } });
    } catch (err) {
      revert();                                                                              // roll the optimistic change back
      setAnnounce(`Could not move ${event.title}`);
      toast.error(err instanceof ApiError && err.code === 'STALE_EVENT' ? 'Someone else changed this item. The calendar was refreshed.' : errMsg(err));
    } finally { pending.current.delete(k); setPendingKeys([...pending.current]); refreshAll(); }
  };
  const undo = async (event: CalEvent, current: string, back: string) => {
    try { await api.post('/calendar/reschedule', { kind: event.kind, id: event.id, start: back, expectedStart: current }); toast.success('Move undone'); } catch (err) { toast.error(errMsg(err)); } finally { refreshAll(); }
  };

  // keyboard alternative to dragging: Alt+←/→ = ±1 day, Alt+↑/↓ = ±1 week (±30 min in day view)
  const keyStep = (e: CalEvent, key: string): Move | null => {
    const start = new Date(e.start);
    const dayKey = formatInTimeZone(start, tz, DAY);
    if (mode === 'day' && (key === 'ArrowUp' || key === 'ArrowDown')) {
      const t = fromZonedTime(`${dayKey}T${formatInTimeZone(start, tz, 'HH:mm')}:00`, tz).getTime() + (key === 'ArrowDown' ? 1 : -1) * 30 * 60_000;
      return { event: e, date: formatInTimeZone(new Date(t), tz, DAY), time: formatInTimeZone(new Date(t), tz, 'HH:mm') };
    }
    const delta = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : key === 'ArrowUp' ? -7 : 7;
    return { event: e, date: format(addDays(dayDate(dayKey), delta), DAY) };
  };

  // touch: long-press a chip, drag, release over a day / time slot
  const startDrag = (e: CalEvent, ev: React.PointerEvent) => {
    const sx = ev.clientX, sy = ev.clientY; let active = false;
    const t = window.setTimeout(() => { active = true; setGhost({ e, x: sx, y: sy }); }, 380);
    const moveH = (p: PointerEvent) => {
      if (!active) { if (Math.hypot(p.clientX - sx, p.clientY - sy) > 8) cleanup(); return; }
      setGhost({ e, x: p.clientX, y: p.clientY });
      setOver(document.elementFromPoint(p.clientX, p.clientY)?.closest<HTMLElement>('[data-drop-date]')?.dataset.dropKey ?? null);
    };
    const prevent = (te: TouchEvent) => { if (active) te.preventDefault(); };
    const up = (p: PointerEvent) => {
      const target = active ? document.elementFromPoint(p.clientX, p.clientY)?.closest<HTMLElement>('[data-drop-date]') : null;
      cleanup();
      if (target?.dataset.dropDate) move({ event: e, date: target.dataset.dropDate, time: target.dataset.dropTime });
    };
    const cleanup = () => { window.clearTimeout(t); document.removeEventListener('pointermove', moveH); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', cleanup); document.removeEventListener('touchmove', prevent); setGhost(null); setOver(null); };
    document.addEventListener('pointermove', moveH); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', cleanup); document.addEventListener('touchmove', prevent, { passive: false });
  };

  const dropProps = (date: string, time?: string) => ({
    'data-drop-date': date, 'data-drop-time': time, 'data-drop-key': `${date}${time ?? ''}`,
    onDragOver: (ev: React.DragEvent) => { if (!ev.dataTransfer.types.includes('application/x-leadflow-event')) return; ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; setOver(`${date}${time ?? ''}`); },
    onDragLeave: () => setOver((o) => (o === `${date}${time ?? ''}` ? null : o)),
    onDrop: (ev: React.DragEvent) => {
      ev.preventDefault(); setOver(null);
      const ev0 = dragged; dragged = undefined;
      const raw = ev.dataTransfer.getData('application/x-leadflow-event'); if (!ev0 || !raw) return;
      move({ event: ev0, date, time });
    },
  });
  const chip = (e: CalEvent, compact?: boolean) => (
    <Chip key={keyOf(e)} e={e} tz={tz} compact={compact} onOpen={onOpen} onMove={move} onReschedule={setResched} startDrag={startDrag} dragging={pendingKeys.includes(keyOf(e)) || ghost?.e === e} step={keyStep} />
  );
  const hl = (key: string) => (over === key ? 'bg-accent-soft/60 ring-1 ring-inset ring-accent/40' : '');

  return (
    <div>
      <div className="sr-only" role="status" aria-live="polite">{announce}</div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button size="iconSm" variant="secondary" aria-label="Previous" onClick={() => stepNav(-1)}><ChevronLeft className="size-4" /></Button>
          <Button size="iconSm" variant="secondary" aria-label="Next" onClick={() => stepNav(1)}><ChevronRight className="size-4" /></Button>
          <Button size="sm" onClick={() => setCursorKey(todayKey)}>Today</Button>
          <h2 className="ml-1 text-[15px] font-semibold" aria-live="polite">{title}</h2>
        </div>
        <div role="tablist" aria-label="Calendar view" className="flex rounded-lg bg-subtle p-0.5">
          {(['day', 'week', 'month'] as Mode[]).map((m) => <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={cn('rounded-md px-3 py-1 text-xs font-medium capitalize', mode === m ? 'bg-surface shadow-card' : 'text-ink-2 hover:text-ink')}>{m}</button>)}
        </div>
      </div>

      {q.isLoading ? <Skeleton className="h-[520px]" /> : mode === 'month' ? (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <div className="grid grid-cols-7 border-b border-line bg-subtle/60 text-center text-[11px] font-medium uppercase tracking-wide text-ink-3">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="py-2">{d}</div>)}</div>
          <div className="grid grid-cols-7" data-testid="calendar-month">
            {days.map((k) => {
              const d = dayDate(k); const ev = forDay(k); const inMonth = format(d, 'yyyy-MM') === format(cursor, 'yyyy-MM');
              return (
                <div key={k} data-testid={`cal-day-${k}`} {...dropProps(k)} className={cn('min-h-[96px] border-b border-r border-line p-1.5 transition-colors max-sm:min-h-[64px] [&:nth-child(7n)]:border-r-0', !inMonth && 'bg-subtle/50', hl(k))} onClick={() => { setCursorKey(k); setMode('day'); }}>
                  <div className="mb-1 flex items-center justify-between">
                    <span className={cn('tnum flex size-6 items-center justify-center rounded-full text-xs', k === todayKey ? 'bg-accent font-semibold text-white' : inMonth ? 'text-ink' : 'text-ink-3')}>{format(d, 'd')}</span>
                    {onCreate && <button type="button" aria-label={`Add on ${format(d, 'MMM d')}`} onClick={(e) => { e.stopPropagation(); onCreate(d); }} className="rounded px-1 text-xs text-ink-3 opacity-0 hover:bg-subtle hover:text-ink focus-visible:opacity-100 [div:hover>div>&]:opacity-100">+</button>}
                  </div>
                  <div className="space-y-0.5">{ev.slice(0, 3).map((e) => chip(e, true))}{ev.length > 3 && <p className="px-1 text-[11px] text-ink-3">+{ev.length - 3} more</p>}</div>
                </div>
              );
            })}
          </div>
        </div>
      ) : mode === 'week' ? (
        <div className="grid gap-2 md:grid-cols-7" data-testid="calendar-week">
          {days.map((k) => (
            <div key={k} data-testid={`cal-day-${k}`} {...dropProps(k)} className={cn('min-h-[200px] rounded-xl border bg-surface p-2 transition-colors', k === todayKey ? 'border-accent/50' : 'border-line', hl(k))}>
              <button type="button" className="mb-2 flex w-full items-center justify-between text-left" onClick={() => { setCursorKey(k); setMode('day'); }}><span className="text-xs font-medium text-ink-2">{format(dayDate(k), 'EEE')}</span><span className={cn('tnum flex size-6 items-center justify-center rounded-full text-xs', k === todayKey ? 'bg-accent font-semibold text-white' : 'text-ink')}>{format(dayDate(k), 'd')}</span></button>
              <div className="space-y-1">{forDay(k).map((e) => chip(e))}{forDay(k).length === 0 && <p className="pt-4 text-center text-[11px] text-ink-3">—</p>}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface" data-testid="calendar-day">
          {Array.from({ length: (SLOT_LAST - SLOT_FIRST + 1) * 2 }, (_, i) => ({ h: SLOT_FIRST + Math.floor(i / 2), m: (i % 2) * 30 })).map(({ h, m }) => {
            const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
            const slot = events.filter((e) => { const t = formatInTimeZone(new Date(e.start), tz, 'HH:mm'); const mins = Number(t.slice(0, 2)) * 60 + Number(t.slice(3)); return mins >= h * 60 + m && mins < h * 60 + m + 30 && formatInTimeZone(new Date(e.start), tz, DAY) === cursorKey; });
            return (
              <div key={time} data-testid={`cal-slot-${time}`} {...dropProps(cursorKey, time)} className={cn('flex min-h-[40px] border-b border-line transition-colors last:border-b-0', hl(`${cursorKey}${time}`))}>
                <div className="tnum w-16 shrink-0 border-r border-line bg-subtle/50 px-2 py-1.5 text-right text-[11px] text-ink-3">{m === 0 ? format(new Date(2000, 0, 1, h), 'h a') : ''}</div>
                <div className="flex-1 space-y-1 p-1">{slot.map((e) => chip(e))}</div>
              </div>
            );
          })}
          {(() => {
            const outside = events.filter((e) => { const h = Number(formatInTimeZone(new Date(e.start), tz, 'H')); return formatInTimeZone(new Date(e.start), tz, DAY) === cursorKey && (h < SLOT_FIRST || h > SLOT_LAST); });
            return outside.length > 0 ? <div className="border-t border-line p-2"><p className="mb-1 text-[11px] text-ink-3">Outside working hours</p><div className="space-y-1">{outside.map((e) => chip(e))}</div></div> : null;
          })()}
        </div>
      )}
      <p className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-ink-3"><span className="inline-flex items-center gap-1"><i className="size-2 rounded-sm bg-accent-soft ring-1 ring-accent/30" />Follow-up</span><span className="inline-flex items-center gap-1"><i className="size-2 rounded-sm bg-warn-soft ring-1 ring-warn/30" />Task</span><span className="inline-flex items-center gap-1"><i className="size-2 rounded-sm bg-bad-soft ring-1 ring-bad/30" />Overdue</span><span>Drag an item to another day{mode === 'day' ? ' or time' : ''} (long-press on touch screens), use the pencil button, or press Alt + arrow keys on a focused item. Times use the workspace timezone ({tz.replace('_', ' ')}).</span></p>
      {ghost && <div className="pointer-events-none fixed z-[60] max-w-[200px] -translate-x-1/2 -translate-y-1/2 truncate rounded-md bg-ink px-2 py-1 text-[11px] text-white shadow-pop" style={{ left: ghost.x, top: ghost.y - 28 }}>{ghost.e.title.split(' · ')[0]}</div>}
      <RescheduleEventDialog event={resched} tz={tz} busy={!!resched && pendingKeys.includes(keyOf(resched))} onClose={() => setResched(null)} onSubmit={(date, time) => { const e = resched!; setResched(null); move({ event: e, date, time }); }} />
    </div>
  );
}
