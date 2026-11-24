'use client';
import * as React from 'react';
import { ArrowDown, ArrowUp, Building2, Check, ImagePlus, Lock, Pencil, Plus, Shield, Star, Trash2, X } from 'lucide-react';
import { CURRENCIES, CUSTOM_FIELD_TYPES, DATE_FORMATS, INDUSTRIES, PERMISSION_GROUPS } from '@leadflow/shared';
import { api } from '@/lib/api';
import { useCustomFields, usePipelines, type CustomField, type Lookup, type Pipeline, type Stage } from '@/lib/hooks';
import { errMsg, useAct, useOrg, useT } from '@/lib/session';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, FormError, Input, Select, Switch, Textarea } from '@/components/ui/form';
import { Badge, Card, CardHeader, EmptyState, PageHeader, Skeleton } from '@/components/ui/data';
import { Dialog, useConfirm } from '@/components/ui/overlay';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/menu';
import { NotificationPrefs } from '../notifications/page';
import Link from 'next/link';

const zones = (() => { try { return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone'); } catch { return ['UTC']; } })();

function CompanyTab() {
  const { org } = useOrg();
  const o = org?.organization;
  const [f, setF] = React.useState({ name: '', industry: '', website: '', contactEmail: '', contactPhone: '', address: '', country: '', timezone: 'UTC', currency: 'USD', dateFormat: 'MMM d, yyyy', notContactedHours: '24', inactiveDays: '7', logoData: '' as string | null });
  const [error, setError] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);
  React.useEffect(() => { if (o) { setF({ name: o.name, industry: o.industry ?? '', website: o.website ?? '', contactEmail: o.contactEmail ?? '', contactPhone: o.contactPhone ?? '', address: o.address ?? '', country: o.country ?? '', timezone: o.timezone, currency: o.currency, dateFormat: o.dateFormat, notContactedHours: String(o.notContactedHours), inactiveDays: String(o.inactiveDays), logoData: o.logoData }); setDirty(false); } }, [o]);
  const save = useAct(() => api.patch('/organizations/current', { name: f.name, industry: f.industry || null, website: f.website || null, contactEmail: f.contactEmail || null, contactPhone: f.contactPhone || null, address: f.address || null, country: f.country || null, timezone: f.timezone, currency: f.currency, dateFormat: f.dateFormat, notContactedHours: Number(f.notContactedHours), inactiveDays: Number(f.inactiveDays), logoData: f.logoData || null }), { success: 'Workspace settings saved', silent: true, onSuccess: () => setDirty(false), onError: (e) => setError(errMsg(e)) });
  const set = (p: Partial<typeof f>) => { setF({ ...f, ...p }); setDirty(true); };
  function onLogo(file?: File) { if (!file) return; if (file.size > 400_000) { setError('Logo must be smaller than 400 KB'); return; } const r = new FileReader(); r.onload = () => set({ logoData: String(r.result) }); r.readAsDataURL(file); }
  if (!o) return <Skeleton className="h-96" />;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Company profile & branding" />
        <div className="space-y-4 p-4">
          <FormError message={error} />
          <div className="flex items-center gap-4">
            <label className="relative flex size-16 cursor-pointer items-center justify-center overflow-hidden rounded-xl border border-dashed border-line-strong bg-subtle text-ink-3 hover:border-accent">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {f.logoData ? <img src={f.logoData} alt="Company logo" className="size-full object-cover" /> : <ImagePlus className="size-5" />}<input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="sr-only" aria-label="Upload logo" onChange={(e) => onLogo(e.target.files?.[0])} />
            </label>
            <div className="text-xs text-ink-3"><p className="text-[13px] font-medium text-ink">Company logo</p>PNG, JPG, SVG or WebP up to 400 KB.{f.logoData && <button className="ml-2 text-bad hover:underline" onClick={() => set({ logoData: null })}>Remove</button>}</div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Company name" required><Input aria-label="Company name" value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field label="Industry"><Select aria-label="Industry" value={f.industry} onChange={(e) => set({ industry: e.target.value })}><option value="">—</option>{INDUSTRIES.map((i) => <option key={i}>{i}</option>)}</Select></Field>
            <Field label="Website"><Input aria-label="Website" value={f.website} onChange={(e) => set({ website: e.target.value })} /></Field>
            <Field label="Contact email"><Input aria-label="Contact email" type="email" value={f.contactEmail} onChange={(e) => set({ contactEmail: e.target.value })} /></Field>
            <Field label="Phone"><Input aria-label="Phone" value={f.contactPhone} onChange={(e) => set({ contactPhone: e.target.value })} /></Field>
            <Field label="Country"><Input aria-label="Country" value={f.country} onChange={(e) => set({ country: e.target.value })} /></Field>
            <Field label="Address" className="sm:col-span-2"><Input aria-label="Address" value={f.address} onChange={(e) => set({ address: e.target.value })} /></Field>
          </div>
        </div>
      </Card>
      <Card>
        <CardHeader title="Regional settings" description="Dates, reporting windows and money formatting use these." />
        <div className="grid gap-4 p-4 sm:grid-cols-3">
          <Field label="Timezone"><Select aria-label="Timezone" value={f.timezone} onChange={(e) => set({ timezone: e.target.value })}>{zones.map((z) => <option key={z}>{z}</option>)}</Select></Field>
          <Field label="Currency"><Select aria-label="Currency" value={f.currency} onChange={(e) => set({ currency: e.target.value })}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select></Field>
          <Field label="Date format"><Select aria-label="Date format" value={f.dateFormat} onChange={(e) => set({ dateFormat: e.target.value })}>{DATE_FORMATS.map((c) => <option key={c}>{c}</option>)}</Select></Field>
        </div>
      </Card>
      <Card>
        <CardHeader title="Lead follow-through" description="Defaults used by automations when a rule doesn't set its own time." />
        <div className="grid gap-4 p-4 sm:grid-cols-2"><Field label="Lead counts as “not contacted” after (hours)"><Input aria-label="Not contacted hours" type="number" min={1} value={f.notContactedHours} onChange={(e) => set({ notContactedHours: e.target.value })} /></Field><Field label="Lead counts as inactive after (days)"><Input aria-label="Inactive days" type="number" min={1} value={f.inactiveDays} onChange={(e) => set({ inactiveDays: e.target.value })} /></Field></div>
      </Card>
      <div className="sticky bottom-3 flex justify-end"><Button variant="primary" size="lg" loading={save.isPending} disabled={!dirty} onClick={() => { setError(null); save.mutate(); }} className="shadow-pop">Save changes</Button></div>
    </div>
  );
}

function LookupManager({ title, description, path, noun, withColor = true, hint }: { title: string; description: string; path: string; noun: string; withColor?: boolean; hint?: string }) {
  const confirm = useConfirm();
  const key = path.slice(1);
  const q = useT([key, 'manage'], () => api.get<Lookup[]>(path, { includeInactive: true }));
  const [name, setName] = React.useState('');
  const [color, setColor] = React.useState('#5558e3');
  const [editing, setEditing] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState('');
  const add = useAct(() => api.post(path, { name, color: withColor ? color : undefined }), { success: `${noun} added`, onSuccess: () => setName('') });
  const rename = useAct((v: { id: string; body: Record<string, unknown> }) => api.patch(`${path}/${v.id}`, v.body), { success: 'Saved', onSuccess: () => setEditing(null) });
  const del = useAct((id: string) => api.del<{ deleted: boolean; deactivated?: boolean; reason?: string }>(`${path}/${id}`), { success: (r) => (r.deactivated ? r.reason ?? 'Deactivated' : `${noun} deleted`) });
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <form className="flex flex-wrap items-center gap-2 px-4 pt-3" onSubmit={(e) => { e.preventDefault(); if (name.trim()) add.mutate(); }}>
        <div className="min-w-[200px] max-w-sm flex-1"><Input aria-label={`New ${noun} name`} value={name} onChange={(e) => setName(e.target.value)} placeholder={`New ${noun}…`} /></div>
        {withColor && <input aria-label="Color" type="color" value={color} onChange={(e) => setColor(e.target.value)} className="size-8 cursor-pointer rounded-md border border-line-strong bg-surface p-0.5" />}
        <Button type="submit" variant="primary" loading={add.isPending} disabled={!name.trim()}><Plus className="size-3.5" />Add</Button>
      </form>
      {hint && <p className="px-4 pt-2 text-xs text-ink-3">{hint}</p>}
      <ul className="mt-3 divide-y divide-line border-t border-line">
        {q.isLoading ? <li className="p-4"><Skeleton className="h-16" /></li> : q.data?.map((r) => (
          <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
            {withColor && <input aria-label={`Color for ${r.name}`} type="color" defaultValue={r.color} onBlur={(e) => e.target.value !== r.color && rename.mutate({ id: r.id, body: { color: e.target.value } })} className="size-6 cursor-pointer rounded border-0 bg-transparent p-0" />}
            {editing === r.id ? <form className="flex flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); rename.mutate({ id: r.id, body: { name: editName } }); }}><Input aria-label="Name" autoFocus value={editName} onChange={(e) => setEditName(e.target.value)} className="max-w-xs" /><Button size="iconSm" variant="primary" type="submit" aria-label="Save name"><Check className="size-3.5" /></Button><Button size="iconSm" onClick={() => setEditing(null)} aria-label="Cancel"><X className="size-3.5" /></Button></form> : <span className={cn('flex-1 text-[13px]', !r.isActive && 'text-ink-3 line-through')}>{r.name}</span>}
            <span className="tnum text-xs text-ink-3">{r.usageCount ?? 0} in use</span>
            {!r.isActive && <Badge>Inactive</Badge>}
            <Switch aria-label={`${r.name} active`} checked={r.isActive} onCheckedChange={(v) => rename.mutate({ id: r.id, body: { isActive: v } })} />
            <Button size="iconSm" variant="ghost" aria-label={`Rename ${r.name}`} onClick={() => { setEditing(r.id); setEditName(r.name); }}><Pencil className="size-3.5" /></Button>
            <Button size="iconSm" variant="ghost" aria-label={`Delete ${r.name}`} onClick={async () => { if (await confirm({ title: `Delete “${r.name}”?`, description: (r.usageCount ?? 0) > 0 ? 'It is in use, so it will be hidden from new selections but kept on existing records.' : 'This cannot be undone.', destructive: true, confirmLabel: (r.usageCount ?? 0) > 0 ? 'Deactivate' : 'Delete' })) del.mutate(r.id); }}><Trash2 className="size-3.5 text-bad" /></Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

interface RoleRow { id: string; name: string; description: string | null; permissions: string[]; isSystem: boolean; systemKey: string | null; memberCount: number }
function RolesTab() {
  const { has, can } = useOrg();
  const confirm = useConfirm();
  const q = useT(['roles', 'manage'], () => api.get<RoleRow[]>('/roles'));
  const [edit, setEdit] = React.useState<RoleRow | 'new' | null>(null);
  const del = useAct((id: string) => api.del(`/roles/${id}`), { success: 'Role deleted', invalidate: ['roles'] });
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between"><p className="text-[13px] text-ink-2">Roles control what each member can see and do. A person can hold a different role in each workspace.</p>{can('roles.manage') && <Button variant="primary" onClick={() => (has('custom_roles') ? setEdit('new') : undefined)} disabled={!has('custom_roles')}>{!has('custom_roles') && <Lock className="size-3.5" />}<Plus className="size-3.5" />Custom role</Button>}</div>
      {!has('custom_roles') && <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">Custom roles and editing role permissions are included in the Professional plan. <Link href="/billing" className="font-semibold underline">Upgrade</Link></p>}
      <div className="grid gap-3 md:grid-cols-2">
        {q.data?.map((r) => (
          <Card key={r.id} className="p-4">
            <div className="flex items-start justify-between gap-2"><div><p className="flex items-center gap-2 text-[13px] font-semibold"><Shield className="size-4 text-accent" />{r.name}{r.isSystem && <Badge>System</Badge>}</p><p className="mt-1 text-xs text-ink-2">{r.description ?? `${r.permissions.length} permissions`}</p></div><span className="tnum text-xs text-ink-3">{r.memberCount} member{r.memberCount === 1 ? '' : 's'}</span></div>
            <p className="mt-2 text-xs text-ink-3">{r.permissions.length} permission{r.permissions.length === 1 ? '' : 's'}</p>
            {can('roles.manage') && r.systemKey !== 'OWNER' && <div className="mt-3 flex gap-2"><Button size="sm" onClick={() => setEdit(r)} disabled={!has('custom_roles')}><Pencil className="size-3.5" />Edit permissions</Button>{!r.isSystem && <Button size="sm" variant="dangerGhost" onClick={async () => { if (await confirm({ title: `Delete role “${r.name}”?`, destructive: true, confirmLabel: 'Delete' })) del.mutate(r.id); }}>Delete</Button>}</div>}
            {r.systemKey === 'OWNER' && <p className="mt-3 flex items-center gap-1 text-xs text-ink-3"><Lock className="size-3" />Owners always have every permission.</p>}
          </Card>
        ))}
      </div>
      {edit && <RoleDialog role={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}
function RoleDialog({ role, onClose }: { role: RoleRow | null; onClose: () => void }) {
  const [name, setName] = React.useState(role?.name ?? '');
  const [desc, setDesc] = React.useState(role?.description ?? '');
  const [perms, setPerms] = React.useState<string[]>(role?.permissions ?? ['leads.create', 'leads.update']);
  const [error, setError] = React.useState<string | null>(null);
  const save = useAct(() => (role ? api.patch(`/roles/${role.id}`, { name, description: desc || null, permissions: perms }) : api.post('/roles', { name, description: desc || null, permissions: perms })), { success: 'Role saved', invalidate: ['roles'], silent: true, onSuccess: onClose, onError: (e) => setError(errMsg(e)) });
  const toggle = (p: string, v: boolean) => setPerms(v ? [...perms, p] : perms.filter((x) => x !== p));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="lg" title={role ? `Edit ${role.name}` : 'New custom role'} description="Choose exactly what members with this role can do."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={name.trim().length < 2} onClick={() => save.mutate()}>Save role</Button></>}>
      <div className="space-y-4"><FormError message={error} />
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Role name" required><Input aria-label="Role name" value={name} onChange={(e) => setName(e.target.value)} disabled={role?.isSystem} /></Field><Field label="Description"><Input aria-label="Description" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field></div>
        {PERMISSION_GROUPS.map((g) => (
          <fieldset key={g.group} className="rounded-lg border border-line"><legend className="ml-3 px-1 text-xs font-semibold text-ink-2">{g.group}</legend>
            <div className="grid gap-x-4 gap-y-2.5 p-3 sm:grid-cols-2">{g.items.map((i) => <label key={i.key} className="flex items-start gap-2 text-[13px]"><span className="pt-0.5"><Checkbox checked={perms.includes(i.key)} onCheckedChange={(v) => toggle(i.key, v)} aria-label={i.label} /></span><span><span className="font-medium">{i.label}</span>{i.description && <span className="block text-xs text-ink-3">{i.description}</span>}</span></label>)}</div></fieldset>
        ))}
      </div>
    </Dialog>
  );
}

function PipelinesTab() {
  const confirm = useConfirm();
  const { has } = useOrg();
  const q = usePipelines();
  const [sel, setSel] = React.useState<string>('');
  const pipe: Pipeline | undefined = q.data?.find((p) => p.id === sel) ?? q.data?.[0];
  const [newStage, setNewStage] = React.useState('');
  const [newPipe, setNewPipe] = React.useState('');
  const act = <T,>(fn: (v: T) => Promise<unknown>, success?: string) => useAct(fn, { success, invalidate: ['pipelines'] });
  const addStage = act(() => api.post(`/pipelines/${pipe!.id}/stages`, { name: newStage }), 'Stage added');
  const patchStage = act((v: { id: string; body: Record<string, unknown> }) => api.patch(`/stages/${v.id}`, v.body), 'Stage updated');
  const delStage = act((id: string) => api.del(`/stages/${id}`), 'Stage deleted');
  const reorder = act((ids: string[]) => api.post(`/pipelines/${pipe!.id}/stages/reorder`, { stageIds: ids }));
  const createPipe = act(() => api.post('/pipelines', { name: newPipe }), 'Pipeline created');
  const patchPipe = act((v: { id: string; body: Record<string, unknown> }) => api.patch(`/pipelines/${v.id}`, v.body), 'Pipeline updated');
  const archive = act((id: string) => api.del(`/pipelines/${id}`), 'Pipeline archived');
  React.useEffect(() => { if (q.data && !q.data.find((p) => p.id === sel)) setSel(q.data[0]?.id ?? ''); }, [q.data, sel]);
  if (!pipe) return <Skeleton className="h-64" />;
  const move = (s: Stage, dir: -1 | 1) => { const ids = pipe.stages.map((x) => x.id); const i = ids.indexOf(s.id); const j = i + dir; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j]!, ids[i]!]; reorder.mutate(ids); };
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          {q.data?.map((p) => <button key={p.id} onClick={() => setSel(p.id)} className={cn('rounded-full border px-3 py-1 text-[13px]', pipe.id === p.id ? 'border-accent bg-accent-soft font-medium text-accent-ink' : 'border-line text-ink-2 hover:bg-subtle')}>{p.name}{p.isDefault && <Star className="ml-1 inline size-3 fill-current" />}</button>)}
          <form className="ml-auto flex gap-2" onSubmit={(e) => { e.preventDefault(); if (newPipe.trim()) { createPipe.mutate(undefined as never); setNewPipe(''); } }}><Input aria-label="New pipeline name" value={newPipe} onChange={(e) => setNewPipe(e.target.value)} placeholder={has('custom_pipelines') ? 'New pipeline…' : 'Custom pipelines need Professional'} disabled={!has('custom_pipelines')} className="w-52" /><Button type="submit" disabled={!has('custom_pipelines') || !newPipe.trim()}>{!has('custom_pipelines') && <Lock className="size-3.5" />}Add pipeline</Button></form>
        </div>
      </Card>
      <Card>
        <CardHeader title={pipe.name} description="Stages run left to right on the board. Won and Lost are outcome stages and always come last." actions={<div className="flex gap-2">{!pipe.isDefault && <Button size="sm" onClick={() => patchPipe.mutate({ id: pipe.id, body: { isDefault: true } })}>Make default</Button>}{!pipe.isDefault && <Button size="sm" variant="dangerGhost" onClick={async () => { if (await confirm({ title: `Archive “${pipe.name}”?`, description: 'Only possible when no open opportunities remain in it.', destructive: true, confirmLabel: 'Archive' })) archive.mutate(pipe.id); }}>Archive</Button>}</div>} />
        <ul className="mt-2 divide-y divide-line border-t border-line">
          {pipe.stages.map((s, i) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <div className="flex flex-col"><button className="text-ink-3 hover:text-ink disabled:opacity-30" aria-label={`Move ${s.name} up`} disabled={i === 0 || s.kind !== 'OPEN' || pipe.stages[i - 1]?.kind !== 'OPEN'} onClick={() => move(s, -1)}><ArrowUp className="size-3.5" /></button><button className="text-ink-3 hover:text-ink disabled:opacity-30" aria-label={`Move ${s.name} down`} disabled={s.kind !== 'OPEN' || pipe.stages[i + 1]?.kind !== 'OPEN'} onClick={() => move(s, 1)}><ArrowDown className="size-3.5" /></button></div>
              <input aria-label={`Color for ${s.name}`} type="color" defaultValue={s.color} onBlur={(e) => e.target.value !== s.color && patchStage.mutate({ id: s.id, body: { color: e.target.value } })} className="size-6 cursor-pointer rounded border-0 bg-transparent p-0" />
              <Input aria-label={`Name of stage ${i + 1}`} defaultValue={s.name} key={s.name} className="max-w-[220px]" onBlur={(e) => e.target.value.trim() && e.target.value !== s.name && patchStage.mutate({ id: s.id, body: { name: e.target.value.trim() } })} />
              <Badge tone={s.kind === 'WON' ? 'ok' : s.kind === 'LOST' ? 'bad' : 'neutral'}>{s.kind === 'OPEN' ? 'Open' : s.kind === 'WON' ? 'Won' : 'Lost'}</Badge>
              <label className="flex items-center gap-1.5 text-xs text-ink-3">Win %<Input aria-label={`Probability of ${s.name}`} type="number" min={0} max={100} defaultValue={s.probability} className="h-7 w-16" disabled={s.kind !== 'OPEN'} onBlur={(e) => Number(e.target.value) !== s.probability && patchStage.mutate({ id: s.id, body: { probability: Number(e.target.value) } })} /></label>
              <span className="tnum ml-auto text-xs text-ink-3">{s.opportunityCount ?? 0} deals</span>
              <Button size="iconSm" variant="ghost" aria-label={`Delete stage ${s.name}`} onClick={async () => { if (await confirm({ title: `Delete stage “${s.name}”?`, destructive: true, confirmLabel: 'Delete' })) delStage.mutate(s.id); }}><Trash2 className="size-3.5 text-bad" /></Button>
            </li>
          ))}
        </ul>
        <form className="flex gap-2 border-t border-line p-4" onSubmit={(e) => { e.preventDefault(); if (newStage.trim()) { addStage.mutate(undefined as never); setNewStage(''); } }}><Input aria-label="New stage name" value={newStage} onChange={(e) => setNewStage(e.target.value)} placeholder="New stage name (added before Won)…" className="max-w-xs" /><Button type="submit" variant="primary" disabled={!newStage.trim()}><Plus className="size-3.5" />Add stage</Button></form>
      </Card>
    </div>
  );
}

function CustomFieldsTab() {
  const { has } = useOrg();
  const confirm = useConfirm();
  const q = useCustomFields();
  const [f, setF] = React.useState({ label: '', type: 'TEXT', options: '', required: false });
  const [error, setError] = React.useState<string | null>(null);
  const add = useAct(() => api.post('/custom-fields', { label: f.label, type: f.type, options: f.type === 'SELECT' ? f.options.split(',').map((o) => o.trim()).filter(Boolean) : undefined, required: f.required }), { success: 'Field added', invalidate: ['custom-fields'], silent: true, onSuccess: () => { setF({ label: '', type: 'TEXT', options: '', required: false }); setError(null); }, onError: (e) => setError(errMsg(e)) });
  const patch = useAct((v: { id: string; body: Record<string, unknown> }) => api.patch(`/custom-fields/${v.id}`, v.body), { invalidate: ['custom-fields'] });
  const del = useAct((id: string) => api.del(`/custom-fields/${id}`), { success: 'Field deactivated — existing values are kept', invalidate: ['custom-fields'] });
  return (
    <Card>
      <CardHeader title="Custom lead fields" description="Capture what's unique to your business — budget, property type, service interest, anything." />
      {!has('custom_fields') && <p className="mx-4 mt-3 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">Custom fields are included in Starter and Professional plans. <Link href="/billing" className="font-semibold underline">Upgrade</Link></p>}
      <div className="space-y-3 p-4"><FormError message={error} />
        <div className="grid items-end gap-3 md:grid-cols-[1fr_140px_1fr_auto_auto]">
          <Field label="Label"><Input aria-label="Field label" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="e.g. Budget" disabled={!has('custom_fields')} /></Field>
          <Field label="Type"><Select aria-label="Field type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} disabled={!has('custom_fields')}>{CUSTOM_FIELD_TYPES.map((t) => <option key={t} value={t}>{t[0] + t.slice(1).toLowerCase()}</option>)}</Select></Field>
          <Field label="Options (comma separated)">{f.type === 'SELECT' ? <Input aria-label="Options" value={f.options} onChange={(e) => setF({ ...f, options: e.target.value })} placeholder="Option A, Option B" /> : <Input aria-label="Options" disabled placeholder="Only for dropdowns" />}</Field>
          <label className="flex h-8 items-center gap-2 text-[13px]"><Checkbox checked={f.required} onCheckedChange={(v) => setF({ ...f, required: v })} aria-label="Required" />Required</label>
          <Button variant="primary" loading={add.isPending} disabled={!f.label.trim() || !has('custom_fields')} onClick={() => add.mutate()}><Plus className="size-3.5" />Add field</Button>
        </div>
      </div>
      <ul className="divide-y divide-line border-t border-line">
        {!q.data?.length ? <li><EmptyState className="py-8" title="No custom fields yet" /></li> : q.data.map((c: CustomField) => <li key={c.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]"><span className={cn('flex-1 font-medium', !c.isActive && 'text-ink-3 line-through')}>{c.label}</span><code className="rounded bg-subtle px-1.5 text-xs text-ink-3">{c.key}</code><Badge>{c.type.toLowerCase()}</Badge>{c.required && <Badge tone="warn">required</Badge>}{c.options.length > 0 && <span className="hidden text-xs text-ink-3 md:block">{c.options.join(', ')}</span>}<Switch aria-label={`${c.label} active`} checked={c.isActive} onCheckedChange={(v) => patch.mutate({ id: c.id, body: { isActive: v } })} /><Button size="iconSm" variant="ghost" aria-label={`Deactivate ${c.label}`} onClick={async () => { if (await confirm({ title: `Deactivate “${c.label}”?`, description: 'Existing values stay on leads but the field is hidden from forms.', confirmLabel: 'Deactivate', destructive: true })) del.mutate(c.id); }}><Trash2 className="size-3.5 text-bad" /></Button></li>)}
      </ul>
    </Card>
  );
}

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Workspace settings" description="Configure how your company works inside LeadFlow." />
      <Tabs defaultValue="company">
        <TabsList>
          {[['company', 'Company'], ['roles', 'Roles & permissions'], ['sources', 'Lead sources'], ['priorities', 'Priorities'], ['pipelines', 'Pipelines'], ['fields', 'Custom fields'], ['tags', 'Tags'], ['lost', 'Lost reasons'], ['notifications', 'Notifications']].map(([v, l]) => <TabsTrigger key={v} value={v!}>{l}</TabsTrigger>)}
        </TabsList>
        <div className="pt-5">
          <TabsContent value="company"><CompanyTab /></TabsContent>
          <TabsContent value="roles"><RolesTab /></TabsContent>
          <TabsContent value="sources"><LookupManager title="Lead sources" description="Where leads come from. Powers the source-performance reports." path="/lead-sources" noun="source" /></TabsContent>
          <TabsContent value="priorities"><LookupManager title="Lead priorities" description="Hot, Warm, Cold by default — rename or add your own levels." path="/lead-priorities" noun="priority" hint="New leads default to “Warm” when no priority is chosen." /></TabsContent>
          <TabsContent value="pipelines"><PipelinesTab /></TabsContent>
          <TabsContent value="fields"><CustomFieldsTab /></TabsContent>
          <TabsContent value="tags"><LookupManager title="Tags" description="Lightweight labels for filtering and bulk actions." path="/tags" noun="tag" /></TabsContent>
          <TabsContent value="lost"><LookupManager title="Lost reasons" description="Why deals are lost. Required when an opportunity is marked lost." path="/lost-reasons" noun="reason" withColor={false} /></TabsContent>
          <TabsContent value="notifications"><NotificationPrefs /></TabsContent>
        </div>
      </Tabs>
    </>
  );
}
void Building2; void Textarea;
