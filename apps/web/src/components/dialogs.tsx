'use client';
import * as React from 'react';
import { addDays, setHours, setMinutes } from 'date-fns';
import { Search, X } from 'lucide-react';
import { FOLLOWUP_OUTCOMES, FOLLOWUP_TYPES, PRIORITIES } from '@leadflow/shared';
import { api } from '@/lib/api';
import { useLostReasons, usePipelines, type Pipeline } from '@/lib/hooks';
import { errMsg, useAct, useOrg, useT } from '@/lib/session';
import { fromLocalInput, toLocalInput } from '@/lib/format';
import { useDebounced } from '@/lib/use-url-state';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/overlay';
import { Field, FormError, Input, Select, Switch, Textarea } from '@/components/ui/form';
import { Avatar, Spinner } from '@/components/ui/data';
import { MemberSelect } from '@/components/filters';
import { followUpIcon } from '@/components/badges';

export interface LeadLite { id: string; name: string; companyName?: string | null; email?: string | null; assignedTo?: { id: string } | null }

// ───── Lead picker (async search) ─────
export function LeadPicker({ value, onChange, invalid }: { value: LeadLite | null; onChange: (l: LeadLite | null) => void; invalid?: boolean }) {
  const [q, setQ] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const dq = useDebounced(q.trim(), 250);
  const res = useT(['lead-picker', dq], () => api.page<LeadLite>('/leads', { q: dq || undefined, pageSize: 8 }), { enabled: open });
  if (value) return <div className="flex h-8 items-center justify-between rounded-md border border-line-strong bg-surface px-2.5 text-[13px]"><span className="flex items-center gap-2 truncate"><Avatar name={value.name} size="xs" />{value.name}{value.companyName && <span className="text-ink-3">· {value.companyName}</span>}</span><button type="button" aria-label="Clear lead" onClick={() => onChange(null)} className="text-ink-3 hover:text-ink"><X className="size-3.5" /></button></div>;
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" />
      <Input value={q} invalid={invalid} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} placeholder="Search a lead by name, email or company…" className="pl-8" aria-label="Lead" />
      {open && (
        <div className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-line bg-surface shadow-pop">
          {res.isLoading ? <div className="flex items-center gap-2 p-3 text-xs text-ink-3"><Spinner /> Searching…</div> : !res.data?.data.length ? <p className="p-3 text-xs text-ink-3">No leads found.</p> : res.data.data.map((l) => (
            <button type="button" key={l.id} onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange(l); setOpen(false); setQ(''); }} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-subtle"><Avatar name={l.name} size="sm" /><span className="min-w-0"><span className="block truncate text-[13px] font-medium">{l.name}</span><span className="block truncate text-xs text-ink-3">{l.companyName ?? l.email}</span></span></button>
          ))}
        </div>
      )}
    </div>
  );
}

const tomorrowTen = () => toLocalInput(setMinutes(setHours(addDays(new Date(), 1), 10), 0));

