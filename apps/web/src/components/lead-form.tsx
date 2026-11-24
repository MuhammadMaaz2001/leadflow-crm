'use client';
import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { leadSchema } from '@leadflow/shared';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError, api } from '@/lib/api';
import { applyServerErrors, useZodForm } from '@/lib/forms';
import { useCustomFields, usePriorities, useSources } from '@/lib/hooks';
import { useOrg, useWorkspace } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/overlay';
import { Field, FormError, Input, Select, Textarea } from '@/components/ui/form';
import { MemberSelect } from '@/components/filters';
import { TagPicker } from '@/components/tag-picker';

export interface LeadFormValues {
  firstName: string; lastName: string; email: string; phone: string; companyName: string; jobTitle: string; sourceId: string; priorityId: string; campaign: string;
  assignedToId: string; description: string; tagIds: string[]; customFields: Record<string, string | number | boolean | null>; allowDuplicate?: boolean;
}
export interface EditableLead { id: string; firstName: string; lastName: string | null; email: string | null; phone: string | null; companyName: string | null; jobTitle: string | null; campaign: string | null; description: string | null; source?: { id: string } | null; priority?: { id: string } | null; assignedTo?: { id: string } | null; tags?: Array<{ id: string }>; customFields?: Record<string, unknown> }
interface Dup { id: string; name: string; email: string | null; phone: string | null; reasons: string[] }

const empty = (): LeadFormValues => ({ firstName: '', lastName: '', email: '', phone: '', companyName: '', jobTitle: '', sourceId: '', priorityId: '', campaign: '', assignedToId: '', description: '', tagIds: [], customFields: {} });

