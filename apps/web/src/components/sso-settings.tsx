'use client';
import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { Copy, KeyRound, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { errMsg, useAct, useT } from '@/lib/session';
import { fmtDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardHeader, Skeleton } from '@/components/ui/data';
import { Field, FormError, Input, Select, Switch } from '@/components/ui/form';
import { useConfirm } from '@/components/ui/overlay';

interface Status {
  available: boolean; callbackUrl: string; eligibleJitRoles: Array<{ id: string; name: string }>;
  connection: null | { name: string; issuer: string; clientId: string; hasSecret: boolean; scopes: string; allowedEmailDomains: string[]; allowUnverifiedEmail: boolean; jitEnabled: boolean; jitRoleId: string | null; enabled: boolean; enforceSso: boolean; verifiedAt: string | null; lastLoginAt: string | null; lastError: string | null; lastErrorAt: string | null; linkedUsers: number };
}
interface Identity { user: { id: string; name: string } | null; email: string | null; linkedAt: string; lastLoginAt: string | null }
export const SSO_ERRORS: Record<string, string> = {
  SSO_NOT_AVAILABLE: 'Single sign-on is not enabled for that workspace. Check the workspace name or sign in with your password.',
  STATE_EXPIRED: 'The sign-in took too long or was already used. Please start again.', BROWSER_MISMATCH: 'The sign-in must be completed in the same browser where it was started.',
  TOKEN_INVALID: 'Your identity provider returned a response that could not be verified. Contact your administrator.', IDP_REJECTED: 'Your identity provider rejected the sign-in.', IDP_DENIED: 'The sign-in was cancelled or denied by your identity provider.',
  IDP_ERROR: 'Your identity provider could not be reached. Try again shortly.', IDP_UNREACHABLE: 'Your identity provider could not be reached. Try again shortly.', SSO_DISABLED: 'Single sign-on is switched off for this workspace.',
  EMAIL_NOT_VERIFIED: 'Your identity provider did not confirm your email address, so we cannot sign you in.', DOMAIN_NOT_ALLOWED: 'Your email domain is not allowed for this workspace.', NO_EMAIL: 'Your identity provider did not share an email address.',
  NO_ACCOUNT: 'You do not have an account in this workspace yet. Ask an administrator to invite you.', NOT_A_MEMBER: 'You are not an active member of this workspace. Ask an administrator for access.',
  ACCOUNT_NOT_ELIGIBLE: 'This account cannot sign in with single sign-on.', IDENTITY_MISMATCH: 'This account is already linked to a different identity. Ask your administrator to unlink it.', SEAT_LIMIT_REACHED: 'The workspace has no free seats. Ask an administrator to upgrade the plan.',
  INVALID_REQUEST: 'The sign-in response was incomplete. Please start again.',
};

const GUIDES: Array<[string, string[]]> = [
  ['Microsoft Entra ID (Azure AD)', ['Entra admin centre → App registrations → New registration. Redirect URI (Web): the callback URL above.', 'Certificates & secrets → New client secret; copy the value (not the ID).', 'Issuer URL: https://login.microsoftonline.com/<your-tenant-id>/v2.0 — always your own tenant id, never "common" or "organizations".', 'Entra does not send email_verified by default. Either add the optional claim, or — only for a single-tenant app whose users you manage — tick "Accept unverified email".', 'Scopes: openid email profile.']],
  ['Google Workspace', ['Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID (Web application). Authorised redirect URI: the callback URL above.', 'Issuer URL: https://accounts.google.com. Restrict the OAuth consent screen to "Internal" so only your organisation can sign in.', 'Allowed email domains: your Workspace domain(s). Google sends email_verified.']],
  ['Any OpenID Connect provider (Okta, Auth0, Keycloak, …)', ['Create a confidential web application using the authorization-code flow with PKCE. Register the callback URL above.', 'Issuer URL: the base URL that serves /.well-known/openid-configuration. Use "Check issuer" to verify.', 'The provider must sign ID tokens with RS256, PS256, ES256 or EdDSA and support PKCE (S256).']],
];

export function SsoSettings() {
  const confirm = useConfirm();
  const params = useSearchParams();
  const q = useT(['sso'], () => api.get<Status>('/sso'));
  const ids = useT(['sso-identities'], () => api.get<Identity[]>('/sso/identities'), { enabled: !!q.data?.connection });
  const c = q.data?.connection;
  const [f, setF] = React.useState({ name: '', issuer: '', clientId: '', clientSecret: '', scopes: 'openid email profile', domains: '', allowUnverifiedEmail: false, jitEnabled: false, jitRoleId: '' });
  const [error, setError] = React.useState<string | null>(null);
  const [discovered, setDiscovered] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!q.data) return;
    const x = q.data.connection;
    setF({ name: x?.name ?? '', issuer: x?.issuer ?? '', clientId: x?.clientId ?? '', clientSecret: '', scopes: x?.scopes ?? 'openid email profile', domains: (x?.allowedEmailDomains ?? []).join(', '), allowUnverifiedEmail: x?.allowUnverifiedEmail ?? false, jitEnabled: x?.jitEnabled ?? false, jitRoleId: x?.jitRoleId ?? q.data.eligibleJitRoles[0]?.id ?? '' });
  }, [q.data]);
  React.useEffect(() => {
    const t = params.get('sso_test');
    if (t === 'ok') toast.success('Test sign-in succeeded. You can now switch SSO on.');
    if (t === 'failed') toast.error(SSO_ERRORS[params.get('code') ?? ''] ?? `The test sign-in failed (${params.get('code') ?? 'error'}).`);
  }, [params]);

  const save = useAct(() => api.put<Status & { resetByChange: boolean }>('/sso', {
    name: f.name, issuer: f.issuer, clientId: f.clientId, ...(f.clientSecret ? { clientSecret: f.clientSecret } : {}), scopes: f.scopes,
    allowedEmailDomains: f.domains.split(/[\s,;]+/).map((d) => d.trim().toLowerCase()).filter(Boolean), allowUnverifiedEmail: f.allowUnverifiedEmail, jitEnabled: f.jitEnabled, jitRoleId: f.jitEnabled ? f.jitRoleId || null : null,
  }), { success: (r) => (r.resetByChange ? 'Saved. SSO was switched off — run a test sign-in and switch it on again.' : 'Settings saved'), onSuccess: () => setError(null), onError: (e) => setError(errMsg(e)), silent: true });
  const test = useAct(async () => { const r = await api.post<{ url: string }>('/sso/test'); window.location.href = r.url; }, { silent: true, onError: (e) => toast.error(errMsg(e)) });
  const state = useAct((b: { enabled?: boolean; enforce?: boolean }) => api.post('/sso/state', b), { success: 'Updated', onError: (e) => toast.error(errMsg(e)), silent: true });
  const remove = useAct(() => api.del('/sso'), { success: 'Single sign-on removed' });
  const unlink = useAct((id: string) => api.del(`/sso/identities/${id}`), { success: 'Member unlinked' });
  async function check() {
    setError(null); setDiscovered(null);
    try { const d = await api.post<{ authorizationEndpoint: string; pkceS256: boolean }>('/sso/discover', { issuer: f.issuer }); setDiscovered(`Provider found — authorization endpoint ${d.authorizationEndpoint}${d.pkceS256 ? ' · PKCE supported' : ' · WARNING: PKCE (S256) not advertised'}`); }
    catch (e) { setError(errMsg(e)); }
  }
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  if (q.isLoading) return <Skeleton className="h-96" />;
  if (q.error || !q.data) return <FormError message={errMsg(q.error)} />;
  const d = q.data;
  const status = !c ? ['Not configured', undefined] : c.enforceSso ? ['SSO required', 'ok'] : c.enabled ? ['Enabled', 'ok'] : c.verifiedAt ? ['Tested — switched off', 'warn'] : ['Not tested yet', 'warn'];
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Single sign-on (OpenID Connect)" description="Let your team sign in with your company identity provider. Email and password sign-in keeps working for everyone unless you require SSO."
          actions={<Badge tone={status[1] as 'ok' | 'warn' | undefined}>{status[0]}</Badge>} />
        <div className="space-y-4 px-4 pb-4">
          {!d.available && <p role="alert" className="rounded-md border border-warn/30 bg-warn-soft p-3 text-xs text-warn">Single sign-on is not available on this server (no encryption key configured for stored secrets). Contact the platform operator.</p>}
          <div className="rounded-lg bg-subtle p-3 text-xs">
            <p className="font-medium text-ink-2">Callback (redirect) URL — register this exact address at your identity provider</p>
            <div className="mt-1 flex items-center gap-2"><code className="break-all rounded bg-surface px-2 py-1" data-testid="sso-callback">{d.callbackUrl}</code>
              <Button size="iconSm" variant="ghost" aria-label="Copy callback URL" onClick={() => { void navigator.clipboard?.writeText(d.callbackUrl); toast.success('Copied'); }}><Copy className="size-3.5" /></Button></div>
          </div>
          <FormError message={error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Display name" required htmlFor="sso-name"><Input id="sso-name" value={f.name} onChange={set('name')} placeholder="Acme Entra ID" /></Field>
            <Field label="Client ID" required htmlFor="sso-client"><Input id="sso-client" value={f.clientId} onChange={set('clientId')} autoComplete="off" /></Field>
            <Field label="Issuer URL" required htmlFor="sso-issuer" hint="The base URL that serves /.well-known/openid-configuration"><div className="flex gap-2"><Input id="sso-issuer" value={f.issuer} onChange={set('issuer')} placeholder="https://login.example.com/tenant/v2.0" /><Button type="button" onClick={check}>Check issuer</Button></div></Field>
            <Field label="Client secret" required={!c} htmlFor="sso-secret" hint={c?.hasSecret ? 'A secret is stored (encrypted). Leave blank to keep it.' : 'Stored encrypted; never shown again.'}><Input id="sso-secret" type="password" autoComplete="new-password" value={f.clientSecret} onChange={set('clientSecret')} placeholder={c?.hasSecret ? '••••••••••••' : ''} /></Field>
            <Field label="Allowed email domains" required htmlFor="sso-domains" hint="Comma separated, e.g. acme.com. Only these addresses can be linked or created."><Input id="sso-domains" value={f.domains} onChange={set('domains')} placeholder="acme.com" /></Field>
            <Field label="Scopes" htmlFor="sso-scopes"><Input id="sso-scopes" value={f.scopes} onChange={set('scopes')} /></Field>
          </div>
          {discovered && <p className="text-xs text-ok" role="status">{discovered}</p>}
          <div className="space-y-3 rounded-lg border border-line p-3">
            <label className="flex items-center justify-between gap-3 text-[13px]"><span><b>Create accounts automatically</b> (just-in-time)<span className="block text-xs text-ink-3">When someone from an allowed domain signs in for the first time, add them with the role below. Off by default: people must be invited first.</span></span><Switch aria-label="Create accounts automatically" checked={f.jitEnabled} onCheckedChange={(v) => setF((p) => ({ ...p, jitEnabled: v }))} /></label>
            {f.jitEnabled && <Field label="Role for new members" htmlFor="sso-role" hint="Administrator and owner roles cannot be assigned automatically."><Select id="sso-role" value={f.jitRoleId} onChange={set('jitRoleId')}>{d.eligibleJitRoles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field>}
            <label className="flex items-center justify-between gap-3 text-[13px]"><span><b>Accept unverified email addresses</b><span className="block text-xs text-warn">Only for a single-tenant provider where you control every email address (for example your own Entra tenant). Otherwise anyone who can set an email at the provider could take over that account.</span></span><Switch aria-label="Accept unverified email addresses" checked={f.allowUnverifiedEmail} onCheckedChange={(v) => setF((p) => ({ ...p, allowUnverifiedEmail: v }))} /></label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={save.isPending} disabled={!d.available || !f.name || !f.issuer || !f.clientId || (!c && !f.clientSecret)} onClick={() => save.mutate()}>{c ? 'Save changes' : 'Save connection'}</Button>
            {c && <Button loading={test.isPending} onClick={() => test.mutate()}><KeyRound className="size-3.5" />Test sign-in</Button>}
            {c && !c.enabled && <Button variant="primary" disabled={!c.verifiedAt} loading={state.isPending} onClick={() => state.mutate({ enabled: true })}>Switch SSO on</Button>}
            {c?.enabled && <Button onClick={() => state.mutate({ enabled: false })}>Switch SSO off</Button>}
            {c && <Button variant="danger" onClick={async () => { if (await confirm({ title: 'Remove single sign-on?', description: 'Members go back to email and password. Linked identities are kept.', confirmLabel: 'Remove', destructive: true })) remove.mutate(); }}><Trash2 className="size-3.5" />Remove</Button>}
          </div>
          {c && !c.verifiedAt && <p className="text-xs text-ink-3">Run <b>Test sign-in</b> with your own account first: it checks the whole flow without changing any account. SSO can only be switched on after a successful test.</p>}
        </div>
      </Card>

      {c && (
        <Card>
          <CardHeader title="Status" />
          <dl className="grid gap-3 px-4 pb-4 text-[13px] sm:grid-cols-4">
            <div><dt className="text-xs text-ink-3">Last test</dt><dd>{c.verifiedAt ? fmtDateTime(c.verifiedAt) : 'Never'}</dd></div>
            <div><dt className="text-xs text-ink-3">Last SSO sign-in</dt><dd>{c.lastLoginAt ? fmtDateTime(c.lastLoginAt) : 'None yet'}</dd></div>
            <div><dt className="text-xs text-ink-3">Linked members</dt><dd>{c.linkedUsers}</dd></div>
            <div><dt className="text-xs text-ink-3">Last error</dt><dd className={c.lastError ? 'text-bad' : ''}>{c.lastError ? `${SSO_ERRORS[c.lastError] ?? c.lastError}` : 'None'}</dd></div>
          </dl>
          <div className="space-y-3 border-t border-line px-4 py-4">
            <label className="flex items-center justify-between gap-3 text-[13px]"><span><b className="inline-flex items-center gap-1.5"><ShieldCheck className="size-4" />Require single sign-on</b><span className="block text-xs text-ink-3">Members must sign in with SSO to open this workspace; their passwords stop working here. <b>Owners keep password access</b> so a broken provider can always be repaired, and platform support can switch SSO off in an emergency.</span></span>
              <Switch aria-label="Require single sign-on" checked={c.enforceSso} disabled={!c.enabled || !c.verifiedAt || state.isPending} onCheckedChange={async (v) => { if (!v || await confirm({ title: 'Require single sign-on?', description: 'Everyone except owners will need to sign in through your identity provider. Make sure the test sign-in worked and at least one other administrator can use it.', confirmLabel: 'Require SSO', destructive: true })) state.mutate({ enforce: v }); }} /></label>
          </div>
          {ids.data && ids.data.length > 0 && (
            <div className="border-t border-line px-4 py-3">
              <p className="mb-2 text-xs font-medium text-ink-2">Linked members</p>
              <ul className="divide-y divide-line rounded-lg border border-line text-[13px]" aria-label="Linked members">{ids.data.map((i) => (
                <li key={i.email ?? i.linkedAt} className="flex items-center gap-3 p-2.5"><span className="min-w-0 flex-1 truncate">{i.user?.name ?? i.email}<span className="ml-2 text-xs text-ink-3">{i.email}</span></span><span className="text-xs text-ink-3">{i.lastLoginAt ? fmtDateTime(i.lastLoginAt) : '—'}</span>
                  <Button size="sm" onClick={() => i.user && unlink.mutate(i.user.id)}>Unlink</Button></li>))}</ul>
            </div>
          )}
        </Card>
      )}

      <Card>
        <CardHeader title="Setup guides" description="Step-by-step notes for common providers." />
        <div className="space-y-2 px-4 pb-4">
          {GUIDES.map(([name, steps]) => (
            <details key={name} className="rounded-lg border border-line p-3 text-[13px]"><summary className="cursor-pointer font-medium">{name}</summary><ol className="mt-2 list-decimal space-y-1 pl-5 text-ink-2">{steps.map((s) => <li key={s}>{s}</li>)}</ol></details>
          ))}
        </div>
      </Card>
    </div>
  );
}
