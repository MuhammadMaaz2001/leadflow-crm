'use client';
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Check, ImagePlus, Plus, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CURRENCIES, DATE_FORMATS, INDUSTRIES } from '@leadflow/shared';
import { Logo } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select, Checkbox } from '@/components/ui/form';
import { Card } from '@/components/ui/data';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { TIMEZONES, withCurrent } from '@/lib/format';
import { errMsg, useMe, useOrg, useOrgContext, useRequireAuth, useWorkspace } from '@/lib/session';

const STEPS = ['Company', 'Business details', 'Sales setup', 'Invite team'] as const;

function Wizard() {
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  useRequireAuth();
  const me = useMe();
  const { setOrgId } = useOrgContext();
  const { current } = useWorkspace();
  const { org } = useOrg();
  const creating = params.get('new') === '1' || (!current && !!me.data);
  const [step, setStep] = React.useState(0);
  const [orgReady, setOrgReady] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [company, setCompany] = React.useState({ name: '', industry: '' as string });
  const [details, setDetails] = React.useState({ website: '', contactEmail: '', contactPhone: '', country: '', timezone: 'UTC', currency: 'USD', dateFormat: 'MMM d, yyyy', logoData: '' as string });
  const [sources, setSources] = React.useState<Array<{ id: string; name: string; keep: boolean }>>([]);
  const [newSource, setNewSource] = React.useState('');
  const [assignMode, setAssignMode] = React.useState<'NONE' | 'ROUND_ROBIN'>('NONE');
  const [invites, setInvites] = React.useState<Array<{ email: string; roleKey: string }>>([{ email: '', roleKey: 'SALES_AGENT' }]);
  const [roles, setRoles] = React.useState<Array<{ id: string; systemKey: string; name: string }>>([]);
  const [sent, setSent] = React.useState<string[]>([]);

  React.useEffect(() => { setDetails((d) => ({ ...d, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' })); }, []);
  React.useEffect(() => { if (!creating && current) { setOrgReady(true); setStep((s) => (s === 0 ? 1 : s)); } }, [creating, current]);
  React.useEffect(() => {
    if (org && !creating) setDetails((d) => ({ ...d, website: org.organization.website ?? '', contactEmail: org.organization.contactEmail ?? '', contactPhone: org.organization.contactPhone ?? '', country: org.organization.country ?? '', currency: org.organization.currency, dateFormat: org.organization.dateFormat }));
  }, [org, creating]);
  React.useEffect(() => {
    if (step === 2 && orgReady) api.get<Array<{ id: string; name: string }>>('/lead-sources').then((r) => setSources(r.map((s) => ({ ...s, keep: true })))).catch(() => undefined);
    if (step === 3 && orgReady) api.get<typeof roles>('/roles').then(setRoles).catch(() => undefined);
  }, [step, orgReady]);

  async function next() {
    setError(null); setBusy(true);
    try {
      if (step === 0) {
        if (company.name.trim().length < 2) throw new Error('Enter your company name');
        const r = await api.post<{ id: string }>('/organizations', { name: company.name.trim(), industry: company.industry || undefined }, { tenant: false });
        setOrgId(r.id); await qc.invalidateQueries({ queryKey: ['me'] }); setOrgReady(true);
      } else if (step === 1) {
        await api.patch('/organizations/current', { website: details.website || null, contactEmail: details.contactEmail || null, contactPhone: details.contactPhone || null, country: details.country || null, timezone: details.timezone, currency: details.currency, dateFormat: details.dateFormat, logoData: details.logoData || null });
      } else if (step === 2) {
        for (const s of sources.filter((x) => !x.keep)) await api.del(`/lead-sources/${s.id}`);
        if (newSource.trim()) await api.post('/lead-sources', { name: newSource.trim() });
        await api.patch('/organizations/current', { autoAssignMode: assignMode });
      } else if (step === 3) {
        const todo = invites.filter((i) => i.email.trim());
        const done: string[] = [];
        for (const i of todo) {
          const role = roles.find((r) => r.systemKey === i.roleKey);
          if (!role) continue;
          try { await api.post('/invitations', { email: i.email.trim().toLowerCase(), roleId: role.id }); done.push(i.email); } catch (e) { throw new Error(`${i.email}: ${errMsg(e)}`); }
        }
        setSent(done);
        await api.post('/organizations/current/onboarding', { complete: true });
        await qc.invalidateQueries();
        toast.success('Your workspace is ready');
        router.replace('/dashboard');
        return;
      }
      setStep(step + 1);
    } catch (e) { setError(e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong'); } finally { setBusy(false); }
  }
  async function skipAll() {
    setBusy(true);
    try { await api.post('/organizations/current/onboarding', { complete: true }); await qc.invalidateQueries(); router.replace('/dashboard'); } catch (e) { setError(errMsg(e)); setBusy(false); }
  }
  function onLogo(file?: File) {
    if (!file) return;
    if (file.size > 400_000) { setError('Logo must be smaller than 400 KB'); return; }
    const r = new FileReader(); r.onload = () => setDetails((d) => ({ ...d, logoData: String(r.result) })); r.readAsDataURL(file);
  }

  return (
    <div className="min-h-dvh bg-canvas px-4 py-8">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8 flex items-center justify-between"><Logo />{current && !creating && <Button variant="ghost" onClick={skipAll}>Skip setup</Button>}{creating && current && <Button variant="ghost" onClick={() => router.push('/dashboard')}>Cancel</Button>}</div>
        <ol className="mb-6 flex items-center gap-2" aria-label="Setup progress">
          {STEPS.map((s, i) => (
            <li key={s} className="flex flex-1 items-center gap-2">
              <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold', i < step ? 'bg-accent text-white' : i === step ? 'bg-accent-soft text-accent-ink ring-2 ring-accent' : 'bg-subtle text-ink-3')}>{i < step ? <Check className="size-3.5" /> : i + 1}</span>
              <span className={cn('hidden text-xs font-medium sm:block', i === step ? 'text-ink' : 'text-ink-3')}>{s}</span>
              {i < STEPS.length - 1 && <span className="h-px flex-1 bg-line" />}
            </li>
          ))}
        </ol>
        <Card className="p-6">
          <FormError message={error} />
          <div className={error ? 'mt-4' : ''}>
            {step === 0 && (
              <div className="space-y-4">
                <div><h1 className="text-lg font-semibold">Create your workspace</h1><p className="mt-1 text-[13px] text-ink-2">Each company gets a private workspace with its own team, pipeline and data.</p></div>
                <Field label="Company name" required htmlFor="cn"><Input id="cn" autoFocus value={company.name} onChange={(e) => setCompany({ ...company, name: e.target.value })} placeholder="Acme Realty" /></Field>
                <Field label="Industry" htmlFor="ind"><Select id="ind" value={company.industry} onChange={(e) => setCompany({ ...company, industry: e.target.value })}><option value="">Select an industry (optional)</option>{INDUSTRIES.map((i) => <option key={i}>{i}</option>)}</Select></Field>
                <p className="text-xs text-ink-3">You start with a 14-day Professional trial. No credit card needed.</p>
              </div>
            )}
            {step === 1 && (
              <div className="space-y-4">
                <div><h1 className="text-lg font-semibold">Business details</h1><p className="mt-1 text-[13px] text-ink-2">Used for invoices, date formatting and reporting windows. You can change these later in settings.</p></div>
                <div className="flex items-center gap-4">
                  <label className="flex size-16 cursor-pointer items-center justify-center overflow-hidden rounded-xl border border-dashed border-line-strong bg-subtle text-ink-3 hover:border-accent">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {details.logoData ? <img src={details.logoData} alt="Company logo" className="size-full object-cover" /> : <ImagePlus className="size-5" />}
                    <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" onChange={(e) => onLogo(e.target.files?.[0])} aria-label="Upload logo" />
                  </label>
                  <div className="text-xs text-ink-3">Company logo<br />PNG, JPG, WebP or GIF, up to 400 KB (optional)</div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Website"><Input value={details.website} onChange={(e) => setDetails({ ...details, website: e.target.value })} placeholder="https://" /></Field>
                  <Field label="Contact email"><Input type="email" value={details.contactEmail} onChange={(e) => setDetails({ ...details, contactEmail: e.target.value })} /></Field>
                  <Field label="Phone"><Input value={details.contactPhone} onChange={(e) => setDetails({ ...details, contactPhone: e.target.value })} /></Field>
                  <Field label="Country"><Input value={details.country} onChange={(e) => setDetails({ ...details, country: e.target.value })} /></Field>
                  <Field label="Timezone"><Select value={details.timezone} onChange={(e) => setDetails({ ...details, timezone: e.target.value })}>{withCurrent(TIMEZONES, details.timezone).map((z) => <option key={z}>{z}</option>)}</Select></Field>
                  <Field label="Currency"><Select value={details.currency} onChange={(e) => setDetails({ ...details, currency: e.target.value })}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select></Field>
                  <Field label="Date format"><Select value={details.dateFormat} onChange={(e) => setDetails({ ...details, dateFormat: e.target.value })}>{DATE_FORMATS.map((c) => <option key={c}>{c}</option>)}</Select></Field>
                </div>
              </div>
            )}
            {step === 2 && (
              <div className="space-y-5">
                <div><h1 className="text-lg font-semibold">Sales setup</h1><p className="mt-1 text-[13px] text-ink-2">Keep the lead sources you use. Your pipeline starts with New → Contacted → Qualified → Meeting Scheduled → Proposal Sent → Negotiation → Won / Lost.</p></div>
                <div>
                  <p className="mb-2 text-xs font-medium text-ink-2">Lead sources</p>
                  <div className="grid gap-2 sm:grid-cols-2">{sources.map((s, i) => <label key={s.id} className="flex items-center gap-2 rounded-md border border-line p-2 text-[13px]"><Checkbox checked={s.keep} onCheckedChange={(v) => setSources(sources.map((x, j) => (j === i ? { ...x, keep: v } : x)))} />{s.name}</label>)}</div>
                  <div className="mt-3 max-w-xs"><Input value={newSource} onChange={(e) => setNewSource(e.target.value)} placeholder="Add another source (optional)" aria-label="New lead source" /></div>
                </div>
                <div>
                  <p className="mb-2 text-xs font-medium text-ink-2">How should new leads be assigned?</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {([['NONE', 'Manually', 'New leads stay unassigned until a manager assigns them.'], ['ROUND_ROBIN', 'Round-robin', 'Leads are shared evenly across available salespeople.']] as const).map(([v, t, d]) => (
                      <button key={v} type="button" onClick={() => setAssignMode(v)} className={cn('rounded-lg border p-3 text-left', assignMode === v ? 'border-accent bg-accent-soft' : 'border-line hover:bg-subtle')}><p className="text-[13px] font-medium">{t}</p><p className="mt-0.5 text-xs text-ink-2">{d}</p></button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {step === 3 && (
              <div className="space-y-4">
                <div><h1 className="text-lg font-semibold">Invite your team</h1><p className="mt-1 text-[13px] text-ink-2">Invited teammates receive a link to join. You can always invite more people later.</p></div>
                {invites.map((inv, i) => (
                  <div key={i} className="flex gap-2">
                    <Input type="email" aria-label="Team member email" placeholder="name@company.com" value={inv.email} onChange={(e) => setInvites(invites.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} />
                    <div className="w-40 shrink-0"><Select aria-label="Role" value={inv.roleKey} onChange={(e) => setInvites(invites.map((x, j) => (j === i ? { ...x, roleKey: e.target.value } : x)))}><option value="ADMIN">Admin</option><option value="MANAGER">Manager</option><option value="SALES_AGENT">Sales Agent</option><option value="VIEWER">Viewer</option></Select></div>
                    <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => setInvites(invites.length > 1 ? invites.filter((_, j) => j !== i) : [{ email: '', roleKey: 'SALES_AGENT' }])}><Trash2 className="size-4" /></Button>
                  </div>
                ))}
                <Button variant="ghost" size="sm" onClick={() => setInvites([...invites, { email: '', roleKey: 'SALES_AGENT' }])}><Plus className="size-3.5" />Add another</Button>
                {sent.length > 0 && <p className="text-xs text-ok">Invited: {sent.join(', ')}</p>}
              </div>
            )}
          </div>
          <div className="mt-6 flex items-center justify-between">
            <Button variant="ghost" disabled={step === 0 || (step === 1 && !creating && !!current) || busy} onClick={() => setStep(Math.max(0, step - 1))}>Back</Button>
            <div className="flex gap-2">
              {step === 3 && <Button onClick={skipAll} disabled={busy}>Skip for now</Button>}
              <Button variant="primary" onClick={next} loading={busy}>{step === 3 ? 'Finish setup' : 'Continue'}</Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
export default function Page() { return <React.Suspense><Wizard /></React.Suspense>; }
