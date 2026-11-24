'use client';
import * as React from 'react';
import { Bell, ListChecks, Lock, Pencil, Plus, RotateCcw, Trash2, Workflow, Zap } from 'lucide-react';
import { AUTOMATION_TRIGGERS } from '@leadflow/shared';
import { api } from '@/lib/api';
import { useMembers, usePriorities, useSources } from '@/lib/hooks';
import { errMsg, useAct, useOrg, useT } from '@/lib/session';
import { fmtDateTime, timeAgo, titleCase } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select, Switch } from '@/components/ui/form';
import { Badge, Card, EmptyState, PageHeader, Pagination, Skeleton } from '@/components/ui/data';
import { Dialog, useConfirm } from '@/components/ui/overlay';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/menu';
import { MemberSelect } from '@/components/filters';
import Link from 'next/link';

type Action = { type: 'NOTIFY'; recipient: 'OWNER' | 'MANAGERS' | 'USER'; userId?: string; message?: string } | { type: 'CREATE_TASK'; title: string; assignee: 'OWNER' | 'MANAGERS' | 'USER'; userId?: string; dueInHours: number; priority: 'LOW' | 'MEDIUM' | 'HIGH' } | { type: 'SET_PRIORITY'; priorityId: string };
interface Rule { id: string; name: string; description: string | null; trigger: string; conditions: { sourceIds?: string[]; priorityIds?: string[]; afterHours?: number; afterDays?: number }; actions: Action[]; isEnabled: boolean; isSystem: boolean; stats: Record<string, number>; lastRunAt: string | null }
interface Exec { id: string; status: string; entityType: string; error: string | null; attempts: number; createdAt: string; finishedAt: string | null; result: { reason?: string; actions?: unknown[] } | null; rule: { id: string; name: string; trigger: string } }

const trig = (v: string) => AUTOMATION_TRIGGERS.find((t) => t.value === v);
const describeAction = (a: Action) => a.type === 'NOTIFY' ? `Notify ${a.recipient === 'OWNER' ? 'the lead owner' : a.recipient === 'MANAGERS' ? 'managers' : 'a specific person'}` : a.type === 'CREATE_TASK' ? `Create task “${a.title}”` : 'Change lead priority';