// ───── Schedule follow-up ─────
export function ScheduleFollowUpDialog({ open, onOpenChange, lead, opportunityId, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; lead?: LeadLite | null; opportunityId?: string; onDone?: () => void }) {
  const [picked, setPicked] = React.useState<LeadLite | null>(null);
  const [f, setF] = React.useState({ type: 'CALL', dueAt: tomorrowTen(), assignedToId: '', priority: 'MEDIUM', notes: '' });
  const [error, setError] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);
  React.useEffect(() => { if (open) { setPicked(lead ?? null); setF({ type: 'CALL', dueAt: tomorrowTen(), assignedToId: lead?.assignedTo?.id ?? '', priority: 'MEDIUM', notes: '' }); setError(null); setDirty(false); } }, [open, lead]);
  const save = useAct(() => api.post('/followups', { leadId: picked!.id, opportunityId, type: f.type, dueAt: fromLocalInput(f.dueAt), assignedToId: f.assignedToId || undefined, priority: f.priority, notes: f.notes || undefined }), { success: 'Follow-up scheduled', onSuccess: () => { onOpenChange(false); onDone?.(); }, onError: (e) => setError(errMsg(e)), silent: true });
  const set = (p: Partial<typeof f>) => { setF({ ...f, ...p }); setDirty(true); };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} dirty={dirty} title="Schedule follow-up" description="Every follow-up has an owner and a due date, so nothing slips."
      footer={<><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!picked || !f.dueAt} onClick={() => save.mutate()}>Schedule</Button></>}>
      <div className="space-y-4">
        <FormError message={error} />
        <Field label="Lead" required>{lead ? <div className="flex h-8 items-center gap-2 rounded-md border border-line bg-subtle px-2.5 text-[13px]"><Avatar name={lead.name} size="xs" />{lead.name}</div> : <LeadPicker value={picked} onChange={setPicked} />}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type" required htmlFor="fu-type"><Select id="fu-type" value={f.type} onChange={(e) => set({ type: e.target.value })}>{FOLLOWUP_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select></Field>
          <Field label="Due date & time" required htmlFor="fu-due"><Input id="fu-due" type="datetime-local" value={f.dueAt} min={toLocalInput(new Date())} onChange={(e) => set({ dueAt: e.target.value })} /></Field>
          <Field label="Responsible salesperson" htmlFor="fu-asg" hint="Defaults to the lead owner."><MemberSelect id="fu-asg" allowEmpty placeholder="Lead owner / me" value={f.assignedToId} onChange={(v) => set({ assignedToId: v })} /></Field>
          <Field label="Priority" htmlFor="fu-pri"><Select id="fu-pri" value={f.priority} onChange={(e) => set({ priority: e.target.value })}>{PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select></Field>
        </div>
        <Field label="Notes" htmlFor="fu-notes"><Textarea id="fu-notes" value={f.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="What should be covered?" /></Field>
      </div>
    </Dialog>
  );
}

// ───── Complete follow-up (never silent) ─────
export function CompleteFollowUpDialog({ followUp, onOpenChange, onDone }: { followUp: { id: string; type: string; lead: { name: string } } | null; onOpenChange: (o: boolean) => void; onDone?: () => void }) {
  const [outcome, setOutcome] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [next, setNext] = React.useState(false);
  const [nextDue, setNextDue] = React.useState(tomorrowTen());
  const [nextType, setNextType] = React.useState('CALL');
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => { if (followUp) { setOutcome(''); setNotes(''); setNext(false); setNextDue(tomorrowTen()); setNextType(followUp.type); setError(null); } }, [followUp]);
  const save = useAct(() => api.post(`/followups/${followUp!.id}/complete`, { outcome, outcomeNotes: notes || undefined, next: next ? { dueAt: fromLocalInput(nextDue), type: nextType } : undefined }), { success: 'Follow-up completed', silent: true, onSuccess: () => { onOpenChange(false); onDone?.(); }, onError: (e) => setError(errMsg(e)) });
  return (
    <Dialog open={!!followUp} onOpenChange={onOpenChange} title="Complete follow-up" description={followUp ? `${followUp.lead.name} · outcome and notes are recorded with your name and the time.` : undefined}
      footer={<><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" disabled={!outcome} loading={save.isPending} onClick={() => save.mutate()}>Mark completed</Button></>}>
      <div className="space-y-4">
        <FormError message={error} />
        <fieldset>
          <legend className="mb-1.5 text-xs font-medium text-ink-2">Outcome <span className="text-bad">*</span></legend>
          <div className="flex flex-wrap gap-1.5">{FOLLOWUP_OUTCOMES.map((o) => <button key={o.value} type="button" aria-pressed={outcome === o.value} onClick={() => setOutcome(o.value)} className={cn('rounded-full border px-3 py-1 text-xs transition-colors', outcome === o.value ? 'border-accent bg-accent-soft font-medium text-accent-ink' : 'border-line text-ink-2 hover:bg-subtle')}>{o.label}</button>)}</div>
        </fieldset>
        <Field label="Notes" htmlFor="cf-notes"><Textarea id="cf-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was discussed? Any commitments?" /></Field>
        <div className="rounded-lg border border-line p-3">
          <label className="flex items-center justify-between text-[13px] font-medium">Schedule the next follow-up<Switch aria-label="Schedule next follow-up" checked={next} onCheckedChange={setNext} /></label>
          {next && <div className="mt-3 grid gap-3 sm:grid-cols-2"><Field label="Type"><Select aria-label="Next type" value={nextType} onChange={(e) => setNextType(e.target.value)}>{FOLLOWUP_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select></Field><Field label="Due"><Input aria-label="Next due" type="datetime-local" value={nextDue} min={toLocalInput(new Date())} onChange={(e) => setNextDue(e.target.value)} /></Field></div>}
        </div>
      </div>
    </Dialog>
  );
}

export function RescheduleDialog({ followUp, onOpenChange }: { followUp: { id: string; dueAt: string } | null; onOpenChange: (o: boolean) => void }) {
  const [due, setDue] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => { if (followUp) { setDue(tomorrowTen()); setReason(''); setError(null); } }, [followUp]);
  const save = useAct(() => api.post(`/followups/${followUp!.id}/reschedule`, { dueAt: fromLocalInput(due), reason: reason || undefined }), { success: 'Follow-up rescheduled', silent: true, onSuccess: () => onOpenChange(false), onError: (e) => setError(errMsg(e)) });
  return (
    <Dialog open={!!followUp} onOpenChange={onOpenChange} size="sm" title="Reschedule follow-up" description="The original time stays in the follow-up history."
      footer={<><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Reschedule</Button></>}>
      <div className="space-y-4"><FormError message={error} /><Field label="New date & time" required><Input aria-label="New date and time" type="datetime-local" value={due} min={toLocalInput(new Date())} onChange={(e) => setDue(e.target.value)} /></Field><Field label="Reason"><Input aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" /></Field></div>
    </Dialog>
  );
}