export function LeadFormSheet({ open, onOpenChange, lead, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; lead?: EditableLead | null; onSaved?: (id: string) => void }) {
  const { can } = useOrg();
  const { current } = useWorkspace();
  const sources = useSources(), priorities = usePriorities(), customFields = useCustomFields();
  const qc = useQueryClient();
  const editing = !!lead;
  const form = useZodForm<LeadFormValues>(leadSchema, empty());
  const { register, handleSubmit, reset, setValue, watch, setError, formState: { errors, isSubmitting, isDirty } } = form;
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [dups, setDups] = React.useState<Dup[]>([]);
  const [force, setForce] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setServerError(null); setDups([]); setForce(false);
    reset(lead ? {
      firstName: lead.firstName, lastName: lead.lastName ?? '', email: lead.email ?? '', phone: lead.phone ?? '', companyName: lead.companyName ?? '', jobTitle: lead.jobTitle ?? '', sourceId: lead.source?.id ?? '', priorityId: lead.priority?.id ?? '',
      campaign: lead.campaign ?? '', assignedToId: lead.assignedTo?.id ?? '', description: lead.description ?? '', tagIds: lead.tags?.map((t) => t.id) ?? [], customFields: (lead.customFields ?? {}) as LeadFormValues['customFields'],
    } : empty());
  }, [open, lead, reset]);

  const email = watch('email'), phone = watch('phone');
  async function checkDup() {
    if (editing || (!email && !phone)) return;
    try { const r = await api.post<{ matches: Dup[]; hiddenMatches: number }>('/leads/check-duplicates', { email: email || undefined, phone: phone || undefined }); setDups(r.matches); if (!r.matches.length && r.hiddenMatches) setDups([{ id: '', name: 'A lead you cannot access', email: null, phone: null, reasons: ['email/phone'] }]); } catch { /* non-blocking */ }
  }

  const submit = handleSubmit(async (v) => {
    setServerError(null);
    const body: Record<string, unknown> = { ...v, allowDuplicate: force || undefined };
    for (const k of ['lastName', 'email', 'phone', 'companyName', 'jobTitle', 'campaign', 'description', 'sourceId', 'priorityId', 'assignedToId'] as const) if (body[k] === '') body[k] = editing ? null : undefined;
    if (editing) delete body.assignedToId; // reassignment goes through the dedicated assign action
    delete body.allowDuplicate; if (!editing && force) body.allowDuplicate = true;
    try {
      const r = editing ? await api.patch<{ id: string }>(`/leads/${lead!.id}`, body) : await api.post<{ id: string }>('/leads', body);
      toast.success(editing ? 'Lead updated' : 'Lead created');
      await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === current?.organization.id });
      onOpenChange(false);
      onSaved?.(r.id ?? lead!.id);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DUPLICATE_LEAD') { setDups(((e as unknown as { details?: { matches: Dup[] } }).details?.matches) ?? []); setServerError('A lead with this email or phone already exists.'); setForce(true); return; }
      setServerError(applyServerErrors(e, setError));
    }
  });
  const cf = watch('customFields');

  return (
    <Sheet open={open} onOpenChange={onOpenChange} dirty={isDirty && !isSubmitting} title={editing ? 'Edit lead' : 'Add lead'} description={editing ? 'Update contact details, source and classification.' : 'Capture a new lead. At least an email or a phone number is required.'}
      footer={<><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" onClick={submit} loading={isSubmitting}>{force && !editing ? 'Create anyway' : editing ? 'Save changes' : 'Create lead'}</Button></>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError message={serverError} />
        {dups.length > 0 && (
          <div className="rounded-lg border border-warn/30 bg-warn-soft p-3 text-xs text-warn">
            <p className="mb-1.5 flex items-center gap-1.5 font-semibold"><AlertTriangle className="size-3.5" />Possible duplicate{dups.length > 1 ? 's' : ''}</p>
            <ul className="space-y-1">{dups.map((d, i) => <li key={d.id || i}>{d.id ? <Link href={`/leads/${d.id}`} target="_blank" className="font-medium underline">{d.name}</Link> : <b>{d.name}</b>} <span className="opacity-80">— matches {d.reasons.join(' & ')}</span></li>)}</ul>
            {!editing && <p className="mt-1.5 opacity-90">Review the existing record, or press “Create anyway” to add it as a separate lead.</p>}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" required error={errors.firstName?.message} htmlFor="lf-first"><Input id="lf-first" autoFocus invalid={!!errors.firstName} {...register('firstName')} /></Field>
          <Field label="Last name" error={errors.lastName?.message} htmlFor="lf-last"><Input id="lf-last" {...register('lastName')} /></Field>
          <Field label="Email" error={errors.email?.message} htmlFor="lf-email" hint="Email or phone is required."><Input id="lf-email" type="email" invalid={!!errors.email} {...register('email', { onBlur: checkDup })} /></Field>
          <Field label="Phone" error={errors.phone?.message} htmlFor="lf-phone"><Input id="lf-phone" type="tel" invalid={!!errors.phone} {...register('phone', { onBlur: checkDup })} /></Field>
          <Field label="Company" htmlFor="lf-co"><Input id="lf-co" {...register('companyName')} /></Field>
          <Field label="Job title" htmlFor="lf-job"><Input id="lf-job" {...register('jobTitle')} /></Field>
          <Field label="Lead source" htmlFor="lf-src"><Select id="lf-src" {...register('sourceId')}><option value="">Select a source</option>{sources.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Field label="Campaign" htmlFor="lf-camp"><Input id="lf-camp" placeholder="e.g. Spring promo" {...register('campaign')} /></Field>
          <Field label="Priority" htmlFor="lf-pri"><Select id="lf-pri" {...register('priorityId')}><option value="">Default (Warm)</option>{priorities.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          {!editing && can('leads.assign') && <Field label="Assigned to" htmlFor="lf-asg" hint="Leave empty to use auto-assignment."><MemberSelect id="lf-asg" includeUnassigned value={watch('assignedToId')} onChange={(v) => setValue('assignedToId', v, { shouldDirty: true })} /></Field>}
        </div>
        <Field label="Tags"><TagPicker value={watch('tagIds') ?? []} onChange={(ids) => setValue('tagIds', ids, { shouldDirty: true })} /></Field>
        <Field label="Description" htmlFor="lf-desc"><Textarea id="lf-desc" placeholder="Context, requirements, how they found you…" {...register('description')} /></Field>
        {customFields.data?.filter((f) => f.isActive).length ? (
          <div className="rounded-lg border border-line p-3">
            <p className="mb-3 text-xs font-semibold text-ink-2">Custom fields</p>
            <div className="grid gap-4 sm:grid-cols-2">
              {customFields.data.filter((f) => f.isActive).map((f) => (
                <Field key={f.id} label={f.label} required={f.required} error={(errors as Record<string, { message?: string }>)[`customFields.${f.key}`]?.message}>
                  {f.type === 'SELECT' ? (
                    <Select aria-label={f.label} value={String(cf?.[f.key] ?? '')} onChange={(e) => setValue('customFields', { ...cf, [f.key]: e.target.value }, { shouldDirty: true })}><option value="">—</option>{f.options.map((o) => <option key={o}>{o}</option>)}</Select>
                  ) : f.type === 'BOOLEAN' ? (
                    <Select aria-label={f.label} value={String(cf?.[f.key] ?? '')} onChange={(e) => setValue('customFields', { ...cf, [f.key]: e.target.value === '' ? null : e.target.value === 'true' }, { shouldDirty: true })}><option value="">—</option><option value="true">Yes</option><option value="false">No</option></Select>
                  ) : (
                    <Input aria-label={f.label} type={f.type === 'NUMBER' ? 'number' : f.type === 'DATE' ? 'date' : 'text'} value={String(cf?.[f.key] ?? '')} onChange={(e) => setValue('customFields', { ...cf, [f.key]: e.target.value }, { shouldDirty: true })} />
                  )}
                </Field>
              ))}
            </div>
          </div>
        ) : null}
        <button type="submit" className="sr-only">Submit</button>
      </form>
    </Sheet>
  );
}