function RuleDialog({ open, onOpenChange, rule }: { open: boolean; onOpenChange: (o: boolean) => void; rule: Rule | null }) {
  const sources = useSources(), priorities = usePriorities();
  const [f, setF] = React.useState({ name: '', description: '', trigger: 'LEAD_CREATED', afterHours: '24', afterDays: '7', sourceIds: [] as string[], priorityIds: [] as string[], actions: [] as Action[] });
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return; setError(null);
    setF(rule ? { name: rule.name, description: rule.description ?? '', trigger: rule.trigger, afterHours: String(rule.conditions.afterHours ?? 24), afterDays: String(rule.conditions.afterDays ?? 7), sourceIds: rule.conditions.sourceIds ?? [], priorityIds: rule.conditions.priorityIds ?? [], actions: rule.actions }
      : { name: '', description: '', trigger: 'LEAD_CREATED', afterHours: '24', afterDays: '7', sourceIds: [], priorityIds: [], actions: [{ type: 'NOTIFY', recipient: 'MANAGERS' }] });
  }, [open, rule]);
  const t = trig(f.trigger)!;
  const save = useAct(() => {
    const body = { name: f.name, description: f.description || null, trigger: f.trigger, conditions: { sourceIds: f.sourceIds.length ? f.sourceIds : undefined, priorityIds: f.priorityIds.length ? f.priorityIds : undefined, afterHours: f.trigger === 'LEAD_NOT_CONTACTED' ? Number(f.afterHours) : undefined, afterDays: f.trigger === 'LEAD_INACTIVE' ? Number(f.afterDays) : undefined }, actions: f.actions };
    return rule ? api.patch(`/automations/${rule.id}`, body) : api.post('/automations', body);
  }, { success: rule ? 'Automation updated' : 'Automation created', silent: true, onSuccess: () => onOpenChange(false), onError: (e) => setError(errMsg(e)) });
  const setAction = (i: number, a: Action) => setF({ ...f, actions: f.actions.map((x, j) => (j === i ? a : x)) });
  const toggle = (k: 'sourceIds' | 'priorityIds', id: string) => setF({ ...f, [k]: f[k].includes(id) ? f[k].filter((x) => x !== id) : [...f[k], id] });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg" title={rule ? 'Edit automation' : 'New automation'} description="When something happens in your CRM, do something useful automatically."
      footer={<><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!f.name.trim() || !f.actions.length} onClick={() => save.mutate()}>{rule ? 'Save changes' : 'Create automation'}</Button></>}>
      <div className="space-y-5">
        <FormError message={error} />
        <Field label="Name" required htmlFor="au-name"><Input id="au-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Alert managers about hot leads" /></Field>
        <div className="rounded-lg border border-line p-4">
          <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-3"><Zap className="size-3.5" />When</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Trigger"><Select aria-label="Trigger" value={f.trigger} onChange={(e) => setF({ ...f, trigger: e.target.value })}>{AUTOMATION_TRIGGERS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</Select></Field>
            {f.trigger === 'LEAD_NOT_CONTACTED' && <Field label="Wait (hours)"><Input aria-label="Hours" type="number" min={1} value={f.afterHours} onChange={(e) => setF({ ...f, afterHours: e.target.value })} /></Field>}
            {f.trigger === 'LEAD_INACTIVE' && <Field label="Inactive for (days)"><Input aria-label="Days" type="number" min={1} value={f.afterDays} onChange={(e) => setF({ ...f, afterDays: e.target.value })} /></Field>}
          </div>
          {t ? (
            <div className="mt-3 space-y-2"><p className="text-xs text-ink-3">Only when the lead matches (optional)</p>
              <div className="flex flex-wrap gap-1.5">{sources.data?.map((s) => <button key={s.id} type="button" aria-pressed={f.sourceIds.includes(s.id)} onClick={() => toggle('sourceIds', s.id)} className={cn('rounded-full border px-2.5 py-0.5 text-xs', f.sourceIds.includes(s.id) ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line text-ink-2 hover:bg-subtle')}>Source: {s.name}</button>)}</div>
              <div className="flex flex-wrap gap-1.5">{priorities.data?.map((s) => <button key={s.id} type="button" aria-pressed={f.priorityIds.includes(s.id)} onClick={() => toggle('priorityIds', s.id)} className={cn('rounded-full border px-2.5 py-0.5 text-xs', f.priorityIds.includes(s.id) ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line text-ink-2 hover:bg-subtle')}>Priority: {s.name}</button>)}</div></div>
          ) : null}
        </div>
        <div className="rounded-lg border border-line p-4">
          <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-3"><Workflow className="size-3.5" />Then</p>
          <div className="space-y-3">
            {f.actions.map((a, i) => (
              <div key={i} className="rounded-lg bg-subtle/70 p-3">
                <div className="flex gap-2">
                  <div className="w-44 shrink-0"><Select aria-label="Action type" value={a.type} onChange={(e) => setAction(i, e.target.value === 'NOTIFY' ? { type: 'NOTIFY', recipient: 'OWNER' } : e.target.value === 'CREATE_TASK' ? { type: 'CREATE_TASK', title: '', assignee: 'OWNER', dueInHours: 24, priority: 'MEDIUM' } : { type: 'SET_PRIORITY', priorityId: priorities.data?.[0]?.id ?? '' })}><option value="NOTIFY">Send notification</option><option value="CREATE_TASK">Create task</option><option value="SET_PRIORITY">Set lead priority</option></Select></div>
                  <div className="grid flex-1 gap-2 sm:grid-cols-2">
                    {a.type === 'NOTIFY' && <><Select aria-label="Recipient" value={a.recipient} onChange={(e) => setAction(i, { ...a, recipient: e.target.value as never })}><option value="OWNER">Lead owner</option><option value="MANAGERS">All managers</option><option value="USER">Specific person</option></Select>{a.recipient === 'USER' ? <MemberSelect aria-label="Person" allowEmpty placeholder="Choose person…" value={a.userId ?? ''} onChange={(v) => setAction(i, { ...a, userId: v })} /> : <Input aria-label="Message" placeholder="Custom message (optional)" value={a.message ?? ''} onChange={(e) => setAction(i, { ...a, message: e.target.value })} />}</>}
                    {a.type === 'CREATE_TASK' && <><Input aria-label="Task title" className="sm:col-span-2" placeholder="Task title" value={a.title} onChange={(e) => setAction(i, { ...a, title: e.target.value })} /><Select aria-label="Assignee" value={a.assignee} onChange={(e) => setAction(i, { ...a, assignee: e.target.value as never })}><option value="OWNER">Lead owner</option><option value="MANAGERS">A manager</option><option value="USER">Specific person</option></Select>{a.assignee === 'USER' ? <MemberSelect aria-label="Person" allowEmpty placeholder="Choose person…" value={a.userId ?? ''} onChange={(v) => setAction(i, { ...a, userId: v })} /> : <Input aria-label="Due in hours" type="number" min={1} value={a.dueInHours} onChange={(e) => setAction(i, { ...a, dueInHours: Number(e.target.value) })} />}</>}
                    {a.type === 'SET_PRIORITY' && <Select aria-label="Priority" value={a.priorityId} onChange={(e) => setAction(i, { ...a, priorityId: e.target.value })}>{priorities.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}
                  </div>
                  <Button variant="ghost" size="iconSm" aria-label="Remove action" onClick={() => setF({ ...f, actions: f.actions.filter((_, j) => j !== i) })}><Trash2 className="size-3.5" /></Button>
                </div>
              </div>
            ))}
            <Button size="sm" onClick={() => setF({ ...f, actions: [...f.actions, { type: 'NOTIFY', recipient: 'OWNER' }] })}><Plus className="size-3.5" />Add action</Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

interface AssignRule { id: string; name: string; isActive: boolean; position: number; conditions: { sourceIds?: string[]; priorityIds?: string[]; campaignContains?: string; companyContains?: string }; assigneeIds: string[] }
function AssignmentTab() {
  const { can, has, org } = useOrg();
  const confirm = useConfirm();
  const q = useT(['assignment-rules'], () => api.get<{ mode: string; rules: AssignRule[] }>('/assignment-rules'));
  const sources = useSources(); const members = useMembers();
  const [edit, setEdit] = React.useState<AssignRule | 'new' | null>(null);
  const setMode = useAct((mode: string) => api.patch('/organizations/current', { autoAssignMode: mode }), { success: 'Assignment mode updated', invalidate: ['assignment-rules', 'org'] });
  const del = useAct((id: string) => api.del(`/assignment-rules/${id}`), { success: 'Rule deleted' });
  const mode = q.data?.mode ?? org?.organization.autoAssignMode ?? 'NONE';
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h3 className="text-[13px] font-semibold">How should new leads be assigned?</h3>
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          {([['NONE', 'Manual', 'Leads stay unassigned until a manager assigns them.', true], ['ROUND_ROBIN', 'Round-robin', 'Share new leads evenly across available salespeople.', true], ['RULES', 'Rule-based', 'Route leads by source, priority, campaign or company.', has('rule_assignment')]] as const).map(([v, t, d, ok]) => (
            <button key={v} type="button" disabled={!can('settings.manage') || !ok} onClick={() => setMode.mutate(v)} aria-pressed={mode === v} className={cn('relative rounded-lg border p-3 text-left disabled:opacity-60', mode === v ? 'border-accent bg-accent-soft' : 'border-line hover:bg-subtle')}><p className="flex items-center gap-1.5 text-[13px] font-medium">{t}{!ok && <Lock className="size-3 text-ink-3" />}</p><p className="mt-0.5 text-xs text-ink-2">{d}</p></button>
          ))}
        </div>
        {!has('rule_assignment') && <p className="mt-2 text-xs text-ink-3">Rule-based assignment needs the Professional plan.</p>}
      </Card>
      {(mode === 'RULES' || q.data?.rules.length) ? (
        <Card>
          <div className="flex items-center justify-between border-b border-line px-4 py-3"><div><h3 className="text-[13px] font-semibold">Assignment rules</h3><p className="text-xs text-ink-3">Evaluated top to bottom; the first match wins. Unmatched leads stay unassigned.</p></div>{can('settings.manage') && has('rule_assignment') && <Button size="sm" variant="primary" onClick={() => setEdit('new')}><Plus className="size-3.5" />Add rule</Button>}</div>
          {!q.data?.rules.length ? <EmptyState className="py-10" title="No rules yet" /> : <ul className="divide-y divide-line">{q.data.rules.map((r, i) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3"><span className="tnum flex size-6 items-center justify-center rounded-full bg-subtle text-xs">{i + 1}</span>
              <div className="min-w-0 flex-1"><p className="text-[13px] font-medium">{r.name}{!r.isActive && <Badge className="ml-2">Paused</Badge>}</p><p className="text-xs text-ink-3">{[r.conditions.sourceIds?.length && `Source in ${r.conditions.sourceIds.map((id) => sources.data?.find((s) => s.id === id)?.name ?? '…').join(', ')}`, r.conditions.priorityIds?.length && `${r.conditions.priorityIds.length} priorities`, r.conditions.campaignContains && `Campaign contains “${r.conditions.campaignContains}”`, r.conditions.companyContains && `Company contains “${r.conditions.companyContains}”`].filter(Boolean).join(' · ') || 'Matches every lead'} → {r.assigneeIds.map((id) => members.data?.find((m) => m.userId === id)?.name ?? '…').join(', ')}</p></div>
              {can('settings.manage') && <div className="flex gap-1.5"><Button size="sm" onClick={() => setEdit(r)}><Pencil className="size-3.5" />Edit</Button><Button size="sm" variant="dangerGhost" onClick={async () => { if (await confirm({ title: 'Delete this rule?', destructive: true, confirmLabel: 'Delete' })) del.mutate(r.id); }}><Trash2 className="size-3.5" /></Button></div>}
            </li>))}</ul>}
        </Card>
      ) : null}
      {edit && <AssignRuleDialog rule={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}
function AssignRuleDialog({ rule, onClose }: { rule: AssignRule | null; onClose: () => void }) {
  const sources = useSources(); const members = useMembers();
  const [f, setF] = React.useState({ name: rule?.name ?? '', sourceIds: rule?.conditions.sourceIds ?? [], campaignContains: rule?.conditions.campaignContains ?? '', companyContains: rule?.conditions.companyContains ?? '', assigneeIds: rule?.assigneeIds ?? [], isActive: rule?.isActive ?? true });
  const [error, setError] = React.useState<string | null>(null);
  const save = useAct(() => { const body = { name: f.name, isActive: f.isActive, assigneeIds: f.assigneeIds, conditions: { sourceIds: f.sourceIds.length ? f.sourceIds : undefined, campaignContains: f.campaignContains || undefined, companyContains: f.companyContains || undefined } }; return rule ? api.patch(`/assignment-rules/${rule.id}`, body) : api.post('/assignment-rules', body); }, { success: 'Rule saved', silent: true, onSuccess: onClose, onError: (e) => setError(errMsg(e)) });
  const tog = (k: 'sourceIds' | 'assigneeIds', id: string) => setF({ ...f, [k]: f[k].includes(id) ? f[k].filter((x) => x !== id) : [...f[k], id] });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={rule ? 'Edit assignment rule' : 'New assignment rule'} description="Matching leads are shared round-robin between the selected people." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!f.name.trim() || !f.assigneeIds.length} onClick={() => save.mutate()}>Save rule</Button></>}>
      <div className="space-y-4"><FormError message={error} /><Field label="Rule name" required><Input aria-label="Rule name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Lead sources (any of)"><div className="flex flex-wrap gap-1.5">{sources.data?.map((s) => <button key={s.id} type="button" aria-pressed={f.sourceIds.includes(s.id)} onClick={() => tog('sourceIds', s.id)} className={cn('rounded-full border px-2.5 py-0.5 text-xs', f.sourceIds.includes(s.id) ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line text-ink-2')}>{s.name}</button>)}</div></Field>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Campaign contains"><Input aria-label="Campaign contains" value={f.campaignContains} onChange={(e) => setF({ ...f, campaignContains: e.target.value })} /></Field><Field label="Company contains"><Input aria-label="Company contains" value={f.companyContains} onChange={(e) => setF({ ...f, companyContains: e.target.value })} /></Field></div>
        <Field label="Assign to (round-robin between)" required><div className="flex flex-wrap gap-1.5">{members.data?.filter((m) => m.status === 'ACTIVE').map((m) => <button key={m.userId} type="button" aria-pressed={f.assigneeIds.includes(m.userId)} onClick={() => tog('assigneeIds', m.userId)} className={cn('rounded-full border px-2.5 py-0.5 text-xs', f.assigneeIds.includes(m.userId) ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line text-ink-2')}>{m.name}</button>)}</div></Field>
        <label className="flex items-center gap-2 text-[13px]"><Switch aria-label="Rule active" checked={f.isActive} onCheckedChange={(v) => setF({ ...f, isActive: v })} />Rule is active</label></div>
    </Dialog>
  );
}

function Executions() {
  const [page, setPage] = React.useState(1);
  const [status, setStatus] = React.useState('');
  const q = useT(['executions', page, status], () => api.page<Exec>('/automations/executions', { page, pageSize: 15, status: status || undefined }), { keep: true });
  const retry = useAct((id: string) => api.post(`/automations/executions/${id}/retry`), { success: 'Retry queued' });
  const tone = (s: string) => (s === 'SUCCESS' ? 'ok' : s === 'FAILED' ? 'bad' : s === 'SKIPPED' ? 'warn' : 'neutral') as 'ok' | 'bad' | 'warn' | 'neutral';
  return (
    <Card>
      <div className="flex items-center justify-between gap-2 border-b border-line p-3"><p className="text-[13px] font-semibold">Execution log</p><div className="w-40"><Select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All statuses</option><option value="SUCCESS">Success</option><option value="FAILED">Failed</option><option value="SKIPPED">Skipped</option><option value="PENDING">Pending</option></Select></div></div>
      {q.isLoading ? <Skeleton className="m-4 h-40" /> : !q.data?.data.length ? <EmptyState icon={<ListChecks />} title="Nothing has run yet" description="Executions appear here as soon as a rule fires." /> : (
        <div className="scroll-thin overflow-x-auto"><table className="w-full min-w-[640px] text-left text-[13px]"><thead><tr className="border-b border-line bg-subtle/60 text-[11px] font-medium uppercase tracking-wide text-ink-3"><th className="px-4 py-2">Rule</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Attempts</th><th className="px-4 py-2">When</th><th className="px-4 py-2">Detail</th><th className="px-4 py-2" /></tr></thead>
          <tbody className="divide-y divide-line">{q.data.data.map((e) => <tr key={e.id}><td className="px-4 py-2 font-medium">{e.rule.name}</td><td className="px-4 py-2"><Badge tone={tone(e.status)}>{titleCase(e.status)}</Badge></td><td className="tnum px-4 py-2">{e.attempts}</td><td className="px-4 py-2 text-xs text-ink-2" title={fmtDateTime(e.createdAt)}>{timeAgo(e.createdAt)}</td><td className="max-w-[260px] truncate px-4 py-2 text-xs text-ink-3">{e.error ?? e.result?.reason ?? (Array.isArray(e.result?.actions) ? `${e.result!.actions!.length} action(s) ran` : '')}</td><td className="px-4 py-2 text-right">{(e.status === 'FAILED' || e.status === 'SKIPPED') && <Button size="sm" onClick={() => retry.mutate(e.id)}><RotateCcw className="size-3.5" />Retry</Button>}</td></tr>)}</tbody></table></div>
      )}
      {(q.data?.meta.total ?? 0) > 0 && <Pagination page={page} pageSize={15} total={q.data!.meta.total} noun="runs" onPage={setPage} />}
    </Card>
  );
}

export default function AutomationsPage() {
  const { can } = useOrg();
  const confirm = useConfirm();
  const q = useT(['automations'], () => api.get<{ featureEnabled: boolean; rules: Rule[] }>('/automations'));
  const [edit, setEdit] = React.useState<Rule | 'new' | null>(null);
  const toggle = useAct((id: string) => api.post(`/automations/${id}/toggle`), { success: 'Automation updated' });
  const del = useAct((id: string) => api.del(`/automations/${id}`), { success: 'Automation deleted' });
  const manage = can('automations.manage');
  return (
    <>
      <PageHeader title="Automations" description="Background rules that notify people and create tasks so no lead goes cold." actions={manage && <Button variant="primary" onClick={() => setEdit('new')}><Plus className="size-3.5" />New automation</Button>} />
      {q.data && !q.data.featureEnabled && <div className="mb-4 flex items-center gap-3 rounded-xl border border-warn/30 bg-warn-soft p-3 text-[13px] text-warn"><Lock className="size-4 shrink-0" />Automations are not included in your current plan, so rules are paused. <Link href="/billing" className="font-semibold underline">Upgrade</Link></div>}
      <Tabs defaultValue="rules">
        <TabsList><TabsTrigger value="rules">Rules</TabsTrigger><TabsTrigger value="log">Execution log</TabsTrigger><TabsTrigger value="assignment">Lead assignment</TabsTrigger></TabsList>
        <TabsContent value="rules" className="space-y-3 pt-4">
          {q.isLoading ? <Skeleton className="h-40" /> : q.data?.rules.map((r) => (
            <Card key={r.id} className="p-4">
              <div className="flex flex-wrap items-start gap-4">
                <span className={cn('mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg [&>svg]:size-4', r.isEnabled ? 'bg-accent-soft text-accent' : 'bg-subtle text-ink-3')}><Zap /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold">{r.name}{r.isSystem && <Badge className="ml-2">Template</Badge>}</p>
                  <p className="mt-0.5 text-xs text-ink-2"><b className="font-medium text-ink">When</b> {trig(r.trigger)?.label.replace('…', r.trigger === 'LEAD_NOT_CONTACTED' ? ` ${r.conditions.afterHours ?? 24} hours` : r.trigger === 'LEAD_INACTIVE' ? ` ${r.conditions.afterDays ?? 7} days` : '')} <b className="font-medium text-ink">then</b> {r.actions.map(describeAction).join(', ')}</p>
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-3 text-[11px] text-ink-3"><span><Bell className="mr-1 inline size-3" />{(r.stats.SUCCESS ?? 0)} succeeded</span>{(r.stats.FAILED ?? 0) > 0 && <span className="text-bad">{r.stats.FAILED} failed</span>}{(r.stats.SKIPPED ?? 0) > 0 && <span>{r.stats.SKIPPED} skipped</span>}<span>{r.lastRunAt ? `last ran ${timeAgo(r.lastRunAt)}` : 'never ran'}</span></p>
                </div>
                <div className="flex items-center gap-2">
                  {manage && <><Button size="sm" onClick={() => setEdit(r)}><Pencil className="size-3.5" />Edit</Button>{!r.isSystem && <Button size="sm" variant="dangerGhost" aria-label={`Delete ${r.name}`} onClick={async () => { if (await confirm({ title: `Delete “${r.name}”?`, description: 'Past executions stay in the log.', destructive: true, confirmLabel: 'Delete' })) del.mutate(r.id); }}><Trash2 className="size-3.5" /></Button>}</>}
                  <Switch aria-label={`${r.isEnabled ? 'Disable' : 'Enable'} ${r.name}`} checked={r.isEnabled} disabled={!manage} onCheckedChange={() => toggle.mutate(r.id)} />
                </div>
              </div>
            </Card>
          ))}
          {q.data && !q.data.rules.length && <Card><EmptyState icon={<Zap />} title="No automations yet" /></Card>}
        </TabsContent>
        <TabsContent value="log" className="pt-4"><Executions /></TabsContent>
        <TabsContent value="assignment" className="pt-4"><AssignmentTab /></TabsContent>
      </Tabs>
      <RuleDialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)} rule={edit === 'new' ? null : edit} />
    </>
  );
}