export function CancelFollowUpDialog({ followUp, onOpenChange }: { followUp: { id: string } | null; onOpenChange: (o: boolean) => void }) {
  const [reason, setReason] = React.useState('');
  React.useEffect(() => { if (followUp) setReason(''); }, [followUp]);
  const save = useAct(() => api.post(`/followups/${followUp!.id}/cancel`, { reason: reason || undefined }), { success: 'Follow-up canceled', onSuccess: () => onOpenChange(false) });
  return (
    <Dialog open={!!followUp} onOpenChange={onOpenChange} size="sm" title="Cancel follow-up" description="It stays in the history marked as canceled."
      footer={<><Button onClick={() => onOpenChange(false)}>Keep it</Button><Button variant="danger" loading={save.isPending} onClick={() => save.mutate()}>Cancel follow-up</Button></>}>
      <Field label="Reason"><Input aria-label="Cancel reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" /></Field>
    </Dialog>
  );
}

// ───── Log call / email / WhatsApp / meeting / note ─────
const ACT_TYPES = [['CALL', 'Call'], ['EMAIL', 'Email'], ['WHATSAPP', 'WhatsApp'], ['MEETING', 'Meeting'], ['NOTE', 'Note']] as const;
export function LogActivityDialog({ open, onOpenChange, leadId, leadName, initialType = 'CALL' }: { open: boolean; onOpenChange: (o: boolean) => void; leadId: string; leadName?: string; initialType?: string }) {
  const [type, setType] = React.useState(initialType);
  const [body, setBody] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [when, setWhen] = React.useState(toLocalInput(new Date()));
  const [direction, setDirection] = React.useState('OUTBOUND');
  const [duration, setDuration] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => { if (open) { setType(initialType); setBody(''); setTitle(''); setWhen(toLocalInput(new Date())); setDirection('OUTBOUND'); setDuration(''); setError(null); } }, [open, initialType]);
  const save = useAct(() => api.post(`/leads/${leadId}/activities`, { type, body: body || undefined, title: title || undefined, occurredAt: fromLocalInput(when), direction: type !== 'NOTE' && type !== 'MEETING' ? direction : undefined, durationMinutes: duration && (type === 'CALL' || type === 'MEETING') ? Number(duration) : undefined }), { success: 'Activity logged', silent: true, onSuccess: () => onOpenChange(false), onError: (e) => setError(errMsg(e)) });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} dirty={!!body} title="Log activity" description={leadName ? `Record an interaction with ${leadName}. Nothing is sent — this only adds to the timeline.` : 'Record an interaction.'}
      footer={<><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={type === 'NOTE' && !body.trim()} onClick={() => save.mutate()}>Save to timeline</Button></>}>
      <div className="space-y-4">
        <FormError message={error} />
        <div role="tablist" aria-label="Activity type" className="grid grid-cols-5 gap-1 rounded-lg bg-subtle p-1">{ACT_TYPES.map(([v, l]) => <button key={v} role="tab" aria-selected={type === v} type="button" onClick={() => setType(v)} className={cn('flex flex-col items-center gap-0.5 rounded-md py-1.5 text-[11px] font-medium transition-colors', type === v ? 'bg-surface text-ink shadow-card' : 'text-ink-2 hover:text-ink')}>{followUpIcon(v, 'size-3.5')}{l}</button>)}</div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="When" htmlFor="la-when"><Input id="la-when" type="datetime-local" value={when} max={toLocalInput(new Date(Date.now() + 5 * 60_000))} onChange={(e) => setWhen(e.target.value)} /></Field>
          {(type === 'CALL' || type === 'EMAIL' || type === 'WHATSAPP') && <Field label="Direction"><Select aria-label="Direction" value={direction} onChange={(e) => setDirection(e.target.value)}><option value="OUTBOUND">Outbound (we reached out)</option><option value="INBOUND">Inbound (they reached out)</option></Select></Field>}
          {(type === 'CALL' || type === 'MEETING') && <Field label="Duration (minutes)"><Input aria-label="Duration" type="number" min={0} value={duration} onChange={(e) => setDuration(e.target.value)} /></Field>}
        </div>
        <Field label="Summary"><Input aria-label="Summary" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={type === 'NOTE' ? 'Optional headline' : 'e.g. Discussed pricing options'} /></Field>
        <Field label={type === 'NOTE' ? 'Note' : 'Details'} required={type === 'NOTE'}><Textarea aria-label="Details" value={body} onChange={(e) => setBody(e.target.value)} placeholder="What was said or decided?" /></Field>
      </div>
    </Dialog>
  );
}

