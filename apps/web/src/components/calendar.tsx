'use client';
import * as React from 'react';
import { addDays, addMonths, addWeeks, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, isToday, startOfMonth, startOfWeek } from 'date-fns';
import { CalendarClock, CheckSquare, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/session';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/data';

export interface CalEvent { id: string; kind: 'followup' | 'task'; title: string; start: string; status: string; overdue: boolean; priority: string; type: string; leadId: string | null; assignee: { name: string } | null }
type Mode = 'month' | 'week' | 'day';

const chipTone = (e: CalEvent) => e.status === 'COMPLETED' || e.status === 'DONE' ? 'bg-ok-soft text-ok line-through decoration-ok/40' : e.overdue ? 'bg-bad-soft text-bad' : e.kind === 'task' ? 'bg-warn-soft text-warn' : 'bg-accent-soft text-accent-ink';

function Chip({ e, onOpen, compact }: { e: CalEvent; onOpen: (e: CalEvent) => void; compact?: boolean }) {
  return (
    <button type="button" onClick={(ev) => { ev.stopPropagation(); onOpen(e); }} title={`${format(new Date(e.start), 'p')} · ${e.title}${e.assignee ? ` · ${e.assignee.name}` : ''}`}
      className={cn('flex w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-left text-[11px] font-medium', chipTone(e))}>
      {e.kind === 'task' ? <CheckSquare className="size-3 shrink-0" /> : <CalendarClock className="size-3 shrink-0" />}
      <span className="tnum shrink-0 opacity-70">{format(new Date(e.start), 'h:mma').toLowerCase()}</span>
      <span className="truncate">{compact ? e.title.split(' · ')[0] : e.title}</span>
    </button>
  );
}

export function CalendarView({ kinds = 'followup,task', assignedToId, onOpen, onCreate }: { kinds?: string; assignedToId?: string; onOpen: (e: CalEvent) => void; onCreate?: (day: Date) => void }) {
  const [mode, setMode] = React.useState<Mode>('month');
  const [cursor, setCursor] = React.useState(() => new Date());
  const range = React.useMemo(() => {
    if (mode === 'month') return { from: startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 }), to: addDays(endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 }), 1) };
    if (mode === 'week') { const s = startOfWeek(cursor, { weekStartsOn: 1 }); return { from: s, to: addDays(s, 7) }; }
    const s = new Date(cursor); s.setHours(0, 0, 0, 0); return { from: s, to: addDays(s, 1) };
  }, [mode, cursor]);
  const q = useT(['calendar', kinds, assignedToId, range.from.toISOString(), range.to.toISOString()], () => api.get<CalEvent[]>('/calendar', { from: range.from.toISOString(), to: range.to.toISOString(), kinds, assignedToId }), { keep: true });
  const events = q.data ?? [];
  const forDay = (d: Date) => events.filter((e) => isSameDay(new Date(e.start), d));
  const step = (dir: 1 | -1) => setCursor(mode === 'month' ? addMonths(cursor, dir) : mode === 'week' ? addWeeks(cursor, dir) : addDays(cursor, dir));
  const title = mode === 'month' ? format(cursor, 'MMMM yyyy') : mode === 'week' ? `${format(range.from, 'MMM d')} – ${format(addDays(range.to, -1), 'MMM d, yyyy')}` : format(cursor, 'EEEE, MMMM d, yyyy');
  const days = eachDayOfInterval({ start: range.from, end: addDays(range.to, -1) });

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button size="iconSm" variant="secondary" aria-label="Previous" onClick={() => step(-1)}><ChevronLeft className="size-4" /></Button>
          <Button size="iconSm" variant="secondary" aria-label="Next" onClick={() => step(1)}><ChevronRight className="size-4" /></Button>
          <Button size="sm" onClick={() => setCursor(new Date())}>Today</Button>
          <h2 className="ml-1 text-[15px] font-semibold" aria-live="polite">{title}</h2>
        </div>
        <div role="tablist" aria-label="Calendar view" className="flex rounded-lg bg-subtle p-0.5">
          {(['day', 'week', 'month'] as Mode[]).map((m) => <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={cn('rounded-md px-3 py-1 text-xs font-medium capitalize', mode === m ? 'bg-surface shadow-card' : 'text-ink-2')}>{m}</button>)}
        </div>
      </div>

      {q.isLoading ? <Skeleton className="h-[520px]" /> : mode === 'month' ? (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <div className="grid grid-cols-7 border-b border-line bg-subtle/60 text-center text-[11px] font-medium uppercase tracking-wide text-ink-3">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="py-2">{d}</div>)}</div>
          <div className="grid grid-cols-7" data-testid="calendar-month">
            {days.map((d) => {
              const ev = forDay(d);
              return (
                <div key={d.toISOString()} className={cn('min-h-[96px] border-b border-r border-line p-1.5 max-sm:min-h-[64px] [&:nth-child(7n)]:border-r-0', !isSameMonth(d, cursor) && 'bg-subtle/50')} onClick={() => { setCursor(d); setMode('day'); }}>
                  <div className="mb-1 flex items-center justify-between">
                    <span className={cn('tnum flex size-6 items-center justify-center rounded-full text-xs', isToday(d) ? 'bg-accent font-semibold text-white' : isSameMonth(d, cursor) ? 'text-ink' : 'text-ink-3')}>{format(d, 'd')}</span>
                    {onCreate && <button type="button" aria-label={`Add on ${format(d, 'MMM d')}`} onClick={(e) => { e.stopPropagation(); onCreate(d); }} className="rounded px-1 text-xs text-ink-3 opacity-0 hover:bg-subtle hover:text-ink [div:hover>div>&]:opacity-100">+</button>}
                  </div>
                  <div className="space-y-0.5">{ev.slice(0, 3).map((e) => <Chip key={`${e.kind}${e.id}`} e={e} onOpen={onOpen} compact />)}{ev.length > 3 && <p className="px-1 text-[11px] text-ink-3">+{ev.length - 3} more</p>}</div>
                </div>
              );
            })}
          </div>
        </div>
      ) : mode === 'week' ? (
        <div className="grid gap-2 md:grid-cols-7" data-testid="calendar-week">
          {days.map((d) => (
            <div key={d.toISOString()} className={cn('min-h-[200px] rounded-xl border bg-surface p-2', isToday(d) ? 'border-accent/50' : 'border-line')}>
              <button type="button" className="mb-2 flex w-full items-center justify-between text-left" onClick={() => { setCursor(d); setMode('day'); }}><span className="text-xs font-medium text-ink-2">{format(d, 'EEE')}</span><span className={cn('tnum flex size-6 items-center justify-center rounded-full text-xs', isToday(d) && 'bg-accent font-semibold text-white')}>{format(d, 'd')}</span></button>
              <div className="space-y-1">{forDay(d).map((e) => <Chip key={`${e.kind}${e.id}`} e={e} onOpen={onOpen} />)}{forDay(d).length === 0 && <p className="pt-4 text-center text-[11px] text-ink-3">—</p>}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface" data-testid="calendar-day">
          {Array.from({ length: 15 }, (_, i) => i + 6).map((h) => {
            const slot = events.filter((e) => new Date(e.start).getHours() === h);
            return (
              <div key={h} className="flex min-h-[48px] border-b border-line last:border-b-0">
                <div className="tnum w-16 shrink-0 border-r border-line bg-subtle/50 px-2 py-2 text-right text-[11px] text-ink-3">{format(new Date(2000, 0, 1, h), 'h a')}</div>
                <div className="flex-1 space-y-1 p-1.5">{slot.map((e) => <Chip key={`${e.kind}${e.id}`} e={e} onOpen={onOpen} />)}</div>
              </div>
            );
          })}
          {events.filter((e) => { const h = new Date(e.start).getHours(); return h < 6 || h > 20; }).length > 0 && <div className="border-t border-line p-2"><p className="mb-1 text-[11px] text-ink-3">Outside working hours</p><div className="space-y-1">{events.filter((e) => { const h = new Date(e.start).getHours(); return h < 6 || h > 20; }).map((e) => <Chip key={`${e.kind}${e.id}`} e={e} onOpen={onOpen} />)}</div></div>}
        </div>
      )}
      <p className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-ink-3"><span className="inline-flex items-center gap-1"><i className="size-2 rounded-sm bg-accent-soft ring-1 ring-accent/30" />Follow-up</span><span className="inline-flex items-center gap-1"><i className="size-2 rounded-sm bg-warn-soft ring-1 ring-warn/30" />Task</span><span className="inline-flex items-center gap-1"><i className="size-2 rounded-sm bg-bad-soft ring-1 ring-bad/30" />Overdue</span><span className="inline-flex items-center gap-1"><i className="size-2 rounded-sm bg-ok-soft ring-1 ring-ok/30" />Completed</span></p>
    </div>
  );
}