// ───── Assign / lost reason ─────
export function AssignDialog({ open, onOpenChange, title = 'Assign lead', current, onConfirm, loading }: { open: boolean; onOpenChange: (o: boolean) => void; title?: string; current?: string | null; onConfirm: (userId: string | null, note?: string) => void; loading?: boolean }) {
  const [user, setUser] = React.useState('');
  const [note, setNote] = React.useState('');
  React.useEffect(() => { if (open) { setUser(current ?? ''); setNote(''); } }, [open, current]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="sm" title={title} description="Assignments are recorded in the lead's history and the new owner is notified."
      footer={<><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={loading} onClick={() => onConfirm(user || null, note || undefined)}>{user ? 'Assign' : 'Unassign'}</Button></>}>
      <div className="space-y-4"><Field label="Assign to"><MemberSelect aria-label="Assign to" includeUnassigned value={user} onChange={setUser} /></Field><Field label="Note"><Input aria-label="Assignment note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" /></Field></div>
    </Dialog>
  );
}

export function LostReasonDialog({ open, onOpenChange, onConfirm, loading, title = 'Mark as lost' }: { open: boolean; onOpenChange: (o: boolean) => void; onConfirm: (reasonId: string, note?: string) => void; loading?: boolean; title?: string }) {
  const reasons = useLostReasons();
  const [reason, setReason] = React.useState('');
  const [note, setNote] = React.useState('');
  React.useEffect(() => { if (open) { setReason(''); setNote(''); } }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="sm" title={title} description="Recording why deals are lost powers the Lost Lead report."
      footer={<><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="danger" disabled={!reason} loading={loading} onClick={() => onConfirm(reason, note || undefined)}>Confirm lost</Button></>}>
      <div className="space-y-4"><Field label="Lost reason" required><Select aria-label="Lost reason" value={reason} onChange={(e) => setReason(e.target.value)}><option value="">Select a reason…</option>{reasons.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field><Field label="Details"><Textarea aria-label="Lost details" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional context" /></Field></div>
    </Dialog>
  );
}

// ───── Opportunity ─────
export interface OppEditable { id: string; name: string; value: number; expectedCloseDate: string | null; notes: string | null; owner?: { id: string } | null }
export function OpportunityDialog({ open, onOpenChange, lead, opp }: { open: boolean; onOpenChange: (o: boolean) => void; lead?: LeadLite | null; opp?: OppEditable | null }) {
  const { currency } = useOrg();
  const pipelines = usePipelines();
  const [picked, setPicked] = React.useState<LeadLite | null>(null);
  const [f, setF] = React.useState({ name: '', value: '', expectedCloseDate: '', pipelineId: '', stageId: '', ownerId: '', notes: '' });
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    setPicked(lead ?? null); setError(null);
    setF(opp ? { name: opp.name, value: String(opp.value), expectedCloseDate: opp.expectedCloseDate?.slice(0, 10) ?? '', pipelineId: '', stageId: '', ownerId: opp.owner?.id ?? '', notes: opp.notes ?? '' } : { name: lead ? `${lead.name}${lead.companyName ? ` — ${lead.companyName}` : ''}` : '', value: '', expectedCloseDate: '', pipelineId: '', stageId: '', ownerId: '', notes: '' });
  }, [open, lead, opp]);
  const pipe: Pipeline | undefined = pipelines.data?.find((p) => p.id === f.pipelineId) ?? pipelines.data?.find((p) => p.isDefault) ?? pipelines.data?.[0];
  const save = useAct(() => opp
    ? api.patch(`/opportunities/${opp.id}`, { name: f.name, value: Number(f.value || 0), expectedCloseDate: f.expectedCloseDate || null, ownerId: f.ownerId || undefined, notes: f.notes || null })
    : api.post('/opportunities', { leadId: picked!.id, name: f.name, value: Number(f.value || 0), expectedCloseDate: f.expectedCloseDate || undefined, pipelineId: pipe?.id, stageId: f.stageId || undefined, ownerId: f.ownerId || undefined, notes: f.notes || undefined }),
  { success: opp ? 'Opportunity updated' : 'Opportunity created', silent: true, onSuccess: () => onOpenChange(false), onError: (e) => setError(errMsg(e)) });
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} dirty={!!f.name && !opp && false} title={opp ? 'Edit opportunity' : 'New opportunity'} description="An opportunity is a specific deal. One lead can have several."
      footer={<><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!f.name.trim() || (!opp && !picked)} onClick={() => save.mutate()}>{opp ? 'Save' : 'Create opportunity'}</Button></>}>
      <div className="space-y-4">
        <FormError message={error} />
        {!opp && <Field label="Lead" required>{lead ? <div className="flex h-8 items-center gap-2 rounded-md border border-line bg-subtle px-2.5 text-[13px]"><Avatar name={lead.name} size="xs" />{lead.name}</div> : <LeadPicker value={picked} onChange={(l) => { setPicked(l); if (l && !f.name) set({ name: l.name }); }} />}</Field>}
        <Field label="Deal name" required htmlFor="op-name"><Input id="op-name" value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={`Expected value (${currency})`} htmlFor="op-val"><Input id="op-val" type="number" min={0} step="0.01" value={f.value} onChange={(e) => set({ value: e.target.value })} /></Field>
          <Field label="Expected closing date" htmlFor="op-close"><Input id="op-close" type="date" value={f.expectedCloseDate} onChange={(e) => set({ expectedCloseDate: e.target.value })} /></Field>
          {!opp && (pipelines.data?.length ?? 0) > 1 && <Field label="Pipeline"><Select aria-label="Pipeline" value={pipe?.id ?? ''} onChange={(e) => set({ pipelineId: e.target.value, stageId: '' })}>{pipelines.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>}
          {!opp && pipe && <Field label="Starting stage"><Select aria-label="Starting stage" value={f.stageId} onChange={(e) => set({ stageId: e.target.value })}><option value="">{pipe.stages.find((s) => s.kind === 'OPEN')?.name} (default)</option>{pipe.stages.filter((s) => s.kind === 'OPEN').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>}
          <Field label="Owner" htmlFor="op-owner"><MemberSelect id="op-owner" allowEmpty placeholder="Lead owner / me" value={f.ownerId} onChange={(v) => set({ ownerId: v })} /></Field>
        </div>
        <Field label="Notes"><Textarea aria-label="Notes" value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

// ───── Task ─────
export interface TaskEditable { id: string; title: string; description: string | null; priority: string; dueAt: string | null; assignedTo?: { id: string } | null; lead?: { id: string; name: string } | null }
export function TaskDialog({ open, onOpenChange, task, lead, opportunityId }: { open: boolean; onOpenChange: (o: boolean) => void; task?: TaskEditable | null; lead?: LeadLite | null; opportunityId?: string }) {
  const [picked, setPicked] = React.useState<LeadLite | null>(null);
  const [f, setF] = React.useState({ title: '', description: '', priority: 'MEDIUM', dueAt: '', assignedToId: '' });
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    setError(null);
    setPicked(task?.lead ? { id: task.lead.id, name: task.lead.name } : lead ?? null);
    setF(task ? { title: task.title, description: task.description ?? '', priority: task.priority, dueAt: task.dueAt ? toLocalInput(task.dueAt) : '', assignedToId: task.assignedTo?.id ?? '' } : { title: '', description: '', priority: 'MEDIUM', dueAt: toLocalInput(setMinutes(setHours(addDays(new Date(), 1), 17), 0)), assignedToId: '' });
  }, [open, task, lead]);
  const save = useAct(() => {
    const body = { title: f.title.trim(), description: f.description || (task ? null : undefined), priority: f.priority, dueAt: f.dueAt ? fromLocalInput(f.dueAt) : null, assignedToId: f.assignedToId || undefined };
    return task ? api.patch(`/tasks/${task.id}`, body) : api.post('/tasks', { ...body, leadId: picked?.id, opportunityId });
  }, { success: task ? 'Task updated' : 'Task created', silent: true, onSuccess: () => onOpenChange(false), onError: (e) => setError(errMsg(e)) });
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={task ? 'Edit task' : 'New task'} description="Tasks can be linked to a lead or deal and assigned to anyone on the team."
      footer={<><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!f.title.trim()} onClick={() => save.mutate()}>{task ? 'Save' : 'Create task'}</Button></>}>
      <div className="space-y-4">
        <FormError message={error} />
        <Field label="Title" required htmlFor="tk-title"><Input id="tk-title" autoFocus value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Send revised proposal" /></Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Deadline" htmlFor="tk-due"><Input id="tk-due" type="datetime-local" value={f.dueAt} onChange={(e) => set({ dueAt: e.target.value })} /></Field>
          <Field label="Priority" htmlFor="tk-pri"><Select id="tk-pri" value={f.priority} onChange={(e) => set({ priority: e.target.value })}>{PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select></Field>
          <Field label="Assign to" htmlFor="tk-asg"><MemberSelect id="tk-asg" allowEmpty placeholder="Me" value={f.assignedToId} onChange={(v) => set({ assignedToId: v })} /></Field>
        </div>
        <Field label="Linked lead">{lead || task ? <div className="flex h-8 items-center rounded-md border border-line bg-subtle px-2.5 text-[13px]">{picked?.name ?? 'None'}</div> : <LeadPicker value={picked} onChange={setPicked} />}</Field>
        <Field label="Description" htmlFor="tk-desc"><Textarea id="tk-desc" value={f.description} onChange={(e) => set({ description: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}
